import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ArithMode } from "./arith.ts";
import { checkEquivalence, type LecReport } from "./lec.ts";
import { parseLiberty } from "./liberty.ts";
import { resolveLibrary, type LibrarySource } from "./library.ts";
import type { MapMode, PathStep } from "./map.ts";
import { parseNetlist, type Netlist } from "./netlist.ts";
import { parseSdc } from "./sdc.ts";
import { mapDesign, type Constraints, type DesignReport } from "./seq.ts";
import { proposalText, proposeDesign, type ProposalReport } from "./propose.ts";
import { critText, critDesign, type CritReport } from "./crit.ts";
import { looksLikeVerilog, parseSources } from "./verilog.ts";
import { optText, optimizeDesign, trialLine, type OptGoal, type OptResult } from "./opt.ts";

interface Flags {
  files: string[];
  top: string;
  lib: string;
  mode: MapMode;
  modeSet: boolean;
  arith: ArithMode;
  arithSet: boolean;
  ppa?: number;
  period?: number;
  inputDelay?: number;
  outputDelay?: number;
  inputSlew?: number;
  outputLoad?: number;
  clockSlew?: number;
  maxFanout?: number;
  maxTransition?: number;
  maxCapacitance?: number;
  wireLoad?: string;
  capPerFanout?: number;
  sdc: string;
  netlist: string;
  timing: string;
  bufferInputs: boolean;
  bufferOutputs: boolean;
  gates: boolean;
  verilog: boolean;
  json: boolean;
  lec: boolean;
  propose: boolean;
  proposeLimit: number;
  crit: boolean;
  recover: boolean;
  gate: boolean;
  opt: boolean;
  optGoal: OptGoal;
  help: boolean;
}

const HELP = `sift <file.v> [more.v ...] [options]

Read Verilog (or a gate-netlist JSON file) and map it.
Several Verilog files are one design. Macros from an earlier file apply to a later one.
The top is the module nothing instantiates. If more than one qualifies, it is the last.

  --top NAME                      top module
  --lib std|min|sky130|file.lib   cell library (default std)
  --mode area|delay|load          mapper goal (default area)
  --arith area|delay              adder and multiplier (default area)
  --ppa N                         bias from 0 (area) to 1 (delay). Slack sets each adder's weight.
                                  With no --arith, N below 0.5 starts ripple; 0.5 and above starts Brent-Kung.
  --period N                      clock period (default 10)
  --input-delay N
  --output-delay N
  --input-slew N
  --output-load N
  --clock-slew N
  --max-fanout N
  --max-transition N
  --max-capacitance N
  --wire-load NAME
  --cap-per-fanout N
  --sdc file.sdc                  create_clock, set_input_delay, set_output_delay,
                                  set_input_transition, set_load, set_max_fanout,
                                  set_max_transition, set_max_capacitance,
                                  set_clock_transition, set_wire_load_model,
                                  set_false_path -from/-to/-setup/-hold
                                  set_driving_cell -lib_cell CELL [-pin PIN]
  --netlist file.v                write the cell netlist (no assign)
  --timing file.txt               write the timing report
  --buffer-inputs                 buffer every data input
  --buffer-outputs                buffer every output
  --gates                         print the gate netlist
  --verilog                       print the mapped Verilog
  --json                          print a JSON report
  --lec                           prove the netlist against the Verilog with Yosys
  --propose [N]                   mine repeated AND cones and remap with up to N new cells (default 8)
  --crit                          propose one cell for the critical path and remap
  --recover                       trade positive setup slack for a smaller cell
  --gate                          clock-gate flops that recirculate through an enable
  --opt [area|delay]              search the knobs. area meets the period, then
                                  shrinks area. delay grows slack. A knob you set stays.
  -                               read the source from stdin

A switch overrides the same value from the SDC file. A per-port SDC constraint stays.
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function numberFlag(name: string, value: string | undefined): number {
  if (value === undefined) fail(`${name} needs a number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${name} needs a number`);
  return parsed;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    files: [],
    top: "",
    lib: "std",
    mode: "area",
    modeSet: false,
    arith: "area",
    arithSet: false,
    sdc: "",
    netlist: "",
    timing: "",
    bufferInputs: false,
    bufferOutputs: false,
    gates: false,
    verilog: false,
    json: false,
    lec: false,
    propose: false,
    proposeLimit: 8,
    crit: false,
    recover: false,
    gate: false,
    opt: false,
    optGoal: "area",
    help: false,
  };
  const take = (index: number, name: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${name} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (name === "--help" || name === "-h") flags.help = true;
    else if (name === "--gates") flags.gates = true;
    else if (name === "--verilog") flags.verilog = true;
    else if (name === "--json") flags.json = true;
    else if (name === "--lec") flags.lec = true;
    else if (name === "--propose") {
      flags.propose = true;
      const peek = inline ?? argv[index + 1];
      if (peek !== undefined && !peek.startsWith("-") && Number.isFinite(Number(peek))) {
        flags.proposeLimit = numberFlag(name, peek);
        if (inline === undefined) index += 1;
      } else if (inline !== undefined) fail("--propose needs a count");
    } else if (name === "--crit") flags.crit = true;
    else if (name === "--recover") flags.recover = true;
    else if (name === "--gate") flags.gate = true;
    else if (name === "--opt") {
      flags.opt = true;
      const peek = inline ?? argv[index + 1];
      if (peek === "area" || peek === "delay") {
        flags.optGoal = peek;
        if (inline === undefined) index += 1;
      } else if (inline !== undefined) fail("--opt must be area or delay");
    } else if (name === "--buffer-inputs") flags.bufferInputs = true;
    else if (name === "--buffer-outputs") flags.bufferOutputs = true;
    else if (name === "--lib") {
      flags.lib = inline ?? take(index, name);
      if (inline === undefined) index += 1;
    } else if (name === "--mode") {
      const value = inline ?? take(index, name);
      if (value !== "area" && value !== "delay" && value !== "load")
        fail("--mode must be area, delay, or load");
      flags.mode = value;
      flags.modeSet = true;
      if (inline === undefined) index += 1;
    } else if (name === "--arith") {
      const value = inline ?? take(index, name);
      if (value !== "area" && value !== "delay") fail("--arith must be area or delay");
      flags.arith = value;
      flags.arithSet = true;
      if (inline === undefined) index += 1;
    } else if (name === "--ppa") {
      const value = numberFlag(name, inline ?? take(index, name));
      if (value < 0 || value > 1) fail("--ppa must be from 0 (area) to 1 (delay)");
      flags.ppa = value;
      if (inline === undefined) index += 1;
    } else if (name === "--period") {
      flags.period = numberFlag(name, inline ?? take(index, name));
      if (inline === undefined) index += 1;
    } else if (name === "--input-delay") {
      flags.inputDelay = numberFlag(name, inline ?? take(index, name));
      if (inline === undefined) index += 1;
    } else if (name === "--output-delay") {
      flags.outputDelay = numberFlag(name, inline ?? take(index, name));
      if (inline === undefined) index += 1;
    } else if (name === "--input-slew") {
      flags.inputSlew = numberFlag(name, inline ?? take(index, name));
      if (inline === undefined) index += 1;
    } else if (name === "--output-load") {
      flags.outputLoad = numberFlag(name, inline ?? take(index, name));
      if (inline === undefined) index += 1;
    } else if (name === "--clock-slew") {
      flags.clockSlew = numberFlag(name, inline ?? take(index, name));
      if (inline === undefined) index += 1;
    } else if (name === "--max-fanout") {
      flags.maxFanout = numberFlag(name, inline ?? take(index, name));
      if (inline === undefined) index += 1;
    } else if (name === "--max-transition") {
      flags.maxTransition = numberFlag(name, inline ?? take(index, name));
      if (inline === undefined) index += 1;
    } else if (name === "--max-capacitance") {
      flags.maxCapacitance = numberFlag(name, inline ?? take(index, name));
      if (inline === undefined) index += 1;
    } else if (name === "--wire-load") {
      flags.wireLoad = inline ?? take(index, name);
      if (inline === undefined) index += 1;
    } else if (name === "--cap-per-fanout") {
      flags.capPerFanout = numberFlag(name, inline ?? take(index, name));
      if (inline === undefined) index += 1;
    } else if (name === "--sdc") {
      flags.sdc = inline ?? take(index, name);
      if (inline === undefined) index += 1;
    } else if (name === "--netlist") {
      flags.netlist = inline ?? take(index, name);
      if (inline === undefined) index += 1;
    } else if (name === "--timing") {
      flags.timing = inline ?? take(index, name);
      if (inline === undefined) index += 1;
    } else if (name === "--top") {
      flags.top = inline ?? take(index, name);
      if (inline === undefined) index += 1;
    } else if (arg === "-") {
      if (flags.files.length > 0) fail("stdin cannot be combined with files");
      flags.files.push("-");
    } else if (arg.startsWith("-")) fail(`unknown option ${arg}`);
    else if (flags.files.includes("-")) fail("stdin cannot be combined with files");
    else flags.files.push(arg);
  }
  return flags;
}

function readText(file: string): string {
  if (file === "-") return readFileSync(0, "utf8");
  return readFileSync(file, "utf8");
}

function sourceOf(file: string): { text: string; dir: string } {
  if (file === "-") return { text: readFileSync(0, "utf8"), dir: process.cwd() };
  return { text: readFileSync(file, "utf8"), dir: dirname(file) };
}

async function libraryOf(name: string): Promise<LibrarySource> {
  if (name === "std" || name === "min") return name;
  if (name === "sky130") return (await import("./sky130hd.ts")).sky130Hd();
  return parseLiberty(readFileSync(name, "utf8"));
}

function constraintsOf(flags: Flags, sdc: Constraints | null): Constraints {
  const constraints: Constraints = {
    period: flags.period ?? sdc?.period ?? 10,
    ports: sdc?.ports ?? {},
    ...(sdc?.falsePaths ? { falsePaths: sdc.falsePaths } : {}),
    ...(flags.bufferInputs ? { bufferInputs: true } : {}),
    ...(flags.bufferOutputs ? { bufferOutputs: true } : {}),
  };
  const inputDelay = flags.inputDelay ?? sdc?.inputDelay;
  const outputDelay = flags.outputDelay ?? sdc?.outputDelay;
  const inputSlew = flags.inputSlew ?? sdc?.inputTransition;
  const outputLoad = flags.outputLoad ?? sdc?.outputLoad;
  const clockSlew = flags.clockSlew ?? sdc?.clockTransition;
  const maxFanout = flags.maxFanout ?? sdc?.maxFanout;
  const maxTransition = flags.maxTransition ?? sdc?.maxTransition;
  const maxCapacitance = flags.maxCapacitance ?? sdc?.maxCapacitance;
  const wireLoad = flags.wireLoad ?? sdc?.wireLoad;
  const capPerFanout = flags.capPerFanout ?? sdc?.capPerFanout;
  if (inputDelay !== undefined) constraints.inputDelay = inputDelay;
  if (outputDelay !== undefined) constraints.outputDelay = outputDelay;
  if (inputSlew !== undefined) constraints.inputTransition = inputSlew;
  if (flags.inputSlew === undefined && sdc?.drivingCell) constraints.drivingCell = sdc.drivingCell;
  if (outputLoad !== undefined) constraints.outputLoad = outputLoad;
  if (clockSlew !== undefined) constraints.clockTransition = clockSlew;
  if (maxFanout !== undefined) constraints.maxFanout = maxFanout;
  if (maxTransition !== undefined) constraints.maxTransition = maxTransition;
  if (maxCapacitance !== undefined) constraints.maxCapacitance = maxCapacitance;
  if (wireLoad !== undefined) constraints.wireLoad = wireLoad;
  if (capPerFanout !== undefined) constraints.capPerFanout = capPerFanout;
  if (sdc?.setupUncertainty !== undefined) constraints.setupUncertainty = sdc.setupUncertainty;
  if (sdc?.holdUncertainty !== undefined) constraints.holdUncertainty = sdc.holdUncertainty;
  if (sdc?.multiCycles) constraints.multiCycles = sdc.multiCycles;
  if (flags.recover) constraints.recover = true;
  if (flags.gate) constraints.clockGate = true;
  if (flags.ppa !== undefined) constraints.ppa = flags.ppa;
  return constraints;
}

function uncertaintyText(value: number): string {
  return value > 0 ? `  uncertainty ${num(value)}` : "";
}

function cyclesText(check: "setup" | "hold", value: number): string {
  if (check === "setup" && value === 0.5) return "  half-cycle";
  if (check === "setup" ? value === 1 : value === 0) return "";
  return `  cycles ${num(value)}`;
}

function num(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

function gateLine(netlist: Netlist): string {
  return netlist.gates.map((gate) => `${gate.id} = ${gate.op} ${gate.ins.join(" ")}`).join("\n");
}

function pathLines(title: string, path: PathStep[]): string[] {
  if (path.length === 0) return [];
  const lines = [title];
  for (const step of path) {
    const incr = `+${num(step.incr)}`;
    lines.push(`  ${num(step.at).padStart(8)}  ${incr.padStart(8)}  ${step.label}`);
  }
  return lines;
}

function reportText(netlist: Netlist, report: DesignReport, flags: Flags): string {
  const lines = [
    `${netlist.name}  ${netlist.gates.length} gates  ${netlist.inputs.length} inputs  ${netlist.outputs.length} outputs`,
  ];
  for (const warning of netlist.warnings ?? []) lines.push(`warning: ${warning}`);
  for (const note of netlist.notes ?? []) lines.push(`note: ${note}`);
  if (flags.gates) {
    lines.push("");
    lines.push(gateLine(netlist));
  }
  lines.push("");
  lines.push(
    `${report.library} · ${report.mode} · area ${num(report.area)} · delay ${num(report.delay)} · ${report.cells.length} cells · ${report.registers} registers${flags.ppa === undefined ? "" : ` · ppa ${num(flags.ppa)}`}`,
  );
  if (report.equiv.mismatches > 0) lines.push(`${report.equiv.mismatches} vectors differ`);
  else
    lines.push(
      `outputs match  ${report.equiv.exhaustive ? "exhaustive" : "sampled"}  ${report.equiv.vectors} vectors`,
    );
  if (report.recovery) {
    lines.push(
      `recovered ${num(report.recovery.before)} -> ${num(report.recovery.after)}  slack ${num(report.recovery.slackBefore)} -> ${num(report.recovery.slackAfter)}  ${report.recovery.steps} ${report.recovery.steps === 1 ? "swap" : "swaps"}`,
    );
  }
  if (report.clockGates && report.clockGates.length === 0) lines.push("clock gate  none");
  for (const gate of report.clockGates ?? []) {
    lines.push(
      `clock gate ${gate.id}  ${gate.level === 1 ? "high" : "low"} ${gate.en}  ${gate.flops.join(" ")}  area ${num(gate.area)}  delay ${num(gate.delay)}`,
    );
  }
  if (report.cells.length > 0) lines.push(report.cells.join(" "));
  const timing = report.timing;
  if (timing && !timing.constrained) lines.push("no constrained path  clock ideal");
  else if (timing) {
    lines.push(
      `${timing.met ? "meets" : "misses"}  slack ${num(timing.slack)}  ${timing.edge}  period ${num(timing.period)}  arrival ${num(timing.arrival)} at ${timing.endpoint}  slew ${num(timing.maxSlew)}  clock ideal${uncertaintyText(timing.setupUncertainty)}${cyclesText("setup", timing.setupCycles)}`,
    );
  }
  if (timing && !timing.holdConstrained) lines.push("no hold path");
  else if (timing) {
    lines.push(
      `${timing.holdMet ? "hold met" : "hold missed"}  slack ${num(timing.holdSlack)}  hold ${num(timing.hold)} at ${timing.holdEndpoint}${uncertaintyText(timing.holdUncertainty)}${cyclesText("hold", timing.holdCycles)}`,
    );
    if (timing.wireLoad !== "none") lines.push(`wire ${timing.wireLoad}`);
    if (timing.capPerFanout > 0) lines.push(`cap / fanout ${num(timing.capPerFanout)}`);
  }
  for (const hit of report.over) {
    const parts = [`${hit.net} (${hit.cell})`];
    if (hit.maxCap !== null && hit.cap > hit.maxCap)
      parts.push(`cap ${num(hit.cap)} > ${num(hit.maxCap)}`);
    if (hit.maxFanout !== null && hit.fanout > hit.maxFanout)
      parts.push(`fanout ${num(hit.fanout)} > ${num(hit.maxFanout)}`);
    if (hit.maxTran !== null && hit.slew !== null && hit.slew > hit.maxTran)
      parts.push(`slew ${num(hit.slew)} > ${num(hit.maxTran)}`);
    lines.push(`over ${parts.join("  ")}`);
  }
  if (timing?.constrained) {
    const path = timing.edge === "rise" ? report.risePath : report.fallPath;
    const printed = pathLines(timing.edge, path);
    if (printed.length > 0) {
      lines.push("");
      lines.push(...printed);
    }
  }
  if (flags.verilog) {
    lines.push("");
    lines.push(report.verilog.trimEnd());
  }
  return lines.join("\n");
}

function timingText(report: DesignReport): string {
  const lines: string[] = [];
  const timing = report.timing;
  if (!timing) lines.push("no clock");
  else if (!timing.constrained) lines.push("no constrained path  clock ideal");
  else {
    lines.push(
      `${timing.met ? "meets" : "misses"}  slack ${num(timing.slack)}  ${timing.edge}  period ${num(timing.period)}  arrival ${num(timing.arrival)} at ${timing.endpoint}  slew ${num(timing.maxSlew)}  clock ideal${uncertaintyText(timing.setupUncertainty)}${cyclesText("setup", timing.setupCycles)}`,
    );
  }
  if (timing && !timing.holdConstrained) lines.push("no hold path");
  else if (timing) {
    lines.push(
      `${timing.holdMet ? "hold met" : "hold missed"}  slack ${num(timing.holdSlack)}  hold ${num(timing.hold)} at ${timing.holdEndpoint}${uncertaintyText(timing.holdUncertainty)}${cyclesText("hold", timing.holdCycles)}`,
    );
    if (timing.wireLoad !== "none") lines.push(`wire ${timing.wireLoad}`);
    if (timing.capPerFanout > 0) lines.push(`cap / fanout ${num(timing.capPerFanout)}`);
  }
  for (const hit of report.over) lines.push(`over ${hit.net} (${hit.cell})`);
  const rise = pathLines("rise", report.risePath);
  const fall = pathLines("fall", report.fallPath);
  if (rise.length > 0) {
    lines.push("");
    lines.push(...rise);
  }
  if (fall.length > 0) {
    lines.push("");
    lines.push(...fall);
  }
  return lines.join("\n");
}

function reportJson(
  netlist: Netlist,
  report: DesignReport,
  flags: Flags,
  lec: LecReport | null,
  proposal: ProposalReport | null,
  crit: CritReport | null,
  opt: OptResult | null,
): string {
  const timing = report.timing;
  return JSON.stringify(
    {
      name: netlist.name,
      inputs: netlist.inputs,
      outputs: netlist.outputs,
      gates: flags.gates ? netlist.gates : netlist.gates.length,
      warnings: netlist.warnings ?? [],
      notes: netlist.notes ?? [],
      library: report.library,
      mode: report.mode,
      ...(flags.ppa !== undefined ? { ppa: flags.ppa } : {}),
      area: report.area,
      delay: report.delay,
      cells: report.cells,
      registers: report.registers,
      mismatches: report.equiv.mismatches,
      timing: timing
        ? {
            met: timing.met,
            slack: timing.slack,
            edge: timing.edge,
            period: timing.period,
            arrival: timing.arrival,
            endpoint: timing.endpoint,
            constrained: timing.constrained,
            holdMet: timing.holdMet,
            holdSlack: timing.holdSlack,
            hold: timing.hold,
            holdEndpoint: timing.holdEndpoint,
            holdConstrained: timing.holdConstrained,
            setupUncertainty: timing.setupUncertainty,
            holdUncertainty: timing.holdUncertainty,
            setupCycles: timing.setupCycles,
            holdCycles: timing.holdCycles,
            wireLoad: timing.wireLoad,
            capPerFanout: timing.capPerFanout,
            maxSlew: timing.maxSlew,
          }
        : null,
      over: report.over,
      ...(lec ? { lec: { proved: lec.proved, text: lec.text } } : {}),
      ...(proposal
        ? {
            proposals: {
              examined: proposal.examined,
              shapes: proposal.shapes,
              kept: proposal.cells.map((cell) => ({
                name: cell.name,
                ands: cell.ands,
                pins: cell.pins,
                occurrences: cell.occurrences,
                coverCells: cell.coverCells,
                score: cell.score,
                area: cell.area,
                delay: cell.delay,
                expr: cell.expr,
              })),
              before: proposal.before,
              after: proposal.after,
              used: proposal.used,
              cost: proposal.cost,
            },
          }
        : {}),
      ...(crit
        ? {
            critical: {
              reason: crit.reason,
              note: crit.note,
              endpoint: crit.endpoint,
              slackBefore: crit.slackBefore,
              slackAfter: crit.slackAfter,
              delayBefore: crit.delayBefore,
              delayAfter: crit.delayAfter,
              stretch: crit.stretch,
              used: crit.used,
            },
          }
        : {}),
      ...(flags.verilog ? { verilog: report.verilog } : {}),
      ...(report.recovery ? { recovery: report.recovery } : {}),
      ...(report.clockGates ? { clockGates: report.clockGates } : {}),
      ...(opt
        ? {
            opt: {
              goal: opt.goal,
              kept: opt.kept,
              recipe: opt.recipe,
              trials: opt.trials,
            },
          }
        : {}),
    },
    null,
    2,
  );
}

export async function run(argv: string[]): Promise<number> {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags.lec && flags.gate) fail("--lec cannot prove a gated clock; drop --lec or --gate");
  if (flags.files.length === 0) {
    process.stderr.write(HELP);
    return 1;
  }
  if (flags.ppa !== undefined && !flags.arithSet) flags.arith = flags.ppa < 0.5 ? "area" : "delay";
  const parts: { text: string; dir: string }[] = [];
  let verilog = false;
  let netlist: Netlist;
  try {
    parts.push(...flags.files.map(sourceOf));
    verilog = parts.some((part) => looksLikeVerilog(part.text));
    if (parts.length > 1 && parts.some((part) => !looksLikeVerilog(part.text)))
      fail("every source file must be Verilog");
    netlist = verilog
      ? parseSources(parts, {
          mode: flags.arith,
          read: (path) => readFileSync(path, "utf8"),
          ...(flags.top ? { top: flags.top } : {}),
        })
      : parseNetlist(parts[0]?.text ?? "");
  } catch (err) {
    fail(err instanceof Error ? err.message : "synthesis failed");
  }
  let sdc: Constraints | null = null;
  if (flags.sdc) {
    try {
      sdc = parseSdc(readText(flags.sdc), netlist);
    } catch (err) {
      fail(err instanceof Error ? err.message : "SDC failed");
    }
  }
  const library = await libraryOf(flags.lib);
  let report: DesignReport;
  let proposal: ProposalReport | null = null;
  let crit: CritReport | null = null;
  let opt: OptResult | null = null;
  try {
    const constraints = constraintsOf(flags, sdc);
    if (flags.opt) {
      if (flags.crit || flags.propose)
        fail("--opt searches the knobs itself; drop --propose and --crit");
      opt = optimizeDesign({
        netlist,
        library,
        goal: flags.optGoal,
        constraints,
        pins: {
          mode: flags.modeSet,
          arith: flags.arithSet,
          ppa: flags.ppa !== undefined,
          gate: flags.gate,
          recover: flags.recover,
          maxFanout: flags.maxFanout !== undefined || sdc?.maxFanout !== undefined,
        },
        recipe: {
          mode: flags.mode,
          arith: flags.arith,
          ...(flags.ppa !== undefined ? { ppa: flags.ppa } : {}),
          gate: flags.gate,
          recover: flags.recover,
          ...(constraints.maxFanout !== undefined ? { maxFanout: constraints.maxFanout } : {}),
        },
        ...(verilog
          ? {
              elaborate: (arith) =>
                parseSources(parts, {
                  mode: arith,
                  read: (path) => readFileSync(path, "utf8"),
                  ...(flags.top ? { top: flags.top } : {}),
                }),
            }
          : {}),
        onTrial: (trial) => {
          process.stderr.write(`${trialLine(trial)}\n`);
        },
      });
      report = opt.report;
      netlist = opt.netlist;
    } else if (flags.crit) {
      crit = critDesign(netlist, library, flags.mode, constraints);
      report = crit.mapped;
    } else if (flags.propose) {
      proposal = proposeDesign(netlist, library, flags.mode, constraints, {
        limit: flags.proposeLimit,
      });
      report = proposal.mapped;
    } else report = mapDesign(netlist, library, flags.mode, constraints);
  } catch (err) {
    fail(err instanceof Error ? err.message : "mapping failed");
  }
  if (flags.lec && (flags.gate || opt?.recipe.gate)) {
    fail(
      opt?.recipe.gate && !flags.gate
        ? "--lec cannot prove a gated clock; the search kept --gate, so drop --lec"
        : "--lec cannot prove a gated clock; drop --lec or --gate",
    );
  }
  if (report.verilog.includes("assign ")) fail("mapped netlist still contains assign");
  let lec: LecReport | null = null;
  if (flags.lec) {
    if (!verilog) fail("--lec needs Verilog");
    const sources = flags.files.map((file, index) => {
      if (file !== "-") return resolve(file);
      const dir = mkdtempSync(join(tmpdir(), "sift-lec-src-"));
      const path = join(dir, "stdin.v");
      writeFileSync(path, parts[index]?.text ?? "");
      return path;
    });
    try {
      lec = checkEquivalence(
        sources,
        netlist.name,
        report.verilog,
        proposal?.library ?? resolveLibrary(library),
      );
    } catch (err) {
      fail(err instanceof Error ? err.message : "lec failed");
    }
  }
  if (flags.netlist) writeFileSync(flags.netlist, `${report.verilog.trimEnd()}\n`);
  if (flags.timing) writeFileSync(flags.timing, `${timingText(report)}\n`);
  const text = flags.json
    ? reportJson(netlist, report, flags, lec, proposal, crit, opt)
    : reportText(netlist, report, flags);
  const preface = [
    opt && !flags.json ? optText(opt) : "",
    crit && !flags.json ? critText(crit) : "",
    proposal && !flags.json ? proposalText(proposal) : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
  const body = preface ? `${preface}\n\n${text}` : text;
  process.stdout.write(`${lec && !flags.json ? `${body}\n${lec.text}` : body}\n`);
  return report.equiv.mismatches > 0 || (lec !== null && !lec.proved) ? 1 : 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : "sift failed"}\n`);
      process.exit(1);
    });
}
