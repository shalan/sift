import {
  baseCells,
  inverterOf,
  resolveLibrary,
  type Cell,
  type Library,
  type LibrarySource,
} from "./library.ts";
import { logicChoices, type LogicChoice, type MapMode, type PatternSeed } from "./map.ts";
import type { Netlist } from "./netlist.ts";
import { comboCloud, flopsOf, mapDesign, type Constraints, type DesignReport } from "./seq.ts";

const MIN_ANDS = 3;
const MAX_ANDS = 8;
const MAX_PINS = 8;
const EXPLORE = 256;
const KEEP_EACH = 12;
const MIN_HITS = 2;

export interface ProposedCell {
  name: string;
  ands: number;
  pins: number;
  occurrences: number;
  coverCells: number;
  score: number;
  area: number;
  delay: number;
  expr: string;
  shape: string;
}

export interface ProposalReport {
  examined: number;
  shapes: number;
  skippedNpn: number;
  skippedRare: number;
  skippedScore: number;
  skippedWide: number;
  cost: string;
  cells: ProposedCell[];
  before: { area: number; delay: number; cells: number };
  after: { area: number; delay: number; cells: number };
  used: { name: string; count: number }[];
  mismatches: number;
  library: Library;
  seeds: Map<number, PatternSeed[]>;
  mapped: DesignReport;
}

interface PinRef {
  inv: boolean;
  gate: number | null;
  pin: number | null;
}

interface Frag {
  gates: { a: PinRef; b: PinRef }[];
  root: number;
}

interface Side {
  inv: boolean;
  gate: number | null;
  leaf: number | null;
}

interface Local {
  root: number;
  gates: { a: Side; b: Side }[];
  leafIds: number[];
}

interface Graph {
  nAnd: number;
  nLeaf: number;
  root: number;
  ins: { to: number; inv: boolean }[][];
}

interface Hit {
  root: number;
  nodes: number[];
  pins: number[];
  frag: Frag;
  cells: number;
  tt: string;
  shape: string;
}

const PERMS: number[][][] = [0, 1, 2, 3, 4].map((count) => {
  const out: number[][] = [];
  const used = Array<boolean>(count).fill(false);
  const current: number[] = [];
  const walk = (): void => {
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
  };
  walk();
  return out;
});

function tidy(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function nodeOf(lit: number): number {
  return lit >>> 1;
}

function evalFrag(frag: Frag, mask: number): 0 | 1 {
  const bits: number[] = [];
  const read = (ref: PinRef): 0 | 1 => {
    const base = ref.gate !== null ? (bits[ref.gate] ?? 0) : (mask >> (ref.pin ?? 0)) & 1;
    return (base ^ (ref.inv ? 1 : 0)) === 1 ? 1 : 0;
  };
  for (const gate of frag.gates) bits.push((read(gate.a) & read(gate.b)) === 1 ? 1 : 0);
  return bits[frag.root] === 1 ? 1 : 0;
}

function truthBits(frag: Frag, width: number): string {
  const space = 1 << width;
  let bits = "";
  for (let mask = 0; mask < space; mask += 1) bits += evalFrag(frag, mask);
  return bits;
}

function pinName(index: number): string {
  return "abcdefgh"[index] ?? `p${index}`;
}

function exprOf(frag: Frag): string {
  const name = new Map<number, string>();
  const lines: string[] = [];
  const expr = (ref: PinRef): string => {
    const body = ref.gate === null ? pinName(ref.pin ?? 0) : gate(ref.gate);
    return ref.inv ? `~${body}` : body;
  };
  const gate = (index: number): string => {
    const hit = name.get(index);
    if (hit) return hit;
    const id = index === frag.root ? "y" : `t${index}`;
    name.set(index, id);
    const row = frag.gates[index];
    if (!row) return id;
    lines.push(`${id}=${expr(row.a)}&${expr(row.b)}`);
    return id;
  };
  gate(frag.root);
  return lines.join(", ");
}

function buildLocal(
  ids: number[],
  root: number,
  andBy: Map<number, { a: number; b: number }>,
): Local | null {
  const set = new Set(ids);
  const index = new Map<number, number>();
  const pending = new Set(ids);
  const order: number[] = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((id) => {
        const and = andBy.get(id);
        if (!and) return false;
        for (const lit of [and.a, and.b]) {
          const node = nodeOf(lit);
          if (set.has(node) && !index.has(node)) return false;
        }
        return true;
      })
      .sort((left, right) => left - right);
    if (ready.length === 0) return null;
    for (const id of ready) {
      index.set(id, order.length);
      order.push(id);
      pending.delete(id);
    }
  }
  const leafIds: number[] = [];
  const leafIndex = new Map<number, number>();
  const leafOf = (node: number): number | null => {
    if (node === 0) return null;
    const have = leafIndex.get(node);
    if (have !== undefined) return have;
    const id = leafIds.length;
    if (id >= MAX_PINS) return null;
    leafIndex.set(node, id);
    leafIds.push(node);
    return id;
  };
  const side = (lit: number): Side | null => {
    const node = nodeOf(lit);
    const inv = (lit & 1) === 1;
    if (set.has(node)) {
      const gate = index.get(node);
      if (gate === undefined) return null;
      return { inv, gate, leaf: null };
    }
    const leaf = leafOf(node);
    if (leaf === null) return null;
    return { inv, gate: null, leaf };
  };
  const gates: { a: Side; b: Side }[] = [];
  for (const id of order) {
    const and = andBy.get(id);
    if (!and) return null;
    const a = side(and.a);
    const b = side(and.b);
    if (!a || !b) return null;
    gates.push({ a, b });
  }
  if (leafIds.length < 2) return null;
  const rootIndex = index.get(root);
  if (rootIndex === undefined) return null;
  return { root: rootIndex, gates, leafIds };
}

function asGraph(local: Local): Graph {
  const nAnd = local.gates.length;
  const ins: { to: number; inv: boolean }[][] = Array.from(
    { length: nAnd + local.leafIds.length },
    () => [],
  );
  local.gates.forEach((gate, index) => {
    for (const ref of [gate.a, gate.b]) {
      const to = ref.gate !== null ? ref.gate : nAnd + (ref.leaf ?? 0);
      ins[index]?.push({ to, inv: ref.inv });
    }
  });
  return { nAnd, nLeaf: local.leafIds.length, root: local.root, ins };
}

function refine(graph: Graph, color: number[]): number[] {
  let current = color;
  const limit = graph.ins.length + 2;
  for (let iter = 0; iter < limit; iter += 1) {
    const users: { to: number; inv: boolean }[][] = graph.ins.map(() => []);
    graph.ins.forEach((edges, vertex) => {
      for (const edge of edges) users[edge.to]?.push({ to: vertex, inv: edge.inv });
    });
    const keys = graph.ins.map((_, vertex) => {
      const inn = (graph.ins[vertex] ?? [])
        .map((edge) => `${edge.inv ? 1 : 0}:${current[edge.to] ?? 0}`)
        .sort();
      const out = (users[vertex] ?? [])
        .map((edge) => `${edge.inv ? 1 : 0}:${current[edge.to] ?? 0}`)
        .sort();
      return `${current[vertex] ?? 0}>${inn.join(",")}<${out.join(",")}`;
    });
    const order = [...new Set(keys)].sort();
    const next = keys.map((key) => order.indexOf(key));
    if (next.every((entry, index) => entry === current[index])) return next;
    current = next;
  }
  return current;
}

function certificate(graph: Graph, color: number[]): { key: string; unique: boolean } {
  const ands = [...Array(graph.nAnd).keys()].sort(
    (left, right) => (color[left] ?? 0) - (color[right] ?? 0) || left - right,
  );
  const seen = new Set<number>();
  let unique = true;
  for (const vertex of ands) {
    const tone = color[vertex] ?? 0;
    if (seen.has(tone)) unique = false;
    seen.add(tone);
  }
  const parts = ands.map((vertex) =>
    (graph.ins[vertex] ?? [])
      .map((edge) => `${edge.inv ? "~" : ""}${color[edge.to] ?? 0}`)
      .sort()
      .join("&"),
  );
  return { key: `${graph.nAnd}.${graph.nLeaf}:${parts.join("|")}`, unique };
}

function pinOrder(graph: Graph, color: number[]): number[] {
  const leaves = [...Array(graph.nLeaf).keys()].map((index) => graph.nAnd + index);
  leaves.sort((left, right) => (color[left] ?? 0) - (color[right] ?? 0) || left - right);
  const pinOf = Array<number>(graph.nLeaf).fill(0);
  leaves.forEach((vertex, pin) => {
    pinOf[vertex - graph.nAnd] = pin;
  });
  return pinOf;
}

function canonicalize(local: Local): { shape: string; pinOfLeaf: number[] } {
  const graph = asGraph(local);
  const initial = graph.ins.map((_, vertex) =>
    vertex === graph.root ? 0 : vertex < graph.nAnd ? 1 : 2,
  );
  let best: string | null = null;
  let bestColor: number[] | null = null;
  let steps = 0;
  const search = (color: number[]): void => {
    if (steps > 8000) return;
    steps += 1;
    const refined = refine(graph, color);
    const classes = new Map<number, number[]>();
    for (let vertex = 0; vertex < graph.nAnd; vertex += 1) {
      const tone = refined[vertex] ?? 0;
      const list = classes.get(tone) ?? [];
      list.push(vertex);
      classes.set(tone, list);
    }
    let victim: number[] | null = null;
    for (const list of classes.values()) {
      if (list.length < 2) continue;
      if (!victim || list.length < victim.length) victim = list;
    }
    const cert = certificate(graph, refined);
    if (!victim || cert.unique) {
      if (best === null || cert.key < best) {
        best = cert.key;
        bestColor = refined;
      }
      return;
    }
    const fresh = Math.max(...refined) + 1;
    for (const vertex of victim) {
      const next = refined.slice();
      next[vertex] = fresh;
      search(next);
      if (steps > 8000) return;
    }
  };
  search(initial);
  const color = bestColor ?? refine(graph, initial);
  const shape = best ?? certificate(graph, color).key;
  return { shape, pinOfLeaf: pinOrder(graph, color) };
}

function withPins(local: Local, pinOfLeaf: number[]): { frag: Frag; pins: number[] } | null {
  const pins = Array<number>(local.leafIds.length).fill(0);
  for (let leaf = 0; leaf < local.leafIds.length; leaf += 1) {
    const pin = pinOfLeaf[leaf];
    const id = local.leafIds[leaf];
    if (pin === undefined || id === undefined) return null;
    pins[pin] = id;
  }
  if (pins.some((id) => id === 0) || new Set(pins).size !== pins.length) return null;
  const mapRef = (ref: Side): PinRef => ({
    inv: ref.inv,
    gate: ref.gate,
    pin: ref.leaf === null ? null : (pinOfLeaf[ref.leaf] ?? null),
  });
  return {
    pins,
    frag: {
      root: local.root,
      gates: local.gates.map((gate) => ({ a: mapRef(gate.a), b: mapRef(gate.b) })),
    },
  };
}

function enumerate(
  root: number,
  andBy: Map<number, { a: number; b: number }>,
  andSet: Set<number>,
): number[][] {
  const found: number[][] = [];
  const kept = new Map<number, number>();
  const seen = new Set<string>([String(root)]);
  const queue: number[][] = [[root]];
  let expanded = 0;
  while (queue.length > 0 && expanded < EXPLORE) {
    const current = queue.shift();
    if (!current) break;
    expanded += 1;
    if (current.length >= MIN_ANDS) {
      const have = kept.get(current.length) ?? 0;
      if (have < KEEP_EACH) {
        kept.set(current.length, have + 1);
        found.push(current);
      }
    }
    if (current.length >= MAX_ANDS) continue;
    const inside = new Set(current);
    const candidates: number[] = [];
    for (const id of current) {
      const and = andBy.get(id);
      if (!and) continue;
      for (const lit of [and.a, and.b]) {
        const node = nodeOf(lit);
        if (!andSet.has(node) || inside.has(node) || candidates.includes(node)) continue;
        candidates.push(node);
      }
    }
    candidates.sort((left, right) => left - right);
    for (const node of candidates) {
      const next = [...current, node].sort((left, right) => left - right);
      const key = next.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
      if (queue.length > EXPLORE) break;
    }
  }
  return found;
}

function coverCells(
  node: number,
  pol: "pos" | "neg",
  cone: Set<number>,
  pos: Map<number, LogicChoice>,
  neg: Map<number, LogicChoice>,
  seen: Set<string>,
): number {
  if (!cone.has(node)) return 0;
  const key = `${node}:${pol}`;
  if (seen.has(key)) return 0;
  seen.add(key);
  const choice = pol === "pos" ? pos.get(node) : neg.get(node);
  if (!choice || choice.kind === "pi") return 0;
  if (choice.kind === "inv")
    return 1 + coverCells(node, pol === "pos" ? "neg" : "pos", cone, pos, neg, seen);
  let count = 1;
  choice.leaves.forEach((leaf, pin) => {
    count += coverCells(leaf, choice.pinInv[pin] ? "neg" : "pos", cone, pos, neg, seen);
  });
  return count;
}

function depends(frag: Frag, width: number): number[] {
  const space = 1 << width;
  const used: number[] = [];
  for (let pin = 0; pin < width; pin += 1) {
    const bit = 1 << pin;
    for (let mask = 0; mask < space; mask += 1) {
      if (evalFrag(frag, mask) !== evalFrag(frag, mask ^ bit)) {
        used.push(pin);
        break;
      }
    }
  }
  return used;
}

function reducedTable(frag: Frag, used: number[]): number {
  const width = used.length;
  const space = 1 << width;
  let table = 0;
  for (let mask = 0; mask < space; mask += 1) {
    let full = 0;
    used.forEach((pin, index) => {
      if (((mask >> index) & 1) === 1) full |= 1 << pin;
    });
    if (evalFrag(frag, full) === 1) table += 2 ** mask;
  }
  return table;
}

function cellMatches(table: number, width: number, cell: Cell): boolean {
  if (cell.inputs.length !== width) return false;
  const space = 1 << width;
  const full = 2 ** space - 1;
  for (const perm of PERMS[width] ?? []) {
    const phases = 1 << width;
    for (let phase = 0; phase < phases; phase += 1) {
      let got = 0;
      for (let mask = 0; mask < space; mask += 1) {
        let cellMask = 0;
        for (let pin = 0; pin < width; pin += 1) {
          const leafBit = (mask >> (perm[pin] ?? 0)) & 1;
          const pinBit = leafBit ^ ((phase >> pin) & 1);
          cellMask |= pinBit << pin;
        }
        if (cell.fn(cellMask) === 1) got += 2 ** mask;
      }
      if (got === table || got === full - table) return true;
    }
  }
  return false;
}

function knownFunction(frag: Frag, width: number, library: Library): boolean {
  const used = depends(frag, width);
  if (used.length < 2) return true;
  if (used.length > 4) return false;
  const table = reducedTable(frag, used);
  return baseCells(library).some((cell) => cellMatches(table, used.length, cell));
}

export interface ConeFragment {
  pins: number[];
  ands: number;
  expr: string;
  fn: (mask: number) => 0 | 1;
}

/** Boolean fragment of an AND cone. Pins are the leaf node ids, inversions included in `fn`. */
export function coneFragment(
  ids: number[],
  root: number,
  andBy: Map<number, { a: number; b: number }>,
): ConeFragment | null {
  const local = buildLocal(ids, root, andBy);
  if (!local) return null;
  const pinned = withPins(local, canonicalize(local).pinOfLeaf);
  if (!pinned) return null;
  const frag = pinned.frag;
  return {
    pins: pinned.pins,
    ands: frag.gates.length,
    expr: exprOf(frag),
    fn: (mask) => evalFrag(frag, mask),
  };
}

/** True when some base cell already implements `fn`, so a new cell would not change the cover. */
export function coveredByLibrary(
  fn: (mask: number) => 0 | 1,
  width: number,
  library: Library,
): boolean {
  if (width < 2) return true;
  if (width > 4) return false;
  const space = 1 << width;
  const used: number[] = [];
  for (let pin = 0; pin < width; pin += 1) {
    const bit = 1 << pin;
    for (let mask = 0; mask < space; mask += 1) {
      if (fn(mask) !== fn(mask ^ bit)) {
        used.push(pin);
        break;
      }
    }
  }
  if (used.length < 2 || used.length > 4) return used.length < 2;
  let table = 0;
  const reduced = 1 << used.length;
  for (let mask = 0; mask < reduced; mask += 1) {
    let full = 0;
    used.forEach((pin, index) => {
      if (((mask >> index) & 1) === 1) full |= 1 << pin;
    });
    if (fn(full) === 1) table += 2 ** mask;
  }
  return baseCells(library).some((cell) => cellMatches(table, used.length, cell));
}

export function estimatedCell(
  library: Library,
  name: string,
  ands: number,
  width: number,
  fn: (mask: number) => 0 | 1,
): Cell {
  const ref = referenceCell(library);
  return {
    name,
    family: name,
    drive: 1,
    area: tidy(ref.area * (0.5 + 0.35 * ands)),
    delay: tidy(ref.delay * (0.8 + 0.1 * ands)),
    cap: ref.cap > 0 ? ref.cap : 1,
    inputs: Array.from({ length: width }, (_, pin) => pinName(pin)),
    fn,
    sense: "non",
  };
}

function referenceCell(library: Library): Cell {
  const nand = baseCells(library).find((cell) => {
    if (cell.inputs.length !== 2) return false;
    return [0, 1, 2, 3].every((mask) => cell.fn(mask) === (mask === 3 ? 0 : 1));
  });
  return nand ?? baseCells(library).find((cell) => cell.inputs.length === 2) ?? inverterOf(library);
}

function sized(report: DesignReport): { area: number; delay: number; cells: number } {
  return { area: tidy(report.area), delay: tidy(report.delay), cells: report.cells.length };
}

function cloudOf(netlist: Netlist): Netlist | null {
  return flopsOf(netlist).length === 0 ? netlist : comboCloud(netlist);
}

export function proposeDesign(
  netlist: Netlist,
  source: LibrarySource,
  mode: MapMode = "area",
  timing: number | Constraints = 10,
  options: { limit?: number } = {},
): ProposalReport {
  const library = resolveLibrary(source);
  const limit = options.limit ?? 8;
  const cloud = cloudOf(netlist);
  const before = mapDesign(netlist, library, mode, timing);
  const emptySeeds = new Map<number, PatternSeed[]>();
  if (!cloud || limit <= 0) {
    return blank(before, library, emptySeeds, "no cones");
  }
  const { graph, pos, neg } = logicChoices(cloud, library, mode);
  const andBy = new Map(graph.ands.map((and) => [and.node, { a: and.a, b: and.b }]));
  const andSet = new Set(andBy.keys());
  const groups = new Map<string, Hit[]>();
  let examined = 0;
  let skippedWide = 0;
  for (const and of graph.ands) {
    for (const ids of enumerate(and.node, andBy, andSet)) {
      examined += 1;
      const local = buildLocal(ids, and.node, andBy);
      if (!local) {
        skippedWide += 1;
        continue;
      }
      const canon = canonicalize(local);
      const pinned = withPins(local, canon.pinOfLeaf);
      if (!pinned) {
        skippedWide += 1;
        continue;
      }
      const tt = truthBits(pinned.frag, pinned.pins.length);
      const cells = coverCells(and.node, "pos", new Set(ids), pos, neg, new Set());
      const hit: Hit = {
        root: and.node,
        nodes: ids,
        pins: pinned.pins,
        frag: pinned.frag,
        cells,
        tt,
        shape: canon.shape,
      };
      const key = `${canon.shape}\n${tt}`;
      const list = groups.get(key) ?? [];
      list.push(hit);
      groups.set(key, list);
    }
  }

  let skippedNpn = 0;
  let skippedRare = 0;
  let skippedScore = 0;
  const ranked: { hits: Hit[]; score: number; cover: number }[] = [];
  for (const hits of groups.values()) {
    const sample = hits[0];
    if (!sample) continue;
    if (sample.pins.length > MAX_PINS) {
      skippedWide += 1;
      continue;
    }
    if (knownFunction(sample.frag, sample.pins.length, library)) {
      skippedNpn += 1;
      continue;
    }
    if (hits.length < MIN_HITS) {
      skippedRare += 1;
      continue;
    }
    const score = hits.reduce((sum, hit) => sum + Math.max(0, hit.cells - 1), 0);
    if (score <= 0) {
      skippedScore += 1;
      continue;
    }
    const cover = hits.reduce((sum, hit) => sum + hit.cells, 0) / hits.length;
    ranked.push({ hits, score, cover });
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      right.hits.length - left.hits.length ||
      left.hits[0]!.shape.localeCompare(right.hits[0]!.shape),
  );
  const chosen = ranked.slice(0, limit);
  const ref = referenceCell(library);
  const cost = `area = ${ref.name} * (0.5 + 0.35 * ands), delay = ${ref.name} * (0.8 + 0.1 * ands)`;
  const cells: ProposedCell[] = [];
  const added: Cell[] = [];
  const seeds = new Map<number, PatternSeed[]>();
  chosen.forEach((group, index) => {
    const sample = group.hits[0];
    if (!sample) return;
    const name = `prop${index}`;
    const ands = sample.frag.gates.length;
    const area = tidy(ref.area * (0.5 + 0.35 * ands));
    const delay = tidy(ref.delay * (0.8 + 0.1 * ands));
    const inputs = sample.pins.map((_, pin) => pinName(pin));
    const frag = sample.frag;
    added.push({
      name,
      family: name,
      drive: 1,
      area,
      delay,
      cap: ref.cap > 0 ? ref.cap : 1,
      inputs,
      fn: (mask) => evalFrag(frag, mask),
      sense: "non",
    });
    cells.push({
      name,
      ands,
      pins: sample.pins.length,
      occurrences: group.hits.length,
      coverCells: tidy(group.cover),
      score: group.score,
      area,
      delay,
      expr: exprOf(frag),
      shape: sample.shape,
    });
    for (const hit of group.hits) {
      const seed: PatternSeed = { cell: name, leaves: hit.pins, pinInv: hit.pins.map(() => false) };
      const list = seeds.get(hit.root) ?? [];
      const id = `${seed.cell}:${seed.leaves.join(".")}`;
      if (!list.some((item) => `${item.cell}:${item.leaves.join(".")}` === id)) list.push(seed);
      seeds.set(hit.root, list);
    }
  });

  if (added.length === 0) {
    return {
      examined,
      shapes: groups.size,
      skippedNpn,
      skippedRare,
      skippedScore,
      skippedWide,
      cost,
      cells,
      before: sized(before),
      after: sized(before),
      used: [],
      mismatches: before.equiv.mismatches,
      library,
      seeds,
      mapped: before,
    };
  }

  const extended: Library = {
    ...library,
    name: `${library.name}+prop`,
    cells: [...library.cells, ...added],
  };
  const mapped = mapDesign(netlist, extended, mode, timing, seeds);
  const used = cells.map((cell) => ({
    name: cell.name,
    count: mapped.cells.filter((item) => item === cell.name).length,
  }));
  return {
    examined,
    shapes: groups.size,
    skippedNpn,
    skippedRare,
    skippedScore,
    skippedWide,
    cost,
    cells,
    before: sized(before),
    after: sized(mapped),
    used,
    mismatches: mapped.equiv.mismatches,
    library: extended,
    seeds,
    mapped,
  };
}

function blank(
  before: DesignReport,
  library: Library,
  seeds: Map<number, PatternSeed[]>,
  cost: string,
): ProposalReport {
  const size = sized(before);
  return {
    examined: 0,
    shapes: 0,
    skippedNpn: 0,
    skippedRare: 0,
    skippedScore: 0,
    skippedWide: 0,
    cost,
    cells: [],
    before: size,
    after: size,
    used: [],
    mismatches: before.equiv.mismatches,
    library,
    seeds,
    mapped: before,
  };
}

export function proposalText(report: ProposalReport): string {
  const lines = [
    `proposals  examined ${report.examined}  shapes ${report.shapes}  npn ${report.skippedNpn}  rare ${report.skippedRare}  covered ${report.skippedScore}  wide ${report.skippedWide}  kept ${report.cells.length}`,
    `cost  ${report.cost}`,
  ];
  for (const cell of report.cells) {
    lines.push(
      `${cell.name}  ${cell.ands} ands  ${cell.pins} pins  x${cell.occurrences}  cover ${cell.coverCells}  score ${cell.score}  area ${cell.area}  delay ${cell.delay}`,
    );
    lines.push(`  ${cell.expr}`);
  }
  const area = tidy(report.after.area - report.before.area);
  const delay = tidy(report.after.delay - report.before.delay);
  const cells = report.after.cells - report.before.cells;
  lines.push(
    `before  area ${report.before.area}  delay ${report.before.delay}  cells ${report.before.cells}`,
    `after   area ${report.after.area}  delay ${report.after.delay}  cells ${report.after.cells}`,
    `delta   area ${area}  delay ${delay}  cells ${cells}`,
  );
  const used = report.used
    .filter((item) => item.count > 0)
    .map((item) => `${item.name} x${item.count}`);
  lines.push(used.length > 0 ? `used  ${used.join("  ")}` : "used  none");
  lines.push(
    "score counts every cone, including ones that overlap; used is what the remapper kept",
  );
  return lines.join("\n");
}
