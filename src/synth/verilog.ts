import {
  addBits,
  adderKind,
  divBits,
  dividerKind,
  mulBits,
  multiplierKind,
  type ArithMode,
} from "./arith.ts";
import {
  parseNetlist,
  sweepState,
  validate,
  type AdderSite,
  type Gate,
  type Netlist,
  type Op,
  type SweptFlop,
} from "./netlist.ts";

export class VerilogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerilogError";
  }
}

const MAX_WIDTH = 512;

type Expr =
  | { kind: "ref"; name: string; hi: number | null; lo: number | null }
  | { kind: "const"; value: number; width: number | null; wild?: number }
  | { kind: "not"; arg: Expr }
  | {
      kind:
        | "and"
        | "or"
        | "xor"
        | "add"
        | "sub"
        | "mul"
        | "div"
        | "mod"
        | "shl"
        | "shr"
        | "ashl"
        | "ashr";
      left: Expr;
      right: Expr;
    }
  | { kind: "eq" | "ne" | "lt" | "gt" | "le" | "ge"; left: Expr; right: Expr }
  | { kind: "mux"; sel: Expr; yes: Expr; no: Expr }
  | { kind: "concat"; parts: Expr[] }
  | { kind: "rep"; count: CExpr; inner: Expr }
  | { kind: "index"; name: string; index: Expr }
  | { kind: "word"; name: string; index: Expr; hi: Expr; lo: Expr }
  | { kind: "lognot"; arg: Expr }
  | { kind: "logand" | "logor"; left: Expr; right: Expr }
  | { kind: "reduce"; op: "and" | "or" | "xor" | "nand" | "nor" | "xnor"; arg: Expr }
  | { kind: "slice"; name: string; base: Expr; width: CExpr; up: boolean }
  | { kind: "part"; name: string; hi: Expr; lo: Expr };

interface SliceSel {
  base: Expr;
  width: CExpr;
  up: boolean;
}

type Stmt =
  | { kind: "block"; body: Stmt[] }
  | {
      kind: "set";
      target: string;
      hi: number | null;
      lo: number | null;
      index: Expr | null;
      slice: SliceSel | null;
      part: { hi: Expr; lo: Expr } | null;
      expr: Expr;
      blocking: boolean;
      line: number;
    }
  | {
      kind: "join";
      parts: { name: string; hi: number | null; lo: number | null }[];
      expr: Expr;
      blocking: boolean;
      line: number;
    }
  | { kind: "if"; cond: Expr; yes: Stmt[]; no: Stmt[]; line: number }
  | {
      kind: "case";
      sel: Expr;
      arms: {
        labels: { value: number; width: number | null; wild?: number; name?: string }[];
        body: Stmt[];
      }[];
      full: boolean;
      line: number;
    }
  | {
      kind: "for";
      name: string;
      init: CExpr;
      rel: "<" | "<=" | ">" | ">=";
      bound: CExpr;
      dir: 1 | -1;
      step: CExpr;
      body: Stmt[];
      line: number;
    };

interface Token {
  kind: "id" | "num" | "sym" | "eof";
  text: string;
  line: number;
  value?: number;
  width?: number | null;
  /** Bit mask of x, z, or ? digits. A set bit is don't-care. */
  wild?: number;
  lead?: string;
}

interface Sig {
  name: string;
  source: string;
  dir: "input" | "output" | "local";
  reg: boolean;
  signed: boolean;
  msb: number;
  lsb: number;
  scalar: boolean;
  memLo: number | null;
  memHi: number | null;
  line: number;
}

interface Item {
  kind: "assign" | "always" | "instance" | "genfor" | "genif";
  seq: boolean;
  target?: string;
  hi?: number | null;
  lo?: number | null;
  index?: Expr | null;
  slice?: SliceSel | null;
  part?: { hi: Expr; lo: Expr } | null;
  expr?: Expr;
  body?: Stmt[];
  rst?: string | null;
  rstLevel?: 0 | 1;
  module?: string;
  inst?: string;
  params?: { name: string; value: CExpr }[];
  joins?: { name: string; hi: number | null; lo: number | null }[];
  conns?: { port: string; expr: Expr; line: number }[];
  gen?: string;
  init?: CExpr;
  rel?: "<" | "<=" | ">" | ">=";
  bound?: CExpr;
  dir?: 1 | -1;
  step?: CExpr;
  items?: Item[];
  yes?: Item[];
  no?: Item[];
  condExpr?: CExpr;
  line: number;
}

type CExpr =
  | { kind: "num"; value: number; width?: number | null }
  | { kind: "name"; name: string }
  | { kind: "add" | "sub" | "mul" | "div" | "mod"; left: CExpr; right: CExpr }
  | { kind: "lt" | "le" | "gt" | "ge" | "eq" | "ne"; left: CExpr; right: CExpr };

interface RangeAst {
  msb: CExpr;
  lsb: CExpr;
}

interface ModuleAst {
  name: string;
  params: { name: string; value: CExpr }[];
  locals: { name: string; value: CExpr }[];
  ports: {
    dir: "input" | "output";
    reg: boolean;
    logic: boolean;
    signed: boolean;
    range: RangeAst | null;
    names: string[];
    line: number;
    /** Non-ANSI name, waiting for an input or output declaration. */
    open?: boolean;
  }[];
  decls: {
    reg: boolean;
    logic: boolean;
    signed: boolean;
    range: RangeAst | null;
    names: { name: string; mem: RangeAst | null }[];
    line: number;
  }[];
  integers: string[];
  items: Item[];
}

const LATER: Record<string, string> = {};

export function looksLikeVerilog(text: string): boolean {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .trimStart();
  return stripped.startsWith("module") || stripped.startsWith("`");
}

export function loadDesign(
  text: string,
  mode: ArithMode = "area",
  options?: { dir?: string; read?: (path: string) => string; top?: string },
): Netlist {
  return looksLikeVerilog(text) ? parseVerilog(text, { mode, ...options }) : parseNetlist(text);
}

export function parseVerilog(
  source: string,
  options?: { mode?: ArithMode; dir?: string; read?: (path: string) => string; top?: string },
): Netlist {
  return parseSources([{ text: source, dir: options?.dir ?? "" }], options);
}

export function parseSources(
  sources: { text: string; dir: string }[],
  options?: { mode?: ArithMode; read?: (path: string) => string; top?: string },
): Netlist {
  const macros = new Map<string, Macro>();
  const text = sources
    .map((source) => preprocess(source.text, source.dir, options?.read, macros, []))
    .join("\n");
  return new Parser(text, options?.mode ?? "area").parseFile(options?.top);
}

interface Macro {
  params: string[] | null;
  body: string;
}

interface Branch {
  hot: boolean;
  taken: boolean;
  elseSeen: boolean;
}

const LINE_DIRECTIVES = new Set([
  "timescale",
  "default_nettype",
  "resetall",
  "celldefine",
  "endcelldefine",
  "unconnected_drive",
  "nounconnected_drive",
  "protect",
  "endprotect",
  "begin_keywords",
  "end_keywords",
]);

function preprocess(
  source: string,
  dir: string,
  read: ((path: string) => string) | undefined,
  macros: Map<string, Macro>,
  stack: string[],
  expanding: string[] = [],
): string {
  if (expanding.length > 16) throw new VerilogError("macro expansion is nested too deeply");
  let out = "";
  let index = 0;
  let line = 1;
  const cond: Branch[] = [];
  const live = () => cond.every((branch) => branch.hot);
  const bump = (text: string) => {
    for (const ch of text) if (ch === "\n") line += 1;
  };
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      const chunk = end < 0 ? source.slice(index) : source.slice(index, end);
      if (live()) out += chunk;
      bump(chunk);
      index += chunk.length;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new VerilogError("unterminated comment");
      const chunk = source.slice(index, end + 2);
      if (live()) out += chunk;
      bump(chunk);
      index = end + 2;
      continue;
    }
    if (source[index] === '"') {
      const end = source.indexOf('"', index + 1);
      if (end < 0) throw new VerilogError(`line ${line}: unterminated string`);
      const chunk = source.slice(index, end + 1);
      if (live()) out += chunk;
      index = end + 1;
      continue;
    }
    if (source[index] === "`") {
      const ident = readIdent(source, index + 1);
      if (!ident) throw new VerilogError(`line ${line}: expected a macro name`);
      index = ident.index;
      const name = ident.name;
      if (name === "define") {
        const defined = readDefine(source, index, line);
        if (live()) macros.set(defined.name, { params: defined.params, body: defined.body });
        bump(source.slice(index, defined.index));
        index = defined.index;
        continue;
      }
      if (name === "undef") {
        const id = readIdent(source, skipHorizontal(source, index));
        if (!id) throw new VerilogError(`line ${line}: \`undef needs a name`);
        if (live()) macros.delete(id.name);
        index = id.index;
        continue;
      }
      if (name === "ifdef" || name === "ifndef" || name === "elsif") {
        const id = readIdent(source, skipHorizontal(source, index));
        if (!id) throw new VerilogError(`line ${line}: \`${name} needs a name`);
        const on = macros.has(id.name);
        if (name === "elsif") {
          const top = cond[cond.length - 1];
          if (!top || top.elseSeen) throw new VerilogError(`line ${line}: \`elsif without \`ifdef`);
          const parent = cond.slice(0, -1).every((branch) => branch.hot);
          top.hot = parent && !top.taken && (name === "elsif" ? on : false);
          if (top.hot) top.taken = true;
        } else {
          const parent = live();
          const hot = parent && (name === "ifdef" ? on : !on);
          cond.push({ hot, taken: hot, elseSeen: false });
        }
        index = id.index;
        continue;
      }
      if (name === "else") {
        const top = cond[cond.length - 1];
        if (!top || top.elseSeen) throw new VerilogError(`line ${line}: \`else without \`ifdef`);
        const parent = cond.slice(0, -1).every((branch) => branch.hot);
        top.elseSeen = true;
        top.hot = parent && !top.taken;
        top.taken = true;
        continue;
      }
      if (name === "endif") {
        if (cond.length === 0) throw new VerilogError(`line ${line}: \`endif without \`ifdef`);
        cond.pop();
        continue;
      }
      if (name === "include") {
        const opened = readIncludeName(source, index, line);
        bump(source.slice(index, opened.index));
        index = opened.index;
        if (!live()) continue;
        if (!read) throw new VerilogError("`include needs a source file");
        const path = resolvePath(dir, opened.name);
        if (stack.includes(path)) throw new VerilogError(`\`include cycle at '${opened.name}'`);
        if (stack.length > 16) throw new VerilogError("`include is nested too deeply");
        let text = "";
        try {
          text = read(path);
        } catch {
          throw new VerilogError(`cannot read \`include '${opened.name}'`);
        }
        const child = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        out += preprocess(text, child, read, macros, [...stack, path]);
        continue;
      }
      if (LINE_DIRECTIVES.has(name)) {
        const end = source.indexOf("\n", index);
        const chunk = end < 0 ? source.slice(index) : source.slice(index, end);
        bump(chunk);
        index += chunk.length;
        continue;
      }
      const macro = macros.get(name);
      if (!macro) {
        if (!live()) continue;
        throw new VerilogError(`line ${line}: unknown macro '${name}'`);
      }
      if (!live()) {
        if (macro.params) {
          const skipped = skipCall(source, index);
          bump(source.slice(index, skipped));
          index = skipped;
        }
        continue;
      }
      if (expanding.includes(name))
        throw new VerilogError(`line ${line}: macro '${name}' expands itself`);
      let body = macro.body;
      if (macro.params) {
        const call = readCall(source, index, line);
        if (call.args.length !== macro.params.length) {
          throw new VerilogError(
            `line ${line}: macro '${name}' needs ${macro.params.length} arguments`,
          );
        }
        bump(source.slice(index, call.index));
        index = call.index;
        body = substitute(body, macro.params, call.args);
      }
      out += preprocess(body, dir, read, macros, stack, [...expanding, name]);
      continue;
    }
    if (live()) out += source[index] ?? "";
    else if (source[index] === "\n") out += "\n";
    if (source[index] === "\n") line += 1;
    index += 1;
  }
  if (cond.length > 0) throw new VerilogError("missing `endif");
  return out;
}

function readDefine(
  source: string,
  index: number,
  line: number,
): { name: string; params: string[] | null; body: string; index: number } {
  const ident = readIdent(source, skipHorizontal(source, index));
  if (!ident) throw new VerilogError(`line ${line}: \`define needs a name`);
  let cursor = ident.index;
  let params: string[] | null = null;
  if (source[cursor] === "(") {
    const parsed = readParams(source, cursor + 1, line);
    params = parsed.params;
    cursor = parsed.index;
  }
  let body = "";
  while (cursor < source.length && source[cursor] !== "\n") {
    if (source[cursor] === "\\" && source[cursor + 1] === "\n") {
      cursor += 2;
      continue;
    }
    if (source.startsWith("//", cursor)) break;
    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      if (end < 0) throw new VerilogError(`line ${line}: unterminated comment`);
      cursor = end + 2;
      continue;
    }
    body += source[cursor] ?? "";
    cursor += 1;
  }
  return { name: ident.name, params, body: body.trim(), index: cursor };
}

function readParams(
  source: string,
  index: number,
  line: number,
): { params: string[]; index: number } {
  const params: string[] = [];
  let cursor = index;
  if (source[cursor] === ")") return { params, index: cursor + 1 };
  while (cursor < source.length) {
    cursor = skipHorizontal(source, cursor);
    const ident = readIdent(source, cursor);
    if (!ident) throw new VerilogError(`line ${line}: \`define needs a parameter name`);
    params.push(ident.name);
    cursor = skipHorizontal(source, ident.index);
    if (source[cursor] === ",") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === ")") return { params, index: cursor + 1 };
    throw new VerilogError(`line ${line}: \`define parameter list needs ')'`);
  }
  throw new VerilogError(`line ${line}: unterminated \`define`);
}

function readIncludeName(
  source: string,
  index: number,
  line: number,
): { name: string; index: number } {
  const cursor = skipHorizontal(source, index);
  const open = source[cursor];
  if (open !== '"' && open !== "<")
    throw new VerilogError(`line ${line}: \`include needs a file name`);
  const close = open === "<" ? ">" : '"';
  const end = source.indexOf(close, cursor + 1);
  if (end < 0) throw new VerilogError(`line ${line}: unterminated \`include`);
  return { name: source.slice(cursor + 1, end), index: end + 1 };
}

function readCall(source: string, index: number, line: number): { args: string[]; index: number } {
  const cursor = skipHorizontal(source, index);
  if (source[cursor] !== "(") throw new VerilogError(`line ${line}: macro needs '('`);
  return readArgList(source, cursor + 1, line);
}

function readArgList(
  source: string,
  index: number,
  line: number,
): { args: string[]; index: number } {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let cursor = index;
  if (source[cursor] === ")") return { args, index: cursor + 1 };
  while (cursor < source.length) {
    const ch = source[cursor] ?? "";
    if (ch === '"') {
      const end = source.indexOf('"', cursor + 1);
      if (end < 0) throw new VerilogError(`line ${line}: unterminated string`);
      current += source.slice(cursor, end + 1);
      cursor = end + 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      current += ch;
      cursor += 1;
      continue;
    }
    if (ch === ")" && depth === 0) {
      args.push(current.trim());
      return { args, index: cursor + 1 };
    }
    if (ch === ")") {
      depth -= 1;
      current += ch;
      cursor += 1;
      continue;
    }
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      cursor += 1;
      continue;
    }
    if (ch === "\n") throw new VerilogError(`line ${line}: unterminated macro call`);
    current += ch;
    cursor += 1;
  }
  throw new VerilogError(`line ${line}: unterminated macro call`);
}

function skipCall(source: string, index: number): number {
  const cursor = skipHorizontal(source, index);
  if (source[cursor] !== "(") return index;
  try {
    return readArgList(source, cursor + 1, 0).index;
  } catch {
    return index;
  }
}

function substitute(body: string, params: string[], args: string[]): string {
  const map = new Map(params.map((name, index) => [name, args[index] ?? ""]));
  let out = "";
  let index = 0;
  while (index < body.length) {
    if (body[index] === '"') {
      const end = body.indexOf('"', index + 1);
      const chunk = end < 0 ? body.slice(index) : body.slice(index, end + 1);
      out += chunk;
      index += chunk.length;
      continue;
    }
    const ident = readIdent(body, index);
    if (
      ident &&
      ident.index > index &&
      body[index] !== undefined &&
      /[A-Za-z_]/.test(body[index] ?? "")
    ) {
      out += map.get(ident.name) ?? ident.name;
      index = ident.index;
      continue;
    }
    out += body[index] ?? "";
    index += 1;
  }
  return out;
}

function readIdent(source: string, index: number): { name: string; index: number } | null {
  if (!/[A-Za-z_]/.test(source[index] ?? "")) return null;
  let end = index + 1;
  while (/[A-Za-z0-9_$]/.test(source[end] ?? "")) end += 1;
  return { name: source.slice(index, end), index: end };
}

function skipHorizontal(source: string, index: number): number {
  while (source[index] === " " || source[index] === "\t") index += 1;
  return index;
}

function resolvePath(dir: string, file: string): string {
  if (file.startsWith("/")) return normalizePath(file);
  return normalizePath(dir ? `${dir}/${file}` : file);
}

function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function selectTop(modules: ModuleAst[], topName: string | undefined): ModuleAst {
  if (topName) {
    const found = modules.find((mod) => mod.name === topName);
    if (!found) throw new VerilogError(`unknown module '${topName}'`);
    return found;
  }
  const used = new Set<string>();
  for (const mod of modules) collectInstances(mod.items, used);
  const roots = modules.filter((mod) => !used.has(mod.name));
  return roots[roots.length - 1] ?? modules[modules.length - 1]!;
}

function collectInstances(items: Item[], used: Set<string>): void {
  for (const item of items) {
    if (item.kind === "instance" && item.module) used.add(item.module);
    if (item.items) collectInstances(item.items, used);
    if (item.yes) collectInstances(item.yes, used);
    if (item.no) collectInstances(item.no, used);
  }
}

function linearOf(
  expr: Expr,
  scope: ReadonlyMap<string, number>,
): { k: number; terms: Map<string, number> } | null {
  if (expr.kind === "const") return { k: expr.value, terms: new Map() };
  if (expr.kind === "ref" && expr.hi === null) {
    if (scope.has(expr.name)) return { k: scope.get(expr.name) ?? 0, terms: new Map() };
    return { k: 0, terms: new Map([[expr.name, 1]]) };
  }
  if (expr.kind === "add" || expr.kind === "sub") {
    const left = linearOf(expr.left, scope);
    const right = linearOf(expr.right, scope);
    if (!left || !right) return null;
    const sign = expr.kind === "add" ? 1 : -1;
    const terms = new Map(left.terms);
    for (const [name, coeff] of right.terms) {
      const next = (terms.get(name) ?? 0) + sign * coeff;
      if (next === 0) terms.delete(name);
      else terms.set(name, next);
    }
    return { k: left.k + sign * right.k, terms };
  }
  if (expr.kind === "mul") {
    const left = linearOf(expr.left, scope);
    const right = linearOf(expr.right, scope);
    if (!left || !right) return null;
    if (left.terms.size === 0) return scaleLinear(right, left.k);
    if (right.terms.size === 0) return scaleLinear(left, right.k);
  }
  return null;
}

function scaleLinear(
  value: { k: number; terms: Map<string, number> },
  factor: number,
): { k: number; terms: Map<string, number> } {
  const terms = new Map<string, number>();
  for (const [name, coeff] of value.terms) {
    const next = coeff * factor;
    if (next !== 0) terms.set(name, next);
  }
  return { k: value.k * factor, terms };
}

class Parser {
  private readonly source: string;
  private index = 0;
  private line = 1;
  private readonly buf: Token[] = [];
  private sigs = new Map<string, Sig>();
  private order: Sig[] = [];
  private alias = new Map<string, string>();
  private readonly mode: ArithMode;
  private readonly notes: string[] = [];
  private tempSeq = 0;
  private depth = 0;
  private prefix = "";
  private modules: ModuleAst[] = [];
  private readonly stack: string[] = [];
  private constParams = new Map<string, number>();
  /** Self-determined width of a parameter whose value is a sized constant. */
  private paramWidths = new Map<string, number>();
  private integers = new Set<string>();
  private loopVars = new Map<string, number>();
  private genSuffix = "";
  private pendingDecls: ModuleAst["decls"] = [];
  private pendingIntegers: string[] = [];

  constructor(source: string, mode: ArithMode) {
    this.source = source;
    this.mode = mode;
  }

  parseFile(topName?: string): Netlist {
    const modules: ModuleAst[] = [];
    while (this.peek().kind !== "eof") modules.push(this.parseOne());
    if (modules.length === 0) throw this.fail("expected module");
    const seen = new Set<string>();
    for (const mod of modules) {
      if (seen.has(mod.name)) throw new VerilogError(`module '${mod.name}' is already defined`);
      seen.add(mod.name);
    }
    this.modules = modules;
    const top = selectTop(modules, topName);
    const params = new Map<string, number>();
    const widths = new Map<string, number>();
    for (const param of top.params) this.bindValue(param.name, param.value, params, widths, params);
    for (const local of top.locals) {
      if (params.has(local.name))
        throw new VerilogError(`localparam '${local.name}' is already defined`);
      this.bindValue(local.name, local.value, params, widths, params);
    }
    this.paramWidths = widths;
    this.define(top, params, "");
    return this.elaborate(top.name, top.items, params);
  }

  private parseOne(): ModuleAst {
    this.expect("id", "module");
    const name = this.expect("id").text;
    const params: { name: string; value: CExpr }[] = [];
    if (this.eat("#")) {
      this.expect("sym", "(");
      while (this.peek().text !== ")") {
        this.expect("id", "parameter");
        const param = this.expect("id").text;
        this.expect("sym", "=");
        params.push({ name: param, value: this.parseConstExpr() });
        if (this.peek().text === ",") this.next();
      }
      this.expect("sym", ")");
    }
    this.expect("sym", "(");
    const ports = this.parsePortAst();
    this.expect("sym", ")");
    this.expect("sym", ";");
    this.pendingDecls = [];
    this.pendingIntegers = [];
    const decls: ModuleAst["decls"] = [];
    const integers: string[] = [];
    const items: Item[] = [];
    const locals: ModuleAst["locals"] = [];
    while (this.peek().text !== "endmodule") {
      if (this.peek().kind === "eof") throw this.fail("expected endmodule");
      const word = this.peek().text;
      if (word === "integer" || word === "genvar") {
        const line = this.peek().line;
        this.next();
        for (const name of this.names()) {
          if (integers.includes(name)) throw this.fail(`'${name}' is already an integer`, line);
          integers.push(name);
        }
        this.expect("sym", ";");
        continue;
      }
      if (word === "initial") {
        this.next();
        this.parseStmt();
        continue;
      }
      if (word === "input" || word === "output") {
        const decl = this.parseOnePort();
        this.expect("sym", ";");
        for (const name of decl.names) {
          const port = ports.find(
            (item) => item.open && item.names.length === 1 && item.names[0] === name,
          );
          if (!port) throw this.fail(`'${name}' is not a port`, decl.line);
          port.dir = decl.dir;
          port.reg = decl.reg;
          port.logic = decl.logic;
          port.signed = decl.signed;
          port.range = decl.range;
          port.line = decl.line;
          port.open = false;
        }
        continue;
      }
      if (word === "wire" || word === "reg" || word === "logic") {
        const line = this.peek().line;
        const reg = word === "reg";
        const logic = word === "logic";
        this.next();
        if ((reg && this.peek().text === "logic") || (logic && this.peek().text === "reg"))
          throw this.fail("say reg or logic", line);
        let signed = false;
        if (this.eat("signed")) signed = true;
        const range = this.parseRange();
        if (this.eat("signed")) signed = true;
        const names = this.declNames();
        if (names.length === 1 && !names[0]?.mem && this.peek().text === "=") {
          if (reg) throw this.fail("a reg initializer is later", line);
          this.next();
          const expr = this.parseExpr();
          items.push({
            kind: "assign",
            seq: false,
            target: names[0].name,
            hi: null,
            lo: null,
            index: null,
            slice: null,
            part: null,
            expr,
            line,
          });
        }
        const known = names.every((item) =>
          ports.some(
            (port) => !port.open && port.names.length === 1 && port.names[0] === item.name,
          ),
        );
        if (known && names.length > 0) {
          for (const item of names) {
            const port = ports.find(
              (port) => port.names.length === 1 && port.names[0] === item.name,
            );
            if (!port) continue;
            if (item.mem) throw this.fail("a memory cannot be a port", line);
            if (reg && port.dir === "input") throw this.fail("an input cannot be a reg", line);
            if (reg) port.reg = true;
            if (logic) port.logic = true;
            if (signed) port.signed = true;
            if (range && !port.range) port.range = range;
          }
        } else decls.push({ reg, logic, signed, range, names, line });
        this.expect("sym", ";");
        continue;
      }
      if (word === "localparam" || word === "parameter") {
        locals.push(...this.parseLocals());
        continue;
      }
      if (word === "assign") {
        const line = this.peek().line;
        this.next();
        if (this.eat("{")) {
          const joins: { name: string; hi: number | null; lo: number | null }[] = [];
          while (this.peek().text !== "}") {
            if (this.peek().kind === "eof") throw this.fail("expected }");
            const lhs = this.parseLhs();
            if (lhs.index || lhs.slice || lhs.part)
              throw this.fail("that left-hand side is later", lhs.line);
            joins.push({ name: lhs.name, hi: lhs.hi, lo: lhs.lo });
            if (!this.eat(",")) break;
          }
          this.expect("sym", "}");
          this.expect("sym", "=");
          const expr = this.parseExpr();
          this.notYet();
          this.expect("sym", ";");
          items.push({
            kind: "assign",
            seq: false,
            joins,
            expr,
            line,
          });
          continue;
        }
        const lhs = this.parseLhs();
        this.expect("sym", "=");
        const expr = this.parseExpr();
        this.notYet();
        this.expect("sym", ";");
        items.push({
          kind: "assign",
          seq: false,
          target: lhs.name,
          hi: lhs.hi,
          lo: lhs.lo,
          index: lhs.index,
          slice: lhs.slice,
          part: lhs.part,
          expr,
          line,
        });
        continue;
      }
      if (word === "always" || word === "always_comb" || word === "always_ff") {
        items.push(this.parseAlways());
        continue;
      }
      if (word === "generate") {
        this.next();
        while (this.peek().text !== "endgenerate") {
          if (this.peek().kind === "eof") throw this.fail("expected endgenerate");
          if (this.peek().text === "begin") items.push(...this.parseGenBlock());
          else items.push(this.parseGenItem());
        }
        this.next();
        continue;
      }
      if (word === "for") {
        items.push(this.parseGenFor());
        continue;
      }
      if (word === "if") {
        items.push(this.parseGenIf());
        continue;
      }
      if (this.peek().kind === "id" && (this.peek(1).text === "#" || this.peek(1).kind === "id")) {
        items.push(this.parseInstance());
        continue;
      }
      if (word === "case") throw this.fail(`${word} is later`);
      throw this.fail(`unexpected '${word || "token"}'`);
    }
    this.next();
    const pending = ports.find((port) => port.open);
    if (pending?.names[0]) throw this.fail(`'${pending.names[0]}' has no direction`, pending.line);
    const mod: ModuleAst = {
      name,
      params,
      locals,
      ports,
      decls: [...decls, ...this.pendingDecls],
      integers: [...integers, ...this.pendingIntegers.filter((name) => !integers.includes(name))],
      items,
    };
    this.settleLogic(mod);
    return mod;
  }

  private parseLocals(): { name: string; value: CExpr }[] {
    this.next();
    this.eat("signed");
    this.parseRange();
    this.eat("signed");
    const locals: { name: string; value: CExpr }[] = [];
    for (;;) {
      const name = this.expect("id").text;
      this.expect("sym", "=");
      locals.push({ name, value: this.parseConstExpr() });
      if (!this.eat(",")) break;
    }
    this.expect("sym", ";");
    return locals;
  }

  private settleLogic(mod: ModuleAst): void {
    const targets = new Set<string>();
    const walkItems = (items: Item[]) => {
      for (const item of items) {
        if (item.kind === "always" && item.body) walkStmts(item.body);
        if (item.kind === "genfor" && item.items) walkItems(item.items);
        if (item.kind === "genif") {
          if (item.yes) walkItems(item.yes);
          if (item.no) walkItems(item.no);
        }
      }
    };
    const walkStmts = (stmts: Stmt[]) => {
      for (const stmt of stmts) {
        if (stmt.kind === "set") targets.add(stmt.target);
        else if (stmt.kind === "join") for (const part of stmt.parts) targets.add(part.name);
        else if (stmt.kind === "block") walkStmts(stmt.body);
        else if (stmt.kind === "if") {
          walkStmts(stmt.yes);
          walkStmts(stmt.no);
        } else if (stmt.kind === "case") {
          for (const arm of stmt.arms) walkStmts(arm.body);
        } else if (stmt.kind === "for") walkStmts(stmt.body);
      }
    };
    walkItems(mod.items);
    const decls: ModuleAst["decls"] = [];
    for (const decl of mod.decls) {
      if (!decl.logic) {
        decls.push(decl);
        continue;
      }
      const regs = decl.names.filter((item) => targets.has(item.name));
      const nets = decl.names.filter((item) => !targets.has(item.name));
      if (regs.length > 0) decls.push({ ...decl, reg: true, names: regs });
      if (nets.length > 0) decls.push({ ...decl, reg: false, names: nets });
    }
    mod.decls = decls;
    const ports: ModuleAst["ports"] = [];
    for (const port of mod.ports) {
      if (port.reg && port.logic) throw new VerilogError(`line ${port.line}: say reg or logic`);
      if (!port.logic) {
        ports.push(port);
        continue;
      }
      const regs = port.names.filter((name) => targets.has(name));
      const nets = port.names.filter((name) => !targets.has(name));
      if (regs.length > 0 && port.dir === "input")
        throw new VerilogError(`line ${port.line}: an input cannot be a reg`);
      if (regs.length > 0) ports.push({ ...port, reg: true, names: regs });
      if (nets.length > 0) ports.push({ ...port, reg: false, names: nets });
    }
    mod.ports = ports;
  }

  private parseInstance(): Item {
    const line = this.peek().line;
    const module = this.expect("id").text;
    const params: { name: string; value: CExpr }[] = [];
    if (this.eat("#")) {
      this.expect("sym", "(");
      if (this.peek().text === ".") {
        while (this.peek().text !== ")") {
          this.expect("sym", ".");
          const name = this.expect("id").text;
          this.expect("sym", "(");
          params.push({ name, value: this.parseConstExpr() });
          this.expect("sym", ")");
          if (this.peek().text === ",") this.next();
        }
      } else {
        while (this.peek().text !== ")") {
          params.push({ name: "", value: this.parseConstExpr() });
          if (this.peek().text === ",") this.next();
        }
      }
      this.expect("sym", ")");
    }
    const inst = this.expect("id").text;
    this.expect("sym", "(");
    const conns: { port: string; expr: Expr; line: number }[] = [];
    while (this.peek().text !== ")") {
      if (this.peek().kind === "eof") throw this.fail("expected )");
      this.expect("sym", ".");
      const port = this.expect("id").text;
      this.expect("sym", "(");
      const expr = this.parseExpr();
      this.notYet();
      this.expect("sym", ")");
      conns.push({ port, expr, line: this.peek().line });
      if (this.peek().text === ",") this.next();
    }
    this.expect("sym", ")");
    this.expect("sym", ";");
    return { kind: "instance", seq: false, module, inst, params, conns, line };
  }

  private parsePortAst(): ModuleAst["ports"] {
    const ports: ModuleAst["ports"] = [];
    if (this.peek().text === ")") return ports;
    if (this.peek().text !== "input" && this.peek().text !== "output") {
      const line = this.peek().line;
      return this.names().map((name) => ({
        dir: "input" as const,
        reg: false,
        logic: false,
        signed: false,
        range: null,
        names: [name],
        line,
        open: true,
      }));
    }
    while (this.peek().text !== ")") {
      ports.push(this.parseOnePort());
      if (this.peek().text === ",") this.next();
    }
    return ports;
  }

  private portFlags(): { reg: boolean; logic: boolean; signed: boolean } {
    let reg = false;
    let logic = false;
    let signed = false;
    for (;;) {
      if (!logic && this.eat("logic")) {
        logic = true;
        continue;
      }
      if (!reg && this.eat("reg")) {
        reg = true;
        continue;
      }
      if (!signed && this.eat("signed")) {
        signed = true;
        continue;
      }
      if (this.eat("wire")) continue;
      break;
    }
    return { reg, logic, signed };
  }

  private parseOnePort(): ModuleAst["ports"][number] {
    const dirTok = this.peek();
    if (dirTok.text !== "input" && dirTok.text !== "output")
      throw this.fail("expected input or output");
    this.next();
    const before = this.portFlags();
    const range = this.parseRange();
    const after = this.portFlags();
    const reg = before.reg || after.reg;
    const logic = before.logic || after.logic;
    const signed = before.signed || after.signed;
    if (reg && logic) throw this.fail("say reg or logic", dirTok.line);
    if (dirTok.text === "input" && reg) throw this.fail("an input cannot be a reg", dirTok.line);
    return {
      dir: dirTok.text,
      reg,
      logic,
      signed,
      range,
      names: this.names(),
      line: dirTok.line,
    };
  }

  private define(mod: ModuleAst, params: Map<string, number>, prefix: string): void {
    this.declareImplicit(mod);
    this.sigs = new Map();
    this.order = [];
    this.alias = new Map();
    this.prefix = prefix;
    this.integers = new Set(mod.integers);
    const add = (
      names: string[],
      dir: Sig["dir"],
      reg: boolean,
      signed: boolean,
      range: RangeAst | null,
      mem: RangeAst | null,
      line: number,
    ) => {
      const resolved = this.resolveRange(range, params, line);
      const depth = mem ? this.resolveMem(mem, params, line) : null;
      for (const name of names) {
        const id = name === "clk" ? "clk" : `${prefix}${name}`;
        this.alias.set(name, id);
        this.addSig(id, name, dir, reg, signed, resolved, depth, line);
      }
    };
    for (const port of mod.ports)
      add(port.names, port.dir, port.reg, port.signed, port.range, null, port.line);
    for (const decl of mod.decls) {
      for (const item of decl.names)
        add([item.name], "local", decl.reg, decl.signed, decl.range, item.mem, decl.line);
    }
    for (const name of this.integers) {
      if (this.alias.has(name)) throw new VerilogError(`'${name}' is already a net`);
    }
  }

  private declareImplicit(mod: ModuleAst): void {
    const known = new Set<string>();
    for (const port of mod.ports) for (const name of port.names) known.add(name);
    for (const decl of mod.decls) for (const item of decl.names) known.add(item.name);
    for (const local of mod.locals) known.add(local.name);
    for (const param of mod.params) known.add(param.name);
    for (const name of mod.integers) known.add(name);
    const add = (name: string | undefined, line: number) => {
      if (!name || known.has(name)) return;
      known.add(name);
      mod.decls.push({
        reg: false,
        logic: false,
        signed: false,
        range: null,
        names: [{ name, mem: null }],
        line,
      });
    };
    const walkExpr = (expr: Expr | undefined, line: number): void => {
      if (!expr) return;
      switch (expr.kind) {
        case "ref":
        case "index":
        case "word":
        case "slice":
        case "part":
          add(expr.name, line);
          if (expr.kind === "index" || expr.kind === "word") walkExpr(expr.index, line);
          if (expr.kind === "word") {
            walkExpr(expr.hi, line);
            walkExpr(expr.lo, line);
          } else if (expr.kind === "slice") walkExpr(expr.base, line);
          else if (expr.kind === "part") {
            walkExpr(expr.hi, line);
            walkExpr(expr.lo, line);
          }
          return;
        case "const":
          return;
        case "not":
        case "lognot":
        case "reduce":
          walkExpr(expr.arg, line);
          return;
        case "mux":
          walkExpr(expr.sel, line);
          walkExpr(expr.yes, line);
          walkExpr(expr.no, line);
          return;
        case "concat":
          for (const part of expr.parts) walkExpr(part, line);
          return;
        case "rep":
          walkExpr(expr.inner, line);
          return;
        default:
          walkExpr(expr.left, line);
          walkExpr(expr.right, line);
      }
    };
    const walkItems = (items: Item[]): void => {
      for (const item of items) {
        if (item.kind === "assign") {
          add(item.target, item.line);
          if (item.joins) for (const part of item.joins) add(part.name, item.line);
          if (item.index) walkExpr(item.index, item.line);
          if (item.slice) walkExpr(item.slice.base, item.line);
          if (item.part) {
            walkExpr(item.part.hi, item.line);
            walkExpr(item.part.lo, item.line);
          }
          walkExpr(item.expr, item.line);
        } else if (item.kind === "instance") {
          for (const conn of item.conns ?? []) walkExpr(conn.expr, conn.line);
        } else if (item.kind === "genfor" && item.items) walkItems(item.items);
        else if (item.kind === "genif") {
          if (item.yes) walkItems(item.yes);
          if (item.no) walkItems(item.no);
        }
      }
    };
    walkItems(mod.items);
  }

  private resolveRange(
    range: RangeAst | null,
    params: Map<string, number>,
    line: number,
  ): { msb: number; lsb: number } | null {
    if (!range) return null;
    const msb = evalConst(range.msb, params);
    const lsb = evalConst(range.lsb, params);
    if (msb < lsb) throw new VerilogError(`line ${line}: range must be [msb:lsb]`);
    if (msb - lsb + 1 > MAX_WIDTH)
      throw new VerilogError(`line ${line}: at most ${MAX_WIDTH} bits in this build`);
    return { msb, lsb };
  }

  private resolveMem(
    range: RangeAst,
    params: Map<string, number>,
    line: number,
  ): { lo: number; hi: number } {
    const left = evalConst(range.msb, params);
    const right = evalConst(range.lsb, params);
    const lo = Math.min(left, right);
    const hi = Math.max(left, right);
    const depth = hi - lo + 1;
    if (depth > 128) throw new VerilogError(`line ${line}: at most 128 words in this build`);
    return { lo, hi };
  }

  private addSig(
    name: string,
    source: string,
    dir: Sig["dir"],
    reg: boolean,
    signed: boolean,
    range: { msb: number; lsb: number } | null,
    mem: { lo: number; hi: number } | null,
    line: number,
  ): void {
    if (this.sigs.has(name))
      throw new VerilogError(`line ${line}: '${source}' is already declared`);
    if (mem && !reg) throw new VerilogError(`line ${line}: a memory must be a reg`);
    if (mem && dir !== "local") throw new VerilogError(`line ${line}: a memory cannot be a port`);
    const width = range ? range.msb - range.lsb + 1 : 1;
    if (mem && width * (mem.hi - mem.lo + 1) > 1024) {
      throw new VerilogError(`line ${line}: at most 1024 memory bits in this build`);
    }
    const sig: Sig = {
      name,
      source,
      dir,
      reg,
      signed,
      msb: range?.msb ?? 0,
      lsb: range?.lsb ?? 0,
      scalar: range === null,
      memLo: mem?.lo ?? null,
      memHi: mem?.hi ?? null,
      line,
    };
    this.sigs.set(name, sig);
    this.order.push(sig);
  }

  private names(): string[] {
    const found = [this.expect("id").text];
    while (this.peek().text === ",") {
      const after = this.peek(1);
      if (after.text === "input" || after.text === "output") break;
      this.next();
      found.push(this.expect("id").text);
    }
    return found;
  }

  private declNames(): { name: string; mem: RangeAst | null }[] {
    const found: { name: string; mem: RangeAst | null }[] = [];
    for (;;) {
      const name = this.expect("id").text;
      const mem = this.peek().text === "[" ? this.parseRange() : null;
      found.push({ name, mem });
      if (this.peek().text !== ",") break;
      this.next();
    }
    return found;
  }

  private parseRange(): RangeAst | null {
    if (!this.eat("[")) return null;
    const msb = this.parseConstExpr();
    this.expect("sym", ":");
    const lsb = this.parseConstExpr();
    this.expect("sym", "]");
    return { msb, lsb };
  }

  private parseConstExpr(): CExpr {
    let left = this.parseConstProduct();
    while (this.peek().text === "+" || this.peek().text === "-") {
      const op = this.next().text;
      left = { kind: op === "+" ? "add" : "sub", left, right: this.parseConstProduct() };
    }
    return left;
  }

  private parseConstProduct(): CExpr {
    let left = this.parseConstTerm();
    while (this.peek().text === "*" || this.peek().text === "/" || this.peek().text === "%") {
      const op = this.next().text;
      const kind = op === "*" ? "mul" : op === "/" ? "div" : "mod";
      left = { kind, left, right: this.parseConstTerm() };
    }
    return left;
  }

  private parseConstTerm(): CExpr {
    if (this.eat("(")) {
      const inner = this.parseConstExpr();
      this.expect("sym", ")");
      return inner;
    }
    const tok = this.peek();
    if (tok.kind === "num") {
      this.next();
      return { kind: "num", value: tok.value ?? 0, width: tok.width ?? null };
    }
    if (tok.kind === "id") {
      this.next();
      return { kind: "name", name: tok.text };
    }
    throw this.fail("expected a constant");
  }

  private parseLhs(): {
    name: string;
    hi: number | null;
    lo: number | null;
    index: Expr | null;
    slice: SliceSel | null;
    part: { hi: Expr; lo: Expr } | null;
    line: number;
  } {
    const target = this.expect("id");
    if (!this.eat("["))
      return {
        name: target.text,
        hi: null,
        lo: null,
        index: null,
        slice: null,
        part: null,
        line: target.line,
      };
    const sel = this.parseBracket();
    if (this.peek().text === "[") throw this.fail("a bit select of a memory word is later");
    return { name: target.text, ...sel, line: target.line };
  }

  private parseBracket(): {
    hi: number | null;
    lo: number | null;
    index: Expr | null;
    slice: SliceSel | null;
    part: { hi: Expr; lo: Expr } | null;
  } {
    const bit = this.peek().kind === "num" && this.peek(1).text === "]";
    const fixed =
      this.peek().kind === "num" && this.peek(1).text === ":" && this.peek(2).kind === "num";
    if (bit || fixed) {
      const tok = this.expect("num");
      if (tok.width != null) throw this.fail("range bound must be a plain number", tok.line);
      const hi = tok.value ?? 0;
      let lo: number | null = null;
      if (this.eat(":")) {
        const low = this.expect("num");
        if (low.width != null) throw this.fail("range bound must be a plain number", low.line);
        lo = low.value ?? 0;
      }
      this.expect("sym", "]");
      return { hi, lo, index: null, slice: null, part: null };
    }
    const base = this.parseExpr();
    if (this.peek().text === "+:" || this.peek().text === "-:") {
      const up = this.next().text === "+:";
      const width = this.parseConstExpr();
      this.expect("sym", "]");
      return { hi: null, lo: null, index: null, slice: { base, width, up }, part: null };
    }
    if (this.peek().text === ":") {
      this.next();
      const lo = this.parseExpr();
      this.expect("sym", "]");
      return { hi: null, lo: null, index: null, slice: null, part: { hi: base, lo } };
    }
    this.expect("sym", "]");
    return { hi: null, lo: null, index: base, slice: null, part: null };
  }

  private parseLoopHead(): {
    name: string;
    init: CExpr;
    rel: "<" | "<=" | ">" | ">=";
    bound: CExpr;
    dir: 1 | -1;
    step: CExpr;
    line: number;
  } {
    const line = this.peek().line;
    this.expect("id", "for");
    this.expect("sym", "(");
    if (this.peek().text === "genvar" || this.peek().text === "integer") this.next();
    const name = this.expect("id").text;
    this.expect("sym", "=");
    const init = this.parseConstExpr();
    this.expect("sym", ";");
    if (this.expect("id").text !== name) throw this.fail("the condition must test the loop index");
    const relTok = this.next();
    if (
      relTok.kind !== "sym" ||
      (relTok.text !== "<" && relTok.text !== "<=" && relTok.text !== ">" && relTok.text !== ">=")
    ) {
      throw this.fail("the condition must be <, <=, > or >=", relTok.line);
    }
    const bound = this.parseConstExpr();
    this.expect("sym", ";");
    if (this.expect("id").text !== name) throw this.fail("the step must assign the loop index");
    this.expect("sym", "=");
    let dir: 1 | -1 = 1;
    let step: CExpr;
    if (this.peek().text === name) {
      this.next();
      const op = this.next().text;
      if (op !== "+" && op !== "-") throw this.fail("the step must add or subtract a constant");
      dir = op === "+" ? 1 : -1;
      step = this.parseConstExpr();
    } else {
      step = this.parseConstExpr();
      if (!this.eat("+") || this.expect("id").text !== name)
        throw this.fail("the step must change the loop index");
    }
    this.expect("sym", ")");
    return { name, init, rel: relTok.text, bound, dir, step, line };
  }

  private parseGenBlock(): Item[] {
    if (!this.eat("begin")) return [this.parseGenItem()];
    if (this.eat(":")) this.expect("id");
    const items: Item[] = [];
    while (!this.eat("end")) {
      if (this.peek().kind === "eof") throw this.fail("expected end");
      items.push(this.parseGenItem());
    }
    return items;
  }

  private parseGenItem(): Item {
    const word = this.peek().text;
    if (word === "for") return this.parseGenFor();
    if (word === "if") return this.parseGenIf();
    if (word === "assign") {
      const line = this.peek().line;
      this.next();
      const lhs = this.parseLhs();
      this.expect("sym", "=");
      const expr = this.parseExpr();
      this.notYet();
      this.expect("sym", ";");
      return {
        kind: "assign",
        seq: false,
        target: lhs.name,
        hi: lhs.hi,
        lo: lhs.lo,
        index: lhs.index,
        slice: lhs.slice,
        part: lhs.part,
        expr,
        line,
      };
    }
    if (word === "always" || word === "always_comb" || word === "always_ff")
      return this.parseAlways();
    if (this.peek().kind === "id" && (this.peek(1).text === "#" || this.peek(1).kind === "id"))
      return this.parseInstance();
    if (
      word === "wire" ||
      word === "reg" ||
      word === "logic" ||
      word === "localparam" ||
      word === "integer" ||
      word === "genvar"
    ) {
      throw this.fail("declare this outside the generate");
    }
    throw this.fail(`unexpected '${word || "token"}'`);
  }

  private parseGenFor(): Item {
    const head = this.parseLoopHead();
    return {
      kind: "genfor",
      seq: false,
      gen: head.name,
      init: head.init,
      rel: head.rel,
      bound: head.bound,
      dir: head.dir,
      step: head.step,
      items: this.parseGenBlock(),
      line: head.line,
    };
  }

  private parseGenIf(): Item {
    const line = this.peek().line;
    this.expect("id", "if");
    this.expect("sym", "(");
    const condExpr = this.parseConstRel();
    this.expect("sym", ")");
    const yes = this.parseGenBlock();
    const no = this.eat("else") ? this.parseGenBlock() : [];
    return { kind: "genif", seq: false, condExpr, yes, no, line };
  }

  private parseConstRel(): CExpr {
    const left = this.parseConstExpr();
    const op = this.peek().text;
    if (op === "<" || op === "<=" || op === ">" || op === ">=" || op === "==" || op === "!=") {
      this.next();
      const kind =
        op === "<"
          ? "lt"
          : op === "<="
            ? "le"
            : op === ">"
              ? "gt"
              : op === ">="
                ? "ge"
                : op === "=="
                  ? "eq"
                  : "ne";
      return { kind, left, right: this.parseConstExpr() };
    }
    return left;
  }

  private parseAlways(): Item {
    const line = this.peek().line;
    const word = this.next().text;
    if (word === "always_comb") {
      this.parseCombSense();
      return this.alwaysBody(line, false, null, 1);
    }
    if (word === "always_ff") {
      const clock = this.parseClockSense(true);
      return this.alwaysBody(line, true, clock.rst, clock.rstLevel);
    }
    if (word !== "always") throw this.fail("expected always", line);
    const clock = this.parseClockSense(false);
    return this.alwaysBody(line, clock.seq, clock.rst, clock.rstLevel);
  }

  private alwaysBody(line: number, seq: boolean, rst: string | null, rstLevel: 0 | 1): Item {
    const stmt = this.parseStmt();
    const body = stmt.kind === "block" ? stmt.body : [stmt];
    return { kind: "always", seq, body, rst, rstLevel, line };
  }

  private parseCombSense(): void {
    if (this.peek().text !== "@") return;
    this.next();
    if (this.eat("*")) return;
    this.expect("sym", "(");
    if (!this.eat("*")) throw this.fail("always_comb takes @* or no event");
    this.expect("sym", ")");
  }

  private parseClockSense(ff: boolean): { seq: boolean; rst: string | null; rstLevel: 0 | 1 } {
    if (ff && this.peek().text !== "@") throw this.fail("always_ff needs posedge clk");
    this.expect("sym", "@");
    if (!ff && this.eat("*")) return { seq: false, rst: null, rstLevel: 1 };
    if (ff && this.peek().text === "*") throw this.fail("always_ff needs posedge clk");
    this.expect("sym", "(");
    if (this.eat("*")) {
      if (ff) throw this.fail("always_ff needs posedge clk");
      this.expect("sym", ")");
      return { seq: false, rst: null, rstLevel: 1 };
    }
    if (this.peek().text !== "posedge" && this.peek().text !== "negedge") {
      if (ff) throw this.fail("always_ff needs posedge clk");
      while (!this.eat(")")) {
        if (this.peek().kind === "eof") throw this.fail("expected )");
        this.next();
      }
      return { seq: false, rst: null, rstLevel: 1 };
    }
    this.expect("id", "posedge");
    const clock = this.expect("id");
    if (clock.text !== "clk") throw this.fail("only posedge clk", clock.line);
    let rst: string | null = null;
    let rstLevel: 0 | 1 = 1;
    if (this.eat("or")) {
      const edge = this.expect("id");
      if (edge.text !== "posedge" && edge.text !== "negedge")
        throw this.fail("expected posedge or negedge", edge.line);
      rst = this.expect("id").text;
      rstLevel = edge.text === "posedge" ? 1 : 0;
    }
    this.expect("sym", ")");
    return { seq: true, rst, rstLevel };
  }

  private parseStmt(): Stmt {
    if (this.eat("begin")) {
      if (this.eat(":")) this.expect("id");
      const body: Stmt[] = [];
      while (!this.eat("end")) {
        if (this.peek().kind === "eof") throw this.fail("expected end");
        const decl = this.peek().text;
        if (decl === "reg" || decl === "logic" || decl === "integer") {
          this.hoistDecl();
          continue;
        }
        body.push(this.parseStmt());
      }
      if (this.eat(":")) this.expect("id");
      return { kind: "block", body };
    }
    if (this.eat("if")) {
      const line = this.peek().line;
      this.expect("sym", "(");
      const cond = this.parseExpr();
      this.notYet();
      this.expect("sym", ")");
      const yesStmt = this.parseStmt();
      const noStmt = this.eat("else") ? this.parseStmt() : null;
      return {
        kind: "if",
        cond,
        yes: yesStmt.kind === "block" ? yesStmt.body : [yesStmt],
        no: noStmt === null ? [] : noStmt.kind === "block" ? noStmt.body : [noStmt],
        line,
      };
    }
    if (this.peek().text.startsWith("$")) {
      this.next();
      if (this.eat("(")) {
        let depth = 1;
        while (depth > 0) {
          if (this.peek().kind === "eof") throw this.fail("expected )");
          if (this.peek().text === "(") depth += 1;
          else if (this.peek().text === ")") depth -= 1;
          this.next();
        }
      }
      this.expect("sym", ";");
      return { kind: "block", body: [] };
    }
    if (this.peek().text === "for") return this.parseFor();
    if (this.peek().text === "case" || this.peek().text === "casex" || this.peek().text === "casez")
      return this.parseCase();
    if (this.eat("{")) {
      const line = this.peek().line;
      const parts: { name: string; hi: number | null; lo: number | null }[] = [];
      while (this.peek().text !== "}") {
        if (this.peek().kind === "eof") throw this.fail("expected }");
        const lhs = this.parseLhs();
        if (lhs.index || lhs.slice || lhs.part)
          throw this.fail("that left-hand side is later", lhs.line);
        parts.push({ name: lhs.name, hi: lhs.hi, lo: lhs.lo });
        if (!this.eat(",")) break;
      }
      this.expect("sym", "}");
      let blocking = true;
      if (this.eat("<=")) blocking = false;
      else if (!this.eat("=")) throw this.fail("expected = or <=");
      if (this.eat("#")) {
        if (this.eat("(")) {
          this.parseExpr();
          this.expect("sym", ")");
        } else if (this.peek().kind === "num") this.next();
        else throw this.fail("expected a delay");
      }
      const expr = this.parseExpr();
      this.notYet();
      this.expect("sym", ";");
      return { kind: "join", parts, expr, blocking, line };
    }
    const lhs = this.parseLhs();
    let blocking = true;
    if (this.eat("<=")) blocking = false;
    else if (!this.eat("=")) throw this.fail("expected = or <=");
    if (this.eat("#")) {
      if (this.eat("(")) {
        this.parseExpr();
        this.expect("sym", ")");
      } else if (this.peek().kind === "num") this.next();
      else throw this.fail("expected a delay");
    }
    const expr = this.parseExpr();
    this.notYet();
    this.expect("sym", ";");
    return {
      kind: "set",
      target: lhs.name,
      hi: lhs.hi,
      lo: lhs.lo,
      index: lhs.index,
      slice: lhs.slice,
      part: lhs.part,
      expr,
      blocking,
      line: lhs.line,
    };
  }

  private hoistDecl(): void {
    const line = this.peek().line;
    const word = this.next().text;
    if (word === "integer") {
      for (const name of this.names()) {
        if (!this.pendingIntegers.includes(name)) this.pendingIntegers.push(name);
      }
      this.expect("sym", ";");
      return;
    }
    const reg = word === "reg";
    const logic = word === "logic";
    let signed = false;
    if (this.eat("signed")) signed = true;
    const range = this.parseRange();
    if (this.eat("signed")) signed = true;
    const names = this.declNames();
    this.pendingDecls.push({ reg, logic, signed, range, names, line });
    this.expect("sym", ";");
  }

  private parseFor(): Stmt {
    const head = this.parseLoopHead();
    const stmt = this.parseStmt();
    return {
      kind: "for",
      name: head.name,
      init: head.init,
      rel: head.rel,
      bound: head.bound,
      dir: head.dir,
      step: head.step,
      body: stmt.kind === "block" ? stmt.body : [stmt],
      line: head.line,
    };
  }

  private parseCase(): Stmt {
    const line = this.peek().line;
    const word = this.next().text;
    const relaxed = word === "casex" || word === "casez";
    this.expect("sym", "(");
    const sel = this.parseExpr();
    this.notYet();
    this.expect("sym", ")");
    const full = /\bfull_case\b/.test(this.peek().lead ?? "");
    const arms: {
      labels: { value: number; width: number | null; wild?: number; name?: string }[];
      body: Stmt[];
    }[] = [];
    while (!this.eat("endcase")) {
      if (this.peek().kind === "eof") throw this.fail("expected endcase");
      if (this.eat("default")) {
        this.expect("sym", ":");
        arms.push({ labels: [], body: this.stmtList() });
        continue;
      }
      const labels: { value: number; width: number | null; wild?: number; name?: string }[] = [];
      for (;;) {
        const label = this.parseExpr();
        if (label.kind === "ref" && label.hi === null) {
          labels.push({ value: 0, width: null, name: label.name });
        } else if (label.kind === "const") {
          if (label.wild && !relaxed) throw this.fail("x or z in a case label needs casex");
          labels.push({
            value: label.value,
            width: label.width,
            ...(label.wild ? { wild: label.wild } : {}),
          });
        } else throw this.fail("case label must be a constant");
        if (!this.eat(",")) break;
      }
      this.expect("sym", ":");
      arms.push({ labels, body: this.stmtList() });
    }
    return { kind: "case", sel, arms, full, line };
  }

  private stmtList(): Stmt[] {
    const stmt = this.parseStmt();
    return stmt.kind === "block" ? stmt.body : [stmt];
  }

  private parseExpr(): Expr {
    const cond = this.parseLogOr();
    if (!this.eat("?")) return cond;
    const yes = this.parseExpr();
    this.expect("sym", ":");
    const no = this.parseExpr();
    return { kind: "mux", sel: cond, yes, no };
  }

  private parseLogOr(): Expr {
    let left = this.parseLogAnd();
    while (this.peek().text === "||") {
      this.next();
      left = { kind: "logor", left, right: this.parseLogAnd() };
    }
    return left;
  }

  private parseLogAnd(): Expr {
    let left = this.parseOr();
    while (this.peek().text === "&&") {
      this.next();
      left = { kind: "logand", left, right: this.parseOr() };
    }
    return left;
  }

  private parseOr(): Expr {
    let left = this.parseXor();
    while (this.peek().text === "|") {
      this.next();
      left = { kind: "or", left, right: this.parseXor() };
    }
    return left;
  }

  private parseXor(): Expr {
    let left = this.parseAnd();
    while (this.peek().text === "^") {
      this.next();
      left = { kind: "xor", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseEq();
    while (this.peek().text === "&") {
      this.next();
      left = { kind: "and", left, right: this.parseEq() };
    }
    return left;
  }

  private parseEq(): Expr {
    let left = this.parseRel();
    while (this.peek().text === "==" || this.peek().text === "!=") {
      const op = this.next().text;
      const right = this.parseRel();
      left = { kind: op === "==" ? "eq" : "ne", left, right };
    }
    return left;
  }

  private parseRel(): Expr {
    let left = this.parseShift();
    const kinds: Record<string, "lt" | "gt" | "le" | "ge"> = {
      "<": "lt",
      ">": "gt",
      "<=": "le",
      ">=": "ge",
    };
    while (this.peek().text in kinds) {
      const op = this.next().text;
      const kind = kinds[op] ?? "lt";
      left = { kind, left, right: this.parseShift() };
    }
    return left;
  }

  private parseShift(): Expr {
    let left = this.parseAdd();
    while (
      this.peek().text === "<<" ||
      this.peek().text === ">>" ||
      this.peek().text === "<<<" ||
      this.peek().text === ">>>"
    ) {
      const op = this.next().text;
      const kind = op === "<<" ? "shl" : op === ">>" ? "shr" : op === "<<<" ? "ashl" : "ashr";
      left = { kind, left, right: this.parseAdd() };
    }
    return left;
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.peek().text === "+" || this.peek().text === "-") {
      const op = this.next().text;
      left = { kind: op === "+" ? "add" : "sub", left, right: this.parseMul() };
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.peek().text === "*" || this.peek().text === "/" || this.peek().text === "%") {
      const op = this.next().text;
      const kind = op === "*" ? "mul" : op === "/" ? "div" : "mod";
      left = { kind, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expr {
    const tok = this.peek();
    if (tok.text === "!") {
      this.next();
      return { kind: "lognot", arg: this.parseUnary() };
    }
    if (tok.text === "~") {
      this.next();
      const next = this.peek().text;
      if (next === "&" || next === "|" || next === "^") {
        this.next();
        const op = next === "&" ? "nand" : next === "|" ? "nor" : "xnor";
        return { kind: "reduce", op, arg: this.parseUnary() };
      }
      return { kind: "not", arg: this.parseUnary() };
    }
    if (tok.text === "^" && this.peek(1).text === "~") {
      this.next();
      this.next();
      return { kind: "reduce", op: "xnor", arg: this.parseUnary() };
    }
    if (tok.text === "&" || tok.text === "|" || tok.text === "^") {
      this.next();
      const op = tok.text === "&" ? "and" : tok.text === "|" ? "or" : "xor";
      return { kind: "reduce", op, arg: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const tok = this.peek();
    if (tok.text === "(") {
      this.next();
      const inner = this.parseExpr();
      this.notYet();
      this.expect("sym", ")");
      return inner;
    }
    if (tok.text === "{") {
      this.next();
      const replicated = (): boolean => {
        if (this.peek().kind === "num" || (this.peek().kind === "id" && this.peek(1).text === "{"))
          return this.peek(1).text === "{";
        if (this.peek().text !== "(") return false;
        let depth = 0;
        for (let ahead = 0; ahead < 48; ahead += 1) {
          const tok = this.peek(ahead);
          if (tok.kind === "eof") return false;
          if (tok.text === "(") depth += 1;
          else if (tok.text === ")") {
            depth -= 1;
            if (depth === 0) return this.peek(ahead + 1).text === "{";
          }
        }
        return false;
      };
      if (replicated()) {
        let count: CExpr;
        if (this.peek().text === "(") {
          this.next();
          count = this.parseConstExpr();
          this.expect("sym", ")");
        } else count = this.parseConstTerm();
        this.expect("sym", "{");
        const inner = this.parseConcatBody();
        this.expect("sym", "}");
        this.expect("sym", "}");
        return { kind: "rep", count, inner };
      }
      const parts = this.parseConcatBody();
      this.notYet();
      this.expect("sym", "}");
      return parts.kind === "concat" ? parts : { kind: "concat", parts: [parts] };
    }
    if (tok.kind === "num") {
      this.next();
      return {
        kind: "const",
        value: tok.value ?? 0,
        width: tok.width ?? null,
        ...(tok.wild ? { wild: tok.wild } : {}),
      };
    }
    if (tok.kind === "id") {
      this.next();
      let hi: number | null = null;
      let lo: number | null = null;
      if (this.eat("[")) {
        if (this.peek().kind === "num" && this.peek(1).text === "]") {
          const hiTok = this.expect("num");
          hi = hiTok.value ?? 0;
          this.expect("sym", "]");
          return { kind: "ref", name: tok.text, hi, lo };
        }
        if (
          this.peek().kind === "num" &&
          this.peek(1).text === ":" &&
          this.peek(2).kind === "num"
        ) {
          const hiTok = this.expect("num");
          hi = hiTok.value ?? 0;
          this.expect("sym", ":");
          lo = this.expect("num").value ?? 0;
          this.expect("sym", "]");
          return { kind: "ref", name: tok.text, hi, lo };
        }
        const index = this.parseExpr();
        if (this.peek().text === "+:" || this.peek().text === "-:") {
          const up = this.next().text === "+:";
          const width = this.parseConstExpr();
          this.expect("sym", "]");
          return { kind: "slice", name: tok.text, base: index, width, up };
        }
        if (this.peek().text === ":") {
          this.next();
          const low = this.parseExpr();
          this.expect("sym", "]");
          return { kind: "part", name: tok.text, hi: index, lo: low };
        }
        this.expect("sym", "]");
        if (this.eat("[")) {
          const hi = this.parseExpr();
          this.expect("sym", ":");
          const lo = this.parseExpr();
          this.expect("sym", "]");
          return { kind: "word", name: tok.text, index, hi, lo };
        }
        return { kind: "index", name: tok.text, index };
      }
      return { kind: "ref", name: tok.text, hi, lo };
    }
    throw this.fail(`expected an expression, got '${tok.text || "end"}'`);
  }

  private parseConcatBody(): Expr {
    const parts = [this.parseExpr()];
    while (this.eat(",")) parts.push(this.parseExpr());
    const only = parts[0];
    if (parts.length === 1 && only) return only;
    return { kind: "concat", parts };
  }

  private notYet(): void {
    const tok = this.peek();
    const reason = LATER[tok.text];
    if (reason) throw this.fail(reason, tok.line);
  }

  private elaborate(name: string, items: Item[], params: Map<string, number>): Netlist {
    this.constParams = params;
    const clocked = items.some((item) => item.kind === "always" && item.seq);
    if (clocked && !this.order.some((sig) => sig.dir === "input" && sig.source === "clk")) {
      throw new VerilogError("expected input clk");
    }
    const gates: Gate[] = [];
    const used = new Set<string>(["0", "1"]);
    const reserved = new Set<string>(["0", "1"]);
    for (const sig of this.order) {
      if (clocked && sig.source === "clk") continue;
      const bits = sig.memLo !== null ? memBits(sig) : bitsLSB(sig);
      for (const bit of bits) reserved.add(bit);
      if (sig.dir === "input") for (const bit of bits) used.add(bit);
    }
    if (clocked) {
      used.add("clk");
      reserved.add("clk");
    }
    const fresh = (): string => {
      let id = `${this.prefix}_t${this.tempSeq}`;
      while (used.has(id) || reserved.has(id)) {
        this.tempSeq += 1;
        id = `${this.prefix}_t${this.tempSeq}`;
      }
      this.tempSeq += 1;
      used.add(id);
      return id;
    };
    const emit = (op: Op, ins: string[], id?: string): string => {
      const gate = id ?? fresh();
      if (id) {
        if (used.has(id)) throw new VerilogError(`'${id}' is already a net`);
        used.add(id);
      }
      gates.push({ id: gate, op, ins });
      return gate;
    };
    let retarget = (_oldId: string, _newId: string): void => {};
    const renamed = new Map<string, string>();
    const resolveNet = (value: string): string => {
      let current = value;
      const seen = new Set<string>();
      while (renamed.has(current) && !seen.has(current)) {
        seen.add(current);
        current = renamed.get(current) ?? current;
      }
      return current;
    };
    const connect = (id: string, value: string): string => {
      const current = resolveNet(value);
      if (current === id) return id;
      if (current === "0" || current === "1") return emit("AND", [current, current], id);
      const gate = gates.find((candidate) => candidate.id === current);
      const shared = gates.some((candidate) => candidate.ins.includes(current));
      if (gate && current.includes("_t") && !shared) {
        gate.id = id;
        used.delete(current);
        used.add(id);
        renamed.set(current, id);
        retarget(current, id);
        return id;
      }
      return emit("INV", [emit("INV", [current])], id);
    };
    let overlay: Map<string, (string | undefined)[]> | null = null;
    const readName = (sigName: string): string[] => {
      const sig = this.must(sigName);
      const base = bitsLSB(sig);
      const over = overlay?.get(sig.name);
      if (!over) return base;
      return base.map((bit, index) => over[index] ?? bit);
    };
    const memWord = (sig: Sig, addr: number): string[] => {
      const over = overlay?.get(sig.name);
      const width = widthOf(sig);
      const base = (addr - (sig.memLo ?? 0)) * width;
      const word: string[] = [];
      for (let bit = sig.lsb; bit <= sig.msb; bit += 1) {
        const live = over?.[base + (bit - sig.lsb)];
        word.push(live ?? memBit(sig, addr, bit));
      }
      return word;
    };
    const orReduce = (bits: string[]): string => {
      const first = bits[0];
      if (first === undefined) throw new VerilogError("empty condition");
      return bits.slice(1).reduce((acc, bit) => emit("OR", [acc, bit]), first);
    };
    const reduceBits = (
      bits: string[],
      op: "and" | "or" | "xor" | "nand" | "nor" | "xnor",
    ): string => {
      const gate: Op =
        op === "and" || op === "nand" ? "AND" : op === "or" || op === "nor" ? "OR" : "XOR";
      const first = bits[0];
      if (first === undefined) throw new VerilogError("empty reduction");
      let acc = first;
      for (const bit of bits.slice(1)) acc = emit(gate, [acc, bit]);
      if (op === "nand" || op === "nor" || op === "xnor") acc = emit("INV", [acc]);
      return acc;
    };
    interface Produced {
      op: "add" | "mul";
      a: string[];
      b: string[];
      cin: string;
      out: string[];
    }
    const produced = new Map<string, Produced>();
    const remember = (info: Produced): void => {
      produced.set(info.out.join(","), info);
    };
    const note = (text: string): void => {
      if (!this.notes.includes(text)) this.notes.push(text);
    };
    const invertedBit = new Map<string, string>();
    const invertOne = (bit: string): string => {
      if (bit === "0") return "1";
      if (bit === "1") return "0";
      const hit = invertedBit.get(bit);
      if (hit) return hit;
      const out = emit("INV", [bit]);
      invertedBit.set(bit, out);
      return out;
    };
    const invertBits = (bits: string[]): string[] => bits.map(invertOne);
    const knownAdds = new Map<string, { sums: string[]; cout: string }>();
    retarget = (oldId: string, newId: string): void => {
      if (oldId === newId) return;
      const pending: Produced[] = [];
      for (const [key, info] of [...produced.entries()]) {
        if (
          !info.out.includes(oldId) &&
          !info.a.includes(oldId) &&
          !info.b.includes(oldId) &&
          info.cin !== oldId
        )
          continue;
        produced.delete(key);
        const swap = (bit: string): string => (bit === oldId ? newId : bit);
        info.a = info.a.map(swap);
        info.b = info.b.map(swap);
        info.out = info.out.map(swap);
        if (info.cin === oldId) info.cin = newId;
        pending.push(info);
      }
      for (const info of pending) produced.set(info.out.join(","), info);
      for (const saved of knownAdds.values()) {
        if (saved.cout === oldId) saved.cout = newId;
        if (saved.sums.includes(oldId))
          saved.sums = saved.sums.map((bit) => (bit === oldId ? newId : bit));
      }
      for (const [bit, inv] of invertedBit) if (inv === oldId) invertedBit.set(bit, newId);
      for (const site of adders) {
        const swap = (bit: string): string => (bit === oldId ? newId : bit);
        site.a = site.a.map(swap);
        site.b = site.b.map(swap);
        site.sums = site.sums.map(swap);
        if (site.cin === oldId) site.cin = newId;
        if (site.cout === oldId) site.cout = newId;
      }
    };
    const adders: AdderSite[] = [];
    const recordAdder = (site: AdderSite): void => {
      adders.push(site);
    };
    const buildAdder = (
      left: string[],
      right: string[],
      cin: string,
      names?: string[],
    ): { sums: string[]; cout: string } => {
      const built = addBits(this.mode, emit, left, right, cin, names);
      adders.push({
        a: left.slice(),
        b: right.slice(),
        cin,
        sums: built.sums.slice(),
        cout: built.cout,
        kind: this.mode === "delay" ? "brent-kung" : "ripple",
      });
      return built;
    };
    const addCached = (
      left: string[],
      right: string[],
      cin: string,
      names?: string[],
    ): { sums: string[]; cout: string } => {
      const key = `${cin}\0${left.join("\0")}\0${right.join("\0")}`;
      const hit = knownAdds.get(key);
      if (hit) {
        if (!names) return hit;
        const sums = hit.sums.slice();
        for (let index = 0; index < sums.length; index += 1) {
          const name = names[index];
          const sum = sums[index];
          if (!name || sum === undefined || name === sum) continue;
          const next = connect(name, sum);
          sums[index] = next;
          if (next !== sum && !gates.some((gate) => gate.id === sum)) retarget(sum, next);
        }
        return { sums, cout: hit.cout };
      }
      note(adderKind(this.mode));
      const built = buildAdder(left, right, cin, names);
      knownAdds.set(key, built);
      remember({ op: "add", a: left.slice(), b: right.slice(), cin, out: built.sums.slice() });
      return built;
    };
    const operate = (
      kind: "add" | "sub",
      left: string[],
      right: string[],
      names?: string[],
    ): string[] => {
      const b = kind === "sub" ? invertBits(right) : right;
      const cin = kind === "sub" ? "1" : "0";
      const sums = addCached(left, b, cin, names).sums;
      remember({ op: "add", a: left.slice(), b: b.slice(), cin, out: sums.slice() });
      return sums;
    };
    const multiply = (left: string[], right: string[], width: number): string[] => {
      note(multiplierKind(this.mode));
      const out = mulBits(this.mode, emit, left, right, width, recordAdder);
      remember({ op: "mul", a: left, b: right, cin: "0", out });
      return out;
    };
    const divide = (
      left: string[],
      right: string[],
      width: number,
      signedOp: boolean,
      remainder: boolean,
    ): string[] => {
      note(dividerKind(this.mode));
      const negate = (bits: string[], sign: string): string[] => {
        if (sign === "0") return bits;
        const flipped = bits.map((bit) => {
          if (sign === "1") return bit === "0" ? "1" : bit === "1" ? "0" : emit("INV", [bit]);
          return emit("XOR", [bit, sign]);
        });
        return addCached(
          flipped,
          bits.map(() => "0"),
          sign,
        ).sums;
      };
      const magA = signedOp ? negate(left, left[width - 1] ?? "0") : left;
      const magB = signedOp ? negate(right, right[width - 1] ?? "0") : right;
      const raw = divBits(this.mode, emit, magA, magB, width, recordAdder);
      if (!signedOp) return remainder ? raw.rem : raw.quot;
      const signA = left[width - 1] ?? "0";
      const signB = right[width - 1] ?? "0";
      if (remainder) return negate(raw.rem, signA);
      const flip =
        signA === signB
          ? "0"
          : signA === "0" || signB === "0"
            ? signA === "0"
              ? signB
              : signA
            : emit("XOR", [signA, signB]);
      return negate(raw.quot, flip);
    };
    const shiftConst = (
      bits: string[],
      amount: number,
      dir: "shl" | "shr",
      fill: string,
      names?: string[],
    ): string[] => {
      const shifted = bits.map((_, index) => {
        const from = dir === "shl" ? index - amount : index + amount;
        if (amount < 0 || from < 0 || from >= bits.length)
          return dir === "shr" && from >= bits.length ? fill : "0";
        return bits[from] ?? "0";
      });
      return shifted.map((bit, index) =>
        names?.[index] && names[index] !== bit ? connect(names[index] ?? bit, bit) : bit,
      );
    };
    const barrel = (
      bits: string[],
      amount: string[],
      dir: "shl" | "shr",
      fillOf: (current: string[]) => string,
      names?: string[],
    ): string[] => {
      let current = bits;
      for (let stage = 0; stage < amount.length; stage += 1) {
        const distance = 2 ** stage;
        const sel = amount[stage] ?? "0";
        const prev = current;
        const fill = fillOf(prev);
        current = prev.map((bit, index) => {
          const from = dir === "shl" ? index - distance : index + distance;
          const shifted =
            from < 0 || from >= prev.length
              ? dir === "shr" && from >= prev.length
                ? fill
                : "0"
              : (prev[from] ?? "0");
          if (bit === shifted) return bit;
          return emit("MUX", [sel, shifted, bit]);
        });
      }
      return current.map((bit, index) =>
        names?.[index] && names[index] !== bit ? connect(names[index] ?? bit, bit) : bit,
      );
    };
    const decoded = new Map<string, string>();
    const decode = (idx: string[], value: number): string => {
      if (idx.length < 31 && value >= 2 ** idx.length) return "0";
      const key = `${value}:${idx.join(",")}`;
      const cached = decoded.get(key);
      if (cached) return cached;
      let match = "1";
      for (let bit = 0; bit < idx.length; bit += 1) {
        const wanted = ((value >> bit) & 1) === 1;
        const pin = idx[bit] ?? "0";
        const ok = wanted ? pin : pin === "0" ? "1" : pin === "1" ? "0" : emit("INV", [pin]);
        if (ok === "0") {
          match = "0";
          break;
        }
        match = match === "1" ? ok : emit("AND", [match, ok]);
      }
      decoded.set(key, match);
      return match;
    };
    const orTree = (terms: string[]): string => {
      let layer = terms.filter((term) => term !== "0");
      if (layer.length === 0) return "0";
      while (layer.length > 1) {
        const next: string[] = [];
        for (let index = 0; index < layer.length; index += 2) {
          const left = layer[index] ?? "0";
          const right = layer[index + 1];
          if (right === undefined || right === "0" || left === right) next.push(left);
          else if (left === "0") next.push(right);
          else next.push(emit("OR", [left, right]));
        }
        layer = next;
      }
      return layer[0] ?? "0";
    };
    /** Binary mux tree. `idx[0]` is the LSB. `sel` chooses `hi`. A missing half is 0. */
    const muxLayers = (choices: readonly string[], idx: readonly string[]): string => {
      let layer = [...choices];
      if (layer.length === 0) return "0";
      for (let stage = 0; stage < idx.length; stage += 1) {
        const sel = idx[stage] ?? "0";
        const next: string[] = [];
        for (let index = 0; index < layer.length; index += 2) {
          const lo = layer[index] ?? "0";
          const hi = layer[index + 1] ?? "0";
          if (lo === hi || sel === "0") next.push(lo);
          else if (sel === "1") next.push(hi);
          else next.push(emit("MUX", [sel, hi, lo]));
        }
        layer = next;
      }
      return layer[0] ?? "0";
    };
    const fit = (bits: string[], width: number, signed: boolean): string[] => {
      if (bits.length === width) return bits;
      if (bits.length > width) return bits.slice(0, width);
      const fill = signed && bits.length > 0 ? (bits[bits.length - 1] ?? "0") : "0";
      return [...bits, ...Array.from({ length: width - bits.length }, () => fill)];
    };
    const lower = (expr: Expr, width: number | null, names?: string[]): string[] => {
      switch (expr.kind) {
        case "ref": {
          if (expr.hi === null && this.loopVars.has(expr.name)) {
            const value = this.loopVars.get(expr.name) ?? 0;
            return constBits(value, width ?? Math.max(1, minBits(value)));
          }
          if (this.constParams.has(expr.name)) {
            const value = this.constParams.get(expr.name) ?? 0;
            if (expr.hi === null) {
              const known = this.paramWidths.get(expr.name);
              return constBits(value, width ?? known ?? Math.max(1, minBits(value)));
            }
            const lo = expr.lo ?? expr.hi;
            const hi = expr.hi;
            const bits = constBits(value, Math.max(hi + 1, minBits(value), width ?? 1));
            return bits.slice(lo, hi + 1);
          }
          const sig = this.must(expr.name);
          if (sig.memLo !== null) {
            if (expr.hi !== null && expr.lo === null) {
              return lower(
                {
                  kind: "index",
                  name: expr.name,
                  index: { kind: "const", value: expr.hi, width: null },
                },
                width,
                names,
              );
            }
            throw new VerilogError(`'${expr.name}' is a memory; select a word`);
          }
          const all = readName(expr.name);
          if (expr.hi === null) return all;
          const lo = expr.lo ?? expr.hi;
          const hi = expr.hi;
          if (hi < lo || lo < sig.lsb || hi > sig.msb)
            throw new VerilogError(`'${expr.name}[${hi}]' is out of range`);
          const picked: string[] = [];
          for (let bit = lo; bit <= hi; bit += 1) {
            const value = all[bit - sig.lsb];
            if (value === undefined)
              throw new VerilogError(`'${expr.name}[${bit}]' is out of range`);
            picked.push(value);
          }
          return picked;
        }
        case "const": {
          const w = width ?? expr.width ?? Math.max(1, minBits(expr.value));
          return constBits(expr.value, w);
        }
        case "not": {
          const w = width ?? this.selfWidth(expr.arg);
          if (w === null) throw new VerilogError("width is not known");
          const arg = this.align(expr.arg, w, lower);
          return arg.map((bit, index) => emit("INV", [bit], names?.[index]));
        }
        case "and":
        case "or":
        case "xor": {
          const w = width ?? this.pairWidth(expr.left, expr.right);
          const left = this.align(expr.left, w, lower);
          const right = this.align(expr.right, w, lower);
          const op: Op = expr.kind === "and" ? "AND" : expr.kind === "or" ? "OR" : "XOR";
          return left.map((bit, index) => emit(op, [bit, right[index] ?? "0"], names?.[index]));
        }
        case "add":
        case "sub": {
          const w = width ?? this.pairWidth(expr.left, expr.right);
          const unsigned = !this.isSigned(expr);
          const left = this.extend(expr.left, w, lower, unsigned);
          const right = this.extend(expr.right, w, lower, unsigned);
          return operate(expr.kind, left, right, names);
        }
        case "mul": {
          const w = width ?? (this.selfWidth(expr.left) ?? 1) + (this.selfWidth(expr.right) ?? 1);
          if (w > MAX_WIDTH) throw new VerilogError(`at most ${MAX_WIDTH} bits in this build`);
          if (this.isSigned(expr))
            return multiply(this.extend(expr.left, w, lower), this.extend(expr.right, w, lower), w);
          // The low bits of a product depend only on the low bits of each operand.
          const leftW = Math.min(this.selfWidth(expr.left) ?? w, w);
          const rightW = Math.min(this.selfWidth(expr.right) ?? w, w);
          return multiply(
            this.extend(expr.left, leftW, lower, true),
            this.extend(expr.right, rightW, lower, true),
            w,
          );
        }
        case "div":
        case "mod": {
          const w = width ?? this.pairWidth(expr.left, expr.right);
          if (w > MAX_WIDTH) throw new VerilogError(`at most ${MAX_WIDTH} bits in this build`);
          const unsigned = !this.isSigned(expr);
          const left = this.extend(expr.left, w, lower, unsigned);
          const right = this.extend(expr.right, w, lower, unsigned);
          return divide(left, right, w, !unsigned, expr.kind === "mod");
        }
        case "shl":
        case "shr":
        case "ashl":
        case "ashr": {
          const arith = expr.kind === "ashl" || expr.kind === "ashr";
          const signedLeft = this.isSigned(expr.left);
          const w = width ?? this.selfWidth(expr.left);
          if (w === null) throw new VerilogError("width is not known");
          const value = this.extend(expr.left, w, lower, arith ? !signedLeft : true);
          const dir = expr.kind === "shl" || expr.kind === "ashl" ? "shl" : "shr";
          const signFill = expr.kind === "ashr" && signedLeft;
          if (expr.right.kind === "const") {
            return shiftConst(
              value,
              expr.right.value,
              dir,
              signFill ? (value[value.length - 1] ?? "0") : "0",
              names,
            );
          }
          const amountW = this.selfWidth(expr.right) ?? minBits(0);
          return barrel(
            value,
            lower(expr.right, amountW),
            dir,
            (current) => (signFill ? (current[current.length - 1] ?? "0") : "0"),
            names,
          );
        }
        case "index": {
          const sig = this.must(expr.name);
          const folded = this.fold(expr.index);
          if (folded !== null) {
            if (sig.memLo !== null) {
              if (folded < sig.memLo || folded > (sig.memHi ?? sig.memLo))
                throw new VerilogError(`'${expr.name}[${folded}]' is out of range`);
              const word = memWord(sig, folded);
              return word.map((bit, index) =>
                names?.[index] && names[index] !== bit ? connect(names[index] ?? bit, bit) : bit,
              );
            }
            return lower({ kind: "ref", name: expr.name, hi: folded, lo: folded }, width, names);
          }
          const amountW = this.selfWidth(expr.index) ?? 1;
          const idx = lower(expr.index, amountW);
          if (sig.memLo !== null) {
            // A mux tree per bit loses to one shared address decode on a wide word.
            const hi = sig.memHi ?? sig.memLo;
            const word: string[] = [];
            for (let bit = sig.lsb; bit <= sig.msb; bit += 1) {
              const terms: string[] = [];
              for (let addr = sig.memLo; addr <= hi; addr += 1) {
                const match = decode(idx, addr);
                if (match === "0") continue;
                const cell = memWord(sig, addr)[bit - sig.lsb] ?? "0";
                terms.push(match === "1" ? cell : emit("AND", [cell, match]));
              }
              const acc = orTree(terms);
              const named = names?.[bit - sig.lsb];
              word.push(named && named !== acc ? connect(named, acc) : acc);
            }
            return word;
          }
          const all = readName(expr.name);
          const span = idx.length < 31 ? 2 ** idx.length : all.length;
          const choices = Array.from({ length: span }, (_, value) =>
            value < all.length ? (all[value] ?? "0") : "0",
          );
          const acc = muxLayers(choices, idx);
          const named = names?.[0];
          return [named && named !== acc ? connect(named, acc) : acc];
        }
        case "lt":
        case "gt":
        case "le":
        case "ge": {
          const w = this.pairWidth(expr.left, expr.right);
          const signedOp = this.isSigned(expr.left) && this.isSigned(expr.right);
          const left = this.extend(expr.left, w, lower, !signedOp);
          const right = this.extend(expr.right, w, lower, !signedOp);
          if (!signedOp) {
            const swapped = expr.kind === "gt" || expr.kind === "le";
            const a = swapped ? right : left;
            const b = invertBits(swapped ? left : right);
            const cout = addCached(a, b, "1").cout;
            const less = expr.kind === "lt" || expr.kind === "gt";
            return [less ? emit("INV", [cout]) : cout];
          }
          const bitNot = invertOne;
          const bitAnd = (a: string, b: string): string =>
            a === "0" || b === "0" ? "0" : a === "1" ? b : b === "1" ? a : emit("AND", [a, b]);
          const bitOr = (a: string, b: string): string =>
            a === "1" || b === "1" ? "1" : a === "0" ? b : b === "0" ? a : emit("OR", [a, b]);
          const bitXor = (a: string, b: string): string =>
            a === "0"
              ? b
              : b === "0"
                ? a
                : a === "1"
                  ? bitNot(b)
                  : b === "1"
                    ? bitNot(a)
                    : emit("XOR", [a, b]);
          const signedLess = (a: string[], b: string[]): string => {
            const cout = addCached(a, invertBits(b), "1").cout;
            const uns = emit("INV", [cout]);
            const sa = a[a.length - 1] ?? "0";
            const sb = b[b.length - 1] ?? "0";
            return bitOr(bitAnd(sa, bitNot(sb)), bitAnd(bitNot(bitXor(sa, sb)), uns));
          };
          if (expr.kind === "lt") return [signedLess(left, right)];
          if (expr.kind === "gt") return [signedLess(right, left)];
          if (expr.kind === "le") return [bitNot(signedLess(right, left))];
          return [bitNot(signedLess(left, right))];
        }
        case "eq":
        case "ne": {
          const w = this.pairWidth(expr.left, expr.right);
          const left = this.extend(expr.left, w, lower);
          const right = this.extend(expr.right, w, lower);
          let acc = "";
          let differ = false;
          for (let index = 0; index < w; index += 1) {
            const a = left[index] ?? "0";
            const b = right[index] ?? "0";
            if (a === b && (a === "0" || a === "1")) continue;
            if ((a === "0" || a === "1") && (b === "0" || b === "1")) {
              differ = true;
              break;
            }
            const diff = emit("XOR", [a, b]);
            const same = emit("INV", [diff]);
            acc = acc === "" ? same : emit("AND", [acc, same]);
          }
          if (differ) acc = "0";
          else if (acc === "") acc = "1";
          if (expr.kind === "ne") acc = acc === "0" ? "1" : acc === "1" ? "0" : emit("INV", [acc]);
          return [acc];
        }
        case "mux": {
          const w = width ?? this.selfWidth(expr.yes) ?? this.selfWidth(expr.no);
          if (w === null) throw new VerilogError("width is not known");
          const sel = orReduce(lower(expr.sel, null));
          const yes = this.align(expr.yes, w, lower);
          const no = this.align(expr.no, w, lower);
          return yes.map((bit, index) => emit("MUX", [sel, bit, no[index] ?? "0"], names?.[index]));
        }
        case "concat": {
          let bits: string[] = [];
          for (let index = expr.parts.length - 1; index >= 0; index -= 1) {
            const part = expr.parts[index];
            if (!part) continue;
            if (part.kind === "const" && part.width === null)
              throw new VerilogError("unsized number in a concatenation needs a width");
            const w = this.selfWidth(part);
            if (w === null)
              throw new VerilogError("unsized number in a concatenation needs a width");
            bits = bits.concat(lower(part, w));
          }
          return bits;
        }
        case "rep": {
          const count = evalConst(expr.count, this.constParams);
          if (count < 1) throw new VerilogError("replication count must be at least 1");
          if (expr.inner.kind === "const" && expr.inner.width === null)
            throw new VerilogError("unsized number in a replication needs a width");
          const partWidth = this.selfWidth(expr.inner);
          if (partWidth === null)
            throw new VerilogError("unsized number in a replication needs a width");
          if (count * partWidth > MAX_WIDTH)
            throw new VerilogError(`at most ${MAX_WIDTH} bits in this build`);
          const part = lower(expr.inner, partWidth);
          let bits: string[] = [];
          for (let copy = 0; copy < count; copy += 1) bits = bits.concat(part);
          return bits;
        }
        case "lognot":
          return [emit("INV", [orReduce(lower(expr.arg, this.selfWidth(expr.arg)))])];
        case "logand":
        case "logor":
          return [
            emit(expr.kind === "logand" ? "AND" : "OR", [
              orReduce(lower(expr.left, this.selfWidth(expr.left))),
              orReduce(lower(expr.right, this.selfWidth(expr.right))),
            ]),
          ];
        case "reduce":
          return [reduceBits(lower(expr.arg, this.selfWidth(expr.arg)), expr.op)];
        case "slice": {
          const width = this.constWidth(expr.width);
          const sig = this.must(expr.name);
          if (sig.memLo !== null)
            throw new VerilogError(`'${expr.name}' is a memory; select a word`);
          const base = this.fold(expr.base);
          if (base !== null) {
            const lo = expr.up ? base : base - width + 1;
            const hi = expr.up ? base + width - 1 : base;
            return lower({ kind: "ref", name: expr.name, hi, lo }, width, names);
          }
          const all = readName(expr.name);
          const amount = this.baseAmount(expr.base, sig.msb);
          const idx = lower(expr.base, amount);
          const span = 1 << amount;
          const out: string[] = [];
          for (let k = 0; k < width; k += 1) {
            const choices: string[] = [];
            for (let value = 0; value < span; value += 1) {
              const bit = expr.up ? value + k : value - width + 1 + k;
              if (bit < sig.lsb || bit > sig.msb) choices.push("0");
              else choices.push(all[bit - sig.lsb] ?? "0");
            }
            const acc = muxLayers(choices, idx);
            const named = names?.[k];
            out.push(named && named !== acc ? connect(named, acc) : acc);
          }
          return out;
        }
        case "word": {
          const sig = this.must(expr.name);
          const word = lower({ kind: "index", name: expr.name, index: expr.index }, null);
          const hi = this.fold(expr.hi);
          const lo = this.fold(expr.lo);
          if (hi === null || lo === null)
            throw new VerilogError("a variable part-select of a memory word is later");
          const top = Math.max(hi, lo);
          const bot = Math.min(hi, lo);
          if (bot < sig.lsb || top > sig.msb)
            throw new VerilogError(`'${expr.name}' select is out of range`);
          const bits: string[] = [];
          for (let bit = bot; bit <= top; bit += 1) bits.push(word[bit - sig.lsb] ?? "0");
          return fit(bits, width ?? bits.length, false);
        }
        case "part": {
          const spec = this.indexedPart(expr.hi, expr.lo);
          return lower(
            {
              kind: "slice",
              name: expr.name,
              base: spec.base,
              width: { kind: "num", value: spec.width },
              up: true,
            },
            width,
            names,
          );
        }
        default: {
          const never: never = expr;
          throw new VerilogError(`bad expression '${String(never)}'`);
        }
      }
    };

    const driven = new Set<string>();
    const inferred: { line: number; signal: string; bits: string[]; width: number }[] = [];
    const noteLatch = (line: number, signal: string, bit: string, width: number): void => {
      const found = inferred.find((item) => item.line === line && item.signal === signal);
      if (found) found.bits.push(bit);
      else inferred.push({ line, signal, bits: [bit], width });
    };
    type Part = (string | undefined)[];
    const blank = (sig: Sig): Part =>
      Array.from(
        { length: sig.memLo !== null ? memBits(sig).length : widthOf(sig) },
        () => undefined,
      );
    const sliceOf = (
      sig: Sig,
      hi: number | null,
      lo: number | null,
    ): { lo: number; ids: string[] } => {
      const top = hi ?? sig.msb;
      const bot = lo ?? (hi === null ? sig.lsb : hi);
      if (top < bot || bot < sig.lsb || top > sig.msb)
        throw new VerilogError(`'${sig.name}' select is out of range`);
      const ids: string[] = [];
      for (let bit = bot; bit <= top; bit += 1) ids.push(bitName(sig, bit));
      return { lo: bot, ids };
    };
    const claim = (id: string, line: number): void => {
      if (driven.has(id)) throw new VerilogError(`line ${line}: '${id}' is already driven`);
      driven.add(id);
    };
    const paint = (part: Part, sig: Sig, lo: number, bits: string[]): Part => {
      const next = part.slice();
      bits.forEach((bit, index) => {
        next[lo - sig.lsb + index] = bit;
      });
      return next;
    };
    const tryShare = (sel: string, left: Part, right: Part): string[] | null => {
      if (this.mode !== "area") return null;
      if (left.some((bit) => bit === undefined) || right.some((bit) => bit === undefined))
        return null;
      const leftInfo = produced.get(left.join(","));
      const rightInfo = produced.get(right.join(","));
      if (
        !leftInfo ||
        !rightInfo ||
        leftInfo.op !== rightInfo.op ||
        leftInfo.out.length !== rightInfo.out.length
      )
        return null;
      const muxed = (a: string[], b: string[]) =>
        a.map((bit, index) => (bit === b[index] ? bit : emit("MUX", [sel, bit, b[index] ?? "0"])));
      if (leftInfo.op === "add") {
        note("shared adder");
        const a = muxed(leftInfo.a, rightInfo.a);
        const b = muxed(leftInfo.b, rightInfo.b);
        const cin =
          leftInfo.cin === rightInfo.cin
            ? leftInfo.cin
            : emit("MUX", [sel, leftInfo.cin, rightInfo.cin]);
        const sums = buildAdder(a, b, cin).sums;
        remember({ op: "add", a, b, cin, out: sums });
        return sums;
      }
      note("shared multiplier");
      const a = muxed(leftInfo.a, rightInfo.a);
      const b = muxed(leftInfo.b, rightInfo.b);
      const out = mulBits(this.mode, emit, a, b, leftInfo.out.length, recordAdder);
      remember({ op: "mul", a, b, cin: "0", out });
      return out;
    };
    const sharedOutputs = (rows: { cond: string | null; bits: Part }[]): Map<number, string[]> => {
      const found = new Map<number, string[]>();
      if (this.mode !== "area") return found;
      const lookup = (bits: Part) =>
        bits.every((bit) => bit !== undefined) ? produced.get(bits.join(",")) : undefined;
      const infos = rows.map((row) => lookup(row.bits));
      const used = new Set<number>();
      for (let start = 0; start < rows.length; start += 1) {
        if (used.has(start)) continue;
        const first = infos[start];
        if (!first) continue;
        const group = [start];
        for (let next = start + 1; next < rows.length; next += 1) {
          const info = infos[next];
          if (!info || info.op !== first.op || info.out.length !== first.out.length) continue;
          if (info.a.length !== first.a.length || info.b.length !== first.b.length) continue;
          group.push(next);
        }
        if (group.length < 2) continue;
        for (const index of group) used.add(index);
        const base = group.find((index) => rows[index]?.cond === null) ?? group[0] ?? start;
        const baseInfo = infos[base] ?? first;
        let a = baseInfo.a.slice();
        let b = baseInfo.b.slice();
        let cin = baseInfo.cin;
        for (const index of group) {
          if (index === base) continue;
          const info = infos[index];
          const cond = rows[index]?.cond;
          if (!info || !cond) continue;
          a = a.map((bit, pin) =>
            bit === info.a[pin] ? bit : emit("MUX", [cond, info.a[pin] ?? "0", bit]),
          );
          b = b.map((bit, pin) =>
            bit === info.b[pin] ? bit : emit("MUX", [cond, info.b[pin] ?? "0", bit]),
          );
          cin = cin === info.cin ? cin : emit("MUX", [cond, info.cin, cin]);
        }
        let shared: string[];
        if (baseInfo.op === "add") {
          note("shared adder");
          shared = buildAdder(a, b, cin).sums;
          remember({ op: "add", a, b, cin, out: shared });
        } else {
          note("shared multiplier");
          shared = mulBits(this.mode, emit, a, b, baseInfo.out.length);
          remember({ op: "mul", a, b, cin: "0", out: shared });
        }
        for (const index of group) found.set(index, shared);
      }
      return found;
    };
    const locate = (
      stmt: Extract<Stmt, { kind: "set" }>,
    ): { hi: number | null; lo: number | null; index: Expr | null; slice: SliceSel | null } => {
      if (stmt.part) {
        const spec = this.indexedPart(stmt.part.hi, stmt.part.lo);
        const base = this.fold(spec.base);
        if (base === null)
          return {
            hi: null,
            lo: null,
            index: null,
            slice: { base: spec.base, width: { kind: "num", value: spec.width }, up: true },
          };
        return { hi: base + spec.width - 1, lo: base, index: null, slice: null };
      }
      if (stmt.slice) {
        const width = this.constWidth(stmt.slice.width);
        const base = this.fold(stmt.slice.base);
        if (base === null) return { hi: null, lo: null, index: null, slice: stmt.slice };
        const lo = stmt.slice.up ? base : base - width + 1;
        const hi = stmt.slice.up ? base + width - 1 : base;
        return { hi, lo, index: null, slice: null };
      }
      if (!stmt.index) return { hi: stmt.hi, lo: stmt.lo, index: null, slice: null };
      const value = this.fold(stmt.index);
      if (value === null) return { hi: stmt.hi, lo: stmt.lo, index: stmt.index, slice: null };
      const sig = this.must(stmt.target);
      if (sig.memLo !== null)
        return { hi: null, lo: null, index: { kind: "const", value, width: null }, slice: null };
      return { hi: value, lo: value, index: null, slice: null };
    };
    const matchLabels = (
      sel: Expr,
      labels: { value: number; width: number | null; wild?: number; name?: string }[],
    ): string | null => {
      if (labels.length === 0) return null;
      let acc: string | null = null;
      for (const label of labels) {
        let value = label.value;
        if (label.name) {
          const found = this.constParams.get(label.name);
          if (found === undefined) throw new VerilogError(`unknown parameter '${label.name}'`);
          value = found;
        }
        let mask = 0;
        for (let bit = 0; bit < (label.width ?? 0); bit += 1) mask = mask * 2 + 1;
        const care = label.wild ? mask - label.wild : null;
        const bit = orReduce(
          lower(
            {
              kind: "eq",
              left:
                care === null
                  ? sel
                  : {
                      kind: "and",
                      left: sel,
                      right: { kind: "const", value: care, width: label.width },
                    },
              right: {
                kind: "const",
                value: care === null ? value : value & care,
                width: label.width,
              },
            },
            null,
          ),
        );
        if (acc === null || acc === "0") acc = bit;
        else if (bit === "0" || acc === "1") continue;
        else if (bit === "1") acc = "1";
        else acc = emit("OR", [acc, bit]);
      }
      return acc;
    };
    const labelHits = (
      label: { value: number; wild?: number; name?: string },
      span: number,
    ): number[] | null => {
      let value = label.value;
      if (label.name) {
        const found = this.constParams.get(label.name);
        if (found === undefined) return null;
        value = found;
      }
      if (!Number.isInteger(value) || value < 0) return null;
      const wild = label.wild ?? 0;
      const care = ~wild >>> 0;
      const hits: number[] = [];
      for (let n = 0; n < span; n += 1) {
        if ((n & care) === ((value & care) & (span - 1))) hits.push(n);
      }
      return hits;
    };
    const caseExclusive = (
      arms: { labels: { value: number; wild?: number; name?: string }[] }[],
      width: number,
    ): boolean => {
      if (width < 1 || width > 16) return false;
      const span = 2 ** width;
      const seen = new Set<number>();
      let defaults = 0;
      for (const arm of arms) {
        if (arm.labels.length === 0) {
          defaults += 1;
          if (defaults > 1) return false;
          continue;
        }
        for (const label of arm.labels) {
          const hits = labelHits(label, span);
          if (!hits || hits.length === 0) return false;
          for (const value of hits) {
            if (seen.has(value)) return false;
            seen.add(value);
          }
        }
      }
      return true;
    };
    const muxTree = (leaves: readonly string[], bits: readonly string[]): string => {
      const walk = (lo: number, hi: number, bit: number): string => {
        if (hi - lo <= 1) return leaves[lo] ?? "0";
        const mid = (lo + hi) >> 1;
        const down = walk(lo, mid, bit - 1);
        const up = walk(mid, hi, bit - 1);
        if (down === up) return down;
        const sel = bits[bit] ?? "0";
        if (sel === "0") return down;
        if (sel === "1") return up;
        return emit("MUX", [sel, up, down]);
      };
      return walk(0, leaves.length, bits.length - 1);
    };
    const writeJoin = (
      stmt: Extract<Stmt, { kind: "join" }>,
      env: Map<string, Part> | null,
      seq: boolean,
      wireOnly = false,
    ): void => {
      if (seq && stmt.blocking) throw new VerilogError(`line ${stmt.line}: use <= inside always`);
      const specs = stmt.parts.map((part) => {
        const sig = this.must(part.name);
        if (wireOnly && sig.reg)
          throw new VerilogError(`line ${stmt.line}: '${sig.name}' is a reg; use <= inside always`);
        if (seq && !sig.reg)
          throw new VerilogError(`line ${stmt.line}: '${sig.name}' is not a reg`);
        if (sig.dir === "input")
          throw new VerilogError(`line ${stmt.line}: '${sig.name}' is an input`);
        const hi = part.hi ?? sig.msb;
        const lo = part.lo ?? (part.hi === null ? sig.lsb : part.hi);
        return { sig, lo, width: hi - lo + 1 };
      });
      const total = specs.reduce((sum, spec) => sum + spec.width, 0);
      if (total > MAX_WIDTH)
        throw new VerilogError(`line ${stmt.line}: at most ${MAX_WIDTH} bits in this build`);
      let bits = fit(lower(stmt.expr, total), total, this.isSigned(stmt.expr));
      for (let index = specs.length - 1; index >= 0; index -= 1) {
        const spec = specs[index];
        if (!spec) continue;
        const slice = bits.slice(0, spec.width);
        bits = bits.slice(spec.width);
        if (env === null) {
          const ids = sliceOf(spec.sig, spec.lo + spec.width - 1, spec.lo).ids;
          for (const id of ids) claim(id, stmt.line);
          ids.forEach((id, bit) => {
            const value = slice[bit] ?? "0";
            if (value !== id) connect(id, value);
          });
        } else {
          env.set(
            spec.sig.name,
            paint(env.get(spec.sig.name) ?? blank(spec.sig), spec.sig, spec.lo, slice),
          );
        }
      }
    };
    let comboHold: Map<string, Part> | null = null;
    const writeComboMem = (
      stmt: Extract<Stmt, { kind: "set" }>,
      sig: Sig,
      at: {
        hi: number | null;
        lo: number | null;
        index: Expr | null;
      },
      env: Map<string, Part> | null,
    ): void => {
      const indexExpr =
        at.index ??
        (at.hi !== null && at.lo === null
          ? { kind: "const" as const, value: at.hi, width: null }
          : null);
      if (!indexExpr || sig.memLo === null)
        throw new VerilogError(`line ${stmt.line}: write a memory on posedge clk`);
      const width = widthOf(sig);
      const data = fit(lower(stmt.expr, width), width, this.isSigned(stmt.expr));
      const cur = ((env ? env.get(sig.name) : comboHold?.get(sig.name)) ?? blank(sig)).slice();
      const hi = sig.memHi ?? sig.memLo;
      const folded = this.fold(indexExpr);
      if (folded !== null) {
        if (folded < sig.memLo || folded > hi)
          throw new VerilogError(`line ${stmt.line}: '${sig.source}[${folded}]' is out of range`);
        for (let bit = 0; bit < width; bit += 1)
          cur[(folded - sig.memLo) * width + bit] = data[bit] ?? "0";
      } else {
        const idx = lower(indexExpr, this.selfWidth(indexExpr) ?? 1);
        const ids = memBits(sig);
        for (let addr = sig.memLo; addr <= hi; addr += 1) {
          const match = decode(idx, addr);
          for (let bit = 0; bit < width; bit += 1) {
            const pos = (addr - sig.memLo) * width + bit;
            if (match === "0") continue;
            const hold = cur[pos] ?? ids[pos] ?? "0";
            const incoming = data[bit] ?? "0";
            cur[pos] =
              match === "1" || hold === incoming ? incoming : emit("MUX", [match, incoming, hold]);
          }
        }
      }
      if (env) env.set(sig.name, cur);
      else comboHold?.set(sig.name, cur);
    };
    const walkCombo = (stmts: Stmt[], env: Map<string, Part> | null): void => {
      const saved = overlay;
      overlay = env;
      try {
        for (const stmt of stmts) {
          if (stmt.kind === "block") {
            walkCombo(stmt.body, env);
            continue;
          }
          if (stmt.kind === "for") {
            this.unroll(stmt, (body) => walkCombo(body, env));
            continue;
          }
          if (stmt.kind === "join") {
            writeJoin(stmt, env, false);
            continue;
          }
          if (stmt.kind === "set") {
            const sig = this.must(stmt.target);
            const at = locate(stmt);
            if (at.slice)
              throw new VerilogError(
                `line ${stmt.line}: a variable part-select on the left belongs in a clocked always`,
              );
            if (sig.memLo !== null) {
              writeComboMem(stmt, sig, at, env);
              continue;
            }
            if (at.index)
              throw new VerilogError(`line ${stmt.line}: a variable index on the left is later`);
            if (sig.dir === "input")
              throw new VerilogError(`line ${stmt.line}: '${sig.name}' is an input`);
            const slice = sliceOf(sig, at.hi, at.lo);
            const naming = env === null;
            if (naming) for (const id of slice.ids) claim(id, stmt.line);
            const bits = fit(
              lower(stmt.expr, slice.ids.length, naming ? slice.ids : undefined),
              slice.ids.length,
              this.isSigned(stmt.expr),
            );
            if (naming) {
              slice.ids.forEach((id, index) => {
                const bit = bits[index] ?? "0";
                if (bit !== id) connect(id, bit);
              });
            } else {
              env?.set(sig.name, paint(env.get(sig.name) ?? blank(sig), sig, slice.lo, bits));
            }
            continue;
          }
          if (stmt.kind === "case") {
            const selWidth = this.selfWidth(stmt.sel);
            const exclusive =
              selWidth !== null && caseExclusive(stmt.arms, selWidth) && selWidth <= 8;
            let selBits: string[] | null = null;
            const selectBits = (): string[] => {
              if (!selBits) selBits = lower(stmt.sel, selWidth ?? 1);
              return selBits;
            };
            const arms = stmt.arms.map((arm) => {
              const local = new Map<string, Part>();
              if (env) for (const [key, bits] of env) local.set(key, bits.slice());
              walkCombo(arm.body, local);
              const cond = matchLabels(stmt.sel, arm.labels);
              return { cond, local, labels: arm.labels };
            });
            const names = new Set<string>();
            for (const arm of arms) for (const key of arm.local.keys()) names.add(key);
            for (const sigName of names) {
              const sig = this.must(sigName);
              if (sig.memLo !== null) {
                const parent = env?.get(sigName) ?? comboHold?.get(sigName) ?? blank(sig);
                let acc = parent.slice();
                for (const arm of arms) {
                  const bits = arm.local.get(sigName);
                  if (!bits) continue;
                  if (!arm.cond) {
                    acc = bits.map((bit, index) => bit ?? acc[index]);
                    continue;
                  }
                  acc = acc.map((prev, index) => {
                    const left = bits[index];
                    if (left === undefined) return prev;
                    const right = prev ?? left;
                    return left === right ? left : emit("MUX", [arm.cond ?? "0", left, right]);
                  });
                }
                if (env) env.set(sigName, acc);
                else comboHold?.set(sigName, acc);
                continue;
              }
              const ids = bitsLSB(sig);
              const padded = arms.map((arm) => {
                const bits = blank(sig);
                (arm.local.get(sigName) ?? []).forEach((bit, index) => {
                  bits[index] = bit;
                });
                return { cond: arm.cond, bits };
              });
              const lookup = (bits: Part) =>
                bits.every((bit) => bit !== undefined) ? produced.get(bits.join(",")) : undefined;
              const op = padded
                .map((row) => lookup(row.bits)?.op)
                .find((kind) => kind !== undefined);
              const group = op ? padded.filter((row) => lookup(row.bits)?.op === op) : [];
              let shared: string[] | null = null;
              if (this.mode === "area" && group.length >= 2) {
                const first = lookup(group[0]?.bits ?? []);
                if (first) {
                  let a = first.a.slice();
                  let b = first.b.slice();
                  let cin = first.cin;
                  for (const row of group.slice(1)) {
                    const info = lookup(row.bits);
                    if (!info || !row.cond) continue;
                    a = a.map((bit, index) =>
                      bit === info.a[index]
                        ? bit
                        : emit("MUX", [row.cond ?? "0", info.a[index] ?? "0", bit]),
                    );
                    b = b.map((bit, index) =>
                      bit === info.b[index]
                        ? bit
                        : emit("MUX", [row.cond ?? "0", info.b[index] ?? "0", bit]),
                    );
                    cin = cin === info.cin ? cin : emit("MUX", [row.cond, info.cin, cin]);
                  }
                  if (first.op === "add") {
                    note("shared adder");
                    shared = buildAdder(a, b, cin).sums;
                    remember({ op: "add", a, b, cin, out: shared });
                  } else {
                    note("shared multiplier");
                    shared = mulBits(this.mode, emit, a, b, first.out.length, recordAdder);
                    remember({ op: "mul", a, b, cin: "0", out: shared });
                  }
                }
              }
              const explicit = padded.find((row) => row.cond === null);
              const span = selWidth === null ? 0 : 2 ** selWidth;
              const rowOf = new Array<number>(span).fill(-1);
              if (exclusive && selWidth !== null) {
                arms.forEach((arm, row) => {
                  for (const label of arm.labels) {
                    const hits = labelHits(label, span);
                    if (!hits) continue;
                    for (const value of hits) rowOf[value] = row;
                  }
                });
              }
              const def = arms.findIndex((arm) => arm.labels.length === 0);
              const leafBit = (row: number, index: number): string | undefined => {
                if (row < 0) return stmt.full ? "0" : undefined;
                const item = padded[row];
                if (!item) return undefined;
                if (shared && group.includes(item)) return shared[index];
                if (item.bits[index] !== undefined) return item.bits[index];
                return stmt.full ? "0" : undefined;
              };
              let tree: Part | null = null;
              if (exclusive && selWidth !== null && span > 0) {
                const covered = ids.every((_, index) => {
                  for (let value = 0; value < span; value += 1) {
                    const row = rowOf[value] >= 0 ? (rowOf[value] ?? -1) : def;
                    if (leafBit(row, index) === undefined) return false;
                  }
                  return true;
                });
                if (covered) {
                  const bits = selectBits();
                  tree = ids.map((_, index) => {
                    const leaves = Array.from({ length: span }, (_, value) => {
                      const row = rowOf[value] >= 0 ? (rowOf[value] ?? -1) : def;
                      return leafBit(row, index) ?? "0";
                    });
                    return muxTree(leaves, bits);
                  });
                }
              }
              let acc: Part = tree
                ? tree
                : explicit && group.includes(explicit) && shared
                  ? shared
                  : (explicit?.bits ?? blank(sig));
              if (!tree) {
                for (const row of padded) {
                  if (!row.cond) continue;
                  const bits: Part = group.includes(row) && shared ? shared : row.bits;
                  const next = blank(sig);
                  for (let index = 0; index < ids.length; index += 1) {
                    const left = stmt.full ? (bits[index] ?? "0") : bits[index];
                    const right = stmt.full ? (acc[index] ?? "0") : acc[index];
                    if (left === undefined && right === undefined) continue;
                    const id = ids[index] ?? sigName;
                    if (left !== undefined && right !== undefined)
                      next[index] = left === right ? left : emit("MUX", [row.cond, left, right]);
                    else if (env !== null && env.get(sigName)?.[index] !== undefined) {
                      const prev = env.get(sigName)?.[index] ?? "0";
                      const incoming = left ?? right ?? "0";
                      const choose = left !== undefined ? row.cond : emit("INV", [row.cond]);
                      next[index] =
                        incoming === prev ? incoming : emit("MUX", [choose, incoming, prev]);
                    } else if (!sig.reg)
                      throw new VerilogError(
                        `line ${stmt.line}: latch on '${sig.source}'; declare it reg`,
                      );
                    else {
                      noteLatch(stmt.line, sig.source, id, ids.length);
                      const en = left !== undefined ? row.cond : emit("INV", [row.cond]);
                      next[index] = emit("LATCH", [en, left ?? right ?? "0"]);
                    }
                  }
                  acc = next;
                }
              }
              if (env === null) {
                ids.forEach((id, index) => {
                  const bit = acc[index];
                  if (bit === undefined) return;
                  if (!driven.has(id)) claim(id, stmt.line);
                  if (bit !== id) connect(id, bit);
                });
              } else env.set(sigName, acc);
            }
            continue;
          }
          const sel = orReduce(lower(stmt.cond, null));
          const yes = new Map<string, Part>();
          const no = new Map<string, Part>();
          if (env) {
            for (const [key, bits] of env) {
              yes.set(key, bits.slice());
              no.set(key, bits.slice());
            }
          }
          walkCombo(stmt.yes, yes);
          walkCombo(stmt.no, no);
          for (const sigName of new Set([...yes.keys(), ...no.keys()])) {
            const sig = this.must(sigName);
            const ay = yes.get(sigName) ?? blank(sig);
            const an = no.get(sigName) ?? blank(sig);
            if (env && ay.length === an.length && ay.every((bit, index) => bit === an[index])) {
              env.set(sigName, ay);
              continue;
            }
            if (sig.memLo !== null) {
              const parent = env?.get(sigName) ?? comboHold?.get(sigName) ?? blank(sig);
              const merged = blank(sig);
              const ids = memBits(sig);
              for (let index = 0; index < ids.length; index += 1) {
                const left = ay[index] !== undefined ? ay[index] : parent[index];
                const right = an[index] !== undefined ? an[index] : parent[index];
                if (left === undefined || right === undefined) {
                  if (left === undefined && right === undefined) continue;
                  throw new VerilogError(`line ${stmt.line}: write a memory on posedge clk`);
                }
                merged[index] = left === right ? left : emit("MUX", [sel, left, right]);
              }
              if (env) env.set(sigName, merged);
              else comboHold?.set(sigName, merged);
              continue;
            }
            const ids = bitsLSB(sig);
            const shared = tryShare(sel, ay, an);
            if (shared) {
              const merged = shared.map((bit, index) => {
                const id = ids[index] ?? sigName;
                if (env !== null) return bit;
                claim(id, stmt.line);
                return bit === id ? bit : connect(id, bit);
              });
              if (env) env.set(sigName, merged);
              continue;
            }
            const merged = blank(sig);
            for (let index = 0; index < ids.length; index += 1) {
              const left = ay[index];
              const right = an[index];
              if (left === undefined && right === undefined) continue;
              const id = ids[index] ?? sigName;
              if (left !== undefined && right !== undefined) {
                if (env === null) claim(id, stmt.line);
                const net =
                  left === right
                    ? left
                    : emit(
                        "MUX",
                        [sel, left, right],
                        env === null && left !== right ? id : undefined,
                      );
                merged[index] = env === null && net !== id ? connect(id, net) : net;
              } else if (env !== null && env.get(sigName)?.[index] !== undefined) {
                const prev = env.get(sigName)?.[index] ?? "0";
                const incoming = left ?? right ?? "0";
                const choose = left !== undefined ? sel : emit("INV", [sel]);
                merged[index] =
                  incoming === prev ? incoming : emit("MUX", [choose, incoming, prev]);
              } else if (!sig.reg) {
                throw new VerilogError(`line ${stmt.line}: latch on '${sigName}'; declare it reg`);
              } else {
                noteLatch(stmt.line, sigName, id, ids.length);
                const en = left !== undefined ? sel : emit("INV", [sel]);
                const latch = emit("LATCH", [en, left ?? right ?? "0"]);
                if (env === null) {
                  claim(id, stmt.line);
                  merged[index] = connect(id, latch);
                } else merged[index] = latch;
              }
            }
            if (env) env.set(sigName, merged);
          }
        }
      } finally {
        overlay = saved;
      }
    };
    const walkSeq = (
      stmts: Stmt[],
      state: Map<string, Part>,
      fallback: (sig: string, index: number, ids: string[]) => string,
    ): void => {
      const read = (sig: string, index: number, ids: string[]): string => {
        const bit = state.get(sig)?.[index];
        if (bit !== undefined) return bit;
        return fallback(sig, index, ids);
      };
      const saved = overlay;
      overlay = null;
      try {
        for (const stmt of stmts) {
          if (stmt.kind === "block") {
            walkSeq(stmt.body, state, fallback);
            continue;
          }
          if (stmt.kind === "for") {
            this.unroll(stmt, (body) => walkSeq(body, state, fallback));
            continue;
          }
          if (stmt.kind === "join") {
            writeJoin(stmt, state, true);
            continue;
          }
          if (stmt.kind === "set") {
            if (stmt.blocking) throw new VerilogError(`line ${stmt.line}: use <= inside always`);
            const sig = this.must(stmt.target);
            if (!sig.reg) throw new VerilogError(`line ${stmt.line}: '${sig.name}' is not a reg`);
            const at = locate(stmt);
            if (at.slice) {
              const width = this.constWidth(at.slice.width);
              const data = fit(lower(stmt.expr, width), width, this.isSigned(stmt.expr));
              const amount = this.baseAmount(at.slice.base, sig.msb, stmt.line);
              const idx = lower(at.slice.base, amount);
              const span = 1 << amount;
              const ids = bitsLSB(sig);
              const cur = (state.get(sig.name) ?? blank(sig)).slice();
              for (let bit = sig.lsb; bit <= sig.msb; bit += 1) {
                const pos = bit - sig.lsb;
                let hold = read(sig.name, pos, ids);
                for (let value = 0; value < span; value += 1) {
                  const src = at.slice.up ? bit - value : bit - (value - width + 1);
                  if (src < 0 || src >= width) continue;
                  const match = decode(idx, value);
                  if (match === "0") continue;
                  const incoming = data[src] ?? "0";
                  hold =
                    match === "1"
                      ? incoming
                      : hold === incoming
                        ? hold
                        : emit("MUX", [match, incoming, hold]);
                }
                cur[pos] = hold;
              }
              state.set(sig.name, cur);
              continue;
            }
            if (sig.memLo !== null || at.index) {
              const indexExpr =
                at.index ??
                (at.hi !== null && at.lo === null
                  ? { kind: "const" as const, value: at.hi, width: null }
                  : null);
              if (!indexExpr || sig.memLo === null)
                throw new VerilogError(`line ${stmt.line}: a variable index on the left is later`);
              const width = widthOf(sig);
              const data = fit(lower(stmt.expr, width), width, this.isSigned(stmt.expr));
              const cur = (state.get(sig.name) ?? blank(sig)).slice();
              const hi = sig.memHi ?? sig.memLo;
              const folded = this.fold(indexExpr);
              if (folded !== null) {
                if (folded < sig.memLo || folded > hi)
                  throw new VerilogError(
                    `line ${stmt.line}: '${sig.source}[${folded}]' is out of range`,
                  );
                for (let bit = 0; bit < width; bit += 1)
                  cur[(folded - sig.memLo) * width + bit] = data[bit] ?? "0";
              } else {
                const idx = lower(indexExpr, this.selfWidth(indexExpr) ?? 1);
                const ids = memBits(sig);
                for (let addr = sig.memLo; addr <= hi; addr += 1) {
                  const match = decode(idx, addr);
                  for (let bit = 0; bit < width; bit += 1) {
                    const at = (addr - sig.memLo) * width + bit;
                    if (match === "0") continue;
                    const hold = read(sig.name, at, ids);
                    const incoming = data[bit] ?? "0";
                    if (match === "1") cur[at] = incoming;
                    else cur[at] = hold === incoming ? hold : emit("MUX", [match, incoming, hold]);
                  }
                }
              }
              state.set(sig.name, cur);
              continue;
            }
            const slice = sliceOf(sig, at.hi, at.lo);
            const bits = fit(
              lower(stmt.expr, slice.ids.length),
              slice.ids.length,
              this.isSigned(stmt.expr),
            );
            state.set(sig.name, paint(state.get(sig.name) ?? blank(sig), sig, slice.lo, bits));
            continue;
          }
          if (stmt.kind === "case") {
            const selWidth = this.selfWidth(stmt.sel);
            const exclusive = selWidth !== null && caseExclusive(stmt.arms, selWidth);
            const arms = stmt.arms.map((arm) => {
              const local = new Map<string, Part>();
              walkSeq(arm.body, local, read);
              const cond = matchLabels(stmt.sel, arm.labels);
              return { cond, local };
            });
            const names = new Set<string>();
            for (const arm of arms) for (const key of arm.local.keys()) names.add(key);
            for (const sigName of names) {
              const sig = this.must(sigName);
              const ids = sig.memLo !== null ? memBits(sig) : bitsLSB(sig);
              const padded = arms.map((arm) => {
                const bits = blank(sig);
                (arm.local.get(sigName) ?? []).forEach((bit, index) => {
                  bits[index] = bit;
                });
                return { cond: arm.cond, bits };
              });
              const sharedAt = sharedOutputs(padded);
              const explicit = padded.findIndex((row) => row.cond === null);
              const holdAt = (index: number): string => read(sigName, index, ids);
              const fromRow = (rowIndex: number, index: number): string | undefined => {
                const shared = sharedAt.get(rowIndex);
                if (shared) return shared[index];
                return padded[rowIndex]?.bits[index];
              };
              let anyLabel: string | null = null;
              if (
                exclusive &&
                explicit >= 0 &&
                ids.some((_, index) => fromRow(explicit, index) !== undefined)
              ) {
                for (const row of padded) {
                  const cond = row.cond;
                  if (!cond || cond === "0") continue;
                  if (cond === "1") {
                    anyLabel = "1";
                    break;
                  }
                  anyLabel = anyLabel === null ? cond : emit("OR", [anyLabel, cond]);
                }
              }
              const acc = exclusive
                ? ids.map((_, index) => {
                    let value = holdAt(index);
                    for (let rowIndex = padded.length - 1; rowIndex >= 0; rowIndex -= 1) {
                      const cond = padded[rowIndex]?.cond;
                      if (!cond || cond === "0") continue;
                      const written = fromRow(rowIndex, index);
                      if (written === undefined || written === value) continue;
                      value = cond === "1" ? written : emit("MUX", [cond, written, value]);
                    }
                    const fallback = explicit < 0 ? undefined : fromRow(explicit, index);
                    if (fallback !== undefined && (anyLabel === null || anyLabel === "0"))
                      return fallback;
                    if (
                      fallback === undefined ||
                      fallback === value ||
                      anyLabel === null ||
                      anyLabel === "1"
                    )
                      return value;
                    return emit("MUX", [anyLabel, value, fallback]);
                  })
                : ids.map((_, index) => {
                    let prior =
                      explicit < 0 ? holdAt(index) : (fromRow(explicit, index) ?? holdAt(index));
                    for (let rowIndex = padded.length - 1; rowIndex >= 0; rowIndex -= 1) {
                      const cond = padded[rowIndex]?.cond;
                      if (!cond) continue;
                      const incoming = fromRow(rowIndex, index) ?? holdAt(index);
                      if (incoming !== prior) prior = emit("MUX", [cond, incoming, prior]);
                    }
                    return prior;
                  });
              state.set(sigName, acc);
            }
            continue;
          }
          const sel = orReduce(lower(stmt.cond, null));
          const yes = new Map<string, Part>();
          walkSeq(stmt.yes, yes, read);
          const no = new Map<string, Part>();
          walkSeq(stmt.no, no, read);
          for (const sigName of new Set([...yes.keys(), ...no.keys()])) {
            const sig = this.must(sigName);
            const ay = yes.get(sigName) ?? blank(sig);
            const an = no.get(sigName) ?? blank(sig);
            const cur = (state.get(sigName) ?? blank(sig)).slice();
            const ids = sig.memLo !== null ? memBits(sig) : bitsLSB(sig);
            const shared = tryShare(sel, ay, an);
            if (shared && shared.length === ids.length) {
              shared.forEach((bit, index) => {
                cur[index] = bit;
              });
              state.set(sigName, cur);
              continue;
            }
            for (let index = 0; index < ids.length; index += 1) {
              const left = ay[index];
              const right = an[index];
              if (left === undefined && right === undefined) continue;
              const hold = read(sigName, index, ids);
              const av = left ?? hold;
              const bv = right ?? hold;
              cur[index] = av === bv ? av : emit("MUX", [sel, av, bv]);
            }
            state.set(sigName, cur);
          }
        }
      } finally {
        overlay = saved;
      }
    };
    const isReset = (expr: Expr, pin: string, level: 0 | 1): boolean => {
      const ref = expr.kind === "not" || expr.kind === "lognot" ? expr.arg : expr;
      const hit = ref.kind === "ref" && ref.name === pin && ref.hi === null;
      if (!hit) return false;
      return level === 1 ? expr.kind === "ref" : expr.kind === "not" || expr.kind === "lognot";
    };
    const takeReset = (stmts: Stmt[], into: Map<string, Part>): void => {
      for (const stmt of stmts) {
        if (stmt.kind === "block") {
          takeReset(stmt.body, into);
          continue;
        }
        if (stmt.kind === "for") {
          this.unroll(stmt, (body) => takeReset(body, into));
          continue;
        }
        if (stmt.kind !== "set") {
          throw new VerilogError(`line ${stmt.line}: asynchronous reset must be a constant`);
        }
        const resetValue = this.fold(stmt.expr);
        if (resetValue === null) {
          throw new VerilogError(`line ${stmt.line}: asynchronous reset must be a constant`);
        }
        if (stmt.blocking) throw new VerilogError(`line ${stmt.line}: use <= inside always`);
        const at = locate(stmt);
        if (at.slice || at.index)
          throw new VerilogError(
            `line ${stmt.line}: asynchronous reset of a variable select is later`,
          );
        const sig = this.must(stmt.target);
        if (!sig.reg) throw new VerilogError(`line ${stmt.line}: '${sig.name}' is not a reg`);
        const slice = sliceOf(sig, at.hi, at.lo);
        into.set(
          sig.name,
          paint(
            into.get(sig.name) ?? blank(sig),
            sig,
            slice.lo,
            constBits(resetValue, slice.ids.length),
          ),
        );
      }
    };
    const emitState = (
      state: Map<string, Part>,
      resets: Map<string, Part>,
      rstPin: string | null,
      line: number,
    ): void => {
      for (const sigName of new Set([...state.keys(), ...resets.keys()])) {
        const sig = this.must(sigName);
        const data = state.get(sigName) ?? blank(sig);
        const reset = resets.get(sigName) ?? blank(sig);
        const ids = sig.memLo !== null ? memBits(sig) : bitsLSB(sig);
        ids.forEach((id, index) => {
          const bit = data[index];
          const value = reset[index];
          if (bit === undefined && value === undefined) {
            if (sig.memLo === null) return;
            claim(id, line);
            emit("DFF", ["0"], id);
            return;
          }
          claim(id, line);
          const pin = bit ?? id;
          if (value !== undefined && rstPin) emit("DFF", [pin, rstPin, value], id);
          else emit("DFF", [pin], id);
        });
      }
    };

    const portBits = (expr: Expr, line: number, port: string): string[] => {
      if (expr.kind === "ref") {
        const target = this.must(expr.name);
        if (target.memLo !== null) {
          if (expr.hi === null || expr.lo !== null)
            throw new VerilogError(`line ${line}: '${port}' must connect to a net`);
          const hi = target.memHi ?? target.memLo;
          if (expr.hi < target.memLo || expr.hi > hi)
            throw new VerilogError(`line ${line}: '${expr.name}[${expr.hi}]' is out of range`);
          const ids: string[] = [];
          for (let bit = target.lsb; bit <= target.msb; bit += 1)
            ids.push(memBit(target, expr.hi, bit));
          return ids;
        }
        return expr.hi === null ? bitsLSB(target) : sliceOf(target, expr.hi, expr.lo).ids;
      }
      if (expr.kind === "index") {
        const value = this.fold(expr.index);
        if (value === null) throw new VerilogError(`line ${line}: '${port}' must connect to a net`);
        const target = this.must(expr.name);
        if (target.memLo !== null) {
          const hi = target.memHi ?? target.memLo;
          if (value < target.memLo || value > hi)
            throw new VerilogError(`line ${line}: '${expr.name}[${value}]' is out of range`);
          const ids: string[] = [];
          for (let bit = target.lsb; bit <= target.msb; bit += 1)
            ids.push(memBit(target, value, bit));
          return ids;
        }
        return sliceOf(target, value, value).ids;
      }
      if (expr.kind === "part") {
        const spec = this.indexedPart(expr.hi, expr.lo);
        const base = this.fold(spec.base);
        if (base === null) throw new VerilogError(`line ${line}: '${port}' must connect to a net`);
        return sliceOf(this.must(expr.name), base + spec.width - 1, base).ids;
      }
      if (expr.kind === "slice") {
        const width = this.constWidth(expr.width);
        const base = this.fold(expr.base);
        if (base === null) throw new VerilogError(`line ${line}: '${port}' must connect to a net`);
        const lo = expr.up ? base : base - width + 1;
        const hi = expr.up ? base + width - 1 : base;
        return sliceOf(this.must(expr.name), hi, lo).ids;
      }
      throw new VerilogError(`line ${line}: '${port}' must connect to a net`);
    };
    const childWarnings: string[] = [];
    const instantiate = (item: Item): void => {
      const mod = this.modules.find((candidate) => candidate.name === item.module);
      if (!mod || !item.inst)
        throw new VerilogError(`line ${item.line}: unknown module '${item.module ?? ""}'`);
      if (this.stack.includes(mod.name))
        throw new VerilogError(`line ${item.line}: '${mod.name}' is recursive`);
      const childParams = new Map<string, number>();
      const childWidths = new Map<string, number>();
      for (const param of mod.params)
        this.bindValue(param.name, param.value, childParams, childWidths, childParams);
      for (const local of mod.locals) {
        if (childParams.has(local.name))
          throw new VerilogError(`localparam '${local.name}' is already defined`);
        this.bindValue(local.name, local.value, childParams, childWidths, childParams);
      }
      for (const [index, override] of (item.params ?? []).entries()) {
        const key = override.name === "" ? mod.params[index]?.name : override.name;
        if (!key || !mod.params.some((param) => param.name === key)) {
          throw new VerilogError(
            `line ${item.line}: unknown parameter '${override.name || index}'`,
          );
        }
        const scope = new Map<string, number>([...params, ...this.loopVars, ...childParams]);
        const widthScope = new Map<string, number>([...this.paramWidths, ...childWidths]);
        childParams.set(key, evalConst(override.value, scope));
        const width = this.takeWidth(override.value, widthScope);
        if (width === null) childWidths.delete(key);
        else childWidths.set(key, width);
      }
      const saved = {
        sigs: this.sigs,
        order: this.order,
        alias: this.alias,
        prefix: this.prefix,
        constParams: this.constParams,
        paramWidths: this.paramWidths,
        integers: this.integers,
        loopVars: this.loopVars,
        genSuffix: this.genSuffix,
      };
      this.stack.push(mod.name);
      this.depth += 1;
      this.define(mod, childParams, `${item.inst}${this.genSuffix}_`);
      this.loopVars = new Map();
      this.genSuffix = "";
      this.paramWidths = childWidths;
      const child = this.elaborate(mod.name, mod.items, childParams);
      const childOrder = this.order.slice();
      this.sigs = saved.sigs;
      this.order = saved.order;
      this.alias = saved.alias;
      this.prefix = saved.prefix;
      this.constParams = saved.constParams;
      this.paramWidths = saved.paramWidths;
      this.integers = saved.integers;
      this.loopVars = saved.loopVars;
      this.genSuffix = saved.genSuffix;
      this.depth -= 1;
      this.stack.pop();
      for (const warning of child.warnings ?? []) childWarnings.push(warning);
      const conns = new Map((item.conns ?? []).map((conn) => [conn.port, conn.expr]));
      const rename = new Map<string, string>();
      for (const sig of childOrder) {
        if (sig.dir === "local") continue;
        const expr = conns.get(sig.source);
        if (!expr) throw new VerilogError(`line ${item.line}: '${sig.source}' is not connected`);
        if (sig.source === "clk") {
          if (expr.kind !== "ref" || expr.name !== "clk" || expr.hi !== null)
            throw new VerilogError(`line ${item.line}: clk must be the clock`);
          continue;
        }
        const bits = bitsLSB(sig);
        if (sig.dir === "input") {
          const from = lower(expr, bits.length);
          if (from.length !== bits.length)
            throw new VerilogError(`line ${item.line}: '${sig.source}' width does not match`);
          bits.forEach((bit, index) => rename.set(bit, from[index] ?? "0"));
          continue;
        }
        const dest = portBits(expr, item.line, sig.source);
        if (dest.length !== bits.length)
          throw new VerilogError(`line ${item.line}: '${sig.source}' width does not match`);
        dest.forEach((id) => claim(id, item.line));
        bits.forEach((bit, index) => rename.set(bit, dest[index] ?? bit));
      }
      for (const gate of child.gates) {
        const id = rename.get(gate.id) ?? gate.id;
        if (used.has(id)) throw new VerilogError(`line ${item.line}: '${id}' is already a net`);
        used.add(id);
        gates.push({ id, op: gate.op, ins: gate.ins.map((net) => rename.get(net) ?? net) });
      }
    };

    const fixedSlice = (
      item: Item,
    ): { hi: number | null; lo: number | null; index: Expr | null } => {
      if (item.part) {
        const spec = this.indexedPart(item.part.hi, item.part.lo);
        const base = this.fold(spec.base);
        if (base === null)
          throw new VerilogError(
            `line ${item.line}: a variable part-select on the left belongs in a clocked always`,
          );
        return { hi: base + spec.width - 1, lo: base, index: null };
      }
      if (!item.slice)
        return { hi: item.hi ?? null, lo: item.lo ?? null, index: item.index ?? null };
      const width = this.constWidth(item.slice.width);
      const base = this.fold(item.slice.base);
      if (base === null)
        throw new VerilogError(
          `line ${item.line}: a variable part-select on the left belongs in a clocked always`,
        );
      const lo = item.slice.up ? base : base - width + 1;
      const hi = item.slice.up ? base + width - 1 : base;
      return { hi, lo, index: null };
    };
    const elaborateItem = (item: Item): void => {
      if (item.kind === "genfor") {
        this.loopOver(
          {
            name: item.gen ?? "",
            init: item.init ?? { kind: "num", value: 0 },
            rel: item.rel ?? "<",
            bound: item.bound ?? { kind: "num", value: 0 },
            dir: item.dir ?? 1,
            step: item.step ?? { kind: "num", value: 1 },
            line: item.line,
          },
          (n) => {
            const saved = this.genSuffix;
            this.genSuffix = `${saved}_${n}`;
            for (const child of item.items ?? []) elaborateItem(child);
            this.genSuffix = saved;
          },
        );
        return;
      }
      if (item.kind === "genif") {
        const scope = new Map<string, number>([...this.constParams, ...this.loopVars]);
        const cond = evalConst(item.condExpr ?? { kind: "num", value: 0 }, scope);
        for (const child of (cond !== 0 ? item.yes : item.no) ?? []) elaborateItem(child);
        return;
      }
      if (item.kind === "instance") {
        instantiate(item);
        return;
      }
      if (item.kind === "assign") {
        if (item.joins && item.expr) {
          writeJoin(
            { kind: "join", parts: item.joins, expr: item.expr, blocking: true, line: item.line },
            null,
            false,
            true,
          );
          return;
        }
        const sig = this.must(item.target ?? "");
        const fixed = fixedSlice(item);
        if (sig.memLo !== null || fixed.index)
          throw new VerilogError(`line ${item.line}: write a memory on posedge clk`);
        if (sig.reg)
          throw new VerilogError(`line ${item.line}: '${sig.name}' is a reg; use <= inside always`);
        if (sig.dir === "input")
          throw new VerilogError(`line ${item.line}: '${sig.name}' is an input`);
        const slice = sliceOf(sig, fixed.hi, fixed.lo);
        for (const id of slice.ids) claim(id, item.line);
        const bits = fit(
          lower(item.expr ?? { kind: "const", value: 0, width: 1 }, slice.ids.length, slice.ids),
          slice.ids.length,
          this.isSigned(item.expr ?? { kind: "const", value: 0, width: 1 }),
        );
        slice.ids.forEach((id, index) => {
          const bit = bits[index] ?? "0";
          if (bit !== id) connect(id, bit);
        });
        return;
      }
      if (item.seq) {
        if (item.rst) {
          const head = item.body?.length === 1 ? item.body[0] : undefined;
          if (!head || head.kind !== "if" || !isReset(head.cond, item.rst, item.rstLevel ?? 1)) {
            throw new VerilogError(
              `line ${item.line}: asynchronous reset must be if (rst) ... else ...`,
            );
          }
          const resets = new Map<string, Part>();
          takeReset(head.yes, resets);
          const state = new Map<string, Part>();
          walkSeq(head.no, state, (_sig, index, ids) => ids[index] ?? "0");
          emitState(
            state,
            resets,
            item.rstLevel === 0 ? emit("INV", [item.rst]) : item.rst,
            item.line,
          );
        } else {
          const state = new Map<string, Part>();
          walkSeq(item.body ?? [], state, (_sig, index, ids) => ids[index] ?? "0");
          emitState(state, new Map(), null, item.line);
        }
        return;
      }
      const frame = new Map<string, Part>();
      walkCombo(item.body ?? [], frame);
      for (const [sigName, bits] of frame) {
        const sig = this.must(sigName);
        const ids = sig.memLo !== null ? memBits(sig) : bitsLSB(sig);
        ids.forEach((id, index) => {
          const bit = bits[index];
          if (bit === undefined || bit === id) return;
          if (driven.has(id)) return;
          claim(id, item.line);
          connect(id, bit);
        });
      }
    };
    for (const item of items) elaborateItem(item);

    for (const sig of this.order) {
      if (sig.dir !== "output") continue;
      const missing = bitsLSB(sig).filter((id) => !driven.has(id));
      if (missing.length === bitsLSB(sig).length)
        throw new VerilogError(`output '${sig.name}' is not driven`);
      if (missing[0]) throw new VerilogError(`'${missing[0]}' is not driven`);
    }
    const hasFlop = gates.some((gate) => gate.op === "DFF");
    const usesClock = clocked || hasFlop;
    if (usesClock && !this.order.some((sig) => sig.dir === "input" && sig.source === "clk")) {
      throw new VerilogError("expected input clk");
    }
    const inputs: string[] = [];
    const outputs: string[] = [];
    for (const sig of this.order) {
      if (sig.dir === "input" && !(usesClock && sig.source === "clk")) inputs.push(...bitsMSB(sig));
      if (sig.dir === "output") outputs.push(...bitsMSB(sig));
    }
    const swept = sweepState(gates, outputs, adders, inputs);
    const warnings = [
      ...inferred.map((item) => {
        const label =
          item.bits.length === item.width
            ? `'${item.signal}'`
            : `'${item.signal}' (${item.bits.join(", ")})`;
        return `line ${item.line}: latch inferred for ${label} — a path does not assign it`;
      }),
      ...flopWarnings(swept.flops),
      ...childWarnings,
    ];
    const kept = swept.gates;
    if (this.depth > 0) {
      return {
        name,
        inputs,
        outputs,
        gates: kept,
        warnings,
        notes: [...this.notes],
        adders: swept.adders,
      };
    }
    return validate({
      name,
      inputs,
      outputs,
      gates: kept,
      warnings,
      notes: [...this.notes],
      adders: swept.adders,
    });
  }

  private must(name: string): Sig {
    if (this.integers.has(name) && !this.loopVars.has(name))
      throw new VerilogError(`'${name}' is a loop index, not a net`);
    const sig = this.sigs.get(this.alias.get(name) ?? name);
    if (!sig) throw new VerilogError(`unknown net '${name}'`);
    return sig;
  }

  private takeWidth(expr: CExpr, widths: Map<string, number>): number | null {
    if (expr.kind === "num") return expr.width ?? null;
    if (expr.kind === "name") return widths.get(expr.name) ?? null;
    return null;
  }

  private bindValue(
    name: string,
    value: CExpr,
    params: Map<string, number>,
    widths: Map<string, number>,
    scope: Map<string, number>,
  ): void {
    const folded = evalConst(value, scope);
    params.set(name, folded);
    const width = this.takeWidth(value, widths);
    if (width === null) widths.delete(name);
    else widths.set(name, width);
    scope.set(name, folded);
  }

  private fold(expr: Expr): number | null {
    if (expr.kind === "const") return expr.value;
    if (expr.kind === "ref" && expr.hi === null && this.loopVars.has(expr.name))
      return this.loopVars.get(expr.name) ?? 0;
    if (expr.kind === "ref" && expr.hi === null && this.constParams.has(expr.name))
      return this.constParams.get(expr.name) ?? 0;
    if (expr.kind === "add" || expr.kind === "sub") {
      const left = this.fold(expr.left);
      const right = this.fold(expr.right);
      if (left === null || right === null) return null;
      return expr.kind === "add" ? left + right : left - right;
    }
    return null;
  }

  private constWidth(expr: CExpr): number {
    const width = evalConst(expr, new Map([...this.constParams, ...this.loopVars]));
    if (!Number.isInteger(width) || width < 1)
      throw new VerilogError("part-select width must be a positive constant");
    if (width > MAX_WIDTH) throw new VerilogError(`at most ${MAX_WIDTH} bits in this build`);
    return width;
  }

  private loopOver(
    stmt: {
      name: string;
      init: CExpr;
      rel: "<" | "<=" | ">" | ">=";
      bound: CExpr;
      dir: 1 | -1;
      step: CExpr;
      line: number;
    },
    visit: (n: number) => void,
  ): void {
    if (this.alias.has(stmt.name))
      throw new VerilogError(`line ${stmt.line}: the loop index cannot be a net`);
    const scope = new Map<string, number>([...this.constParams, ...this.loopVars]);
    let n = evalConst(stmt.init, scope);
    const bound = evalConst(stmt.bound, scope);
    const step = evalConst(stmt.step, scope);
    if (step === 0) throw new VerilogError(`line ${stmt.line}: the loop step must not be 0`);
    const saved = this.loopVars.get(stmt.name);
    const holds = (value: number): boolean => {
      if (stmt.rel === "<") return value < bound;
      if (stmt.rel === "<=") return value <= bound;
      if (stmt.rel === ">") return value > bound;
      return value >= bound;
    };
    let spins = 0;
    while (holds(n)) {
      if (++spins > 256) throw new VerilogError(`line ${stmt.line}: loop runs more than 256 times`);
      this.loopVars.set(stmt.name, n);
      visit(n);
      n += stmt.dir * step;
    }
    if (saved === undefined) this.loopVars.delete(stmt.name);
    else this.loopVars.set(stmt.name, saved);
  }

  private unroll(stmt: Extract<Stmt, { kind: "for" }>, visit: (body: Stmt[]) => void): void {
    this.loopOver(stmt, () => visit(stmt.body));
  }

  private isSigned(expr: Expr): boolean {
    switch (expr.kind) {
      case "const":
        return expr.width === null;
      case "ref":
        if (this.loopVars.has(expr.name) || this.constParams.has(expr.name)) return false;
        return expr.hi === null && this.must(expr.name).signed;
      case "index": {
        const sig = this.must(expr.name);
        return sig.memLo !== null && sig.signed;
      }
      case "not":
        return this.isSigned(expr.arg);
      case "and":
      case "or":
      case "xor":
      case "add":
      case "sub":
      case "mul":
      case "div":
      case "mod":
        return this.isSigned(expr.left) && this.isSigned(expr.right);
      case "ashl":
      case "ashr":
        return this.isSigned(expr.left);
      case "mux":
        return this.isSigned(expr.yes) && this.isSigned(expr.no);
      default:
        return false;
    }
  }

  private indexedPart(hi: Expr, lo: Expr): { base: Expr; width: number } {
    const scope = new Map<string, number>([...this.constParams, ...this.loopVars]);
    const top = linearOf(hi, scope);
    const bot = linearOf(lo, scope);
    if (!top || !bot)
      throw new VerilogError("the width of a variable part-select must be constant");
    const terms = new Map(top.terms);
    for (const [name, coeff] of bot.terms) {
      const next = (terms.get(name) ?? 0) - coeff;
      if (next === 0) terms.delete(name);
      else terms.set(name, next);
    }
    if (terms.size > 0)
      throw new VerilogError("the width of a variable part-select must be constant");
    const width = top.k - bot.k + 1;
    if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH)
      throw new VerilogError("part-select width is out of range");
    return { base: lo, width };
  }

  private selfWidth(expr: Expr): number | null {
    switch (expr.kind) {
      case "const":
        // An unsized integer is 32 bits. A sized literal keeps its width.
        return expr.width ?? 32;
      case "ref": {
        if (expr.hi === null && this.loopVars.has(expr.name)) return null;
        if (this.constParams.has(expr.name)) {
          if (expr.hi === null) return this.paramWidths.get(expr.name) ?? null;
          if (expr.lo === null) return 1;
          return expr.hi - expr.lo + 1;
        }
        const sig = this.must(expr.name);
        if (sig.memLo !== null) {
          if (expr.hi !== null && expr.lo === null) return widthOf(sig);
          throw new VerilogError(`'${expr.name}' is a memory; select a word`);
        }
        if (expr.hi === null) return widthOf(sig);
        if (expr.lo === null) return 1;
        return expr.hi - expr.lo + 1;
      }
      case "concat": {
        let width = 0;
        for (const part of expr.parts) {
          const partWidth = this.selfWidth(part);
          if (partWidth === null) return null;
          width += partWidth;
        }
        return width;
      }
      case "rep": {
        const count = evalConst(expr.count, this.constParams);
        if (count < 1) throw new VerilogError("replication count must be at least 1");
        const part = this.selfWidth(expr.inner);
        if (part === null) return null;
        const width = count * part;
        if (width > MAX_WIDTH) throw new VerilogError(`at most ${MAX_WIDTH} bits in this build`);
        return width;
      }
      case "index": {
        const sig = this.must(expr.name);
        return sig.memLo !== null ? widthOf(sig) : 1;
      }
      case "word": {
        const hi = this.fold(expr.hi);
        const lo = this.fold(expr.lo);
        if (hi === null || lo === null) return null;
        return Math.abs(hi - lo) + 1;
      }
      case "slice":
        return this.constWidth(expr.width);
      case "part":
        return this.indexedPart(expr.hi, expr.lo).width;
      case "eq":
      case "ne":
      case "lt":
      case "gt":
      case "le":
      case "ge":
      case "lognot":
      case "logand":
      case "logor":
      case "reduce":
        return 1;
      case "not":
        return this.selfWidth(expr.arg);
      case "and":
      case "or":
      case "xor":
      case "add":
      case "sub":
      case "div":
      case "mod": {
        const left = this.selfWidth(expr.left);
        const right = this.selfWidth(expr.right);
        if (left === null || right === null) return null;
        return Math.max(left, right);
      }
      case "mul": {
        const left = this.selfWidth(expr.left);
        const right = this.selfWidth(expr.right);
        if (left === null || right === null) return null;
        const width = left + right;
        if (width > MAX_WIDTH) throw new VerilogError(`at most ${MAX_WIDTH} bits in this build`);
        return width;
      }
      case "shl":
      case "shr":
      case "ashl":
      case "ashr":
        return this.selfWidth(expr.left);
      case "mux": {
        const yes = this.selfWidth(expr.yes);
        const no = this.selfWidth(expr.no);
        if (yes === null || no === null) return null;
        return Math.max(yes, no);
      }
      default:
        return null;
    }
  }

  private pairWidth(left: Expr, right: Expr): number {
    const lw = this.selfWidth(left);
    const rw = this.selfWidth(right);
    if (lw !== null && rw !== null) return Math.max(lw, rw);
    if (lw !== null) return lw;
    if (rw !== null) return rw;
    if (left.kind === "const" && right.kind === "const")
      return Math.max(minBits(left.value), minBits(right.value));
    throw new VerilogError("width is not known");
  }

  /** Bits of a variable part-select base. An unsized base uses the vector's own index width. */
  private baseAmount(base: Expr, highest: number, line?: number): number {
    // A bare integer is 32 bits in an expression, but a part-select base only
    // needs the bits that pick a bit of the vector. Unsized literals must not
    // inflate that index (a[s+3:s] is as wide as s, not 32).
    let amount = this.indexWidth(base);
    if (amount === null && (base.kind === "add" || base.kind === "sub")) {
      const left = this.indexWidth(base.left);
      const right = this.indexWidth(base.right);
      if (left !== null || right !== null) amount = Math.max(left ?? 0, right ?? 0);
    }
    if (amount === null) amount = minBits(Math.max(highest, 0));
    if (amount > 12) {
      const where = line === undefined ? "" : `line ${line}: `;
      throw new VerilogError(`${where}part-select base is wider than 12 bits`);
    }
    return Math.max(1, amount);
  }

  /** Width of an index, treating an unsized integer as "no contribution". */
  private indexWidth(expr: Expr): number | null {
    if (expr.kind === "const") return expr.width;
    if (
      expr.kind === "add" ||
      expr.kind === "sub" ||
      expr.kind === "mul" ||
      expr.kind === "and" ||
      expr.kind === "or" ||
      expr.kind === "xor"
    ) {
      const left = this.indexWidth(expr.left);
      const right = this.indexWidth(expr.right);
      if (expr.kind === "mul") {
        if (left === null || right === null) return null;
        const width = left + right;
        return width > MAX_WIDTH ? null : width;
      }
      if (left === null) return right;
      if (right === null) return left;
      return Math.max(left, right);
    }
    return this.selfWidth(expr);
  }

  /**
   * Operators whose Verilog width is the surrounding context. A wider
   * destination must be computed at that width; padding a narrow result
   * drops the carry (and inverts the wrong bits of a bitwise not).
   */
  private contextWidth(expr: Expr, width: number): number | null {
    const self = this.selfWidth(expr);
    if (self === null) return width;
    if (width <= self) return null;
    switch (expr.kind) {
      case "add":
      case "sub":
      case "and":
      case "or":
      case "xor":
      case "not":
      case "shl":
      case "shr":
      case "ashl":
      case "ashr":
      case "mux":
        return width;
      default:
        return null;
    }
  }

  private align(
    expr: Expr,
    width: number,
    lower: (expr: Expr, width: number | null, names?: string[]) => string[],
  ): string[] {
    if (expr.kind === "const") return constBits(expr.value, width);
    const bits = lower(expr, this.contextWidth(expr, width));
    if (bits.length === width) return bits;
    if (bits.length > width) return bits.slice(0, width);
    return [...bits, ...Array.from({ length: width - bits.length }, () => "0")];
  }

  private extend(
    expr: Expr,
    width: number,
    lower: (expr: Expr, width: number | null, names?: string[]) => string[],
    forceUnsigned = false,
  ): string[] {
    if (expr.kind === "const") return constBits(expr.value, width);
    const signed = !forceUnsigned && this.isSigned(expr);
    const bits = lower(expr, this.contextWidth(expr, width));
    if (bits.length > width) return bits.slice(0, width);
    if (bits.length === width) return bits;
    const fill = signed ? (bits[bits.length - 1] ?? "0") : "0";
    return [...bits, ...Array.from({ length: width - bits.length }, () => fill)];
  }

  private peek(ahead = 0): Token {
    while (this.buf.length <= ahead) this.buf.push(this.lex());
    return this.buf[ahead] ?? { kind: "eof", text: "", line: this.line };
  }

  private next(): Token {
    const tok = this.peek();
    this.buf.shift();
    return tok;
  }

  private eat(text: string): boolean {
    if (this.peek().text !== text) return false;
    this.next();
    return true;
  }

  private expect(kind: Token["kind"], text?: string): Token {
    const tok = this.next();
    if (tok.kind !== kind || (text !== undefined && tok.text !== text)) {
      throw this.fail(`expected ${text ?? kind}, got '${tok.text || "end"}'`, tok.line);
    }
    return tok;
  }

  private fail(message: string, line = this.peek().line): VerilogError {
    return new VerilogError(`line ${line}: ${message}`);
  }

  private finishTranslate(): void {
    const source = this.source;
    const end = source.length;
    const on = source.indexOf("translate_on", this.index);
    if (on < 0) throw new VerilogError(`line ${this.line}: translate_off has no translate_on`);
    while (this.index < on) {
      if (source[this.index] === "\n") this.line += 1;
      this.index += 1;
    }
    this.index += "translate_on".length;
    while (this.index < end) {
      const ch = source[this.index] ?? "";
      if (ch === "\n") break;
      if (ch === "*" && source[this.index + 1] === "/") {
        this.index += 2;
        break;
      }
      this.index += 1;
    }
  }

  private lex(): Token {
    const source = this.source;
    const end = source.length;
    let lead = "";
    const tag = (token: Token): Token => {
      if (lead) token.lead = lead;
      return token;
    };
    while (this.index < end) {
      const ch = source[this.index] ?? "";
      if (ch === "/" && source[this.index + 1] === "/") {
        this.index += 2;
        const from = this.index;
        while (this.index < end && source[this.index] !== "\n") this.index += 1;
        lead += source.slice(from, this.index);
        if (lead.includes("translate_off")) {
          this.finishTranslate();
          lead = "";
        }
        continue;
      }
      if (ch === "/" && source[this.index + 1] === "*") {
        const start = this.line;
        this.index += 2;
        const from = this.index;
        while (
          this.index < end &&
          !(source[this.index] === "*" && source[this.index + 1] === "/")
        ) {
          if (source[this.index] === "\n") this.line += 1;
          this.index += 1;
        }
        if (this.index >= end) throw new VerilogError(`line ${start}: unterminated comment`);
        lead += source.slice(from, this.index);
        this.index += 2;
        if (lead.includes("translate_off")) {
          this.finishTranslate();
          lead = "";
        }
        continue;
      }
      if (ch === "\n") {
        this.line += 1;
        this.index += 1;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\r") {
        this.index += 1;
        continue;
      }
      break;
    }
    if (this.index >= end) return tag({ kind: "eof", text: "", line: this.line });
    const start = this.line;
    const ch = source[this.index] ?? "";
    if (ch === '"') {
      this.index += 1;
      while (this.index < end && source[this.index] !== '"') {
        if (source[this.index] === "\n") this.line += 1;
        if (source[this.index] === "\\") this.index += 1;
        this.index += 1;
      }
      if (this.index >= end) throw new VerilogError(`line ${start}: unterminated string`);
      this.index += 1;
      return tag({ kind: "id", text: '""', line: start });
    }
    if (ch === "$") {
      let text = "$";
      this.index += 1;
      while (this.index < end && /[A-Za-z0-9_]/.test(source[this.index] ?? ""))
        text += source[this.index++];
      return tag({ kind: "id", text, line: start });
    }
    if (/[A-Za-z_]/.test(ch)) {
      let text = "";
      while (this.index < end && /[A-Za-z0-9_]/.test(source[this.index] ?? ""))
        text += source[this.index++];
      return tag({ kind: "id", text, line: start });
    }
    if (/[0-9]/.test(ch)) {
      let text = "";
      while (this.index < end && /[0-9]/.test(source[this.index] ?? ""))
        text += source[this.index++];
      if (source[this.index] !== "'") {
        return tag({ kind: "num", text, line: start, value: Number(text), width: null });
      }
      this.index += 1;
      const base = (source[this.index++] ?? "").toLowerCase();
      const width = Number(text);
      if (width < 1 || width > MAX_WIDTH)
        throw new VerilogError(`line ${start}: at most ${MAX_WIDTH} bits in this build`);
      if (base === "b") {
        let bits = "";
        let wilds = "";
        while (this.index < end && /[01xXzZ?_]/.test(source[this.index] ?? "")) {
          const digit = source[this.index] ?? "";
          this.index += 1;
          if (digit === "_") continue;
          if (digit === "0" || digit === "1") {
            bits += digit;
            wilds += "0";
          } else {
            bits += "0";
            wilds += "1";
          }
        }
        if (bits.length === 0) throw new VerilogError(`line ${start}: missing bits`);
        if (bits.length > width) throw new VerilogError(`line ${start}: too many bits`);
        const wild = Number.parseInt(wilds, 2);
        return tag({
          kind: "num",
          text: bits,
          line: start,
          value: Number.parseInt(bits, 2),
          width,
          ...(wild > 0 ? { wild } : {}),
        });
      }
      if (base === "d" || base === "h") {
        const digits = base === "d" ? /[0-9_]/ : /[0-9a-fA-F_]/;
        let body = "";
        while (this.index < end && digits.test(source[this.index] ?? "")) {
          if (source[this.index] !== "_") body += source[this.index];
          this.index += 1;
        }
        if (body.length === 0) throw new VerilogError(`line ${start}: missing digits`);
        const value = base === "d" ? Number(body) : Number.parseInt(body, 16);
        if (value >= 2 ** width)
          throw new VerilogError(`line ${start}: value does not fit in ${width} bits`);
        return tag({ kind: "num", text: body, line: start, value, width });
      }
      throw new VerilogError(`line ${start}: only 'b, 'd, and 'h constants`);
    }
    const three = source.slice(this.index, this.index + 3);
    if (three === "<<<" || three === ">>>") {
      this.index += 3;
      return tag({ kind: "sym", text: three, line: start });
    }
    const two = source.slice(this.index, this.index + 2);
    if (["<=", ">=", "==", "!=", "&&", "||", "<<", ">>", "+:", "-:"].includes(two)) {
      this.index += 2;
      return tag({ kind: "sym", text: two, line: start });
    }
    this.index += 1;
    if ("()[]{};,.@#?:~^&|=<>!+-*/%".includes(ch))
      return tag({ kind: "sym", text: ch, line: start });
    throw new VerilogError(`line ${start}: unexpected '${ch}'`);
  }
}

function evalConst(expr: CExpr, params: Map<string, number>): number {
  switch (expr.kind) {
    case "num":
      return expr.value;
    case "name": {
      const value = params.get(expr.name);
      if (value === undefined) throw new VerilogError(`unknown parameter '${expr.name}'`);
      return value;
    }
    case "add":
      return evalConst(expr.left, params) + evalConst(expr.right, params);
    case "sub":
      return evalConst(expr.left, params) - evalConst(expr.right, params);
    case "mul":
      return evalConst(expr.left, params) * evalConst(expr.right, params);
    case "div": {
      const right = evalConst(expr.right, params);
      if (right === 0) throw new VerilogError("division by zero");
      return Math.trunc(evalConst(expr.left, params) / right);
    }
    case "mod": {
      const right = evalConst(expr.right, params);
      if (right === 0) throw new VerilogError("division by zero");
      return evalConst(expr.left, params) % right;
    }
    case "lt":
      return evalConst(expr.left, params) < evalConst(expr.right, params) ? 1 : 0;
    case "le":
      return evalConst(expr.left, params) <= evalConst(expr.right, params) ? 1 : 0;
    case "gt":
      return evalConst(expr.left, params) > evalConst(expr.right, params) ? 1 : 0;
    case "ge":
      return evalConst(expr.left, params) >= evalConst(expr.right, params) ? 1 : 0;
    case "eq":
      return evalConst(expr.left, params) === evalConst(expr.right, params) ? 1 : 0;
    case "ne":
      return evalConst(expr.left, params) !== evalConst(expr.right, params) ? 1 : 0;
    default: {
      const never: never = expr;
      throw new VerilogError(`bad constant '${String(never)}'`);
    }
  }
}

function flopWarnings(flops: SweptFlop[]): string[] {
  const unread = new Map<string, { base: string; bits: number[]; why: string }>();
  const notes: string[] = [];
  for (const flop of flops) {
    if (flop.reason === "duplicate") {
      notes.push(`removed duplicate flop '${flop.id}' — same input as '${flop.sameAs}'`);
      continue;
    }
    const match = /^(.*)_(\d+)$/.exec(flop.id);
    const base = match?.[1] ?? flop.id;
    const why =
      flop.reason === "no reader"
        ? "no reader"
        : flop.reason === "constant"
          ? "constant"
          : "not observable";
    const key = `${base}\0${why}`;
    const group = unread.get(key) ?? { base, bits: [], why };
    if (match?.[2]) group.bits.push(Number(match[2]));
    unread.set(key, group);
  }
  for (const group of unread.values()) {
    const bits = [...group.bits].sort((a, b) => a - b);
    const contig = bits.length > 1 && bits[bits.length - 1]! - bits[0]! + 1 === bits.length;
    const label = contig
      ? `'${group.base}' [${bits[bits.length - 1]}:${bits[0]}]`
      : bits.length === 1
        ? `'${group.base}' [${bits[0]}]`
        : `'${group.base}'`;
    notes.push(
      group.why === "constant"
        ? `removed constant flop ${label}`
        : `removed unread flop ${label} — ${group.why}`,
    );
  }
  return notes;
}

function memBit(sig: Sig, addr: number, index: number): string {
  return `${sig.name}_${addr}_${index}`;
}

function memBits(sig: Sig): string[] {
  const bits: string[] = [];
  const lo = sig.memLo ?? 0;
  const hi = sig.memHi ?? lo;
  for (let addr = lo; addr <= hi; addr += 1) {
    for (let index = sig.lsb; index <= sig.msb; index += 1) bits.push(memBit(sig, addr, index));
  }
  return bits;
}

function widthOf(sig: Sig): number {
  return sig.msb - sig.lsb + 1;
}

function bitName(sig: Sig, index: number): string {
  return sig.scalar ? sig.name : `${sig.name}_${index}`;
}

function bitsLSB(sig: Sig): string[] {
  const bits: string[] = [];
  for (let index = sig.lsb; index <= sig.msb; index += 1) bits.push(bitName(sig, index));
  return bits;
}

function bitsMSB(sig: Sig): string[] {
  return [...bitsLSB(sig)].reverse();
}

function bitOf(value: number, index: number): "0" | "1" {
  if (value < 0) return bitOf(((value % 4294967296) + 4294967296) % 4294967296, index);
  let left = value;
  for (let step = 0; step < index; step += 1) left = Math.floor(left / 2);
  return left % 2 === 1 ? "1" : "0";
}

function constBits(value: number, width: number): string[] {
  if (width < 1 || width > MAX_WIDTH) throw new VerilogError(`width ${width} is out of range`);
  const bits: string[] = [];
  for (let index = 0; index < width; index += 1) bits.push(bitOf(value, index));
  return bits;
}

function minBits(value: number): number {
  let bits = 1;
  let left = Math.abs(value);
  while (left > 1) {
    left = Math.floor(left / 2);
    bits += 1;
  }
  return bits;
}
