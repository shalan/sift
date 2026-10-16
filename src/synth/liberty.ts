import {
  tableDelay,
  type Cell,
  type FlopCell,
  type FlopPins,
  type Library,
  type LoadTable,
  type TimingArc,
  type WireLoad,
} from "./library.ts";

export class LibertyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibertyError";
  }
}

interface Group {
  kind: string;
  args: string[];
  attrs: Map<string, string>;
  groups: Group[];
}

interface Token {
  kind: "id" | "num" | "str" | "sym";
  value: string;
  line: number;
}

export const SAMPLE_LIBERTY = `library (sample) {
  cell (INV_X1) {
    area : 1;
    pin (A) { direction : input; capacitance : 1; }
    pin (Y) {
      direction : output;
      function : "!A";
      timing () { related_pin : "A"; intrinsic_rise : 1; intrinsic_fall : 1; }
    }
  }
  cell (NAND2_X1) {
    area : 2;
    pin (A) { direction : input; capacitance : 1; }
    pin (B) { direction : input; capacitance : 1; }
    pin (Y) {
      direction : output;
      function : "!(A * B)";
      timing () { related_pin : "A"; intrinsic_rise : 2; intrinsic_fall : 2; }
    }
  }
  cell (NAND2_X4) {
    area : 8;
    drive_strength : 4;
    pin (A) { direction : input; capacitance : 4; }
    pin (B) { direction : input; capacitance : 4; }
    pin (Y) {
      direction : output;
      function : "!(A * B)";
      timing () { related_pin : "A"; intrinsic_rise : 2; intrinsic_fall : 2; }
    }
  }
  cell (NOR2_X1) {
    area : 2;
    pin (A) { direction : input; capacitance : 1; }
    pin (B) { direction : input; capacitance : 1; }
    pin (Y) {
      direction : output;
      function : "!(A + B)";
      timing () { related_pin : "A"; intrinsic_rise : 2; intrinsic_fall : 2; }
    }
  }
  cell (XOR2_X1) {
    area : 4;
    pin (A) { direction : input; capacitance : 1; }
    pin (B) { direction : input; capacitance : 1; }
    pin (Y) {
      direction : output;
      function : "(A ^ B)";
      timing () { related_pin : "A"; intrinsic_rise : 4; intrinsic_fall : 4; }
    }
  }
  cell (DFF_X1) {
    area : 6;
    ff (IQ, IQN) { next_state : "D"; clocked_on : "CK"; }
    pin (CK) { direction : input; clock : true; }
    pin (D) { direction : input; capacitance : 1; }
    pin (Q) {
      direction : output;
      function : "IQ";
      timing () { related_pin : "CK"; timing_type : rising_edge; intrinsic_rise : 2; intrinsic_fall : 2; }
    }
    pin (D) {
      direction : input;
      timing () { related_pin : "CK"; timing_type : setup_rising; intrinsic_rise : 1; }
    }
  }
  cell (DFFR_X1) {
    area : 8;
    ff (IQ, IQN) { next_state : "D"; clocked_on : "CK"; clear : "!CDN"; }
    pin (CK) { direction : input; clock : true; }
    pin (CDN) { direction : input; }
    pin (D) { direction : input; capacitance : 1; }
    pin (Q) {
      direction : output;
      function : "IQ";
      timing () { related_pin : "CK"; timing_type : rising_edge; intrinsic_rise : 2; intrinsic_fall : 2; }
    }
    pin (D) {
      direction : input;
      timing () { related_pin : "CK"; timing_type : setup_rising; intrinsic_rise : 1; }
    }
  }
  cell (DLH_X1) {
    area : 5;
    latch (IQ, IQN) { enable : "G"; data_in : "D"; }
    pin (G) { direction : input; }
    pin (D) { direction : input; capacitance : 1; }
    pin (Q) { direction : output; function : "IQ"; }
  }
}
`;

export function parseLiberty(source: string): Library {
  const tokens = tokenize(source);
  let cursor = 0;
  const peek = () => tokens[cursor];
  const pull = () => {
    const token = tokens[cursor];
    if (!token) throw new LibertyError("unexpected end of liberty file");
    cursor += 1;
    return token;
  };
  const at = (kind: Token["kind"], value?: string) => {
    const token = peek();
    return Boolean(token && token.kind === kind && (value === undefined || token.value === value));
  };
  const need = (kind: Token["kind"], value?: string) => {
    const token = pull();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new LibertyError(`line ${token.line}: expected ${value ?? kind}`);
    }
    return token;
  };

  function parseValue(): string {
    const token = pull();
    if (token.kind === "str" || token.kind === "num" || token.kind === "id") return token.value;
    throw new LibertyError(`line ${token.line}: expected a value`);
  }

  function parseGroup(): Group {
    const kind = need("id").value;
    need("sym", "(");
    const args: string[] = [];
    if (!at("sym", ")")) {
      args.push(parseValue());
      while (at("sym", ",")) {
        pull();
        args.push(parseValue());
      }
    }
    need("sym", ")");
    const attrs = new Map<string, string>();
    const groups: Group[] = [];
    if (at("sym", "{")) {
      pull();
      while (!at("sym", "}")) {
        if (!peek()) throw new LibertyError("unclosed group");
        if (at("id") && tokens[cursor + 1]?.value === ":") {
          const name = pull().value;
          need("sym", ":");
          attrs.set(name, parseValue());
          need("sym", ";");
        } else if (at("id")) groups.push(parseGroup());
        else throw new LibertyError(`line ${peek()?.line ?? 0}: expected an attribute or a group`);
      }
      need("sym", "}");
    } else need("sym", ";");
    return { kind, args, attrs, groups };
  }

  const top: Group[] = [];
  while (cursor < tokens.length) top.push(parseGroup());
  const library = top.find((group) => group.kind === "library");
  if (!library) throw new LibertyError("expected a library() group");
  const templates = constraintAxes(library);
  const cells: Cell[] = [];
  const flops: FlopCell[] = [];
  for (const group of library.groups) {
    if (group.kind !== "cell") continue;
    if (group.attrs.get("dont_use") === "true") continue;
    if (group.groups.some((child) => child.kind === "statetable")) continue;
    const read = readCell(group, templates);
    if (read.cell) cells.push(read.cell);
    if (read.flop) flops.push(read.flop);
  }
  if (!cells.some((cell) => cell.inputs.length === 1 && cell.fn(0) === 1 && cell.fn(1) === 0)) {
    throw new LibertyError(`${library.args[0] ?? "library"} has no inverter`);
  }
  const wireLoads = library.groups.filter((group) => group.kind === "wire_load").map(readWire);
  const chosen = library.attrs.get("default_wire_load");
  return {
    name: library.args[0] || "liberty",
    cells,
    flops,
    ...(wireLoads.length > 0 ? { wireLoads } : {}),
    ...(chosen ? { defaultWireLoad: chosen } : {}),
  };
}

function readCell(group: Group, templates: Map<string, boolean>): { cell?: Cell; flop?: FlopCell } {
  const name = group.args[0] ?? "cell";
  const seq = group.groups.find((child) => child.kind === "ff" || child.kind === "latch");
  const pins = mergePins(group);
  const inputs = [...pins.values()].filter(
    (pin) => (pin.attrs.get("direction") ?? "input") === "input",
  );
  const outputs = [...pins.values()].filter((pin) => pin.attrs.get("direction") === "output");
  const area = numberAttr(group.attrs.get("area")) ?? 1;
  const cap = inputs.reduce((max, pin) => {
    const value = numberAttr(pin.attrs.get("capacitance") ?? pin.attrs.get("rise_capacitance"));
    return value === null ? max : Math.max(max, value);
  }, 0);
  const drive = strength(name, group.attrs.get("drive_strength"), cap || 1);
  if (seq) {
    const family =
      seq.kind === "latch"
        ? "LATCH"
        : seq.attrs.has("clear") || seq.attrs.has("preset")
          ? "ADFF"
          : "DFF";
    const output =
      outputs.find((pin) => pin.groups.some((child) => child.kind === "timing")) ?? outputs[0];
    const edges = output ? edgeTable(output) : undefined;
    const qTable = edges?.delay;
    const maxCap = output ? numberAttr(output.attrs.get("max_capacitance")) : null;
    const maxFanout = output ? numberAttr(output.attrs.get("max_fanout")) : null;
    const maxTran = transitionOf(output, inputs) ?? characterized(edges?.slew ?? qTable);
    const clock = clockPin(pins, seq);
    const clockCap = clock
      ? numberAttr(clock.attrs.get("capacitance") ?? clock.attrs.get("rise_capacitance"))
      : null;
    const hold = inputs.reduce((max, pin) => Math.max(max, holdOf(pin)), 0);
    const setupArcs = inputs.flatMap((pin) => constraintArcs(pin, "setup", templates));
    const holdArcs = inputs.flatMap((pin) => constraintArcs(pin, "hold", templates));
    const seqPins = flopPins(seq, output);
    const clearName = seqPins?.clear;
    const presetName = seqPins?.preset;
    const clearCap = clearName ? pinCap(pins, clearName) : undefined;
    const presetCap = presetName ? pinCap(pins, presetName) : undefined;
    return {
      flop: {
        name,
        family,
        drive,
        area,
        clkToQ: qTable ? tableDelay(qTable, qTable.loads[0] ?? 0) : output ? edgeDelay(output) : 1,
        setup: inputs.reduce((max, pin) => Math.max(max, setupOf(pin)), 0) || 1,
        ...(qTable ? { qTable } : {}),
        ...(edges?.slew ? { qSlew: edges.slew } : {}),
        ...(maxCap !== null ? { maxCap } : {}),
        ...(maxFanout !== null ? { maxFanout } : {}),
        ...(maxTran !== null ? { maxTran } : {}),
        ...(clockCap !== null && clockCap > 0 ? { clockCap } : {}),
        ...(clearCap !== undefined ? { clearCap } : {}),
        ...(presetCap !== undefined ? { presetCap } : {}),
        ...(hold > 0 ? { hold } : {}),
        ...(setupArcs.length > 0 ? { setupArcs } : {}),
        ...(holdArcs.length > 0 ? { holdArcs } : {}),
        ...(seqPins ? { seq: seqPins } : {}),
      },
    };
  }
  const output = outputs.find((pin) => pin.attrs.has("function"));
  const expr = output?.attrs.get("function");
  if (!output || !expr) return {};
  if (/\bIQN?\b/.test(expr)) return {};
  const pinNames = inputs.map((pin) => pin.args[0] ?? "");
  if (pinNames.some((pin) => pin.includes("["))) return {};
  const fn = compileFunction(expr, pinNames, name);
  const arcs = arcsOf(output, pinNames, name);
  const plain = arcs.filter((arc) => !arc.when);
  const tables = (plain.length > 0 ? plain : arcs).reduce<
    { delay: LoadTable; slew?: LoadTable; sense: "pos" | "neg" | "non" } | undefined
  >((best, arc) => {
    const first = Math.max(arc.table.rise[0]?.[0] ?? 0, arc.table.fall[0]?.[0] ?? 0);
    const score = best ? Math.max(best.delay.rise[0]?.[0] ?? 0, best.delay.fall[0]?.[0] ?? 0) : -1;
    return !best || first > score
      ? { delay: arc.table, sense: arc.sense, ...(arc.slew ? { slew: arc.slew } : {}) }
      : best;
  }, undefined);
  const table = tables?.delay;
  const delay = table ? tableDelay(table, table.loads[0] ?? 0) : (comboDelay(output) ?? 1);
  const maxCap = numberAttr(output.attrs.get("max_capacitance"));
  const maxFanout = numberAttr(output.attrs.get("max_fanout"));
  const maxTran = transitionOf(output, inputs) ?? characterized(table ?? tables?.slew);
  let bits = "";
  for (let mask = 0; mask < 1 << pinNames.length; mask += 1) bits += fn(mask);
  return {
    cell: {
      name,
      family: `f${pinNames.length}:${bits}`,
      drive,
      area,
      delay,
      cap: cap || drive,
      inputs: pinNames,
      fn,
      ...(table ? { table } : {}),
      ...(tables?.slew ? { slew: tables.slew } : {}),
      ...(tables ? { sense: tables.sense } : {}),
      ...(arcs.length > 0 ? { arcs } : {}),
      ...(maxCap !== null ? { maxCap } : {}),
      ...(maxFanout !== null ? { maxFanout } : {}),
      ...(maxTran !== null ? { maxTran } : {}),
      output: output.args[0] ?? "Y",
    },
  };
}

function pinLevel(expr: string | undefined): { name: string; level: 0 | 1 } | null {
  if (!expr) return null;
  const name = expr.replace(/[()!\s"]/g, "");
  if (name === "" || name === "0" || name === "1") return null;
  return { name, level: expr.includes("!") ? 0 : 1 };
}

function flopPins(seq: Group, output: Group | undefined): FlopPins | null {
  const q = output?.args[0] ?? seq.args[0];
  if (!q) return null;
  if (seq.kind === "latch") {
    const data = pinLevel(seq.attrs.get("data_in"));
    const en = pinLevel(seq.attrs.get("enable"));
    if (!data || !en) return null;
    return { q, d: data.name, en: en.name, enLevel: en.level };
  }
  const data = pinLevel(seq.attrs.get("next_state"));
  if (!data) return null;
  const clock = pinLevel(seq.attrs.get("clocked_on"));
  const clear = pinLevel(seq.attrs.get("clear"));
  const preset = pinLevel(seq.attrs.get("preset"));
  return {
    q,
    d: data.name,
    ...(clock ? { clk: clock.name } : {}),
    ...(clear ? { clear: clear.name, clearLevel: clear.level } : {}),
    ...(preset ? { preset: preset.name, presetLevel: preset.level } : {}),
  };
}

function mergePins(cell: Group): Map<string, Group> {
  const pins = new Map<string, Group>();
  for (const pin of cell.groups) {
    if (pin.kind !== "pin") continue;
    const name = pin.args[0] ?? "";
    const existing = pins.get(name);
    if (!existing) {
      pins.set(name, pin);
      continue;
    }
    for (const [key, value] of pin.attrs)
      if (!existing.attrs.has(key)) existing.attrs.set(key, value);
    existing.groups.push(...pin.groups);
  }
  return pins;
}

function strength(name: string, attr: string | undefined, fallback: number): number {
  const given = numberAttr(attr);
  if (given !== null && given > 0) return given;
  const suffix = /(?:^|_)X([0-9]+)$/.exec(name) ?? /_([0-9]+)$/.exec(name);
  if (suffix?.[1]) return Number(suffix[1]);
  return fallback > 0 ? fallback : 1;
}

function pinCap(pins: Map<string, Group>, name: string): number | undefined {
  const pin = pins.get(name);
  const value = pin
    ? numberAttr(pin.attrs.get("capacitance") ?? pin.attrs.get("rise_capacitance"))
    : null;
  return value !== null && value > 0 ? value : undefined;
}

function numberAttr(value: string | undefined): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberIn(text: string): number | null {
  const match = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text);
  return match ? Number(match[0]) : null;
}

function firstTable(group: Group): number | null {
  const direct = group.attrs.get("values");
  if (direct) {
    const number = numberIn(direct);
    if (number !== null) return number;
  }
  const values = group.groups.find((child) => child.kind === "values");
  if (!values) return null;
  for (const arg of values.args) {
    const number = numberIn(arg);
    if (number !== null) return number;
  }
  return null;
}

function arcDelay(timing: Group): number | null {
  let best: number | null = null;
  for (const key of ["intrinsic_rise", "intrinsic_fall"]) {
    const number = numberAttr(timing.attrs.get(key));
    if (number !== null) best = best === null ? number : Math.max(best, number);
  }
  if (best !== null) return best;
  for (const child of timing.groups) {
    if (
      child.kind !== "cell_rise" &&
      child.kind !== "cell_fall" &&
      child.kind !== "rise_constraint" &&
      child.kind !== "fall_constraint"
    ) {
      continue;
    }
    const number = firstTable(child);
    if (number !== null) best = best === null ? number : Math.max(best, number);
  }
  return best;
}

function rowOf(group: Group): { slews: number[]; loads: number[]; rows: number[][] } | null {
  const loads = axisOf(group, "index_2");
  const values = group.groups.find((child) => child.kind === "values");
  if (!values || loads.length === 0) return null;
  const rows = values.args
    .map((arg) => numbers(arg).slice(0, loads.length))
    .filter((row) => row.length > 0);
  if (rows.length === 0) return null;
  return { slews: axisOf(group, "index_1"), loads, rows };
}

function axisOf(group: Group, kind: string): number[] {
  const index = group.groups.find((child) => child.kind === kind);
  if (!index) return [];
  return numbers(`${index.args.join(" ")} ${index.attrs.get("values") ?? ""}`);
}

function asTable(
  rise: ReturnType<typeof rowOf>,
  fall: ReturnType<typeof rowOf>,
): LoadTable | undefined {
  const basis = rise ?? fall;
  if (!basis) return undefined;
  return { slews: basis.slews, loads: basis.loads, rise: rise?.rows ?? [], fall: fall?.rows ?? [] };
}

function tablesOf(
  timing: Group,
  delayKinds: [string, string],
  slewKinds: [string, string],
): { delay?: LoadTable; slew?: LoadTable } {
  let rise: ReturnType<typeof rowOf> = null;
  let fall: ReturnType<typeof rowOf> = null;
  let riseSlew: ReturnType<typeof rowOf> = null;
  let fallSlew: ReturnType<typeof rowOf> = null;
  for (const child of timing.groups) {
    const row = rowOf(child);
    if (!row) continue;
    if (child.kind === delayKinds[0]) rise = row;
    if (child.kind === delayKinds[1]) fall = row;
    if (child.kind === slewKinds[0]) riseSlew = row;
    if (child.kind === slewKinds[1]) fallSlew = row;
  }
  const delay = asTable(rise, fall);
  const slew = asTable(riseSlew, fallSlew);
  return { ...(delay ? { delay } : {}), ...(slew ? { slew } : {}) };
}

function arcsOf(pin: Group, inputs: string[], cell: string): TimingArc[] {
  const arcs: TimingArc[] = [];
  for (const timing of pin.groups) {
    if (timing.kind !== "timing") continue;
    const type = timing.attrs.get("timing_type") ?? "";
    if (/setup|hold|removal|recovery|edge|pulse/.test(type)) continue;
    const found = tablesOf(
      timing,
      ["cell_rise", "cell_fall"],
      ["rise_transition", "fall_transition"],
    );
    const delay = found.delay ?? intrinsicTable(timing);
    if (!delay) continue;
    const when = timing.attrs.has("when")
      ? satisfiable(timing.attrs.get("when") ?? "1", inputs, cell)
      : undefined;
    const related = (timing.attrs.get("related_pin") ?? "")
      .split(/\s+/)
      .filter((name) => name.length > 0);
    for (const name of related.length > 0 ? related : [""]) {
      arcs.push({
        pin: name,
        sense: senseOf(timing.attrs.get("timing_sense")),
        table: delay,
        ...(found.slew ? { slew: found.slew } : {}),
        ...(when ? { when } : {}),
      });
    }
  }
  return arcs;
}

function intrinsicTable(timing: Group): LoadTable | undefined {
  const rise = numberAttr(timing.attrs.get("intrinsic_rise"));
  const fall = numberAttr(timing.attrs.get("intrinsic_fall"));
  if (rise === null && fall === null) return undefined;
  const riseValue = rise ?? fall ?? 0;
  const fallValue = fall ?? rise ?? 0;
  return { slews: [0], loads: [0], rise: [[riseValue]], fall: [[fallValue]] };
}

function satisfiable(
  source: string,
  pins: string[],
  cell: string,
): (known: ReadonlyMap<string, 0 | 1 | undefined>) => boolean {
  const fn = compileFunction(source, pins, cell);
  return (known) => {
    const free: number[] = [];
    let base = 0;
    pins.forEach((pin, index) => {
      const value = known.get(pin);
      if (value === undefined) free.push(index);
      else if (value === 1) base |= 1 << index;
    });
    if (free.length > 8) return true;
    const space = 1 << free.length;
    for (let n = 0; n < space; n += 1) {
      let mask = base;
      for (let bit = 0; bit < free.length; bit += 1) {
        if ((n >> bit) & 1) mask |= 1 << (free[bit] ?? 0);
      }
      if (fn(mask) === 1) return true;
    }
    return false;
  };
}

function edgeTable(pin: Group): { delay: LoadTable; slew?: LoadTable } | undefined {
  let best: { delay: LoadTable; slew?: LoadTable } | undefined;
  let score = -1;
  for (const timing of pin.groups) {
    if (timing.kind !== "timing" || timing.attrs.has("when")) continue;
    if (!/edge/.test(timing.attrs.get("timing_type") ?? "")) continue;
    const found = tablesOf(
      timing,
      ["cell_rise", "cell_fall"],
      ["rise_transition", "fall_transition"],
    );
    if (!found.delay) continue;
    const first = Math.max(found.delay.rise[0]?.[0] ?? 0, found.delay.fall[0]?.[0] ?? 0);
    if (!best || first > score) {
      best = { delay: found.delay, ...(found.slew ? { slew: found.slew } : {}) };
      score = first;
    }
  }
  return best;
}

function senseOf(value: string | undefined): "pos" | "neg" | "non" {
  if (value?.includes("negative")) return "neg";
  if (value?.includes("positive")) return "pos";
  return "non";
}

function numbers(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)].map((match) => Number(match[0]));
}

function comboDelay(pin: Group): number | null {
  let best: number | null = null;
  for (const timing of pin.groups) {
    if (timing.kind !== "timing") continue;
    const type = timing.attrs.get("timing_type") ?? "";
    if (/setup|hold|removal|recovery|edge|pulse/.test(type)) continue;
    const delay = arcDelay(timing);
    if (delay !== null) best = best === null ? delay : Math.max(best, delay);
  }
  return best;
}

function edgeDelay(pin: Group): number {
  let best = 0;
  for (const timing of pin.groups) {
    if (timing.kind !== "timing") continue;
    if (!/edge/.test(timing.attrs.get("timing_type") ?? "")) continue;
    const delay = arcDelay(timing);
    if (delay !== null) best = Math.max(best, delay);
  }
  return best || 1;
}

function holdOf(pin: Group): number {
  let best = 0;
  for (const timing of pin.groups) {
    if (timing.kind !== "timing") continue;
    if (!/hold/.test(timing.attrs.get("timing_type") ?? "")) continue;
    const delay = arcDelay(timing);
    if (delay !== null) best = Math.max(best, delay);
  }
  return best;
}

function clockPin(pins: Map<string, Group>, seq: Group): Group | undefined {
  const named = (seq.attrs.get("clocked_on") ?? "").replace(/[()!\s"]/g, "");
  return [...pins.values()].find(
    (pin) => pin.attrs.get("clock") === "true" || (named !== "" && pin.args[0] === named),
  );
}

function transitionOf(output: Group | undefined, inputs: Group[]): number | null {
  let best: number | null = null;
  for (const pin of [output, ...inputs]) {
    if (!pin) continue;
    const value = numberAttr(pin.attrs.get("max_transition"));
    if (value === null) continue;
    best = best === null ? value : Math.min(best, value);
  }
  return best;
}

function characterized(table: LoadTable | undefined): number | null {
  const last = table?.slews[table.slews.length - 1];
  return last !== undefined && last > 0 ? last : null;
}

function readWire(group: Group): WireLoad {
  const fanouts = group.groups
    .filter((child) => child.kind === "fanout_length")
    .map((child) => ({ fanout: Number(child.args[0] ?? 0), length: Number(child.args[1] ?? 0) }))
    .filter((row) => Number.isFinite(row.fanout) && Number.isFinite(row.length));
  return {
    name: group.args[0] ?? "wire",
    capacitance: numberAttr(group.attrs.get("capacitance")) ?? 0,
    resistance: numberAttr(group.attrs.get("resistance")) ?? 0,
    slope: numberAttr(group.attrs.get("slope")) ?? 0,
    fanouts,
  };
}

function setupOf(pin: Group): number {
  let best = 0;
  for (const timing of pin.groups) {
    if (timing.kind !== "timing") continue;
    if (!/setup/.test(timing.attrs.get("timing_type") ?? "")) continue;
    const delay = arcDelay(timing);
    if (delay !== null) best = Math.max(best, delay);
  }
  return best;
}

/** True when the template's first axis is the constrained pin, so the table is stored swapped. */
function constraintAxes(library: Group): Map<string, boolean> {
  const axes = new Map<string, boolean>();
  for (const group of library.groups) {
    if (group.kind !== "lu_table_template") continue;
    const name = group.args[0] ?? "";
    if (!name) continue;
    const first = group.attrs.get("variable_1") ?? "";
    axes.set(name, first.includes("constrained"));
  }
  return axes;
}

function constraintArcs(
  pin: Group,
  kind: "setup" | "hold",
  templates: Map<string, boolean>,
): LoadTable[] {
  const found: LoadTable[] = [];
  for (const timing of pin.groups) {
    if (timing.kind !== "timing") continue;
    const type = timing.attrs.get("timing_type") ?? "";
    if (kind === "setup" ? !/setup/.test(type) : !/hold/.test(type)) continue;
    const table = constraintTable(timing, templates);
    if (table) found.push(table);
  }
  return found;
}

function constraintTable(timing: Group, templates: Map<string, boolean>): LoadTable | undefined {
  let rise: ReturnType<typeof rowOf> = null;
  let fall: ReturnType<typeof rowOf> = null;
  let template = "";
  for (const child of timing.groups) {
    if (child.kind !== "rise_constraint" && child.kind !== "fall_constraint") continue;
    const row = rowOf(child);
    if (!row) continue;
    if (!template) template = child.args[0] ?? "";
    if (child.kind === "rise_constraint") rise = row;
    else fall = row;
  }
  const table = asTable(rise, fall);
  if (!table) return undefined;
  return templates.get(template) ? transpose(table) : table;
}

function transpose(table: LoadTable): LoadTable {
  const flip = (grid: number[][]): number[][] => {
    if (grid.length === 0) return [];
    return table.loads.map((_, col) => grid.map((row) => row[col] ?? 0));
  };
  return {
    slews: [...table.loads],
    loads: [...table.slews],
    rise: flip(table.rise),
    fall: flip(table.fall),
  };
}

interface Expr {
  kind: "pin" | "const" | "not" | "and" | "or" | "xor";
  pin?: string;
  value?: 0 | 1;
  left?: Expr;
  right?: Expr;
  term?: Expr;
}

function compileFunction(source: string, pins: string[], cell: string): (mask: number) => 0 | 1 {
  const tokens = tokenize(source).filter((token) => token.kind !== "sym" || token.value !== ";");
  let cursor = 0;
  const peek = () => tokens[cursor];
  const pull = () => {
    const token = tokens[cursor];
    if (!token) throw new LibertyError(`${cell}: function ended early`);
    cursor += 1;
    return token;
  };

  function parseOr(): Expr {
    let left = parseXor();
    while (peek()?.value === "+" || peek()?.value === "|") {
      pull();
      left = { kind: "or", left, right: parseXor() };
    }
    return left;
  }
  function parseXor(): Expr {
    let left = parseAnd();
    while (peek()?.value === "^") {
      pull();
      left = { kind: "xor", left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd(): Expr {
    let left = parseUnary();
    while (peek()?.value === "*" || peek()?.value === "&") {
      pull();
      left = { kind: "and", left, right: parseUnary() };
    }
    return left;
  }
  function parseUnary(): Expr {
    if (peek()?.value === "!") {
      pull();
      return { kind: "not", term: parseUnary() };
    }
    let term = parsePrimary();
    while (peek()?.value === "'") {
      pull();
      term = { kind: "not", term };
    }
    return term;
  }
  function parsePrimary(): Expr {
    const token = pull();
    if (token.value === "(") {
      const inner = parseOr();
      if (pull().value !== ")") throw new LibertyError(`${cell}: function is missing )`);
      return inner;
    }
    if (token.value === "0" || token.value === "1")
      return { kind: "const", value: token.value === "1" ? 1 : 0 };
    if (token.kind === "id" || token.kind === "str") {
      if (!pins.includes(token.value))
        throw new LibertyError(`${cell}: function pin ${token.value} is not an input`);
      return { kind: "pin", pin: token.value };
    }
    throw new LibertyError(`${cell}: bad function token ${token.value}`);
  }

  const expr = parseOr();
  if (cursor < tokens.length) throw new LibertyError(`${cell}: extra token in function`);
  const index = new Map(pins.map((pin, place) => [pin, place]));
  const evalExpr = (node: Expr, mask: number): 0 | 1 => {
    if (node.kind === "const") return node.value ?? 0;
    if (node.kind === "pin") return ((mask >> (index.get(node.pin ?? "") ?? 0)) & 1) === 1 ? 1 : 0;
    if (node.kind === "not") return evalExpr(node.term as Expr, mask) === 1 ? 0 : 1;
    const left = evalExpr(node.left as Expr, mask);
    const right = evalExpr(node.right as Expr, mask);
    if (node.kind === "and") return left && right ? 1 : 0;
    if (node.kind === "or") return left || right ? 1 : 0;
    return left ^ right ? 1 : 0;
  };
  return (mask) => evalExpr(expr, mask);
}

function tokenize(source: string): Token[] {
  const text = source.replace(/\\\r?\n/g, "");
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }
    if ("{}():;,*+^&|!'".includes(char)) {
      tokens.push({ kind: "sym", value: char, line });
      index += 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      let value = "";
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\n") line += 1;
        if (text[index] === "\\" && text[index + 1] === '"') {
          value += '"';
          index += 2;
          continue;
        }
        value += text[index] ?? "";
        index += 1;
      }
      index += 1;
      tokens.push({ kind: "str", value, line });
      continue;
    }
    if (/[0-9]/.test(char) || (char === "-" && /[0-9]/.test(text[index + 1] ?? ""))) {
      const start = index;
      index += 1;
      while (index < text.length && /[0-9.eE+-]/.test(text[index] ?? "")) index += 1;
      tokens.push({ kind: "num", value: text.slice(start, index), line });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index] ?? "")) index += 1;
      tokens.push({ kind: "id", value: text.slice(start, index), line });
      continue;
    }
    throw new LibertyError(`line ${line}: unexpected ${char}`);
  }
  return tokens;
}
