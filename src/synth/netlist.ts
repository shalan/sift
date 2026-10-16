export type Op = "INV" | "AND" | "OR" | "XOR" | "MUX" | "DFF" | "LATCH";

export interface Gate {
  id: string;
  op: Op;
  ins: string[];
}

export interface AdderSite {
  a: string[];
  b: string[];
  cin: string;
  sums: string[];
  cout: string;
  kind: "ripple" | "lookahead" | "brent-kung";
}

export interface Netlist {
  name: string;
  inputs: string[];
  outputs: string[];
  gates: Gate[];
  warnings?: string[];
  notes?: string[];
  adders?: AdderSite[];
  adderTuned?: boolean;
  /** Present after automatic clock gating. Empty means the pass ran and found no enable. */
  clockGates?: ClockGate[];
}

export interface ClockGate {
  id: string;
  en: string;
  level: 0 | 1;
  flops: string[];
}

const ARITY: Record<Op, number> = { INV: 1, AND: 2, OR: 2, XOR: 2, MUX: 3, DFF: 1, LATCH: 2 };

function inputCount(gate: Gate): boolean {
  if (gate.op === "DFF") return gate.ins.length === 1 || gate.ins.length === 3;
  return gate.ins.length === ARITY[gate.op];
}

export class NetlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetlistError";
  }
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw new NetlistError(`${label} must be a list of non-empty strings`);
  }
  return value.map((v) => (v as string).trim());
}

export function parseNetlist(input: unknown): Netlist {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid JSON";
      throw new NetlistError(`JSON: ${message}`);
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NetlistError("netlist must be an object");
  }
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : "netlist";
  const inputs = stringList(raw.inputs, "inputs");
  const outputs = stringList(raw.outputs, "outputs");
  if (outputs.length === 0) throw new NetlistError("outputs must name at least one net");
  if (!Array.isArray(raw.gates)) throw new NetlistError("gates must be a list");

  const gates: Gate[] = raw.gates.map((gate, index) => {
    if (gate === null || typeof gate !== "object" || Array.isArray(gate)) {
      throw new NetlistError(`gate ${index} must be an object`);
    }
    const g = gate as Record<string, unknown>;
    if (typeof g.id !== "string" || g.id.trim() === "") {
      throw new NetlistError(`gate ${index} is missing an id`);
    }
    if (typeof g.op !== "string" || !(g.op in ARITY)) {
      throw new NetlistError(`gate '${g.id}' has unknown op '${String(g.op)}'`);
    }
    const ins = stringList(g.ins, `gate '${g.id}' inputs`);
    return { id: g.id.trim(), op: g.op as Op, ins };
  });

  return validate({ name, inputs, outputs, gates });
}

export function validate(netlist: Netlist): Netlist {
  if (netlist.inputs.length > 2048) {
    throw new NetlistError("at most 2048 inputs in this build");
  }
  const seen = new Set<string>(["0", "1"]);
  for (const name of netlist.inputs) {
    if (name === "0" || name === "1")
      throw new NetlistError(`input '${name}' collides with a constant`);
    if (seen.has(name)) throw new NetlistError(`duplicate name '${name}'`);
    seen.add(name);
  }
  for (const gate of netlist.gates) {
    if (gate.id === "0" || gate.id === "1")
      throw new NetlistError(`gate id '${gate.id}' collides with a constant`);
    if (seen.has(gate.id)) throw new NetlistError(`duplicate name '${gate.id}'`);
    seen.add(gate.id);
    const want = gate.op === "DFF" ? "1 or 3" : String(ARITY[gate.op]);
    if (!inputCount(gate)) {
      throw new NetlistError(
        `gate '${gate.id}' ${gate.op} expects ${want} inputs, got ${gate.ins.length}`,
      );
    }
  }
  for (const gate of netlist.gates) {
    for (const net of gate.ins) {
      if (!seen.has(net)) throw new NetlistError(`gate '${gate.id}' reads unknown net '${net}'`);
    }
  }
  for (const out of netlist.outputs) {
    if (!seen.has(out)) throw new NetlistError(`output '${out}' is not a net`);
  }
  topoGates(netlist);
  const listed = netlist.warnings ?? [];
  const latches = netlist.gates.filter((gate) => gate.op === "LATCH").map((gate) => `'${gate.id}'`);
  const warnings =
    listed.length > 0 || latches.length === 0
      ? listed
      : [`latch inferred for ${latches.join(", ")} — a path does not assign it`];
  return { ...netlist, warnings };
}

/** Topological order. Throws if a gate reads itself through a cycle. */
export function topoGates(netlist: Netlist): Gate[] {
  const byId = new Map(netlist.gates.map((g) => [g.id, g]));
  const inputs = new Set(netlist.inputs);
  const state = new Map<string, 0 | 1 | 2>();
  const ordered: Gate[] = [];

  function visit(id: string): void {
    if (id === "0" || id === "1" || inputs.has(id)) return;
    const gate = byId.get(id);
    if (!gate) throw new NetlistError(`unknown net '${id}'`);
    const mark = state.get(id) ?? 0;
    if (mark === 2) return;
    if (mark === 1) throw new NetlistError(`cycle through '${id}'`);
    state.set(id, 1);
    if (gate.op !== "DFF") {
      for (const net of gate.ins) visit(net);
    }
    state.set(id, 2);
    ordered.push(gate);
  }

  for (const gate of netlist.gates) visit(gate.id);
  return ordered;
}

/** Gates that feed no output, directly or through other gates. */
export function deadGates(netlist: Netlist): string[] {
  const byId = new Map(netlist.gates.map((g) => [g.id, g]));
  const seen = new Set<string>();
  const stack = [...netlist.outputs];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const gate = byId.get(id);
    if (!gate) continue;
    for (const net of gate.ins) stack.push(net);
  }
  return netlist.gates.filter((g) => !seen.has(g.id)).map((g) => g.id);
}

export interface SweptFlop {
  id: string;
  reason: "no reader" | "not observable" | "duplicate";
  sameAs?: string;
}

/**
 * Drop flip-flops that are unread or copies of another flop.
 * A flop is unread when every path to an output is blocked by the mux select
 * that guards it. A flop is a copy when its data and reset match another flop,
 * including a clock-enable mux that holds its own Q.
 */
export function sweepState(
  gates: Gate[],
  outputs: string[],
  adders: AdderSite[] = [],
  inputs: readonly string[] = [],
): { gates: Gate[]; flops: SweptFlop[]; adders: AdderSite[] } {
  const flops: SweptFlop[] = [];
  const merged = mergeDuplicateFlops(gates, outputs, flops);
  const observable = observableGates(merged.gates, outputs, flops);
  const live = new Set<string>(["0", "1", ...inputs, ...observable.map((gate) => gate.id)]);
  const resolve = (net: string): string => {
    let guard = 0;
    let name = net;
    while (merged.alias.has(name) && guard < 8) {
      name = merged.alias.get(name) ?? name;
      guard += 1;
    }
    return name;
  };
  const operand = (net: string): string => {
    const name = resolve(net);
    return live.has(name) ? name : "0";
  };
  const result = (net: string): string => {
    const name = resolve(net);
    return live.has(name) ? name : net;
  };
  const rewritten = adders.map((site) => ({
    ...site,
    a: site.a.map(operand),
    b: site.b.map(operand),
    cin: operand(site.cin),
    sums: site.sums.map(result),
    cout: result(site.cout),
  }));
  return { gates: observable, flops, adders: rewritten };
}

function mergeDuplicateFlops(
  gates: Gate[],
  outputs: string[],
  flops: SweptFlop[],
): { gates: Gate[]; alias: Map<string, string> } {
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const intern = new Map<string, number>();
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  let seq = 1;
  const leaf = (key: string): number => {
    const found = intern.get(key);
    if (found !== undefined) return found;
    intern.set(key, seq);
    seq += 1;
    return seq - 1;
  };
  const sig = (root: string): number => {
    const work: { net: string; phase: 0 | 1 }[] = [{ net: root, phase: 0 }];
    while (work.length > 0) {
      const item = work.pop();
      if (!item) break;
      const { net } = item;
      if (memo.has(net)) continue;
      if (net === "0" || net === "1") {
        memo.set(net, leaf(`c:${net}`));
        continue;
      }
      const gate = byId.get(net);
      if (!gate || gate.op === "DFF" || gate.op === "LATCH") {
        memo.set(net, leaf(`n:${net}`));
        continue;
      }
      if (item.phase === 0) {
        if (visiting.has(net)) {
          memo.set(net, leaf(`cycle:${net}`));
          continue;
        }
        visiting.add(net);
        work.push({ net, phase: 1 });
        for (const pin of gate.ins) work.push({ net: pin, phase: 0 });
        continue;
      }
      visiting.delete(net);
      if (memo.has(net)) continue;
      const key = `${gate.op}:${gate.ins.map((pin) => memo.get(pin) ?? leaf(`n:${pin}`)).join(",")}`;
      memo.set(net, leaf(key));
    }
    return memo.get(root) ?? leaf(`n:${root}`);
  };
  const groups = new Map<string, Gate[]>();
  for (const gate of gates) {
    if (gate.op !== "DFF" && gate.op !== "LATCH") continue;
    const data = gate.ins[0] ?? "0";
    const mux = byId.get(data);
    let payload = `d:${sig(data)}`;
    if (mux?.op === "MUX") {
      const [sel, yes, no] = mux.ins;
      if (no === gate.id) payload = `h1:${sig(sel ?? "0")}:${sig(yes ?? "0")}`;
      else if (yes === gate.id) payload = `h0:${sig(sel ?? "0")}:${sig(no ?? "0")}`;
    }
    const reset = gate.ins
      .slice(1)
      .map((pin) => sig(pin))
      .join(",");
    const key = `${gate.op}|${payload}|${reset}`;
    const list = groups.get(key);
    if (list) list.push(gate);
    else groups.set(key, [gate]);
  }
  const alias = new Map<string, string>();
  const outputSet = new Set(outputs);
  const buffers: Gate[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.id < b.id ? -1 : 1));
    const keeper = group[0];
    if (!keeper) continue;
    for (const dup of group.slice(1)) {
      alias.set(dup.id, keeper.id);
      flops.push({ id: dup.id, reason: "duplicate", sameAs: keeper.id });
      if (outputSet.has(dup.id)) {
        const mid = `${dup.id}__tie`;
        buffers.push({ id: mid, op: "INV", ins: [keeper.id] });
        buffers.push({ id: dup.id, op: "INV", ins: [mid] });
      }
    }
  }
  if (alias.size === 0) return { gates, alias };
  const resolve = (net: string): string => {
    let guard = 0;
    while (alias.has(net) && guard < 8) {
      net = alias.get(net) ?? net;
      guard += 1;
    }
    return net;
  };
  const next: Gate[] = [];
  for (const gate of gates) {
    if (alias.has(gate.id)) continue;
    next.push({ ...gate, ins: gate.ins.map(resolve) });
  }
  for (const gate of buffers) next.push({ ...gate, ins: gate.ins.map(resolve) });
  return { gates: next, alias };
}

function observableGates(gates: Gate[], outputs: string[], flops: SweptFlop[]): Gate[] {
  const before = gates.filter((gate) => gate.op === "DFF" || gate.op === "LATCH");
  const reachable = new Set<string>();
  const seed = [...outputs];
  const byBefore = new Map(gates.map((gate) => [gate.id, gate]));
  while (seed.length > 0) {
    const id = seed.pop();
    if (!id || reachable.has(id) || id === "0" || id === "1") continue;
    reachable.add(id);
    const gate = byBefore.get(id);
    if (!gate) continue;
    for (const net of gate.ins) seed.push(net);
  }
  const folded = foldGuardedCones(gates, new Set(outputs));
  const byId = new Map(folded.map((gate) => [gate.id, gate]));
  const keep = new Set<string>();
  const pending = [...outputs];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || keep.has(id) || id === "0" || id === "1") continue;
    keep.add(id);
    const gate = byId.get(id);
    if (!gate) continue;
    for (const net of gate.ins) pending.push(net);
  }
  const kept = folded.filter((gate) => keep.has(gate.id));
  const survived = new Set(
    kept.filter((gate) => gate.op === "DFF" || gate.op === "LATCH").map((gate) => gate.id),
  );
  for (const flop of before) {
    if (survived.has(flop.id)) continue;
    flops.push({ id: flop.id, reason: reachable.has(flop.id) ? "not observable" : "no reader" });
  }
  return kept;
}

/** Fold gates that a mux select makes constant, when nothing else reads them. */
function foldGuardedCones(gates: Gate[], outputs: Set<string>): Gate[] {
  let current = gates;
  for (let pass = 0; pass < 4; pass += 1) {
    const byId = new Map(current.map((gate) => [gate.id, gate]));
    const fanout = new Map<string, string[]>();
    for (const gate of current) {
      for (const net of gate.ins) {
        const list = fanout.get(net);
        if (list) list.push(gate.id);
        else fanout.set(net, [gate.id]);
      }
    }
    const valueMemo = new Map<string, 0 | 1 | null>();
    const value = (root: string, forced: ReadonlyMap<string, 0 | 1>, key: string): 0 | 1 | null => {
      const work: { net: string; phase: 0 | 1 }[] = [{ net: root, phase: 0 }];
      const active = new Set<string>();
      while (work.length > 0) {
        const item = work.pop();
        if (!item) break;
        const { net } = item;
        if (net === "0" || net === "1" || forced.has(net)) continue;
        const memoKey = `${net}\n${key}`;
        if (valueMemo.has(memoKey)) continue;
        const gate = byId.get(net);
        if (!gate || gate.op === "DFF" || gate.op === "LATCH") {
          valueMemo.set(memoKey, null);
          continue;
        }
        if (item.phase === 0) {
          if (active.has(net)) {
            valueMemo.set(memoKey, null);
            continue;
          }
          active.add(net);
          work.push({ net, phase: 1 });
          for (const pin of gate.ins) work.push({ net: pin, phase: 0 });
          continue;
        }
        active.delete(net);
        if (valueMemo.has(memoKey)) continue;
        const ins = gate.ins.map((pin) => {
          if (pin === "1") return 1;
          if (pin === "0") return 0;
          const bit = forced.get(pin);
          if (bit !== undefined) return bit;
          return valueMemo.get(`${pin}\n${key}`) ?? null;
        });
        let result: 0 | 1 | null = null;
        if (gate.op === "INV")
          result = ins[0] === null || ins[0] === undefined ? null : ins[0] === 1 ? 0 : 1;
        else if (gate.op === "AND") {
          if (ins.some((bit) => bit === 0)) result = 0;
          else if (ins.every((bit) => bit === 1)) result = 1;
        } else if (gate.op === "OR") {
          if (ins.some((bit) => bit === 1)) result = 1;
          else if (ins.every((bit) => bit === 0)) result = 0;
        } else if (gate.op === "XOR") {
          if (ins[0] !== null && ins[0] !== undefined && ins[1] !== null && ins[1] !== undefined) {
            result = ((ins[0] ^ ins[1]) & 1) as 0 | 1;
          }
        } else if (gate.op === "MUX") {
          if (ins[0] === 1) result = ins[1] ?? null;
          else if (ins[0] === 0) result = ins[2] ?? null;
        }
        valueMemo.set(memoKey, result);
      }
      if (root === "0" || root === "1") return root === "1" ? 1 : 0;
      const forcedBit = forced.get(root);
      if (forcedBit !== undefined) return forcedBit;
      return valueMemo.get(`${root}\n${key}`) ?? null;
    };
    const rewrites = new Map<string, Gate>();
    const consider = (root: string, sel: string, bit: 0 | 1, mux: string): void => {
      const cone = new Set<string>();
      let usesSelect = false;
      let readsState = false;
      const stack = [root];
      while (stack.length > 0) {
        const id = stack.pop();
        if (!id || cone.has(id) || id === "0" || id === "1" || outputs.has(id)) continue;
        if (id === sel) usesSelect = true;
        const gate = byId.get(id);
        if (!gate || gate.op === "DFF" || gate.op === "LATCH") {
          if (gate) readsState = true;
          continue;
        }
        cone.add(id);
        for (const pin of gate.ins) {
          if (pin === sel) usesSelect = true;
          stack.push(pin);
        }
      }
      if (!usesSelect || !readsState || cone.size === 0) return;
      const leak = new Set<string>();
      const spread = [];
      for (const id of cone) {
        if ((fanout.get(id) ?? []).some((user) => user !== mux && !cone.has(user))) {
          leak.add(id);
          spread.push(id);
        }
      }
      while (spread.length > 0) {
        const cur = spread.pop();
        const gate = cur ? byId.get(cur) : undefined;
        if (!gate) continue;
        for (const pin of gate.ins) {
          if (!cone.has(pin) || leak.has(pin)) continue;
          leak.add(pin);
          spread.push(pin);
        }
      }
      const forced = new Map<string, 0 | 1>([[sel, bit]]);
      const key = `${sel}=${bit}`;
      value(root, forced, key);
      for (const id of cone) {
        if (leak.has(id)) continue;
        const known = valueMemo.get(`${id}\n${key}`) ?? null;
        if (known === null) continue;
        const c = known === 1 ? "1" : "0";
        rewrites.set(id, { id, op: "AND", ins: [c, c] });
      }
    };
    for (const gate of current) {
      if (gate.op !== "MUX") continue;
      const [sel, yes, no] = gate.ins;
      if (!sel) continue;
      consider(yes ?? "0", sel, 1, gate.id);
      consider(no ?? "0", sel, 0, gate.id);
    }
    if (rewrites.size === 0) return current;
    current = current.map((gate) => rewrites.get(gate.id) ?? gate);
  }
  return current;
}

export function evalOp(op: Op, ins: Array<0 | 1>): 0 | 1 {
  switch (op) {
    case "INV":
      return ins[0] === 0 ? 1 : 0;
    case "AND":
      return ins[0] & ins[1] ? 1 : 0;
    case "OR":
      return ins[0] | ins[1] ? 1 : 0;
    case "XOR":
      return ins[0] ^ ins[1] ? 1 : 0;
    case "MUX":
      return ins[0] === 1 ? ins[1] : ins[2];
    case "DFF":
      throw new NetlistError("a DFF holds state; it is not a combinational gate");
    case "LATCH":
      throw new NetlistError("a LATCH holds state; it is not a combinational gate");
    default: {
      const never: never = op;
      throw new NetlistError(`unknown op '${String(never)}'`);
    }
  }
}

export function evalNetlist(
  netlist: Netlist,
  assign: ReadonlyMap<string, 0 | 1>,
): Map<string, 0 | 1> {
  const values = new Map<string, 0 | 1>(assign);
  values.set("0", 0);
  values.set("1", 1);
  for (const name of netlist.inputs) {
    if (!values.has(name)) throw new NetlistError(`missing value for input '${name}'`);
  }
  for (const gate of topoGates(netlist)) {
    if (gate.op === "DFF" || gate.op === "LATCH") continue;
    const ins = gate.ins.map((net) => {
      const bit = values.get(net);
      if (bit === undefined) throw new NetlistError(`net '${net}' has no value`);
      return bit;
    });
    values.set(gate.id, evalOp(gate.op, ins));
  }
  return values;
}
