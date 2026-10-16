/**
 * Delay synthesis: Sift versus Yosys+ABC, scored by OpenSTA.
 *
 * Both mappers see the same 24 Sky130 HD cells. OpenSTA times both netlists
 * with that liberty (full NLDM tables and power). Sift's own area, slack,
 * cell count, and leakage are compared with OpenSTA on the Sift netlist.
 *
 *   node --experimental-strip-types scripts/bench-delay.ts [design ...]
 *   node --experimental-strip-types scripts/bench-delay.ts --modes [design ...]
 *   node --experimental-strip-types scripts/bench-delay.ts --modes --from pic16
 *
 * The default run is `--opt area` with the mode free. `--modes` pins the mode
 * to area, then delay, then load. Each of those runs also passes `--opt area`
 * and `--recover`, and every map repairs max capacitance and max transition.
 * `--from` keeps the rows already in modes.json and starts at that design.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { VERILOG } from "../src/synth/examples.ts";
import { portCap } from "../src/synth/library.ts";
import { librarySlew } from "../src/synth/map.ts";
import { sky130Hd } from "../src/synth/sky130hd.ts";

const ROOT = process.env.SIFT_BENCH_ROOT ?? "/workspace";
const WORK = "/tmp/sift-delay-bench";
const FULL_LIB =
  process.env.SIFT_SKY130_LIB ?? "/tmp/OpenSTA/test/sky130hd/sky130_fd_sc_hd__tt_025C_1v80.lib";
const YOSYS = process.env.SIFT_YOSYS ?? "/tmp/oss/oss-cad-suite/bin/yosys";
const STA = process.env.SIFT_STA ?? "/tmp/OpenSTA/build/sta";
const PERIOD_NS = 8;
const PERIOD_PS = PERIOD_NS * 1000;
const ACTIVITY = 0.1;
const DUTY = 0.5;
const SIFT_FANOUT = 20;

const DESIGNS: { id: string; note: string; file?: string; example?: string; top?: string }[] = [
  { id: "cpu8", note: "8-bit CPU, register file, and ALU", file: "designs/cpu8.v" },
  { id: "dsp8", note: "8-bit DSP slice: product, MAC, delay line", file: "designs/dsp8.v" },
  { id: "fir10", note: "10-tap 8-bit FIR", file: "designs/fir10.v" },
  { id: "xfir", note: "dual 10-tap inner product", file: "designs/xfir.v" },
  { id: "uart", note: "UART", example: "uart.v" },
  { id: "fifo", note: "four-word FIFO", example: "fifo.v" },
  { id: "mem", note: "16×8 register file", example: "mem.v" },
  { id: "pwm", note: "PWM compare", example: "pwm.v" },
  { id: "lfsr", note: "LFSR", example: "lfsr.v" },
  { id: "gray", note: "Gray-code counter", example: "gray.v" },
  {
    id: "uart_apb",
    note: "UART-to-APB master, not the 256-bit system",
    file: "designs/uart_apb.v",
    top: "uart_apb_master",
  },
  { id: "risc8", note: "PIC16C5x-compatible CPU", file: "designs/risc8.v", top: "cpu" },
  {
    id: "pic16",
    note: "PIC16C5x, clock port renamed clk",
    file: "designs/pic16.v",
    top: "PIC16C5x",
  },
  {
    id: "pic1826",
    note: "PIC16F1826-style CPU, ROM and RAM stubbed",
    file: "designs/pic1826.v",
    top: "cpu",
  },
  {
    id: "p16c5x",
    note: "Morris P16C5x, clock port renamed clk",
    file: "designs/p16c5x.v",
    top: "P16C5x",
  },
  { id: "arlet6502", note: "Arlet 6502", file: "designs/arlet6502.v", top: "cpu" },
  {
    id: "x18",
    note: "Arlet X18, program image is the address",
    file: "designs/x18.v",
    top: "x18",
  },
  { id: "chacha", note: "memory-mapped ChaCha", file: "designs/chacha.v", top: "chacha" },
];

interface SiftJson {
  name: string;
  area: number;
  cells: string[];
  registers: number;
  mismatches: number;
  timing: {
    slack: number;
    arrival: number;
    holdSlack: number;
    maxSlew: number;
    endpoint: string;
    met: boolean;
  } | null;
  opt?: {
    goal: string;
    kept: number;
    trials: unknown[];
    recipe: {
      mode: string;
      arith: string;
      ppa?: number;
      gate: boolean;
      recover: boolean;
      maxFanout?: number;
    };
  };
}

interface Power {
  internalW: number;
  switchingW: number;
  leakageW: number;
  totalW: number;
}

interface StaNums {
  cells: number;
  area: number;
  slack: number;
  hold: number;
  arrival: number;
  slew: number;
  power: Power | null;
}

interface Row {
  id: string;
  note: string;
  top: string;
  siftS: number;
  yosysS: number;
  sift: SiftJson;
  leakN: number;
  staSift: StaNums;
  staYosys: StaNums;
  error?: string;
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function sourceOf(design: (typeof DESIGNS)[number]): string {
  if (design.file) return readFileSync(join(ROOT, design.file), "utf8");
  const found = VERILOG.find((item) => item.id === design.example);
  if (!found) die(`missing example ${design.example}`);
  return found.source;
}

function balanced(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced liberty brace");
}

function libertySubset(names: readonly string[]): { text: string; leakage: Map<string, number> } {
  const full = readFileSync(FULL_LIB, "utf8");
  const wanted = new Set(names);
  const first = full.search(/\bcell\s*\(/);
  if (first < 0) die("liberty has no cells");
  let header = full.slice(0, first);
  header = header.replace(/\s*default_wire_load\s*:[^;]*;/g, "");
  header = header.replace(/\s*default_wire_load_mode\s*:[^;]*;/g, "");
  const leakage = new Map<string, number>();
  const blocks: string[] = [];
  const cellRe = /\bcell\s*\(\s*"?([^"\s)]+)"?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = cellRe.exec(full))) {
    const name = match[1] ?? "";
    const brace = full.indexOf("{", match.index);
    if (brace < 0) continue;
    const end = balanced(full, brace);
    cellRe.lastIndex = end + 1;
    if (!wanted.has(name)) continue;
    const body = full.slice(match.index, end + 1);
    blocks.push(body);
    const leak = /cell_leakage_power\s*:\s*([0-9.eE+-]+)\s*;/.exec(body);
    if (leak?.[1]) leakage.set(name, Number(leak[1]));
    wanted.delete(name);
  }
  if (wanted.size > 0) die(`liberty is missing ${[...wanted].join(", ")}`);
  return { text: `${header}${blocks.join("\n")}\n}\n`, leakage };
}

function pinOrder(): Map<string, string[]> {
  const lib = sky130Hd();
  const order = new Map<string, string[]>();
  for (const cell of lib.cells) {
    const output = cell.output ?? "Y";
    order.set(cell.name, [output, ...cell.inputs]);
  }
  return order;
}

function namePorts(verilog: string, order: Map<string, string[]>): string {
  return verilog
    .split("\n")
    .map((line) => {
      const match = /^(\s*)(sky130_fd_sc_hd__\w+)\s+(\w+)\s*\((.*)\)\s*;\s*$/.exec(line);
      if (!match) return line;
      const [, indent, cell, inst, args] = match;
      if (!indent || !cell || !inst || args === undefined) return line;
      if (args.includes(".")) return line;
      const pins = order.get(cell);
      if (!pins) throw new Error(`no pin order for ${cell}`);
      const nets = args
        .split(",")
        .map((net) => net.trim())
        .filter((net) => net.length > 0);
      if (nets.length !== pins.length) {
        throw new Error(`${cell} ${inst}: ${nets.length} nets, pins ${pins.join(",")}`);
      }
      const named = pins.map((pin, index) => `.${pin}(${nets[index] ?? ""})`).join(", ");
      return `${indent}${cell} ${inst} (${named});`;
    })
    .join("\n");
}

function run(
  cmd: string,
  args: string[],
  out: string,
  err: string,
  limitMs: number,
  echoErr = false,
): { s: number; status: number; error: string } {
  const outFd = openSync(out, "w");
  const errFd = echoErr ? -1 : openSync(err, "w");
  const start = Date.now();
  let status = 1;
  let error = "";
  try {
    const child = spawnSync(cmd, args, {
      stdio: ["ignore", outFd, echoErr ? "inherit" : errFd],
      timeout: limitMs,
    });
    status = child.status ?? 1;
    if (child.error) {
      error = child.error.message;
      if ((child.error as NodeJS.ErrnoException).code === "ETIMEDOUT") status = 124;
    }
  } finally {
    closeSync(outFd);
    if (errFd >= 0) closeSync(errFd);
  }
  if (error) {
    if (errFd >= 0) appendFileSync(err, `\n${error}\n`);
    else process.stderr.write(`${error}\n`);
  }
  return { s: (Date.now() - start) / 1000, status, error };
}

function parsePower(log: string): Power | null {
  for (const line of log.split("\n")) {
    const match = /^\s*Total\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line);
    if (!match) continue;
    const internalW = Number(match[1]);
    const switchingW = Number(match[2]);
    const leakageW = Number(match[3]);
    const totalW = Number(match[4]);
    if ([internalW, switchingW, leakageW, totalW].every((value) => Number.isFinite(value))) {
      return { internalW, switchingW, leakageW, totalW };
    }
  }
  return null;
}

function worstArrival(log: string): number {
  let pending: number | null = null;
  let bestSlack = Infinity;
  let best = NaN;
  for (const line of log.split("\n")) {
    const arrival = /^\s*(\S+)\s+data arrival time\s*$/.exec(line);
    if (arrival) {
      const value = Number(arrival[1]);
      if (value >= 0 && pending === null) pending = value;
      continue;
    }
    const slack = /^\s*(\S+)\s+slack \((?:MET|VIOLATED)\)\s*$/.exec(line);
    if (!slack || pending === null) continue;
    const value = Number(slack[1]);
    if (value < bestSlack) {
      bestSlack = value;
      best = pending;
    }
    pending = null;
  }
  return best;
}

function parseSta(log: string): StaNums {
  const cells = Number(/^\s*RESULT cells\s+(\S+)/m.exec(log)?.[1]);
  const area = Number(/^\s*RESULT area\s+(\S+)/m.exec(log)?.[1]);
  const slack = Number(/^\s*RESULT slack\s+(\S+)/m.exec(log)?.[1]);
  const hold = Number(/^\s*RESULT hold\s+(\S+)/m.exec(log)?.[1]);
  const slew = Number(/^\s*RESULT slew\s+(\S+)/m.exec(log)?.[1]);
  return { cells, area, slack, hold, arrival: worstArrival(log), slew, power: parsePower(log) };
}

function staTcl(verilog: string, top: string, lib: string, slew: number, load: number): string {
  return `read_liberty ${lib}
read_verilog ${verilog}
link_design ${top}
create_clock -name clk -period ${PERIOD_NS} [get_ports clk]
foreach port [get_ports *] {
  set port_name [get_name $port]
  set direction [get_property $port direction]
  if {$port_name eq "clk"} continue
  if {$direction eq "input"} {
    set_input_delay -clock clk 0 $port
    set_input_transition ${slew} $port
  }
}
set_output_delay -clock clk 0 [all_outputs]
set_input_transition ${slew} [get_ports clk]
set_propagated_clock [get_clocks clk]
set_load ${load} [all_outputs]
set_power_activity -global -activity ${ACTIVITY} -duty ${DUTY}
set_power_activity -input -activity ${ACTIVITY} -duty ${DUTY}
report_power -digits 6
report_checks -path_delay max -digits 6 -fields {slew} -no_line_splits
set area 0
set count 0
foreach cell [get_cells -hierarchical *] {
  set ref [get_property $cell ref_name]
  if {[catch {set libcell [get_lib_cells */$ref]}]} continue
  if {$libcell eq ""} continue
  if {[catch {set value [get_property $libcell area]}]} continue
  if {$value eq ""} continue
  set area [expr {$area + $value}]
  incr count
}
set slew 0
foreach pin [get_pins -hierarchical *] {
  if {[catch {set value [get_property $pin slew_max]}]} continue
  if {[string is double -strict $value] && $value > $slew} { set slew $value }
}
foreach port [get_ports *] {
  foreach edge {slew_max_rise slew_max_fall} {
    if {[catch {set value [get_property $port $edge]}]} continue
    if {[string is double -strict $value] && $value > $slew} { set slew $value }
  }
}
puts "RESULT cells $count"
puts "RESULT area $area"
puts "RESULT slack [sta::worst_slack -max]"
puts "RESULT hold [sta::worst_slack -min]"
puts "RESULT slew $slew"
`;
}

function num(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs !== 0 && abs < 0.001) return value.toExponential(2);
  return value.toFixed(digits);
}

function uw(watts: number): string {
  if (!Number.isFinite(watts)) return "—";
  return num(watts * 1e6, 2);
}

function tail(path: string): string {
  try {
    return readFileSync(path, "utf8").trim().slice(-500);
  } catch {
    return "";
  }
}

function wordAt(text: string, index: number, word: string): boolean {
  if (!text.startsWith(word, index)) return false;
  const after = text[index + word.length] ?? "";
  return !/[A-Za-z0-9_]/.test(after);
}

function skipSpace(src: string, index: number): number {
  let i = index;
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

function skipStatement(src: string, index: number): number {
  let i = skipSpace(src, index);
  if (wordAt(src, i, "begin")) {
    let depth = 0;
    for (let cursor = i; cursor < src.length; cursor += 1) {
      if (wordAt(src, cursor, "begin")) {
        depth += 1;
        cursor += 4;
      } else if (wordAt(src, cursor, "end")) {
        depth -= 1;
        cursor += 2;
        if (depth === 0) return skipSpace(src, cursor + 1);
      }
    }
    return src.length;
  }
  if (wordAt(src, i, "for")) {
    const open = src.indexOf("(", i);
    let depth = 0;
    let cursor = open;
    for (; cursor < src.length; cursor += 1) {
      if (src[cursor] === "(") depth += 1;
      else if (src[cursor] === ")") {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      }
    }
    return skipStatement(src, cursor);
  }
  const semi = src.indexOf(";", i);
  return semi < 0 ? src.length : semi + 1;
}

/** Yosys rejects always_comb latches, $finish, and a non-constant $readmemh. Sift ignores all three. */
function forYosys(text: string): string {
  const src = text
    .replace(/\balways_comb\b/g, "always @*")
    .replace(/\balways_ff\b/g, "always")
    .replace(/\$finish\s*;/g, ";");
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl + 1;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") j += 1;
        j += 1;
      }
      out += src.slice(i, Math.min(src.length, j + 1));
      i = j + 1;
      continue;
    }
    const before = src[i - 1] ?? "";
    if (wordAt(src, i, "initial") && !/[A-Za-z0-9_]/.test(before)) {
      i = skipStatement(src, i + "initial".length);
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

function forSta(text: string): string {
  const src = text.replace(/ signed /g, " ");
  let out = "";
  let index = 0;
  while (index < src.length) {
    const at = src.indexOf("always", index);
    if (at < 0) {
      out += src.slice(index);
      break;
    }
    const begin = src.indexOf("begin", at);
    const semi = src.indexOf(";", at);
    if (!wordAt(src, at, "always") || begin < 0 || (semi >= 0 && semi < begin)) {
      out += src.slice(index, at + 6);
      index = at + 6;
      continue;
    }
    let depth = 0;
    let end = begin;
    for (let cursor = begin; cursor < src.length; cursor += 1) {
      if (wordAt(src, cursor, "begin")) {
        depth += 1;
        cursor += 4;
      } else if (wordAt(src, cursor, "end")) {
        depth -= 1;
        cursor += 2;
        if (depth === 0) {
          end = cursor + 1;
          break;
        }
      }
    }
    const block = src.slice(at, end);
    out += src.slice(index, at);
    if (!block.includes("$write") && !block.includes("$display")) out += block;
    index = end;
  }
  return out;
}

function emptySta(): StaNums {
  return { cells: NaN, area: NaN, slack: NaN, hold: NaN, arrival: NaN, slew: NaN, power: null };
}

function runSta(
  id: string,
  verilog: string,
  top: string,
  lib: string,
  slew: number,
  load: number,
): StaNums {
  const tcl = join(WORK, "sta", `${id}.tcl`);
  const log = join(WORK, "sta", `${id}.log`);
  writeFileSync(tcl, staTcl(verilog, top, lib, slew, load));
  const result = run(STA, ["-no_init", "-exit", tcl], log, join(WORK, "sta", `${id}.err`), 180_000);
  if (result.status !== 0) {
    process.stdout.write(`sta failed ${id} (${num(result.s, 1)}s)\n${tail(log)}\n`);
    return emptySta();
  }
  return parseSta(readFileSync(log, "utf8"));
}

function scoreYosys(
  id: string,
  top: string,
  rtlText: string,
  libPath: string,
  constr: string,
  slew: number,
  load: number,
): { yosysS: number; sta: StaNums } {
  const ysSrc = join(WORK, "src", `${id}.ys.v`);
  writeFileSync(ysSrc, forYosys(rtlText));
  const ysV = join(WORK, "ys", `${id}.v`);
  const ysLog = join(WORK, "ys", `${id}.log`);
  const yosys = run(
    YOSYS,
    [
      "-q",
      "-p",
      [
        `read_verilog -sv ${ysSrc}`,
        `synth -top ${top} -flatten`,
        `dfflibmap -liberty ${libPath}`,
        `abc -D ${PERIOD_PS} -liberty ${libPath} -constr ${constr}`,
        "clean",
        `write_verilog -noattr ${ysV}`,
      ].join("; "),
    ],
    ysLog,
    join(WORK, "ys", `${id}.err`),
    600_000,
  );
  if (yosys.status !== 0) {
    process.stdout.write(`yosys failed ${id}\n${tail(ysLog)}\n`);
    return { yosysS: yosys.s, sta: emptySta() };
  }
  const cleaned = join(WORK, "sta", `yosys_${id}.v`);
  writeFileSync(cleaned, forSta(readFileSync(ysV, "utf8")));
  return { yosysS: yosys.s, sta: runSta(`yosys_${id}`, cleaned, top, libPath, slew, load) };
}

const FIXED_MODES = ["area", "delay", "load"] as const;
type FixedMode = (typeof FIXED_MODES)[number];

interface ModePoint {
  id: string;
  note: string;
  mode: FixedMode;
  siftS: number;
  cells: number;
  area: number;
  slack: number;
  slew: number;
  powerW: number;
  recipe: string;
  error?: string;
}

interface YosysPoint {
  id: string;
  note: string;
  yosysS: number;
  cells: number;
  area: number;
  slack: number;
  slew: number;
  powerW: number;
  error?: string;
}

/** Area, delay, and load as three fixed maps. Yosys+ABC stays the one delay-constrained run. */
function runFixedModes(
  designs: (typeof DESIGNS)[number][],
  libPath: string,
  constr: string,
  slew: number,
  load: number,
  order: Map<string, string[]>,
  prior: { yosys: YosysPoint[]; modes: ModePoint[] } = { yosys: [], modes: [] },
): void {
  const yosysRows: YosysPoint[] = [...prior.yosys];
  const modeRows: ModePoint[] = [...prior.modes];
  const outDir = join(ROOT, "bench/delay");
  mkdirSync(outDir, { recursive: true });
  for (const design of designs) {
    process.stdout.write(`\n== ${design.id} ==\n`);
    const rtl = join(WORK, "src", `${design.id}.v`);
    writeFileSync(rtl, sourceOf(design));
    const rtlText = readFileSync(rtl, "utf8");
    let top = design.top ?? "";
    let yosys: YosysPoint = {
      id: design.id,
      note: design.note,
      yosysS: NaN,
      cells: NaN,
      area: NaN,
      slack: NaN,
      slew: NaN,
      powerW: NaN,
      error: "not run",
    };
    for (const mode of FIXED_MODES) {
      const dir = join(WORK, "sift", mode);
      mkdirSync(dir, { recursive: true });
      const siftOut = join(dir, `${design.id}.json`);
      const siftErr = join(dir, `${design.id}.err`);
      const siftV = join(dir, `${design.id}.v`);
      const sift = run(
        "node",
        [
          "--experimental-strip-types",
          join(ROOT, "src/synth/cli.ts"),
          rtl,
          "--lib",
          "sky130",
          "--mode",
          mode,
          "--opt",
          "area",
          "--recover",
          "--period",
          String(PERIOD_NS),
          "--max-fanout",
          String(SIFT_FANOUT),
          "--input-slew",
          String(slew),
          "--output-load",
          String(load),
          "--clock-slew",
          String(slew),
          ...(design.top ? ["--top", design.top] : []),
          "--json",
          "--netlist",
          siftV,
        ],
        siftOut,
        siftErr,
        10_800_000,
        true,
      );
      if (sift.error || (sift.status !== 0 && sift.status !== 1)) {
        const why = sift.error || `sift exit ${sift.status}`;
        const detail = tail(siftErr);
        modeRows.push(failedMode(design, mode, detail ? `${why}: ${detail}` : why));
        continue;
      }
      let report: SiftJson;
      try {
        report = JSON.parse(readFileSync(siftOut, "utf8")) as SiftJson;
      } catch (err) {
        const why = err instanceof Error ? err.message : "parse failed";
        modeRows.push(failedMode(design, mode, `sift JSON: ${why}: ${tail(siftErr)}`));
        continue;
      }
      if (!report.timing) {
        modeRows.push(failedMode(design, mode, "sift found no clock"));
        continue;
      }
      if (!top) top = report.name;
      let named = "";
      try {
        named = namePorts(readFileSync(siftV, "utf8"), order);
      } catch (err) {
        modeRows.push(
          failedMode(design, mode, err instanceof Error ? err.message : "pin naming failed"),
        );
        continue;
      }
      const namedPath = join(dir, `${design.id}.named.v`);
      writeFileSync(namedPath, named);
      if (yosys.error) {
        const scored = scoreYosys(design.id, top, rtlText, libPath, constr, slew, load);
        yosys = {
          id: design.id,
          note: design.note,
          yosysS: scored.yosysS,
          cells: scored.sta.cells,
          area: scored.sta.area,
          slack: scored.sta.slack,
          slew: scored.sta.slew,
          powerW: scored.sta.power?.totalW ?? NaN,
          error: Number.isFinite(scored.sta.area) ? undefined : "yosys or sta failed",
        };
        process.stdout.write(
          `${design.id}  yosys ${num(yosys.yosysS, 1)}s  slack ${num(yosys.slack)}  cells ${num(yosys.cells, 0)}  area ${num(yosys.area, 1)}  slew ${num(yosys.slew)}\n`,
        );
      }
      const sta = runSta(`sift_${mode}_${design.id}`, namedPath, report.name, libPath, slew, load);
      const point: ModePoint = {
        id: design.id,
        note: design.note,
        mode,
        siftS: sift.s,
        cells: sta.cells,
        area: sta.area,
        slack: sta.slack,
        slew: sta.slew,
        powerW: sta.power?.totalW ?? NaN,
        recipe: recipeOf(report),
        error: Number.isFinite(sta.area) ? undefined : "sta failed",
      };
      modeRows.push(point);
      process.stdout.write(
        `${design.id}  ${mode}  sift ${num(sift.s, 1)}s  slack ${num(point.slack)} / ys ${num(yosys.slack)}  cells ${num(point.cells, 0)}/${num(yosys.cells, 0)}  area ${num(point.area, 1)}/${num(yosys.area, 1)}  slew ${num(point.slew)}/${num(yosys.slew)}\n`,
      );
    }
    if (yosys.error === "not run") {
      yosys = { ...yosys, error: "no sift netlist to name the top" };
    }
    yosysRows.push(yosys);
    const partial = renderModes(modeRows, yosysRows, slew, load);
    writeFileSync(join(WORK, "modes.json"), JSON.stringify({ yosys: yosysRows, modes: modeRows }, null, 2));
    writeFileSync(join(outDir, "MODES.md"), partial);
  }
  process.stdout.write(`\nwrote bench/delay/MODES.md\n`);
}

function failedMode(
  design: (typeof DESIGNS)[number],
  mode: FixedMode,
  error: string,
): ModePoint {
  process.stdout.write(`FAIL ${design.id} ${mode}: ${error}\n`);
  return {
    id: design.id,
    note: design.note,
    mode,
    siftS: NaN,
    cells: NaN,
    area: NaN,
    slack: NaN,
    slew: NaN,
    powerW: NaN,
    recipe: "",
    error,
  };
}

function renderModes(
  rows: ModePoint[],
  yosysRows: YosysPoint[],
  slew: number,
  load: number,
): string {
  const yosys = new Map(yosysRows.map((row) => [row.id, row]));
  const lines: string[] = [];
  lines.push("# Sift vs Yosys+ABC, three mapper modes");
  lines.push("");
  lines.push(
    `Both sides use the same 24 Sky130 HD cells. Period ${PERIOD_NS} ns, input delay 0, output delay 0. Input slew ${num(slew, 2)} ns, clock slew the same, output load ${num(load, 6)} pF (${num(load * 1000, 3)} fF). Wires are pin capacitance only. Activity ${ACTIVITY}, duty ${DUTY}. OpenSTA scores every netlist.`,
  );
  lines.push("");
  lines.push(
    `Each Sift run pins \`--mode\` to area, delay, or load, then runs \`--opt area\` and \`--recover\`. Max fanout stays ${SIFT_FANOUT}. The search may change arithmetic, the adder bias, and clock gating. It does not leave the pinned mode, and it does not turn recovery off. Every map also sizes, buffers, or clones a driver that misses max capacitance or max transition. \`area\` picks the smallest legal cell. \`delay\` sizes from a fanout count. \`load\` uses the same goal as delay, but each gate's delay is the Liberty NLDM table at that gate's input slew and output capacitance. Yosys is \`synth -flatten\`, \`dfflibmap\`, then \`abc -D ${PERIOD_PS}\` once per design, and that one result is the right-hand side of every table.`,
  );
  lines.push("");
  lines.push(
    "Columns are Sift / Yosys. Area is µm². Slack is setup slack, nanoseconds. Slew is the largest pin transition, nanoseconds. Power is OpenSTA total power, microwatts. Runtime is wall clock of the mapper, not of OpenSTA.",
  );
  for (const mode of FIXED_MODES) {
    lines.push("");
    lines.push(`## ${mode}`);
    lines.push("");
    lines.push(
      "| Design | What | Cells S/Y | Area S/Y | Slack S/Y | Slew S/Y | Power µW S/Y | Runtime s S/Y |",
    );
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    let cellsS = 0;
    let cellsY = 0;
    let areaS = 0;
    let areaY = 0;
    let powerS = 0;
    let powerY = 0;
    let timeS = 0;
    let timeY = 0;
    let n = 0;
    let areaWins = 0;
    let cellWins = 0;
    let powerWins = 0;
    let slackWins = 0;
    for (const row of rows.filter((item) => item.mode === mode)) {
      const other = yosys.get(row.id);
      if (row.error || !other || other.error || !Number.isFinite(row.area) || !Number.isFinite(other.area)) {
        lines.push(`| ${row.id} | ${row.note} | ${row.error ?? other?.error ?? "failed"} | | | | | |`);
        continue;
      }
      lines.push(
        `| ${row.id} | ${row.note} | ${pair(row.cells, other.cells, 0)} | ${pair(row.area, other.area, 1)} | ${pair(row.slack, other.slack)} | ${pair(row.slew, other.slew)} | ${uw(row.powerW)}/${uw(other.powerW)} | ${pair(row.siftS, other.yosysS, 2)} |`,
      );
      cellsS += row.cells;
      cellsY += other.cells;
      areaS += row.area;
      areaY += other.area;
      powerS += row.powerW;
      powerY += other.powerW;
      timeS += row.siftS;
      timeY += other.yosysS;
      n += 1;
      if (other.area < row.area) areaWins += 1;
      if (other.cells < row.cells) cellWins += 1;
      if (other.powerW < row.powerW) powerWins += 1;
      if (row.slack > other.slack) slackWins += 1;
    }
    lines.push(
      `| **sum** | ${n} designs | ${cellsS}/${cellsY} | ${num(areaS, 1)}/${num(areaY, 1)} | | | ${uw(powerS)}/${uw(powerY)} | ${num(timeS, 1)}/${num(timeY, 1)} |`,
    );
    lines.push("");
    lines.push(
      `Yosys is smaller in area on ${areaWins} of ${n}, uses fewer cells on ${cellWins}, and uses less power on ${powerWins}. Sift has more setup slack on ${slackWins}.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  mkdirSync(WORK, { recursive: true });
  const lib = sky130Hd();
  const slew = librarySlew(lib);
  const load = portCap(lib);
  if (process.argv.includes("--report-only")) {
    const rows = JSON.parse(readFileSync(join(WORK, "rows.json"), "utf8")) as Row[];
    const report = render(rows, slew, load);
    writeFileSync(join(WORK, "REPORT.md"), report);
    mkdirSync(join(ROOT, "bench/delay"), { recursive: true });
    writeFileSync(join(ROOT, "bench/delay/REPORT.md"), report);
    process.stdout.write(`rewrote bench/delay/REPORT.md\n`);
    return;
  }
  mkdirSync(join(WORK, "src"), { recursive: true });
  mkdirSync(join(WORK, "sift"), { recursive: true });
  mkdirSync(join(WORK, "ys"), { recursive: true });
  mkdirSync(join(WORK, "sta"), { recursive: true });
  const names = [...lib.cells, ...lib.flops].map((cell) => cell.name);
  const subset = libertySubset(names);
  const libPath = join(WORK, "sky130_hd_sift.lib");
  writeFileSync(libPath, subset.text);
  const constr = join(WORK, "abc.constr");
  writeFileSync(
    constr,
    `set_driving_cell sky130_fd_sc_hd__inv_1\nset_load ${(load * 1000).toFixed(6)}\n`,
  );
  const order = pinOrder();
  const yosysOnly = process.argv.includes("--yosys-only");
  const modes = process.argv.includes("--modes");
  const args = process.argv.slice(2);
  let fromId = "";
  const want = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--report-only" || arg === "--yosys-only" || arg === "--modes") continue;
    if (arg === "--from") {
      fromId = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    want.add(arg);
  }
  if (modes) {
    let designs = DESIGNS.filter((design) => want.size === 0 || want.has(design.id));
    let prior: { yosys: YosysPoint[]; modes: ModePoint[] } = { yosys: [], modes: [] };
    if (fromId) {
      const start = designs.findIndex((design) => design.id === fromId);
      if (start < 0) throw new Error(`--from ${fromId} is not in this run`);
      designs = designs.slice(start);
      const savedPath = join(WORK, "modes.json");
      if (existsSync(savedPath)) {
        const saved = JSON.parse(readFileSync(savedPath, "utf8")) as {
          yosys: YosysPoint[];
          modes: ModePoint[];
        };
        const skip = new Set(designs.map((design) => design.id));
        prior = {
          yosys: saved.yosys.filter((row) => !skip.has(row.id)),
          modes: saved.modes.filter((row) => !skip.has(row.id)),
        };
      }
    }
    runFixedModes(designs, libPath, constr, slew, load, order, prior);
    return;
  }
  if (yosysOnly) {
    const rows = JSON.parse(readFileSync(join(WORK, "rows.json"), "utf8")) as Row[];
    const ids =
      want.size === 0
        ? rows.filter((row) => !Number.isFinite(row.staYosys.area)).map((row) => row.id)
        : [...want];
    for (const id of ids) {
      const row = rows.find((item) => item.id === id);
      const design = DESIGNS.find((item) => item.id === id);
      if (!row || !design || !row.top) {
        process.stdout.write(`skip ${id}: no saved Sift row\n`);
        continue;
      }
      process.stdout.write(`\n== yosys ${id} ==\n`);
      const scored = scoreYosys(id, row.top, sourceOf(design), libPath, constr, slew, load);
      row.yosysS = scored.yosysS;
      row.staYosys = scored.sta;
      process.stdout.write(
        `${id}  yosys ${num(scored.yosysS, 1)}s  slack ${num(scored.sta.slack)}  cells ${num(scored.sta.cells, 0)}  area ${num(scored.sta.area, 1)}  slew ${num(scored.sta.slew)}\n`,
      );
      writeFileSync(join(WORK, "rows.json"), JSON.stringify(rows, null, 2));
    }
    const report = render(rows, slew, load);
    writeFileSync(join(WORK, "REPORT.md"), report);
    mkdirSync(join(ROOT, "bench/delay"), { recursive: true });
    writeFileSync(join(ROOT, "bench/delay/REPORT.md"), report);
    process.stdout.write(`\nwrote bench/delay/REPORT.md\n`);
    return;
  }
  const designs = DESIGNS.filter((design) => want.size === 0 || want.has(design.id));
  const rows: Row[] = [];
  for (const design of designs) {
    process.stdout.write(`\n== ${design.id} ==\n`);
    const rtl = join(WORK, "src", `${design.id}.v`);
    writeFileSync(rtl, sourceOf(design));
    const siftOut = join(WORK, "sift", `${design.id}.json`);
    const siftErr = join(WORK, "sift", `${design.id}.err`);
    const siftV = join(WORK, "sift", `${design.id}.v`);
    const sift = run(
      "node",
      [
        "--experimental-strip-types",
        join(ROOT, "src/synth/cli.ts"),
        rtl,
        "--lib",
        "sky130",
        "--opt",
        "area",
        "--period",
        String(PERIOD_NS),
        "--max-fanout",
        String(SIFT_FANOUT),
        "--input-slew",
        String(slew),
        "--output-load",
        String(load),
        "--clock-slew",
        String(slew),
        ...(design.top ? ["--top", design.top] : []),
        "--json",
        "--netlist",
        siftV,
      ],
      siftOut,
      siftErr,
      2_400_000,
      true,
    );
    if (sift.status !== 0 && sift.status !== 1) {
      rows.push(failed(design, `sift exit ${sift.status}: ${tail(siftErr)}`));
      continue;
    }
    let report: SiftJson;
    try {
      report = JSON.parse(readFileSync(siftOut, "utf8")) as SiftJson;
    } catch (err) {
      const bytes = readFileSync(siftOut).length;
      const why = err instanceof Error ? err.message : "parse failed";
      rows.push(failed(design, `sift JSON (${bytes} bytes): ${why}: ${tail(siftErr)}`));
      continue;
    }
    if (!report.timing) {
      rows.push(failed(design, "sift found no clock"));
      continue;
    }
    let named = "";
    try {
      named = namePorts(readFileSync(siftV, "utf8"), order);
    } catch (err) {
      rows.push(failed(design, err instanceof Error ? err.message : "pin naming failed"));
      continue;
    }
    const namedPath = join(WORK, "sift", `${design.id}.named.v`);
    writeFileSync(namedPath, named);
    const leakN = report.cells.reduce((sum, cell) => sum + (subset.leakage.get(cell) ?? 0), 0);
    const scored = scoreYosys(
      design.id,
      report.name,
      readFileSync(rtl, "utf8"),
      libPath,
      constr,
      slew,
      load,
    );
    const yosysS = scored.yosysS;
    const staYosys = scored.sta;
    const staSift = runSta(`sift_${design.id}`, namedPath, report.name, libPath, slew, load);
    const row: Row = {
      id: design.id,
      note: design.note,
      top: report.name,
      siftS: sift.s,
      yosysS,
      sift: report,
      leakN,
      staSift,
      staYosys,
    };
    rows.push(row);
    process.stdout.write(
      `${design.id}  sift ${num(sift.s, 1)}s  yosys ${num(yosysS, 1)}s  ${recipeOf(report)}  slack ${num(report.timing.slack)} / sta ${num(staSift.slack)} / ys ${num(staYosys.slack)}  slew ${num(report.timing.maxSlew)} / sta ${num(staSift.slew)} / ys ${num(staYosys.slew)}\n`,
    );
    const partial = render(rows, slew, load);
    writeFileSync(join(WORK, "rows.json"), JSON.stringify(rows, null, 2));
    writeFileSync(join(WORK, "REPORT.md"), partial);
    mkdirSync(join(ROOT, "bench/delay"), { recursive: true });
    writeFileSync(join(ROOT, "bench/delay/REPORT.md"), partial);
  }
  const report = render(rows, slew, load);
  writeFileSync(join(WORK, "REPORT.md"), report);
  mkdirSync(join(ROOT, "bench/delay"), { recursive: true });
  writeFileSync(join(ROOT, "bench/delay/REPORT.md"), report);
  process.stdout.write(`\nwrote bench/delay/REPORT.md\n`);
}

function failed(design: (typeof DESIGNS)[number], error: string): Row {
  process.stdout.write(`FAIL ${design.id}: ${error}\n`);
  return {
    id: design.id,
    note: design.note,
    top: "",
    siftS: NaN,
    yosysS: NaN,
    sift: { name: "", area: NaN, cells: [], registers: 0, mismatches: 0, timing: null },
    leakN: NaN,
    staSift: emptySta(),
    staYosys: emptySta(),
    error,
  };
}

function recipeOf(report: SiftJson): string {
  const recipe = report.opt?.recipe;
  if (!recipe) return "no search";
  const ppa = recipe.ppa === undefined ? "—" : num(recipe.ppa);
  return `maps ${report.opt?.trials.length ?? 0}  ${recipe.mode}/${recipe.arith}  ppa ${ppa}  gate ${recipe.gate ? "on" : "off"}`;
}

function pair(left: number, right: number, digits = 3): string {
  return `${num(left, digits)}/${num(right, digits)}`;
}

function render(rows: Row[], slew: number, load: number): string {
  const lines: string[] = [];
  lines.push("# Sift vs Yosys+ABC, delay synthesis");
  lines.push("");
  lines.push(
    `Both mappers target the same 24 Sky130 HD cells (the cells Sift knows). The clock is propagated from the clk port, period ${PERIOD_NS} ns, input delay 0, output delay 0. Input slew and the clock source slew are the first liberty slew index. The output load is one inverter pin. Wires are pin capacitance only: the liberty default wire-load was removed so OpenSTA matches Sift. Activity is 0.1 transitions per cycle, duty 0.5.`,
  );
  lines.push("");
  lines.push(
    `Sift is \`--opt area\` with max fanout ${SIFT_FANOUT} pinned. The search starts at \`--mode area --arith area\` and changes one free knob at a time, up to eight maps. It keeps a step only when the period is met and the area drops, or, while the period is missed, when slack improves. \`load\` is the timed cover, because Sky130 has NLDM tables. Yosys is \`synth -flatten\`, \`dfflibmap\`, then \`abc -D ${PERIOD_PS}\` (${PERIOD_NS} ns) with the same output load and no fanout cap, so both netlists are flat. Runtime is wall clock of each tool, not of OpenSTA, and for Sift it includes every map the search tried. \`uart_apb\`, \`risc8\`, and \`pic16\` are vendored cores. \`pic16\` renames the clock port \`Clk\` to \`clk\`. \`uart_apb\` is the master only. \`pic1826\`, \`p16c5x\`, \`arlet6502\`, \`x18\`, and \`chacha\` are vendored the same way. \`pic1826\` stubs the stack, ROM, and RAM. \`p16c5x\` is Morris's P16C5x (the repo is named 6502) and renames \`Clk\` to \`clk\`. \`x18\` replaces the missing program image with the address.`,
  );
  lines.push("");
  lines.push(
    `Input slew ${num(slew, 2)} ns. Output load ${num(load, 6)} pF (${num(load * 1000, 3)} fF into ABC). Max slew is the largest transition OpenSTA or Sift records on any pin. Leakage from Sift is the sum of \`cell_leakage_power\` on the mapped cells. OpenSTA leakage is state-dependent at the activity above, so the two leakage numbers are not the same model.`,
  );
  lines.push("");
  lines.push("## Sift's report against OpenSTA on the Sift netlist");
  lines.push("");
  lines.push(
    "| Design | Cells Sift | Cells STA | Area Sift | Area STA | Slack Sift | Slack STA | Leak nW Sift | Leak nW STA | Sift s |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    if (row.error || !row.sift.timing) {
      lines.push(`| ${row.id} | ${row.error ?? "no timing"} |`);
      continue;
    }
    lines.push(
      `| ${row.id} | ${row.sift.cells.length} | ${num(row.staSift.cells, 0)} | ${num(row.sift.area, 1)} | ${num(row.staSift.area, 1)} | ${num(row.sift.timing.slack)} | ${num(row.staSift.slack)} | ${num(row.leakN, 2)} | ${num((row.staSift.power?.leakageW ?? NaN) * 1e9, 2)} | ${num(row.siftS, 2)} |`,
    );
  }
  lines.push("");
  lines.push("## Timing: Sift against OpenSTA on the Sift netlist");
  lines.push("");
  lines.push(
    "Slack and arrival are the setup check, nanoseconds. Hold slack is the worst min-path slack. Slew is the largest transition in the design, nanoseconds. Δ is Sift minus OpenSTA.",
  );
  lines.push("");
  lines.push(
    "| Design | Slack Sift | Slack STA | Δslack | Arrival Sift | Arrival STA | Hold Sift | Hold STA | Slew Sift | Slew STA |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    if (row.error || !row.sift.timing) {
      lines.push(`| ${row.id} | ${row.error ?? "no timing"} |`);
      continue;
    }
    const timing = row.sift.timing;
    lines.push(
      `| ${row.id} | ${num(timing.slack)} | ${num(row.staSift.slack)} | ${num(timing.slack - row.staSift.slack)} | ${num(timing.arrival)} | ${num(row.staSift.arrival)} | ${num(timing.holdSlack)} | ${num(row.staSift.hold)} | ${num(timing.maxSlew)} | ${num(row.staSift.slew)} |`,
    );
  }
  lines.push("");
  lines.push("## Kept recipe");
  lines.push("");
  lines.push(
    `\`--opt area\` tried up to eight maps. Max fanout stays ${SIFT_FANOUT}. Maps is how many recipes were mapped. The other columns are the recipe OpenSTA scored.`,
  );
  lines.push("");
  lines.push("| Design | Maps | Mode | Arith | PPA | Gate | Recover |");
  lines.push("| --- | ---: | --- | --- | ---: | --- | --- |");
  for (const row of rows) {
    const recipe = row.sift.opt?.recipe;
    if (row.error || !recipe) {
      lines.push(`| ${row.id} | ${row.error ?? "no search"} |`);
      continue;
    }
    lines.push(
      `| ${row.id} | ${row.sift.opt?.trials.length ?? 0} | ${recipe.mode} | ${recipe.arith} | ${recipe.ppa === undefined ? "—" : num(recipe.ppa)} | ${recipe.gate ? "on" : "off"} | ${recipe.recover ? "on" : "off"} |`,
    );
  }
  lines.push("");
  lines.push("## OpenSTA scoreboard");
  lines.push("");
  lines.push(
    "Area is µm² from the liberty. Slack is setup, nanoseconds. Slew is the largest pin transition, nanoseconds. Power is OpenSTA total (internal + switching + leakage), microwatts. A higher slack is faster. A lower area, power, cell count, slew, or runtime is smaller.",
  );
  lines.push("");
  lines.push(
    "| Design | What | Cells S/Y | Area S/Y | Slack S/Y | Slew S/Y | Power µW S/Y | Runtime s S/Y |",
  );
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  const scored = rows.filter(
    (row) => !row.error && Number.isFinite(row.staSift.area) && Number.isFinite(row.staYosys.area),
  );
  let cellsS = 0;
  let cellsY = 0;
  let areaS = 0;
  let areaY = 0;
  let powerS = 0;
  let powerY = 0;
  let timeS = 0;
  let timeY = 0;
  let areaWins = 0;
  let cellWins = 0;
  let powerWins = 0;
  let slackWins = 0;
  let timeWins = 0;
  for (const row of rows) {
    if (row.error) {
      lines.push(`| ${row.id} | ${row.note} | failed | | | | | |`);
      continue;
    }
    lines.push(
      `| ${row.id} | ${row.note} | ${pair(row.staSift.cells, row.staYosys.cells, 0)} | ${pair(row.staSift.area, row.staYosys.area, 1)} | ${pair(row.staSift.slack, row.staYosys.slack)} | ${pair(row.staSift.slew, row.staYosys.slew)} | ${uw(row.staSift.power?.totalW ?? NaN)}/${uw(row.staYosys.power?.totalW ?? NaN)} | ${pair(row.siftS, row.yosysS, 2)} |`,
    );
  }
  for (const row of scored) {
    cellsS += row.staSift.cells;
    cellsY += row.staYosys.cells;
    areaS += row.staSift.area;
    areaY += row.staYosys.area;
    powerS += row.staSift.power?.totalW ?? 0;
    powerY += row.staYosys.power?.totalW ?? 0;
    timeS += row.siftS;
    timeY += row.yosysS;
    if (row.staYosys.area < row.staSift.area) areaWins += 1;
    if (row.staYosys.cells < row.staSift.cells) cellWins += 1;
    if ((row.staYosys.power?.totalW ?? Infinity) < (row.staSift.power?.totalW ?? Infinity))
      powerWins += 1;
    if (row.staSift.slack > row.staYosys.slack) slackWins += 1;
    if (row.siftS < row.yosysS) timeWins += 1;
  }
  lines.push(
    `| **sum** | ${scored.length} designs | ${cellsS}/${cellsY} | ${num(areaS, 1)}/${num(areaY, 1)} | | | ${uw(powerS)}/${uw(powerY)} | ${num(timeS, 1)}/${num(timeY, 1)} |`,
  );
  lines.push("");
  lines.push(
    `On the OpenSTA scoreboard Yosys is smaller in area on ${areaWins} of ${scored.length}, uses fewer cells on ${cellWins}, and uses less power on ${powerWins}. Sift has more setup slack on ${slackWins} and is faster to run on ${timeWins}.`,
  );
  const failedRows = rows.filter((row) => row.error);
  if (failedRows.length > 0) {
    lines.push("");
    lines.push("## Failures");
    lines.push("");
    for (const row of failedRows) lines.push(`- **${row.id}**: ${row.error}`);
  }
  lines.push("");
  return lines.join("\n");
}

main();
