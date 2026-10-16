/** Technology-independent AIG passes: rewrite, resubstitution, balance, functional sweep, refactor. */

export type OptMode = "area" | "delay" | "load";

export interface OptFlags {
  rewrite: boolean;
  balance: boolean;
  sweep: boolean;
  refactor: boolean;
  resub?: boolean;
}

export interface OptStats {
  rewrite: number;
  balance: number;
  sweep: number;
  refactor: number;
  resub: number;
  depthBefore: number;
  depthAfter: number;
}

export interface AigIn {
  inputs: number;
  ands: { node: number; a: number; b: number }[];
  outputs: { name: string; lit: number }[];
}

export const OPT_ALL: OptFlags = {
  rewrite: true,
  balance: true,
  sweep: true,
  refactor: true,
  resub: true,
};
export const OPT_NONE: OptFlags = {
  rewrite: false,
  balance: false,
  sweep: false,
  refactor: false,
  resub: false,
};

interface AndRec {
  a: number;
  b: number;
}

interface Graph {
  nInputs: number;
  ands: Map<number, AndRec>;
  outputs: { name: string; lit: number }[];
  next: number;
  hash: Map<string, number>;
}

interface Pattern {
  ands: { a: number; b: number }[];
  out: number;
  nodes: number;
  depth: number;
}

interface Choice {
  node: number;
  lit: number;
}

const SUPPORT_LIMIT = 10;
const patternCache = new Map<string, { area: Pattern; delay: Pattern }>();

function litNode(lit: number): number {
  return lit >>> 1;
}

function coneHas(g: Graph, lit: number, target: number): boolean {
  const seen = new Set<number>();
  const stack = [litNode(lit)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || node === 0 || seen.has(node)) continue;
    if (node === target) return true;
    seen.add(node);
    const and = g.ands.get(node);
    if (!and) continue;
    stack.push(litNode(and.a), litNode(and.b));
  }
  return false;
}

function gAnd(g: Graph, a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  if (a === 1) return b;
  if (b === 1) return a;
  if (a === b) return a;
  if (a === (b ^ 1)) return 0;
  let x = a;
  let y = b;
  if (x > y) {
    const swap = x;
    x = y;
    y = swap;
  }
  const key = `${x},${y}`;
  const hit = g.hash.get(key);
  if (hit !== undefined && g.ands.has(hit)) return hit << 1;
  const node = g.next;
  g.next += 1;
  g.hash.set(key, node);
  g.ands.set(node, { a: x, b: y });
  return node << 1;
}

function undoFrom(g: Graph, mark: number) {
  for (const id of [...g.ands.keys()]) {
    if (id >= mark) g.ands.delete(id);
  }
  for (const [key, node] of g.hash) {
    if (node >= mark) g.hash.delete(key);
  }
  g.next = mark;
}

function load(input: AigIn): Graph {
  const ands = new Map<number, AndRec>();
  const hash = new Map<string, number>();
  let next = input.inputs + 1;
  for (const and of input.ands) {
    ands.set(and.node, { a: and.a, b: and.b });
    let x = and.a;
    let y = and.b;
    if (x > y) {
      const swap = x;
      x = y;
      y = swap;
    }
    hash.set(`${x},${y}`, and.node);
    if (and.node >= next) next = and.node + 1;
  }
  return {
    nInputs: input.inputs,
    ands,
    outputs: input.outputs.map((output) => ({ name: output.name, lit: output.lit })),
    next,
    hash,
  };
}

function clone(g: Graph): Graph {
  const ands = new Map<number, AndRec>();
  for (const [id, and] of g.ands) ands.set(id, { a: and.a, b: and.b });
  return {
    nInputs: g.nInputs,
    ands,
    outputs: g.outputs.map((output) => ({ name: output.name, lit: output.lit })),
    next: g.next,
    hash: new Map(g.hash),
  };
}

function topo(g: Graph): number[] {
  const indeg = new Map<number, number>();
  const users = new Map<number, number[]>();
  for (const id of g.ands.keys()) {
    indeg.set(id, 0);
    users.set(id, []);
  }
  for (const [id, and] of g.ands) {
    for (const lit of [and.a, and.b]) {
      const node = litNode(lit);
      if (!g.ands.has(node)) continue;
      indeg.set(id, (indeg.get(id) ?? 0) + 1);
      users.get(node)?.push(id);
    }
  }
  const ready = [...indeg.keys()].filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: number[] = [];
  let head = 0;
  while (head < ready.length) {
    const node = ready[head];
    head += 1;
    if (node === undefined) break;
    order.push(node);
    for (const user of users.get(node) ?? []) {
      const next = (indeg.get(user) ?? 1) - 1;
      indeg.set(user, next);
      if (next === 0) ready.push(user);
    }
  }
  if (order.length !== g.ands.size) throw new Error("AIG cycle during optimization");
  return order;
}

function reachable(g: Graph): Set<number> {
  const live = new Set<number>();
  const stack = g.outputs.map((output) => litNode(output.lit));
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || node === 0 || live.has(node) || !g.ands.has(node)) continue;
    live.add(node);
    const and = g.ands.get(node);
    if (!and) continue;
    stack.push(litNode(and.a), litNode(and.b));
  }
  return live;
}

function levels(g: Graph): Map<number, number> {
  const level = new Map<number, number>();
  for (let node = 1; node <= g.nInputs; node += 1) level.set(node, 0);
  for (const node of topo(g)) {
    const and = g.ands.get(node);
    if (!and) continue;
    const left = level.get(litNode(and.a)) ?? 0;
    const right = level.get(litNode(and.b)) ?? 0;
    level.set(node, 1 + Math.max(left, right));
  }
  return level;
}

function metrics(g: Graph): { nodes: number; depth: number } {
  const live = reachable(g);
  const level = levels(g);
  let depth = 0;
  for (const output of g.outputs) {
    if (output.lit <= 1) continue;
    depth = Math.max(depth, level.get(litNode(output.lit)) ?? 0);
  }
  return { nodes: live.size, depth };
}

function fanout(g: Graph): Map<number, number> {
  const refs = new Map<number, number>();
  const bump = (lit: number) => {
    const node = litNode(lit);
    if (node === 0) return;
    refs.set(node, (refs.get(node) ?? 0) + 1);
  };
  for (const and of g.ands.values()) {
    bump(and.a);
    bump(and.b);
  }
  for (const output of g.outputs) bump(output.lit);
  return refs;
}

function rebuild(g: Graph): Graph {
  const live = reachable(g);
  const fresh: Graph = {
    nInputs: g.nInputs,
    ands: new Map(),
    outputs: [],
    next: g.nInputs + 1,
    hash: new Map(),
  };
  const mapped = new Map<number, number>();
  const mapLit = (lit: number): number => {
    if (lit <= 1) return lit;
    const node = litNode(lit);
    if (!g.ands.has(node)) {
      if (node <= g.nInputs) return lit;
      throw new Error("optimizer dropped a live node");
    }
    const next = mapped.get(node);
    if (next === undefined) throw new Error("optimizer dropped a live node");
    return (lit & 1) === 1 ? next ^ 1 : next;
  };
  for (const node of topo(g)) {
    if (!live.has(node)) continue;
    const and = g.ands.get(node);
    if (!and) continue;
    mapped.set(node, gAnd(fresh, mapLit(and.a), mapLit(and.b)));
  }
  fresh.outputs = g.outputs.map((output) => ({ name: output.name, lit: mapLit(output.lit) }));
  return fresh;
}

function applyChosen(g: Graph, chosen: Choice[]): Graph {
  let active = chosen;
  let repl = new Map(active.map((choice) => [choice.node, choice.lit]));
  const resolve = (lit: number): number => {
    let current = lit;
    const seen = new Set<number>();
    while (repl.has(litNode(current)) && !seen.has(litNode(current))) {
      seen.add(litNode(current));
      const next = repl.get(litNode(current)) ?? current;
      current = (current & 1) === 1 ? next ^ 1 : next;
    }
    return current;
  };
  for (;;) {
    const dying = new Set(active.map((choice) => choice.node));
    const next = active.filter((choice) => !dying.has(litNode(resolve(choice.lit))));
    if (next.length === active.length) break;
    active = next;
    repl = new Map(active.map((choice) => [choice.node, choice.lit]));
  }
  const dying = new Set(active.map((choice) => choice.node));
  for (const choice of active) {
    const mapped = resolve(choice.lit);
    const mapLit = (lit: number) => {
      if (litNode(lit) !== choice.node) return lit;
      return (lit & 1) === 1 ? mapped ^ 1 : mapped;
    };
    for (const [id, and] of g.ands) {
      if (dying.has(id)) continue;
      and.a = mapLit(and.a);
      and.b = mapLit(and.b);
    }
    for (const output of g.outputs) output.lit = mapLit(output.lit);
  }
  for (const id of dying) g.ands.delete(id);
  return rebuild(g);
}

function mffcOf(g: Graph, root: number, refs: Map<number, number>): Set<number> {
  const dead = new Set<number>();
  const undo: [number, number][] = [];
  const drop = (node: number) => {
    if (node === 0 || !g.ands.has(node) || dead.has(node)) return;
    const prev = refs.get(node) ?? 0;
    undo.push([node, prev]);
    const next = prev - 1;
    refs.set(node, next);
    if (next > 0) return;
    dead.add(node);
    const and = g.ands.get(node);
    if (!and) return;
    drop(litNode(and.a));
    drop(litNode(and.b));
  };
  const and = g.ands.get(root);
  if (!and) return dead;
  dead.add(root);
  undo.push([root, refs.get(root) ?? 0]);
  refs.set(root, 0);
  drop(litNode(and.a));
  drop(litNode(and.b));
  for (let index = undo.length - 1; index >= 0; index -= 1) {
    const item = undo[index];
    if (item) refs.set(item[0], item[1]);
  }
  return dead;
}

function enumerateCuts(g: Graph): Map<number, number[][]> {
  const cuts = new Map<number, number[][]>();
  for (let node = 1; node <= g.nInputs; node += 1) cuts.set(node, [[node]]);
  for (const node of topo(g)) {
    const and = g.ands.get(node);
    if (!and) continue;
    const left = cuts.get(litNode(and.a)) ?? [[]];
    const right = cuts.get(litNode(and.b)) ?? [[]];
    const found: number[][] = [];
    const seen = new Set<string>();
    for (const a of left) {
      for (const b of right) {
        const merged = [...new Set([...a, ...b])]
          .filter((leaf) => leaf !== 0)
          .sort((x, y) => x - y);
        if (merged.length === 0 || merged.length > 4 || merged.includes(node)) continue;
        const key = merged.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(merged);
      }
    }
    found.sort((a, b) => a.length - b.length || a.join(",").localeCompare(b.join(",")));
    cuts.set(node, found.slice(0, 8));
  }
  return cuts;
}

function truthOf(g: Graph, rootLit: number, leaves: number[]): bigint | null {
  const leafSet = new Set(leaves);
  const order: number[] = [];
  const seen = new Set<number>();
  const stack: { n: number; done: boolean }[] = [{ n: litNode(rootLit), done: false }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top || top.n === 0 || leafSet.has(top.n)) continue;
    if (!g.ands.has(top.n)) return null;
    if (top.done) {
      order.push(top.n);
      continue;
    }
    if (seen.has(top.n)) continue;
    seen.add(top.n);
    stack.push({ n: top.n, done: true });
    const and = g.ands.get(top.n);
    if (!and) continue;
    stack.push({ n: litNode(and.a), done: false }, { n: litNode(and.b), done: false });
  }
  const width = leaves.length;
  const space = 1 << width;
  const ones = (1n << BigInt(space)) - 1n;
  const vars: bigint[] = [];
  for (let index = 0; index < width; index += 1) {
    let mask = 0n;
    for (let bit = 0; bit < space; bit += 1)
      if (((bit >> index) & 1) === 1) mask |= 1n << BigInt(bit);
    vars.push(mask);
  }
  const val = new Map<number, bigint>();
  val.set(0, 0n);
  leaves.forEach((leaf, index) => val.set(leaf, vars[index] ?? 0n));
  const read = (lit: number): bigint => {
    if (lit <= 1) return lit === 1 ? ones : 0n;
    const value = val.get(litNode(lit));
    if (value === undefined) throw new Error("cut eval missed a node");
    return (lit & 1) === 1 ? value ^ ones : value;
  };
  for (const node of order) {
    const and = g.ands.get(node);
    if (!and) continue;
    val.set(node, read(and.a) & read(and.b));
  }
  return read(rootLit);
}

function cofactor0(tt: bigint, width: number): { c0: bigint; c1: bigint } {
  let c0 = 0n;
  let c1 = 0n;
  const half = 1 << (width - 1);
  for (let i = 0; i < half; i += 1) {
    const base = i << 1;
    if (((tt >> BigInt(base)) & 1n) === 1n) c0 |= 1n << BigInt(i);
    if (((tt >> BigInt(base + 1)) & 1n) === 1n) c1 |= 1n << BigInt(i);
  }
  return { c0, c1 };
}

function repack(tt: bigint, n: number, order: number[]): bigint {
  let out = 0n;
  const space = 1 << n;
  for (let mask = 0; mask < space; mask += 1) {
    let old = 0;
    for (let bit = 0; bit < n; bit += 1) {
      if (((mask >> bit) & 1) === 1) old |= 1 << (order[bit] ?? 0);
    }
    if (((tt >> BigInt(old)) & 1n) === 1n) out |= 1n << BigInt(mask);
  }
  return out;
}

function patternDepth(n: number, ands: { a: number; b: number }[], out: number): number {
  const level = new Map<number, number>();
  for (let node = 1; node <= n; node += 1) level.set(node, 0);
  ands.forEach((and, index) => {
    const id = n + 1 + index;
    level.set(id, 1 + Math.max(level.get(litNode(and.a)) ?? 0, level.get(litNode(and.b)) ?? 0));
  });
  if (out <= 1) return 0;
  return level.get(litNode(out)) ?? 0;
}

function shannon(n: number, tt: bigint, order: number[]): Pattern {
  const ands: { a: number; b: number }[] = [];
  const hash = new Map<string, number>();
  let next = n + 1;
  const memo = new Map<string, number>();
  const and = (a: number, b: number): number => {
    if (a === 0 || b === 0) return 0;
    if (a === 1) return b;
    if (b === 1) return a;
    if (a === b) return a;
    if (a === (b ^ 1)) return 0;
    let x = a;
    let y = b;
    if (x > y) {
      const swap = x;
      x = y;
      y = swap;
    }
    const key = `${x},${y}`;
    const hit = hash.get(key);
    if (hit !== undefined) return hit << 1;
    const node = next;
    next += 1;
    hash.set(key, node);
    ands.push({ a: x, b: y });
    return node << 1;
  };
  const or = (a: number, b: number) => and(a ^ 1, b ^ 1) ^ 1;
  const rec = (sub: bigint, vars: number[]): number => {
    const width = vars.length;
    const mask = width >= 31 ? (1n << (1n << BigInt(width))) - 1n : (1n << BigInt(1 << width)) - 1n;
    const value = sub & mask;
    const key = `${value.toString()}:${vars.join(",")}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let lit: number;
    if (value === 0n) lit = 0;
    else if (value === mask) lit = 1;
    else if (width <= 1) {
      const variable = ((vars[0] ?? 0) + 1) << 1;
      if (value === 2n) lit = variable;
      else if (value === 1n) lit = variable ^ 1;
      else lit = value === 0n ? 0 : 1;
    } else {
      const { c0, c1 } = cofactor0(value, width);
      const rest = vars.slice(1);
      if (c0 === c1) lit = rec(c0, rest);
      else {
        const negative = rec(c0, rest);
        const positive = rec(c1, rest);
        const variable = ((vars[0] ?? 0) + 1) << 1;
        lit = or(and(variable, positive), and(variable ^ 1, negative));
      }
    }
    memo.set(key, lit);
    return lit;
  };
  const out = n === 0 ? (tt === 0n ? 0 : 1) : rec(repack(tt, n, order), order);
  return { ands, out, nodes: ands.length, depth: patternDepth(n, ands, out) };
}

function eachOrder(n: number, visit: (order: number[]) => void) {
  const order = Array.from({ length: n }, (_, index) => index);
  const rec = (k: number) => {
    if (k === n) {
      visit(order);
      return;
    }
    for (let i = k; i < n; i += 1) {
      const swap = order[k] ?? 0;
      order[k] = order[i] ?? 0;
      order[i] = swap;
      rec(k + 1);
      order[i] = order[k] ?? 0;
      order[k] = swap;
    }
  };
  rec(0);
}

function exactPatterns(n: number, tt: bigint): { area: Pattern; delay: Pattern } {
  const key = `${n}:${tt.toString()}`;
  const hit = patternCache.get(key);
  if (hit) return hit;
  if (n === 0) {
    const pattern = { ands: [], out: tt === 0n ? 0 : 1, nodes: 0, depth: 0 };
    const both = { area: pattern, delay: pattern };
    patternCache.set(key, both);
    return both;
  }
  let area: Pattern | null = null;
  let delay: Pattern | null = null;
  eachOrder(n, (order) => {
    const pattern = shannon(n, tt, [...order]);
    if (
      !area ||
      pattern.nodes < area.nodes ||
      (pattern.nodes === area.nodes && pattern.depth < area.depth)
    )
      area = pattern;
    if (
      !delay ||
      pattern.depth < delay.depth ||
      (pattern.depth === delay.depth && pattern.nodes < delay.nodes)
    ) {
      delay = pattern;
    }
  });
  if (!area || !delay) throw new Error("no pattern");
  const both = { area, delay };
  patternCache.set(key, both);
  return both;
}

function moveToFront(tt: bigint, width: number, place: number): bigint {
  if (place === 0) return tt;
  let out = 0n;
  const space = 1 << width;
  for (let mask = 0; mask < space; mask += 1) {
    const bit = mask & 1;
    const rest = mask >> 1;
    const lowMask = (1 << place) - 1;
    const low = rest & lowMask;
    const high = rest >> place;
    const old = low | (bit << place) | (high << (place + 1));
    if (((tt >> BigInt(old)) & 1n) === 1n) out |= 1n << BigInt(mask);
  }
  return out;
}

function greedyPattern(n: number, tt: bigint): Pattern {
  const ands: { a: number; b: number }[] = [];
  const hash = new Map<string, number>();
  let next = n + 1;
  const and = (a: number, b: number): number => {
    if (a === 0 || b === 0) return 0;
    if (a === 1) return b;
    if (b === 1) return a;
    if (a === b) return a;
    if (a === (b ^ 1)) return 0;
    let x = a;
    let y = b;
    if (x > y) {
      const swap = x;
      x = y;
      y = swap;
    }
    const key = `${x},${y}`;
    const hit = hash.get(key);
    if (hit !== undefined) return hit << 1;
    const node = next;
    next += 1;
    hash.set(key, node);
    ands.push({ a: x, b: y });
    return node << 1;
  };
  const or = (a: number, b: number) => and(a ^ 1, b ^ 1) ^ 1;
  const rec = (sub: bigint, vars: number[]): number => {
    const width = vars.length;
    const mask = (1n << (1n << BigInt(width))) - 1n;
    const value = sub & mask;
    if (value === 0n) return 0;
    if (value === mask) return 1;
    if (width <= 1) {
      const variable = ((vars[0] ?? 0) + 1) << 1;
      if (value === 2n) return variable;
      if (value === 1n) return variable ^ 1;
      return value === 0n ? 0 : 1;
    }
    let bestPlace = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let place = 0; place < width; place += 1) {
      const moved = moveToFront(value, width, place);
      const { c0, c1 } = cofactor0(moved, width);
      const space = 1 << (width - 1);
      const full = (1n << BigInt(space)) - 1n;
      let score: number;
      if (c0 === c1) score = -1000;
      else if (c0 === 0n || c0 === full || c1 === 0n || c1 === full) score = -100;
      else score = place;
      if (score < bestScore) {
        bestScore = score;
        bestPlace = place;
      }
    }
    const moved = moveToFront(value, width, bestPlace);
    const { c0, c1 } = cofactor0(moved, width);
    const variable = vars[bestPlace] ?? 0;
    const rest = vars.filter((_, index) => index !== bestPlace);
    if (c0 === c1) return rec(c0, rest);
    const negative = rec(c0, rest);
    const positive = rec(c1, rest);
    const select = (variable + 1) << 1;
    return or(and(select, positive), and(select ^ 1, negative));
  };
  const vars = Array.from({ length: n }, (_, index) => index);
  const out = rec(tt, vars);
  return { ands, out, nodes: ands.length, depth: patternDepth(n, ands, out) };
}

function patternsFor(n: number, tt: bigint, mode: OptMode): Pattern {
  if (n <= 5) {
    const both = exactPatterns(n, tt);
    return mode === "area" ? both.area : both.delay;
  }
  const key = `g:${n}:${tt.toString()}`;
  const hit = patternCache.get(key);
  if (hit) return mode === "area" ? hit.area : hit.delay;
  const greedy = greedyPattern(n, tt);
  let area = greedy;
  let delay = greedy;
  const orders = [
    Array.from({ length: n }, (_, index) => index),
    Array.from({ length: n }, (_, index) => n - 1 - index),
  ];
  for (const order of orders) {
    const pattern = shannon(n, tt, order);
    if (pattern.nodes < area.nodes || (pattern.nodes === area.nodes && pattern.depth < area.depth))
      area = pattern;
    if (
      pattern.depth < delay.depth ||
      (pattern.depth === delay.depth && pattern.nodes < delay.nodes)
    )
      delay = pattern;
  }
  patternCache.set(key, { area, delay });
  return mode === "area" ? area : delay;
}

/** Evaluate the area pattern of a truth table. Used to test the synthesizer. */
export function patternTruth(n: number, tt: bigint): bigint {
  const pattern = n <= 5 ? exactPatterns(n, tt).area : greedyPattern(n, tt);
  let out = 0n;
  const space = 1 << n;
  for (let mask = 0; mask < space; mask += 1) {
    const val = new Map<number, number>();
    for (let bit = 0; bit < n; bit += 1) val.set(bit + 1, (mask >> bit) & 1);
    pattern.ands.forEach((and, index) => {
      const left = (val.get(litNode(and.a)) ?? 0) ^ (and.a & 1);
      const right = (val.get(litNode(and.b)) ?? 0) ^ (and.b & 1);
      val.set(n + 1 + index, left & right);
    });
    const bit =
      pattern.out <= 1 ? pattern.out : (val.get(litNode(pattern.out)) ?? 0) ^ (pattern.out & 1);
    if (bit === 1) out |= 1n << BigInt(mask);
  }
  return out;
}

function instantiate(g: Graph, pattern: Pattern, leaves: number[]): number {
  const local = new Map<number, number>();
  leaves.forEach((leaf, index) => local.set(index + 1, leaf << 1));
  const resolve = (lit: number) => {
    if (lit <= 1) return lit;
    const mapped = local.get(litNode(lit));
    if (mapped === undefined) throw new Error("pattern leaf is missing");
    return (lit & 1) === 1 ? mapped ^ 1 : mapped;
  };
  pattern.ands.forEach((and, index) => {
    local.set(leaves.length + 1 + index, gAnd(g, resolve(and.a), resolve(and.b)));
  });
  return resolve(pattern.out);
}

function addedSince(g: Graph, mark: number): number {
  let count = 0;
  for (const id of g.ands.keys()) if (id >= mark) count += 1;
  return count;
}

function litLevel(g: Graph, lit: number, known: Map<number, number>, mark: number): number {
  const memo = new Map<number, number>();
  const rec = (node: number): number => {
    if (node === 0 || !g.ands.has(node)) return known.get(node) ?? 0;
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    const knownLevel = known.get(node);
    if (knownLevel !== undefined && node < mark) return knownLevel;
    const and = g.ands.get(node);
    if (!and) return 0;
    const value = 1 + Math.max(rec(litNode(and.a)), rec(litNode(and.b)));
    memo.set(node, value);
    return value;
  };
  if (lit <= 1) return 0;
  return rec(litNode(lit));
}

function betterChoice(
  mode: OptMode,
  volume: number,
  added: number,
  oldLevel: number,
  newLevel: number,
): boolean {
  if (mode === "area") return added < volume;
  return (added < volume && newLevel <= oldLevel) || (added <= volume && newLevel < oldLevel);
}

function acceptBatch(
  mode: OptMode,
  before: { nodes: number; depth: number },
  after: { nodes: number; depth: number },
): boolean {
  if (mode === "area") return after.nodes < before.nodes;
  return (
    (after.depth < before.depth && after.nodes <= before.nodes) ||
    (after.nodes < before.nodes && after.depth <= before.depth)
  );
}

function selectRewrite(g: Graph, mode: OptMode): Choice[] {
  const refs = fanout(g);
  const cuts = enumerateCuts(g);
  const level = levels(g);
  const blocked = new Set<number>();
  const chosen: Choice[] = [];
  for (const node of topo(g)) {
    const dead = mffcOf(g, node, refs);
    if ([...dead].some((item) => blocked.has(item))) continue;
    let kept = false;
    for (const cut of cuts.get(node) ?? []) {
      if (cut.includes(node) || cut.some((leaf) => blocked.has(leaf))) continue;
      const volume = [...dead].filter((item) => !cut.includes(item)).length;
      if (volume <= 0) continue;
      const tt = truthOf(g, node << 1, cut);
      if (tt === null) continue;
      const pattern = patternsFor(cut.length, tt, mode);
      if (pattern.nodes > volume) continue;
      const mark = g.next;
      const lit = instantiate(g, pattern, cut);
      const added = addedSince(g, mark);
      const newLevel = litLevel(g, lit, level, mark);
      const oldLevel = level.get(node) ?? 0;
      if (!betterChoice(mode, volume, added, oldLevel, newLevel) || coneHas(g, lit, node)) {
        undoFrom(g, mark);
        continue;
      }
      chosen.push({ node, lit });
      for (const item of dead) blocked.add(item);
      kept = true;
      break;
    }
    if (!kept) continue;
  }
  return chosen;
}

function rewrite(g0: Graph, mode: OptMode): { g: Graph; removed: number } {
  let g = g0;
  let removed = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const before = metrics(g);
    const mark = g.next;
    const chosen = selectRewrite(g, mode);
    if (chosen.length === 0) break;
    const trial = applyChosen(clone(g), chosen);
    const after = metrics(trial);
    if (!acceptBatch(mode, before, after)) {
      undoFrom(g, mark);
      break;
    }
    removed += before.nodes - after.nodes;
    g = trial;
  }
  return { g, removed };
}

function absorbed(g: Graph, node: number, refs: Map<number, number>): boolean {
  if ((refs.get(node) ?? 0) !== 1) return false;
  const positive = node << 1;
  for (const and of g.ands.values()) {
    if (and.a === positive || and.b === positive) return true;
  }
  return false;
}

function andLeaves(
  g: Graph,
  root: number,
  refs: Map<number, number>,
): { leaves: number[]; internals: number } {
  const leaves: number[] = [];
  let internals = 0;
  const seen = new Set<number>();
  const walk = (lit: number, isRoot: boolean) => {
    const node = litNode(lit);
    if (lit <= 1 || (lit & 1) === 1 || !g.ands.has(node)) {
      leaves.push(lit);
      return;
    }
    if (!isRoot && ((refs.get(node) ?? 0) !== 1 || seen.has(node))) {
      leaves.push(lit);
      return;
    }
    seen.add(node);
    internals += 1;
    const and = g.ands.get(node);
    if (!and) return;
    walk(and.a, false);
    walk(and.b, false);
  };
  walk(root << 1, true);
  return { leaves, internals };
}

function selectBalance(g: Graph): Choice[] {
  const refs = fanout(g);
  const level = levels(g);
  const chosen: Choice[] = [];
  const blocked = new Set<number>();
  for (const node of topo(g)) {
    if (blocked.has(node) || absorbed(g, node, refs)) continue;
    const tree = andLeaves(g, node, refs);
    if (tree.leaves.length < 3) continue;
    const mark = g.next;
    const pending = tree.leaves.map((lit) => ({
      lit,
      level: lit <= 1 ? 0 : (level.get(litNode(lit)) ?? 0),
    }));
    while (pending.length > 1) {
      pending.sort((a, b) => a.level - b.level || a.lit - b.lit);
      const left = pending.shift();
      const right = pending.shift();
      if (!left || !right) break;
      const lit = gAnd(g, left.lit, right.lit);
      pending.push({ lit, level: 1 + Math.max(left.level, right.level) });
    }
    const lit = pending[0]?.lit ?? node << 1;
    const added = addedSince(g, mark);
    const newLevel = pending[0]?.level ?? level.get(node) ?? 0;
    const oldLevel = level.get(node) ?? 0;
    if (
      coneHas(g, lit, node) ||
      added > tree.internals ||
      (added === tree.internals && newLevel >= oldLevel)
    ) {
      undoFrom(g, mark);
      continue;
    }
    chosen.push({ node, lit });
    const stack = [node];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const item = stack.pop();
      if (item === undefined || seen.has(item) || !g.ands.has(item)) continue;
      seen.add(item);
      blocked.add(item);
      const and = g.ands.get(item);
      if (!and) continue;
      if ((and.a & 1) === 0) stack.push(litNode(and.a));
      if ((and.b & 1) === 0) stack.push(litNode(and.b));
    }
  }
  return chosen;
}

function balance(g0: Graph, mode: OptMode): { g: Graph; trees: number } {
  let g = g0;
  let trees = 0;
  const passes = mode === "area" ? 1 : 4;
  for (let pass = 0; pass < passes; pass += 1) {
    const before = metrics(g);
    const mark = g.next;
    const chosen = selectBalance(g);
    if (chosen.length === 0) break;
    const trial = applyChosen(clone(g), chosen);
    const after = metrics(trial);
    if (
      after.nodes > before.nodes ||
      (after.nodes === before.nodes && after.depth >= before.depth)
    ) {
      undoFrom(g, mark);
      break;
    }
    trees += chosen.length;
    g = trial;
  }
  return { g, trees };
}

interface Sig {
  hi: number;
  lo: number;
}

function notSig(sig: Sig): Sig {
  return { hi: (sig.hi ^ 0xffffffff) >>> 0, lo: (sig.lo ^ 0xffffffff) >>> 0 };
}

function sigKey(sig: Sig): string {
  return `${sig.hi >>> 0},${sig.lo >>> 0}`;
}

function simulate(g: Graph): Map<number, Sig> {
  const sig = new Map<number, Sig>();
  sig.set(0, { hi: 0, lo: 0 });
  let seed = 0x51f7a1;
  for (let node = 1; node <= g.nInputs; node += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    let lo = seed;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    let hi = seed;
    if (lo === 0 && hi === 0) lo = 1;
    if (lo === 0xffffffff && hi === 0xffffffff) hi = 0x7fffffff;
    sig.set(node, { hi, lo });
  }
  const read = (lit: number): Sig => {
    if (lit === 0) return { hi: 0, lo: 0 };
    if (lit === 1) return { hi: 0xffffffff, lo: 0xffffffff };
    const base = sig.get(litNode(lit));
    if (!base) throw new Error("missing signature");
    return (lit & 1) === 1 ? notSig(base) : base;
  };
  for (const node of topo(g)) {
    const and = g.ands.get(node);
    if (!and) continue;
    const left = read(and.a);
    const right = read(and.b);
    sig.set(node, { hi: (left.hi & right.hi) >>> 0, lo: (left.lo & right.lo) >>> 0 });
  }
  return sig;
}

function supportOf(g: Graph, node: number): number[] {
  const inputs: number[] = [];
  const seen = new Set<number>();
  const stack = [node];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined || item === 0 || seen.has(item)) continue;
    seen.add(item);
    const and = g.ands.get(item);
    if (!and) {
      inputs.push(item);
      continue;
    }
    stack.push(litNode(and.a), litNode(and.b));
  }
  return inputs;
}

function evalAt(g: Graph, node: number, assign: Map<number, 0 | 1>): 0 | 1 {
  const memo = new Map<number, 0 | 1>();
  const rec = (item: number): 0 | 1 => {
    const cached = memo.get(item);
    if (cached !== undefined) return cached;
    const and = g.ands.get(item);
    if (!and) {
      const value = assign.get(item);
      if (value === undefined) throw new Error("missing input in functional sweep");
      memo.set(item, value);
      return value;
    }
    const left = rec(litNode(and.a)) ^ ((and.a & 1) as 0 | 1);
    const right = rec(litNode(and.b)) ^ ((and.b & 1) as 0 | 1);
    const value = ((left & right) === 1 ? 1 : 0) as 0 | 1;
    memo.set(item, value);
    return value;
  };
  return rec(node);
}

function sameOnSupport(g: Graph, left: number, right: number, inverted: boolean): boolean {
  const inputs = [...new Set([...supportOf(g, left), ...supportOf(g, right)])];
  if (inputs.length > SUPPORT_LIMIT) return false;
  const space = 1 << inputs.length;
  for (let mask = 0; mask < space; mask += 1) {
    const assign = new Map<number, 0 | 1>();
    inputs.forEach((input, index) => assign.set(input, ((mask >> index) & 1) === 1 ? 1 : 0));
    const a =
      left <= g.nInputs && !g.ands.has(left) ? (assign.get(left) ?? 0) : evalAt(g, left, assign);
    const b =
      right <= g.nInputs && !g.ands.has(right)
        ? (assign.get(right) ?? 0)
        : evalAt(g, right, assign);
    const expected = inverted ? (b === 1 ? 0 : 1) : b;
    if (a !== expected) return false;
  }
  return true;
}

function functionalSweep(g0: Graph): { g: Graph; removed: number } {
  let g = g0;
  let removed = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const before = metrics(g).nodes;
    const sig = simulate(g);
    const rep = new Map<string, number>();
    for (let node = 1; node <= g.nInputs; node += 1) {
      const key = sigKey(sig.get(node) ?? { hi: 0, lo: 0 });
      if (!rep.has(key)) rep.set(key, node);
    }
    const chosen: Choice[] = [];
    for (const node of topo(g)) {
      const value = sig.get(node) ?? { hi: 0, lo: 0 };
      if (value.hi === 0 && value.lo === 0 && sameOnSupport(g, node, 0, false)) {
        chosen.push({ node, lit: 0 });
        continue;
      }
      if (value.hi === 0xffffffff && value.lo === 0xffffffff && sameOnSupport(g, node, 0, true)) {
        chosen.push({ node, lit: 1 });
        continue;
      }
      const direct = rep.get(sigKey(value));
      const flipped = rep.get(sigKey(notSig(value)));
      if (
        direct !== undefined &&
        direct !== node &&
        sameOnSupport(g, node, direct, false) &&
        !coneHas(g, direct << 1, node)
      ) {
        chosen.push({ node, lit: direct << 1 });
        continue;
      }
      if (
        flipped !== undefined &&
        flipped !== node &&
        sameOnSupport(g, node, flipped, true) &&
        !coneHas(g, (flipped << 1) ^ 1, node)
      ) {
        chosen.push({ node, lit: (flipped << 1) ^ 1 });
        continue;
      }
      const key = sigKey(value);
      if (!rep.has(key)) rep.set(key, node);
    }
    if (chosen.length === 0) break;
    g = applyChosen(g, chosen);
    const after = metrics(g).nodes;
    if (after >= before) break;
    removed += before - after;
  }
  return { g, removed };
}

function boundary(g: Graph, dead: Set<number>): number[] {
  const leaves = new Set<number>();
  for (const node of dead) {
    const and = g.ands.get(node);
    if (!and) continue;
    for (const lit of [and.a, and.b]) {
      const leaf = litNode(lit);
      if (leaf !== 0 && !dead.has(leaf)) leaves.add(leaf);
    }
  }
  return [...leaves].sort((a, b) => a - b);
}

function selectRefactor(g: Graph, mode: OptMode): Choice[] {
  const refs = fanout(g);
  const level = levels(g);
  const blocked = new Set<number>();
  const chosen: Choice[] = [];
  for (const node of topo(g)) {
    const dead = mffcOf(g, node, refs);
    if (dead.size < 4 || dead.size > 16) continue;
    if ([...dead].some((item) => blocked.has(item))) continue;
    const leaves = boundary(g, dead);
    if (leaves.length > 6) continue;
    const tt = truthOf(g, node << 1, leaves);
    if (tt === null) continue;
    const pattern = patternsFor(leaves.length, tt, mode);
    if (pattern.nodes > dead.size) continue;
    const mark = g.next;
    const lit = instantiate(g, pattern, leaves);
    const added = addedSince(g, mark);
    const newLevel = litLevel(g, lit, level, mark);
    const oldLevel = level.get(node) ?? 0;
    if (!betterChoice(mode, dead.size, added, oldLevel, newLevel) || coneHas(g, lit, node)) {
      undoFrom(g, mark);
      continue;
    }
    chosen.push({ node, lit });
    for (const item of dead) blocked.add(item);
  }
  return chosen;
}

function refactor(g0: Graph, mode: OptMode): { g: Graph; removed: number } {
  let g = g0;
  let removed = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const before = metrics(g);
    const mark = g.next;
    const chosen = selectRefactor(g, mode);
    if (chosen.length === 0) break;
    const trial = applyChosen(clone(g), chosen);
    const after = metrics(trial);
    if (!acceptBatch(mode, before, after)) {
      undoFrom(g, mark);
      break;
    }
    removed += before.nodes - after.nodes;
    g = trial;
  }
  return { g, removed };
}

function supportMap(g: Graph): Map<number, Set<number>> {
  const map = new Map<number, Set<number>>();
  for (let node = 1; node <= g.nInputs; node += 1) map.set(node, new Set([node]));
  for (const node of topo(g)) {
    const and = g.ands.get(node);
    if (!and) continue;
    const support = new Set<number>();
    for (const lit of [and.a, and.b]) {
      const child = litNode(lit);
      const known = map.get(child);
      if (known) {
        for (const input of known) support.add(input);
      } else if (child !== 0) support.add(child);
    }
    map.set(node, support);
  }
  return map;
}

function sortedIds(ids: Iterable<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

function supportKey(ids: readonly number[]): string {
  return ids.join(",");
}

function expandTruth(tt: bigint, from: readonly number[], to: readonly number[]): bigint {
  const space = 1 << to.length;
  const pos = from.map((leaf) => to.indexOf(leaf));
  let out = 0n;
  for (let mask = 0; mask < space; mask += 1) {
    let small = 0;
    for (let index = 0; index < pos.length; index += 1)
      if (((mask >> (pos[index] ?? 0)) & 1) === 1) small |= 1 << index;
    if (((tt >> BigInt(small)) & 1n) === 1n) out |= 1n << BigInt(mask);
  }
  return out;
}

function selectResub(g: Graph, mode: OptMode): Choice[] {
  const refs = fanout(g);
  const level = levels(g);
  const supports = supportMap(g);
  const blocked = new Set<number>();
  const chosen: Choice[] = [];
  const nodes = [...supports.keys()].filter((item) => g.ands.has(item) || item <= g.nInputs);
  const rank = new Map<number, number>();
  const bySupport = new Map<string, number[]>();
  const supportOf = new Map<number, number[]>();
  nodes.forEach((item, index) => {
    rank.set(item, index);
    const support = supports.get(item);
    if (!support || support.size === 0 || support.size > 8) return;
    const leaves = sortedIds(support);
    supportOf.set(item, leaves);
    const key = supportKey(leaves);
    const list = bySupport.get(key);
    if (list) list.push(item);
    else bySupport.set(key, [item]);
  });
  const cached = new Map<number, bigint | null>();
  const cachedTruth = (item: number): bigint | null => {
    if (cached.has(item)) return cached.get(item) ?? null;
    const leaves = supportOf.get(item);
    if (!leaves) return null;
    const tt = truthOf(g, item << 1, leaves);
    cached.set(item, tt);
    return tt;
  };
  for (const node of topo(g)) {
    if (blocked.has(node)) continue;
    const dead = mffcOf(g, node, refs);
    if ([...dead].some((item) => blocked.has(item))) continue;
    const own = supports.get(node);
    const boundaryLeaves = boundary(g, dead);
    const leaves =
      own && own.size > 0 && own.size <= 8
        ? sortedIds(own)
        : boundaryLeaves.length > 0 && boundaryLeaves.length <= 8
          ? sortedIds(boundaryLeaves)
          : null;
    if (!leaves) continue;
    const leafKey = supportKey(leaves);
    const ownLeaves = supportOf.get(node);
    const root =
      ownLeaves && supportKey(ownLeaves) === leafKey
        ? cachedTruth(node)
        : truthOf(g, node << 1, leaves);
    if (root === null) continue;
    const mask = (1n << (1n << BigInt(leaves.length))) - 1n;
    const found: { item: number; supportSize: number; level: number; rank: number }[] = [];
    const space = 1 << leaves.length;
    for (let bits = 1; bits < space; bits += 1) {
      const ids: number[] = [];
      for (let index = 0; index < leaves.length; index += 1)
        if (((bits >> index) & 1) === 1) ids.push(leaves[index] ?? 0);
      const list = bySupport.get(supportKey(sortedIds(ids)));
      if (!list) continue;
      for (const item of list) {
        if (item === node || dead.has(item)) continue;
        found.push({
          item,
          supportSize: ids.length,
          level: level.get(item) ?? 0,
          rank: rank.get(item) ?? 0,
        });
      }
    }
    const divisors = found
      .sort((a, b) => b.supportSize - a.supportSize || a.level - b.level || a.rank - b.rank)
      .slice(0, 16);
    const tables: { lit: number; tt: bigint }[] = [];
    for (const divisor of divisors) {
      const divisorLeaves = supportOf.get(divisor.item);
      const cachedTt = divisorLeaves ? cachedTruth(divisor.item) : null;
      const tt =
        cachedTt === null || !divisorLeaves
          ? truthOf(g, divisor.item << 1, leaves)
          : supportKey(divisorLeaves) === leafKey
            ? cachedTt
            : expandTruth(cachedTt, divisorLeaves, leaves);
      if (tt === null) continue;
      tables.push({ lit: divisor.item << 1, tt });
    }
    let kept = false;
    const banned = (lit: number): boolean => {
      const seen = new Set<number>();
      const stack = [litNode(lit)];
      while (stack.length > 0) {
        const item = stack.pop();
        if (item === undefined || item === 0 || seen.has(item)) continue;
        if (item === node || dead.has(item) || blocked.has(item)) return true;
        seen.add(item);
        const and = g.ands.get(item);
        if (!and) continue;
        stack.push(litNode(and.a), litNode(and.b));
      }
      return false;
    };
    const tryLit = (lit: number, keep: number[], mark: number) => {
      if (banned(lit)) {
        undoFrom(g, mark);
        return false;
      }
      const added = addedSince(g, mark);
      const newLevel = litLevel(g, lit, level, mark);
      const oldLevel = level.get(node) ?? 0;
      if (!betterChoice(mode, dead.size, added, oldLevel, newLevel)) {
        undoFrom(g, mark);
        return false;
      }
      chosen.push({ node, lit });
      for (const item of dead) blocked.add(item);
      for (const item of keep) blocked.add(item);
      return true;
    };
    for (const divisor of tables) {
      const mark = g.next;
      if (divisor.tt === root && tryLit(divisor.lit, [litNode(divisor.lit)], mark)) {
        kept = true;
        break;
      }
      if ((divisor.tt ^ mask) === root && tryLit(divisor.lit ^ 1, [litNode(divisor.lit)], mark)) {
        kept = true;
        break;
      }
    }
    if (kept) continue;
    for (let i = 0; i < tables.length && !kept; i += 1) {
      const left = tables[i];
      if (!left) continue;
      for (let j = i; j < tables.length && !kept; j += 1) {
        const right = tables[j];
        if (!right) continue;
        for (const a of [left.lit, left.lit ^ 1]) {
          if (kept) break;
          for (const b of [right.lit, right.lit ^ 1]) {
            const tt = (a & 1) === 1 ? left.tt ^ mask : left.tt;
            const other = (b & 1) === 1 ? right.tt ^ mask : right.tt;
            const combined = tt & other;
            if (combined !== root && (combined ^ mask) !== root) continue;
            const mark = g.next;
            const built = gAnd(g, a, b);
            const lit = combined === root ? built : built ^ 1;
            if (tryLit(lit, [litNode(a), litNode(b)], mark)) kept = true;
            if (kept) break;
          }
        }
      }
    }
  }
  return chosen;
}

function resub(g0: Graph, mode: OptMode): { g: Graph; removed: number } {
  let g = g0;
  let removed = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const before = metrics(g);
    const mark = g.next;
    const chosen = selectResub(g, mode);
    if (chosen.length === 0) break;
    const trial = applyChosen(clone(g), chosen);
    const after = metrics(trial);
    if (!acceptBatch(mode, before, after)) {
      undoFrom(g, mark);
      break;
    }
    removed += before.nodes - after.nodes;
    g = trial;
  }
  return { g, removed };
}

function dump(g: Graph): AigIn {
  return {
    inputs: g.nInputs,
    ands: [...g.ands.keys()]
      .sort((a, b) => a - b)
      .map((node) => {
        const and = g.ands.get(node);
        if (!and) throw new Error("missing AND");
        return { node, a: and.a, b: and.b };
      }),
    outputs: g.outputs.map((output) => ({ name: output.name, lit: output.lit })),
  };
}

export function optimizeAig(
  input: AigIn,
  mode: OptMode = "area",
  flags: OptFlags = OPT_ALL,
): AigIn & { stats: OptStats } {
  let g = load(input);
  const depthBefore = metrics(g).depth;
  let rewriteRemoved = 0;
  let trees = 0;
  let sweepRemoved = 0;
  let refactorRemoved = 0;
  let resubRemoved = 0;
  if (flags.rewrite) {
    const pass = rewrite(g, mode);
    g = pass.g;
    rewriteRemoved += pass.removed;
  }
  if (flags.resub) {
    const pass = resub(g, mode);
    g = pass.g;
    resubRemoved += pass.removed;
  }
  if (flags.balance) {
    const pass = balance(g, mode);
    g = pass.g;
    trees += pass.trees;
  }
  if (flags.sweep) {
    const pass = functionalSweep(g);
    g = pass.g;
    sweepRemoved += pass.removed;
  }
  if (flags.refactor) {
    const pass = refactor(g, mode);
    g = pass.g;
    refactorRemoved += pass.removed;
  }
  if (flags.resub && refactorRemoved > 0) {
    const pass = resub(g, mode);
    g = pass.g;
    resubRemoved += pass.removed;
  }
  if (flags.rewrite && (sweepRemoved > 0 || refactorRemoved > 0 || resubRemoved > 0)) {
    const pass = rewrite(g, mode);
    g = pass.g;
    rewriteRemoved += pass.removed;
  }
  if (flags.balance && mode !== "area") {
    const pass = balance(g, mode);
    g = pass.g;
    trees += pass.trees;
  }
  const stats: OptStats = {
    rewrite: rewriteRemoved,
    balance: trees,
    sweep: sweepRemoved,
    refactor: refactorRemoved,
    resub: resubRemoved,
    depthBefore,
    depthAfter: metrics(g).depth,
  };
  return { ...dump(g), stats };
}
