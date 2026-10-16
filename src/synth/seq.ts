import { inputAssignment } from "./aig.ts";
import {
  byArea,
  inverterOf,
  isBuffer,
  pickByFanout,
  portCap,
  resolveLibrary,
  tableDelay,
  tableEdge,
  checkTime,
  wireOf,
  type Cell,
  type FlopCell,
  type FlopPins,
  type Library,
  type LibrarySource,
  type WireLoad,
} from "./library.ts";
import { adderLevels, ppaFits, ppaWeight, rebuildAdder, type AdderKind } from "./arith.ts";
import {
  arrivals,
  cellMeets,
  DEFAULT_MAX_FANOUT,
  librarySlew,
  limitHits,
  mapNetlist,
  relieveNet,
  repairLimits,
  slewBuffer,
  tieBuffer,
  type ArrivalQuery,
  type DelayModel,
  type DrivingCell,
  type LimitHit,
  type MapGate,
  type MapMode,
  type MapReport,
  type PathStep,
  type PatternSeed,
  type TimedNet,
} from "./map.ts";
import { evalNetlist, validate, type AdderSite, type Gate, type Netlist } from "./netlist.ts";
import { insertClockGates, realizeClockGates, type IcgBuilt, type IcgGate } from "./clkgate.ts";

export interface Flop {
  kind: "dff" | "latch";
  q: string;
  d: string;
  en?: string;
  rst?: string;
  rstValue?: 0 | 1;
  /** Clock-gate enable. The flop loads only when this pin matches `level`. */
  clock?: { en: string; level: 0 | 1 };
}

export interface CycleRow {
  cycle: number;
  inputs: { name: string; value: 0 | 1 }[];
  outputs: { name: string; net: 0 | 1; mapped: 0 | 1 }[];
  match: boolean;
}

export interface ClockReport {
  period: number;
  slack: number;
  arrival: number;
  setup: number;
  endpoint: string;
  met: boolean;
  edge: "rise" | "fall";
  inputDelay: number;
  outputDelay: number;
  hold: number;
  holdSlack: number;
  holdMet: boolean;
  holdEndpoint: string;
  constrained: boolean;
  holdConstrained: boolean;
  clockLatency: number;
  clockSlew: number;
  /** Largest transition anywhere in the max-delay graph, including inputs. */
  maxSlew: number;
  setupUncertainty: number;
  holdUncertainty: number;
  setupCycles: number;
  holdCycles: number;
  wireLoad: string;
  capPerFanout: number;
}

export interface FalseEnd {
  kind: "inputs" | "outputs" | "registers" | "ports" | "pins";
  names: string[];
}

export interface FalsePath {
  from: FalseEnd | null;
  to: FalseEnd | null;
  setup: boolean;
  hold: boolean;
}

export interface MultiCycle {
  from: FalseEnd | null;
  to: FalseEnd | null;
  setup: number | null;
  hold: number | null;
}

export interface PortConstraint {
  slew?: number;
  load?: number;
  delay?: number;
  drive?: DrivingCell;
}

export interface Constraints {
  period: number;
  inputTransition?: number;
  outputLoad?: number;
  inputDelay?: number;
  outputDelay?: number;
  maxFanout?: number;
  maxTransition?: number;
  maxCapacitance?: number;
  clockTransition?: number;
  setupUncertainty?: number;
  holdUncertainty?: number;
  wireLoad?: string;
  capPerFanout?: number;
  ports?: Record<string, PortConstraint>;
  falsePaths?: FalsePath[];
  multiCycles?: MultiCycle[];
  drivingCell?: DrivingCell;
  bufferInputs?: boolean;
  bufferOutputs?: boolean;
  /** Downsize cells while setup slack stays non-negative. */
  recover?: boolean;
  /** Replace enable recirculation with a latch-based clock gate. */
  clockGate?: boolean;
  /**
   * Bias from 0 (area and leakage) to 1 (delay).
   * Each adder's weight still comes from its slack. Omit this and only the slack is used.
   */
  ppa?: number;
}

export interface DesignReport extends MapReport {
  registers: number;
  cycles: CycleRow[];
  timing: ClockReport | null;
  recovery?: {
    before: number;
    after: number;
    slackBefore: number;
    slackAfter: number;
    steps: number;
  };
  clockGates?: {
    id: string;
    en: string;
    level: 0 | 1;
    flops: string[];
    area: number;
    delay: number;
  }[];
}

export const DEFAULT_PERIOD = 10;
export { DEFAULT_MAX_FANOUT };

export function flopsOf(netlist: Netlist): Flop[] {
  const gated = new Map<string, { en: string; level: 0 | 1 }>();
  for (const group of netlist.clockGates ?? []) {
    for (const q of group.flops) gated.set(q, { en: group.en, level: group.level });
  }
  const flops: Flop[] = [];
  for (const gate of netlist.gates) {
    if (gate.op === "DFF") {
      const clock = gated.get(gate.id);
      flops.push({
        kind: "dff",
        q: gate.id,
        d: gate.ins[0] ?? "0",
        rst: gate.ins[1],
        rstValue: gate.ins[2] === "1" ? 1 : 0,
        ...(clock ? { clock } : {}),
      });
    } else if (gate.op === "LATCH") {
      flops.push({ kind: "latch", q: gate.id, en: gate.ins[0] ?? "0", d: gate.ins[1] ?? "0" });
    }
  }
  return flops;
}

/** Combinational cloud. Flip-flop outputs are inputs of that cloud. Their D pins are outputs. */
export function comboCloud(netlist: Netlist, extra: readonly string[] = []): Netlist | null {
  const flops = flopsOf(netlist);
  if (flops.length === 0) return netlist;
  const qNames = new Set(flops.map((flop) => flop.q));
  const gates = netlist.gates.filter((gate) => gate.op !== "DFF" && gate.op !== "LATCH");
  const gateIds = new Set(gates.map((gate) => gate.id));
  const outputs: string[] = [];
  const seen = new Set<string>();
  const pins = [
    ...flops.flatMap((flop) =>
      flop.kind === "latch" ? [flop.en ?? "0", flop.d] : [flop.d, ...(flop.rst ? [flop.rst] : [])],
    ),
    ...extra,
  ];
  for (const name of [...netlist.outputs.filter((out) => !qNames.has(out)), ...pins]) {
    if (!gateIds.has(name) || seen.has(name)) continue;
    seen.add(name);
    outputs.push(name);
  }
  if (outputs.length === 0) return null;
  return validate({
    name: netlist.name,
    inputs: [...netlist.inputs, ...flops.map((flop) => flop.q)],
    outputs,
    gates,
  });
}

function moduleName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (cleaned.length === 0 || /^[0-9]/.test(cleaned)) return `m_${cleaned}`;
  return cleaned;
}

function bitOf(net: string, values: ReadonlyMap<string, 0 | 1>): 0 | 1 {
  if (net === "0" || net === "1'b0") return 0;
  if (net === "1" || net === "1'b1") return 1;
  const bit = values.get(net);
  if (bit === undefined) throw new Error(`net '${net}' has no value`);
  return bit;
}

function renderSequential(
  netlist: Netlist,
  flops: Flop[],
  combo: MapReport | null,
  cells: ReadonlyMap<string, string>,
  buffers: MapGate[] = [],
  pins: ReadonlyMap<string, string> = new Map(),
  seqPins: ReadonlyMap<string, FlopPins> = new Map(),
  rstNet: ReadonlyMap<string, string> = new Map(),
  extra: IcgGate[] = [],
  clocks: ReadonlyMap<string, string> = new Map(),
): string {
  const lines = [`module ${moduleName(netlist.name)} (`];
  const clocked = flops.some((flop) => flop.kind === "dff");
  const ports = [
    ...(clocked ? ["  input clk"] : []),
    ...netlist.inputs.map((name) => `  input ${name}`),
    ...netlist.outputs.map((name) => `  output ${name}`),
  ];
  lines.push(ports.join(",\n"));
  lines.push(");");
  const portsNamed = new Set([...(clocked ? ["clk"] : []), ...netlist.inputs, ...netlist.outputs]);
  const wires = new Set<string>();
  if (combo) {
    for (const gate of combo.gates) if (!portsNamed.has(gate.output)) wires.add(gate.output);
  }
  for (const gate of buffers) if (!portsNamed.has(gate.output)) wires.add(gate.output);
  for (const gate of extra) if (!portsNamed.has(gate.output)) wires.add(gate.output);
  for (const flop of flops) {
    const q = pins.get(flop.q) ?? flop.q;
    if (!portsNamed.has(q)) wires.add(q);
  }
  if (wires.size > 0) lines.push(`  wire ${[...wires].join(", ")};`);
  let index = 0;
  for (const gate of [...(combo?.gates ?? []), ...buffers]) {
    lines.push(`  ${gate.cell} g${index} (${gate.output}, ${gate.inputs.join(", ")});`);
    index += 1;
  }
  for (const gate of extra) {
    const conn = [
      `.${gate.outputPin}(${gate.output})`,
      ...gate.pins.map((pin, pinIndex) => `.${pin}(${gate.inputs[pinIndex] ?? ""})`),
    ];
    lines.push(`  ${gate.cell} g${index} (${conn.join(", ")});`);
    index += 1;
  }
  for (const flop of flops) {
    const q = pins.get(flop.q) ?? flop.q;
    const data = pinOf(flop.d, pins);
    const clk = clocks.get(flop.q) ?? "clk";
    const cell = cells.get(flop.q) ?? (flop.kind === "latch" ? "LATCH" : flop.rst ? "ADFF" : "DFF");
    const spec = seqPins.get(flop.q);
    if (!spec) {
      if (flop.kind === "latch") {
        lines.push(`  ${cell} lat_${flop.q} (${q}, ${data}, ${pinOf(flop.en ?? "0", pins)});`);
      } else if (flop.rst) {
        const value = flop.rstValue === 1 ? "1'b1" : "1'b0";
        lines.push(
          `  ${cell} ff_${flop.q} (${q}, ${data}, ${pinOf(flop.rst, pins)}, ${value}, ${clk});`,
        );
      } else {
        lines.push(`  ${cell} ff_${flop.q} (${q}, ${data}, ${clk});`);
      }
      continue;
    }
    const conn = [`.${spec.q}(${q})`, `.${spec.d}(${data})`];
    if (flop.kind === "latch") {
      if (!spec.en) throw new Error(`${cell} has no enable pin`);
      conn.push(`.${spec.en}(${pinOf(flop.en ?? "0", pins)})`);
    } else {
      if (flop.rst) {
        const value = flop.rstValue ?? 0;
        const pin = value === 1 ? spec.preset : spec.clear;
        if (!pin) throw new Error(`${cell} cannot reset to ${value}`);
        conn.push(`.${pin}(${rstNet.get(flop.q) ?? pinOf(flop.rst, pins)})`);
      }
      if (!spec.clk) throw new Error(`${cell} has no clock pin`);
      conn.push(`.${spec.clk}(${clk})`);
    }
    const label = flop.kind === "latch" ? "lat" : "ff";
    lines.push(`  ${cell} ${label}_${flop.q} (${conn.join(", ")});`);
  }
  lines.push("endmodule");
  return lines.join("\n");
}

function pinOf(net: string, pins: ReadonlyMap<string, string>): string {
  if (net === "0") return "1'b0";
  if (net === "1") return "1'b1";
  return pins.get(net) ?? net;
}

function observe(
  netlist: Netlist,
  inputs: ReadonlyMap<string, 0 | 1>,
  state: ReadonlyMap<string, 0 | 1>,
): Map<string, 0 | 1> {
  const assign = new Map<string, 0 | 1>(inputs);
  for (const [name, bit] of state) assign.set(name, bit);
  const values = evalNetlist(netlist, assign);
  const out = new Map<string, 0 | 1>();
  for (const name of netlist.outputs) {
    out.set(name, state.has(name) ? (state.get(name) ?? 0) : bitOf(name, values));
  }
  return out;
}

function cloudValues(
  library: Library,
  combo: MapReport | null,
  inputs: ReadonlyMap<string, 0 | 1>,
  state: ReadonlyMap<string, 0 | 1>,
): Map<string, 0 | 1> {
  const values = new Map<string, 0 | 1>(inputs);
  for (const [name, bit] of state) values.set(name, bit);
  values.set("0", 0);
  values.set("1", 1);
  if (!combo) return values;
  const cells = new Map(library.cells.map((cell) => [cell.name, cell]));
  for (const gate of combo.gates) {
    const cell = cells.get(gate.cell);
    if (!cell) throw new Error(`unknown cell ${gate.cell}`);
    let mask = 0;
    gate.inputs.forEach((net, index) => {
      if (bitOf(net, values) === 1) mask |= 1 << index;
    });
    values.set(gate.output, cell.fn(mask));
  }
  for (const drive of combo.drives) {
    if (drive.wire === "1'b0") values.set(drive.name, 0);
    else if (drive.wire === "1'b1") values.set(drive.name, 1);
    else values.set(drive.name, bitOf(drive.wire, values));
  }
  return values;
}

function step(
  flops: Flop[],
  values: ReadonlyMap<string, 0 | 1>,
  inputs: ReadonlyMap<string, 0 | 1>,
  settled: ReadonlyMap<string, 0 | 1>,
): Map<string, 0 | 1> {
  const next = new Map(settled);
  for (const flop of flops) {
    if (flop.kind !== "dff") continue;
    if (flop.rst && (inputs.get(flop.rst) ?? 0) === 1) next.set(flop.q, flop.rstValue ?? 0);
    else if (flop.clock) {
      const open =
        flop.clock.level === 1
          ? bitOf(flop.clock.en, values) === 1
          : bitOf(flop.clock.en, values) === 0;
      if (open) next.set(flop.q, bitOf(flop.d, values));
    } else next.set(flop.q, bitOf(flop.d, values));
  }
  return next;
}

function settle(
  flops: Flop[],
  inputs: ReadonlyMap<string, 0 | 1>,
  state: ReadonlyMap<string, 0 | 1>,
  valuesOf: (
    inputs: ReadonlyMap<string, 0 | 1>,
    state: ReadonlyMap<string, 0 | 1>,
  ) => ReadonlyMap<string, 0 | 1>,
): Map<string, 0 | 1> {
  const current = new Map(state);
  for (const flop of flops) {
    if (flop.kind === "dff" && flop.rst && (inputs.get(flop.rst) ?? 0) === 1)
      current.set(flop.q, flop.rstValue ?? 0);
  }
  const latches = flops.filter((flop) => flop.kind === "latch");
  if (latches.length === 0) return current;
  for (let guard = 0; guard < 16; guard += 1) {
    const values = valuesOf(inputs, current);
    let changed = false;
    for (const latch of latches) {
      if (bitOf(latch.en ?? "0", values) !== 1) continue;
      const data = bitOf(latch.d, values);
      if (current.get(latch.q) !== data) {
        current.set(latch.q, data);
        changed = true;
      }
    }
    if (!changed) return current;
  }
  throw new Error("latch did not settle");
}

function cycleInputs(cycle: number, inputs: string[]): Map<string, 0 | 1> {
  const values = inputAssignment(cycle, inputs);
  for (const name of inputs) {
    if (name === "rst" || name === "reset") values.set(name, cycle < 2 || cycle === 6 ? 1 : 0);
  }
  return values;
}

function trace(
  netlist: Netlist,
  flops: Flop[],
  library: Library,
  combo: MapReport | null,
  count: number,
): CycleRow[] {
  let state = new Map<string, 0 | 1>(flops.map((flop) => [flop.q, 0]));
  let mapped = new Map<string, 0 | 1>(flops.map((flop) => [flop.q, 0]));
  const rows: CycleRow[] = [];
  for (let cycle = 0; cycle < count; cycle += 1) {
    const inputs = cycleInputs(cycle, netlist.inputs);
    const goldenOf = (pins: ReadonlyMap<string, 0 | 1>, held: ReadonlyMap<string, 0 | 1>) =>
      evalNetlist(netlist, new Map([...pins, ...held]));
    state = settle(flops, inputs, state, goldenOf);
    mapped = settle(flops, inputs, mapped, (pins, held) => cloudValues(library, combo, pins, held));
    const golden = observe(netlist, inputs, state);
    const mappedValues = cloudValues(library, combo, inputs, mapped);
    const outputs = netlist.outputs.map((name) => {
      const net = golden.get(name) ?? 0;
      const bit = mapped.has(name) ? (mapped.get(name) ?? 0) : bitOf(name, mappedValues);
      return { name, net, mapped: bit };
    });
    rows.push({
      cycle,
      inputs: netlist.inputs.map((name) => ({ name, value: inputs.get(name) ?? 0 })),
      outputs,
      match: outputs.every((output) => output.net === output.mapped),
    });
    const goldenValues = evalNetlist(netlist, new Map([...inputs, ...state]));
    state = step(flops, goldenValues, inputs, state);
    mapped = step(flops, mappedValues, inputs, mapped);
  }
  return rows;
}

function normalize(timing: number | Constraints): {
  period: number;
  inputTransition?: number;
  outputLoad?: number;
  inputDelay: number;
  outputDelay: number;
  maxFanout: number;
  clockTransition?: number;
  setupUncertainty: number;
  holdUncertainty: number;
  wireLoad: string;
  capPerFanout: number;
  ports: Record<string, PortConstraint>;
  falsePaths: FalsePath[];
  multiCycles: MultiCycle[];
  drivingCell?: DrivingCell;
  bufferInputs: boolean;
  bufferOutputs: boolean;
  recover: boolean;
  clockGate: boolean;
  ppa?: number;
  maxTransition?: number;
  maxCapacitance?: number;
} {
  if (typeof timing === "number") {
    return {
      period: timing,
      inputDelay: 0,
      outputDelay: 0,
      maxFanout: DEFAULT_MAX_FANOUT,
      wireLoad: "",
      capPerFanout: 0,
      ports: {},
      falsePaths: [],
      multiCycles: [],
      bufferInputs: false,
      bufferOutputs: false,
      setupUncertainty: 0,
      holdUncertainty: 0,
      recover: false,
      clockGate: false,
    };
  }
  const inputDelay = timing.inputDelay ?? 0;
  const outputDelay = timing.outputDelay ?? 0;
  const maxFanout = timing.maxFanout ?? DEFAULT_MAX_FANOUT;
  if (!Number.isFinite(inputDelay) || inputDelay < 0)
    throw new Error("input delay must be a non-negative number");
  if (!Number.isFinite(outputDelay) || outputDelay < 0)
    throw new Error("output delay must be a non-negative number");
  if (!Number.isFinite(maxFanout) || maxFanout < 1)
    throw new Error("max fanout must be at least 1");
  if (
    timing.inputTransition !== undefined &&
    (!Number.isFinite(timing.inputTransition) || timing.inputTransition < 0)
  ) {
    throw new Error("input slew must be a non-negative number");
  }
  if (
    timing.clockTransition !== undefined &&
    (!Number.isFinite(timing.clockTransition) || timing.clockTransition < 0)
  ) {
    throw new Error("clock slew must be a non-negative number");
  }
  if (
    timing.outputLoad !== undefined &&
    (!Number.isFinite(timing.outputLoad) || timing.outputLoad < 0)
  ) {
    throw new Error("output load must be a non-negative number");
  }
  if (
    timing.capPerFanout !== undefined &&
    (!Number.isFinite(timing.capPerFanout) || timing.capPerFanout < 0)
  ) {
    throw new Error("capacitance per fanout must be a non-negative number");
  }
  if (
    timing.maxTransition !== undefined &&
    (!Number.isFinite(timing.maxTransition) || timing.maxTransition < 0)
  ) {
    throw new Error("max transition must be a non-negative number");
  }
  if (
    timing.maxCapacitance !== undefined &&
    (!Number.isFinite(timing.maxCapacitance) || timing.maxCapacitance < 0)
  ) {
    throw new Error("max capacitance must be a non-negative number");
  }
  const setupUncertainty = timing.setupUncertainty ?? 0;
  const holdUncertainty = timing.holdUncertainty ?? 0;
  if (!Number.isFinite(setupUncertainty) || setupUncertainty < 0)
    throw new Error("setup uncertainty must be a non-negative number");
  if (!Number.isFinite(holdUncertainty) || holdUncertainty < 0)
    throw new Error("hold uncertainty must be a non-negative number");
  if (
    timing.ppa !== undefined &&
    (!Number.isFinite(timing.ppa) || timing.ppa < 0 || timing.ppa > 1)
  )
    throw new Error("ppa must be from 0 (area) to 1 (delay)");
  const multiCycles = timing.multiCycles ?? [];
  for (const rule of multiCycles) {
    if (rule.setup === null && rule.hold === null)
      throw new Error("a multicycle path needs a setup or a hold multiplier");
    if (rule.setup !== null && (!Number.isInteger(rule.setup) || rule.setup < 1)) {
      throw new Error("setup multicycle must be an integer of at least 1");
    }
    if (rule.hold !== null && (!Number.isInteger(rule.hold) || rule.hold < 0)) {
      throw new Error("hold multicycle must be an integer of at least 0");
    }
  }
  return {
    period: timing.period,
    inputDelay,
    outputDelay,
    maxFanout,
    wireLoad: timing.wireLoad ?? "",
    capPerFanout: timing.capPerFanout ?? 0,
    ports: timing.ports ?? {},
    falsePaths: timing.falsePaths ?? [],
    multiCycles,
    ...(timing.drivingCell ? { drivingCell: timing.drivingCell } : {}),
    bufferInputs: timing.bufferInputs === true,
    bufferOutputs: timing.bufferOutputs === true,
    ...(timing.maxTransition !== undefined ? { maxTransition: timing.maxTransition } : {}),
    ...(timing.maxCapacitance !== undefined ? { maxCapacitance: timing.maxCapacitance } : {}),
    ...(timing.inputTransition !== undefined ? { inputTransition: timing.inputTransition } : {}),
    ...(timing.clockTransition !== undefined ? { clockTransition: timing.clockTransition } : {}),
    ...(timing.outputLoad !== undefined ? { outputLoad: timing.outputLoad } : {}),
    setupUncertainty,
    holdUncertainty,
    recover: timing.recover === true,
    clockGate: timing.clockGate === true,
    ...(timing.ppa !== undefined ? { ppa: timing.ppa } : {}),
  };
}

function tidy(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function servesReset(cell: FlopCell, value: 0 | 1): boolean {
  if (!cell.seq) return true;
  return value === 1 ? cell.seq.preset !== undefined : cell.seq.clear !== undefined;
}

function pickFlop(
  flops: readonly FlopCell[],
  family: string,
  fanout: number,
  cap: number,
  mode: MapMode,
  library: string,
  reset: 0 | 1 | null = null,
): FlopCell {
  const options = byArea(
    flops.filter((cell) => cell.family === family && (reset === null || servesReset(cell, reset))),
  );
  const capped = options.some((cell) => cell.maxCap !== undefined || cell.maxFanout !== undefined);
  const legal = options.filter(
    (cell) =>
      (cell.maxCap === undefined || cap <= cell.maxCap + 1e-12) &&
      (cell.maxFanout === undefined || fanout <= cell.maxFanout),
  );
  const chosen = capped
    ? (legal[0] ?? options[options.length - 1])
    : mode === "delay"
      ? pickByFanout(options, fanout)
      : options[0];
  if (!chosen) throw new Error(`${library} has no ${family}`);
  return chosen;
}

function sinkCap(
  name: string,
  combo: MapReport | null,
  outputs: readonly string[],
  library: Library,
  outputLoad?: number,
): number {
  let cap = outputs.includes(name) ? (outputLoad ?? portCap(library)) : 0;
  if (!combo) return cap;
  const cells = new Map(library.cells.map((cell) => [cell.name, cell]));
  for (const gate of combo.gates) {
    const pin = cells.get(gate.cell)?.cap ?? 1;
    for (const net of gate.inputs) if (net === name) cap += pin;
  }
  return cap;
}

function loadsOf(name: string, combo: MapReport | null, outputs: readonly string[]): number {
  let count = outputs.includes(name) ? 1 : 0;
  if (combo) {
    for (const gate of combo.gates) for (const pin of gate.inputs) if (pin === name) count += 1;
    for (const drive of combo.drives) if (drive.wire === name) count += 1;
  }
  return Math.max(count, 1);
}

function capOf(
  name: string,
  combo: MapReport | null,
  outputs: readonly string[],
  library: Library,
  outputLoad?: number,
  wire: WireLoad | null = null,
  capPerFanout = 0,
): number {
  let cap = outputs.includes(name) ? (outputLoad ?? portCap(library)) : 0;
  let pins = outputs.includes(name) ? 1 : 0;
  if (combo) {
    const cells = new Map(library.cells.map((cell) => [cell.name, cell]));
    for (const gate of combo.gates) {
      const pin = cells.get(gate.cell)?.cap ?? 1;
      for (const net of gate.inputs) {
        if (net !== name) continue;
        cap += pin;
        pins += 1;
      }
    }
    for (const drive of combo.drives) {
      if (drive.wire !== name) continue;
      cap += outputLoad ?? portCap(library);
      pins += 1;
    }
  }
  if (capPerFanout > 0) return cap + pins * capPerFanout;
  if (wire && pins > 0) cap += wireOf(wire, pins).cap;
  return cap;
}

function flopOptions(library: Library, flop: Flop): FlopCell[] {
  const reset = flop.kind === "dff" && flop.rst ? (flop.rstValue ?? 0) : null;
  const family = flop.kind === "latch" ? "LATCH" : flop.rst ? "ADFF" : "DFF";
  return byArea(
    library.flops.filter(
      (cell) => cell.family === family && (reset === null || servesReset(cell, reset)),
    ),
  );
}

function flopLimit(cell: FlopCell, design: number | undefined): number | undefined {
  if (cell.maxTran === undefined) return design;
  if (design === undefined) return cell.maxTran;
  return Math.min(cell.maxTran, design);
}

function outputSlew(cell: FlopCell, weight: number, clockSlew: number): number | null {
  if (!cell.qSlew) return null;
  return Math.max(
    tableEdge(cell.qSlew, "rise", weight, clockSlew),
    tableEdge(cell.qSlew, "fall", weight, clockSlew),
  );
}

function driveFits(cell: FlopCell, cap: number, fanout: number): boolean {
  if (cell.maxCap !== undefined && cap > cell.maxCap + 1e-12) return false;
  if (cell.maxFanout !== undefined && fanout > cell.maxFanout + 1e-9) return false;
  return true;
}

function launchOfPath(
  path: PathStep[],
  chosen: ReadonlyMap<string, FlopCell>,
  flops: readonly Flop[],
  endpoint: string,
): string | null {
  for (const step of path) {
    if (chosen.has(step.label)) return step.label;
    if (!step.label.endsWith("/Q")) continue;
    const name = step.label.slice(0, -2);
    if (chosen.has(name)) return name;
  }
  if (endpoint.endsWith("/D")) {
    const flop = flops.find((item) => item.q === endpoint.slice(0, -2));
    if (flop && chosen.has(flop.d)) return flop.d;
  }
  return chosen.has(endpoint) ? endpoint : null;
}

/** Move flop-Q sinks onto a buffer so the flop's own transition meets the limit. */
function splitFlopLoads(
  library: Library,
  combo: MapReport,
  flops: readonly Flop[],
  chosen: ReadonlyMap<string, FlopCell>,
  constraints: Constraints,
  weightOf: (name: string, tabular?: boolean) => number,
  tried: Set<string>,
): boolean {
  const clockSlew = constraints.clockTransition ?? librarySlew(library);
  const known = new Map(library.cells.map((cell) => [cell.name, cell]));
  let next = 0;
  for (const gate of combo.gates) {
    const match = /^_(\d+)$/.exec(gate.output);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  let changed = false;
  for (const flop of flops) {
    const cell = chosen.get(flop.q);
    if (!cell?.qSlew) continue;
    const limit = flopLimit(cell, constraints.maxTransition);
    if (limit === undefined) continue;
    const slew = outputSlew(cell, weightOf(flop.q, true), clockSlew);
    if (slew === null || slew <= limit + 1e-9) continue;
    const pins: { gate: number; pin: number }[] = [];
    combo.gates.forEach((gate, index) => {
      gate.inputs.forEach((net, pin) => {
        if (net === flop.q) pins.push({ gate: index, pin });
      });
    });
    if (pins.length === 0) continue;
    const mark = `${flop.q}|${pins.map((pin) => `${pin.gate}.${pin.pin}`).join(",")}`;
    if (tried.has(mark)) continue;
    const take = pins.length === 1 ? pins : pins.slice(0, Math.ceil(pins.length / 2));
    const load = take.reduce((sum, pin) => {
      const gate = combo.gates[pin.gate];
      return sum + (gate ? (known.get(gate.cell)?.cap ?? 1) : 0);
    }, 0);
    const buffer = slewBuffer(library, load, slew, limit, constraints.maxTransition);
    if (!buffer) continue;
    if (pins.length === 1 && buffer.cap >= load - 1e-15) {
      tried.add(mark);
      continue;
    }
    tried.add(mark);
    const wire = `_${next}`;
    next += 1;
    combo.gates.push({ cell: buffer.name, output: wire, inputs: [flop.q] });
    for (const pin of take) {
      const gate = combo.gates[pin.gate];
      if (gate) gate.inputs[pin.pin] = wire;
    }
    changed = true;
  }
  return changed;
}

function cellTran(cell: Cell, design: number | undefined): number | undefined {
  if (cell.maxTran === undefined) return design;
  if (design === undefined) return cell.maxTran;
  return Math.min(cell.maxTran, design);
}

function edgeSlew(cell: Cell, load: number, input: number): number {
  if (!cell.slew) return input;
  return Math.max(
    tableEdge(cell.slew, "rise", load, input),
    tableEdge(cell.slew, "fall", load, input),
  );
}

/**
 * An async reset or preset net fans out to every flop. The same size, buffer,
 * and clone rules as the combo cloud close its capacitance and transition.
 */
function repairControlNets(
  library: Library,
  buffers: MapGate[],
  rstNet: Map<string, string>,
  chosen: ReadonlyMap<string, FlopCell>,
  flops: readonly Flop[],
  constraints: Constraints,
  mode: MapMode,
  slewAt: (net: string) => number,
  reserved: ReadonlySet<string>,
): LimitHit[] {
  const query: ArrivalQuery = {
    ...(constraints.maxFanout !== undefined ? { maxFanout: constraints.maxFanout } : {}),
    ...(constraints.maxCapacitance !== undefined
      ? { maxCapacitance: constraints.maxCapacitance }
      : {}),
    ...(constraints.maxTransition !== undefined
      ? { maxTransition: constraints.maxTransition }
      : {}),
  };
  const slewWork = library.cells.some((cell) => cell.slew);
  const capWork =
    constraints.maxCapacitance !== undefined || library.cells.some((cell) => cell.maxCap !== undefined);
  if ((!slewWork && !capWork) || rstNet.size === 0) return [];
  const cells = new Map(library.cells.map((cell) => [cell.name, cell]));
  const flopByQ = new Map(flops.map((flop) => [flop.q, flop]));
  const tree = new Set(rstNet.values());
  let next = 0;
  const reserve = (name: string) => {
    const match = /^_(\d+)$/.exec(name);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  };
  for (const name of reserved) reserve(name);
  for (const gate of buffers) reserve(gate.output);
  const pinCap = (q: string): number => {
    const cell = chosen.get(q);
    const flop = flopByQ.get(q);
    if (!cell || !flop) return 0;
    const value = (flop.rstValue ?? 0) === 1 ? cell.presetCap : cell.clearCap;
    return value ?? cell.clockCap ?? 0;
  };
  const sinksOf = (net: string): string[] => {
    const found: string[] = [];
    for (const [q, sink] of rstNet) if (sink === net) found.push(q);
    return found;
  };
  const loadOf = (net: string): number => {
    let cap = 0;
    for (const q of sinksOf(net)) cap += pinCap(q);
    for (const gate of buffers) {
      if (gate.inputs[0] !== net || !tree.has(gate.output)) continue;
      cap += cells.get(gate.cell)?.cap ?? 0;
    }
    return cap;
  };
  const inputOf = (gate: MapGate, seen: ReadonlySet<string>): number => {
    const src = gate.inputs[0] ?? "";
    if (seen.has(gate.output)) return slewAt(src);
    const parent = buffers.find((item) => item.output === src && tree.has(item.output));
    const parentCell = parent ? cells.get(parent.cell) : undefined;
    if (!parent || !parentCell?.slew) return slewAt(src);
    const nextSeen = new Set(seen);
    nextSeen.add(gate.output);
    return edgeSlew(parentCell, loadOf(src), inputOf(parent, nextSeen));
  };
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false;
    for (const gate of [...buffers]) {
      if (!tree.has(gate.output)) continue;
      const cell = cells.get(gate.cell);
      if (!cell) continue;
      const load = loadOf(gate.output);
      const incoming = inputOf(gate, new Set());
      if (cellMeets(library, cell, load, incoming, query, mode)) continue;
      const fit = byArea(
        library.cells.filter((item) => item.family === cell.family && (!cell.slew || item.slew)),
      ).find(
        (item) =>
          item.area + 1e-9 >= cell.area && cellMeets(library, item, load, incoming, query, mode),
      );
      if (fit && fit.name !== gate.cell) {
        gate.cell = fit.name;
        changed = true;
        continue;
      }
      const qs = sinksOf(gate.output);
      const choice = relieveNet(
        library,
        qs.map((q) => pinCap(q)),
        load,
        (nextLoad) => cellMeets(library, cell, nextLoad, incoming, query, mode),
        qs.length >= 2 ? cell : undefined,
        incoming,
        edgeSlew(cell, load, incoming),
        query,
        mode,
      );
      if (!choice) continue;
      for (const group of choice.groups) {
        const wire = `_${next}`;
        next += 1;
        buffers.push({
          cell: choice.cell.name,
          output: wire,
          inputs: [choice.kind === "buffer" ? gate.output : (gate.inputs[0] ?? "")],
        });
        tree.add(wire);
        for (const index of group) {
          const q = qs[index];
          if (q) rstNet.set(q, wire);
        }
      }
      changed = true;
    }
    if (!changed) break;
  }
  const hits: LimitHit[] = [];
  for (const gate of buffers) {
    if (!tree.has(gate.output)) continue;
    const cell = cells.get(gate.cell);
    if (!cell) continue;
    const load = loadOf(gate.output);
    const incoming = inputOf(gate, new Set());
    if (cellMeets(library, cell, load, incoming, query, mode)) continue;
    const limit = cellTran(cell, constraints.maxTransition);
    const slew = cell.slew ? edgeSlew(cell, load, incoming) : 0;
    const slewBad = limit !== undefined && cell.slew !== undefined && slew > limit + 1e-9;
    const capLimit =
      cell.maxCap !== undefined && constraints.maxCapacitance !== undefined
        ? Math.min(cell.maxCap, constraints.maxCapacitance)
        : (cell.maxCap ?? constraints.maxCapacitance);
    const capBad = capLimit !== undefined && load > capLimit + 1e-12;
    hits.push({
      net: gate.output,
      cell: gate.cell,
      cap: capBad ? tidy(load) : 0,
      maxCap: capBad ? capLimit : null,
      fanout: sinksOf(gate.output).length,
      maxFanout: cell.maxFanout ?? null,
      slew: slewBad ? tidy(slew) : null,
      maxTran: slewBad ? (limit ?? null) : null,
    });
  }
  return hits;
}

/** Step up a flop when Q slew is over the limit, or when its launch misses setup. */
function sizeFlops(
  flops: readonly Flop[],
  chosen: Map<string, FlopCell>,
  names: Map<string, string>,
  library: Library,
  mode: MapMode,
  weightOf: (name: string, tabular?: boolean) => number,
  constraints: Constraints,
  evaluate: () => { path: PathStep[]; timing: ClockReport | null },
  combo: MapReport | null,
  netlist: Netlist,
): void {
  const clockSlew = constraints.clockTransition ?? librarySlew(library);
  for (const flop of flops) {
    const options = flopOptions(library, flop);
    let at = options.findIndex((cell) => cell.name === chosen.get(flop.q)?.name);
    if (at < 0) continue;
    const cap = sinkCap(flop.q, combo, netlist.outputs, library, constraints.outputLoad);
    const fanout = loadsOf(flop.q, combo, netlist.outputs);
    while (at < options.length - 1) {
      const cell = options[at];
      if (!cell?.qSlew) break;
      const limit = flopLimit(cell, constraints.maxTransition);
      const slew = outputSlew(cell, weightOf(flop.q, true), clockSlew);
      if (limit === undefined || slew === null || slew <= limit + 1e-9) break;
      const next = options[at + 1];
      if (!next || !driveFits(next, cap, fanout)) break;
      at += 1;
      chosen.set(flop.q, next);
      names.set(flop.q, next.name);
    }
  }
  if (mode === "area") return;
  for (let step = 0; step < 8; step += 1) {
    const before = evaluate();
    const slack = before.timing?.slack;
    if (slack === undefined || slack >= -1e-9) return;
    const launch = launchOfPath(before.path, chosen, flops, before.timing?.endpoint ?? "");
    const flop = flops.find((item) => item.q === launch);
    if (!launch || !flop) return;
    const options = flopOptions(library, flop);
    const cell = chosen.get(launch);
    const at = options.findIndex((item) => item.name === cell?.name);
    const next = options[at + 1];
    if (!cell || !next) return;
    const cap = sinkCap(launch, combo, netlist.outputs, library, constraints.outputLoad);
    const fanout = loadsOf(launch, combo, netlist.outputs);
    if (!driveFits(next, cap, fanout)) return;
    chosen.set(launch, next);
    names.set(launch, next.name);
    const after = evaluate();
    const nextSlack = after.timing?.slack ?? Number.NEGATIVE_INFINITY;
    const holdFloor =
      before.timing?.holdMet === false ? (before.timing.holdSlack ?? 0) - 1e-9 : -1e-9;
    const slackBetter = nextSlack > slack + 1e-4;
    const moved = after.timing?.endpoint !== before.timing?.endpoint;
    const faster =
      (after.timing?.arrival ?? Number.POSITIVE_INFINITY) <
      (before.timing?.arrival ?? Number.POSITIVE_INFINITY) - 1e-4;
    if (
      !(slackBetter || moved || faster) ||
      nextSlack < slack - 1e-9 ||
      (after.timing?.holdSlack ?? -1) < holdFloor
    ) {
      chosen.set(launch, cell);
      names.set(launch, cell.name);
      return;
    }
  }
}

function launchOf(cell: FlopCell, weight: number, model: DelayModel, slew?: number): number {
  if (cell.qTable) return tidy(tableDelay(cell.qTable, weight, slew));
  const load = model === "cap" ? weight : Math.max(0, weight - 1);
  return tidy(cell.clkToQ + load / cell.drive);
}

function launchEdge(
  cell: FlopCell,
  weight: number,
  model: DelayModel,
  slew: number | undefined,
  edge: "min" | "max",
): number {
  if (!cell.qTable) return launchOf(cell, weight, model, slew);
  const rise = tableEdge(cell.qTable, "rise", weight, slew ?? cell.qTable.slews[0] ?? 0);
  const fall = tableEdge(cell.qTable, "fall", weight, slew ?? cell.qTable.slews[0] ?? 0);
  return tidy(edge === "min" ? Math.min(rise, fall) : Math.max(rise, fall));
}

function chosenWire(library: Library, name: string): WireLoad | null {
  if (name === "none") return null;
  const wanted = name || library.defaultWireLoad;
  if (!wanted) return null;
  const found = library.wireLoads?.find((model) => model.name === wanted);
  if (!found && name) throw new Error(`no wire load ${name}`);
  return found ?? null;
}

function portMaps(
  netlist: Netlist,
  ports: Record<string, PortConstraint>,
): {
  slew: Map<string, number>;
  load: Map<string, number>;
  delay: Map<string, number>;
  output: Map<string, number>;
} {
  const slew = new Map<string, number>();
  const load = new Map<string, number>();
  const delay = new Map<string, number>();
  const output = new Map<string, number>();
  for (const [name, spec] of Object.entries(ports)) {
    if (spec.slew !== undefined) slew.set(name, spec.slew);
    if (spec.load !== undefined) load.set(name, spec.load);
    if (spec.delay === undefined) continue;
    if (netlist.inputs.includes(name)) delay.set(name, spec.delay);
    if (netlist.outputs.includes(name)) output.set(name, spec.delay);
  }
  return { slew, load, delay, output };
}

function flopTax(library: Library): number {
  const flop = byArea(library.flops)[0];
  return (flop?.clkToQ ?? 0) + (flop?.setup ?? 0);
}

function endpointWire(netlist: Netlist, endpoint: string): string | null {
  if (endpoint.endsWith("/D")) {
    const q = endpoint.slice(0, -2);
    return flopsOf(netlist).find((flop) => flop.q === q)?.d ?? null;
  }
  return netlist.outputs.includes(endpoint) ? endpoint : null;
}

function sweepFromOutputs(netlist: Netlist): Gate[] {
  const byId = new Map(netlist.gates.map((gate) => [gate.id, gate]));
  const keep = new Set<string>();
  const stack = [...netlist.outputs, ...(netlist.clockGates ?? []).map((gate) => gate.en)];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || keep.has(id) || id === "0" || id === "1") continue;
    keep.add(id);
    const gate = byId.get(id);
    if (!gate) continue;
    for (const net of gate.ins) stack.push(net);
  }
  return netlist.gates.filter((gate) => keep.has(gate.id));
}

function replaceAdder(netlist: Netlist, site: AdderSite, kind: AdderKind): void {
  const byId = new Map(netlist.gates.map((gate) => [gate.id, gate]));
  const roots = [...site.sums, site.cout].filter((id) => byId.has(id));
  if (roots.length === 0) return;
  const stops = new Set<string>([...site.a, ...site.b, site.cin, "0", "1"]);
  const drop = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || drop.has(id) || stops.has(id)) continue;
    const gate = byId.get(id);
    if (!gate || gate.op === "DFF" || gate.op === "LATCH") continue;
    drop.add(id);
    for (const net of gate.ins) stack.push(net);
  }
  netlist.gates = netlist.gates.filter((gate) => !drop.has(gate.id));
  const used = new Set([...netlist.inputs, ...netlist.gates.map((gate) => gate.id)]);
  let seq = 0;
  const emit = (op: Gate["op"], ins: string[], id?: string): string => {
    let name = id;
    if (!name) {
      do {
        name = `_ad${seq}`;
        seq += 1;
      } while (used.has(name));
    }
    if (used.has(name)) throw new Error(`adder pin ${name} is still live`);
    used.add(name);
    netlist.gates.push({ id: name, op, ins: [...ins] });
    return name;
  };
  const built = rebuildAdder(kind, emit, site.a, site.b, site.cin, site.sums);
  if (built.cout !== site.cout && drop.has(site.cout)) {
    const gate = netlist.gates.find((item) => item.id === built.cout);
    if (!gate) return;
    used.delete(built.cout);
    gate.id = site.cout;
  }
}

function rewriteAdders(
  netlist: Netlist,
  flips: readonly { site: AdderSite; kind: AdderKind }[],
): Netlist {
  const gates = netlist.gates.map((gate) => ({ ...gate, ins: [...gate.ins] }));
  const kindOf = new Map(flips.map((flip) => [flip.site, flip.kind]));
  const adders = (netlist.adders ?? []).map((site) => ({
    ...site,
    a: [...site.a],
    b: [...site.b],
    sums: [...site.sums],
    kind: kindOf.get(site) ?? site.kind,
  }));
  const copy: Netlist = { ...netlist, gates, adders, adderTuned: true };
  for (const flip of flips) replaceAdder(copy, flip.site, flip.kind);
  copy.gates = sweepFromOutputs(copy);
  return validate(copy);
}

function logicDepth(netlist: Netlist, root: string): number {
  const byId = new Map(netlist.gates.map((gate) => [gate.id, gate]));
  const at = new Map<string, number>();
  const arrival = (id: string): number => {
    if (!id || id === "0" || id === "1" || !byId.has(id)) return 0;
    const cached = at.get(id);
    if (cached !== undefined) return cached;
    const gate = byId.get(id);
    if (!gate || gate.op === "DFF" || gate.op === "LATCH") {
      at.set(id, 0);
      return 0;
    }
    at.set(id, 0);
    let best = 0;
    for (const net of gate.ins) best = Math.max(best, arrival(net));
    const depth = best + 1;
    at.set(id, depth);
    return depth;
  };
  return arrival(root);
}

function tuneAdders(
  netlist: Netlist,
  source: LibrarySource,
  mode: MapMode,
  timingConstraint: number | Constraints,
  seeds: ReadonlyMap<number, readonly PatternSeed[]>,
  report: DesignReport,
  ends: { wire: string; slack: number }[],
): DesignReport {
  if (netlist.adderTuned || !report.timing || !netlist.adders?.length) return report;
  const slack = report.timing.slack;
  if (!(slack > 0.02) && !(slack < -0.02)) return report;
  const byId = new Map(netlist.gates.map((gate) => [gate.id, gate]));
  const users = new Map<string, string[]>();
  for (const gate of netlist.gates) {
    if (gate.op === "DFF" || gate.op === "LATCH") continue;
    for (const net of gate.ins) {
      const list = users.get(net);
      if (list) list.push(gate.id);
      else users.set(net, [gate.id]);
    }
  }
  const byWire = new Map<string, number>();
  for (const end of ends) {
    const prev = byWire.get(end.wire);
    if (prev === undefined || end.slack < prev) byWire.set(end.wire, end.slack);
  }
  const through = (site: AdderSite): number => {
    let worst = Number.POSITIVE_INFINITY;
    let hit = false;
    const seen = new Set<string>();
    const stack = [...site.sums, site.cout];
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id || seen.has(id) || id === "0" || id === "1") continue;
      seen.add(id);
      const found = byWire.get(id);
      if (found !== undefined) {
        hit = true;
        if (found < worst) worst = found;
      }
      const gate = byId.get(id);
      if (gate && (gate.op === "DFF" || gate.op === "LATCH")) continue;
      for (const next of users.get(id) ?? []) stack.push(next);
    }
    return hit ? worst : Number.POSITIVE_INFINITY;
  };
  const live = (site: AdderSite) => site.sums.some((id) => byId.has(id)) || byId.has(site.cout);
  const root = endpointWire(netlist, report.timing.endpoint);
  const depth = root ? logicDepth(netlist, root) : 0;
  const step = depth > 0 && report.timing.arrival > 0 ? report.timing.arrival / depth : 0.12;
  const pick = (site: AdderSite, room: number): AdderKind => {
    const width = Math.max(site.a.length, 1);
    const now = adderLevels(site.kind, width);
    const period =
      typeof timingConstraint === "number" ? timingConstraint : timingConstraint.period;
    const bias = typeof timingConstraint === "number" ? undefined : timingConstraint.ppa;
    const weight = ppaWeight(room, period, bias);
    const fits = (kind: AdderKind) =>
      ppaFits(room, (adderLevels(kind, width) - now) * step, weight);
    if (slack > 0) {
      if (fits("ripple")) return "ripple";
      if (fits("lookahead") && adderLevels("lookahead", width) < adderLevels("ripple", width))
        return "lookahead";
      return site.kind;
    }
    if (!(room < -0.02)) return site.kind;
    if (weight >= 0.5 && adderLevels("brent-kung", width) < now) return "brent-kung";
    if (fits("lookahead") && adderLevels("lookahead", width) < now) return "lookahead";
    if (adderLevels("brent-kung", width) < now) return "brent-kung";
    return site.kind;
  };
  const ranked = netlist.adders
    .filter(live)
    .map((site) => {
      const room = through(site);
      const kind = pick(site, room);
      const width = Math.max(site.a.length, 1);
      return {
        site,
        kind,
        room: room - (adderLevels(kind, width) - adderLevels(site.kind, width)) * step,
      };
    })
    .filter((item) => item.kind !== item.site.kind);
  if (ranked.length === 0) return report;
  const accept = (again: DesignReport): boolean => {
    if (!again.timing || !report.timing) return false;
    if (report.timing.holdMet && again.timing.holdSlack < -1e-9) return false;
    if (!report.timing.holdMet && again.timing.holdSlack < report.timing.holdSlack - 1e-9)
      return false;
    if (slack >= 0 && (again.timing.slack < 0 || again.area > report.area + 0.05)) return false;
    if (slack < 0 && again.timing.slack < slack) return false;
    return true;
  };
  const remap = (items: { site: AdderSite; kind: AdderKind }[]): DesignReport | null => {
    if (items.length === 0) return null;
    const again = mapDesign(rewriteAdders(netlist, items), source, mode, timingConstraint, seeds);
    return accept(again) ? again : null;
  };
  ranked.sort((left, right) => right.room - left.room);
  const kept = remap(ranked);
  if (kept) return kept;
  if (slack <= 0 || ranked.length < 2) return report;
  return remap(ranked.slice(0, -1)) ?? report;
}

export function mapDesign(
  netlist: Netlist,
  source: LibrarySource,
  mode: MapMode = "area",
  timingConstraint: number | Constraints = DEFAULT_PERIOD,
  seeds: ReadonlyMap<number, readonly PatternSeed[]> = new Map(),
): DesignReport {
  const constraints = normalize(timingConstraint);
  if (constraints.clockGate && netlist.clockGates === undefined) {
    const gated = insertClockGates(netlist, resolveLibrary(source), mode);
    return mapDesign(gated ?? { ...netlist, clockGates: [] }, source, mode, constraints, seeds);
  }
  const period = constraints.period;
  if (!Number.isFinite(period) || period < 0)
    throw new Error("period must be a non-negative number");
  const flops = flopsOf(netlist);
  const library = resolveLibrary(source);
  const wire = chosenWire(library, constraints.wireLoad);
  const mappedPorts = portMaps(netlist, constraints.ports);
  const arrivalBudget =
    mode === "load"
      ? Math.max(
          0,
          period -
            constraints.inputDelay -
            constraints.outputDelay -
            (flops.length > 0 ? flopTax(library) : 0),
        )
      : undefined;
  const budgetField = arrivalBudget === undefined ? {} : { arrivalBudget };
  const query: ArrivalQuery = {
    ...(constraints.inputTransition !== undefined
      ? { inputSlew: constraints.inputTransition }
      : {}),
    ...(constraints.outputLoad !== undefined ? { outputLoad: constraints.outputLoad } : {}),
    inputDelay: constraints.inputDelay,
    maxFanout: constraints.maxFanout,
    ports: new Set(netlist.outputs),
    ...(mappedPorts.slew.size > 0 ? { portSlew: mappedPorts.slew } : {}),
    ...(mappedPorts.load.size > 0 ? { portLoad: mappedPorts.load } : {}),
    ...(mappedPorts.delay.size > 0 ? { portDelay: mappedPorts.delay } : {}),
    ...(constraints.capPerFanout > 0 ? { capPerFanout: constraints.capPerFanout } : {}),
    ...driveQuery(constraints, netlist.inputs),
    wire,
    ...(constraints.bufferInputs ? { bufferInputs: new Set(netlist.inputs) } : {}),
    ...(constraints.bufferOutputs ? { bufferOutputs: new Set(netlist.outputs) } : {}),
    ...(constraints.maxCapacitance !== undefined
      ? { maxCapacitance: constraints.maxCapacitance }
      : {}),
    ...(constraints.maxTransition !== undefined
      ? { maxTransition: constraints.maxTransition }
      : {}),
    ...budgetField,
  };
  if (flops.length === 0) {
    return {
      ...mapNetlist(netlist, source, mode, query, seeds),
      registers: 0,
      cycles: [],
      timing: null,
    };
  }
  if (
    netlist.inputs.includes("clk") ||
    netlist.gates.some((gate) => gate.id === "clk" || gate.ins.includes("clk"))
  ) {
    throw new Error("clk is the clock pin");
  }
  const cloud = comboCloud(
    netlist,
    (netlist.clockGates ?? []).map((gate) => gate.en),
  );
  const sourceLimit = new Map<string, { maxCap?: number; maxFanout?: number; drive?: number }>();
  for (const flop of flops) {
    const reset = flop.kind === "dff" && flop.rst ? (flop.rstValue ?? 0) : null;
    const family = flop.kind === "latch" ? "LATCH" : flop.rst ? "ADFF" : "DFF";
    const smallest = byArea(
      library.flops.filter(
        (cell) => cell.family === family && (reset === null || servesReset(cell, reset)),
      ),
    )[0];
    const cellCap = smallest?.maxCap;
    const maxCap =
      cellCap === undefined
        ? constraints.maxCapacitance
        : constraints.maxCapacitance === undefined
          ? cellCap
          : Math.min(cellCap, constraints.maxCapacitance);
    sourceLimit.set(flop.q, {
      ...(maxCap !== undefined ? { maxCap } : {}),
      maxFanout: smallest?.maxFanout ?? constraints.maxFanout,
      drive: smallest?.drive ?? 1,
    });
  }
  const sized: ArrivalQuery = {
    ...(constraints.outputLoad !== undefined ? { outputLoad: constraints.outputLoad } : {}),
    maxFanout: constraints.maxFanout,
    ports: new Set(netlist.outputs),
    ...(mappedPorts.load.size > 0 ? { portLoad: mappedPorts.load } : {}),
    ...(constraints.capPerFanout > 0 ? { capPerFanout: constraints.capPerFanout } : {}),
    ...driveQuery(constraints, netlist.inputs),
    wire,
    sourceLimit,
    ...(constraints.bufferInputs ? { bufferInputs: new Set(netlist.inputs) } : {}),
    ...(constraints.bufferOutputs ? { bufferOutputs: new Set(netlist.outputs) } : {}),
    ...(constraints.maxCapacitance !== undefined
      ? { maxCapacitance: constraints.maxCapacitance }
      : {}),
    ...(constraints.maxTransition !== undefined
      ? { maxTransition: constraints.maxTransition }
      : {}),
    ...budgetField,
  };
  const combo = cloud ? mapNetlist(cloud, library, mode, sized, seeds) : null;
  const names = new Map<string, string>();
  const chosen = new Map<string, FlopCell>();
  for (const flop of flops) {
    const reset = flop.kind === "dff" && flop.rst ? (flop.rstValue ?? 0) : null;
    const family = flop.kind === "latch" ? "LATCH" : flop.rst ? "ADFF" : "DFF";
    const fanout = loadsOf(flop.q, combo, netlist.outputs);
    const cell = pickFlop(
      library.flops,
      family,
      fanout,
      sinkCap(flop.q, combo, netlist.outputs, library, constraints.outputLoad),
      mode,
      library.name,
      reset,
    );
    chosen.set(flop.q, cell);
    names.set(flop.q, cell.name);
  }
  const clocked = flops.filter((flop) => flop.kind === "dff");
  const model: DelayModel = mode === "load" ? "cap" : "count";
  const flopOutput = new Set(
    flops.filter((flop) => netlist.outputs.includes(flop.q)).map((flop) => flop.q),
  );
  const weightOf = (name: string, tabular = false) => {
    if (constraints.bufferOutputs && flopOutput.has(name)) {
      const buffer = byArea(library.cells.filter(isBuffer))[0];
      const cap = buffer?.cap ?? inverterOf(library).cap;
      return model === "cap" || tabular ? (cap > 0 ? cap : portCap(library)) : 1;
    }
    return model === "cap" || tabular
      ? capOf(
          name,
          combo,
          netlist.outputs,
          library,
          constraints.outputLoad,
          wire,
          constraints.capPerFanout,
        )
      : loadsOf(name, combo, netlist.outputs);
  };
  const icgs: IcgBuilt[] = netlist.clockGates?.length
    ? realizeClockGates(library, netlist.clockGates, mode, netlist)
    : [];
  const latency = new Map<string, number>();
  for (const icg of icgs) for (const q of icg.flops) latency.set(q, icg.delay);
  const enables = icgs.map((icg) => ({
    id: icg.id,
    en: icg.en,
    setup: icg.setup,
    clkInv: icg.clkInv,
  }));
  const evaluate = () => {
    let delay = combo?.delay ?? 0;
    let rise = combo?.rise ?? 0;
    let fall = combo?.fall ?? 0;
    let path = combo?.path ?? [];
    let risePath = combo?.risePath ?? [];
    let fallPath = combo?.fallPath ?? [];
    let timing: ClockReport | null = null;
    let ends: { wire: string; slack: number }[] = [];
    if (clocked.length > 0) {
      const launch = new Map<string, number>();
      const slews = new Map<string, number>();
      for (const flop of clocked) {
        const cell = chosen.get(flop.q);
        if (!cell) continue;
        const weight = weightOf(flop.q, Boolean(cell.qTable));
        launch.set(
          flop.q,
          launchEdge(cell, weight, model, constraints.clockTransition, "max") +
            (latency.get(flop.q) ?? 0),
        );
        const pinSlew =
          constraints.clockTransition ?? cell.qTable?.slews.find((value) => value > 0) ?? 0;
        if (cell.qSlew)
          slews.set(
            flop.q,
            Math.max(
              tableEdge(cell.qSlew, "rise", weight, pinSlew),
              tableEdge(cell.qSlew, "fall", weight, pinSlew),
            ),
          );
      }
      const timed =
        combo && cloud
          ? arrivals(library, combo.gates, combo.drives, cloud.inputs, launch, model, slews, query)
          : null;
      const minLaunch = new Map<string, number>();
      for (const flop of clocked) {
        const cell = chosen.get(flop.q);
        if (!cell) continue;
        minLaunch.set(
          flop.q,
          launchEdge(
            cell,
            weightOf(flop.q, Boolean(cell.qTable)),
            model,
            constraints.clockTransition,
            "min",
          ) + (latency.get(flop.q) ?? 0),
        );
      }
      const early =
        combo && cloud
          ? arrivals(library, combo.gates, combo.drives, cloud.inputs, minLaunch, model, slews, {
              ...query,
              extreme: "min",
            })
          : null;
      const rules = compileFalse(constraints.falsePaths, netlist, clocked);
      const multi = compileMulti(constraints.multiCycles, netlist, clocked);
      const qNames = new Set(clocked.map((flop) => flop.q));
      const graphs = new Map<string, TimedNet | null>();
      const graphFor = (blocked: Set<string> | null, extreme: "max" | "min"): TimedNet | null => {
        const shared = extreme === "max" ? timed : early;
        if (!blocked || !combo || !cloud) return shared;
        const key = `${extreme}:${[...blocked].sort().join("\n")}`;
        if (graphs.has(key)) return graphs.get(key) ?? null;
        const open = cloud.inputs.some((name) => !blocked.has(name) && !blocked.has(`${name}/Q`));
        if (!open) {
          graphs.set(key, null);
          return null;
        }
        const seeded = banLaunch(extreme === "max" ? launch : minLaunch, blocked, extreme);
        const next = arrivals(
          library,
          combo.gates,
          combo.drives,
          cloud.inputs,
          seeded,
          model,
          slews,
          extreme === "min" ? { ...query, extreme: "min" } : query,
        );
        graphs.set(key, next);
        return next;
      };
      const openPath = (
        endId: string,
        check: "setup" | "hold",
        single: string | null,
      ): Set<string> | null | "skip" => {
        const found = blockedStarts(rules, endId, check);
        if (found === "all" || (found && single !== null && found.has(single))) return "skip";
        return single === null ? found : null;
      };
      const points: {
        name: string;
        wire: string;
        arrival: number;
        rise: number;
        fall: number;
        setup: number;
        setupCycles: number;
        outputDelay: number;
        capture: number;
        edge: "rise" | "fall";
        pin: string;
        path: PathStep[];
        risePath: PathStep[];
        fallPath: PathStep[];
      }[] = [];
      const withLaunch = (steps: PathStep[]): PathStep[] => {
        const start = steps[0];
        const cell = start ? chosen.get(start.label) : undefined;
        if (!cell || !start) return steps;
        const renamed = steps.map((step, index) =>
          index === 0 ? { ...step, label: `${start.label}/Q` } : step,
        );
        return [{ label: cell.name, at: 0, incr: 0, slew: 0, edge: start.edge }, ...renamed];
      };
      const clockSlewOf = (cell: FlopCell): number =>
        constraints.clockTransition ??
        cell.qTable?.slews.find((value) => value > 0) ??
        librarySlew(library);
      const slewFor = (graph: TimedNet | null, wire: string, edge: "rise" | "fall"): number => {
        if (graph) return graph.slewEdge(wire, edge);
        const launched = slews.get(wire);
        if (launched !== undefined) return launched;
        return constraints.inputTransition ?? constraints.clockTransition ?? librarySlew(library);
      };
      const push = (
        name: string,
        wire: string,
        setup: number,
        direct: number | null,
        graph: TimedNet | null,
        setupCycles: number,
        capture = 0,
        pin = wire,
        cell?: FlopCell,
      ) => {
        const rise =
          direct !== null
            ? direct
            : wire === "1'b0" || wire === "1'b1"
              ? 0
              : (graph?.edgeAt(wire, "rise") ?? 0);
        const fall =
          direct !== null
            ? direct
            : wire === "1'b0" || wire === "1'b1"
              ? 0
              : (graph?.edgeAt(wire, "fall") ?? 0);
        const edgeAtRise = rise >= fall ? "rise" : "fall";
        let edge = edgeAtRise;
        let arrival = Math.max(rise, fall);
        let used = setup;
        if (cell?.setupArcs?.length) {
          const clk = clockSlewOf(cell);
          const riseNeed = checkTime(
            cell.setupArcs,
            cell.setup,
            "rise",
            slewFor(graph, wire, "rise"),
            clk,
          );
          const fallNeed = checkTime(
            cell.setupArcs,
            cell.setup,
            "fall",
            slewFor(graph, wire, "fall"),
            clk,
          );
          if (rise + riseNeed >= fall + fallNeed) {
            edge = "rise";
            arrival = rise;
            used = riseNeed;
          } else {
            edge = "fall";
            arrival = fall;
            used = fallNeed;
          }
        }
        const launchCell = chosen.get(name);
        const bare = (at: number, which: "rise" | "fall"): PathStep[] =>
          launchCell
            ? [
                { label: launchCell.name, at: 0, incr: 0, slew: 0, edge: which },
                { label: name, at, incr: at, slew: 0, edge: which },
              ]
            : [{ label: name, at, incr: at, slew: 0, edge: which }];
        const rose =
          graph && direct === null
            ? withLaunch(graph.pathTo(wire, name, "rise"))
            : bare(rise, "rise");
        const fell =
          graph && direct === null
            ? withLaunch(graph.pathTo(wire, name, "fall"))
            : bare(fall, "fall");
        points.push({
          name,
          wire,
          arrival,
          rise,
          fall,
          setup: used,
          setupCycles,
          outputDelay: netlist.outputs.includes(name)
            ? (mappedPorts.output.get(name) ?? constraints.outputDelay)
            : 0,
          capture,
          edge,
          pin,
          path: edge === "rise" ? rose : fell,
          risePath: rose,
          fallPath: fell,
        });
      };
      const finiteAt = (graph: TimedNet | null, wire: string): boolean => {
        if (!graph || wire === "1'b0" || wire === "1'b1")
          return graph !== null || wire === "1'b0" || wire === "1'b1";
        return (
          Number.isFinite(graph.edgeAt(wire, "rise")) || Number.isFinite(graph.edgeAt(wire, "fall"))
        );
      };
      for (const flop of clocked) {
        const cell = chosen.get(flop.q);
        if (!cell) continue;
        const endId = `${flop.q}/D`;
        const drive = combo?.drives.find((item) => item.name === flop.d);
        if (drive) {
          const decision = openPath(endId, "setup", null);
          if (decision === "skip") continue;
          const graph = graphFor(decision, "max");
          if (!finiteAt(graph, drive.wire)) continue;
          push(
            endId,
            drive.wire,
            cell.setup,
            null,
            graph,
            cyclesFor(multi, endId, null).setup,
            latency.get(flop.q) ?? 0,
            flop.d,
            cell,
          );
        } else {
          const start = startPin(flop.d, qNames);
          const decision = openPath(endId, "setup", start);
          if (decision === "skip") continue;
          const bare = netlist.inputs.includes(flop.d)
            ? (mappedPorts.delay.get(flop.d) ?? constraints.inputDelay)
            : (launch.get(flop.d) ?? 0);
          const hopped =
            constraints.bufferInputs && netlist.inputs.includes(flop.d)
              ? bare +
                portHop(
                  library,
                  portCap(library),
                  constraints.inputTransition ?? librarySlew(library),
                )
              : bare;
          push(
            netlist.inputs.includes(flop.d) ? flop.d : endId,
            flop.d,
            cell.setup,
            hopped,
            null,
            cyclesFor(multi, endId, start).setup,
            latency.get(flop.q) ?? 0,
            flop.d,
            cell,
          );
        }
      }
      for (const out of netlist.outputs) {
        if (qNames.has(out)) {
          if (openPath(out, "setup", `${out}/Q`) === "skip") continue;
          const cell = chosen.get(out);
          if (!cell) continue;
          const launched =
            launchEdge(
              cell,
              weightOf(out, Boolean(cell.qTable)),
              model,
              constraints.clockTransition,
              "max",
            ) + (latency.get(out) ?? 0);
          const hopped = constraints.bufferOutputs
            ? launched +
              portHop(
                library,
                constraints.outputLoad ?? portCap(library),
                constraints.clockTransition ?? librarySlew(library),
              )
            : launched;
          push(out, out, 0, hopped, null, cyclesFor(multi, out, `${out}/Q`).setup);
          continue;
        }
        const drive = combo?.drives.find((item) => item.name === out);
        const decision = openPath(out, "setup", null);
        if (!drive || decision === "skip") continue;
        const graph = graphFor(decision, "max");
        if (!finiteAt(graph, drive.wire)) continue;
        push(out, drive.wire, 0, null, graph, cyclesFor(multi, out, null).setup, 0, out);
      }
      for (const end of enables) {
        const endId = `${end.id}/EN`;
        const drive = combo?.drives.find((item) => item.name === end.en);
        const decision = openPath(endId, "setup", null);
        if (decision === "skip") continue;
        const pinSetup = end.setup + end.clkInv;
        if (drive) {
          const graph = graphFor(decision, "max");
          if (!finiteAt(graph, drive.wire)) continue;
          push(endId, drive.wire, pinSetup, null, graph, 0.5, 0, end.en);
          continue;
        }
        const direct = netlist.inputs.includes(end.en)
          ? (mappedPorts.delay.get(end.en) ?? constraints.inputDelay) +
            (constraints.bufferInputs
              ? portHop(
                  library,
                  portCap(library),
                  constraints.inputTransition ?? librarySlew(library),
                )
              : 0)
          : (launch.get(end.en) ?? 0);
        push(endId, end.en, pinSetup, direct, null, 0.5, 0);
      }
      let worst = points[0];
      const required = (point: (typeof points)[number]) =>
        point.setupCycles * period +
        point.capture -
        point.setup -
        point.outputDelay -
        point.arrival -
        constraints.setupUncertainty;
      for (const point of points) {
        if (!worst || required(point) < required(worst)) worst = point;
      }
      let holdName = "(none)";
      let hold = 0;
      let holdSlack = Number.POSITIVE_INFINITY;
      let holdCycles = 0;
      let holdConstrained = false;
      for (const flop of clocked) {
        const cell = chosen.get(flop.q);
        if (!cell) continue;
        const endId = `${flop.q}/D`;
        const drive = combo?.drives.find((item) => item.name === flop.d);
        const start = drive ? null : startPin(flop.d, qNames);
        const decision = openPath(endId, "hold", start);
        if (decision === "skip") continue;
        const fallback = cell.hold ?? 0;
        let riseAt: number;
        let fallAt: number;
        let graph: TimedNet | null = null;
        let wire = flop.d;
        if (drive) {
          graph = graphFor(decision, "min");
          if (!graph) continue;
          wire = drive.wire;
          riseAt = graph.edgeAt(wire, "rise");
          fallAt = graph.edgeAt(wire, "fall");
          if (!Number.isFinite(riseAt) && !Number.isFinite(fallAt)) continue;
        } else if (netlist.inputs.includes(flop.d)) {
          const at = mappedPorts.delay.get(flop.d) ?? constraints.inputDelay;
          riseAt = at;
          fallAt = at;
        } else {
          const at = minLaunch.get(flop.d) ?? 0;
          riseAt = at;
          fallAt = at;
        }
        if (!Number.isFinite(riseAt)) riseAt = Number.POSITIVE_INFINITY;
        if (!Number.isFinite(fallAt)) fallAt = Number.POSITIVE_INFINITY;
        const clk = clockSlewOf(cell);
        const riseNeed = checkTime(
          cell.holdArcs,
          fallback,
          "rise",
          slewFor(graph, wire, "rise"),
          clk,
        );
        const fallNeed = checkTime(
          cell.holdArcs,
          fallback,
          "fall",
          slewFor(graph, wire, "fall"),
          clk,
        );
        const riseSlack = riseAt - riseNeed;
        const fallSlack = fallAt - fallNeed;
        const arrival = riseSlack <= fallSlack ? riseAt : fallAt;
        const need = riseSlack <= fallSlack ? riseNeed : fallNeed;
        holdConstrained = true;
        const cycles = cyclesFor(multi, endId, start);
        const slackHere = tidy(
          arrival -
            (latency.get(flop.q) ?? 0) -
            need -
            cycles.hold * period -
            constraints.holdUncertainty,
        );
        if (slackHere < holdSlack) {
          holdSlack = slackHere;
          hold = need;
          holdName = endId;
          holdCycles = cycles.hold;
        }
      }
      if (!Number.isFinite(holdSlack)) holdSlack = 0;
      const clockSlew = constraints.clockTransition ?? librarySlew(library);
      let maxSlew = Math.max(clockSlew, constraints.inputTransition ?? librarySlew(library));
      const watchSlew = (value: number) => {
        if (Number.isFinite(value) && value > maxSlew) maxSlew = value;
      };
      for (const value of slews.values()) watchSlew(value);
      if (timed && combo) {
        for (const gate of combo.gates) watchSlew(timed.slewAt(gate.output));
        for (const drive of combo.drives) watchSlew(timed.slewAt(drive.wire));
      }
      maxSlew = tidy(maxSlew);
      ends = points.map((point) => ({ wire: point.pin, slack: tidy(required(point)) }));
      const wireName =
        constraints.capPerFanout > 0
          ? `${constraints.capPerFanout}/fanout`
          : (wire?.name ?? "none");
      if (worst) {
        delay = worst.arrival;
        rise = worst.rise;
        fall = worst.fall;
        path = worst.path;
        risePath = worst.risePath;
        fallPath = worst.fallPath;
        const slack = tidy(required(worst));
        timing = {
          period,
          slack,
          arrival: worst.arrival,
          setup: tidy(worst.setup),
          endpoint: worst.name,
          met: slack >= 0,
          edge: worst.edge,
          inputDelay: constraints.inputDelay,
          outputDelay: worst.outputDelay,
          hold: tidy(hold),
          holdSlack: tidy(holdSlack),
          holdMet: holdSlack >= 0,
          holdEndpoint: holdName,
          constrained: true,
          holdConstrained,
          clockLatency: 0,
          clockSlew,
          maxSlew,
          setupUncertainty: constraints.setupUncertainty,
          holdUncertainty: constraints.holdUncertainty,
          setupCycles: worst.setupCycles,
          holdCycles,
          wireLoad: wireName,
          capPerFanout: constraints.capPerFanout,
        };
      } else {
        timing = {
          period,
          slack: 0,
          arrival: 0,
          setup: 0,
          endpoint: "(none)",
          met: true,
          edge: "rise",
          inputDelay: constraints.inputDelay,
          outputDelay: constraints.outputDelay,
          hold: tidy(hold),
          holdSlack: tidy(holdSlack),
          holdMet: holdSlack >= 0,
          holdEndpoint: holdName,
          constrained: false,
          holdConstrained,
          clockLatency: 0,
          clockSlew,
          maxSlew,
          setupUncertainty: constraints.setupUncertainty,
          holdUncertainty: constraints.holdUncertainty,
          setupCycles: 1,
          holdCycles,
          wireLoad: wireName,
          capPerFanout: constraints.capPerFanout,
        };
      }
    }
    return { delay, rise, fall, path, risePath, fallPath, timing, ends };
  };
  const clockPin = constraints.clockTransition ?? librarySlew(library);
  const drivenSlews = (): Map<string, number> => {
    const slews = new Map<string, number>();
    for (const flop of flops) {
      const cell = chosen.get(flop.q);
      if (!cell?.qSlew) continue;
      const slew = outputSlew(cell, weightOf(flop.q, true), clockPin);
      if (slew !== null) slews.set(flop.q, slew);
    }
    return slews;
  };
  const qOver = (): boolean =>
    flops.some((flop) => {
      const cell = chosen.get(flop.q);
      if (!cell?.qSlew) return false;
      const limit = flopLimit(cell, constraints.maxTransition);
      const slew = outputSlew(cell, weightOf(flop.q, true), clockPin);
      return limit !== undefined && slew !== null && slew > limit + 1e-9;
    });
  const shapeOf = (): string =>
    (combo?.gates ?? [])
      .map((gate) => `${gate.cell}:${gate.output}:${gate.inputs.join(",")}`)
      .join(";");
  const repairCloud = () => {
    if (!combo || !cloud) return;
    const tried = new Set<string>();
    for (let pass = 0; pass < 12; pass += 1) {
      const before = shapeOf();
      splitFlopLoads(library, combo, flops, chosen, constraints, weightOf, tried);
      combo.gates = repairLimits(
        library,
        combo.gates,
        combo.drives,
        cloud.inputs,
        mode,
        query,
        drivenSlews(),
      );
      if (!qOver() || shapeOf() === before) break;
    }
  };
  repairCloud();
  sizeFlops(flops, chosen, names, library, mode, weightOf, constraints, evaluate, combo, netlist);
  if (qOver()) repairCloud();
  const checkQuery: ArrivalQuery = {
    ...sized,
    ...(query.inputSlew !== undefined ? { inputSlew: query.inputSlew } : {}),
    ...(query.portSlew ? { portSlew: query.portSlew } : {}),
  };
  const slewModel: DelayModel = library.cells.some((cell) => cell.slew) ? "cap" : model;
  const gateHits = (): LimitHit[] =>
    combo && cloud
      ? limitHits(
          library,
          combo.gates,
          combo.drives,
          cloud.inputs,
          slewModel,
          checkQuery,
          drivenSlews(),
        )
      : [];
  const flopHits = (): LimitHit[] => {
    const hits: LimitHit[] = [];
    for (const flop of clocked) {
      const cell = chosen.get(flop.q);
      if (!cell?.qSlew) continue;
      const limit = flopLimit(cell, constraints.maxTransition);
      if (limit === undefined) continue;
      const slew = outputSlew(cell, weightOf(flop.q, true), clockPin);
      if (slew === null || slew <= limit + 1e-9) continue;
      hits.push({
        net: flop.q,
        cell: cell.name,
        cap: 0,
        maxCap: cell.maxCap ?? null,
        fanout: 0,
        maxFanout: cell.maxFanout ?? null,
        slew: tidy(slew),
        maxTran: limit,
      });
    }
    return hits;
  };
  const allHits = (): LimitHit[] => [...gateHits(), ...flopHits()];
  const tranCount = (hits: readonly LimitHit[]): number =>
    hits.filter((hit) => hit.maxTran !== null).length;
  const evaluated = evaluate();
  let delay = evaluated.delay;
  let rise = evaluated.rise;
  let fall = evaluated.fall;
  let path = evaluated.path;
  let risePath = evaluated.risePath;
  let fallPath = evaluated.fallPath;
  let timing = evaluated.timing;
  let ends = evaluated.ends;
  const placedArea = () =>
    (combo?.gates ?? []).reduce(
      (sum, gate) => sum + (library.cells.find((cell) => cell.name === gate.cell)?.area ?? 0),
      0,
    ) + flops.reduce((sum, flop) => sum + (chosen.get(flop.q)?.area ?? 0), 0);
  let recovery: DesignReport["recovery"];
  if (constraints.recover && timing && combo && cloud) {
    const slackBefore = timing.slack;
    const holdBefore = timing.holdSlack;
    const before = placedArea();
    let steps = 0;
    if (slackBefore > 0.02) {
      const baseHits = allHits();
      const baseOver = baseHits.length;
      const baseTran = tranCount(baseHits);
      // A rejected swap stays rejected. Later swaps only add delay and slew,
      // so a setup or electrical miss cannot become legal. A hold miss can,
      // because a slower data path can repair it, and those swaps are tried again.
      const dead = new Set<string>();
      const holdFloor = holdBefore >= 0 ? -1e-9 : holdBefore - 1e-9;
      for (let pass = 0; pass < 48 && steps < 48; pass += 1) {
        const moves: {
          key: string;
          save: number;
          apply: () => void;
          revert: () => void;
        }[] = [];
        for (const gate of combo.gates) {
          const cell = library.cells.find((item) => item.name === gate.cell);
          if (!cell) continue;
          const options = byArea(library.cells.filter((item) => item.family === cell.family));
          const prev = options[options.findIndex((item) => item.name === cell.name) - 1];
          if (!prev || prev.area >= cell.area - 1e-9) continue;
          const key = `g:${gate.output}->${prev.name}`;
          if (dead.has(key)) continue;
          const old = gate.cell;
          moves.push({
            key,
            save: cell.area - prev.area,
            apply: () => {
              gate.cell = prev.name;
            },
            revert: () => {
              gate.cell = old;
            },
          });
        }
        for (const flop of flops) {
          const cell = chosen.get(flop.q);
          if (!cell) continue;
          const reset = flop.kind === "dff" && flop.rst ? (flop.rstValue ?? 0) : null;
          const options = byArea(
            library.flops.filter(
              (item) => item.family === cell.family && (reset === null || servesReset(item, reset)),
            ),
          );
          const prev = options[options.findIndex((item) => item.name === cell.name) - 1];
          if (!prev || prev.area >= cell.area - 1e-9) continue;
          const key = `f:${flop.q}->${prev.name}`;
          if (dead.has(key)) continue;
          moves.push({
            key,
            save: cell.area - prev.area,
            apply: () => {
              chosen.set(flop.q, prev);
              names.set(flop.q, prev.name);
            },
            revert: () => {
              chosen.set(flop.q, cell);
              names.set(flop.q, cell.name);
            },
          });
        }
        moves.sort((left, right) => right.save - left.save);
        let took = false;
        for (const move of moves) {
          move.apply();
          const trial = evaluate();
          const slackOk = (trial.timing?.slack ?? -1) >= -1e-9;
          const holdOk = (trial.timing?.holdSlack ?? -1) >= holdFloor;
          if (slackOk && holdOk) {
            const overs = allHits();
            if (
              overs.length <= baseOver &&
              tranCount(overs) <= baseTran &&
              placedArea() < before - 1e-6
            ) {
              delay = trial.delay;
              rise = trial.rise;
              fall = trial.fall;
              path = trial.path;
              risePath = trial.risePath;
              fallPath = trial.fallPath;
              timing = trial.timing;
              ends = trial.ends;
              steps += 1;
              took = true;
              break;
            }
            move.revert();
            dead.add(move.key);
            continue;
          }
          move.revert();
          if (!slackOk) dead.add(move.key);
        }
        if (!took) break;
      }
    }
    recovery = {
      before,
      after: placedArea(),
      slackBefore,
      slackAfter: timing?.slack ?? slackBefore,
      steps,
    };
  }
  const cycles = trace(netlist, flops, library, combo, 8);
  const mismatches = cycles.filter((row) => !row.match).length + (combo?.equiv.mismatches ?? 0);
  const pins = new Map<string, string>();
  const buffers: MapGate[] = [];
  if (constraints.bufferInputs) {
    for (const input of netlist.inputs) {
      const isolated = combo?.gates.find((gate) => gate.output === `_ib_${input}`)?.output;
      const drivesFlop = flops.some(
        (flop) => flop.d === input || flop.en === input || flop.rst === input,
      );
      if (isolated) pins.set(input, isolated);
      else if (drivesFlop) {
        const net = `_ib_${input}`;
        buffers.push(...tieBuffer(library, net, input));
        pins.set(input, net);
      }
    }
  }
  if (constraints.bufferOutputs) {
    for (const flop of flops) {
      if (!netlist.outputs.includes(flop.q)) continue;
      const net = `_ob_${flop.q}`;
      pins.set(flop.q, net);
      buffers.push(...tieBuffer(library, flop.q, net));
    }
  }
  const seqPins = new Map<string, FlopPins>();
  const rstNet = new Map<string, string>();
  const inverted = new Map<string, string>();
  const inv = inverterOf(library);
  for (const flop of flops) {
    const cell = chosen.get(flop.q);
    if (!cell?.seq) continue;
    seqPins.set(flop.q, cell.seq);
    if (flop.kind !== "dff" || !flop.rst) continue;
    const value = flop.rstValue ?? 0;
    const level = value === 1 ? cell.seq.presetLevel : cell.seq.clearLevel;
    if (level !== 0) continue;
    const src = pins.get(flop.rst) ?? flop.rst;
    const hit = inverted.get(src);
    if (hit) {
      rstNet.set(flop.q, hit);
      continue;
    }
    const net = `_rstn_${src.replace(/[^A-Za-z0-9_]/g, "_")}`;
    buffers.push({ cell: inv.name, output: net, inputs: [src] });
    inverted.set(src, net);
    rstNet.set(flop.q, net);
  }
  const reserved = new Set<string>();
  for (const gate of combo?.gates ?? []) reserved.add(gate.output);
  const timedControls =
    combo && cloud
      ? arrivals(library, combo.gates, combo.drives, cloud.inputs, new Map(), "cap", drivenSlews(), query)
      : null;
  const controlFallback = constraints.inputTransition ?? librarySlew(library);
  const controlHits = repairControlNets(
    library,
    buffers,
    rstNet,
    chosen,
    flops,
    constraints,
    mode,
    (net) => {
      const value = timedControls?.slewAt(net) ?? 0;
      return value > 0 ? value : controlFallback;
    },
    reserved,
  );
  const bufferArea = buffers.reduce(
    (sum, gate) => sum + (library.cells.find((cell) => cell.name === gate.cell)?.area ?? 0),
    0,
  );
  const connect = (net: string): string => {
    if (net === "clk") return "clk";
    const drive = combo?.drives.find((item) => item.name === net);
    if (drive?.wire === "1'b0" || drive?.wire === "1'b1") return drive.wire;
    return pinOf(drive ? drive.wire : net, pins);
  };
  const clocks = new Map<string, string>();
  const icgGates: IcgGate[] = [];
  for (const icg of icgs) {
    for (const q of icg.flops) clocks.set(q, icg.gclk);
    for (const gate of icg.gates) {
      icgGates.push({
        cell: gate.cell,
        output: gate.output,
        outputPin: gate.outputPin,
        inputs: gate.inputs.map(connect),
        pins: gate.pins,
      });
    }
  }
  const icgArea = icgs.reduce((sum, icg) => sum + icg.area, 0);
  const area = placedArea() + bufferArea + icgArea;
  if (recovery)
    recovery = {
      ...recovery,
      before: recovery.before + bufferArea + icgArea,
      after: recovery.after + bufferArea + icgArea,
    };
  const over = [...allHits(), ...controlHits];
  const report: DesignReport = {
    library: library.name,
    mode,
    area,
    delay,
    rise,
    fall,
    path,
    risePath,
    fallPath,
    cells: [
      ...(combo?.gates.map((gate) => gate.cell) ?? []),
      ...flops.map((flop) => names.get(flop.q) ?? "DFF"),
      ...buffers.map((gate) => gate.cell),
      ...icgGates.map((gate) => gate.cell),
    ],
    gates: [...(combo?.gates ?? []), ...buffers],
    drives: combo?.drives ?? [],
    limited: combo?.limited ?? false,
    over,
    verilog: renderSequential(
      netlist,
      flops,
      combo,
      names,
      buffers,
      pins,
      seqPins,
      rstNet,
      icgGates,
      clocks,
    ),
    registers: flops.length,
    cycles,
    timing,
    ...(recovery ? { recovery } : {}),
    ...(netlist.clockGates
      ? {
          clockGates: icgs.map((icg) => ({
            id: icg.id,
            en: icg.en,
            level: icg.level,
            flops: icg.flops,
            area: icg.area,
            delay: tidy(icg.delay),
          })),
        }
      : {}),
    equiv: {
      exhaustive: false,
      vectors: cycles.length,
      mismatches,
      rows: [],
    },
  };
  return tuneAdders(netlist, source, mode, timingConstraint, seeds, report, ends);
}

function startPin(net: string, flops: ReadonlySet<string>): string {
  return flops.has(net) ? `${net}/Q` : net;
}

function banLaunch(
  base: ReadonlyMap<string, number>,
  blocked: ReadonlySet<string>,
  extreme: "max" | "min",
): Map<string, number> {
  const next = new Map(base);
  const value = extreme === "max" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (const name of blocked) next.set(name.endsWith("/Q") ? name.slice(0, -2) : name, value);
  return next;
}

function compileFalse(
  paths: FalsePath[],
  netlist: Netlist,
  flops: Flop[],
): { from: Set<string> | null; to: Set<string> | null; setup: boolean; hold: boolean }[] {
  return paths.map((path) => ({
    from: path.from ? expandFalse(path.from, "from", netlist, flops) : null,
    to: path.to ? expandFalse(path.to, "to", netlist, flops) : null,
    setup: path.setup,
    hold: path.hold,
  }));
}

function compileMulti(
  paths: MultiCycle[],
  netlist: Netlist,
  flops: Flop[],
): {
  from: Set<string> | null;
  to: Set<string> | null;
  setup: number | null;
  hold: number | null;
}[] {
  return paths.map((path) => ({
    from: path.from ? expandFalse(path.from, "from", netlist, flops) : null,
    to: path.to ? expandFalse(path.to, "to", netlist, flops) : null,
    setup: path.setup,
    hold: path.hold,
  }));
}

function cyclesFor(
  rules: {
    from: Set<string> | null;
    to: Set<string> | null;
    setup: number | null;
    hold: number | null;
  }[],
  endId: string,
  start: string | null,
): { setup: number; hold: number } {
  let setup = 1;
  let hold = 0;
  for (const rule of rules) {
    if (rule.to && !rule.to.has(endId)) continue;
    if (rule.from && (start === null || !rule.from.has(start))) continue;
    if (rule.setup !== null) setup = rule.setup;
    if (rule.hold !== null) hold = rule.hold;
  }
  return { setup, hold };
}

function expandFalse(
  end: FalseEnd,
  role: "from" | "to",
  netlist: Netlist,
  flops: Flop[],
): Set<string> {
  const inputs = netlist.inputs.filter((name) => name !== "clk");
  const outputs = netlist.outputs;
  const qPins = flops.map((flop) => `${flop.q}/Q`);
  const dPins = flops.map((flop) => `${flop.q}/D`);
  let found: string[] = [];
  if (end.kind === "inputs") found = inputs;
  else if (end.kind === "outputs") found = outputs;
  else if (end.kind === "registers") found = role === "from" ? qPins : dPins;
  else if (end.kind === "ports") found = collect(end.names, role === "from" ? inputs : outputs);
  else found = collect(end.names, role === "from" ? [...inputs, ...qPins] : [...outputs, ...dPins]);
  if (found.length === 0) throw new Error(`false path matches nothing on -${role}`);
  return new Set(found);
}

function collect(patterns: string[], pool: string[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    const hits = pool.filter((id) => pinMatch(pattern, id));
    if (hits.length === 0) throw new Error(`false path matches no pin '${pattern}'`);
    found.push(...hits);
  }
  return found;
}

function pinMatch(pattern: string, id: string): boolean {
  if (glob(pattern, id)) return true;
  if (id.endsWith("/D") || id.endsWith("/Q")) return glob(pattern, id.slice(0, -2));
  return false;
}

function glob(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`).test(name);
}

function blockedStarts(
  rules: { from: Set<string> | null; to: Set<string> | null; setup: boolean; hold: boolean }[],
  endId: string,
  check: "setup" | "hold",
): Set<string> | "all" | null {
  let blocked: Set<string> | null = null;
  for (const rule of rules) {
    if (check === "setup" && !rule.setup) continue;
    if (check === "hold" && !rule.hold) continue;
    if (rule.to && !rule.to.has(endId)) continue;
    if (!rule.from) return "all";
    blocked ??= new Set();
    for (const name of rule.from) blocked.add(name);
  }
  return blocked;
}

function driveQuery(
  constraints: { drivingCell?: DrivingCell; ports: Record<string, PortConstraint> },
  inputs: string[],
): Pick<ArrivalQuery, "drivingCell" | "portDrive" | "drivingInputs"> {
  const portDrive = new Map<string, DrivingCell>();
  for (const [name, spec] of Object.entries(constraints.ports)) {
    if (spec.drive && spec.slew === undefined) portDrive.set(name, spec.drive);
  }
  return {
    ...(constraints.drivingCell
      ? { drivingCell: constraints.drivingCell, drivingInputs: new Set(inputs) }
      : {}),
    ...(portDrive.size > 0 ? { portDrive } : {}),
  };
}

function portHop(library: Library, load: number, slew: number): number {
  const buffer = byArea(library.cells.filter(isBuffer))[0];
  if (buffer) return bufferDelay(buffer, load, slew);
  const inv = inverterOf(library);
  const pin = inv.cap > 0 ? inv.cap : 1;
  return bufferDelay(inv, pin, slew) + bufferDelay(inv, load, slew);
}

function bufferDelay(cell: Cell, load: number, slew: number): number {
  if (cell.table) return tableDelay(cell.table, load, slew);
  return cell.delay + Math.max(0, load - 1) / (cell.drive || 1);
}
