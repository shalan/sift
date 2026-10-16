import type { DrivingCell } from "./map.ts";
import type { Constraints, FalseEnd, FalsePath, MultiCycle, PortConstraint } from "./seq.ts";

export class SdcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SdcError";
  }
}

interface Command {
  line: number;
  name: string;
  flags: Map<string, string | true>;
  args: string[];
  kind: string;
  names: string[];
}

const TAKES: Record<string, true> = {
  name: true,
  period: true,
  clock: true,
  waveform: true,
  lib_cell: true,
  pin: true,
  from_pin: true,
  library: true,
  input_transition_rise: true,
  input_transition_fall: true,
};
const OBJECT: Record<string, true> = { from: true, to: true };
const KNOWN = new Set([
  "create_clock",
  "set_input_delay",
  "set_output_delay",
  "set_input_transition",
  "set_load",
  "set_max_fanout",
  "set_max_transition",
  "set_max_capacitance",
  "set_clock_transition",
  "set_wire_load_model",
  "set_false_path",
  "set_multicycle_path",
  "set_driving_cell",
  "set_clock_uncertainty",
]);

export function parseSdc(
  text: string,
  ports: { inputs: string[]; outputs: string[] },
): Constraints {
  const constraints: Constraints = { period: 10, ports: {} };
  let clock = "";
  for (const command of commands(text)) {
    if (!KNOWN.has(command.name))
      throw new SdcError(`line ${command.line}: '${command.name}' is not in the SDC subset`);
    if (command.name === "create_clock") {
      const period = requiredNumber(command, "period");
      if (period <= 0) throw new SdcError(`line ${command.line}: clock period must be positive`);
      constraints.period = period;
      clock =
        typeof command.flags.get("name") === "string" ? String(command.flags.get("name")) : "clk";
      continue;
    }
    if (command.name === "set_clock_transition") {
      const value = positional(command);
      if (
        clock &&
        command.names.length > 0 &&
        command.names.some((name) => name !== clock && name !== "*")
      ) {
        throw new SdcError(
          `line ${command.line}: unknown clock '${command.names.find((name) => name !== clock) ?? ""}'`,
        );
      }
      constraints.clockTransition = value;
      continue;
    }
    if (command.name === "set_clock_uncertainty") {
      applyUncertainty(constraints, command, clock);
      continue;
    }
    if (command.name === "set_max_fanout") {
      constraints.maxFanout = positional(command);
      continue;
    }
    if (command.name === "set_max_transition") {
      constraints.maxTransition = positional(command);
      continue;
    }
    if (command.name === "set_max_capacitance") {
      constraints.maxCapacitance = positional(command);
      continue;
    }
    if (command.name === "set_wire_load_model") {
      const name = command.flags.get("name");
      if (typeof name !== "string" || name === "")
        throw new SdcError(`line ${command.line}: set_wire_load_model needs -name`);
      constraints.wireLoad = name;
      continue;
    }
    if (command.name === "set_false_path") {
      constraints.falsePaths = [...(constraints.falsePaths ?? []), falsePath(command)];
      continue;
    }
    if (command.name === "set_multicycle_path") {
      constraints.multiCycles = [...(constraints.multiCycles ?? []), multiCycle(command)];
      continue;
    }
    if (command.name === "set_driving_cell") {
      applyDrive(constraints, command, ports);
      continue;
    }
    const value = positional(command);
    const targets = expand(command, ports);
    const everywhere =
      command.kind === "design" ||
      command.names.length === 0 ||
      command.kind === "inputs" ||
      command.kind === "outputs";
    if (command.name === "set_input_delay") {
      if (everywhere && command.kind !== "outputs") constraints.inputDelay = value;
      else setPorts(constraints, targets.inputs, "delay", value);
    }
    if (command.name === "set_output_delay") {
      if (everywhere && command.kind !== "inputs") constraints.outputDelay = value;
      else setPorts(constraints, targets.outputs, "delay", value);
    }
    if (command.name === "set_input_transition") {
      if (everywhere && command.kind !== "outputs") {
        constraints.inputTransition = value;
        constraints.drivingCell = undefined;
        clearDrive(constraints, ports.inputs);
      } else {
        setPorts(constraints, targets.inputs, "slew", value);
        clearDrive(constraints, targets.inputs);
      }
    }
    if (command.name === "set_load") {
      if (everywhere && command.kind !== "inputs") constraints.outputLoad = value;
      else setPorts(constraints, targets.outputs, "load", value);
    }
  }
  return constraints;
}

function setPorts(
  constraints: Constraints,
  names: string[],
  key: keyof PortConstraint,
  value: number,
): void {
  const ports = constraints.ports ?? {};
  for (const name of names) ports[name] = { ...ports[name], [key]: value };
  constraints.ports = ports;
}

function expand(
  command: Command,
  ports: { inputs: string[]; outputs: string[] },
): { inputs: string[]; outputs: string[] } {
  if (command.kind === "design" || command.kind === "inputs")
    return { inputs: ports.inputs, outputs: [] };
  if (command.kind === "outputs") return { inputs: [], outputs: ports.outputs };
  const inputs: string[] = [];
  const outputs: string[] = [];
  for (const name of command.names) {
    const found = match(name, [...ports.inputs, ...ports.outputs]);
    if (found.length === 0) throw new SdcError(`line ${command.line}: unknown port '${name}'`);
    for (const port of found) {
      if (ports.inputs.includes(port)) inputs.push(port);
      if (ports.outputs.includes(port)) outputs.push(port);
    }
  }
  return { inputs, outputs };
}

function match(name: string, ports: string[]): string[] {
  const star = name.endsWith("*") ? name.slice(0, -1) : name;
  if (name === "*") return ports;
  const exact = ports.filter((port) => port === name);
  if (exact.length > 0) return exact;
  return ports.filter(
    (port) =>
      port === star ||
      new RegExp(`^${star.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_\\d+$`).test(port),
  );
}

function applyDrive(
  constraints: Constraints,
  command: Command,
  ports: { inputs: string[]; outputs: string[] },
): void {
  const allowed = new Set([
    "lib_cell",
    "pin",
    "from_pin",
    "library",
    "input_transition_rise",
    "input_transition_fall",
    "min",
    "max",
  ]);
  for (const flag of command.flags.keys()) {
    if (!allowed.has(flag))
      throw new SdcError(`line ${command.line}: -${flag} is not in the SDC subset`);
  }
  const cell = command.flags.get("lib_cell");
  if (typeof cell !== "string" || cell === "")
    throw new SdcError(`line ${command.line}: set_driving_cell needs -lib_cell`);
  const pin = command.flags.get("pin");
  const fromPin = command.flags.get("from_pin");
  const rise = optionalNumber(command, "input_transition_rise");
  const fall = optionalNumber(command, "input_transition_fall");
  const spec: DrivingCell = {
    cell,
    ...(typeof pin === "string" ? { pin } : {}),
    ...(typeof fromPin === "string" ? { fromPin } : {}),
    ...(rise !== undefined ? { rise } : {}),
    ...(fall !== undefined ? { fall } : {}),
  };
  if (command.kind === "outputs")
    throw new SdcError(`line ${command.line}: set_driving_cell applies to input ports`);
  const targets = expand(command, ports);
  if (targets.outputs.length > 0)
    throw new SdcError(`line ${command.line}: set_driving_cell applies to input ports`);
  const everywhere =
    command.kind === "inputs" || command.kind === "design" || command.names.length === 0;
  if (everywhere) {
    constraints.drivingCell = spec;
    clearDrive(constraints, ports.inputs);
    return;
  }
  const record = constraints.ports ?? {};
  for (const name of targets.inputs) {
    const prev = record[name] ?? {};
    record[name] = { ...prev, drive: spec };
    delete record[name].slew;
  }
  constraints.ports = record;
}

function optionalNumber(command: Command, flag: string): number | undefined {
  const raw = command.flags.get(flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (typeof raw !== "string" || !Number.isFinite(value) || value < 0) {
    throw new SdcError(`line ${command.line}: -${flag} needs a non-negative number`);
  }
  return value;
}

function clearDrive(constraints: Constraints, names: string[]): void {
  if (!constraints.ports) return;
  for (const name of names) {
    const spec = constraints.ports[name];
    if (!spec?.drive) continue;
    delete spec.drive;
  }
}

function falsePath(command: Command): FalsePath {
  for (const flag of command.flags.keys()) {
    if (flag !== "setup" && flag !== "hold" && flag !== "from" && flag !== "to") {
      throw new SdcError(`line ${command.line}: -${flag} is not in the SDC subset`);
    }
  }
  const from = command.flags.get("from");
  const to = command.flags.get("to");
  if (typeof from !== "string" && typeof to !== "string")
    throw new SdcError(`line ${command.line}: set_false_path needs -from or -to`);
  const setup = command.flags.has("setup") || !command.flags.has("hold");
  const hold = command.flags.has("hold") || !command.flags.has("setup");
  return {
    from: typeof from === "string" ? falseEnd(from, command.line) : null,
    to: typeof to === "string" ? falseEnd(to, command.line) : null,
    setup,
    hold,
  };
}

function multiCycle(command: Command): MultiCycle {
  for (const flag of command.flags.keys()) {
    if (flag !== "setup" && flag !== "hold" && flag !== "from" && flag !== "to") {
      throw new SdcError(`line ${command.line}: -${flag} is not in the SDC subset`);
    }
  }
  if (command.flags.has("setup") && command.flags.has("hold")) {
    throw new SdcError(`line ${command.line}: set setup and hold in two commands`);
  }
  const raw = command.args.find((arg) => arg !== "");
  if (raw === undefined)
    throw new SdcError(`line ${command.line}: set_multicycle_path needs a number`);
  const value = Number(raw);
  const hold = command.flags.has("hold");
  if (!Number.isInteger(value) || (hold ? value < 0 : value < 1)) {
    throw new SdcError(
      `line ${command.line}: ${hold ? "hold multicycle must be an integer of at least 0" : "setup multicycle must be an integer of at least 1"}`,
    );
  }
  const from = command.flags.get("from");
  const to = command.flags.get("to");
  return {
    from: typeof from === "string" ? falseEnd(from, command.line) : null,
    to: typeof to === "string" ? falseEnd(to, command.line) : null,
    setup: hold ? null : value,
    hold: hold ? value : null,
  };
}

function falseEnd(token: string, line: number): FalseEnd {
  const text = token.trim();
  if (!text.startsWith("[")) return { kind: "pins", names: splitNames(text) };
  const inner = text.slice(1, -1).trim();
  if (inner === "all_inputs") return { kind: "inputs", names: [] };
  if (inner === "all_outputs") return { kind: "outputs", names: [] };
  if (inner === "all_registers") return { kind: "registers", names: [] };
  const head = inner.split(/\s+/)[0] ?? "";
  if (head === "get_ports") return namedEnd("ports", inner.slice(head.length), line);
  if (head === "get_pins") return namedEnd("pins", inner.slice(head.length), line);
  throw new SdcError(`line ${line}: '${head || inner}' is not a false-path object`);
}

function namedEnd(kind: "ports" | "pins", rest: string, line: number): FalseEnd {
  const names = splitNames(rest);
  if (names.length === 0) throw new SdcError(`line ${line}: false path needs a pin`);
  return { kind, names };
}

function applyUncertainty(constraints: Constraints, command: Command, clock: string): void {
  for (const flag of command.flags.keys()) {
    if (flag !== "setup" && flag !== "hold")
      throw new SdcError(`line ${command.line}: -${flag} is not in the SDC subset`);
  }
  if (
    command.kind === "inputs" ||
    command.kind === "outputs" ||
    (command.kind === "ports" && command.names.length > 0)
  ) {
    throw new SdcError(`line ${command.line}: set_clock_uncertainty applies to a clock`);
  }
  if (command.kind === "clocks") {
    if (command.names.length === 0)
      throw new SdcError(`line ${command.line}: set_clock_uncertainty needs a clock`);
    const other = command.names.find((name) => name !== clock && name !== "*");
    if (clock && other) throw new SdcError(`line ${command.line}: unknown clock '${other}'`);
  }
  const setup = command.flags.get("setup");
  const hold = command.flags.get("hold");
  if (setup === undefined && hold === undefined) {
    const value = positional(command);
    constraints.setupUncertainty = value;
    constraints.holdUncertainty = value;
    return;
  }
  if (typeof setup === "string") constraints.setupUncertainty = flagNumber(command, "setup");
  if (typeof hold === "string") constraints.holdUncertainty = flagNumber(command, "hold");
}

function flagNumber(command: Command, flag: string): number {
  const raw = command.flags.get(flag);
  const value = Number(raw);
  if (typeof raw !== "string" || !Number.isFinite(value) || value < 0) {
    throw new SdcError(`line ${command.line}: -${flag} needs a non-negative number`);
  }
  return value;
}

function positional(command: Command): number {
  const raw = command.args.find((arg) => arg !== "");
  if (raw === undefined) throw new SdcError(`line ${command.line}: ${command.name} needs a number`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new SdcError(`line ${command.line}: ${command.name} needs a non-negative number`);
  return value;
}

function requiredNumber(command: Command, flag: string): number {
  const raw = command.flags.get(flag);
  const value = Number(raw);
  if (typeof raw !== "string" || !Number.isFinite(value))
    throw new SdcError(`line ${command.line}: ${command.name} needs -${flag}`);
  return value;
}

function commands(text: string): Command[] {
  const out: Command[] = [];
  const rows = text.split(/\r?\n/);
  let pending = "";
  let start = 1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = (rows[index] ?? "").replace(/#.*/, "").trim();
    if (row.endsWith("\\")) {
      if (!pending) start = index + 1;
      pending += `${row.slice(0, -1)} `;
      continue;
    }
    const full = `${pending}${row}`.trim();
    const line = pending ? start : index + 1;
    pending = "";
    if (full) out.push(command(full, line));
  }
  return out;
}

function command(text: string, line: number): Command {
  const tokens = tokenize(text, line);
  const name = tokens[0] ?? "";
  const flags = new Map<string, string | true>();
  const args: string[] = [];
  let kind = "ports";
  let names: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.startsWith("-")) {
      const flag = token.slice(1);
      const value = tokens[index + 1];
      const takes =
        OBJECT[flag] ||
        TAKES[flag] ||
        (name === "set_clock_uncertainty" && (flag === "setup" || flag === "hold"));
      if (takes) {
        if (value === undefined || value.startsWith("-"))
          throw new SdcError(`line ${line}: -${flag} needs a value`);
        if (TAKES[flag] && value.startsWith("["))
          throw new SdcError(`line ${line}: -${flag} needs a value`);
        flags.set(flag, value);
        index += 1;
      } else flags.set(flag, true);
      continue;
    }
    if (token.startsWith("[")) {
      const inner = token.slice(1, -1).trim();
      const parsed = object(inner);
      kind = parsed.kind;
      names = parsed.names;
      continue;
    }
    if (/^-?\d/.test(token) || token.includes(".")) args.push(token);
    else names.push(...splitNames(token));
  }
  return { line, name, flags, args, kind, names };
}

function object(inner: string): { kind: string; names: string[] } {
  if (inner === "current_design") return { kind: "design", names: [] };
  if (inner === "all_inputs") return { kind: "inputs", names: [] };
  if (inner === "all_outputs") return { kind: "outputs", names: [] };
  const head = inner.split(/\s+/)[0] ?? "";
  if (head === "get_ports" || head === "get_clocks")
    return {
      kind: head === "get_clocks" ? "clocks" : "ports",
      names: splitNames(inner.slice(head.length).trim()),
    };
  return { kind: "ports", names: splitNames(inner) };
}

function splitNames(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return splitNames(trimmed.slice(1, -1));
  return trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => name.replace(/\[\*\]/g, "*"));
}

function tokenize(text: string, line: number): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index] ?? "";
    if (ch === " " || ch === "\t") {
      index += 1;
      continue;
    }
    if (ch === '"') {
      const end = text.indexOf('"', index + 1);
      if (end < 0) throw new SdcError(`line ${line}: unterminated string`);
      tokens.push(text.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      let depth = 0;
      let end = index;
      for (; end < text.length; end += 1) {
        if (text[end] === ch) depth += 1;
        if (text[end] === close) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) throw new SdcError(`line ${line}: unterminated '${ch}'`);
      tokens.push(text.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < text.length && text[end] !== " " && text[end] !== "\t") end += 1;
    tokens.push(text.slice(index, end));
    index = end;
  }
  return tokens;
}
