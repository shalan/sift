import { deadGates, evalNetlist, topoGates, validate, type Netlist } from "./netlist.ts";
import { OPT_ALL, optimizeAig, type OptFlags, type OptMode, type OptStats } from "./aig-opt.ts";

export type { OptFlags, OptMode, OptStats };
export { OPT_ALL, OPT_NONE } from "./aig-opt.ts";

/** Even literal is the node, odd is the node inverted. Node 0 is constant 0, so literal 1 is constant 1. */
export type Lit = number;

const LIT0 = 0;
const LIT1 = 1;

function litNot(lit: Lit): Lit {
  return lit ^ 1;
}

function litNode(lit: Lit): number {
  return lit >>> 1;
}

function litInv(lit: Lit): boolean {
  return (lit & 1) === 1;
}

function litFromNode(node: number, inv = false): Lit {
  return (node << 1) | (inv ? 1 : 0);
}

interface AndRec {
  a: Lit;
  b: Lit;
}

interface Built {
  inputNames: string[];
  ands: Map<number, AndRec>;
  outputs: { name: string; lit: Lit }[];
  andBefore: number;
  strashHits: number;
  folds: number;
}

function build(netlist: Netlist): Built {
  const inputNames = netlist.inputs;
  const ands = new Map<number, AndRec>();
  const hash = new Map<string, number>();
  let strashHits = 0;
  let folds = 0;
  let next = inputNames.length + 1;

  const lits = new Map<string, Lit>();
  lits.set("0", LIT0);
  lits.set("1", LIT1);
  inputNames.forEach((name, index) => {
    lits.set(name, litFromNode(index + 1));
  });

  function and(a: Lit, b: Lit): Lit {
    if (a === LIT0 || b === LIT0) {
      folds += 1;
      return LIT0;
    }
    if (a === LIT1) {
      folds += 1;
      return b;
    }
    if (b === LIT1) {
      folds += 1;
      return a;
    }
    if (a === b) {
      folds += 1;
      return a;
    }
    if (a === litNot(b)) {
      folds += 1;
      return LIT0;
    }
    let x = a;
    let y = b;
    if (x > y) {
      const swap = x;
      x = y;
      y = swap;
    }
    const key = `${x},${y}`;
    const hit = hash.get(key);
    if (hit !== undefined) {
      strashHits += 1;
      return litFromNode(hit);
    }
    const node = next;
    next += 1;
    hash.set(key, node);
    ands.set(node, { a: x, b: y });
    return litFromNode(node);
  }

  function or(a: Lit, b: Lit): Lit {
    return litNot(and(litNot(a), litNot(b)));
  }

  for (const gate of topoGates(netlist)) {
    const ins = gate.ins.map((net) => {
      const lit = lits.get(net);
      if (lit === undefined) throw new Error(`net '${net}' was not lowered`);
      return lit;
    });
    let lit: Lit;
    switch (gate.op) {
      case "INV":
        lit = litNot(ins[0]);
        break;
      case "AND":
        lit = and(ins[0], ins[1]);
        break;
      case "OR":
        lit = or(ins[0], ins[1]);
        break;
      case "XOR": {
        const left = and(litNot(ins[0]), ins[1]);
        const right = and(ins[0], litNot(ins[1]));
        lit = or(left, right);
        break;
      }
      case "MUX": {
        const when1 = and(ins[0], ins[1]);
        const when0 = and(litNot(ins[0]), ins[2]);
        lit = or(when1, when0);
        break;
      }
      case "DFF":
        throw new Error(`'${gate.id}' is a DFF; the graph is only the cloud around it`);
      case "LATCH":
        throw new Error(`'${gate.id}' is a LATCH; the graph is only the cloud around it`);
      default: {
        const never: never = gate.op;
        throw new Error(`unknown op '${String(never)}'`);
      }
    }
    lits.set(gate.id, lit);
  }

  const outputs = netlist.outputs.map((name) => {
    const lit = lits.get(name);
    if (lit === undefined) throw new Error(`output '${name}' was not lowered`);
    return { name, lit };
  });

  return {
    inputNames,
    ands,
    outputs,
    andBefore: ands.size,
    strashHits,
    folds,
  };
}

export interface AigNode {
  id: string;
  expr: string;
}

export interface AigOutput {
  name: string;
  expr: string;
}

export interface AigView {
  inputs: string[];
  nodes: AigNode[];
  outputs: AigOutput[];
}

export interface SubjectGraph {
  inputs: { name: string; node: number }[];
  ands: { node: number; a: Lit; b: Lit }[];
  outputs: { name: string; lit: Lit }[];
  view: AigView;
}

function sweep(built: Built): SubjectGraph {
  const used = new Set<number>();
  const stack = built.outputs.map((o) => litNode(o.lit));
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || node === 0 || used.has(node)) continue;
    used.add(node);
    const rec = built.ands.get(node);
    if (!rec) continue;
    stack.push(litNode(rec.a), litNode(rec.b));
  }

  const remap = new Map<number, number>();
  remap.set(0, 0);
  const inputs: { name: string; node: number }[] = [];
  let next = 1;
  built.inputNames.forEach((name, index) => {
    remap.set(index + 1, next);
    inputs.push({ name, node: next });
    next += 1;
  });

  const oldAnds = [...built.ands.keys()].filter((id) => used.has(id)).sort((a, b) => a - b);
  for (const id of oldAnds) {
    remap.set(id, next);
    next += 1;
  }

  function mapLit(lit: Lit): Lit {
    if (lit <= 1) return lit;
    const node = remap.get(litNode(lit));
    if (node === undefined) throw new Error("sweep dropped a live node");
    return litFromNode(node, litInv(lit));
  }

  const ands = oldAnds.map((id) => {
    const rec = built.ands.get(id);
    if (!rec) throw new Error("missing AND");
    const node = remap.get(id);
    if (node === undefined) throw new Error("missing remap");
    return { node, a: mapLit(rec.a), b: mapLit(rec.b) };
  });
  const outputs = built.outputs.map((o) => ({ name: o.name, lit: mapLit(o.lit) }));

  const piNames = new Set(inputs.map((i) => i.name));
  function nameOf(node: number): string {
    const pi = inputs.find((p) => p.node === node);
    if (pi) return pi.name;
    const label = `n${node}`;
    return piNames.has(label) ? `${label}_` : label;
  }
  function fmt(lit: Lit): string {
    if (lit === LIT0) return "0";
    if (lit === LIT1) return "1";
    const name = nameOf(litNode(lit));
    return litInv(lit) ? `~${name}` : name;
  }

  return {
    inputs,
    ands,
    outputs,
    view: {
      inputs: inputs.map((i) => i.name),
      nodes: ands.map((and) => ({ id: nameOf(and.node), expr: `${fmt(and.a)} & ${fmt(and.b)}` })),
      outputs: outputs.map((o) => ({ name: o.name, expr: fmt(o.lit) })),
    },
  };
}

function evalAig(aig: SubjectGraph, assign: ReadonlyMap<string, 0 | 1>): Map<string, 0 | 1> {
  const val: number[] = [];
  val[0] = 0;
  for (const input of aig.inputs) {
    const bit = assign.get(input.name);
    if (bit === undefined) throw new Error(`missing value for '${input.name}'`);
    val[input.node] = bit;
  }
  for (const and of aig.ands) {
    const left = (val[litNode(and.a)] ?? 0) ^ (litInv(and.a) ? 1 : 0);
    const right = (val[litNode(and.b)] ?? 0) ^ (litInv(and.b) ? 1 : 0);
    val[and.node] = left & right;
  }
  const out = new Map<string, 0 | 1>();
  for (const output of aig.outputs) {
    if (output.lit <= 1) {
      out.set(output.name, output.lit === 1 ? 1 : 0);
      continue;
    }
    const bit = (val[litNode(output.lit)] ?? 0) ^ (litInv(output.lit) ? 1 : 0);
    out.set(output.name, bit === 1 ? 1 : 0);
  }
  return out;
}

export interface TruthRow {
  inputs: { name: string; value: 0 | 1 }[];
  outputs: { name: string; net: 0 | 1; aig: 0 | 1 }[];
  match: boolean;
}

export interface ShrinkReport {
  name: string;
  gates: number;
  deadGates: string[];
  andBefore: number;
  andAfter: number;
  strashHits: number;
  folds: number;
  constOutputs: { name: string; value: 0 | 1 }[];
  opt: OptStats;
  aig: AigView;
  equiv: {
    exhaustive: boolean;
    vectors: number;
    mismatches: number;
    rows: TruthRow[];
  };
}

export function inputAssignment(index: number, inputs: string[]): Map<string, 0 | 1> {
  const values = new Map<string, 0 | 1>();
  const width = inputs.length;
  inputs.forEach((name, place) => {
    const shift = width - 1 - place;
    values.set(name, Math.floor(index / 2 ** shift) % 2 === 1 ? 1 : 0);
  });
  return values;
}

export function vectorIndexes(width: number): { exhaustive: boolean; indexes: number[] } {
  if (width <= 8)
    return { exhaustive: true, indexes: Array.from({ length: 1 << width }, (_, i) => i) };
  return { exhaustive: false, indexes: sampleIndexes(width, 256) };
}

function sampleIndexes(width: number, count: number): number[] {
  if (width === 0) return [0];
  if (width <= 16) {
    const space = 1 << width;
    if (count >= space) return Array.from({ length: space }, (_, i) => i);
  }
  const span = width >= 53 ? Number.MAX_SAFE_INTEGER : 2 ** width;
  const indexes = [0, span - 1];
  let seed = 0x51f7;
  const seen = new Set<number>(indexes);
  while (indexes.length < count) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    let index = seed;
    let filled = 16;
    while (filled < Math.min(width, 48)) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const take = Math.min(16, width - filled);
      index += (seed & ((1 << take) - 1)) * 2 ** filled;
      filled += take;
    }
    if (width < 53) index %= span;
    if (seen.has(index)) continue;
    seen.add(index);
    indexes.push(index);
  }
  return indexes;
}

export function graphDepth(graph: SubjectGraph): number {
  const level = new Map<number, number>();
  for (const input of graph.inputs) level.set(input.node, 0);
  for (const and of graph.ands) {
    const left = level.get(litNode(and.a)) ?? 0;
    const right = level.get(litNode(and.b)) ?? 0;
    level.set(and.node, 1 + Math.max(left, right));
  }
  let depth = 0;
  for (const output of graph.outputs) {
    if (output.lit <= 1) continue;
    depth = Math.max(depth, level.get(litNode(output.lit)) ?? 0);
  }
  return depth;
}

function finish(netlist: Netlist, mode: OptMode, flags: OptFlags) {
  validate(netlist);
  const built = build(netlist);
  const swept = sweep(built);
  const skip = !flags.rewrite && !flags.balance && !flags.sweep && !flags.refactor && !flags.resub;
  if (skip) {
    const depth = graphDepth(swept);
    const stats: OptStats = {
      rewrite: 0,
      balance: 0,
      sweep: 0,
      refactor: 0,
      resub: 0,
      depthBefore: depth,
      depthAfter: depth,
    };
    return { built, aig: swept, stats };
  }
  const optimized = optimizeAig(
    {
      inputs: swept.inputs.length,
      ands: swept.ands.map((and) => ({ node: and.node, a: and.a, b: and.b })),
      outputs: swept.outputs.map((output) => ({ name: output.name, lit: output.lit })),
    },
    mode,
    flags,
  );
  const aig = sweep({
    inputNames: swept.inputs.map((input) => input.name),
    ands: new Map(optimized.ands.map((and) => [and.node, { a: and.a, b: and.b }])),
    outputs: optimized.outputs,
    andBefore: built.andBefore,
    strashHits: built.strashHits,
    folds: built.folds,
  });
  return { built, aig, stats: optimized.stats };
}

export function subjectGraph(
  netlist: Netlist,
  mode: OptMode = "area",
  flags: OptFlags = OPT_ALL,
): SubjectGraph {
  return finish(netlist, mode, flags).aig;
}

export function shrink(netlist: Netlist, mode: OptMode = "area"): ShrinkReport {
  const { built, aig, stats } = finish(netlist, mode, OPT_ALL);
  const width = netlist.inputs.length;
  const plan = vectorIndexes(width);
  const rows: TruthRow[] = [];
  let mismatches = 0;

  for (const index of plan.indexes) {
    const assign = inputAssignment(index, netlist.inputs);
    const fromNet = evalNetlist(netlist, assign);
    const fromAig = evalAig(aig, assign);
    const outputs = netlist.outputs.map((name) => {
      const net = fromNet.get(name);
      const mapped = fromAig.get(name);
      if (net === undefined || mapped === undefined) {
        throw new Error(`output '${name}' missing from simulation`);
      }
      return { name, net, aig: mapped };
    });
    const match = outputs.every((o) => o.net === o.aig);
    if (!match) mismatches += 1;
    rows.push({
      inputs: netlist.inputs.map((name) => ({ name, value: assign.get(name) ?? 0 })),
      outputs,
      match,
    });
  }

  const shown = rows.length <= 16 ? rows : rows.filter((row) => !row.match).slice(0, 16);

  return {
    name: netlist.name,
    gates: netlist.gates.length,
    deadGates: deadGates(netlist),
    andBefore: built.andBefore,
    andAfter: aig.ands.length,
    strashHits: built.strashHits,
    folds: built.folds,
    constOutputs: aig.outputs
      .filter((o) => o.lit <= 1)
      .map((o) => ({ name: o.name, value: o.lit === 1 ? 1 : 0 })),
    opt: stats,
    aig: aig.view,
    equiv: {
      exhaustive: plan.exhaustive,
      vectors: rows.length,
      mismatches,
      rows: shown,
    },
  };
}
