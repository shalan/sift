import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, dirname, join, resolve } from "node:path";
import type { Cell, FlopCell, FlopPins, Library } from "./library.ts";

export interface LecReport {
  proved: boolean;
  text: string;
}

interface MappedPort {
  dir: "input" | "output";
  name: string;
}

interface RtlPort {
  name: string;
  dir: "input" | "output";
  offset: number;
  width: number;
  bus: boolean;
}

function yosysBin(): string {
  const fromEnv = process.env.YOSYS;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const bundled = "/tmp/oss/oss-cad-suite/bin/yosys";
  if (existsSync(bundled)) return bundled;
  return "yosys";
}

function sop(cell: Cell): string {
  const width = cell.inputs.length;
  const terms: string[] = [];
  for (let mask = 0; mask < 1 << width; mask += 1) {
    if (cell.fn(mask) !== 1) continue;
    if (width === 0) {
      terms.push("1'b1");
      continue;
    }
    const bits = cell.inputs.map((pin, index) => (((mask >> index) & 1) === 1 ? pin : `~${pin}`));
    const term = bits.length === 1 ? bits[0] : `(${bits.join(" & ")})`;
    if (term) terms.push(term);
  }
  return terms.length === 0 ? "1'b0" : terms.join(" | ");
}

function comboModel(cell: Cell): string {
  const out = cell.output ?? "Y";
  const ports = [`output ${out}`, ...cell.inputs.map((pin) => `input ${pin}`)];
  return `module ${cell.name} (${ports.join(", ")});\n  assign ${out} = ${sop(cell)};\nendmodule\n`;
}

function levelTest(pin: string, level: 0 | 1 | undefined): string {
  return level === 0 ? `!${pin}` : pin;
}

function asyncBody(seq: FlopPins): string {
  const lines: string[] = [];
  if (seq.clear) lines.push(`if (${levelTest(seq.clear, seq.clearLevel)}) ${seq.q} <= 1'b0;`);
  if (seq.preset)
    lines.push(
      `${lines.length > 0 ? "else " : ""}if (${levelTest(seq.preset, seq.presetLevel)}) ${seq.q} <= 1'b1;`,
    );
  const data = seq.en
    ? `if (${levelTest(seq.en, seq.enLevel)}) ${seq.q} <= ${seq.d};`
    : `${seq.q} <= ${seq.d};`;
  if (lines.length === 0) return data;
  lines.push(`else ${data}`);
  return lines.join("\n    ");
}

function flopModel(cell: FlopCell): string {
  const seq: FlopPins | undefined = cell.seq;
  if (!seq) {
    if (cell.family === "LATCH") {
      return `module ${cell.name} (output reg Q, input D, input EN);\n  always @* if (EN) Q = D;\nendmodule\n`;
    }
    if (cell.family === "ADFF") {
      return `module ${cell.name} (output reg Q, input D, input RST, input RV, input CLK);\n  always @(posedge CLK or posedge RST) if (RST) Q <= RV; else Q <= D;\nendmodule\n`;
    }
    return `module ${cell.name} (output reg Q, input D, input CLK);\n  always @(posedge CLK) Q <= D;\nendmodule\n`;
  }
  const ports = [`output reg ${seq.q}`, `input ${seq.d}`];
  if (seq.clear) ports.push(`input ${seq.clear}`);
  if (seq.preset) ports.push(`input ${seq.preset}`);
  if (seq.en) ports.push(`input ${seq.en}`);
  if (seq.clk) ports.push(`input ${seq.clk}`);
  if (seq.en && !seq.clk) {
    return `module ${cell.name} (${ports.join(", ")});\n  always @* if (${levelTest(seq.en, seq.enLevel)}) ${seq.q} = ${seq.d};\nendmodule\n`;
  }
  const edges = [`posedge ${seq.clk ?? "CLK"}`];
  if (seq.clear) edges.push(`${seq.clearLevel === 0 ? "negedge" : "posedge"} ${seq.clear}`);
  if (seq.preset) edges.push(`${seq.presetLevel === 0 ? "negedge" : "posedge"} ${seq.preset}`);
  return `module ${cell.name} (${ports.join(", ")});\n  always @(${edges.join(" or ")})\n    ${asyncBody(seq)}\nendmodule\n`;
}

function cellModels(library: Library): string {
  return [...library.cells.map(comboModel), ...library.flops.map(flopModel)].join("\n");
}

function mappedModule(verilog: string): { name: string; ports: MappedPort[] } {
  const header = verilog.match(/module\s+([A-Za-z_][\w]*)\s*\(([\s\S]*?)\)\s*;/);
  if (!header?.[1] || !header[2]) throw new Error("mapped netlist has no module");
  const ports: MappedPort[] = [];
  for (const part of header[2].split(",")) {
    const match = part.match(/\b(input|output)\b\s+([A-Za-z_][\w]*)/);
    if (!match || (match[1] !== "input" && match[1] !== "output") || !match[2]) continue;
    ports.push({ dir: match[1], name: match[2] });
  }
  if (ports.length === 0) throw new Error("mapped netlist has no ports");
  return { name: header[1], ports };
}

function moduleBody(dump: string, top: string): string {
  const marker = `module \\${top}_rtl\n`;
  const start = dump.indexOf(marker);
  if (start < 0) throw new Error(`Yosys did not elaborate ${top}`);
  const end = dump.indexOf("\nend\n", start);
  return dump.slice(start, end < 0 ? undefined : end);
}

function rtlPorts(dump: string, top: string): RtlPort[] {
  const text = moduleBody(dump, top);
  const ports: RtlPort[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(
      /^ {2}wire(?: width (\d+))?(?: offset (-?\d+))?.*\s(input|output)\s+\d+\s+\\(\S+)\s*$/,
    );
    if (!match?.[4] || (match[3] !== "input" && match[3] !== "output")) continue;
    ports.push({
      name: match[4],
      dir: match[3],
      offset: match[2] ? Number(match[2]) : 0,
      width: match[1] ? Number(match[1]) : 1,
      bus: match[1] !== undefined,
    });
  }
  if (ports.length === 0) throw new Error(`Yosys reported no ports on ${top}`);
  return ports;
}

function siftBits(port: RtlPort): { name: string; index: number }[] {
  const bits: { name: string; index: number }[] = [];
  for (let step = 0; step < port.width; step += 1) {
    const index = port.offset + step;
    bits.push({ name: port.bus ? `${port.name}_${index}` : port.name, index });
  }
  return bits;
}

function wrappers(
  top: string,
  gate: { name: string; ports: MappedPort[] },
  ports: RtlPort[],
): string {
  const decl = gate.ports.map((port) => `  ${port.dir} ${port.name}`).join(",\n");
  const known = new Set(gate.ports.map((port) => port.name));
  const wires: string[] = [];
  const assign: string[] = [];
  const conn: string[] = [];
  for (const port of ports) {
    const bits = siftBits(port);
    for (const bit of bits) {
      if (!known.has(bit.name))
        throw new Error(`mapped netlist has no port ${bit.name} for ${port.name}`);
    }
    if (!port.bus) {
      conn.push(`.${port.name}(${port.name})`);
      continue;
    }
    const hi = port.offset + port.width - 1;
    wires.push(`  wire [${hi}:${port.offset}] ${port.name};`);
    if (port.dir === "input") {
      const packed = [...bits]
        .reverse()
        .map((bit) => bit.name)
        .join(", ");
      assign.push(`  assign ${port.name} = {${packed}};`);
    } else {
      for (const bit of bits) assign.push(`  assign ${bit.name} = ${port.name}[${bit.index}];`);
    }
    conn.push(`.${port.name}(${port.name})`);
  }
  const gateConn = gate.ports.map((port) => `.${port.name}(${port.name})`).join(", ");
  return [
    `module gold (`,
    decl,
    `);`,
    ...wires,
    `  ${top}_rtl u (${conn.join(", ")});`,
    ...assign,
    `endmodule`,
    ``,
    `module gate (`,
    decl,
    `);`,
    `  ${gate.name} u (${gateConn});`,
    `endmodule`,
    ``,
  ].join("\n");
}

function yosysQuote(path: string): string {
  return `"${path.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}

function gateSource(verilog: string): string {
  const text = verilog.endsWith("\n") ? verilog : `${verilog}\n`;
  if (!/^module\s+[A-Za-z_][\w]*/.test(text)) throw new Error("mapped netlist has no module");
  return text.replace(/^module\s+[A-Za-z_][\w]*/, "module sift_gate");
}

function runYosys(script: string, dir: string): { status: number; log: string } {
  const file = join(dir, "lec.ys");
  writeFileSync(file, script);
  const result = spawnSync(yosysBin(), ["-s", file], {
    encoding: "utf8",
    cwd: dir,
    maxBuffer: 32 * 1024 * 1024,
  });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      status: 1,
      log: missing ? "Yosys was not found. Set YOSYS to the binary." : result.error.message,
    };
  }
  return { status: result.status ?? 1, log };
}

function tailOf(log: string): string {
  return log.trim().split("\n").slice(-16).join("\n");
}

const WIRE_LINE =
  /^ {2}wire((?: width \d+)?(?: offset -?\d+)?)(?: (?:input|output|inout) \d+)? (\S+)$/;

function stateKey(escaped: string): string | null {
  const gate = escaped.match(/^\\u\.ff_(.+)\.Q$/);
  if (gate?.[1] && /^[A-Za-z_][\w]*$/.test(gate[1])) return gate[1];
  const gold = escaped.match(/^\\u\.(.+)$/);
  if (!gold?.[1]) return null;
  const flat = gold[1].replaceAll("[", "_").replaceAll("]", "");
  const parts = flat.split(".").filter(Boolean);
  const signal = parts.at(-1) ?? "";
  const inst = parts.length >= 2 ? (parts.at(-2) ?? "") : "";
  const key = (inst ? `${inst}_${signal}` : signal).replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Za-z_][\w]*$/.test(key) ? key : null;
}

function isWireId(token: string): boolean {
  return token.startsWith("\\") || token.startsWith("$");
}

function isConstSig(sig: string): boolean {
  return /^\d+'[bB]?[01xz]+$/i.test(sig);
}

function hdlValue(line: string): string | null {
  if (!line.includes("attribute \\hdlname")) return null;
  const match = /attribute \\hdlname(?:\s+-?\d+)?\s+"((?:\\.|[^"\\])*)"/.exec(line);
  if (!match?.[1]) return null;
  return match[1].replace(/\\/g, "");
}

function keyOfHdl(text: string, wire: string): string | null {
  const fromWire = stateKey(wire);
  if (fromWire) return fromWire;
  const indexed = /^(.*?)\s+\[(\d+):(\d+)\]\s+(\d+)$/.exec(text);
  const raw = (indexed?.[1] ?? text).replace(/^u\s+/, "");
  const parts = raw.split(/[\s.]+/).filter(Boolean);
  const fromBit = /\[(\d+)\]$/.exec(wire)?.[1];
  const bit = indexed?.[4] ?? fromBit;
  const signal = parts.at(-1) ?? "";
  const inst = parts.length >= 2 ? (parts.at(-2) ?? "") : "";
  const body = inst ? `${inst}_${signal}` : signal;
  const name = (bit ? `${body}_${bit}` : body)
    .replace(/\[(\d+)\]/g, "_$1")
    .replace(/[^\w]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[A-Za-z_][\w]*$/.test(name) ? name : null;
}

function connectBits(expr: string): string[] | null {
  const text = expr.trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    const parts = text.slice(1, -1).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts.some((part) => !isWireId(part))) return null;
    return parts;
  }
  return isWireId(text) ? [text] : null;
}

function splitConnect(line: string): [string, string] | null {
  let rest = line.slice("  connect ".length).trimStart();
  const take = (): string | null => {
    if (rest.startsWith("{")) {
      const end = rest.indexOf("}");
      if (end < 0) return null;
      const bit = rest.slice(0, end + 1);
      rest = rest.slice(end + 1).trimStart();
      return bit;
    }
    const match = /^\S+/.exec(rest);
    if (!match?.[0]) return null;
    rest = rest.slice(match[0].length).trimStart();
    return match[0];
  };
  const left = take();
  const right = left ? take() : null;
  if (!left || !right || rest !== "") return null;
  return [left, right];
}

interface AliasSets {
  add: (name: string) => void;
  find: (name: string) => string;
  join: (left: string, right: string) => void;
  members: (name: string) => string[];
}

function aliasSets(): AliasSets {
  const parent = new Map<string, string>();
  const kids = new Map<string, string[]>();
  const add = (name: string) => {
    if (parent.has(name)) return;
    parent.set(name, name);
    kids.set(name, [name]);
  };
  const find = (name: string): string => {
    add(name);
    let root = name;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    let at = name;
    while (at !== root) {
      const next = parent.get(at) ?? root;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const join = (left: string, right: string) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    parent.set(b, a);
    kids.set(a, [...(kids.get(a) ?? []), ...(kids.get(b) ?? [])]);
    kids.delete(b);
  };
  return { add, find, join, members: (name) => kids.get(find(name)) ?? [name] };
}

interface ResetMux {
  a: string;
  b: string;
  y: string;
}

interface FlopBit {
  q: string;
  kind: string;
  d: string;
  r: string;
  e: string;
}

function readNet(il: string):
  | {
      flops: FlopBit[];
      muxes: ResetMux[];
      hdlKey: Map<string, string>;
      sets: AliasSets;
      drivers: Map<string, { kind: string; ins: string[] }>;
    }
  | { error: string } {
  const flops: FlopBit[] = [];
  const muxes: ResetMux[] = [];
  const hdlKey = new Map<string, string>();
  const sets = aliasSets();
  const pendingDrivers: { y: string; kind: string; ins: string[] }[] = [];
  const lines = il.split("\n");
  let pendingHdl: string | null = null;
  const note = (wire: string): void => {
    if (pendingHdl === null) return;
    const key = keyOfHdl(pendingHdl, wire);
    if (key) hdlKey.set(wire, key);
    pendingHdl = null;
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const named = hdlValue(line);
    if (named !== null) pendingHdl = named;
    const wire = WIRE_LINE.exec(line);
    if (wire?.[2]) {
      if (pendingHdl !== null) note(wire[2]);
      else pendingHdl = null;
      sets.add(wire[2]);
      index += 1;
      continue;
    }
    if (line.startsWith("  connect ")) {
      pendingHdl = null;
      const parts = splitConnect(line);
      const left = parts ? connectBits(parts[0]) : null;
      const right = parts ? connectBits(parts[1]) : null;
      if (left && right && left.length === right.length) {
        for (let bit = 0; bit < left.length; bit += 1) {
          const a = left[bit];
          const b = right[bit];
          if (a && b) sets.join(a, b);
        }
      }
      index += 1;
      continue;
    }
    const cell = /^ {2}cell (\S+) /.exec(line);
    const kind = cell?.[1];
    if (!kind) {
      if (!line.startsWith("  attribute ")) pendingHdl = null;
      index += 1;
      continue;
    }
    const pins = new Map<string, string>();
    index += 1;
    while (index < lines.length && lines[index] !== "  end") {
      const pin = /^ {4}connect \\([A-Za-z0-9]+) (\S+)$/.exec(lines[index] ?? "");
      if (pin?.[1] && pin[2]) pins.set(pin[1], pin[2]);
      index += 1;
    }
    if (lines[index] === "  end") index += 1;
    if (kind.includes("LATCH") || kind.includes("dlatch"))
      return { error: "lec failed: a latch is not proved" };
    if (kind.includes("DFF")) {
      const q = pins.get("Q");
      if (!q || !isWireId(q))
        return { error: `lec failed: flop Q ${q ?? "?"} has no register name` };
      if (pendingHdl !== null) note(q);
      flops.push({
        q,
        kind,
        d: pins.get("D") ?? "",
        r: pins.get("R") ?? "",
        e: pins.get("E") ?? "",
      });
      sets.add(q);
      continue;
    }
    pendingHdl = null;
    if (kind === "$_MUX_" || kind === "$mux") {
      const a = pins.get("A");
      const b = pins.get("B");
      const y = pins.get("Y");
      if (a && b && y) muxes.push({ a, b, y });
    }
    const y = pins.get("Y");
    if (y && isWireId(y)) {
      const ins = [...pins.entries()]
        .filter(([name]) => name !== "Y")
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([, net]) => net);
      pendingDrivers.push({ y, kind, ins });
    }
  }
  const drivers = new Map<string, { kind: string; ins: string[] }>();
  for (const driver of pendingDrivers) {
    drivers.set(sets.find(driver.y), {
      kind: driver.kind,
      ins: driver.ins.map((net) => (isConstSig(net) ? net : sets.find(net))),
    });
  }
  return { flops, muxes, hdlKey, sets, drivers };
}

function hierarchyDepth(name: string): number | null {
  if (!name.startsWith("\\u.")) return null;
  const body = name.slice(3);
  if (/^ff_.+\.Q$/.test(body)) return 0;
  return body.split(".").length - 1;
}

function bestKeys(names: readonly string[]): { keys: string[]; depth: number } | null {
  let bestDepth = Number.POSITIVE_INFINITY;
  let best = new Set<string>();
  for (const name of names) {
    const key = stateKey(name);
    const depth = hierarchyDepth(name);
    if (!key || depth === null) continue;
    if (depth < bestDepth) {
      bestDepth = depth;
      best = new Set([key]);
    } else if (depth === bestDepth) best.add(key);
  }
  if (best.size === 0) return null;
  return { keys: [...best], depth: bestDepth };
}

function preferKey(q: string, chosen: { keys: string[] }, wires: readonly string[]): string | "many" {
  if (chosen.keys.length === 1) return chosen.keys[0] ?? "many";
  const own = stateKey(q);
  if (own && chosen.keys.includes(own)) return own;
  const fromWires = bestKeys(wires);
  if (fromWires && fromWires.keys.length === 1) return fromWires.keys[0] ?? "many";
  const shortest = [...chosen.keys].sort(
    (a, b) => a.length - b.length || (a < b ? -1 : 1),
  )[0];
  return shortest ?? "many";
}

function nameFlop(
  q: string,
  muxes: ResetMux[],
  hdlKey: ReadonlyMap<string, string>,
  sets: AliasSets,
): { key: string; cands: string[] } | null | "many" {
  const yWires: string[] = [];
  const root = sets.find(q);
  for (const mux of muxes) {
    const aConst = isConstSig(mux.a);
    const bConst = isConstSig(mux.b);
    const aHit = !aConst && sets.find(mux.a) === root;
    const bHit = !bConst && sets.find(mux.b) === root;
    if ((aHit && bConst) || (bHit && aConst)) yWires.push(mux.y);
  }
  const pool = new Set<string>(sets.members(q));
  for (const wire of yWires) for (const member of sets.members(wire)) pool.add(member);
  const cands = new Set<string>();
  for (const wire of pool) {
    const key = stateKey(wire);
    if (key && hierarchyDepth(wire) !== null) cands.add(key);
    const hdl = hdlKey.get(wire);
    if (hdl) cands.add(hdl);
  }
  const chosen = bestKeys([...pool]);
  if (chosen) {
    const key = preferKey(q, chosen, yWires);
    if (key !== "many") return { key, cands: [...cands] };
  }
  const fromHdl = [...cands];
  if (fromHdl.length === 1 && fromHdl[0]) return { key: fromHdl[0], cands: fromHdl };
  if (fromHdl.length > 1) {
    const head = [...fromHdl].sort((a, b) => a.length - b.length)[0];
    if (head && fromHdl.every((key) => key === head || key.endsWith(`_${head}`)))
      return { key: head, cands: fromHdl };
  }
  return null;
}

function isMemRdReg(q: string): boolean {
  return /\$rdreg\[\d+\]\$q\[\d+\]$/.test(q);
}

function mixHash(text: string, parts: readonly number[]): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  for (const part of parts) hash = Math.imul(hash ^ part, 16777619);
  return hash >>> 0;
}

function flopSig(
  flop: FlopBit,
  sets: AliasSets,
  drivers: ReadonlyMap<string, { kind: string; ins: string[] }>,
): string {
  const self = sets.find(flop.q);
  const memo = new Map<string, number>();
  const stack = new Set<string>();
  const hash = (net: string): number => {
    if (!net) return 0;
    if (isConstSig(net)) return mixHash(net, []);
    const root = sets.find(net);
    if (root === self) return 1;
    const known = memo.get(root);
    if (known !== undefined) return known;
    const driver = drivers.get(root);
    if (!driver) return mixHash(`l:${root}`, []);
    if (stack.has(root)) return 2;
    stack.add(root);
    const text = mixHash(
      driver.kind,
      driver.ins.map((pin) => hash(pin)),
    );
    stack.delete(root);
    memo.set(root, text);
    return text;
  };
  return `${flop.kind}|${hash(flop.d)}|${hash(flop.r)}|${hash(flop.e)}`;
}

function holdSig(
  flop: FlopBit,
  sets: AliasSets,
  drivers: ReadonlyMap<string, { kind: string; ins: string[] }>,
): string | null {
  if (!flop.d) return null;
  const self = sets.find(flop.q);
  const driver = drivers.get(sets.find(flop.d));
  if (!driver) return null;
  let held = false;
  const ins = driver.ins.map((net) => {
    if (isConstSig(net)) return net;
    if (sets.find(net) === self) {
      held = true;
      return "self";
    }
    return sets.find(net);
  });
  if (!held) return null;
  const pin = (net: string): string => (net ? (isConstSig(net) ? net : sets.find(net)) : "");
  return `${flop.kind}|${driver.kind}|${ins.join(",")}|${pin(flop.r)}|${pin(flop.e)}`;
}

function flopMap(il: string):
  | {
      byKey: Map<string, string>;
      ties: Map<string, string>;
      sigOf: Map<string, string>;
      holdOf: Map<string, string>;
      cands: Map<string, string[]>;
    }
  | { error: string } {
  const net = readNet(il);
  if ("error" in net) return net;
  const byKey = new Map<string, string>();
  const sigOf = new Map<string, string>();
  const holdOf = new Map<string, string>();
  const cands = new Map<string, string[]>();
  const unnamed: FlopBit[] = [];
  for (const flop of net.flops) {
    const named = nameFlop(flop.q, net.muxes, net.hdlKey, net.sets);
    if (named === "many") return { error: `lec failed: flop Q ${flop.q} has several register names` };
    if (!named) {
      if (!isMemRdReg(flop.q)) return { error: `lec failed: flop Q ${flop.q} has no register name` };
      unnamed.push(flop);
      continue;
    }
    const prev = byKey.get(named.key);
    if (prev) return { error: `lec failed: ${prev} and ${flop.q} both name st_${named.key}` };
    byKey.set(named.key, flop.q);
    cands.set(named.key, named.cands.length > 0 ? named.cands : [named.key]);
    sigOf.set(named.key, flopSig(flop, net.sets, net.drivers));
    const held = holdSig(flop, net.sets, net.drivers);
    if (held) holdOf.set(named.key, held);
  }
  const bySig = new Map<string, string[]>();
  for (const [key, sig] of sigOf) {
    const list = bySig.get(sig) ?? [];
    list.push(key);
    bySig.set(sig, list);
  }
  const ties = new Map<string, string>();
  for (const flop of unnamed) {
    const keys = bySig.get(flopSig(flop, net.sets, net.drivers)) ?? [];
    const key = keys.length === 1 ? keys[0] : null;
    if (!key) return { error: `lec failed: flop Q ${flop.q} has no register name` };
    ties.set(flop.q, key);
  }
  return { byKey, ties, sigOf, holdOf, cands };
}

function renameTokens(il: string, rename: ReadonlyMap<string, string>): string {
  if (rename.size === 0) return il;
  return il
    .split("\n")
    .map((line) =>
      line
        .split(/(\s+)/)
        .map((token) => rename.get(token) ?? token)
        .join(""),
    )
    .join("\n");
}

function listed(keys: string[]): string {
  const cap = process.env.SIFT_LEC_ALL === "1" ? keys.length : 12;
  const shown = keys.slice(0, cap);
  const more = keys.length > shown.length ? ` (+${keys.length - shown.length})` : "";
  return `${shown.join(", ")}${more}`;
}

function dropFlops(il: string, dropped: ReadonlyMap<string, string>): string {
  const lines = il.split("\n");
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const cell = /^ {2}cell (\S+) /.exec(lines[index] ?? "");
    const kind = cell?.[1];
    if (!kind || !kind.includes("DFF")) {
      const wire = WIRE_LINE.exec(lines[index] ?? "");
      if (wire?.[2] && dropped.has(wire[2])) {
        kept.push((lines[index] ?? "").replace(/ output \d+/, ""));
        index += 1;
        continue;
      }
      kept.push(lines[index] ?? "");
      index += 1;
      continue;
    }
    const start = index;
    const pins = new Map<string, string>();
    index += 1;
    while (index < lines.length && lines[index] !== "  end") {
      const pin = /^ {4}connect \\([A-Za-z0-9]+) (\S+)$/.exec(lines[index] ?? "");
      if (pin?.[1] && pin[2]) pins.set(pin[1], pin[2]);
      index += 1;
    }
    if (lines[index] === "  end") index += 1;
    const q = pins.get("Q");
    const tie = q ? dropped.get(q) : undefined;
    if (!q || tie === undefined) {
      kept.push(...lines.slice(start, index));
      continue;
    }
    while (kept.length > 0 && (kept.at(-1)?.startsWith("  attribute ") ?? false)) kept.pop();
    kept.push(`  connect ${q} ${tie}`);
  }
  return kept.join("\n");
}

function normKey(key: string): string {
  return key.replace(/_reg(_\d+)?$/, (_all, bit: string | undefined) => bit ?? "");
}

function keyScore(gold: string, gate: string): number {
  const left = normKey(gold);
  const right = normKey(gate);
  if (left === right) return left.length + 1;
  if (left.endsWith(`_${right}`)) return right.length;
  if (right.endsWith(`_${left}`)) return left.length;
  return 0;
}

function pairKeys(goldKeys: readonly string[], gateKeys: readonly string[]): Map<string, string> {
  const goldLeft = new Set(goldKeys);
  const gateLeft = new Set(gateKeys);
  const paired = new Map<string, string>();
  const take = (gold: string, gate: string): void => {
    paired.set(gold, gate);
    goldLeft.delete(gold);
    gateLeft.delete(gate);
  };
  for (const key of [...goldLeft]) if (gateLeft.has(key)) take(key, key);
  const uniqueNorm = (keys: ReadonlySet<string>): Map<string, string> => {
    const grouped = new Map<string, string[]>();
    for (const key of keys) {
      const norm = normKey(key);
      const list = grouped.get(norm) ?? [];
      list.push(key);
      grouped.set(norm, list);
    }
    const one = new Map<string, string>();
    for (const [norm, list] of grouped) if (list.length === 1 && list[0]) one.set(norm, list[0]);
    return one;
  };
  for (const [norm, gold] of uniqueNorm(goldLeft)) {
    const gate = uniqueNorm(gateLeft).get(norm);
    if (gate) take(gold, gate);
  }
  let moved = true;
  while (moved) {
    moved = false;
    for (const gold of [...goldLeft]) {
      let best = "";
      let bestScore = 0;
      let tied = false;
      for (const gate of gateLeft) {
        const score = keyScore(gold, gate);
        if (score === 0) continue;
        if (score > bestScore) {
          best = gate;
          bestScore = score;
          tied = false;
        } else if (score === bestScore) tied = true;
      }
      if (!best || tied) continue;
      let claims = 0;
      for (const other of goldLeft) if (keyScore(other, best) > 0) claims += 1;
      if (claims !== 1) continue;
      take(gold, best);
      moved = true;
    }
  }
  return paired;
}

function pairState(
  goldIl: string,
  gateIl: string,
): { gold: string; gate: string } | { error: string } {
  const gold = flopMap(goldIl);
  const gate = flopMap(gateIl);
  if ("error" in gold) return gold;
  if ("error" in gate) return gate;
  const goldMap = gold.byKey;
  const gateMap = gate.byKey;
  const matched = pairKeys([...goldMap.keys()], [...gateMap.keys()]);
  const claim = (goldKey: string, gateKey: string): void => {
    if (matched.has(goldKey) || [...matched.values()].includes(gateKey)) return;
    matched.set(goldKey, gateKey);
  };
  let grew = true;
  while (grew) {
    grew = false;
    const goldLeft = [...goldMap.keys()].filter((key) => !matched.has(key));
    const gateLeft = [...gateMap.keys()].filter((key) => ![...matched.values()].includes(key));
    for (const gateKey of gateLeft) {
      const hits = goldLeft.filter((goldKey) =>
        (gold.cands.get(goldKey) ?? [goldKey]).some((cand) => keyScore(cand, gateKey) > 0),
      );
      if (hits.length !== 1 || !hits[0]) continue;
      const before = matched.size;
      claim(hits[0], gateKey);
      if (matched.size !== before) grew = true;
    }
  }
  const goldSig = (key: string): string => gold.sigOf.get(key) ?? "";
  const gateSig = (key: string): string => gate.sigOf.get(key) ?? "";
  const goldHold = (key: string): string => gold.holdOf.get(key) ?? "";
  const gateHold = (key: string): string => gate.holdOf.get(key) ?? "";
  const sigAlias = (
    sig: (key: string) => string,
    keys: readonly string[],
    keep: ReadonlySet<string>,
  ): Map<string, string> => {
    const sigs = new Map<string, string[]>();
    for (const key of keys) {
      const list = sigs.get(sig(key)) ?? [];
      list.push(key);
      sigs.set(sig(key), list);
    }
    const alias = new Map<string, string>();
    for (const key of keys) {
      if (keep.has(key)) continue;
      const peers = (sigs.get(sig(key)) ?? []).filter((peer) => keep.has(peer));
      const peer = peers.length === 1 ? peers[0] : undefined;
      if (peer) alias.set(key, peer);
    }
    return alias;
  };
  const goldKeep = new Set(matched.keys());
  const gateKeep = new Set(matched.values());
  const goldDup = sigAlias(goldSig, [...goldMap.keys()], goldKeep);
  const gateDup = sigAlias(gateSig, [...gateMap.keys()], gateKeep);
  for (const [key, peer] of sigAlias(goldHold, [...goldMap.keys()], goldKeep)) goldDup.set(key, peer);
  for (const [key, peer] of sigAlias(gateHold, [...gateMap.keys()], gateKeep)) gateDup.set(key, peer);
  for (const [q, key] of gold.ties) if (goldKeep.has(key) || goldDup.has(key)) goldDup.set(`\0${q}`, key);
  for (const [q, key] of gate.ties) if (gateKeep.has(key) || gateDup.has(key)) gateDup.set(`\0${q}`, key);
  const goldOnly = [...goldMap.keys()].filter((key) => !goldKeep.has(key) && !goldDup.has(key)).sort();
  const gateOnly = [...gateMap.keys()].filter((key) => !gateKeep.has(key) && !gateDup.has(key)).sort();
  if (gateOnly.length > 0) {
    return {
      error: `lec failed: gold and gate flops do not pair; gate-only: ${listed(gateOnly)}`,
    };
  }
  const sharedOfGold = new Map<string, string>();
  for (const [goldKey, gateKey] of matched) sharedOfGold.set(goldKey, `\\st_${gateKey}`);
  const resolveShared = (key: string, seen: Set<string>): string | null => {
    let current = key;
    while (!sharedOfGold.has(current)) {
      if (seen.has(current)) return null;
      seen.add(current);
      const next = goldDup.get(current);
      if (!next) return null;
      current = next;
    }
    return sharedOfGold.get(current) ?? null;
  };
  const goldDrop = new Map<string, string>();
  for (const key of goldOnly) {
    const q = goldMap.get(key);
    if (q) goldDrop.set(q, "1'0");
  }
  for (const [key, peer] of goldDup) {
    const shared = resolveShared(peer, new Set([key]));
    const q = key.startsWith("\0") ? key.slice(1) : goldMap.get(key);
    if (!q || !shared) continue;
    goldDrop.set(q, shared);
  }
  const gateDrop = new Map<string, string>();
  for (const [key, peer] of gateDup) {
    if (!gateKeep.has(peer)) continue;
    const q = key.startsWith("\0") ? key.slice(1) : gateMap.get(key);
    if (q) gateDrop.set(q, `\\st_${peer}`);
  }
  if (process.env.SIFT_LEC_DEBUG === "1") {
    writeFileSync(
      "/tmp/sift-last-pair.txt",
      [
        `matched ${matched.size}`,
        `zero ${goldOnly.join(" ")}`,
        `goldDup ${[...goldDup.keys()].join(" ")}`,
        `gateDup ${[...gateDup.keys()].join(" ")}`,
      ].join("\n"),
    );
  }
  const goldText = goldDrop.size > 0 ? dropFlops(goldIl, goldDrop) : goldIl;
  const gateText = gateDrop.size > 0 ? dropFlops(gateIl, gateDrop) : gateIl;
  const goldRename = new Map<string, string>();
  const gateRename = new Map<string, string>();
  for (const [goldKey, gateKey] of matched) {
    const shared = `\\st_${gateKey}`;
    const goldWire = goldMap.get(goldKey);
    const gateWire = gateMap.get(gateKey);
    if (!goldWire || !gateWire) return { error: "lec failed: gold and gate flops do not pair" };
    goldRename.set(goldWire, shared);
    gateRename.set(gateWire, shared);
  }
  return { gold: renameTokens(goldText, goldRename), gate: renameTokens(gateText, gateRename) };
}

function muxCell(id: string, a: string, b: string, s: string, y: string): string[] {
  return [
    `  cell $_MUX_ ${id}`,
    `    connect \\A ${a}`,
    `    connect \\B ${b}`,
    `    connect \\S ${s}`,
    `    connect \\Y ${y}`,
    `  end`,
  ];
}

function nextFlop(
  kind: string,
  pins: Map<string, string>,
  at: number,
): { q: string; lines: string[] } | { error: string } {
  const q = pins.get("Q");
  const d = pins.get("D");
  if (!q || !d) return { error: "lec failed: a DFF is missing D or Q" };
  const nx = `\\nx_${q.startsWith("\\") ? q.slice(1) : q}`;
  const head = [`  wire output ${3000 + at} ${nx}`];
  if (kind === "$_DFF_P_") return { q, lines: [...head, `  connect ${nx} ${d}`] };
  const r = pins.get("R");
  const e = pins.get("E");
  const reset = (data: string, y: string): string[] | null => {
    if (!r) return null;
    if (kind.includes("PP0")) return muxCell(`$nxr${at}`, data, "1'0", r, y);
    if (kind.includes("PN0")) return muxCell(`$nxr${at}`, "1'0", data, r, y);
    if (kind.includes("PP1")) return muxCell(`$nxr${at}`, data, "1'1", r, y);
    if (kind.includes("PN1")) return muxCell(`$nxr${at}`, "1'1", data, r, y);
    return null;
  };
  if (kind.startsWith("$_SDFFE_") && e) {
    const hold = `$nxh${at}`;
    const enabled = kind.endsWith("P_")
      ? muxCell(`$nxe${at}`, q, d, e, hold)
      : muxCell(`$nxe${at}`, d, q, e, hold);
    const cleared = reset(hold, nx);
    if (!cleared) return { error: `lec failed: flop ${kind} is not a plain DFF` };
    return { q, lines: [`  wire ${hold}`, ...head, ...enabled, ...cleared] };
  }
  if (kind.startsWith("$_SDFF_")) {
    const cleared = reset(d, nx);
    if (!cleared) return { error: `lec failed: flop ${kind} is not a plain DFF` };
    return { q, lines: [...head, ...cleared] };
  }
  if (kind.startsWith("$_DFFE_") && e) {
    const enabled = kind.endsWith("P_")
      ? muxCell(`$nxe${at}`, q, d, e, nx)
      : muxCell(`$nxe${at}`, d, q, e, nx);
    return { q, lines: [...head, ...enabled] };
  }
  return { error: `lec failed: flop ${kind} is not a plain DFF` };
}

function cutFlops(il: string): { text: string } | { error: string } {
  const lines = il.split("\n");
  const kept: string[] = [];
  const flops: { q: string; lines: string[] }[] = [];
  let index = 0;
  while (index < lines.length) {
    const cell = /^ {2}cell (\S+) /.exec(lines[index] ?? "");
    const kind = cell?.[1];
    if (!kind || (!kind.includes("DFF") && !kind.includes("LATCH") && !kind.includes("dlatch"))) {
      kept.push(lines[index] ?? "");
      index += 1;
      continue;
    }
    const pins = new Map<string, string>();
    index += 1;
    while (index < lines.length && lines[index] !== "  end") {
      const pin = /^ {4}connect \\([A-Za-z0-9]+) (\S+)$/.exec(lines[index] ?? "");
      if (pin?.[1] && pin[2]) pins.set(pin[1], pin[2]);
      index += 1;
    }
    if (lines[index] === "  end") index += 1;
    if (kind.includes("LATCH") || kind.includes("dlatch"))
      return { error: "lec failed: a latch is not proved" };
    const built = nextFlop(kind, pins, flops.length);
    if ("error" in built) return built;
    while (kept.length > 0 && (kept.at(-1)?.startsWith("  attribute ") ?? false)) kept.pop();
    flops.push(built);
  }
  const outputs = new Set(flops.map((flop) => flop.q));
  const seen = new Set<string>();
  let port = 2000;
  const rewritten = kept.map((line) => {
    const match = WIRE_LINE.exec(line);
    const name = match?.[2];
    if (!name || !outputs.has(name)) return line;
    seen.add(name);
    port += 1;
    return `  wire${match[1] ?? ""} input ${port} ${name}`;
  });
  if (seen.size !== outputs.size) return { error: "lec failed: a flop Q was not a wire" };
  const extra = flops.flatMap((flop) => flop.lines);
  const endAt = rewritten.lastIndexOf("end");
  if (endAt >= 0) rewritten.splice(endAt, 0, ...extra);
  else rewritten.push(...extra);
  return { text: rewritten.join("\n") };
}

function drivenNets(il: string): Set<string> {
  const driven = new Set<string>();
  const lines = il.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("  connect ")) {
      const parts = splitConnect(line);
      const left = parts ? connectBits(parts[0]) : null;
      if (left) for (const bit of left) driven.add(bit);
      index += 1;
      continue;
    }
    if (line.startsWith("  cell ")) {
      index += 1;
      while (index < lines.length && lines[index] !== "  end") {
        const pin = /^ {4}connect \\([A-Za-z0-9]+) (\S+)$/.exec(lines[index] ?? "");
        if (pin?.[1] === "Y" || pin?.[1] === "Q") driven.add(pin[2] ?? "");
        index += 1;
      }
      if (lines[index] === "  end") index += 1;
      continue;
    }
    index += 1;
  }
  return driven;
}

/** Drop output flags on wires nothing drives. `expose -dff` leaves unread register bits as ports. */
function stripUndrivenOutputs(il: string): string {
  const driven = drivenNets(il);
  return il
    .split("\n")
    .map((line) => {
      const match = WIRE_LINE.exec(line);
      const name = match?.[2];
      if (!name || !line.includes(" output ") || driven.has(name)) return line;
      return line.replace(/ output \d+/, "");
    })
    .join("\n");
}

function undefToken(token: string): boolean {
  return token === "1'x" || token === "1'X" || token === "1'z" || token === "1'Z";
}

function hasUndef(il: string): boolean {
  return il.split("\n").some((line) => line.split(/(\s+)/).some((token) => undefToken(token)));
}

function tieUndef(
  il: string,
  policy: "free" | "zero",
): { text: string; tied: boolean } | { error: string } {
  let tied = false;
  let bad = "";
  const lines = il.split("\n").map((line) =>
    line
      .split(/(\s+)/)
      .map((token) => {
        if (undefToken(token)) {
          if (policy === "zero") return "1'0";
          tied = true;
          return "\\sift_x";
        }
        if (/^\d+'[01xzXZ]*[xzXZ]/.test(token)) {
          bad = token.slice(0, 80);
          return "\0";
        }
        return token;
      })
      .join(""),
  );
  if (bad) return { error: `lec failed: a multi-bit undef ${bad}` };
  return { text: lines.join("\n"), tied };
}

function addUndefPort(il: string): string {
  if (il.split("\n").some((line) => line.startsWith("  wire ") && line.endsWith(" \\sift_x")))
    return il;
  const lines = il.split("\n");
  const at = lines.findIndex((line) => line.startsWith("module "));
  if (at < 0) return il;
  lines.splice(at + 1, 0, "  wire input 9000 \\sift_x");
  return lines.join("\n");
}
function abcBin(): string {
  const beside = join(dirname(yosysBin()), "yosys-abc");
  if (existsSync(beside)) return beside;
  return "yosys-abc";
}

function aigerPorts(map: string, kind: "input" | "output"): string[] {
  const names: string[] = [];
  for (const line of map.split("\n")) {
    if (!line.startsWith(`${kind} `)) continue;
    const name = line.trim().split(/\s+/).at(-1);
    if (name) names.push(name);
  }
  return names;
}

function samePorts(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function outputWires(il: string): Set<string> {
  const names = new Set<string>();
  for (const line of il.split("\n")) {
    const match = WIRE_LINE.exec(line);
    if (match?.[2] && line.includes(" output ")) names.add(match[2]);
  }
  return names;
}

/**
 * `write_aiger -map` omits a constant output. If only one side has already
 * folded that bit, the port lists shift. Tie both sides' constant outputs
 * before mapping, without rewriting the rest of the netlist (opt_clean
 * reorders ports).
 */
function tieConstOutputs(il: string, dir: string, tag: string): string {
  const outputs = outputWires(il);
  writeFileSync(join(dir, `${tag}_fold_in.il`), il);
  const folded = runYosys(
    [`read_rtlil ${tag}_fold_in.il`, `opt_expr`, `opt_clean`, `write_rtlil ${tag}_fold_out.il`, ``].join(
      "\n",
    ),
    dir,
  );
  if (folded.status !== 0) return il;
  const consts = new Map<string, string>();
  for (const line of readFileSync(join(dir, `${tag}_fold_out.il`), "utf8").split("\n")) {
    const match = /^ {2}connect (\S+) (1'[01])$/.exec(line);
    if (!match?.[1] || !match[2] || !outputs.has(match[1])) continue;
    consts.set(match[1], match[2]);
  }
  if (consts.size === 0) return il;
  return il
    .split("\n")
    .map((line) => {
      if (!line.startsWith("  connect ")) return line;
      const parts = splitConnect(line);
      if (!parts) return line;
      const bits = connectBits(parts[0]);
      if (!bits || bits.length !== 1 || !bits[0]) return line;
      const value = consts.get(bits[0]);
      if (!value || parts[1] === value) return line;
      return `  connect ${bits[0]} ${value}`;
    })
    .join("\n");
}

export function checkEquivalence(
  sources: string[],
  top: string,
  verilog: string,
  library: Library,
): LecReport {
  if (!/^[A-Za-z_][\w]*$/.test(top))
    return { proved: false, text: `lec failed: illegal top name ${top}` };
  const dir = mkdtempSync(join(tmpdir(), "sift-lec-"));
  try {
    const abs = sources.map((source) => (isAbsolute(source) ? source : resolve(source)));
    writeFileSync(
      join(dir, "src.v"),
      `${abs.map((source) => `\`include ${yosysQuote(source)}`).join("\n")}\n`,
    );
    const elaborated = runYosys(
      [
        `read_verilog -sv src.v`,
        `hierarchy -top ${top}`,
        `rename ${top} ${top}_rtl`,
        `tee -o dump.il dump`,
        `write_rtlil rtl.il`,
        ``,
      ].join("\n"),
      dir,
    );
    if (elaborated.status !== 0)
      return { proved: false, text: `lec failed to elaborate ${top}\n${tailOf(elaborated.log)}` };
    const ports = rtlPorts(readFileSync(join(dir, "dump.il"), "utf8"), top);
    const gate = mappedModule(gateSource(verilog));
    writeFileSync(join(dir, "cells.v"), cellModels(library));
    writeFileSync(join(dir, "gate.v"), gateSource(verilog));
    writeFileSync(join(dir, "wrap.v"), wrappers(top, gate, ports));
    const prepared = runYosys(
      [
        `read_rtlil rtl.il`,
        `read_verilog -sv cells.v gate.v wrap.v`,
        `hierarchy -top gold`,
        `proc -norom`,
        `memory -nomap -norom`,
        `memory_map`,
        `flatten`,
        `async2sync`,
        `techmap`,
        `opt_merge`,
        `opt_clean`,
        `expose -dff`,
        `splitnets -ports`,
        `write_rtlil gold_prep.il`,
        `design -reset`,
        `read_verilog -sv cells.v gate.v wrap.v`,
        `hierarchy -top gate`,
        `proc`,
        `flatten`,
        `async2sync`,
        `techmap`,
        `opt_clean`,
        `expose -dff`,
        `splitnets -ports`,
        `write_rtlil gate_prep.il`,
        ``,
      ].join("\n"),
      dir,
    );
    if (prepared.status !== 0)
      return { proved: false, text: `lec failed to prepare ${top}\n${tailOf(prepared.log)}` };
    const paired = pairState(
      readFileSync(join(dir, "gold_prep.il"), "utf8"),
      readFileSync(join(dir, "gate_prep.il"), "utf8"),
    );
    if ("error" in paired) return { proved: false, text: paired.error };
    const goldCut = cutFlops(paired.gold);
    const gateCut = cutFlops(paired.gate);
    if ("error" in goldCut) return { proved: false, text: goldCut.error };
    if ("error" in gateCut) return { proved: false, text: gateCut.error };
    const policy = hasUndef(goldCut.text) && hasUndef(gateCut.text) ? "free" : "zero";
    const goldBits = tieUndef(goldCut.text, policy);
    const gateBits = tieUndef(gateCut.text, policy);
    if ("error" in goldBits) return { proved: false, text: goldBits.error };
    if ("error" in gateBits) return { proved: false, text: gateBits.error };
    const goldText = tieConstOutputs(
      stripUndrivenOutputs(
        goldBits.tied || gateBits.tied ? addUndefPort(goldBits.text) : goldBits.text,
      ),
      dir,
      "gold",
    );
    const gateText = tieConstOutputs(
      stripUndrivenOutputs(
        gateBits.tied || gateBits.tied ? addUndefPort(gateBits.text) : gateBits.text,
      ),
      dir,
      "gate",
    );
    writeFileSync(join(dir, "gold_cut.il"), goldText);
    writeFileSync(join(dir, "gate_cut.il"), gateText);
    const aigered = runYosys(
      [
        `read_rtlil gold_cut.il`,
        `opt_clean`,
        `setundef -undriven -zero`,
        `aigmap`,
        `write_aiger -symbols -map gold.map gold.aig`,
        `design -reset`,
        `read_rtlil gate_cut.il`,
        `opt_clean`,
        `setundef -undriven -zero`,
        `aigmap`,
        `write_aiger -symbols -map gate.map gate.aig`,
        ``,
      ].join("\n"),
      dir,
    );
    if (aigered.status !== 0)
      return { proved: false, text: `lec failed to write the miter\n${tailOf(aigered.log)}` };
    const goldIn = aigerPorts(readFileSync(join(dir, "gold.map"), "utf8"), "input");
    const gateIn = aigerPorts(readFileSync(join(dir, "gate.map"), "utf8"), "input");
    const goldOut = aigerPorts(readFileSync(join(dir, "gold.map"), "utf8"), "output");
    const gateOut = aigerPorts(readFileSync(join(dir, "gate.map"), "utf8"), "output");
    if (!samePorts(goldIn, gateIn) || !samePorts(goldOut, gateOut)) {
      const show = (label: string, left: string[], right: string[]): string => {
        const n = Math.max(left.length, right.length);
        const diff: string[] = [];
        for (let index = 0; index < n && diff.length < 8; index += 1) {
          if (left[index] !== right[index]) diff.push(`${left[index] ?? "-"}/${right[index] ?? "-"}`);
        }
        return `${label} ${left.length}/${right.length}${diff.length ? `: ${diff.join(", ")}` : ""}`;
      };
      return {
        proved: false,
        text: `lec failed: gold and gate ports do not line up; ${show("in", goldIn, gateIn)}; ${show("out", goldOut, gateOut)}`,
      };
    }
    const abc = spawnSync(abcBin(), ["-c", "&r gold.aig; &cec gate.aig"], {
      encoding: "utf8",
      cwd: dir,
      maxBuffer: 32 * 1024 * 1024,
    });
    const log = `${abc.stdout ?? ""}${abc.stderr ?? ""}`;
    if (abc.error) {
      const missing = (abc.error as NodeJS.ErrnoException).code === "ENOENT";
      return { proved: false, text: missing ? "Yosys ABC was not found." : abc.error.message };
    }
    const proved = /Networks are equivalent\./.test(log);
    return { proved, text: proved ? "lec proved" : `lec failed\n${tailOf(log)}` };
  } finally {
    if (process.env.SIFT_LEC_KEEP !== "1") rmSync(dir, { recursive: true, force: true });
  }
}
