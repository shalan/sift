import { byArea, inverterOf, portCap, tableDelay, type Cell, type Library } from "./library.ts";
import type { ClockGate, Gate, Netlist } from "./netlist.ts";

export interface IcgGate {
  cell: string;
  output: string;
  outputPin: string;
  inputs: string[];
  pins: string[];
}

/** Latch-based integrated clock gate for one shared enable. */
export interface IcgBuilt {
  id: string;
  en: string;
  level: 0 | 1;
  flops: string[];
  gclk: string;
  area: number;
  delay: number;
  setup: number;
  clkInv: number;
  gates: IcgGate[];
}

interface Factor {
  net: string;
  level: 0 | 1;
}

interface EnableHit {
  q: string;
  factors: Factor[];
  muxes: string[];
  data: string;
}

function factorKey(factors: readonly Factor[]): string {
  return factors.map((factor) => `${factor.level}:${factor.net}`).join("&");
}

function isAnd2(cell: Cell): boolean {
  return (
    cell.inputs.length === 2 &&
    cell.fn(0) === 0 &&
    cell.fn(1) === 0 &&
    cell.fn(2) === 0 &&
    cell.fn(3) === 1
  );
}

function isNand2(cell: Cell): boolean {
  return (
    cell.inputs.length === 2 &&
    cell.fn(0) === 1 &&
    cell.fn(1) === 1 &&
    cell.fn(2) === 1 &&
    cell.fn(3) === 0
  );
}

function fanout(netlist: Netlist): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (net: string) => {
    if (net === "0" || net === "1") return;
    counts.set(net, (counts.get(net) ?? 0) + 1);
  };
  for (const gate of netlist.gates) for (const net of gate.ins) add(net);
  for (const out of netlist.outputs) add(out);
  return counts;
}

/** Recirculation nest: each mux feeds only the next, and one leg is this flop's Q. */
export function findEnables(netlist: Netlist): { hits: EnableHit[] } {
  const byId = new Map(netlist.gates.map((gate) => [gate.id, gate]));
  const fans = fanout(netlist);
  const hits: EnableHit[] = [];
  for (const gate of netlist.gates) {
    if (gate.op !== "DFF") continue;
    const factors: Factor[] = [];
    const muxes: string[] = [];
    let node = gate.ins[0] ?? "";
    while (true) {
      const mux = byId.get(node);
      if (!mux || mux.op !== "MUX" || (fans.get(mux.id) ?? 0) !== 1) break;
      const [sel, yes, no] = mux.ins;
      if (!sel || sel === "0" || sel === "1" || sel === mux.id) break;
      if (no === gate.id && yes !== gate.id && yes !== undefined) {
        factors.push({ net: sel, level: 1 });
        muxes.push(mux.id);
        node = yes;
      } else if (yes === gate.id && no !== gate.id && no !== undefined) {
        factors.push({ net: sel, level: 0 });
        muxes.push(mux.id);
        node = no;
      } else break;
    }
    if (factors.length === 0) continue;
    hits.push({ q: gate.id, factors, muxes, data: node });
  }
  return { hits };
}

function freshName(used: Set<string>, base: string): string {
  let name = base;
  let index = 2;
  while (used.has(name)) {
    name = `${base}${index}`;
    index += 1;
  }
  used.add(name);
  return name;
}

/** One active-high net for every select in the nest. A single select keeps its polarity. */
function composeEnable(
  factors: readonly Factor[],
  used: Set<string>,
  gates: Gate[],
  invOf: Map<string, string>,
): { en: string; level: 0 | 1 } {
  const unique: Factor[] = [];
  const seen = new Set<string>();
  for (const factor of factors) {
    const key = `${factor.level}:${factor.net}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(factor);
  }
  const only = unique[0];
  if (!only) return { en: "0", level: 1 };
  if (unique.length === 1) return { en: only.net, level: only.level };
  const high = (factor: Factor): string => {
    if (factor.level === 1) return factor.net;
    const cached = invOf.get(factor.net);
    if (cached) return cached;
    const id = freshName(used, "_cg_n");
    gates.push({ id, op: "INV", ins: [factor.net] });
    invOf.set(factor.net, id);
    return id;
  };
  let acc = high(only);
  for (const factor of unique.slice(1)) {
    const id = freshName(used, "_cg_a");
    gates.push({ id, op: "AND", ins: [acc, high(factor)] });
    acc = id;
  }
  return { en: acc, level: 1 };
}

/**
 * Remove enable muxes and remember which flops share a clock gate.
 * A nest `ce ? (we ? (match ? data : q) : q) : q` becomes one enable, `ce & we & match`.
 * Returns null when no flop has an enable. Throws when the library cannot build a gate.
 */
export function insertClockGates(
  netlist: Netlist,
  library: Library,
  mode: "area" | "delay" | "load",
): Netlist | null {
  const found = findEnables(netlist);
  if (found.hits.length === 0) return null;
  const used = new Set<string>(["0", "1", "clk"]);
  for (const name of [...netlist.inputs, ...netlist.outputs]) used.add(name);
  for (const gate of netlist.gates) used.add(gate.id);
  const extra: Gate[] = [];
  const invOf = new Map<string, string>();
  const grouped = new Map<string, EnableHit[]>();
  for (const hit of found.hits) {
    const key = factorKey(hit.factors);
    const list = grouped.get(key);
    if (list) list.push(hit);
    else grouped.set(key, [hit]);
  }
  const groups: ClockGate[] = [];
  let index = 0;
  for (const hits of grouped.values()) {
    const sample = hits[0];
    if (!sample) continue;
    const composed = composeEnable(sample.factors, used, extra, invOf);
    groups.push({
      id: `_cg${index}`,
      en: composed.en,
      level: composed.level,
      flops: hits.map((hit) => hit.q),
    });
    index += 1;
  }
  realizeClockGates(library, groups, mode, netlist);
  const drop = new Set(found.hits.flatMap((hit) => hit.muxes));
  const dataOf = new Map(found.hits.map((hit) => [hit.q, hit.data]));
  const gates = [
    ...netlist.gates
      .filter((gate) => !drop.has(gate.id))
      .map((gate) => {
        const data = dataOf.get(gate.id);
        if (gate.op !== "DFF" || data === undefined) return gate;
        return { ...gate, ins: [data, ...gate.ins.slice(1)] };
      }),
    ...extra,
  ];
  return { ...netlist, gates, clockGates: groups };
}

function areaOf(library: Library, name: string): number {
  return (
    library.cells.find((cell) => cell.name === name)?.area ??
    library.flops.find((cell) => cell.name === name)?.area ??
    0
  );
}

function clockPin(library: Library): number {
  const caps = library.flops
    .map((cell) => cell.clockCap)
    .filter((cap): cap is number => cap !== undefined && cap > 0);
  if (caps.length === 0) return portCap(library);
  return Math.min(...caps);
}

function arc(cell: Cell, load: number, tabular: boolean): number {
  if (tabular && cell.table) return tableDelay(cell.table, load);
  return cell.delay;
}

function fresh(used: Set<string>, base: string): string {
  let name = base;
  let index = 2;
  while (used.has(name)) {
    name = `${base}${index}`;
    index += 1;
  }
  used.add(name);
  return name;
}

/** Glitch-free gate: latch the enable while clk is low, then AND it with clk. */
export function realizeClockGates(
  library: Library,
  groups: readonly ClockGate[],
  mode: "area" | "delay" | "load",
  netlist?: Netlist,
): IcgBuilt[] {
  if (groups.length === 0) return [];
  const latch = byArea(library.flops.filter((cell) => cell.family === "LATCH"))[0];
  const and = byArea(library.cells.filter(isAnd2))[0];
  const nand = byArea(library.cells.filter(isNand2))[0];
  const inv = library.cells.some(
    (cell) => cell.fn(0) === 1 && cell.fn(1) === 0 && cell.inputs.length === 1,
  )
    ? inverterOf(library)
    : undefined;
  if (!latch || !inv || (!and && !nand))
    throw new Error("clock gating needs a latch and a 2-input AND or NAND");
  const tabular = mode === "load";
  const used = new Set<string>(["0", "1", "clk"]);
  if (netlist) {
    for (const name of [...netlist.inputs, ...netlist.outputs]) used.add(name);
    for (const gate of netlist.gates) used.add(gate.id);
  }
  return groups.map((group) => {
    const nclk = fresh(used, `${group.id}_n`);
    const lat = fresh(used, `${group.id}_l`);
    const gclk = fresh(used, `${group.id}_y`);
    const enNet = group.level === 1 ? group.en : fresh(used, `${group.id}_e`);
    const gates: IcgGate[] = [
      {
        cell: inv.name,
        output: nclk,
        outputPin: inv.output ?? "Y",
        inputs: ["clk"],
        pins: [inv.inputs[0] ?? "A"],
      },
    ];
    if (group.level === 0)
      gates.push({
        cell: inv.name,
        output: enNet,
        outputPin: inv.output ?? "Y",
        inputs: [group.en],
        pins: [inv.inputs[0] ?? "A"],
      });
    const latchPins = latch.seq?.en ? [latch.seq.d, latch.seq.en] : ["D", "EN"];
    gates.push({
      cell: latch.name,
      output: lat,
      outputPin: latch.seq?.q ?? "Q",
      inputs: [enNet, nclk],
      pins: latchPins,
    });
    let delay: number;
    const pin = clockPin(library);
    const load = tabular ? Math.max(pin, group.flops.length * pin) : group.flops.length;
    if (and) {
      gates.push({
        cell: and.name,
        output: gclk,
        outputPin: and.output ?? "Y",
        inputs: ["clk", lat],
        pins: [and.inputs[0] ?? "A", and.inputs[1] ?? "B"],
      });
      const extra = tabular ? 0 : Math.max(0, group.flops.length - 1) / (and.drive || 1);
      delay = arc(and, load, tabular) + extra;
    } else {
      const mid = fresh(used, `${group.id}_b`);
      const nandCell = nand as Cell;
      gates.push({
        cell: nandCell.name,
        output: mid,
        outputPin: nandCell.output ?? "Y",
        inputs: ["clk", lat],
        pins: [nandCell.inputs[0] ?? "A", nandCell.inputs[1] ?? "B"],
      });
      gates.push({
        cell: inv.name,
        output: gclk,
        outputPin: inv.output ?? "Y",
        inputs: [mid],
        pins: [inv.inputs[0] ?? "A"],
      });
      const extra = tabular ? 0 : Math.max(0, group.flops.length - 1) / (inv.drive || 1);
      delay = arc(nandCell, inv.cap > 0 ? inv.cap : 1, tabular) + arc(inv, load, tabular) + extra;
    }
    const clkInv = arc(inv, portCap(library), tabular);
    const area = gates.reduce((sum, gate) => sum + areaOf(library, gate.cell), 0);
    return {
      id: group.id,
      en: group.en,
      level: group.level,
      flops: [...group.flops],
      gclk,
      area,
      delay,
      setup: latch.setup,
      clkInv,
      gates,
    };
  });
}
