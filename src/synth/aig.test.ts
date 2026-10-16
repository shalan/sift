import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphDepth, shrink, subjectGraph } from "./aig.ts";
import { OPT_NONE, patternTruth } from "./aig-opt.ts";
import { EXAMPLES } from "./examples.ts";
import { NetlistError, parseNetlist, type Netlist } from "./netlist.ts";
import { comboCloud } from "./seq.ts";

function row(netlist: Netlist, bits: Record<string, 0 | 1>) {
  const report = shrink(netlist);
  return report.equiv.rows.find((candidate) =>
    candidate.inputs.every((input) => input.value === bits[input.name]),
  );
}

describe("shrink", () => {
  it("matches every example on an exhaustive table", () => {
    for (const example of EXAMPLES) {
      const cloud = comboCloud(example.netlist);
      if (!cloud || cloud.gates.length === 0) continue;
      const report = shrink(cloud);
      assert.equal(report.equiv.exhaustive, true, example.id);
      assert.equal(report.equiv.mismatches, 0, example.id);
      assert.equal(report.equiv.vectors, 1 << cloud.inputs.length, example.id);
    }
  });

  it("keeps an inverter as an inverted edge", () => {
    const report = shrink(EXAMPLES[0].netlist);
    assert.equal(report.andAfter, 0);
    assert.deepEqual(report.aig.outputs, [{ name: "y", expr: "~a" }]);
  });

  it("shares the carry AND inside the sum", () => {
    const example = EXAMPLES.find((item) => item.id === "half-adder");
    assert.ok(example);
    const report = shrink(example.netlist);
    assert.equal(report.andAfter, 3);
    assert.equal(report.equiv.mismatches, 0);
    const both = row(example.netlist, { a: 1, b: 1 });
    assert.ok(both);
    assert.deepEqual(
      both.outputs.map((output) => [output.name, output.net]),
      [
        ["sum", 0],
        ["cout", 1],
      ],
    );
  });

  it("lowers a mux to three AND nodes", () => {
    const example = EXAMPLES.find((item) => item.id === "mux");
    assert.ok(example);
    const report = shrink(example.netlist);
    assert.equal(report.andAfter, 3);
    const selected = row(example.netlist, { s: 1, a: 0, b: 1 });
    const other = row(example.netlist, { s: 0, a: 0, b: 1 });
    assert.equal(selected?.outputs[0].net, 0);
    assert.equal(other?.outputs[0].net, 1);
  });

  it("shares a duplicated cone", () => {
    const example = EXAMPLES.find((item) => item.id === "shared");
    assert.ok(example);
    const report = shrink(example.netlist);
    assert.equal(report.strashHits, 2);
    assert.equal(report.andBefore, 2);
    assert.equal(report.andAfter, 2);
    assert.deepEqual(report.deadGates, []);
    assert.equal(report.aig.outputs[0].expr, report.aig.outputs[1].expr);
  });

  it("folds a contradiction and sweeps a dead gate", () => {
    const example = EXAMPLES.find((item) => item.id === "contradiction");
    assert.ok(example);
    const report = shrink(example.netlist);
    assert.deepEqual(report.deadGates, ["dead"]);
    assert.deepEqual(report.constOutputs, [{ name: "z", value: 0 }]);
    assert.equal(report.andBefore, 2);
    assert.equal(report.andAfter, 1);
    assert.equal(report.aig.nodes[0].expr, "a & b");
    assert.deepEqual(
      report.aig.outputs.map((output) => output.expr),
      ["0", "n3"],
    );
  });

  it("accepts gates written after the gates that read them", () => {
    const netlist: Netlist = {
      name: "late",
      inputs: ["a", "b"],
      outputs: ["y"],
      gates: [
        { id: "y", op: "AND", ins: ["t", "b"] },
        { id: "t", op: "AND", ins: ["a", "a"] },
      ],
    };
    const report = shrink(netlist);
    assert.equal(report.equiv.mismatches, 0);
    assert.equal(report.andAfter, 1);
    assert.ok(report.folds > 0);
  });

  it("rejects a cycle, a bad arity, and an unknown net", () => {
    assert.throws(
      () =>
        parseNetlist({
          name: "loop",
          inputs: ["a"],
          outputs: ["y"],
          gates: [{ id: "y", op: "AND", ins: ["y", "a"] }],
        }),
      (err: unknown) => err instanceof NetlistError && /cycle/.test(err.message),
    );
    assert.throws(
      () =>
        parseNetlist({
          name: "bad",
          inputs: ["a"],
          outputs: ["y"],
          gates: [{ id: "y", op: "AND", ins: ["a"] }],
        }),
      /expects 2 inputs/,
    );
    assert.throws(
      () =>
        parseNetlist({
          name: "missing",
          inputs: ["a"],
          outputs: ["y"],
          gates: [{ id: "y", op: "INV", ins: ["nope"] }],
        }),
      /unknown net 'nope'/,
    );
  });
});

describe("aig optimization", () => {
  it("synthesizes every function of up to three inputs", () => {
    for (let width = 0; width <= 3; width += 1) {
      const space = 1 << (1 << width);
      for (let tt = 0; tt < space; tt += 1) {
        assert.equal(patternTruth(width, BigInt(tt)), BigInt(tt), `${width}:${tt}`);
      }
    }
  });

  it("rewrites a covered OR back to the input", () => {
    const netlist: Netlist = {
      name: "cover",
      inputs: ["a", "b"],
      outputs: ["y"],
      gates: [
        { id: "ab", op: "AND", ins: ["a", "b"] },
        { id: "nb", op: "INV", ins: ["b"] },
        { id: "anb", op: "AND", ins: ["a", "nb"] },
        { id: "y", op: "OR", ins: ["ab", "anb"] },
      ],
    };
    const report = shrink(netlist);
    assert.equal(report.equiv.mismatches, 0);
    assert.equal(report.andAfter, 0);
    assert.equal(report.aig.outputs[0]?.expr, "a");
    assert.ok(report.opt.rewrite > 0);
  });

  it("balances a long AND chain without adding nodes", () => {
    const width = 8;
    const inputs = Array.from({ length: width }, (_, index) => `a${index}`);
    const gates: Netlist["gates"] = [];
    let prev = inputs[0] ?? "a0";
    for (let index = 1; index < width; index += 1) {
      const id = index === width - 1 ? "y" : `t${index}`;
      gates.push({ id, op: "AND", ins: [prev, inputs[index] ?? ""] });
      prev = id;
    }
    const netlist: Netlist = { name: "chain", inputs, outputs: ["y"], gates };
    const raw = subjectGraph(netlist, "delay", OPT_NONE);
    const balanced = subjectGraph(netlist, "delay", {
      rewrite: false,
      balance: true,
      sweep: false,
      refactor: false,
    });
    assert.equal(balanced.ands.length, raw.ands.length);
    assert.ok(graphDepth(balanced) < graphDepth(raw));
    assert.ok(graphDepth(balanced) <= 3);
    const report = shrink(netlist, "delay");
    assert.equal(report.equiv.mismatches, 0);
    assert.ok(report.opt.balance > 0);
  });

  it("merges two different factorizations of the same AND", () => {
    const netlist: Netlist = {
      name: "twins",
      inputs: ["a", "b", "c", "d", "e"],
      outputs: ["y", "z"],
      gates: [
        { id: "ab", op: "AND", ins: ["a", "b"] },
        { id: "abc", op: "AND", ins: ["ab", "c"] },
        { id: "abcd", op: "AND", ins: ["abc", "d"] },
        { id: "y", op: "AND", ins: ["abcd", "e"] },
        { id: "cd", op: "AND", ins: ["c", "d"] },
        { id: "abcd2", op: "AND", ins: ["ab", "cd"] },
        { id: "z", op: "AND", ins: ["abcd2", "e"] },
      ],
    };
    const raw = subjectGraph(netlist, "area", OPT_NONE);
    const swept = subjectGraph(netlist, "area", {
      rewrite: false,
      balance: false,
      sweep: true,
      refactor: false,
    });
    assert.ok(swept.ands.length < raw.ands.length);
    assert.equal(swept.outputs[0]?.lit, swept.outputs[1]?.lit);
    const resubbed = subjectGraph(netlist, "area", {
      rewrite: false,
      balance: false,
      sweep: false,
      refactor: false,
      resub: true,
    });
    assert.ok(resubbed.ands.length < raw.ands.length);
    assert.equal(resubbed.outputs[0]?.lit, resubbed.outputs[1]?.lit);
    assert.equal(shrink(netlist).equiv.mismatches, 0);
  });

  it("factors a distributed product", () => {
    const netlist: Netlist = {
      name: "dist",
      inputs: ["a", "b", "c", "d", "e"],
      outputs: ["y"],
      gates: [
        { id: "ab", op: "AND", ins: ["a", "b"] },
        { id: "ac", op: "AND", ins: ["a", "c"] },
        { id: "ad", op: "AND", ins: ["a", "d"] },
        { id: "ae", op: "AND", ins: ["a", "e"] },
        { id: "t1", op: "OR", ins: ["ab", "ac"] },
        { id: "t2", op: "OR", ins: ["t1", "ad"] },
        { id: "y", op: "OR", ins: ["t2", "ae"] },
      ],
    };
    const raw = subjectGraph(netlist, "area", OPT_NONE);
    const factored = subjectGraph(netlist, "area", {
      rewrite: false,
      balance: false,
      sweep: false,
      refactor: true,
    });
    assert.ok(factored.ands.length < raw.ands.length);
    const report = shrink(netlist);
    assert.equal(report.equiv.mismatches, 0);
    assert.ok(report.andAfter < raw.ands.length);
  });
});
