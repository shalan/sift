import { evalNetlist, type Netlist } from "./netlist.ts";
import { inputAssignment, subjectGraph, vectorIndexes, type SubjectGraph } from "./aig.ts";
import {
  baseCells,
  byArea,
  inverterOf,
  isBuffer,
  pickByFanout,
  portCap,
  resolveLibrary,
  tableEdge,
  wireOf,
  type Cell,
  type Library,
  type LibrarySource,
  type LoadTable,
  type WireLoad,
} from "./library.ts";

export const DEFAULT_MAX_FANOUT = 4;

const K = 4;

export type MapMode = "area" | "delay" | "load";
export type DelayModel = "count" | "cap";

/** A structural cone offered to the mapper as one library cell. Inversions sit inside the cell. */
export interface PatternSeed {
  cell: string;
  leaves: number[];
  pinInv: boolean[];
  /** When set, the cell implements the negated node and is offered to that cover. */
  outputInv?: boolean;
}

export interface LogicChoice {
  kind: "cell" | "inv" | "pi";
  cell: string;
  leaves: number[];
  pinInv: boolean[];
}

interface CellChoice {
  kind: "cell";
  cell: string;
  area: number;
  tree: number;
  arrival: number;
  leaves: number[];
  pinInv: boolean[];
}

interface InvChoice {
  kind: "inv";
  tree: number;
  arrival: number;
}

interface PiChoice {
  kind: "pi";
  tree: number;
  arrival: number;
}

type Choice = CellChoice | InvChoice | PiChoice;

interface RawMatch {
  cell: string;
  cellArea: number;
  tree: number;
  arrival: number;
  leaves: number[];
  pinInv: boolean[];
}

export interface MapGate {
  cell: string;
  output: string;
  inputs: string[];
}

export interface MapRow {
  inputs: { name: string; value: 0 | 1 }[];
  outputs: { name: string; net: 0 | 1; mapped: 0 | 1 }[];
  match: boolean;
}

export interface PathStep {
  label: string;
  at: number;
  incr: number;
  slew: number;
  edge: "rise" | "fall";
}

export interface DrivingCell {
  cell: string;
  pin?: string;
  fromPin?: string;
  rise?: number;
  fall?: number;
}

export interface ArrivalQuery {
  inputSlew?: number;
  outputLoad?: number;
  inputDelay?: number;
  ports?: ReadonlySet<string>;
  sourceLimit?: ReadonlyMap<string, { maxCap?: number; maxFanout?: number; drive?: number }>;
  maxFanout?: number;
  portSlew?: ReadonlyMap<string, number>;
  portLoad?: ReadonlyMap<string, number>;
  portDelay?: ReadonlyMap<string, number>;
  wire?: WireLoad | null;
  capPerFanout?: number;
  extreme?: "max" | "min";
  bufferInputs?: ReadonlySet<string>;
  bufferOutputs?: ReadonlySet<string>;
  maxCapacitance?: number;
  maxTransition?: number;
  drivingCell?: DrivingCell;
  portDrive?: ReadonlyMap<string, DrivingCell>;
  drivingInputs?: ReadonlySet<string>;
  /** Load mode may slow a path up to this arrival. Omit to minimize arrival. */
  arrivalBudget?: number;
}

export interface LimitHit {
  net: string;
  cell: string;
  cap: number;
  maxCap: number | null;
  fanout: number;
  maxFanout: number | null;
  slew: number | null;
  maxTran: number | null;
}

export interface MapReport {
  library: string;
  mode: MapMode;
  area: number;
  delay: number;
  rise: number;
  fall: number;
  path: PathStep[];
  risePath: PathStep[];
  fallPath: PathStep[];
  cells: string[];
  gates: MapGate[];
  drives: { name: string; wire: string }[];
  limited: boolean;
  over: LimitHit[];
  verilog: string;
  equiv: {
    exhaustive: boolean;
    vectors: number;
    mismatches: number;
    rows: MapRow[];
  };
}

function nodeOf(lit: number): number {
  return lit >>> 1;
}

function invOf(lit: number): boolean {
  return (lit & 1) === 1;
}

function permutations(count: number): number[][] {
  const out: number[][] = [];
  const used = Array<boolean>(count).fill(false);
  const current: number[] = [];
  function walk(): void {
    if (current.length === count) {
      out.push([...current]);
      return;
    }
    for (let index = 0; index < count; index += 1) {
      if (used[index]) continue;
      used[index] = true;
      current.push(index);
      walk();
      current.pop();
      used[index] = false;
    }
  }
  walk();
  return out;
}

const PERMS = [0, 1, 2, 3, 4].map((count) => permutations(count));

const VAR_MASK: number[][] = Array.from({ length: K + 1 }, (_, width) => {
  const space = 1 << width;
  return Array.from({ length: width }, (_, index) => {
    let mask = 0;
    for (let bit = 0; bit < space; bit += 1) if (((bit >> index) & 1) === 1) mask |= 1 << bit;
    return mask;
  });
});

function cutKey(leaves: number[]): string {
  return leaves.join(",");
}

interface Binding {
  cell: string;
  area: number;
  delay: number;
  perm: number[];
  pinInv: boolean[];
}

interface MatchBook {
  byWidth: Map<number, Binding[]>[];
}

interface Cut {
  leaves: number[];
  table: number;
}

function cellTable(cell: Cell, perm: number[], phase: number, width: number): number {
  const space = 1 << width;
  let table = 0;
  for (let mask = 0; mask < space; mask += 1) {
    let cellMask = 0;
    for (let pin = 0; pin < width; pin += 1) {
      const leafBit = (mask >> (perm[pin] ?? 0)) & 1;
      const pinBit = leafBit ^ ((phase >> pin) & 1);
      cellMask |= pinBit << pin;
    }
    if (cell.fn(cellMask) === 1) table |= 1 << mask;
  }
  return table;
}

/** Every pin order and input polarity of each base cell, keyed by the cone word it implements. */
function matchBook(library: Library): MatchBook {
  const byWidth = Array.from({ length: K + 1 }, () => new Map<number, Binding[]>());
  for (const cell of baseCells(library)) {
    const width = cell.inputs.length;
    if (width < 1 || width > K) continue;
    const bucket = byWidth[width];
    if (!bucket) continue;
    for (const perm of PERMS[width] ?? []) {
      const phases = 1 << width;
      for (let phase = 0; phase < phases; phase += 1) {
        const table = cellTable(cell, perm, phase, width);
        const binding: Binding = {
          cell: cell.name,
          area: cell.area,
          delay: cell.delay,
          perm,
          pinInv: perm.map((_, pin) => ((phase >> pin) & 1) === 1),
        };
        const list = bucket.get(table);
        if (list) list.push(binding);
        else bucket.set(table, [binding]);
      }
    }
  }
  return { byWidth };
}

function bindingsFor(book: MatchBook, width: number, table: number): readonly Binding[] {
  return book.byWidth[width]?.get(table) ?? [];
}

function mergeLeaves(
  left: readonly number[],
  right: readonly number[],
  node: number,
): number[] | null {
  const merged: number[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const av = i < left.length ? (left[i] ?? 0) : Number.POSITIVE_INFINITY;
    const bv = j < right.length ? (right[j] ?? 0) : Number.POSITIVE_INFINITY;
    const v = av < bv ? av : bv;
    if (av === bv) {
      i += 1;
      j += 1;
    } else if (av < bv) i += 1;
    else j += 1;
    if (v === node) return null;
    merged.push(v);
    if (merged.length > K) return null;
  }
  return merged.length === 0 ? null : merged;
}

/** Lift a truth table from `from` onto the sorted superset `to`. */
function expandTable(table: number, from: readonly number[], to: readonly number[]): number {
  const space = 1 << to.length;
  const pos: number[] = [];
  for (let index = 0; index < from.length; index += 1) {
    const leaf = from[index];
    let at = 0;
    while (at < to.length && to[at] !== leaf) at += 1;
    pos.push(at);
  }
  let out = 0;
  for (let mask = 0; mask < space; mask += 1) {
    let small = 0;
    for (let index = 0; index < pos.length; index += 1)
      if (((mask >> (pos[index] ?? 0)) & 1) === 1) small |= 1 << index;
    if (((table >> small) & 1) === 1) out |= 1 << mask;
  }
  return out;
}

function cutTable(
  left: Cut,
  right: Cut,
  leaves: number[],
  invLeft: boolean,
  invRight: boolean,
): number {
  const ones = (1 << (1 << leaves.length)) - 1;
  let a = expandTable(left.table, left.leaves, leaves);
  let b = expandTable(right.table, right.leaves, leaves);
  if (invLeft) a ^= ones;
  if (invRight) b ^= ones;
  return a & b;
}

function matchArea(book: MatchBook, table: number, width: number): number {
  const full = (1 << (1 << width)) - 1;
  let best = Number.POSITIVE_INFINITY;
  for (const binding of bindingsFor(book, width, table))
    if (binding.area < best) best = binding.area;
  for (const binding of bindingsFor(book, width, table ^ full))
    if (binding.area < best) best = binding.area;
  return best;
}

function enumerateCuts(graph: SubjectGraph, book: MatchBook): Map<number, Cut[]> {
  const cuts = new Map<number, Cut[]>();
  const identity = VAR_MASK[1]?.[0] ?? 2;
  for (const input of graph.inputs)
    cuts.set(input.node, [{ leaves: [input.node], table: identity }]);
  for (const and of graph.ands) {
    const left = cuts.get(nodeOf(and.a)) ?? [];
    const right = cuts.get(nodeOf(and.b)) ?? [];
    const invLeft = invOf(and.a);
    const invRight = invOf(and.b);
    const found: Cut[] = [];
    const seen = new Set<string>();
    for (const a of left) {
      for (const b of right) {
        const merged = mergeLeaves(a.leaves, b.leaves, and.node);
        if (!merged) continue;
        const key = cutKey(merged);
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ leaves: merged, table: cutTable(a, b, merged, invLeft, invRight) });
      }
    }
    const local = [...new Set([nodeOf(and.a), nodeOf(and.b)])]
      .filter((id) => id !== 0)
      .sort((x, y) => x - y);
    const localKey = cutKey(local);
    const must = found.filter((cut) => cut.leaves.length <= 2 || cutKey(cut.leaves) === localKey);
    const wide = found
      .filter((cut) => cut.leaves.length > 2 && cutKey(cut.leaves) !== localKey)
      .map((cut) => ({ cut, cost: matchArea(book, cut.table, cut.leaves.length) }))
      .sort((a, b) => {
        const aOk = Number.isFinite(a.cost);
        const bOk = Number.isFinite(b.cost);
        if (aOk !== bOk) return aOk ? -1 : 1;
        if (aOk && a.cost !== b.cost) return a.cost - b.cost;
        if (a.cut.leaves.length !== b.cut.leaves.length)
          return b.cut.leaves.length - a.cut.leaves.length;
        return cutKey(a.cut.leaves).localeCompare(cutKey(b.cut.leaves));
      })
      .slice(0, 8)
      .map((item) => item.cut);
    const kept: Cut[] = [];
    const seenKept = new Set<string>();
    for (const cut of [...must, ...wide]) {
      const key = cutKey(cut.leaves);
      if (seenKept.has(key)) continue;
      seenKept.add(key);
      kept.push(cut);
    }
    cuts.set(and.node, [...kept, { leaves: [and.node], table: identity }]);
  }
  return cuts;
}

function better(
  next: RawMatch,
  current: RawMatch | null,
  mode: MapMode,
  areaFirst = false,
): boolean {
  if (!current) return true;
  const byArea = areaFirst || mode === "area";
  if (!byArea) {
    if (next.arrival !== current.arrival) return next.arrival < current.arrival;
    if (next.tree !== current.tree) return next.tree < current.tree;
  } else if (next.tree !== current.tree) return next.tree < current.tree;
  else if (next.arrival !== current.arrival) return next.arrival < current.arrival;
  if (next.cellArea !== current.cellArea) return next.cellArea < current.cellArea;
  return next.cell < current.cell;
}

function fanKey(node: number, pol: "pos" | "neg"): string {
  return `${node}:${pol}`;
}

function structuralFanout(graph: SubjectGraph): Map<string, number> {
  const refs = new Map<string, number>();
  const bump = (lit: number) => {
    const node = nodeOf(lit);
    if (node === 0) return;
    const key = fanKey(node, invOf(lit) ? "neg" : "pos");
    refs.set(key, (refs.get(key) ?? 0) + 1);
  };
  for (const and of graph.ands) {
    bump(and.a);
    bump(and.b);
  }
  for (const output of graph.outputs) bump(output.lit);
  return refs;
}

function coverFanout(
  graph: SubjectGraph,
  pos: Map<number, Choice>,
  neg: Map<number, Choice>,
): Map<string, number> {
  const refs = new Map<string, number>();
  const seen = new Set<string>();
  const visit = (node: number, pol: "pos" | "neg") => {
    const key = fanKey(node, pol);
    refs.set(key, (refs.get(key) ?? 0) + 1);
    if (seen.has(key)) return;
    seen.add(key);
    const choice = pol === "pos" ? pos.get(node) : neg.get(node);
    if (!choice || choice.kind === "pi") return;
    if (choice.kind === "inv") {
      visit(node, pol === "pos" ? "neg" : "pos");
      return;
    }
    choice.leaves.forEach((leaf, pin) => visit(leaf, choice.pinInv[pin] ? "neg" : "pos"));
  };
  for (const output of graph.outputs) {
    if (output.lit <= 1) continue;
    visit(nodeOf(output.lit), invOf(output.lit) ? "neg" : "pos");
  }
  return refs;
}

function coverNode(
  graph: SubjectGraph,
  node: number,
  cuts: Cut[],
  library: Library,
  mode: MapMode,
  refs: Map<string, number>,
  cap: Map<number, { pos: number; neg: number }> | null,
  pos: Map<number, Choice>,
  neg: Map<number, Choice>,
  seeds: readonly PatternSeed[],
  limits: Map<string, number> | null,
  book: MatchBook,
): void {
  const inv = inverterOf(library);
  const posLimit = limits?.get(fanKey(node, "pos"));
  const negLimit = limits?.get(fanKey(node, "neg"));
  const best: {
    posFast: RawMatch | null;
    negFast: RawMatch | null;
    posFit: RawMatch | null;
    negFit: RawMatch | null;
  } = {
    posFast: null,
    negFast: null,
    posFit: null,
    negFit: null,
  };

  function polarity(leaf: number, inverted: boolean): { tree: number; arrival: number } {
    const choice = inverted ? neg.get(leaf) : pos.get(leaf);
    if (!choice) throw new Error(`unmapped leaf ${leaf}`);
    return { tree: choice.tree, arrival: choice.arrival };
  }

  for (const cut of cuts) {
    if (cut.leaves.length === 1 && cut.leaves[0] === node) continue;
    const table = cut.table;
    const width = cut.leaves.length;
    const full = (1 << (1 << width)) - 1;
    const apply = (binding: Binding, negated: boolean) => {
      const leaves = binding.perm.map((index) => cut.leaves[index] ?? 0);
      const pinInv = binding.pinInv.slice();
      const pins = leaves.map((leaf, pin) => polarity(leaf, pinInv[pin] ?? false));
      const tree = binding.area + pins.reduce((sum, pin) => sum + pin.tree, 0);
      const arrival = binding.delay + pins.reduce((max, pin) => Math.max(max, pin.arrival), 0);
      const raw: RawMatch = {
        cell: binding.cell,
        cellArea: binding.area,
        tree,
        arrival,
        leaves,
        pinInv,
      };
      const within = (limit: number | undefined) => limit === undefined || arrival <= limit + 1e-6;
      if (!negated) {
        if (better(raw, best.posFast, mode)) best.posFast = raw;
        if (within(posLimit) && better(raw, best.posFit, mode, posLimit !== undefined))
          best.posFit = raw;
      } else {
        if (better(raw, best.negFast, mode)) best.negFast = raw;
        if (within(negLimit) && better(raw, best.negFit, mode, negLimit !== undefined))
          best.negFit = raw;
      }
    };
    for (const binding of bindingsFor(book, width, table)) apply(binding, false);
    for (const binding of bindingsFor(book, width, table ^ full)) apply(binding, true);
  }

  for (const seed of seeds) {
    const cell = library.cells.find((item) => item.name === seed.cell);
    if (!cell || seed.leaves.length === 0) continue;
    if (seed.leaves.some((leaf, pin) => !(seed.pinInv[pin] ? neg : pos).has(leaf))) continue;
    const pins = seed.leaves.map((leaf, pin) => polarity(leaf, seed.pinInv[pin] ?? false));
    const tree = cell.area + pins.reduce((sum, pin) => sum + pin.tree, 0);
    const arrival = cell.delay + pins.reduce((max, pin) => Math.max(max, pin.arrival), 0);
    const raw: RawMatch = {
      cell: cell.name,
      cellArea: cell.area,
      tree,
      arrival,
      leaves: seed.leaves,
      pinInv: seed.pinInv.map((bit) => bit),
    };
    const within = (limit: number | undefined) => limit === undefined || arrival <= limit + 1e-6;
    if (seed.outputInv) {
      if (better(raw, best.negFast, mode)) best.negFast = raw;
      if (within(negLimit) && better(raw, best.negFit, mode, negLimit !== undefined))
        best.negFit = raw;
    } else {
      if (better(raw, best.posFast, mode)) best.posFast = raw;
      if (within(posLimit) && better(raw, best.posFit, mode, posLimit !== undefined))
        best.posFit = raw;
    }
  }

  const posRaw = best.posFit ?? best.posFast;
  const negRaw = best.negFit ?? best.negFast;

  const posFan = Math.max(1, refs.get(fanKey(node, "pos")) ?? 1);
  const negFan = Math.max(1, refs.get(fanKey(node, "neg")) ?? 1);
  const posCost = posRaw ? posRaw.tree : Number.POSITIVE_INFINITY;
  const negCost = negRaw ? negRaw.tree : Number.POSITIVE_INFINITY;
  const posAt = posRaw ? posRaw.arrival : Number.POSITIVE_INFINITY;
  const negAt = negRaw ? negRaw.arrival : Number.POSITIVE_INFINITY;
  const posVia = Number.isFinite(negCost) ? negCost + inv.area : Number.POSITIVE_INFINITY;
  const negVia = Number.isFinite(posCost) ? posCost + inv.area : Number.POSITIVE_INFINITY;
  const posViaAt = Number.isFinite(negAt) ? negAt + inv.delay : Number.POSITIVE_INFINITY;
  const negViaAt = Number.isFinite(posAt) ? posAt + inv.delay : Number.POSITIVE_INFINITY;
  const limit = cap?.get(node);

  const posKind0 = pickPolarity(
    mode,
    posRaw,
    posAt,
    posVia,
    posViaAt,
    posLimit ?? limit?.pos,
    best.posFit !== null && posLimit !== undefined,
  );
  const negKind0 = pickPolarity(
    mode,
    negRaw,
    negAt,
    negVia,
    negViaAt,
    negLimit ?? limit?.neg,
    best.negFit !== null && negLimit !== undefined,
  );
  let posKind = posKind0;
  let negKind = negKind0;
  if (posKind !== "cell" && negKind !== "cell") {
    const posMeets = best.posFit !== null;
    const negMeets = best.negFit !== null;
    if (posRaw && !posMeets && negMeets) posKind = "cell";
    else if (negRaw && !negMeets && posMeets) negKind = "cell";
    else if (posRaw && negRaw) {
      const faster =
        !posMeets && !negMeets
          ? posRaw.arrival <= negRaw.arrival
          : better(posRaw, negRaw, mode, true);
      if (faster) posKind = "cell";
      else negKind = "cell";
    } else if (posRaw) posKind = "cell";
    else if (negRaw) negKind = "cell";
  }
  if (!posKind && !negKind) throw new Error(`no cover for node ${node} in ${library.name}`);

  if (posKind === "cell" && posRaw) {
    pos.set(node, {
      kind: "cell",
      cell: posRaw.cell,
      area: posRaw.cellArea,
      tree: posRaw.tree / posFan,
      arrival: posRaw.arrival,
      leaves: posRaw.leaves,
      pinInv: posRaw.pinInv,
    });
  } else if (Number.isFinite(posVia)) {
    pos.set(node, { kind: "inv", tree: posVia / posFan, arrival: posViaAt });
  }

  if (negKind === "cell" && negRaw) {
    neg.set(node, {
      kind: "cell",
      cell: negRaw.cell,
      area: negRaw.cellArea,
      tree: negRaw.tree / negFan,
      arrival: negRaw.arrival,
      leaves: negRaw.leaves,
      pinInv: negRaw.pinInv,
    });
  } else if (Number.isFinite(negVia)) {
    neg.set(node, { kind: "inv", tree: negVia / negFan, arrival: negViaAt });
  }
}

function pickPolarity(
  mode: MapMode,
  direct: RawMatch | null,
  directAt: number,
  viaCost: number,
  viaAt: number,
  limit: number | undefined,
  areaFirst = false,
): "cell" | "inv" | null {
  const options: { kind: "cell" | "inv"; arrival: number; cost: number }[] = [];
  if (direct) options.push({ kind: "cell", arrival: directAt, cost: direct.tree });
  if (Number.isFinite(viaCost)) options.push({ kind: "inv", arrival: viaAt, cost: viaCost });
  const legal = options.filter((option) => limit === undefined || option.arrival <= limit + 1e-9);
  const pool = legal.length > 0 ? legal : options;
  pool.sort((a, b) => {
    const byArea = areaFirst || mode === "area";
    if (!byArea) {
      if (a.arrival !== b.arrival) return a.arrival - b.arrival;
      if (a.cost !== b.cost) return a.cost - b.cost;
    } else if (a.cost !== b.cost) return a.cost - b.cost;
    else if (a.arrival !== b.arrival) return a.arrival - b.arrival;
    if (a.kind !== b.kind) return a.kind === "cell" ? -1 : 1;
    return 0;
  });
  return pool[0]?.kind ?? null;
}

interface EmitState {
  pos: Map<number, Choice>;
  neg: Map<number, Choice>;
  wires: Map<string, string>;
  gates: MapGate[];
  areas: Map<string, number>;
  inverter: string;
  next: number;
}

function emit(state: EmitState, node: number, pol: "pos" | "neg"): string {
  const key = `${node}:${pol}`;
  const cached = state.wires.get(key);
  if (cached) return cached;
  const choice = pol === "pos" ? state.pos.get(node) : state.neg.get(node);
  if (!choice) throw new Error(`missing ${pol} cover for ${node}`);
  if (choice.kind === "pi") {
    throw new Error("primary input wire was not seeded");
  }
  if (choice.kind === "inv") {
    const source = emit(state, node, pol === "pos" ? "neg" : "pos");
    const wire = `_${state.next}`;
    state.next += 1;
    state.gates.push({ cell: state.inverter, output: wire, inputs: [source] });
    state.wires.set(key, wire);
    return wire;
  }
  const inputs = choice.leaves.map((leaf, pin) =>
    emit(state, leaf, choice.pinInv[pin] ? "neg" : "pos"),
  );
  const wire = `_${state.next}`;
  state.next += 1;
  state.gates.push({ cell: choice.cell, output: wire, inputs });
  state.wires.set(key, wire);
  return wire;
}

function moduleName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (cleaned.length === 0 || /^[0-9]/.test(cleaned)) return `m_${cleaned}`;
  return cleaned;
}

function renderVerilog(
  netlist: Netlist,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
): string {
  const lines = [`module ${moduleName(netlist.name)} (`];
  const ports = [
    ...netlist.inputs.map((name) => `  input ${name}`),
    ...netlist.outputs.map((name) => `  output ${name}`),
  ];
  lines.push(ports.join(",\n"));
  lines.push(");");
  const portsNamed = new Set([...netlist.inputs, ...netlist.outputs]);
  const wires = [...new Set(gates.map((gate) => gate.output))].filter(
    (name) => !portsNamed.has(name),
  );
  if (wires.length > 0) lines.push(`  wire ${wires.join(", ")};`);
  gates.forEach((gate, index) => {
    lines.push(`  ${gate.cell} g${index} (${gate.output}, ${gate.inputs.join(", ")});`);
  });
  for (const tie of ties) {
    if (tie.wire === tie.name) continue;
    throw new Error(`output ${tie.name} is not driven by a cell`);
  }
  lines.push("endmodule");
  return lines.join("\n");
}

export function tieBuffer(library: Library, output: string, input: string): MapGate[] {
  const buffer = byArea(library.cells.filter(isBuffer))[0];
  if (buffer) return [{ cell: buffer.name, output, inputs: [input] }];
  const inv = inverterOf(library);
  const mid = `${output}_n`;
  return [
    { cell: inv.name, output: mid, inputs: [input] },
    { cell: inv.name, output, inputs: [mid] },
  ];
}

function tieConstant(library: Library, output: string, value: 0 | 1): MapGate[] {
  const buffer = byArea(library.cells.filter(isBuffer))[0];
  if (buffer) return [{ cell: buffer.name, output, inputs: [value === 1 ? "1'b1" : "1'b0"] }];
  const inv = inverterOf(library);
  return [{ cell: inv.name, output, inputs: [value === 1 ? "1'b0" : "1'b1"] }];
}

function stitchTies(
  library: Library,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
): { gates: MapGate[]; ties: { name: string; wire: string }[] } {
  const list = gates.map((gate) => ({ ...gate, inputs: [...gate.inputs] }));
  const extra: MapGate[] = [];
  const renamed = new Map<string, string>();
  const kept: { name: string; wire: string }[] = [];
  for (const tie of ties) {
    if (tie.wire === "1'b0" || tie.wire === "1'b1") {
      extra.push(...tieConstant(library, tie.name, tie.wire === "1'b1" ? 1 : 0));
      kept.push({ name: tie.name, wire: tie.name });
      continue;
    }
    if (tie.wire === tie.name) {
      kept.push(tie);
      continue;
    }
    const source = renamed.get(tie.wire);
    const driver = source ? undefined : list.find((gate) => gate.output === tie.wire);
    if (driver) {
      for (const gate of [...list, ...extra])
        gate.inputs = gate.inputs.map((net) => (net === tie.wire ? tie.name : net));
      driver.output = tie.name;
      renamed.set(tie.wire, tie.name);
      kept.push({ name: tie.name, wire: tie.name });
      continue;
    }
    const from = source ?? tie.wire;
    extra.push(...tieBuffer(library, tie.name, from));
    renamed.set(tie.wire, tie.name);
    kept.push({ name: tie.name, wire: tie.name });
  }
  return { gates: [...list, ...extra], ties: kept };
}

function isolatePorts(
  library: Library,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
  query: ArrivalQuery,
): MapGate[] {
  const inputs = query.bufferInputs;
  const outputs = query.bufferOutputs;
  if ((!inputs || inputs.size === 0) && (!outputs || outputs.size === 0)) return gates;
  const list = gates.map((gate) => ({ ...gate, inputs: [...gate.inputs] }));
  const used = new Set(list.map((gate) => gate.output));
  const alloc = (base: string): string => {
    let name = base;
    let n = 0;
    while (used.has(name)) {
      n += 1;
      name = `${base}_${n}`;
    }
    used.add(name);
    return name;
  };
  if (inputs) {
    for (const name of inputs) {
      if (!list.some((gate) => gate.inputs.includes(name))) continue;
      const internal = alloc(`_ib_${name}`);
      const added = tieBuffer(library, internal, name);
      for (const gate of added) used.add(gate.output);
      for (const gate of list)
        gate.inputs = gate.inputs.map((net) => (net === name ? internal : net));
      list.unshift(...added);
    }
  }
  if (outputs) {
    for (const tie of ties) {
      if (!outputs.has(tie.name)) continue;
      const driver = list.find((gate) => gate.output === tie.name);
      if (!driver) continue;
      const internal = alloc(`_ob_${tie.name}`);
      for (const gate of list) {
        if (gate === driver) continue;
        gate.inputs = gate.inputs.map((net) => (net === tie.name ? internal : net));
      }
      driver.output = internal;
      const added = tieBuffer(library, tie.name, internal);
      for (const gate of added) used.add(gate.output);
      list.push(...added);
    }
  }
  return list;
}

function evalMapped(
  library: Library,
  gates: MapGate[],
  ties: { name: string; expr: string }[],
  assign: ReadonlyMap<string, 0 | 1>,
): Map<string, 0 | 1> {
  const cells = new Map(library.cells.map((cell) => [cell.name, cell]));
  const value = new Map<string, 0 | 1>();
  value.set("0", 0);
  value.set("1", 1);
  value.set("1'b0", 0);
  value.set("1'b1", 1);
  for (const [name, bit] of assign) value.set(name, bit);
  for (const gate of gates) {
    const cell = cells.get(gate.cell);
    if (!cell) throw new Error(`unknown cell ${gate.cell}`);
    let mask = 0;
    gate.inputs.forEach((net, index) => {
      const bit = value.get(net);
      if (bit === undefined) throw new Error(`net ${net} has no value`);
      if (bit === 1) mask |= 1 << index;
    });
    value.set(gate.output, cell.fn(mask));
  }
  const out = new Map<string, 0 | 1>();
  for (const tie of ties) {
    if (tie.expr === "1'b0") out.set(tie.name, 0);
    else if (tie.expr === "1'b1") out.set(tie.name, 1);
    else {
      const bit = value.get(tie.expr);
      if (bit === undefined) throw new Error(`output ${tie.name} is undriven`);
      out.set(tie.name, bit);
    }
  }
  return out;
}

function capMap(
  library: Library,
  gates: MapGate[],
  ties: { name?: string; wire: string }[],
  outputLoad?: number,
  ports?: ReadonlySet<string>,
  query: ArrivalQuery = {},
): Map<string, number> {
  const pins = pinCapMap(library, gates, ties, outputLoad, ports, query);
  const per = query.capPerFanout ?? 0;
  if (per > 0) {
    const counts = fanoutMap(gates, ties);
    for (const [net, cap] of pins) pins.set(net, cap + (counts.get(net) ?? 0) * per);
    return pins;
  }
  const wire = activeWire(library, query);
  if (!wire) return pins;
  const counts = fanoutMap(gates, ties);
  for (const [net, cap] of pins) pins.set(net, cap + wireOf(wire, counts.get(net) ?? 0).cap);
  return pins;
}

function pinCapMap(
  library: Library,
  gates: MapGate[],
  ties: { name?: string; wire: string }[],
  outputLoad?: number,
  ports?: ReadonlySet<string>,
  query: ArrivalQuery = {},
): Map<string, number> {
  const cells = new Map(library.cells.map((cell) => [cell.name, cell]));
  const load = new Map<string, number>();
  const add = (net: string, cap: number) => {
    if (net === "1'b0" || net === "1'b1") return;
    load.set(net, (load.get(net) ?? 0) + cap);
  };
  for (const gate of gates) {
    const cap = cells.get(gate.cell)?.cap ?? 1;
    for (const net of gate.inputs) add(net, cap);
  }
  for (const tie of ties) {
    const name = tie.name ?? "";
    const port = !ports || ports.has(name);
    const named = query.portLoad?.get(name);
    add(tie.wire, named ?? (port ? (outputLoad ?? portCap(library)) : portCap(library)));
  }
  return load;
}

function activeWire(library: Library, query: ArrivalQuery): WireLoad | null {
  if (query.wire === null) return null;
  if (query.wire) return query.wire;
  if (!library.defaultWireLoad) return null;
  return library.wireLoads?.find((model) => model.name === library.defaultWireLoad) ?? null;
}

function wireDelayMap(
  library: Library,
  gates: MapGate[],
  ties: { name?: string; wire: string }[],
  query: ArrivalQuery,
): Map<string, number> {
  const wire = activeWire(library, query);
  const delays = new Map<string, number>();
  if ((query.capPerFanout ?? 0) > 0 || !wire || wire.resistance === 0) return delays;
  const pins = pinCapMap(library, gates, ties, query.outputLoad, query.ports, query);
  const counts = fanoutMap(gates, ties);
  for (const [net, cap] of pins) {
    const extra = wireOf(wire, counts.get(net) ?? 0);
    if (extra.res === 0) continue;
    delays.set(net, extra.res * (extra.cap / 2 + cap));
  }
  return delays;
}

function fanoutMap(gates: MapGate[], ties: { wire: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (net: string) => {
    if (net === "1'b0" || net === "1'b1") return;
    counts.set(net, (counts.get(net) ?? 0) + 1);
  };
  for (const gate of gates) for (const net of gate.inputs) add(net);
  for (const tie of ties) add(tie.wire);
  return counts;
}

function loadDelay(fanout: number, drive: number): number {
  return Math.max(0, fanout - 1) / drive;
}

function tidy(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function orderGates(gates: MapGate[]): MapGate[] {
  const drivers = new Set(gates.map((gate) => gate.output));
  const waiting = new Map<MapGate, number>();
  const readers = new Map<string, MapGate[]>();
  const ready: MapGate[] = [];
  for (const gate of gates) {
    let pending = 0;
    for (const net of gate.inputs) {
      if (!drivers.has(net)) continue;
      pending += 1;
      const list = readers.get(net) ?? [];
      list.push(gate);
      readers.set(net, list);
    }
    waiting.set(gate, pending);
    if (pending === 0) ready.push(gate);
  }
  const ordered: MapGate[] = [];
  while (ready.length > 0) {
    const gate = ready.pop();
    if (!gate) break;
    ordered.push(gate);
    for (const reader of readers.get(gate.output) ?? []) {
      const left = (waiting.get(reader) ?? 1) - 1;
      waiting.set(reader, left);
      if (left === 0) ready.push(reader);
    }
  }
  if (ordered.length !== gates.length) throw new Error("mapped net has a cycle");
  return ordered;
}

function fanoutFallback(query: ArrivalQuery): number {
  const value = query.maxFanout;
  return value !== undefined && value >= 1 ? value : DEFAULT_MAX_FANOUT;
}

function unitOf(library: Library): number {
  const unit = portCap(library);
  return unit > 0 ? unit : 1;
}

function electrical(cap: number, drive: number, unit: number): number {
  const size = drive > 0 ? drive : 1;
  return cap / unit / size;
}

function driveLimit(
  cell: Cell | undefined,
  fallback: number,
  designCap?: number,
): { cap: number; fanout: number } {
  const fanout = cell?.maxFanout ?? fallback;
  let cap = Number.POSITIVE_INFINITY;
  if (cell && (cell.maxCap !== undefined || cell.table)) {
    const last = cell.table?.loads[cell.table.loads.length - 1];
    cap = cell.maxCap ?? last ?? Number.POSITIVE_INFINITY;
  }
  if (designCap !== undefined) cap = Math.min(cap, designCap);
  return { cap, fanout };
}

function tranLimit(cell: Cell | undefined, design?: number): number | undefined {
  if (cell?.maxTran === undefined) return design;
  if (design === undefined) return cell.maxTran;
  return Math.min(cell.maxTran, design);
}

function within(
  cell: Cell,
  cap: number,
  unit: number,
  fallback: number,
  designCap?: number,
): boolean {
  const limit = driveLimit(cell, fallback, designCap);
  return cap <= limit.cap + 1e-12 && electrical(cap, cell.drive, unit) <= limit.fanout + 1e-9;
}

function legalize(
  library: Library,
  gates: MapGate[],
  ties: { name?: string; wire: string }[],
  query: ArrivalQuery,
): MapGate[] {
  const buffers = byArea(library.cells.filter(isBuffer));
  const buffer = buffers[0];
  if (!buffer) return gates;
  const cells = new Map(library.cells.map((cell) => [cell.name, cell]));
  const fallback = fanoutFallback(query);
  const unit = unitOf(library);
  let next = 0;
  for (const gate of gates) {
    const match = /^_(\d+)$/.exec(gate.output);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  const list = gates.map((gate) => ({ ...gate, inputs: [...gate.inputs] }));
  const budget = driveLimit(buffer, fallback, query.maxCapacitance);
  const maxSize = budget.fanout * (buffer.drive > 0 ? buffer.drive : 1);
  for (let pass = 0; pass < 8; pass += 1) {
    const caps = capMap(library, list, ties, query.outputLoad, query.ports, query);
    let grew = false;
    for (const gate of list) {
      const cell = cells.get(gate.cell);
      if (!cell) continue;
      const cap = caps.get(gate.output) ?? 0;
      if (within(cell, cap, unit, fallback, query.maxCapacitance)) continue;
      const fit = byArea(library.cells.filter((item) => item.family === cell.family)).find((item) =>
        within(item, cap, unit, fallback, query.maxCapacitance),
      );
      if (!fit || fit.name === gate.cell) continue;
      gate.cell = fit.name;
      grew = true;
    }
    if (grew) continue;
    const uses = new Map<string, { gate: number; pin: number; cap: number }[]>();
    list.forEach((gate, gateIndex) => {
      const cap = cells.get(gate.cell)?.cap ?? 1;
      gate.inputs.forEach((net, pin) => {
        const pins = uses.get(net) ?? [];
        pins.push({ gate: gateIndex, pin, cap });
        uses.set(net, pins);
      });
    });
    let buffered = false;
    for (const [net, pins] of uses) {
      const driver = list.find((gate) => gate.output === net);
      const cell = driver ? cells.get(driver.cell) : undefined;
      const cap = caps.get(net) ?? 0;
      const source = query.sourceLimit?.get(net);
      const overDriver = cell ? !within(cell, cap, unit, fallback) : false;
      const sourceDrive = source?.drive ?? 1;
      const overSource = Boolean(
        source &&
        ((source.maxCap !== undefined && cap > source.maxCap + 1e-12) ||
          (source.maxFanout !== undefined &&
            electrical(cap, sourceDrive, unit) > source.maxFanout + 1e-9)),
      );
      const overCount = !cell && !source && electrical(cap, 1, unit) > fallback + 1e-9;
      if (!overDriver && !overSource && !overCount) continue;
      const groups: { gate: number; pin: number; cap: number }[][] = [];
      let group: { gate: number; pin: number; cap: number }[] = [];
      let groupCap = 0;
      let groupSize = 0;
      for (const pin of pins) {
        const size = pin.cap / unit;
        if (
          group.length > 0 &&
          (groupCap + pin.cap > budget.cap + 1e-12 || groupSize + size > maxSize + 1e-9)
        ) {
          groups.push(group);
          group = [];
          groupCap = 0;
          groupSize = 0;
        }
        group.push(pin);
        groupCap += pin.cap;
        groupSize += size;
      }
      if (group.length > 0) groups.push(group);
      const heavy =
        pins.length === 1 &&
        !within(buffer, pins[0]?.cap ?? 0, unit, fallback, query.maxCapacitance);
      if (groups.length === 0 || heavy) continue;
      if (
        groups.length === 1 &&
        pins.length === 1 &&
        cell &&
        within(cell, pins[0]?.cap ?? 0, unit, fallback, query.maxCapacitance)
      )
        continue;
      for (const chunk of groups) {
        const wire = `_${next}`;
        next += 1;
        list.push({ cell: buffer.name, output: wire, inputs: [net] });
        for (const pin of chunk) {
          const gate = list[pin.gate];
          if (!gate) throw new Error(`missing gate ${pin.gate}`);
          gate.inputs[pin.pin] = wire;
        }
      }
      buffered = true;
    }
    if (!buffered) return list;
  }
  return list;
}

function overLimit(
  library: Library,
  gates: MapGate[],
  ties: { name?: string; wire: string }[],
  query: ArrivalQuery,
): LimitHit[] {
  const cells = new Map(library.cells.map((cell) => [cell.name, cell]));
  const caps = capMap(library, gates, ties, query.outputLoad, query.ports, query);
  const fallback = fanoutFallback(query);
  const unit = unitOf(library);
  const hits: LimitHit[] = [];
  const seen = new Set<string>();
  const note = (
    net: string,
    cell: string,
    cap: number,
    fanout: number,
    maxCap: number,
    maxFanout: number,
  ) => {
    if (seen.has(net)) return;
    const capBad = Number.isFinite(maxCap) && cap > maxCap + 1e-12;
    const fanBad = Number.isFinite(maxFanout) && fanout > maxFanout + 1e-9;
    if (!capBad && !fanBad) return;
    seen.add(net);
    hits.push({
      net,
      cell,
      cap: Math.round(cap * 1e6) / 1e6,
      maxCap: Number.isFinite(maxCap) ? maxCap : null,
      fanout: Math.round(fanout * 1000) / 1000,
      maxFanout: Number.isFinite(maxFanout) ? maxFanout : null,
      slew: null,
      maxTran: null,
    });
  };
  for (const gate of gates) {
    const cell = cells.get(gate.cell);
    if (!cell) continue;
    const limit = driveLimit(cell, fallback, query.maxCapacitance);
    const cap = caps.get(gate.output) ?? 0;
    note(gate.output, gate.cell, cap, electrical(cap, cell.drive, unit), limit.cap, limit.fanout);
  }
  for (const [net, source] of query.sourceLimit ?? []) {
    const cap = caps.get(net) ?? 0;
    note(
      net,
      "source",
      cap,
      electrical(cap, source.drive ?? 1, unit),
      source.maxCap ?? Number.POSITIVE_INFINITY,
      source.maxFanout ?? fallback,
    );
  }
  return hits;
}

function transitionHits(
  library: Library,
  gates: MapGate[],
  timed: TimedNet,
  design?: number,
): LimitHit[] {
  const hits: LimitHit[] = [];
  for (const gate of gates) {
    const cell = library.cells.find((item) => item.name === gate.cell);
    const limit = tranLimit(cell, design);
    if (limit === undefined) continue;
    const slew = timed.slewAt(gate.output);
    if (slew <= limit + 1e-9) continue;
    hits.push({
      net: gate.output,
      cell: gate.cell,
      cap: 0,
      maxCap: cell?.maxCap ?? null,
      fanout: 0,
      maxFanout: cell?.maxFanout ?? null,
      slew: Math.round(slew * 1000) / 1000,
      maxTran: limit,
    });
  }
  return hits;
}

export function limitHits(
  library: Library,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
  inputs: string[],
  model: DelayModel,
  query: ArrivalQuery,
  drivenSlew: ReadonlyMap<string, number> = new Map(),
): LimitHit[] {
  const timed = arrivals(library, gates, ties, inputs, new Map(), model, drivenSlew, query);
  return [
    ...overLimit(library, gates, ties, query),
    ...transitionHits(library, gates, timed, query.maxTransition),
  ];
}

function sizeByFanout(
  library: Library,
  gates: MapGate[],
  ties: { name?: string; wire: string }[],
  query: ArrivalQuery,
): MapGate[] {
  const caps = capMap(library, gates, ties, query.outputLoad, query.ports, query);
  const unit = unitOf(library);
  return gates.map((gate) => {
    const cell = library.cells.find((item) => item.name === gate.cell);
    if (!cell) return gate;
    const sized = pickByFanout(
      byArea(library.cells.filter((item) => item.family === cell.family)),
      (caps.get(gate.output) ?? 0) / unit,
    );
    return sized ? { ...gate, cell: sized.name } : gate;
  });
}

function nextWire(gates: readonly MapGate[]): number {
  let next = 0;
  for (const gate of gates) {
    const match = /^_(\d+)$/.exec(gate.output);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

interface SlewSink {
  cap: number;
  id: string;
  move: (wire: string) => void;
}

function netSinks(
  library: Library,
  net: string,
  list: MapGate[],
  ties: { name: string; wire: string }[],
  query: ArrivalQuery,
): SlewSink[] {
  const cells = new Map(library.cells.map((cell) => [cell.name, cell]));
  const sinks: SlewSink[] = [];
  list.forEach((other, index) => {
    other.inputs.forEach((pinNet, pin) => {
      if (pinNet !== net) return;
      sinks.push({
        cap: cells.get(other.cell)?.cap ?? 1,
        id: `g${index}.${pin}`,
        move: (wire) => {
          const target = list[index];
          if (target) target.inputs[pin] = wire;
        },
      });
    });
  });
  ties.forEach((tie, index) => {
    if (tie.wire !== net) return;
    const named = query.portLoad?.get(tie.name);
    sinks.push({
      cap: named ?? query.outputLoad ?? portCap(library),
      id: `t${index}`,
      move: (wire) => {
        tie.wire = wire;
      },
    });
  });
  return sinks;
}

function worstInputSlew(gate: MapGate, timed: TimedNet, fallback: number): number {
  let slew = fallback;
  for (const net of gate.inputs) slew = Math.max(slew, timed.slewAt(net));
  return slew;
}

/** Smallest buffer whose output slew meets `limit` at this load. The strongest, if none do. */
export function slewBuffer(
  library: Library,
  load: number,
  inputSlew: number,
  limit: number | undefined,
  design?: number,
): Cell | undefined {
  const buffers = byArea(library.cells.filter((cell) => isBuffer(cell) && cell.slew));
  if (buffers.length === 0 || limit === undefined) return undefined;
  const fit = buffers.find((cell) => {
    const cap = tranLimit(cell, design) ?? limit;
    return estimateSlew(cell, load, inputSlew) <= cap + 1e-9;
  });
  return fit ?? buffers[buffers.length - 1];
}

function fanoutFor(query: ArrivalQuery, mode: MapMode): number {
  if (query.maxFanout !== undefined && query.maxFanout >= 1) return query.maxFanout;
  return mode === "area" ? Number.POSITIVE_INFINITY : DEFAULT_MAX_FANOUT;
}

function slewRepairable(library: Library, query: ArrivalQuery): boolean {
  return (
    library.cells.some((cell) => cell.slew) &&
    (query.maxTransition !== undefined ||
      library.cells.some((cell) => cell.maxTran !== undefined && cell.slew))
  );
}

function electricalWork(library: Library, query: ArrivalQuery, mode: MapMode): boolean {
  if (mode !== "area") return true;
  if (slewRepairable(library, query)) return true;
  if (query.maxCapacitance !== undefined) return true;
  if (query.maxFanout !== undefined && query.maxFanout >= 1) return true;
  if (
    library.cells.some(
      (cell) => cell.maxCap !== undefined || cell.maxFanout !== undefined || cell.table,
    )
  )
    return true;
  for (const source of query.sourceLimit?.values() ?? []) {
    if (source.maxCap !== undefined || source.maxFanout !== undefined) return true;
  }
  return false;
}

/** Capacitance, fanout, and transition at this load. Slew is skipped when the library has no tables. */
export function cellMeets(
  library: Library,
  cell: Cell,
  cap: number,
  inputSlew: number,
  query: ArrivalQuery,
  mode: MapMode,
): boolean {
  if (!within(cell, cap, unitOf(library), fanoutFor(query, mode), query.maxCapacitance)) return false;
  if (!slewRepairable(library, query) || !cell.slew) return true;
  const limit = tranLimit(cell, query.maxTransition);
  if (limit === undefined) return true;
  return estimateSlew(cell, cap, inputSlew) <= limit + 1e-9;
}

function sourceOver(
  source: { maxCap?: number; maxFanout?: number; drive?: number },
  cap: number,
  unit: number,
  fallback: number,
): boolean {
  if (source.maxCap !== undefined && cap > source.maxCap + 1e-12) return true;
  const fan = source.maxFanout ?? fallback;
  return Number.isFinite(fan) && electrical(cap, source.drive ?? 1, unit) > fan + 1e-9;
}

function packIndexes(caps: readonly number[], ok: (load: number) => boolean): number[][] | undefined {
  if (caps.length === 0) return undefined;
  const groups: number[][] = [];
  let group: number[] = [];
  let load = 0;
  for (let index = 0; index < caps.length; index += 1) {
    const pin = caps[index] ?? 0;
    if (group.length > 0 && !ok(load + pin)) {
      groups.push(group);
      group = [];
      load = 0;
    }
    group.push(index);
    load += pin;
  }
  if (group.length > 0) groups.push(group);
  const sum = (indexes: readonly number[]) =>
    indexes.reduce((total, index) => total + (caps[index] ?? 0), 0);
  if (groups.some((item) => !ok(sum(item)))) return undefined;
  return groups;
}

export interface LoadRelief {
  kind: "buffer" | "clone";
  cell: Cell;
  /** Indexes of sinks that leave the original net. */
  groups: number[][];
}

/**
 * Move sinks off an illegal net. A buffer wins when it is legal and no heavier
 * than cloning the driver. Cloning is how a library with no usable buffer still splits.
 */
export function relieveNet(
  library: Library,
  sinkCaps: readonly number[],
  totalLoad: number,
  holds: (load: number) => boolean,
  cloneAs: Cell | undefined,
  cloneSlew: number,
  bufferSlew: number,
  query: ArrivalQuery,
  mode: MapMode,
): LoadRelief | undefined {
  if (sinkCaps.length === 0 || !(totalLoad > 0)) return undefined;
  const pinSum = sinkCaps.reduce((total, pin) => total + pin, 0);
  const extra = Math.max(0, totalLoad - pinSum);
  const useSlew =
    slewRepairable(library, query) && library.cells.some((cell) => isBuffer(cell) && cell.slew);
  const buffers = byArea(library.cells.filter((cell) => isBuffer(cell) && (!useSlew || cell.slew)));
  let bestBuffer: LoadRelief | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  const consider = (buffer: Cell, groups: number[][]) => {
    const driverLoad = extra + groups.length * buffer.cap;
    if (!(driverLoad < totalLoad - 1e-12) || !holds(driverLoad)) return;
    const area = groups.length * buffer.area;
    if (area < bestArea - 1e-9) {
      bestArea = area;
      bestBuffer = { kind: "buffer", cell: buffer, groups };
    }
  };
  for (const buffer of buffers) {
    const groups = packIndexes(sinkCaps, (load) =>
      cellMeets(library, buffer, load, bufferSlew, query, mode),
    );
    if (groups) consider(buffer, groups);
  }
  // The buffer's input slew is this driver's slew after the load drops, not the slew at the old load.
  if (!bestBuffer && cloneAs?.slew) {
    for (const buffer of buffers) {
      const guess = estimateSlew(cloneAs, extra + buffer.cap, cloneSlew);
      const groups = packIndexes(sinkCaps, (load) =>
        cellMeets(library, buffer, load, guess, query, mode),
      );
      if (!groups) continue;
      const driverLoad = extra + groups.length * buffer.cap;
      const settled = estimateSlew(cloneAs, driverLoad, cloneSlew);
      const ready = groups.every((group) => {
        const load = group.reduce((total, index) => total + (sinkCaps[index] ?? 0), 0);
        return cellMeets(library, buffer, load, settled, query, mode);
      });
      if (ready) consider(buffer, groups);
    }
  }
  let cloned: LoadRelief | undefined;
  if (cloneAs && sinkCaps.length >= 2) {
    const groups = packIndexes(sinkCaps, (load) =>
      cellMeets(library, cloneAs, load, cloneSlew, query, mode),
    );
    const stay = groups?.[groups.length - 1];
    if (groups && groups.length >= 2 && stay) {
      const stayLoad = extra + stay.reduce((total, index) => total + (sinkCaps[index] ?? 0), 0);
      if (holds(stayLoad) && stayLoad < totalLoad - 1e-12)
        cloned = { kind: "clone", cell: cloneAs, groups: groups.slice(0, -1) };
    }
  }
  if (bestBuffer && cloned)
    return bestArea <= cloned.groups.length * cloned.cell.area + 1e-9 ? bestBuffer : cloned;
  return bestBuffer ?? cloned;
}

function largerCell(
  library: Library,
  cell: Cell,
  cap: number,
  inputSlew: number,
  query: ArrivalQuery,
  mode: MapMode,
): Cell | undefined {
  const needSlew = slewRepairable(library, query) && cell.slew !== undefined;
  const fit = byArea(library.cells.filter((item) => item.family === cell.family)).find((item) => {
    if (item.area + 1e-9 < cell.area) return false;
    if (needSlew && !item.slew) return false;
    return cellMeets(library, item, cap, inputSlew, query, mode);
  });
  return fit && fit.name !== cell.name ? fit : undefined;
}

function applyRelief(
  list: MapGate[],
  relief: LoadRelief,
  drive: string,
  cloneInputs: readonly string[],
  sinks: readonly SlewSink[],
  nextId: number,
): number {
  for (const group of relief.groups) {
    const wire = `_${nextId}`;
    nextId += 1;
    list.push({
      cell: relief.cell.name,
      output: wire,
      inputs: relief.kind === "buffer" ? [drive] : [...cloneInputs],
    });
    for (const index of group) sinks[index]?.move(wire);
  }
  return nextId;
}

/** One wave of the shared electrical pass: size, then buffer or clone what sizing cannot fix. */
function closeElectrical(
  library: Library,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
  inputs: string[],
  mode: MapMode,
  query: ArrivalQuery,
  drivenSlew: ReadonlyMap<string, number>,
): MapGate[] {
  const cells = new Map(library.cells.map((cell) => [cell.name, cell]));
  const list = gates.map((gate) => ({ ...gate, inputs: [...gate.inputs] }));
  let nextId = nextWire(list);
  const fallback = fanoutFor(query, mode);
  const unit = unitOf(library);
  const checkSlew = slewRepairable(library, query);
  const slew0 = query.inputSlew ?? librarySlew(library);
  const timed = checkSlew
    ? arrivals(library, list, ties, inputs, new Map(), "cap", drivenSlew, query)
    : undefined;
  const caps = capMap(library, list, ties, query.outputLoad, query.ports, query);
  let grew = false;
  const stuck: MapGate[] = [];
  for (const gate of list) {
    const cell = cells.get(gate.cell);
    if (!cell) continue;
    const load = caps.get(gate.output) ?? 0;
    const incoming = timed ? worstInputSlew(gate, timed, slew0) : slew0;
    if (cellMeets(library, cell, load, incoming, query, mode)) continue;
    const fit = largerCell(library, cell, load, incoming, query, mode);
    if (fit) {
      gate.cell = fit.name;
      grew = true;
      continue;
    }
    stuck.push(gate);
  }
  let split = false;
  if (!grew) {
    for (const gate of stuck) {
      const cell = cells.get(gate.cell);
      if (!cell) continue;
      const sinks = netSinks(library, gate.output, list, ties, query);
      if (sinks.length === 0) continue;
      const incoming = timed ? worstInputSlew(gate, timed, slew0) : slew0;
      const relief = relieveNet(
        library,
        sinks.map((sink) => sink.cap),
        caps.get(gate.output) ?? 0,
        (load) => cellMeets(library, cell, load, incoming, query, mode),
        sinks.length >= 2 ? cell : undefined,
        incoming,
        timed ? timed.slewAt(gate.output) : incoming,
        query,
        mode,
      );
      if (!relief) continue;
      nextId = applyRelief(list, relief, gate.output, gate.inputs, sinks, nextId);
      split = true;
    }
  }
  for (const [net, source] of query.sourceLimit ?? []) {
    const load = caps.get(net) ?? 0;
    if (!sourceOver(source, load, unit, fallback)) continue;
    const sinks = netSinks(library, net, list, ties, query);
    if (sinks.length === 0) continue;
    const bufferSlew = drivenSlew.get(net) ?? timed?.slewAt(net) ?? slew0;
    const relief = relieveNet(
      library,
      sinks.map((sink) => sink.cap),
      load,
      (next) => !sourceOver(source, next, unit, fallback),
      undefined,
      bufferSlew,
      bufferSlew,
      query,
      mode,
    );
    if (!relief) continue;
    nextId = applyRelief(list, relief, net, [], sinks, nextId);
    split = true;
  }
  if (!grew && !split) return gates;
  return split ? orderGates(list) : list;
}

/**
 * Shared by area, delay, and load. Size a driver that misses max capacitance,
 * max transition, or a stated fanout. Then buffer the sinks, or clone the driver
 * when no buffer can take them. Area does not invent the implicit fanout of 4.
 */
export function repairLimits(
  library: Library,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
  inputs: string[],
  mode: MapMode,
  query: ArrivalQuery = {},
  drivenSlew: ReadonlyMap<string, number> = new Map(),
): MapGate[] {
  if (!electricalWork(library, query, mode)) return gates;
  let current = gates;
  for (let pass = 0; pass < 32; pass += 1) {
    const next = closeElectrical(library, current, ties, inputs, mode, query, drivenSlew);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function estimateSlew(cell: Cell, load: number, slew: number): number {
  if (!cell.slew) return slew;
  return Math.max(
    tableEdge(cell.slew, "rise", load, slew),
    tableEdge(cell.slew, "fall", load, slew),
  );
}

function pinGroups(cell: Cell): number[][] {
  const cached = groupCache.get(cell.name);
  if (cached) return cached;
  const width = cell.inputs.length;
  const parent = Array.from({ length: width }, (_, index) => index);
  const find = (index: number): number => {
    const at = parent[index] ?? index;
    if (at === index) return index;
    const root = find(at);
    parent[index] = root;
    return root;
  };
  const swapped = (mask: number, left: number, right: number): number => {
    const a = (mask >> left) & 1;
    const b = (mask >> right) & 1;
    return a === b ? mask : mask ^ (1 << left) ^ (1 << right);
  };
  const space = 1 << width;
  for (let left = 0; left < width; left += 1) {
    for (let right = left + 1; right < width; right += 1) {
      let same = true;
      for (let mask = 0; mask < space; mask += 1) {
        if (cell.fn(mask) !== cell.fn(swapped(mask, left, right))) {
          same = false;
          break;
        }
      }
      if (!same) continue;
      const a = find(left);
      const b = find(right);
      if (a !== b) parent[b] = a;
    }
  }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < width; index += 1) {
    const root = find(index);
    const list = groups.get(root) ?? [];
    list.push(index);
    groups.set(root, list);
  }
  const out = [...groups.values()].filter((group) => group.length > 1);
  groupCache.set(cell.name, out);
  return out;
}

const groupCache = new Map<string, number[][]>();

function pinArrival(
  cell: Cell,
  inputs: string[],
  load: number,
  netWire: number,
  fanout: number,
  timed: TimedNet,
  model: DelayModel,
): number {
  const plain =
    cell.delay +
    (model === "cap" ? load / (cell.drive > 0 ? cell.drive : 1) : loadDelay(fanout, cell.drive));
  const known = new Map<string, 0 | 1 | undefined>();
  inputs.forEach((net, index) => {
    const pin = cell.inputs[index] ?? "";
    const value = tied(net);
    if (pin && value !== undefined) known.set(pin, value);
  });
  let rise = 0;
  let fall = 0;
  let sawRise = false;
  let sawFall = false;
  inputs.forEach((net, index) => {
    const pin = cell.inputs[index] ?? "";
    const rose = { at: timed.edgeAt(net, "rise"), slew: timed.slewAt(net) };
    const fell = { at: timed.edgeAt(net, "fall"), slew: timed.slewAt(net) };
    for (const arc of arcsFor(cell, pin, known)) {
      const sense = arc.sense;
      const riseFrom = sense === "neg" ? [fell] : sense === "pos" ? [rose] : [rose, fell];
      const fallFrom = sense === "neg" ? [rose] : sense === "pos" ? [fell] : [rose, fell];
      for (const src of riseFrom) {
        const done = src.at + arcOf(arc.table, "rise", load, src.slew, plain) + netWire;
        if (!sawRise || done > rise) {
          rise = done;
          sawRise = true;
        }
      }
      for (const src of fallFrom) {
        const done = src.at + arcOf(arc.table, "fall", load, src.slew, plain) + netWire;
        if (!sawFall || done > fall) {
          fall = done;
          sawFall = true;
        }
      }
    }
  });
  return Math.max(sawRise ? rise : 0, sawFall ? fall : 0);
}

function assignPins(
  cell: Cell,
  inputs: string[],
  group: number[],
  load: number,
  netWire: number,
  fanout: number,
  timed: TimedNet,
  model: DelayModel,
): string[] {
  const nets = group.map((index) => inputs[index] ?? "");
  let best = inputs;
  let bestCost = pinArrival(cell, inputs, load, netWire, fanout, timed, model);
  for (const perm of PERMS[group.length] ?? []) {
    const trial = inputs.slice();
    for (let slot = 0; slot < group.length; slot += 1)
      trial[group[slot] ?? 0] = nets[perm[slot] ?? 0] ?? "";
    const cost = pinArrival(cell, trial, load, netWire, fanout, timed, model);
    if (cost < bestCost - 1e-4) {
      best = trial;
      bestCost = cost;
    }
  }
  return best;
}

/** Put the later input on the faster arc. Only pins that commute are swapped. */
function reorderInputs(
  library: Library,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
  inputs: string[],
  mode: MapMode,
  query: ArrivalQuery,
): MapGate[] {
  if (!gates.some((gate) => gate.inputs.length > 1)) return gates;
  const tabular = library.cells.some((cell) => (cell.arcs?.length ?? 0) > 0 || cell.table);
  const model: DelayModel = mode === "load" || tabular ? "cap" : "count";
  let current = orderGates(gates);
  const time = (list: MapGate[]) =>
    arrivals(library, list, ties, inputs, new Map(), model, new Map(), query).delay;
  let best = time(current);
  for (let pass = 0; pass < 3; pass += 1) {
    const timed = arrivals(library, current, ties, inputs, new Map(), model, new Map(), query);
    const caps = capMap(library, current, ties, query.outputLoad, query.ports, query);
    const wires = wireDelayMap(library, current, ties, query);
    const fans = fanoutMap(current, ties);
    const next = current.map((gate) => ({ ...gate, inputs: [...gate.inputs] }));
    let moved = false;
    for (const gate of next) {
      const cell = library.cells.find((item) => item.name === gate.cell);
      if (!cell || cell.inputs.length < 2) continue;
      const groups = pinGroups(cell);
      if (groups.length === 0) continue;
      let assigned = gate.inputs;
      const load = caps.get(gate.output) ?? 0;
      const wire = wires.get(gate.output) ?? 0;
      const fanout = fans.get(gate.output) ?? 1;
      for (const group of groups)
        assigned = assignPins(cell, assigned, group, load, wire, fanout, timed, model);
      if (assigned.some((net, index) => net !== gate.inputs[index])) {
        gate.inputs = assigned;
        moved = true;
      }
    }
    if (!moved) break;
    const delay = time(next);
    if (delay > best + 1e-4) break;
    current = next;
    best = delay;
  }
  return current;
}

function prepareDrive(
  library: Library,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
  inputs: string[],
  mode: MapMode,
  query: ArrivalQuery = {},
): MapGate[] {
  const finish = (sized: MapGate[]) =>
    repairLimits(
      library,
      reorderInputs(library, sized, ties, inputs, mode, query),
      ties,
      inputs,
      mode,
      query,
    );
  if (mode === "area") return finish(gates);
  const legal = legalize(library, gates, ties, query);
  if (mode === "delay") return finish(orderGates(sizeByFanout(library, legal, ties, query)));
  return finish(
    orderGates(
      legalize(
        library,
        sizeForLoad(library, legal, ties, inputs, query, query.arrivalBudget),
        ties,
        query,
      ),
    ),
  );
}

function variantsOf(library: Library, family: string): Cell[] {
  return byArea(library.cells.filter((cell) => cell.family === family));
}

function capScore(
  library: Library,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
  inputs: string[],
  query: ArrivalQuery = {},
): { delay: number; area: number; at: Map<string, number> } {
  const timed = arrivals(library, gates, ties, inputs, new Map(), "cap", new Map(), query);
  const area = gates.reduce(
    (sum, gate) => sum + (library.cells.find((cell) => cell.name === gate.cell)?.area ?? 0),
    0,
  );
  return { delay: timed.delay, area, at: timed.at };
}

function spine(gates: MapGate[], ties: { wire: string }[], at: Map<string, number>): Set<string> {
  let wire = "";
  let best = -1;
  for (const tie of ties) {
    if (tie.wire === "1'b0" || tie.wire === "1'b1") continue;
    const here = at.get(tie.wire) ?? 0;
    if (here > best) {
      best = here;
      wire = tie.wire;
    }
  }
  const byOut = new Map(gates.map((gate) => [gate.output, gate]));
  const outs = new Set<string>();
  const seen = new Set<string>();
  while (wire && !seen.has(wire)) {
    seen.add(wire);
    const gate = byOut.get(wire);
    if (!gate) break;
    outs.add(gate.output);
    let slow = gate.inputs[0] ?? "";
    for (const net of gate.inputs) if ((at.get(net) ?? 0) > (at.get(slow) ?? 0)) slow = net;
    wire = slow;
  }
  return outs;
}

function sizeForLoad(
  library: Library,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
  inputs: string[],
  query: ArrivalQuery = {},
  budget?: number,
): MapGate[] {
  let current = gates.map((gate) => ({ ...gate, inputs: [...gate.inputs] }));
  let score = capScore(library, current, ties, inputs, query);
  const allowed = (delay: number): boolean => budget !== undefined && delay <= budget + 1e-6;
  if (!allowed(score.delay)) {
    for (let iter = 0; iter < 12; iter += 1) {
      const onPath = spine(current, ties, score.at);
      let nextGates = current;
      let nextScore = score;
      for (let index = 0; index < current.length; index += 1) {
        const gate = current[index];
        if (!gate || !onPath.has(gate.output)) continue;
        const cell = library.cells.find((item) => item.name === gate.cell);
        if (!cell) continue;
        const next = variantsOf(library, cell.family)[
          variantsOf(library, cell.family).findIndex((item) => item.name === cell.name) + 1
        ];
        if (!next) continue;
        const trial = current.map((item, place) =>
          place === index ? { ...item, cell: next.name } : item,
        );
        const trialScore = capScore(library, trial, ties, inputs, query);
        if (trialScore.delay < nextScore.delay - 0.001) {
          nextGates = trial;
          nextScore = trialScore;
        }
      }
      if (nextGates === current) break;
      current = nextGates;
      score = nextScore;
      if (allowed(score.delay)) break;
    }
  }
  const room = budget ?? score.delay;
  for (let sweep = 0; sweep < 4; sweep += 1) {
    let shrunk = false;
    for (let index = 0; index < current.length; index += 1) {
      const gate = current[index];
      if (!gate) continue;
      const cell = library.cells.find((item) => item.name === gate.cell);
      if (!cell) continue;
      const options = variantsOf(library, cell.family);
      const prev = options[options.findIndex((item) => item.name === cell.name) - 1];
      if (!prev) continue;
      const caps = capMap(library, current, ties, query.outputLoad, query.ports, query);
      if (
        !within(
          prev,
          caps.get(gate.output) ?? 0,
          unitOf(library),
          fanoutFallback(query),
          query.maxCapacitance,
        )
      )
        continue;
      const trial = current.map((item, place) =>
        place === index ? { ...item, cell: prev.name } : item,
      );
      const trialScore = capScore(library, trial, ties, inputs, query);
      if (trialScore.delay <= room + 0.001 && trialScore.area < score.area) {
        current = trial;
        score = trialScore;
        shrunk = true;
      }
    }
    if (!shrunk) break;
  }
  return current;
}

export interface TimedNet {
  delay: number;
  rise: number;
  fall: number;
  path: PathStep[];
  risePath: PathStep[];
  fallPath: PathStep[];
  at: Map<string, number>;
  edgeAt: (wire: string, edge: "rise" | "fall") => number;
  slewAt: (wire: string) => number;
  slewEdge: (wire: string, edge: "rise" | "fall") => number;
  pathTo: (wire: string, name: string, edge?: "rise" | "fall") => PathStep[];
}

export function arrivals(
  library: Library,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
  inputs: string[],
  launch: ReadonlyMap<string, number> = new Map(),
  model: DelayModel = "count",
  drivenSlew: ReadonlyMap<string, number> = new Map(),
  query: ArrivalQuery = {},
): TimedNet {
  type Stamp = { at: number; slew: number; from: string; fromEdge: "rise" | "fall" };
  const delayOf = new Map(library.cells.map((cell) => [cell.name, cell]));
  const tabular = library.cells.some((cell) => cell.table);
  const counts = model === "count" ? fanoutMap(gates, ties) : new Map<string, number>();
  const caps =
    model === "cap" || tabular
      ? capMap(library, gates, ties, query.outputLoad, query.ports, query)
      : new Map<string, number>();
  const wires = wireDelayMap(library, gates, ties, query);
  const extra = (net: string, drive: number) =>
    model === "cap" ? (caps.get(net) ?? 0) / drive : loadDelay(counts.get(net) ?? 0, drive);
  const piSlew = query.inputSlew ?? librarySlew(library);
  const inputDelay = query.inputDelay ?? 0;
  const slower = query.extreme !== "min";
  const at = new Map<string, number>();
  const riseAt = new Map<string, Stamp>();
  const fallAt = new Map<string, Stamp>();
  const seed = (name: string, when: number, slew: number) => {
    at.set(name, when);
    riseAt.set(name, { at: when, slew, from: name, fromEdge: "rise" });
    fallAt.set(name, { at: when, slew, from: name, fromEdge: "fall" });
  };
  for (const name of inputs) {
    const forced = launch.get(name);
    const launched = forced !== undefined;
    const added = query.portDelay?.get(name) ?? inputDelay;
    const base = launched ? tidy(forced) : tabular ? 0 : tidy(extra(name, 1));
    const spec = launched
      ? undefined
      : (query.portDrive?.get(name) ??
        (query.drivingInputs?.has(name) ? query.drivingCell : undefined));
    const slew =
      query.portSlew?.get(name) ??
      (spec
        ? drivingSlew(library, spec, caps.get(name) ?? 0, piSlew)
        : (drivenSlew.get(name) ?? piSlew));
    seed(name, launched ? base : tidy(base + added), slew);
  }
  const byOut = new Map<string, MapGate>();
  for (const gate of gates) {
    const cell = delayOf.get(gate.cell);
    const load = caps.get(gate.output) ?? 0;
    let bestRise: Stamp = { at: 0, slew: piSlew, from: gate.inputs[0] ?? "", fromEdge: "rise" };
    let bestFall: Stamp = { at: 0, slew: piSlew, from: gate.inputs[0] ?? "", fromEdge: "fall" };
    let sawRise = false;
    let sawFall = false;
    const netWire = wires.get(gate.output) ?? 0;
    const plain = (cell?.delay ?? 0) + extra(gate.output, cell?.drive || 1);
    const known = new Map<string, 0 | 1 | undefined>();
    gate.inputs.forEach((net, index) => {
      const pin = cell?.inputs[index] ?? "";
      const value = tied(net);
      if (pin && value !== undefined) known.set(pin, value);
    });
    gate.inputs.forEach((net, index) => {
      const pin = cell?.inputs[index] ?? "";
      const rose = riseAt.get(net) ?? { at: 0, slew: piSlew, from: net, fromEdge: "rise" as const };
      const fell = fallAt.get(net) ?? { at: 0, slew: piSlew, from: net, fromEdge: "fall" as const };
      for (const arc of arcsFor(cell, pin, known)) {
        const sense = arc.sense;
        const riseFrom =
          sense === "neg"
            ? [{ stamp: fell, edge: "fall" as const }]
            : sense === "pos"
              ? [{ stamp: rose, edge: "rise" as const }]
              : [
                  { stamp: rose, edge: "rise" as const },
                  { stamp: fell, edge: "fall" as const },
                ];
        const fallFrom =
          sense === "neg"
            ? [{ stamp: rose, edge: "rise" as const }]
            : sense === "pos"
              ? [{ stamp: fell, edge: "fall" as const }]
              : [
                  { stamp: rose, edge: "rise" as const },
                  { stamp: fell, edge: "fall" as const },
                ];
        for (const src of riseFrom) {
          const done =
            src.stamp.at + arcOf(arc.table, "rise", load, src.stamp.slew, plain) + netWire;
          if (!sawRise || (slower ? done > bestRise.at : done < bestRise.at)) {
            bestRise = {
              at: done,
              slew: slewOut(arc.slew, "rise", load, src.stamp.slew),
              from: net,
              fromEdge: src.edge,
            };
            sawRise = true;
          }
        }
        for (const src of fallFrom) {
          const done =
            src.stamp.at + arcOf(arc.table, "fall", load, src.stamp.slew, plain) + netWire;
          if (!sawFall || (slower ? done > bestFall.at : done < bestFall.at)) {
            bestFall = {
              at: done,
              slew: slewOut(arc.slew, "fall", load, src.stamp.slew),
              from: net,
              fromEdge: src.edge,
            };
            sawFall = true;
          }
        }
      }
    });
    at.set(gate.output, tidy(Math.max(bestRise.at, bestFall.at)));
    riseAt.set(gate.output, { ...bestRise, at: tidy(bestRise.at) });
    fallAt.set(gate.output, { ...bestFall, at: tidy(bestFall.at) });
    byOut.set(gate.output, gate);
  }

  function preferred(wire: string): "rise" | "fall" {
    return (riseAt.get(wire)?.at ?? 0) >= (fallAt.get(wire)?.at ?? 0) ? "rise" : "fall";
  }

  function edgeAt(wire: string, edge: "rise" | "fall"): number {
    return (edge === "rise" ? riseAt : fallAt).get(wire)?.at ?? 0;
  }

  function slewAt(wire: string): number {
    return Math.max(riseAt.get(wire)?.slew ?? 0, fallAt.get(wire)?.slew ?? 0);
  }

  function slewEdge(wire: string, edge: "rise" | "fall"): number {
    return (edge === "rise" ? riseAt : fallAt).get(wire)?.slew ?? 0;
  }

  function pathTo(wire: string, name: string, which?: "rise" | "fall"): PathStep[] {
    const edge = which ?? preferred(wire);
    if (wire === "1'b0" || wire === "1'b1") return [{ label: name, at: 0, incr: 0, slew: 0, edge }];
    const chain: { label: string; wire: string; edge: "rise" | "fall" }[] = [];
    let cursor = wire;
    let walk = edge;
    const seen = new Set<string>();
    while (!seen.has(cursor)) {
      seen.add(cursor);
      const gate = byOut.get(cursor);
      const stamp = (walk === "rise" ? riseAt : fallAt).get(cursor);
      if (!gate || !stamp) {
        chain.push({ label: cursor, wire: cursor, edge: walk });
        break;
      }
      chain.push({ label: gate.cell, wire: cursor, edge: walk });
      cursor = stamp.from;
      walk = stamp.fromEdge;
    }
    chain.reverse();
    const steps = [...chain, { label: name, wire, edge }].map((step) => {
      const stamp = (step.edge === "rise" ? riseAt : fallAt).get(step.wire);
      return {
        label: step.label,
        at: stamp?.at ?? 0,
        slew: tidy(stamp?.slew ?? 0),
        edge: step.edge,
      };
    });
    return steps.map((step, index) => ({
      ...step,
      incr: index === 0 ? step.at : tidy(step.at - (steps[index - 1]?.at ?? 0)),
    }));
  }

  let bestName = "";
  let bestAt = 0;
  let bestWire = "";
  for (const tie of ties) {
    if (tie.wire === "1'b0" || tie.wire === "1'b1") continue;
    const here = at.get(tie.wire) ?? 0;
    if (bestName === "" || here > bestAt) {
      bestName = tie.name;
      bestAt = here;
      bestWire = tie.wire;
    }
  }
  if (bestName === "") {
    return {
      delay: 0,
      rise: 0,
      fall: 0,
      path: [],
      risePath: [],
      fallPath: [],
      at,
      edgeAt,
      slewAt,
      slewEdge,
      pathTo,
    };
  }
  return {
    delay: bestAt,
    rise: edgeAt(bestWire, "rise"),
    fall: edgeAt(bestWire, "fall"),
    path: pathTo(bestWire, bestName),
    risePath: pathTo(bestWire, bestName, "rise"),
    fallPath: pathTo(bestWire, bestName, "fall"),
    at,
    edgeAt,
    slewAt,
    slewEdge,
    pathTo,
  };
}

function tied(net: string): 0 | 1 | undefined {
  if (net === "0" || net === "1'b0") return 0;
  if (net === "1" || net === "1'b1") return 1;
  return undefined;
}

function arcsFor(
  cell: Cell | undefined,
  pin: string,
  known: ReadonlyMap<string, 0 | 1 | undefined>,
): { table?: LoadTable; slew?: LoadTable; sense: "pos" | "neg" | "non" }[] {
  const matched = (cell?.arcs ?? []).filter(
    (arc) => arc.pin === pin && (!arc.when || arc.when(known)),
  );
  if (matched.length > 0) return matched;
  if ((cell?.arcs ?? []).some((arc) => arc.pin === pin)) return [];
  return [{ table: cell?.table, slew: cell?.slew, sense: cell?.sense ?? "non" }];
}

export function librarySlew(library: Library): number {
  for (const cell of library.cells) {
    const slew = cell.table?.slews.find((value) => value > 0);
    if (slew) return slew;
  }
  for (const flop of library.flops) {
    const slew = flop.qTable?.slews.find((value) => value > 0);
    if (slew) return slew;
  }
  return 0;
}

export function drivingSlew(
  library: Library,
  spec: DrivingCell,
  load: number,
  inputSlew: number,
): number {
  const cell = library.cells.find((item) => item.name === spec.cell);
  if (!cell) throw new Error(`no driving cell ${spec.cell}`);
  if (spec.pin && cell.output && cell.output !== spec.pin)
    throw new Error(`driving cell ${spec.cell} has no pin ${spec.pin}`);
  if (spec.pin && !cell.output && spec.pin !== "Y")
    throw new Error(`driving cell ${spec.cell} has no pin ${spec.pin}`);
  const pinSlew =
    spec.rise !== undefined || spec.fall !== undefined
      ? Math.max(spec.rise ?? inputSlew, spec.fall ?? inputSlew)
      : inputSlew;
  const arc = spec.fromPin ? cell.arcs?.find((item) => item.pin === spec.fromPin) : undefined;
  if (spec.fromPin && !arc) throw new Error(`driving cell ${spec.cell} has no pin ${spec.fromPin}`);
  const table = arc?.slew ?? cell.slew;
  if (!table) return cell.delay / (cell.drive > 0 ? cell.drive : 1);
  return Math.max(tableEdge(table, "rise", load, pinSlew), tableEdge(table, "fall", load, pinSlew));
}

function arcOf(
  table: Cell["table"],
  edge: "rise" | "fall",
  load: number,
  slew: number,
  otherwise: number,
): number {
  return table ? tableEdge(table, edge, load, slew) : otherwise;
}

function slewOut(table: Cell["slew"], edge: "rise" | "fall", load: number, slew: number): number {
  return table ? tableEdge(table, edge, load, slew) : slew;
}

function criticalPath(
  library: Library,
  gates: MapGate[],
  ties: { name: string; wire: string }[],
  inputs: string[],
  model: DelayModel = "count",
  query: ArrivalQuery = {},
): TimedNet {
  return arrivals(library, gates, ties, inputs, new Map(), model, new Map(), query);
}

function previewRows(rows: MapRow[]): MapRow[] {
  if (rows.length <= 16) return rows;
  return [
    ...rows.filter((row) => !row.match).slice(0, 8),
    ...rows.filter((row) => row.match).slice(0, 8),
  ];
}

function choiceArrival(
  pos: Map<number, Choice>,
  neg: Map<number, Choice>,
  node: number,
  pol: "pos" | "neg",
): number {
  return (pol === "pos" ? pos : neg).get(node)?.arrival ?? 0;
}

/** Absolute arrival each literal may use without missing `budget`. Null when the fast cover is already late. */
function requiredLimits(
  graph: SubjectGraph,
  pos: Map<number, Choice>,
  neg: Map<number, Choice>,
  budget: number,
): Map<string, number> | null {
  let crit = 0;
  const ends: { node: number; pol: "pos" | "neg" }[] = [];
  for (const output of graph.outputs) {
    if (output.lit <= 1) continue;
    const node = nodeOf(output.lit);
    const pol = invOf(output.lit) ? "neg" : "pos";
    crit = Math.max(crit, choiceArrival(pos, neg, node, pol));
    ends.push({ node, pol });
  }
  if (ends.length === 0 || !(budget > crit + 0.02)) return null;
  const req = new Map<string, number>();
  const stack = new Set<string>();
  const visit = (node: number, pol: "pos" | "neg", need: number): void => {
    const key = fanKey(node, pol);
    const prev = req.get(key);
    if (prev !== undefined && need >= prev - 1e-9) return;
    if (stack.has(key)) return;
    req.set(key, prev === undefined ? need : Math.min(prev, need));
    stack.add(key);
    const choice = pol === "pos" ? pos.get(node) : neg.get(node);
    if (choice?.kind === "inv") {
      const other = pol === "pos" ? "neg" : "pos";
      const delay = Math.max(0, choice.arrival - choiceArrival(pos, neg, node, other));
      visit(node, other, need - delay);
    } else if (choice?.kind === "cell") {
      let maxLeaf = 0;
      const pins = choice.leaves.map((leaf, index) => {
        const leafPol: "pos" | "neg" = choice.pinInv[index] ? "neg" : "pos";
        const at = choiceArrival(pos, neg, leaf, leafPol);
        maxLeaf = Math.max(maxLeaf, at);
        return { leaf, leafPol };
      });
      const delay = Math.max(0, choice.arrival - maxLeaf);
      for (const pin of pins) visit(pin.leaf, pin.leafPol, need - delay);
    }
    stack.delete(key);
  };
  for (const end of ends) visit(end.node, end.pol, budget);
  // The fast cover never visits a cut it did not pick. Those literals may still
  // slow down by the whole slack; the backward walk above is tighter on its own cone.
  const slack = budget - crit;
  for (const and of graph.ands) {
    for (const pol of ["pos", "neg"] as const) {
      const key = fanKey(and.node, pol);
      if (req.has(key)) continue;
      const choice = pol === "pos" ? pos.get(and.node) : neg.get(and.node);
      if (!choice || choice.kind === "pi") continue;
      req.set(key, choice.arrival + slack);
    }
  }
  return req;
}

function chooseCover(
  graph: SubjectGraph,
  library: Library,
  mode: MapMode,
  seeds: ReadonlyMap<number, readonly PatternSeed[]>,
  budget?: number,
): { pos: Map<number, Choice>; neg: Map<number, Choice> } {
  const inv = inverterOf(library);
  const book = matchBook(library);
  const cuts = enumerateCuts(graph, book);
  const pos = new Map<number, Choice>();
  const neg = new Map<number, Choice>();
  let refs = structuralFanout(graph);
  let cap: Map<number, { pos: number; neg: number }> | null = null;
  let recover: Map<string, number> | null = null;
  for (let iter = 0; iter < 2; iter += 1) {
    if (iter === 1 && mode === "load" && budget !== undefined)
      recover = requiredLimits(graph, pos, neg, budget);
    pos.clear();
    neg.clear();
    for (const input of graph.inputs) {
      const fan = Math.max(1, refs.get(fanKey(input.node, "neg")) ?? 1);
      pos.set(input.node, { kind: "pi", tree: 0, arrival: 0 });
      neg.set(input.node, { kind: "inv", tree: inv.area / fan, arrival: inv.delay });
    }
    for (const and of graph.ands) {
      coverNode(
        graph,
        and.node,
        cuts.get(and.node) ?? [],
        library,
        mode,
        refs,
        recover ? null : cap,
        pos,
        neg,
        seeds.get(and.node) ?? [],
        recover,
        book,
      );
    }
    if (iter === 0 && mode !== "area") {
      cap = new Map();
      for (const and of graph.ands) {
        cap.set(and.node, {
          pos: pos.get(and.node)?.arrival ?? Number.POSITIVE_INFINITY,
          neg: neg.get(and.node)?.arrival ?? Number.POSITIVE_INFINITY,
        });
      }
    }
    const used = coverFanout(graph, pos, neg);
    if (used.size > 0) refs = used;
  }
  return { pos, neg };
}

function packChoice(choice: Choice | undefined): LogicChoice {
  if (choice?.kind === "cell")
    return {
      kind: "cell",
      cell: choice.cell,
      leaves: [...choice.leaves],
      pinInv: [...choice.pinInv],
    };
  if (choice?.kind === "inv") return { kind: "inv", cell: "", leaves: [], pinInv: [] };
  return { kind: "pi", cell: "", leaves: [], pinInv: [] };
}

/** Positive and negative covers the mapper picked, before buffers. Node ids match `subjectGraph`. */
export function logicChoices(
  netlist: Netlist,
  source: LibrarySource,
  mode: MapMode = "area",
): { graph: SubjectGraph; pos: Map<number, LogicChoice>; neg: Map<number, LogicChoice> } {
  const library = resolveLibrary(source);
  const graph = subjectGraph(netlist, mode);
  const { pos, neg } = chooseCover(graph, library, mode, new Map());
  return {
    graph,
    pos: new Map([...pos.entries()].map(([node, choice]) => [node, packChoice(choice)])),
    neg: new Map([...neg.entries()].map(([node, choice]) => [node, packChoice(choice)])),
  };
}

export interface SpineHop {
  node: number;
  pol: "pos" | "neg";
  arrival: number;
  kind: "cell" | "inv" | "pi";
  cell: string;
  leaves: number[];
  pinInv: boolean[];
  leafAt: number[];
  lateLeaf: number | null;
  latePol: "pos" | "neg" | null;
}

/** Late pin of the cover, from the worst output back to a primary input. */
export function criticalSpine(
  netlist: Netlist,
  source: LibrarySource,
  mode: MapMode = "delay",
): { graph: SubjectGraph; hops: SpineHop[] } {
  const library = resolveLibrary(source);
  const graph = subjectGraph(netlist, mode);
  const { pos, neg } = chooseCover(graph, library, mode, new Map());
  let best: { node: number; pol: "pos" | "neg"; arrival: number } | null = null;
  for (const output of graph.outputs) {
    if (output.lit <= 1) continue;
    const node = nodeOf(output.lit);
    const pol = invOf(output.lit) ? "neg" : "pos";
    const arrival = choiceArrival(pos, neg, node, pol);
    if (!best || arrival > best.arrival) best = { node, pol, arrival };
  }
  const hops: SpineHop[] = [];
  if (!best) return { graph, hops };
  const seen = new Set<string>();
  let node = best.node;
  let pol = best.pol;
  while (!seen.has(`${node}:${pol}`) && hops.length < 64) {
    seen.add(`${node}:${pol}`);
    const choice = pol === "pos" ? pos.get(node) : neg.get(node);
    if (!choice) break;
    if (choice.kind === "pi") {
      hops.push({
        node,
        pol,
        arrival: choice.arrival,
        kind: "pi",
        cell: "",
        leaves: [],
        pinInv: [],
        leafAt: [],
        lateLeaf: null,
        latePol: null,
      });
      break;
    }
    if (choice.kind === "inv") {
      const latePol = pol === "pos" ? "neg" : "pos";
      hops.push({
        node,
        pol,
        arrival: choice.arrival,
        kind: "inv",
        cell: "",
        leaves: [],
        pinInv: [],
        leafAt: [],
        lateLeaf: node,
        latePol,
      });
      pol = latePol;
      continue;
    }
    let lateLeaf: number | null = null;
    let latePol: "pos" | "neg" | null = null;
    let lateAt = -1;
    const leafAt = choice.leaves.map((leaf, index) =>
      choiceArrival(pos, neg, leaf, choice.pinInv[index] ? "neg" : "pos"),
    );
    leafAt.forEach((at, index) => {
      const leaf = choice.leaves[index] ?? 0;
      const later =
        lateLeaf === null ||
        at > lateAt + 1e-9 ||
        (Math.abs(at - lateAt) <= 1e-9 && leaf > lateLeaf);
      if (!later) return;
      lateAt = at;
      lateLeaf = leaf;
      latePol = choice.pinInv[index] ? "neg" : "pos";
    });
    hops.push({
      node,
      pol,
      arrival: choice.arrival,
      kind: "cell",
      cell: choice.cell,
      leaves: [...choice.leaves],
      pinInv: [...choice.pinInv],
      leafAt,
      lateLeaf,
      latePol,
    });
    if (lateLeaf === null || latePol === null) break;
    node = lateLeaf;
    pol = latePol;
  }
  return { graph, hops };
}

export function mapNetlist(
  netlist: Netlist,
  source: LibrarySource,
  mode: MapMode = "area",
  query: ArrivalQuery = {},
  seeds: ReadonlyMap<number, readonly PatternSeed[]> = new Map(),
): MapReport {
  const library = resolveLibrary(source);
  const graph = subjectGraph(netlist, mode);
  const { pos, neg } = chooseCover(
    graph,
    library,
    mode,
    seeds,
    mode === "load" ? query.arrivalBudget : undefined,
  );
  const inv = inverterOf(library);
  const piName = new Map<string, string>();
  for (const input of graph.inputs) piName.set(`${input.node}:pos`, input.name);

  const areas = new Map(library.cells.map((cell) => [cell.name, cell.area]));
  const state: EmitState = {
    pos,
    neg,
    wires: new Map(piName),
    gates: [],
    areas,
    inverter: inv.name,
    next: 0,
  };
  const ties: { name: string; wire: string }[] = [];

  for (const output of graph.outputs) {
    if (output.lit <= 1) {
      ties.push({ name: output.name, wire: output.lit === 1 ? "1'b1" : "1'b0" });
      continue;
    }
    const wire = emit(state, nodeOf(output.lit), invOf(output.lit) ? "neg" : "pos");
    ties.push({ name: output.name, wire });
  }

  state.gates = prepareDrive(library, state.gates, ties, netlist.inputs, mode, query);
  const stitched = stitchTies(library, state.gates, ties);
  state.gates = isolatePorts(library, stitched.gates, stitched.ties, query);
  const drives = stitched.ties;
  const area = state.gates.reduce((sum, gate) => sum + (areas.get(gate.cell) ?? 0), 0);
  const timed = criticalPath(
    library,
    state.gates,
    drives,
    netlist.inputs,
    mode === "load" ? "cap" : "count",
    query,
  );
  const plan = vectorIndexes(netlist.inputs.length);
  const rows: MapRow[] = [];
  let mismatches = 0;
  const simTies = drives.map((tie) => ({ name: tie.name, expr: tie.wire }));
  for (const index of plan.indexes) {
    const assign = inputAssignment(index, netlist.inputs);
    const fromNet = evalNetlist(netlist, assign);
    const fromMap = evalMapped(library, state.gates, simTies, assign);
    const outputs = netlist.outputs.map((name) => {
      const net = fromNet.get(name);
      const mapped = fromMap.get(name);
      if (net === undefined || mapped === undefined) throw new Error(`output ${name} missing`);
      return { name, net, mapped };
    });
    const match = outputs.every((output) => output.net === output.mapped);
    if (!match) mismatches += 1;
    rows.push({
      inputs: netlist.inputs.map((name) => ({ name, value: assign.get(name) ?? 0 })),
      outputs,
      match,
    });
  }

  return {
    library: library.name,
    mode,
    area,
    delay: timed.delay,
    rise: timed.rise,
    fall: timed.fall,
    path: timed.path,
    risePath: timed.risePath,
    fallPath: timed.fallPath,
    cells: state.gates.map((gate) => gate.cell),
    gates: state.gates,
    drives: drives,
    limited: true,
    over: [
      ...overLimit(library, state.gates, drives, query),
      ...transitionHits(library, state.gates, timed, query.maxTransition),
    ],
    verilog: renderVerilog(netlist, state.gates, drives),
    equiv: {
      exhaustive: plan.exhaustive,
      vectors: rows.length,
      mismatches,
      rows: previewRows(rows),
    },
  };
}
