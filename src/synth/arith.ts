import type { Op } from "./netlist.ts";

export type EmitFn = (op: Op, ins: string[], id?: string) => string;
export type ArithMode = "area" | "delay";

export interface Sum {
  sums: string[];
  cout: string;
}

export type AdderKind = "ripple" | "lookahead" | "brent-kung";

export interface BuiltAdder {
  a: string[];
  b: string[];
  cin: string;
  sums: string[];
  cout: string;
  kind: AdderKind;
}

type BuiltFn = (site: BuiltAdder) => void;

export function adderKind(mode: ArithMode): string {
  return mode === "delay" ? "brent-kung adder" : "ripple adder";
}

export function multiplierKind(mode: ArithMode): string {
  return mode === "delay" ? "Wallace multiplier" : "array multiplier";
}

export function dividerKind(mode: ArithMode): string {
  return mode === "delay" ? "array divider" : "restoring divider";
}

export interface Quotient {
  quot: string[];
  rem: string[];
}

export function addBits(
  mode: ArithMode,
  emit: EmitFn,
  left: string[],
  right: string[],
  cin: string,
  names?: string[],
): Sum {
  return mode === "delay"
    ? brentKung(emit, left, right, cin, names)
    : rippleAdd(emit, left, right, cin, names);
}

export function adderLevels(kind: AdderKind, width: number): number {
  const bits = Math.max(width, 1);
  const ripple = 2 * bits;
  const prefix = Math.min(ripple, 2 * Math.ceil(Math.log2(bits)) + 2);
  if (kind === "brent-kung") return prefix;
  if (kind === "ripple" || bits <= 4) return ripple;
  const groups = Math.ceil(bits / 4);
  const mid = 2 * Math.ceil(Math.log2(groups)) + 10;
  if (mid >= ripple) return ripple;
  if (mid <= prefix) return prefix + 1;
  return mid;
}

/** True when a slower adder of `extra` levels still leaves slack at this PPA weight. */
export function ppaFits(room: number, extra: number, weight: number): boolean {
  return room - extra > 0.02 + weight * Math.max(extra, 0);
}

/** Per-adder performance weight. Slack near the period pulls it toward area; a miss pins it at 1. `bias` shifts that by half a point. */
export function ppaWeight(slack: number, period: number, bias?: number): number {
  if (slack === Number.POSITIVE_INFINITY) return 0;
  const span = period > 0 ? period : 1;
  const fromSlack = 1 - slack / span;
  const shifted = bias === undefined ? fromSlack : fromSlack + bias - 0.5;
  if (!Number.isFinite(shifted)) return 0;
  return Math.min(1, Math.max(0, shifted));
}

export function rebuildAdder(
  kind: AdderKind,
  emit: EmitFn,
  left: string[],
  right: string[],
  cin: string,
  names?: string[],
): Sum {
  if (kind === "brent-kung") return brentKung(emit, left, right, cin, names);
  if (kind === "lookahead") return lookaheadAdd(emit, left, right, cin, names);
  return rippleAdd(emit, left, right, cin, names);
}

export function mulBits(
  mode: ArithMode,
  emit: EmitFn,
  left: string[],
  right: string[],
  width: number,
  built?: BuiltFn,
): string[] {
  const product =
    mode === "delay"
      ? wallace(emit, left, right, width, built)
      : arrayMul(emit, left, right, width, built);
  const fitted = product.slice(0, width);
  while (fitted.length < width) fitted.push("0");
  return fitted;
}

export function divBits(
  mode: ArithMode,
  emit: EmitFn,
  dividend: string[],
  divisor: string[],
  width: number,
  built?: BuiltFn,
): Quotient {
  const subtract = (left: string[], right: string[], cin: string): Sum =>
    mode === "delay"
      ? brentKung(emit, left, right, cin, undefined, built)
      : rippleAdd(emit, left, right, cin, undefined, built);
  return restoring(emit, subtract, dividend, divisor, width);
}

function rippleAdd(
  emit: EmitFn,
  left: string[],
  right: string[],
  cin: string,
  names?: string[],
  built?: BuiltFn,
): Sum {
  let carry = cin;
  const sums: string[] = [];
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? "0";
    const b = right[index] ?? "0";
    const axb = emit("XOR", [a, b]);
    sums.push(emit("XOR", [axb, carry], names?.[index]));
    const ab = emit("AND", [a, b]);
    const ac = emit("AND", [carry, axb]);
    carry = emit("OR", [ab, ac]);
  }
  built?.({
    a: left.slice(),
    b: right.slice(),
    cin,
    sums: sums.slice(),
    cout: carry,
    kind: "ripple",
  });
  return { sums, cout: carry };
}

function lookaheadAdd(
  emit: EmitFn,
  left: string[],
  right: string[],
  cin: string,
  names?: string[],
  built?: BuiltFn,
): Sum {
  const width = left.length;
  if (width <= 4) {
    const added = rippleAdd(emit, left, right, cin, names);
    built?.({
      a: left.slice(),
      b: right.slice(),
      cin,
      sums: added.sums.slice(),
      cout: added.cout,
      kind: "lookahead",
    });
    return added;
  }
  const bitP: string[] = [];
  const bitG: string[] = [];
  for (let index = 0; index < width; index += 1) {
    const a = left[index] ?? "0";
    const b = right[index] ?? "0";
    bitP.push(emit("XOR", [a, b]));
    bitG.push(emit("AND", [a, b]));
  }
  const merge = (hi: { g: string; p: string }, lo: { g: string; p: string }) => {
    const through = emit("AND", [hi.p, lo.g]);
    return { g: emit("OR", [hi.g, through]), p: emit("AND", [hi.p, lo.p]) };
  };
  const groups: { g: string; p: string }[] = [];
  for (let base = 0; base < width; base += 4) {
    let layer: { g: string; p: string }[] = [];
    for (let index = base; index < Math.min(base + 4, width); index += 1) {
      layer.push({ g: bitG[index] ?? "0", p: bitP[index] ?? "0" });
    }
    while (layer.length > 1) {
      const next: { g: string; p: string }[] = [];
      for (let index = 0; index < layer.length; index += 2) {
        const lo = layer[index];
        const hi = layer[index + 1];
        if (!lo) continue;
        next.push(hi ? merge(hi, lo) : lo);
      }
      layer = next;
    }
    const group = layer[0];
    if (!group) throw new Error("lookahead lost a group");
    groups.push(group);
  }
  const nodes = groups.map((group) => ({ g: group.g, p: group.p }));
  let dist = 1;
  while (dist < nodes.length) {
    for (let index = dist * 2 - 1; index < nodes.length; index += dist * 2) {
      const hi = nodes[index];
      const lo = nodes[index - dist];
      if (hi && lo) nodes[index] = merge(hi, lo);
    }
    dist *= 2;
  }
  for (let span = Math.floor(dist / 4); span > 0; span = Math.floor(span / 2)) {
    for (let index = span * 3 - 1; index < nodes.length; index += span * 2) {
      const hi = nodes[index];
      const lo = nodes[index - span];
      if (hi && lo) nodes[index] = merge(hi, lo);
    }
  }
  const sums: string[] = [];
  for (let group = 0; group < nodes.length; group += 1) {
    const lower = group === 0 ? null : nodes[group - 1];
    let carry = lower ? emit("OR", [lower.g, emit("AND", [lower.p, cin])]) : cin;
    const base = group * 4;
    for (let index = base; index < Math.min(base + 4, width); index += 1) {
      sums.push(emit("XOR", [bitP[index] ?? "0", carry], names?.[index]));
      carry = emit("OR", [bitG[index] ?? "0", emit("AND", [bitP[index] ?? "0", carry])]);
    }
  }
  const last = nodes[nodes.length - 1];
  if (!last) throw new Error("lookahead lost a carry");
  const cout = emit("OR", [last.g, emit("AND", [last.p, cin])]);
  built?.({
    a: left.slice(),
    b: right.slice(),
    cin,
    sums: sums.slice(),
    cout,
    kind: "lookahead",
  });
  return { sums, cout };
}

function brentKung(
  emit: EmitFn,
  left: string[],
  right: string[],
  cin: string,
  names?: string[],
  built?: BuiltFn,
): Sum {
  const width = left.length;
  if (width === 0) return { sums: [], cout: cin };
  const bitP: string[] = [];
  const nodes: { g: string; p: string }[] = [];
  for (let index = 0; index < width; index += 1) {
    const a = left[index] ?? "0";
    const b = right[index] ?? "0";
    const p = emit("XOR", [a, b]);
    bitP.push(p);
    nodes.push({ g: emit("AND", [a, b]), p });
  }
  const merge = (hi: { g: string; p: string }, lo: { g: string; p: string }) => {
    const through = emit("AND", [hi.p, lo.g]);
    return { g: emit("OR", [hi.g, through]), p: emit("AND", [hi.p, lo.p]) };
  };
  let dist = 1;
  while (dist < width) {
    for (let index = dist * 2 - 1; index < width; index += dist * 2) {
      const hi = nodes[index];
      const lo = nodes[index - dist];
      if (hi && lo) nodes[index] = merge(hi, lo);
    }
    dist *= 2;
  }
  for (let span = Math.floor(dist / 4); span > 0; span = Math.floor(span / 2)) {
    for (let index = span * 3 - 1; index < width; index += span * 2) {
      const hi = nodes[index];
      const lo = nodes[index - span];
      if (hi && lo) nodes[index] = merge(hi, lo);
    }
  }
  const sums: string[] = [];
  let carry = cin;
  for (let index = 0; index < width; index += 1) {
    sums.push(emit("XOR", [bitP[index] ?? "0", carry], names?.[index]));
    const group = nodes[index];
    if (!group) throw new Error("brent-kung lost a carry");
    carry = emit("OR", [group.g, emit("AND", [group.p, cin])]);
  }
  built?.({
    a: left.slice(),
    b: right.slice(),
    cin,
    sums: sums.slice(),
    cout: carry,
    kind: "brent-kung",
  });
  return { sums, cout: carry };
}

function arrayMul(
  emit: EmitFn,
  left: string[],
  right: string[],
  width: number,
  built?: BuiltFn,
): string[] {
  let acc = Array.from({ length: width }, () => "0");
  for (let row = 0; row < right.length; row += 1) {
    const partial = Array.from({ length: width }, () => "0");
    for (let col = 0; col < left.length; col += 1) {
      const weight = row + col;
      const a = left[col];
      const b = right[row];
      if (weight < width && a && b) partial[weight] = emit("AND", [a, b]);
    }
    acc = rippleAdd(emit, acc, partial, "0", undefined, built).sums;
  }
  return acc;
}

function wallace(
  emit: EmitFn,
  left: string[],
  right: string[],
  width: number,
  built?: BuiltFn,
): string[] {
  let columns: string[][] = Array.from({ length: width }, () => []);
  for (let row = 0; row < right.length; row += 1) {
    for (let col = 0; col < left.length; col += 1) {
      const weight = row + col;
      const a = left[col];
      const b = right[row];
      if (weight < width && a && b) columns[weight]?.push(emit("AND", [a, b]));
    }
  }
  while (columns.some((column) => column.length > 2)) {
    const next = Array.from({ length: width }, () => [] as string[]);
    for (let index = 0; index < width; index += 1) {
      const column = columns[index] ?? [];
      let cursor = 0;
      while (cursor + 2 < column.length) {
        const x = column[cursor] ?? "0";
        const y = column[cursor + 1] ?? "0";
        const z = column[cursor + 2] ?? "0";
        const xy = emit("XOR", [x, y]);
        next[index]?.push(emit("XOR", [xy, z]));
        const carry = emit("OR", [emit("AND", [x, y]), emit("AND", [z, xy])]);
        if (index + 1 < width) next[index + 1]?.push(carry);
        cursor += 3;
      }
      while (cursor < column.length) {
        const bit = column[cursor];
        if (bit) next[index]?.push(bit);
        cursor += 1;
      }
    }
    columns = next;
  }
  const lows = columns.map((column) => column[0] ?? "0");
  const highs = columns.map((column) => column[1] ?? "0");
  return brentKung(emit, lows, highs, "0", undefined, built).sums;
}

function invertBits(emit: EmitFn, bits: string[]): string[] {
  return bits.map((bit) => (bit === "0" ? "1" : bit === "1" ? "0" : emit("INV", [bit])));
}

function restoring(
  emit: EmitFn,
  subtract: (left: string[], right: string[], cin: string) => Sum,
  dividend: string[],
  divisor: string[],
  width: number,
): Quotient {
  let rem = Array.from({ length: width + 1 }, () => "0");
  const quot = Array.from({ length: width }, () => "0");
  const padded = [...divisor.slice(0, width), "0"];
  while (padded.length < width + 1) padded.push("0");
  const subtrahend = invertBits(emit, padded);
  for (let step = width - 1; step >= 0; step -= 1) {
    const shifted = Array.from({ length: width + 1 }, (_, index) =>
      index === 0 ? (dividend[step] ?? "0") : (rem[index - 1] ?? "0"),
    );
    const diff = subtract(shifted, subtrahend, "1");
    quot[step] = diff.cout;
    rem = shifted.map((bit, index) => {
      const next = diff.sums[index] ?? "0";
      if (diff.cout === "1") return next;
      if (diff.cout === "0" || bit === next) return bit;
      return emit("MUX", [diff.cout, next, bit]);
    });
  }
  return { quot, rem: rem.slice(0, width) };
}
