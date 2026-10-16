import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  adderLevels,
  ppaFits,
  ppaWeight,
  rebuildAdder,
  type AdderKind,
  type EmitFn,
} from "./arith.ts";
import { VERILOG } from "./examples.ts";
import { evalNetlist, parseNetlist, validate } from "./netlist.ts";
import { comboCloud, flopsOf, mapDesign } from "./seq.ts";
import { sky130Hd } from "./sky130hd.ts";
import { parseVerilog } from "./verilog.ts";

function source(id: string): string {
  const found = VERILOG.find((example) => example.id === id);
  assert.ok(found);
  return found.source;
}

function design(id: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../designs", id), "utf8");
}

function inputBit(row: { name: string; value: 0 | 1 }[], name: string): 0 | 1 {
  const found = row.find((item) => item.name === name);
  assert.ok(found);
  return found.value;
}

function outputBit(row: { name: string; net: 0 | 1 }[], name: string): 0 | 1 {
  const found = row.find((item) => item.name === name);
  assert.ok(found);
  return found.net;
}

describe("verilog", () => {
  it("elaborates and4 and matches the operator", () => {
    const netlist = parseVerilog(source("and4.v"));
    assert.deepEqual(netlist.inputs, ["a", "b", "c", "d"]);
    assert.deepEqual(netlist.outputs, ["y"]);
    assert.equal(netlist.gates.length, 3);
    assert.ok(netlist.gates.every((gate) => gate.op === "AND"));
    for (const library of ["min", "std"] as const) {
      for (const mode of ["area", "delay"] as const) {
        const report = mapDesign(netlist, library, mode);
        assert.equal(report.equiv.mismatches, 0, `${library} ${mode}`);
        for (const row of report.equiv.rows) {
          const y = (inputBit(row.inputs, "a") &
            inputBit(row.inputs, "b") &
            inputBit(row.inputs, "c") &
            inputBit(row.inputs, "d")) as 0 | 1;
          assert.equal(row.outputs[0]?.net, y);
          assert.equal(row.outputs[0]?.mapped, y);
        }
      }
    }
  });

  it("elaborates the full adder from assign", () => {
    const netlist = parseVerilog(source("adder.v"));
    assert.deepEqual(netlist.outputs, ["sum", "cout"]);
    assert.ok(netlist.gates.some((gate) => gate.op === "XOR"));
    const report = mapDesign(netlist, "std", "area");
    assert.equal(report.registers, 0);
    assert.equal(report.equiv.mismatches, 0);
    for (const row of report.equiv.rows) {
      const a = inputBit(row.inputs, "a");
      const b = inputBit(row.inputs, "b");
      const cin = inputBit(row.inputs, "cin");
      const sum = (a ^ b ^ cin) as 0 | 1;
      const cout = ((a & b) | (cin & (a ^ b))) as 0 | 1;
      assert.equal(outputBit(row.outputs, "sum"), sum);
      assert.equal(outputBit(row.outputs, "cout"), cout);
    }
    assert.equal(mapDesign(netlist, "min", "delay").equiv.mismatches, 0);
  });

  it("lowers posedge clk to DFFs and counts", () => {
    const netlist = parseVerilog(source("counter.v"));
    assert.deepEqual(netlist.inputs, []);
    assert.deepEqual(
      netlist.gates.filter((gate) => gate.op === "DFF").map((gate) => gate.id),
      ["q0", "q1"],
    );
    const report = mapDesign(netlist, "std", "delay");
    assert.equal(report.registers, 2);
    assert.equal(report.equiv.mismatches, 0);
    assert.match(report.verilog, /DFF_[124] ff_q0/);
    assert.match(report.verilog, /input clk/);
    let q0 = 0;
    let q1 = 0;
    const expected: Array<[number, number]> = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      expected.push([q0, q1]);
      const n0 = q0 ^ 1;
      const n1 = q1 ^ q0;
      q0 = n0;
      q1 = n1;
    }
    assert.deepEqual(
      report.cycles
        .slice(0, 5)
        .map((row) => [outputBit(row.outputs, "q0"), outputBit(row.outputs, "q1")]),
      expected,
    );
    assert.equal(mapDesign(netlist, "min", "area").equiv.mismatches, 0);
  });

  it("keeps & above | and lowers ?: to a MUX", () => {
    const mixed = parseVerilog(
      "module m(input a, b, c, output y); assign y = a | b & c; endmodule",
    );
    assert.deepEqual(mixed.gates, [
      { id: "_t0", op: "AND", ins: ["b", "c"] },
      { id: "y", op: "OR", ins: ["a", "_t0"] },
    ]);
    const mux = parseVerilog(
      "module mux(input s, a, b, output y); assign y = s ? a : b; endmodule",
    );
    assert.deepEqual(mux.gates, [{ id: "y", op: "MUX", ins: ["s", "a", "b"] }]);
    const report = mapDesign(mux, "std", "area");
    assert.equal(report.equiv.mismatches, 0);
    assert.ok(report.cells.includes("MUX2_1"));
  });

  it("rejects a variable range, a combinational loop, and a second driver", () => {
    assert.throws(
      () =>
        parseVerilog("module m(input [3:0] a, input s, output y); assign y = a[s:1]; endmodule"),
      /constant/,
    );
    assert.throws(
      () => parseVerilog("module m(input a, output y); assign y = ~y; endmodule"),
      /cycle/,
    );
    assert.throws(
      () => parseVerilog("module m(input a, output y); assign y = a; assign y = ~a; endmodule"),
      /already driven/,
    );
  });

  it("elaborates a 4-bit AND per bit", () => {
    const netlist = parseVerilog(source("bus.v"));
    assert.deepEqual(netlist.outputs, ["y_3", "y_2", "y_1", "y_0"]);
    assert.deepEqual(
      netlist.gates.map((gate) => gate.id),
      ["y_0", "y_1", "y_2", "y_3"],
    );
    assert.ok(netlist.gates.every((gate) => gate.op === "AND"));
    checkBus(netlist, (a, b) => a & b & 15);
    assert.equal(mapDesign(netlist, "std", "delay").equiv.mismatches, 0);
  });

  it("adds two 4-bit numbers and wraps", () => {
    const netlist = parseVerilog(source("add.v"));
    checkBus(netlist, (a, b) => (a + b) & 15);
    assert.equal(mapDesign(netlist, "std", "area").equiv.mismatches, 0);
    assert.equal(mapDesign(netlist, "min", "delay").equiv.mismatches, 0);
  });

  it("lowers if / else to a MUX", () => {
    const netlist = parseVerilog(source("if.v"));
    assert.deepEqual(netlist.gates, [{ id: "y", op: "MUX", ins: ["s", "a", "b"] }]);
    const report = mapDesign(netlist, "std", "area");
    assert.equal(report.equiv.mismatches, 0);
    assert.ok(report.cells.includes("MUX2_1"));
  });

  it("lowers case and a bit select", () => {
    const picked = parseVerilog("module m(input [3:0] a, output y); assign y = a[2]; endmodule");
    assert.deepEqual(picked.inputs, ["a_3", "a_2", "a_1", "a_0"]);
    const values = evalNetlist(
      picked,
      new Map([
        ["a_3", 0],
        ["a_2", 1],
        ["a_1", 0],
        ["a_0", 0],
      ]),
    );
    assert.equal(values.get("y"), 1);

    const cased = parseVerilog(`module m(input s, a, b, output y);
      always @(*) begin
        case (s)
          1'b0: y = a;
          1'b1: y = b;
          default: y = 1'b0;
        endcase
      end
    endmodule`);
    const report = mapDesign(cased, "std", "area");
    assert.equal(report.equiv.mismatches, 0);
    for (const row of report.equiv.rows) {
      const s = inputBit(row.inputs, "s");
      const expect = s === 0 ? inputBit(row.inputs, "a") : inputBit(row.inputs, "b");
      assert.equal(outputBit(row.outputs, "y"), expect);
    }
  });

  it("covers a casex don't-care without a latch", () => {
    const net = parseVerilog(`module m(input [2:0] s, output reg [3:0] y);
      always @* casex (s)
        3'b0xx: y = 4'd0;
        3'b100: y = 4'd10;
        3'b101: y = 4'd0;
        3'b110: y = 4'd0;
        3'b111: y = 4'd6;
      endcase
    endmodule`);
    assert.equal(
      net.gates.some((gate) => gate.op === "LATCH"),
      false,
    );
    const word = (bits: number): number => {
      const values = evalNetlist(
        net,
        new Map([
          ["s_2", (bits >> 2) & 1],
          ["s_1", (bits >> 1) & 1],
          ["s_0", bits & 1],
        ]),
      );
      return [0, 1, 2, 3].reduce((sum, index) => sum + (values.get(`y_${index}`) ?? 0) * 2 ** index, 0);
    };
    assert.equal(word(0b001), 0);
    assert.equal(word(0b100), 10);
    assert.equal(word(0b111), 6);
    assert.equal(mapDesign(net, "std", "area").equiv.mismatches, 0);
  });

  it("clears on rst and then counts", () => {
    const netlist = parseVerilog(source("count4.v"));
    assert.equal(netlist.gates.filter((gate) => gate.op === "DFF").length, 4);
    assert.deepEqual(netlist.inputs, ["rst"]);
    const report = mapDesign(netlist, "std", "area");
    assert.equal(report.equiv.mismatches, 0);
    assert.deepEqual(
      report.cycles.map((row) => inputBit(row.inputs, "rst")),
      [1, 1, 0, 0, 0, 0, 1, 0],
    );
    assert.deepEqual(
      report.cycles.map((row) => busValue(row.outputs, "q")),
      [0, 0, 0, 1, 2, 3, 4, 0],
    );
    assert.equal(mapDesign(netlist, "min", "delay").equiv.mismatches, 0);
  });

  it("subtracts and compares", () => {
    const sub = parseVerilog(
      "module m(input [3:0] a, b, output [3:0] y); assign y = a - b; endmodule",
    );
    checkBus(sub, (a, b) => (a - b) & 15);
    const cmp = parseVerilog(`module m(input [3:0] a, b, output lt, le, gt, ge);
      assign lt = a < b; assign le = a <= b; assign gt = a > b; assign ge = a >= b;
    endmodule`);
    for (let index = 0; index < 256; index += 1) {
      const a = index & 15;
      const b = (index >> 4) & 15;
      const values = evalNetlist(cmp, bitsOf(a, b));
      assert.equal(values.get("lt"), a < b ? 1 : 0);
      assert.equal(values.get("le"), a <= b ? 1 : 0);
      assert.equal(values.get("gt"), a > b ? 1 : 0);
      assert.equal(values.get("ge"), a >= b ? 1 : 0);
    }
    assert.equal(mapDesign(cmp, "std", "area").equiv.mismatches, 0);
  });

  it("packs slices and runs a 16-bit subtract", () => {
    const packed = parseVerilog(source("pack.v"));
    for (let index = 0; index < 512; index += 1) {
      const hi = index & 15;
      const lo = (index >> 4) & 15;
      const swap = (index >> 8) & 1;
      const assign = bitsOf(hi, lo, "hi", "lo");
      assign.set("swap", swap === 1 ? 1 : 0);
      const values = evalNetlist(packed, assign);
      const expect = swap === 1 ? (lo << 4) | hi : (hi << 4) | lo;
      assert.equal(readBus(values, "y", 8), expect);
    }
    assert.equal(mapDesign(packed, "std", "area").equiv.mismatches, 0);

    const wide = parseVerilog(source("wide.v"));
    for (const [a, b] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [65535, 1],
      [1000, 2000],
    ] as const) {
      const assign = bitsOf(a, b, "a", "b", 16);
      const values = evalNetlist(wide, assign);
      assert.equal(readBus(values, "y", 16), (a - b) & 65535);
      assert.equal(values.get("lt"), a < b ? 1 : 0);
    }
    assert.equal(mapDesign(wide, "min", "area").equiv.mismatches, 0);
  });

  it("selects an ALU operation", () => {
    const netlist = parseVerilog(source("alu.v"));
    const ops = [
      (a: number, b: number) => (a + b) & 255,
      (a: number, b: number) => (a - b) & 255,
      (a: number, b: number) => a & b,
      (a: number, b: number) => (a < b ? 1 : 0),
    ];
    for (const [a, b] of [
      [0, 0],
      [3, 5],
      [255, 1],
      [20, 20],
    ] as const) {
      for (let op = 0; op < 4; op += 1) {
        const assign = bitsOf(a, b, "a", "b", 8);
        assign.set("op_0", (op & 1) === 1 ? 1 : 0);
        assign.set("op_1", (op & 2) === 2 ? 1 : 0);
        const values = evalNetlist(netlist, assign);
        assert.equal(readBus(values, "y", 8), ops[op]?.(a, b), `op ${op} a ${a} b ${b}`);
      }
    }
    assert.equal(mapDesign(netlist, "std", "delay").equiv.mismatches, 0);
  });

  it("clears asynchronously and holds a latch", () => {
    const asyncCount = parseVerilog(source("async.v"));
    assert.ok(asyncCount.gates.some((gate) => gate.op === "DFF" && gate.ins.length === 3));
    const report = mapDesign(asyncCount, "std", "area");
    assert.equal(report.equiv.mismatches, 0);
    assert.ok(report.cells.includes("ADFF_1"));
    assert.match(report.verilog, /1'b0/);
    assert.deepEqual(
      report.cycles.map((row) => busValue(row.outputs, "q", 8)),
      [0, 0, 0, 1, 2, 3, 0, 0],
    );

    const latch = parseVerilog(source("latch.v"));
    assert.deepEqual(
      latch.gates.map((gate) => gate.op),
      ["LATCH"],
    );
    const held = mapDesign(latch, "std", "area");
    assert.equal(held.equiv.mismatches, 0);
    assert.ok(held.cells.includes("LATCH"));
    assert.match(latch.warnings?.[0] ?? "", /line \d+: latch inferred for 'q'/);
    assert.deepEqual(
      held.cycles.map((row) => outputBit(row.outputs, "q")),
      [0, 0, 0, 1, 1, 1, 0, 1],
    );
    assert.throws(
      () => parseVerilog("module m(input en, output reg q); always @* if (en) q = ~q; endmodule"),
      /cycle/,
    );
    assert.throws(
      () => parseVerilog("module m(input [512:0] a, output y); assign y = a[0]; endmodule"),
      /512 bits/,
    );
    const low = parseVerilog(`module m(input clk, rst_n, output reg q);
      always @(posedge clk or negedge rst_n) begin
        if (~rst_n) q <= 0;
        else q <= 1;
      end
    endmodule`);
    const flop = low.gates.find((gate) => gate.op === "DFF");
    assert.equal(flop?.ins[2], "0");
    assert.notEqual(flop?.ins[1], "rst_n");
  });

  it("warns for every inferred latch and stays quiet otherwise", () => {
    const mux = parseVerilog(
      "module m(input s, a, b, output y); always @* if (s) y = a; else y = b; endmodule",
    );
    assert.deepEqual(mux.warnings, []);
    const flop = parseVerilog(
      "module m(input clk, d, output reg q); always @(posedge clk) q <= d; endmodule",
    );
    assert.deepEqual(flop.warnings, []);
    const full = parseVerilog(
      "module m(input s, a, b, output y); always @* case (s) 1'b1: y = a; default: y = b; endcase endmodule",
    );
    assert.deepEqual(full.warnings, []);

    const partial = parseVerilog(`module m(input en, d, output reg [1:0] q);
      always @* begin
        q[1] = d;
        if (en) q[0] = d;
      end
    endmodule`);
    assert.match(partial.warnings?.join("\n") ?? "", /latch inferred for 'q' \(q_0\)/);

    const missing = parseVerilog(
      "module m(input s, a, output reg q); always @* case (s) 1'b0: q = a; endcase endmodule",
    );
    assert.match(missing.warnings?.[0] ?? "", /latch inferred for 'q'/);

    const written = parseNetlist({
      name: "hold",
      inputs: ["en", "d"],
      outputs: ["q"],
      gates: [{ id: "q", op: "LATCH", ins: ["en", "d"] }],
    });
    assert.match(written.warnings?.[0] ?? "", /latch inferred for 'q'/);
  });

  it("accepts always_comb, always_ff, case labels, and full_case", () => {
    const comb = parseVerilog(
      "module m(input s, a, b, output y); always_comb if (s) y = a; else y = b; endmodule",
    );
    assert.equal(
      comb.gates.some((gate) => gate.op === "LATCH"),
      false,
    );
    for (let index = 0; index < 8; index += 1) {
      const s = (index & 1) as 0 | 1;
      const a = ((index >> 1) & 1) as 0 | 1;
      const b = ((index >> 2) & 1) as 0 | 1;
      const values = evalNetlist(
        comb,
        new Map([
          ["s", s],
          ["a", a],
          ["b", b],
        ]),
      );
      assert.equal(values.get("y"), s === 1 ? a : b);
    }
    assert.equal(
      evalNetlist(
        parseVerilog("module m(input a, output y); always_comb @* y = a; endmodule"),
        new Map([["a", 1]]),
      ).get("y"),
      1,
    );
    assert.equal(
      evalNetlist(
        parseVerilog("module m(input a, output y); always_comb @(*) y = ~a; endmodule"),
        new Map([["a", 1]]),
      ).get("y"),
      0,
    );
    assert.equal(
      evalNetlist(
        parseVerilog("module m(input a, output y); always_comb y <= a; endmodule"),
        new Map([["a", 1]]),
      ).get("y"),
      1,
    );
    assert.throws(
      () =>
        parseVerilog(
          "module m(input clk, a, output y); always_comb @(posedge clk) y = a; endmodule",
        ),
      /always_comb/,
    );

    const flop = parseVerilog(
      "module m(input clk, d, output reg q); always_ff @(posedge clk) q <= d; endmodule",
    );
    assert.equal(flop.gates.filter((gate) => gate.op === "DFF").length, 1);
    const reset = parseVerilog(`module m(input clk, rst, d, output reg q);
      always_ff @(posedge clk or posedge rst) if (rst) q <= 0; else q <= d;
    endmodule`);
    assert.equal(reset.gates.find((gate) => gate.op === "DFF")?.ins.length, 3);
    assert.throws(
      () =>
        parseVerilog(
          "module m(input clk, d, output reg q); always_ff @(posedge clk) q = d; endmodule",
        ),
      /use <=/,
    );
    assert.throws(
      () => parseVerilog("module m(input clk, d, output reg q); always_ff @* q <= d; endmodule"),
      /always_ff/,
    );
    assert.throws(
      () => parseVerilog("module m(input d, output reg q); always_ff q <= d; endmodule"),
      /always_ff/,
    );

    const picked = parseVerilog(`module m(input [1:0] s, input a, b, output y);
      always_comb case (s)
        2'd0, 2'd1: y = a;
        2'd2: y = b;
        default: y = 1'b0;
      endcase
    endmodule`);
    for (let s = 0; s < 4; s += 1) {
      for (const a of [0, 1] as const) {
        for (const b of [0, 1] as const) {
          const values = evalNetlist(
            picked,
            new Map([
              ["s_0", (s & 1) as 0 | 1],
              ["s_1", ((s >> 1) & 1) as 0 | 1],
              ["a", a],
              ["b", b],
            ]),
          );
          const expect = s === 0 || s === 1 ? a : s === 2 ? b : 0;
          assert.equal(values.get("y"), expect, `s=${s}`);
        }
      }
    }
    assert.throws(
      () =>
        parseVerilog(
          "module m(input s, a, output y); always @* case (s) a: y = a; endcase endmodule",
        ),
      /parameter/,
    );

    const fullOf = (comment: string) =>
      parseVerilog(`module m(input s, a, output reg y);
      always_comb case (s) ${comment}
        1'b1: y = a;
      endcase
    endmodule`);
    for (const comment of [
      "// synopsys full_case",
      "/* synthesis full_case */",
      "// synopsys full_case parallel_case",
    ]) {
      const full = fullOf(comment);
      assert.equal(
        full.gates.some((gate) => gate.op === "LATCH"),
        false,
        comment,
      );
      assert.deepEqual(full.warnings, [], comment);
      assert.equal(
        evalNetlist(
          full,
          new Map([
            ["s", 0],
            ["a", 1],
          ]),
        ).get("y"),
        0,
      );
      assert.equal(
        evalNetlist(
          full,
          new Map([
            ["s", 1],
            ["a", 1],
          ]),
        ).get("y"),
        1,
      );
    }
    const still = parseVerilog(`module m(input s, a, output reg y);
      // synopsys full_case
      always @* case (s)
        1'b1: y = a; // synopsys parallel_case
      endcase
    endmodule`);
    assert.equal(
      still.gates.some((gate) => gate.op === "LATCH"),
      true,
    );
    assert.match(still.warnings?.[0] ?? "", /latch inferred for 'y'/);

    const held = (comment: string) => `module m(input clk, s, d, output reg q);
      always_ff @(posedge clk) case (s) ${comment}
        1'b1: q <= d;
      endcase
    endmodule`;
    const step = (text: string, q: 0 | 1, s: 0 | 1, d: 0 | 1) => {
      const net = parseVerilog(text);
      const flopGate = flopsOf(net).find((item) => item.kind === "dff");
      assert.ok(flopGate && flopGate.kind === "dff");
      const values = evalNetlist(
        net,
        new Map<string, 0 | 1>([
          ["clk", 0],
          ["s", s],
          ["d", d],
          [flopGate.q, q],
        ]),
      );
      return values.get(flopGate.d);
    };
    assert.equal(step(held("// synopsys full_case"), 1, 0, 0), 1);
    assert.equal(step(held(""), 1, 0, 0), 1);
    assert.equal(step(held("// synopsys full_case"), 0, 1, 1), 1);
  });

  it("holds a reg when a clocked case arm assigns something else", () => {
    const net =
      parseVerilog(`module m(input clk, input [1:0] op, input d, output reg q, output reg y);
      always @(posedge clk) case (op)
        2'd0: y <= d;
        2'd1: q <= d;
        default: q <= 1'b0;
      endcase
    endmodule`);
    const flops = flopsOf(net).filter((item) => item.kind === "dff");
    const qFlop = flops.find((item) => item.q === "q");
    const yFlop = flops.find((item) => item.q === "y");
    assert.ok(qFlop && qFlop.kind === "dff");
    assert.ok(yFlop && yFlop.kind === "dff");
    const step = (op: number, q: 0 | 1, y: 0 | 1, d: 0 | 1) => {
      const values = evalNetlist(
        net,
        new Map<string, 0 | 1>([
          ["clk", 0],
          ["op_0", (op & 1) === 1 ? 1 : 0],
          ["op_1", (op & 2) === 2 ? 1 : 0],
          ["d", d],
          [qFlop.q, q],
          [yFlop.q, y],
        ]),
      );
      return { q: values.get(qFlop.d), y: values.get(yFlop.d) };
    };
    assert.deepEqual(step(0, 1, 0, 1), { q: 1, y: 1 });
    assert.deepEqual(step(1, 1, 0, 0), { q: 0, y: 0 });
    assert.deepEqual(step(3, 1, 1, 1), { q: 0, y: 1 });
  });

  it("does not mux bits a clocked case arm does not write", () => {
    const rtl = `module m(input clk, input [3:0] op, input d, output reg a, output reg b);
      always @(posedge clk) case (op)
        4'd0: a <= d;
        4'd1: a <= ~d;
        4'd2: b <= d;
        default: b <= 1'b0;
      endcase
    endmodule`;
    const net = parseVerilog(rtl);
    const muxes = net.gates.filter((gate) => gate.op === "MUX").length;
    assert.ok(muxes < 12, `muxes ${muxes}`);
    const flops = flopsOf(net).filter((item) => item.kind === "dff");
    const aFlop = flops.find((item) => item.q === "a");
    const bFlop = flops.find((item) => item.q === "b");
    assert.ok(aFlop && aFlop.kind === "dff" && bFlop && bFlop.kind === "dff");
    const step = (op: number, a: 0 | 1, b: 0 | 1, d: 0 | 1) => {
      const values = evalNetlist(
        net,
        new Map<string, 0 | 1>([
          ["clk", 0],
          ["op_0", (op & 1) === 1 ? 1 : 0],
          ["op_1", (op & 2) === 2 ? 1 : 0],
          ["op_2", (op & 4) === 4 ? 1 : 0],
          ["op_3", (op & 8) === 8 ? 1 : 0],
          ["d", d],
          [aFlop.q, a],
          [bFlop.q, b],
        ]),
      );
      return { a: values.get(aFlop.d), b: values.get(bFlop.d) };
    };
    assert.deepEqual(step(0, 0, 1, 1), { a: 1, b: 1 });
    assert.deepEqual(step(1, 1, 1, 1), { a: 0, b: 1 });
    assert.deepEqual(step(2, 1, 0, 1), { a: 1, b: 1 });
    assert.deepEqual(step(3, 1, 1, 1), { a: 1, b: 0 });
    assert.deepEqual(step(15, 0, 1, 0), { a: 0, b: 0 });
    const overlap = parseVerilog(`module m(input clk, input [1:0] op, input a, b, output reg y);
      always @(posedge clk) case (op)
        2'd0, 2'd1: y <= a;
        2'd1: y <= b;
        default: y <= 1'b0;
      endcase
    endmodule`);
    const yFlop = flopsOf(overlap).find((item) => item.kind === "dff" && item.q === "y");
    assert.ok(yFlop && yFlop.kind === "dff");
    const yOf = (op: number, a: 0 | 1, b: 0 | 1) =>
      evalNetlist(
        overlap,
        new Map<string, 0 | 1>([
          ["clk", 0],
          ["op_0", (op & 1) === 1 ? 1 : 0],
          ["op_1", (op & 2) === 2 ? 1 : 0],
          ["a", a],
          ["b", b],
          [yFlop.q, 0],
        ]),
      ).get(yFlop.d);
    assert.equal(yOf(1, 1, 0), 1);
    assert.equal(yOf(0, 0, 1), 0);
    assert.equal(yOf(3, 1, 1), 0);
  });

  it("shifts, indexes, multiplies, and flattens a parameterized adder", () => {
    const shifted = parseVerilog(
      "module m(input [3:0] a, input [1:0] s, output [3:0] y); assign y = a << s; endmodule",
    );
    for (let index = 0; index < 64; index += 1) {
      const a = index & 15;
      const s = (index >> 4) & 3;
      const assign = bitsOf(a, s, "a", "s", 4);
      assign.delete("s_2");
      assign.delete("s_3");
      const values = evalNetlist(shifted, assign);
      assert.equal(readBus(values, "y", 4), (a << s) & 15);
    }
    const right = parseVerilog(
      "module m(input [3:0] a, output [3:0] y); assign y = a >> 1; endmodule",
    );
    assert.equal(readBus(evalNetlist(right, bitsOf(0b1010, 0)), "y", 4), 0b0101);

    const picked = parseVerilog(
      "module m(input [3:0] a, input [1:0] i, output y); assign y = a[i]; endmodule",
    );
    for (let index = 0; index < 64; index += 1) {
      const a = index & 15;
      const i = (index >> 4) & 3;
      const assign = bitsOf(a, i, "a", "i", 4);
      assign.delete("i_2");
      assign.delete("i_3");
      assert.equal(evalNetlist(picked, assign).get("y"), (a >> i) & 1);
    }

    const area = parseVerilog(source("mul.v"), { mode: "area" });
    const delay = parseVerilog(source("mul.v"), { mode: "delay" });
    assert.ok(area.notes?.includes("array multiplier"));
    assert.ok(delay.notes?.includes("Wallace multiplier"));
    assert.notEqual(area.gates.length, delay.gates.length);
    for (let index = 0; index < 256; index += 1) {
      const a = index & 15;
      const b = (index >> 4) & 15;
      const values = evalNetlist(delay, bitsOf(a, b));
      assert.equal(readBus(values, "y", 8), a * b);
    }
    assert.equal(mapDesign(area, "std", "area").equiv.mismatches, 0);

    const flat = parseVerilog(source("hier.v"), { mode: "area" });
    assert.ok(flat.notes?.includes("ripple adder"));
    checkBus(flat, (a, b) => (a + b) & 255, 8);
    const fast = parseVerilog(
      "module m(input [3:0] a, b, output [3:0] y); assign y = a + b; endmodule",
      { mode: "delay" },
    );
    assert.ok(fast.notes?.includes("brent-kung adder"));
    checkBus(fast, (a, b) => (a + b) & 15);
  });

  it("keeps the carry when a sum is wider than its operands", () => {
    const net = parseVerilog(
      "module m(input [3:0] a, b, input cin, output [4:0] y, output c); assign y = a + b + cin; assign c = y[4]; endmodule",
    );
    for (let index = 0; index < 512; index += 1) {
      const a = index & 15;
      const b = (index >> 4) & 15;
      const cin = ((index >> 8) & 1) === 1 ? 1 : 0;
      const assign = bitsOf(a, b, "a", "b", 4);
      assign.set("cin", cin);
      const got = evalNetlist(net, assign);
      const sum = a + b + cin;
      assert.equal(readBus(got, "y", 5), sum);
      assert.equal(got.get("c"), (sum >> 4) & 1);
    }
    assert.equal(mapDesign(net, "std", "area").equiv.mismatches, 0);
  });

  it("compares an unsized subtract at 32 bits", () => {
    const net = parseVerilog(
      "module m(input [4:0] rounds, input [3:0] dr, output y, output [7:0] s); assign y = dr == (rounds[4:1] - 1); assign s = rounds[4:1] - 1; endmodule",
    );
    const at = (rounds: number, dr: number): { y: number; s: number } => {
      const assign = bitsOf(rounds, dr, "rounds", "dr", 5);
      for (let bit = 0; bit < 4; bit += 1) assign.set(`dr_${bit}`, ((dr >> bit) & 1) as 0 | 1);
      const got = evalNetlist(net, assign);
      return { y: got.get("y") ?? 0, s: readBus(got, "s", 8) };
    };
    // rounds[4:1] is 0; 0 - 1 is 32'hffffffff, not equal to 4'd15. The low bits are 8'hff.
    assert.deepEqual(at(1, 15), { y: 0, s: 255 });
    // rounds[4:1] is 8; 8 - 1 is 7.
    assert.deepEqual(at(16, 7), { y: 1, s: 7 });
    assert.equal(mapDesign(net, "std", "area").equiv.mismatches, 0);
  });

  it("shares an adder only in area mode", () => {
    const area = parseVerilog(source("share.v"), { mode: "area" });
    const delay = parseVerilog(source("share.v"), { mode: "delay" });
    assert.ok(area.notes?.includes("shared adder"));
    assert.ok(area.notes?.includes("ripple adder"));
    assert.equal(delay.notes?.includes("shared adder"), false);
    assert.ok(delay.notes?.includes("brent-kung adder"));
    const xors = (net: { gates: { op: string }[] }) =>
      net.gates.filter((gate) => gate.op === "XOR").length;
    assert.ok(xors(area) < xors(delay));
    for (const net of [area, delay]) {
      for (let index = 0; index < 512; index += 1) {
        const a = index & 15;
        const b = (index >> 4) & 15;
        const op = (index >> 8) & 1;
        const assign = bitsOf(a, b);
        assign.set("op", op === 1 ? 1 : 0);
        const values = evalNetlist(net, assign);
        assert.equal(readBus(values, "y", 4), op === 1 ? (a + b) & 15 : (a - b) & 15);
      }
    }
    const alu = parseVerilog(source("alu.v"), { mode: "area" });
    assert.ok(alu.notes?.includes("shared adder"));
  });

  it("shares adders chosen by a clocked case", () => {
    const rtl = `module m(
      input clk,
      input [1:0] op,
      input [7:0] a, b, c,
      output reg [7:0] y
    );
      always @(posedge clk) begin
        case (op)
          2'd0: y <= a + b;
          2'd1: y <= a ^ b;
          2'd2: y <= a - c;
          default: y <= b + c;
        endcase
      end
    endmodule`;
    const area = parseVerilog(rtl, { mode: "area" });
    const delay = parseVerilog(rtl, { mode: "delay" });
    assert.ok(area.notes?.includes("shared adder"));
    assert.equal(delay.notes?.includes("shared adder"), false);
    assert.ok(delay.notes?.includes("brent-kung adder"));
    const xors = (net: { gates: { op: string }[] }) =>
      net.gates.filter((gate) => gate.op === "XOR").length;
    assert.equal(xors(area), 30);
    assert.ok(xors(delay) > xors(area));
    const pack = (name: string, value: number, width: number, into: Map<string, 0 | 1>) => {
      for (let index = 0; index < width; index += 1)
        into.set(`${name}_${index}`, ((value >> index) & 1) === 1 ? 1 : 0);
    };
    const read = (values: ReadonlyMap<string, 0 | 1>) => {
      let value = 0;
      for (let index = 0; index < 8; index += 1)
        if (values.get(`y_${index}`) === 1) value |= 1 << index;
      return value;
    };
    const step = (
      net: ReturnType<typeof parseVerilog>,
      op: number,
      a: number,
      b: number,
      c: number,
      state: Map<string, 0 | 1>,
    ) => {
      const inputs = new Map<string, 0 | 1>();
      pack("op", op, 2, inputs);
      pack("a", a, 8, inputs);
      pack("b", b, 8, inputs);
      pack("c", c, 8, inputs);
      const values = evalNetlist(net, new Map([...inputs, ...state]));
      const next = new Map<string, 0 | 1>();
      for (const flop of flopsOf(net)) next.set(flop.q, values.get(flop.d) ?? 0);
      return next;
    };
    const expect = (op: number, a: number, b: number, c: number) => {
      if (op === 0) return (a + b) & 255;
      if (op === 1) return a ^ b;
      if (op === 2) return (a - c) & 255;
      return (b + c) & 255;
    };
    for (const net of [area, delay]) {
      let state = new Map<string, 0 | 1>(flopsOf(net).map((flop) => [flop.q, 0]));
      for (const [op, a, b, c] of [
        [0, 20, 5, 3],
        [1, 20, 5, 3],
        [2, 20, 5, 9],
        [3, 4, 8, 7],
        [0, 200, 100, 1],
      ] as const) {
        state = step(net, op, a, b, c, state);
        assert.equal(read(state), expect(op, a, b, c));
      }
      assert.equal(mapDesign(net, "std", "area").equiv.mismatches, 0);
    }
  });

  it("keeps a fast adder only when the path has no slack", () => {
    const rtl = `module m(input clk, input [15:0] a, b, c, d, output reg [15:0] y, z);
      always @(posedge clk) begin
        y <= a + b;
        z <= c + d;
      end
    endmodule`;
    const net = parseVerilog(rtl, { mode: "delay" });
    assert.ok(net.notes?.includes("brent-kung adder"));
    assert.equal(net.notes?.includes("ripple adder"), false);
    const loose = mapDesign(net, sky130Hd(), "area", 10);
    const tight = mapDesign(net, sky130Hd(), "area", 0.01);
    assert.equal(loose.timing?.met, true);
    assert.equal(tight.timing?.met, false);
    assert.ok(loose.area < tight.area);
    assert.equal(loose.equiv.mismatches, 0);
    assert.equal(tight.equiv.mismatches, 0);
    for (let index = 0; index < loose.cycles.length; index += 1) {
      assert.deepEqual(
        loose.cycles[index]?.outputs.map((item) => item.net),
        tight.cycles[index]?.outputs.map((item) => item.net),
      );
    }
  });

  it("reuses one subtract for a compare of the same operands", () => {
    const xors = (src: string, mode: "area" | "delay") =>
      parseVerilog(src, { mode }).gates.filter((gate) => gate.op === "XOR").length;
    const invs = (src: string, mode: "area" | "delay") =>
      parseVerilog(src, { mode }).gates.filter((gate) => gate.op === "INV").length;
    const diff = "module m(input [7:0] a, b, output [7:0] d); assign d = a - b; endmodule";
    const same =
      "module m(input [7:0] a, b, output [7:0] d, output lt); assign d = a - b; assign lt = a < b; endmodule";
    const later =
      "module m(input [7:0] a, b, output [7:0] d, output lt); assign lt = a < b; assign d = a - b; endmodule";
    const ge =
      "module m(input [7:0] a, b, output [7:0] d, output ge); assign d = a - b; assign ge = a >= b; endmodule";
    const other =
      "module m(input [7:0] a, b, output [7:0] d, output gt); assign d = a - b; assign gt = a > b; endmodule";
    for (const mode of ["area", "delay"] as const) {
      assert.equal(xors(same, mode), xors(diff, mode));
      assert.equal(xors(later, mode), xors(diff, mode));
      assert.equal(xors(ge, mode), xors(diff, mode));
      assert.ok(xors(other, mode) > xors(same, mode));
      assert.equal(invs(same, mode), invs(diff, mode) + 1);
      assert.ok(invs(other, mode) > invs(same, mode));
      const net = parseVerilog(mode === "delay" ? later : same, { mode });
      if (mode === "delay") assert.ok(net.notes?.includes("brent-kung adder"));
      for (let a = 0; a < 256; a += 17) {
        for (let b = 0; b < 256; b += 19) {
          const values = evalNetlist(net, bitsOf(a, b, "a", "b", 8));
          assert.equal(readBus(values, "d", 8), (a - b) & 255, `${mode} ${a}-${b}`);
          assert.equal(values.get("lt"), a < b ? 1 : 0);
        }
      }
    }
    const picked = parseVerilog(
      "module m(input [3:0] a, b, c, output [3:0] y); assign y = a < b ? a - b : c; endmodule",
      { mode: "delay" },
    );
    const bare = "module m(input [3:0] a, b, output [3:0] y); assign y = a - b; endmodule";
    assert.equal(picked.gates.filter((gate) => gate.op === "XOR").length, xors(bare, "delay"));
    for (let index = 0; index < 256; index += 1) {
      const a = index & 15;
      const b = (index >> 4) & 15;
      for (const c of [0, 7, 15]) {
        const assign = bitsOf(a, b);
        for (let bit = 0; bit < 4; bit += 1) assign.set(`c_${bit}`, ((c >> bit) & 1) === 1 ? 1 : 0);
        const values = evalNetlist(picked, assign);
        assert.equal(readBus(values, "y", 4), a < b ? (a - b) & 15 : c);
      }
    }
    const signed = parseVerilog(
      "module m(input signed [3:0] a, b, output signed [3:0] d, output lt); assign d = a - b; assign lt = a < b; endmodule",
      { mode: "delay" },
    );
    const signedSplit = parseVerilog(
      "module m(input signed [3:0] a, b, output signed [3:0] d, output gt); assign d = a - b; assign gt = a > b; endmodule",
      { mode: "delay" },
    );
    assert.ok(
      signed.gates.filter((gate) => gate.op === "XOR").length <
        signedSplit.gates.filter((gate) => gate.op === "XOR").length,
    );
    for (let a = 0; a < 16; a += 1) {
      for (let b = 0; b < 16; b += 1) {
        const sa = (a << 28) >> 28;
        const sb = (b << 28) >> 28;
        const values = evalNetlist(signed, bitsOf(a, b));
        assert.equal(readBus(values, "d", 4), (sa - sb) & 15, `${sa}-${sb}`);
        assert.equal(values.get("lt"), sa < sb ? 1 : 0);
      }
    }
  });

  it("checks Brent-Kung at every width, including non-powers of two", () => {
    for (const width of [1, 3, 5, 6, 7, 8]) {
      const add = parseVerilog(
        `module m(input [${width - 1}:0] a, b, output [${width - 1}:0] y); assign y = a + b; endmodule`,
        { mode: "delay" },
      );
      const sub = parseVerilog(
        `module m(input [${width - 1}:0] a, b, output [${width - 1}:0] y); assign y = a - b; endmodule`,
        { mode: "delay" },
      );
      assert.ok(add.notes?.includes("brent-kung adder"));
      const mask = (1 << width) - 1;
      const limit = 1 << width;
      for (let a = 0; a < limit; a += 1) {
        for (let b = 0; b < limit; b += 1) {
          const assign = bitsOf(a, b, "a", "b", width);
          assert.equal(
            readBus(evalNetlist(add, assign), "y", width),
            (a + b) & mask,
            `add ${width} ${a}+${b}`,
          );
          assert.equal(
            readBus(evalNetlist(sub, assign), "y", width),
            (a - b) & mask,
            `sub ${width} ${a}-${b}`,
          );
        }
      }
    }
  });

  it("places a lookahead adder between ripple and Brent-Kung", () => {
    const valueOf = (kind: AdderKind, width: number, a: number, b: number, cin: 0 | 1) => {
      const gates: { id: string; op: "INV" | "AND" | "OR" | "XOR" | "MUX"; ins: string[] }[] = [];
      let seq = 0;
      const emit: EmitFn = (op, ins, id) => {
        const name = id ?? `g${seq}`;
        seq += 1;
        if (op === "DFF" || op === "LATCH") throw new Error(op);
        gates.push({ id: name, op, ins: [...ins] });
        return name;
      };
      const left = Array.from({ length: width }, (_, index) => `a${index}`);
      const right = Array.from({ length: width }, (_, index) => `b${index}`);
      const built = rebuildAdder(kind, emit, left, right, cin === 1 ? "1" : "0");
      const assign = new Map<string, 0 | 1>();
      for (let index = 0; index < width; index += 1) {
        assign.set(`a${index}`, ((a >> index) & 1) === 1 ? 1 : 0);
        assign.set(`b${index}`, ((b >> index) & 1) === 1 ? 1 : 0);
      }
      const net = validate({
        name: "add",
        inputs: [...left, ...right],
        outputs: [...built.sums, built.cout],
        gates,
      });
      const values = evalNetlist(net, assign);
      let total = 0;
      built.sums.forEach((id, index) => {
        if (values.get(id) === 1) total += 1 << index;
      });
      if (values.get(built.cout) === 1) total += 1 << width;
      return { total, gates: gates.length };
    };
    for (const width of [1, 4, 5, 8, 9, 16]) {
      const ripple = adderLevels("ripple", width);
      const mid = adderLevels("lookahead", width);
      const prefix = adderLevels("brent-kung", width);
      assert.ok(prefix <= mid && mid <= ripple, `${width} ${prefix} ${mid} ${ripple}`);
      if (width >= 8) assert.ok(prefix < mid && mid < ripple);
      const mask = (1 << (width + 1)) - 1;
      const corners: [number, number, 0 | 1][] = [
        [0, 0, 0],
        [(1 << width) - 1, 1, 1],
        [(1 << width) - 1, (1 << width) - 1, 1],
      ];
      for (const cin of [0, 1] as const) {
        for (let a = 0; a < 1 << Math.min(width, 8); a += 17) {
          for (let b = 0; b < 1 << Math.min(width, 8); b += 19) corners.push([a, b, cin]);
        }
      }
      for (const [a, b, cin] of corners) {
        const expect = (a + b + cin) & mask;
        for (const kind of ["ripple", "lookahead", "brent-kung"] as const) {
          assert.equal(
            valueOf(kind, width, a, b, cin).total,
            expect,
            `${kind} ${width} ${a}+${b}+${cin}`,
          );
        }
      }
    }
    const counts = (["ripple", "lookahead", "brent-kung"] as const).map(
      (kind) => valueOf(kind, 16, 1, 1, 0).gates,
    );
    assert.ok(
      (counts[0] ?? 0) < (counts[1] ?? 0) && (counts[1] ?? 0) < (counts[2] ?? 0),
      counts.join(" "),
    );
  });

  it("lets a PPA weight decide how much slack an adder may spend", () => {
    assert.equal(ppaFits(1.1, 1, 0), true);
    assert.equal(ppaFits(1.1, 1, 1), false);
    assert.equal(ppaFits(2.2, 1, 1), true);
    const near = (value: number, expect: number) => assert.ok(Math.abs(value - expect) < 1e-9);
    near(ppaWeight(8, 10), 0.2);
    near(ppaWeight(0, 10), 1);
    near(ppaWeight(-1, 10), 1);
    near(ppaWeight(0.5, 10, 0), 0.45);
    near(ppaWeight(8, 10, 1), 0.7);
    assert.equal(ppaWeight(Number.POSITIVE_INFINITY, 10, 1), 0);
    const rtl = `module m(input clk, input [7:0] a, b, output reg [7:0] y);
      always @(posedge clk) y <= a + b;
    endmodule`;
    const net = parseVerilog(rtl, { mode: "delay" });
    const area = mapDesign(net, sky130Hd(), "load", { period: 10, ppa: 0 });
    const fast = mapDesign(net, sky130Hd(), "load", { period: 10, ppa: 1 });
    assert.ok(area.area <= fast.area + 0.05);
    assert.equal(area.equiv.mismatches, 0);
    assert.equal(fast.equiv.mismatches, 0);
    assert.throws(() => mapDesign(net, sky130Hd(), "load", { period: 10, ppa: 2 }), /ppa/);
  });

  it("replicates, sign-fills, and sign-extends", () => {
    const rep = parseVerilog(source("rep.v"));
    for (let a = 0; a < 4; a += 1) {
      const values = evalNetlist(rep, bitsOf(a, 0, "a", "b", 2));
      let expect = 0;
      for (let copy = 0; copy < 4; copy += 1) expect |= a << (copy * 2);
      assert.equal(readBus(values, "y", 8), expect);
    }
    const wide = parseVerilog(
      "module m(input [1:0] a, b, output [7:0] y); assign y = {2{a, b}}; endmodule",
    );
    assert.equal(readBus(evalNetlist(wide, bitsOf(0b10, 0b01)), "y", 8), 0b10011001);

    const shift = parseVerilog(source("ashift.v"));
    for (let index = 0; index < 256; index += 1) {
      for (let s = 0; s < 8; s += 1) {
        const assign = bitsOf(index, s, "a", "s", 8);
        for (let bit = 3; bit < 8; bit += 1) assign.delete(`s_${bit}`);
        const values = evalNetlist(shift, assign);
        const signed = (index << 24) >> 24;
        assert.equal(readBus(values, "y", 8), (signed >> s) & 255, `arith a=${index} s=${s}`);
        assert.equal(readBus(values, "z", 8), (index >>> s) & 255, `logic a=${index} s=${s}`);
      }
    }

    const math = parseVerilog(source("signed.v"));
    for (let a = 0; a < 16; a += 1) {
      for (let b = 0; b < 16; b += 1) {
        const values = evalNetlist(math, bitsOf(a, b));
        const sa = (a << 28) >> 28;
        const sb = (b << 28) >> 28;
        assert.equal(readBus(values, "y", 8), (sa * sb) & 255, `mul ${sa} ${sb}`);
        assert.equal(readBus(values, "s", 8), (sa + sb) & 255, `add ${sa} ${sb}`);
      }
    }
    const cmp = parseVerilog(
      "module m(input signed [3:0] a, b, output lt); assign lt = a < b; endmodule",
    );
    for (let a = 0; a < 16; a += 1) {
      for (let b = 0; b < 16; b += 1) {
        const sa = (a << 28) >> 28;
        const sb = (b << 28) >> 28;
        assert.equal(evalNetlist(cmp, bitsOf(a, b)).get("lt"), sa < sb ? 1 : 0, `${sa} < ${sb}`);
      }
    }
  });

  it("divides with a restoring row or a prefix array", () => {
    const area = parseVerilog(source("div.v"), { mode: "area" });
    const delay = parseVerilog(source("div.v"), { mode: "delay" });
    assert.ok(area.notes?.includes("restoring divider"));
    assert.ok(delay.notes?.includes("array divider"));
    assert.equal(area.notes?.includes("array divider"), false);
    assert.notEqual(area.gates.length, delay.gates.length);
    for (const net of [area, delay]) {
      for (let a = 0; a < 16; a += 1) {
        for (let b = 1; b < 16; b += 1) {
          const values = evalNetlist(net, bitsOf(a, b));
          assert.equal(readBus(values, "q", 4), Math.floor(a / b), `q ${a}/${b}`);
          assert.equal(readBus(values, "r", 4), a % b, `r ${a}%${b}`);
        }
      }
    }
    const zero = evalNetlist(area, bitsOf(5, 0));
    assert.equal(readBus(zero, "q", 4), 15);
    assert.equal(readBus(zero, "r", 4), 5);

    const signed = parseVerilog(
      "module m(input signed [3:0] a, b, output signed [3:0] q, r); assign q = a / b; assign r = a % b; endmodule",
    );
    const toSigned = (n: number) => (n << 28) >> 28;
    for (let a = 0; a < 16; a += 1) {
      for (let b = 0; b < 16; b += 1) {
        const sb = toSigned(b);
        if (sb === 0 || (toSigned(a) === -8 && sb === -1)) continue;
        const values = evalNetlist(signed, bitsOf(a, b));
        const sa = toSigned(a);
        assert.equal(
          toSigned(readBus(values, "q", 4)) + 0,
          Math.trunc(sa / sb) + 0,
          `q ${sa}/${sb}`,
        );
        assert.equal(toSigned(readBus(values, "r", 4)) + 0, (sa % sb) + 0, `r ${sa}%${sb}`);
      }
    }
    assert.equal(mapDesign(area, "min", "area").equiv.mismatches, 0);
  });

  it("writes a word of flops and reads it back", () => {
    const netlist = parseVerilog(source("mem.v"));
    assert.equal(netlist.gates.filter((gate) => gate.op === "DFF").length, 128);
    const flops = netlist.gates.filter((gate) => gate.op === "DFF");
    let state = new Map<string, 0 | 1>(flops.map((gate) => [gate.id, 0]));
    const run = (we: 0 | 1, addr: number, data: number) => {
      const assign = new Map<string, 0 | 1>(state);
      assign.set("we", we);
      for (let bit = 0; bit < 4; bit += 1)
        assign.set(`addr_${bit}`, ((addr >> bit) & 1) === 1 ? 1 : 0);
      for (let bit = 0; bit < 8; bit += 1)
        assign.set(`d_${bit}`, ((data >> bit) & 1) === 1 ? 1 : 0);
      const values = evalNetlist(netlist, assign);
      const seen = readBus(values, "q", 8);
      const next = new Map(state);
      for (const flop of flops) next.set(flop.id, values.get(flop.ins[0] ?? "0") ?? 0);
      state = next;
      return seen;
    };
    assert.equal(run(1, 3, 0x5a), 0);
    assert.equal(run(0, 3, 0), 0x5a);
    assert.equal(run(1, 15, 0xff), 0);
    assert.equal(run(0, 3, 0), 0x5a);
    assert.equal(run(0, 15, 0), 0xff);
    assert.equal(run(1, 3, 0x01), 0x5a);
    assert.equal(run(0, 3, 0), 0x01);
  });

  it("reduces a bus and treats && as nonzero", () => {
    const netlist = parseVerilog(source("reduce.v"));
    for (let index = 0; index < 256; index += 1) {
      const a = index & 15;
      const b = (index >> 4) & 15;
      const values = evalNetlist(netlist, bitsOf(a, b));
      assert.equal(values.get("y"), a === 15 ? 1 : 0);
      assert.equal(values.get("z"), b !== 0 ? 1 : 0);
      assert.equal(values.get("n"), a === 0 ? 1 : 0);
      assert.equal(values.get("both"), a !== 0 && b !== 0 ? 1 : 0);
    }
    const xor = parseVerilog(
      "module m(input [3:0] a, output y, nand, xnor); assign y = ^a; assign nand = ~&a; assign xnor = ^~a; endmodule",
    );
    for (let a = 0; a < 16; a += 1) {
      const values = evalNetlist(xor, bitsOf(a, 0));
      let parity = 0;
      for (let bit = 0; bit < 4; bit += 1) parity ^= (a >> bit) & 1;
      assert.equal(values.get("y"), parity);
      assert.equal(values.get("nand"), a === 15 ? 0 : 1);
      assert.equal(values.get("xnor"), parity ^ 1);
    }
    const either = parseVerilog(
      "module m(input [3:0] a, b, output y); assign y = a || b; endmodule",
    );
    assert.equal(evalNetlist(either, bitsOf(0, 0)).get("y"), 0);
    assert.equal(evalNetlist(either, bitsOf(0, 2)).get("y"), 1);
    assert.equal(mapDesign(netlist, "std", "area").equiv.mismatches, 0);
  });

  it("unrolls a constant for", () => {
    const band = parseVerilog(`module m(input [3:0] a, b, output [3:0] y);
      integer i;
      always @* begin
        for (i = 0; i < 4; i = i + 1) y[i] = a[i] & b[i];
      end
    endmodule`);
    checkBus(band, (a, b) => a & b);
    const rev = parseVerilog(`module m(input [3:0] a, output [3:0] y);
      integer i;
      always @* for (i = 3; i >= 0; i = i - 1) y[i] = a[3 - i];
    endmodule`);
    for (let a = 0; a < 16; a += 1) {
      const values = evalNetlist(rev, bitsOf(a, 0));
      assert.equal(
        readBus(values, "y", 4),
        ((a & 1) << 3) | ((a & 2) << 1) | ((a & 4) >> 1) | ((a & 8) >> 3),
      );
    }
    const wide = parseVerilog(`module m #(parameter N = 4) (input [3:0] a, output [3:0] y);
      integer i;
      always @* for (i = 0; i < N; i = i + 1) y[i] = ~a[i];
    endmodule`);
    checkBus(wide, (a) => ~a & 15);
    assert.throws(() =>
      parseVerilog(
        "module m(input i, output reg y); always @* for (i = 0; i < 2; i = i + 1) y = 1'b0; endmodule",
      ),
    );

    const shift = parseVerilog(source("sreg.v"));
    assert.equal(shift.gates.filter((gate) => gate.op === "DFF").length, 8);
    const flops = shift.gates.filter((gate) => gate.op === "DFF");
    let state = new Map(flops.map((flop) => [flop.id, 0 as 0 | 1]));
    const tick = (d: 0 | 1, rst: 0 | 1) => {
      const assign = new Map(state);
      assign.set("d", d);
      assign.set("rst", rst);
      const values = evalNetlist(shift, assign);
      const next = new Map<string, 0 | 1>();
      for (const flop of flops) {
        const cleared = rst === 1 && flop.ins[1] === "rst";
        next.set(flop.id, cleared ? 0 : (values.get(flop.ins[0] ?? "0") ?? 0));
      }
      state = next;
    };
    tick(1, 1);
    assert.equal(
      [...state.values()].every((bit) => bit === 0),
      true,
    );
    tick(1, 0);
    tick(0, 0);
    tick(1, 0);
    const value = flops.reduce((acc, flop) => {
      const index = Number(flop.id.slice(flop.id.lastIndexOf("_") + 1));
      return acc | ((state.get(flop.id) ?? 0) << index);
    }, 0);
    assert.equal(value, 0b101);
    assert.equal(mapDesign(shift, "std", "area").equiv.mismatches, 0);
  });

  it("selects a moving slice and unrolls generate", () => {
    const slice = parseVerilog(source("slice.v"));
    const pick = (a: number, base: number, width: number, up: boolean) => {
      let value = 0;
      for (let k = 0; k < width; k += 1) {
        const bit = up ? base + k : base - width + 1 + k;
        if (bit >= 0 && bit < 8) value |= ((a >> bit) & 1) << k;
      }
      return value;
    };
    for (let index = 0; index < 256; index += 1) {
      for (let s = 0; s < 8; s += 1) {
        const assign = bitsOf(index, s, "a", "s", 8);
        const values = evalNetlist(slice, assign);
        assert.equal(readBus(values, "y", 4), pick(index, s, 4, true), `up a=${index} s=${s}`);
        assert.equal(readBus(values, "z", 4), pick(index, 5, 4, false));
      }
    }
    assert.equal(mapDesign(slice, "std", "area").equiv.mismatches, 0);

    const ranged =
      parseVerilog(`module m(input [7:0] a, input [2:0] s, output [3:0] y, output [3:0] z);
      assign y = a[s+3:s];
      assign z = a[(s+3)-1:s];
    endmodule`);
    for (let index = 0; index < 256; index += 1) {
      for (let s = 0; s < 8; s += 1) {
        const assign = bitsOf(index, s, "a", "s", 8);
        const values = evalNetlist(ranged, assign);
        assert.equal(readBus(values, "y", 4), pick(index, s, 4, true), `range a=${index} s=${s}`);
        assert.equal(readBus(values, "z", 4), pick(index, s, 3, true));
      }
    }
    assert.equal(mapDesign(ranged, "std", "area").equiv.mismatches, 0);
    assert.throws(
      () =>
        parseVerilog(
          "module m(input [7:0] a, input [2:0] i, input [2:0] j, output [3:0] y); assign y = a[i:j]; endmodule",
        ),
      /constant/,
    );

    const packed = parseVerilog(`module m(input [7:0] a, output [7:0] y);
      integer i;
      always @* for (i = 0; i < 8; i = i + 2) y[i +: 2] = a[(6 - i) +: 2];
    endmodule`);
    for (let a = 0; a < 256; a += 4) {
      const values = evalNetlist(packed, bitsOf(a, 0, "a", "b", 8));
      const swapped =
        ((a & 3) << 6) | (((a >> 2) & 3) << 4) | (((a >> 4) & 3) << 2) | ((a >> 6) & 3);
      assert.equal(readBus(values, "y", 8), swapped);
    }

    const shift = parseVerilog(`module m(input clk, input [1:0] s, input [3:0] d, output [7:0] q);
      reg [7:0] r;
      always @(posedge clk) r[s +: 4] <= d;
      assign q = r;
    endmodule`);
    const flops = shift.gates.filter((gate) => gate.op === "DFF");
    assert.equal(flops.length, 8);
    let state = new Map(flops.map((flop) => [flop.id, 0 as 0 | 1]));
    const tick = (sel: number, data: number) => {
      const assign = new Map(state);
      for (let bit = 0; bit < 2; bit += 1) assign.set(`s_${bit}`, ((sel >> bit) & 1) === 1 ? 1 : 0);
      for (let bit = 0; bit < 4; bit += 1)
        assign.set(`d_${bit}`, ((data >> bit) & 1) === 1 ? 1 : 0);
      const values = evalNetlist(shift, assign);
      const next = new Map<string, 0 | 1>();
      for (const flop of flops) next.set(flop.id, values.get(flop.ins[0] ?? "0") ?? 0);
      state = next;
    };
    tick(1, 0b1111);
    const stored = flops.reduce(
      (acc, flop) =>
        acc | ((state.get(flop.id) ?? 0) << Number(flop.id.slice(flop.id.lastIndexOf("_") + 1))),
      0,
    );
    assert.equal(stored, 0b00011110);

    const word = parseVerilog(`module m(input [7:0] addr, input [511:0] data, output [31:0] y);
      assign y = data[(15 - (addr - 8'h80)) * 32 +: 32];
    endmodule`);
    const readWord = (addr: number, mark: number) => {
      const assign = new Map<string, 0 | 1>();
      for (let bit = 0; bit < 8; bit += 1)
        assign.set(`addr_${bit}`, ((addr >> bit) & 1) === 1 ? 1 : 0);
      for (let bit = 0; bit < 512; bit += 1)
        assign.set(`data_${bit}`, bit >= mark && bit < mark + 32 ? 1 : 0);
      return readBus(evalNetlist(word, assign), "y", 32);
    };
    assert.equal(readWord(0x80, 480) >>> 0, 0xffffffff);
    assert.equal(readWord(0x8f, 0) >>> 0, 0xffffffff);
    assert.equal(readWord(0x88, 224) >>> 0, 0xffffffff);
    assert.equal(readWord(0x88, 0), 0);

    const grow = parseVerilog(source("grow.v"));
    checkBus(grow, (a) => ~a & 15);
    assert.equal(mapDesign(grow, "std", "area").equiv.mismatches, 0);
    const chosen = parseVerilog(`module m #(parameter N = 1) (input a, b, output y);
      generate
        if (N > 1) begin
          assign y = a & b;
        end else begin
          assign y = a | b;
        end
      endgenerate
    endmodule`);
    assert.equal(
      evalNetlist(
        chosen,
        new Map([
          ["a", 1],
          ["b", 0],
        ]),
      ).get("y"),
      1,
    );
    assert.equal(
      evalNetlist(
        chosen,
        new Map([
          ["a", 0],
          ["b", 0],
        ]),
      ).get("y"),
      0,
    );
  });

  it("runs the macro, case, window, and fsm examples", () => {
    const wide = parseVerilog(source("macro.v"));
    assert.equal(wide.outputs.length, 4);
    checkBus(wide, (a) => ~a);
    assert.equal(mapDesign(wide, "std", "area").equiv.mismatches, 0);

    const decoded = parseVerilog(source("case.v"));
    const expect = (s: number, a: number) =>
      s === 0 ? a : s === 1 ? (a << 1) & 15 : s === 2 ? (a >> 1) | ((a & 1) << 3) : 0;
    for (let s = 0; s < 4; s += 1) {
      for (let a = 0; a < 16; a += 1) {
        const values = evalNetlist(decoded, bitsOf(a, s, "a", "s"));
        assert.equal(readBus(values, "y", 4), expect(s, a), `s=${s} a=${a}`);
      }
    }
    assert.equal(mapDesign(decoded, "std", "area").equiv.mismatches, 0);

    const window = parseVerilog(source("window.v"));
    for (let a = 0; a < 256; a += 1) {
      for (let i = 0; i < 4; i += 1) {
        const values = evalNetlist(window, bitsOf(a, i, "a", "i", 8));
        assert.equal(readBus(values, "y", 4), (a >> i) & 15, `a=${a} i=${i}`);
      }
    }
    assert.equal(mapDesign(window, "std", "area").equiv.mismatches, 0);

    const fsm = parseVerilog(source("fsm.v"));
    assert.equal(fsm.gates.filter((gate) => gate.op === "DFF").length, 3);
    assert.equal(mapDesign(fsm, "std", "area").equiv.mismatches, 0);
  });

  it("maps an 8-bit uart", () => {
    const netlist = parseVerilog(source("uart.v"));
    assert.equal(netlist.gates.filter((gate) => gate.op === "DFF").length, 41);
    const report = mapDesign(netlist, "std", "area");
    assert.equal(report.equiv.mismatches, 0);
    assert.equal(report.registers, 41);
    assert.ok(report.timing);
    assert.ok(report.risePath.length > 1);
    assert.ok(report.fallPath.length > 1);
  });

  it("reads a module through include", () => {
    const dir = mkdtempSync(join(tmpdir(), "sift-"));
    writeFileSync(
      join(dir, "leaf.v"),
      "module leaf(input a, output y);\n  assign y = ~a;\nendmodule\n",
    );
    writeFileSync(
      join(dir, "top.v"),
      '`include "leaf.v"\nmodule top(input a, output y);\n  leaf u(.a(a), .y(y));\nendmodule\n',
    );
    const read = (path: string) => readFileSync(path, "utf8");
    const netlist = parseVerilog(read(join(dir, "top.v")), { dir, read });
    assert.equal(evalNetlist(netlist, new Map([["a", 1]])).get("y"), 0);
    assert.equal(evalNetlist(netlist, new Map([["a", 0]])).get("y"), 1);
    assert.throws(
      () =>
        parseVerilog('`include "missing.v"\nmodule m(input a, output y);\nendmodule\n', {
          dir,
          read,
        }),
      /cannot read/,
    );
    writeFileSync(join(dir, "a.v"), '`include "b.v"\n');
    writeFileSync(join(dir, "b.v"), '`include "a.v"\n');
    assert.throws(() => parseVerilog(read(join(dir, "a.v")), { dir, read }), /cycle/);
  });

  it("expands define and ifdef, and keeps the module nothing instantiates", () => {
    const inverted = parseVerilog(
      "`define W 4\n`define NOT(x) (~(x))\nmodule m(input [`W-1:0] a, output [`W-1:0] y);\n  assign y = `NOT(a);\nendmodule\n",
    );
    assert.equal(inverted.outputs.length, 4);
    checkBus(inverted, (a) => ~a);
    const taken = parseVerilog(
      "`define USE\nmodule m(input a, output y);\n`ifdef USE\n  assign y = ~a;\n`else\n  this is not verilog\n`endif\nendmodule\n",
    );
    assert.equal(evalNetlist(taken, new Map([["a", 1]])).get("y"), 0);
    const other = parseVerilog(
      "module m(input a, output y);\n`ifdef MISSING\n  assign y = ~a;\n`elsif ALSO\n  assign y = ~a;\n`else\n  assign y = a;\n`endif\nendmodule\n",
    );
    assert.equal(evalNetlist(other, new Map([["a", 1]])).get("y"), 1);
    assert.throws(
      () => parseVerilog("module m(input a, output y);\n`ifdef USE\n  assign y = a;\nendmodule\n"),
      /endif/,
    );
    const text =
      "module top(input a, output y);\n  leaf u(.a(a), .y(y));\nendmodule\nmodule leaf(input a, output y);\n  assign y = ~a;\nendmodule\n";
    const both = parseVerilog(text);
    assert.equal(both.name, "top");
    assert.equal(evalNetlist(both, new Map([["a", 0]])).get("y"), 1);
    assert.equal(parseVerilog(text, { top: "leaf" }).name, "leaf");
    assert.throws(() => parseVerilog(text, { top: "nope" }), /unknown module/);
  });

  it("elaborates the 10-tap FIR and the dual-product FIR", () => {
    const pack = (into: Map<string, 0 | 1>, name: string, value: number, width: number) => {
      for (let bit = 0; bit < width; bit += 1)
        into.set(`${name}_${bit}`, ((value >> bit) & 1) === 1 ? 1 : 0);
    };
    const read = (values: ReadonlyMap<string, 0 | 1>, name: string, width: number) => {
      let value = 0;
      for (let bit = 0; bit < width; bit += 1)
        if (values.get(`${name}_${bit}`) === 1) value |= 1 << bit;
      return value;
    };
    const step = (
      net: ReturnType<typeof parseVerilog>,
      state: Map<string, 0 | 1>,
      rst: 0 | 1,
      load: 0 | 1,
      din: number,
    ) => {
      const inputs = new Map<string, 0 | 1>([
        ["rst", rst],
        ["load", load],
      ]);
      pack(inputs, "din", din, 8);
      const values = evalNetlist(net, new Map([...inputs, ...state]));
      const next = new Map<string, 0 | 1>();
      for (const flop of flopsOf(net)) next.set(flop.q, values.get(flop.d) ?? 0);
      return next;
    };
    for (const [id, flopCount, gates] of [
      ["fir10.v", 176, 6000],
      ["xfir.v", 176, 11000],
    ] as const) {
      const net = parseVerilog(design(id), { mode: "delay" });
      assert.equal(net.name, id.slice(0, -2));
      assert.ok(net.gates.length >= gates, `${id} gates ${net.gates.length}`);
      assert.ok((net.notes ?? []).includes("Wallace multiplier"));
      const flops = flopsOf(net);
      assert.equal(flops.length, flopCount);
      const cloud = comboCloud(net);
      assert.ok(cloud);
      assert.ok(cloud.inputs.length <= 1024, `${id} cloud inputs ${cloud.inputs.length}`);
      let state = new Map<string, 0 | 1>(flops.map((flop) => [flop.q, 1]));
      state = step(net, state, 1, 0, 0);
      assert.equal(read(state, "acc", 16), 0);
      state = step(net, state, 0, 1, 3);
      state = step(net, state, 0, 0, 5);
      state = step(net, state, 0, 0, 0);
      assert.equal(read(state, "acc", 16), 15);
    }
  });

  it("accepts localparam, logic, and wires through 32 bits", () => {
    const wide = parseVerilog("module m(input [16:0] a, output y); assign y = a[16]; endmodule");
    assert.equal(wide.inputs.includes("a_16"), true);
    const bits = new Map<string, 0 | 1>();
    for (let bit = 0; bit < 17; bit += 1) bits.set(`a_${bit}`, bit === 16 ? 1 : 0);
    assert.equal(evalNetlist(wide, bits).get("y"), 1);
    const hi = parseVerilog("module m(output [31:0] y); assign y = 32'h80000000; endmodule");
    const values = evalNetlist(hi, new Map());
    assert.equal(values.get("y_31"), 1);
    assert.equal(values.get("y_30"), 0);
    assert.equal(values.get("y_0"), 0);
    const sized = parseVerilog(
      "module m(input [31:0] a, output [31:0] y); assign y = ~a; endmodule",
    );
    assert.equal(sized.inputs.length, 32);
    assert.equal(sized.outputs.length, 32);

    const net = parseVerilog(`module m(
      input clk,
      input d,
      output logic [W-1:0] q,
      output logic y
    );
      localparam W = 8;
      logic [W-1:0] acc;
      logic n;
      assign n = d;
      assign y = n;
      always_ff @(posedge clk) begin
        acc <= acc + 1;
        q <= acc;
      end
    endmodule`);
    assert.equal(flopsOf(net).length, 16);
    const seeded = new Map<string, 0 | 1>([
      ["d", 1],
      ["clk", 0],
    ]);
    for (const flop of flopsOf(net)) seeded.set(flop.q, 0);
    assert.equal(evalNetlist(net, seeded).get("y"), 1);
    assert.equal(mapDesign(net, "std", "area").equiv.mismatches, 0);

    const generated = parseVerilog(`module m(input clk, input d, output logic q);
      generate
        always_ff @(posedge clk) q <= d;
      endgenerate
    endmodule`);
    assert.equal(flopsOf(generated).length, 1);

    const withParam = parseVerilog(
      "module m(input a, output y); parameter W = 1; assign y = a | W; endmodule",
    );
    assert.equal(evalNetlist(withParam, new Map([["a", 0]])).get("y"), 1);
    assert.throws(
      () =>
        parseVerilog(
          "module m(input a, output y); localparam A = 1; localparam A = 2; assign y = a; endmodule",
        ),
      /already defined/,
    );
    assert.throws(
      () =>
        parseVerilog(
          "module m(input clk, input logic d, output y); always_ff @(posedge clk) d <= 0; assign y = d; endmodule",
        ),
      /input cannot be a reg/,
    );
    assert.throws(
      () => parseVerilog("module m(input a, output reg logic y); assign y = a; endmodule"),
      /say reg or logic/,
    );
    assert.throws(
      () =>
        parseVerilog("module m(input a, output logic y); assign y = a; always @* y = a; endmodule"),
      /is a reg/,
    );
  });

  it("lowers a concat assign, an implicit wire, and translate_off", () => {
    const skipped = parseVerilog(`
      module m(input clk, output reg q);
        always @(posedge clk) q <= 1'b1;
        // synopsys translate_off
        reg [63:0] skipped;
        // synopsys translate_on
      endmodule
    `);
    assert.deepEqual(skipped.outputs, ["q"]);
    const alu = parseVerilog(`
      module m(input [3:0] a, input [3:0] b, output [3:0] y, output c);
        reg [3:0] y;
        reg c;
        always @* {c, y} <= {1'b0, a & b};
      endmodule
    `);
    const aluMap = mapDesign(alu, "std", "area");
    assert.equal(aluMap.equiv.mismatches, 0);
    for (const row of aluMap.equiv.rows) {
      let a = 0;
      let b = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        a |= inputBit(row.inputs, `a_${bit}`) << bit;
        b |= inputBit(row.inputs, `b_${bit}`) << bit;
      }
      assert.equal(busValue(row.outputs, "y"), a & b);
      assert.equal(outputBit(row.outputs, "c"), 0);
    }
    const wide = parseVerilog(`
      module m(input [4:0] wide, input sel, output [3:0] y);
        assign use = sel;
        assign y = use ? wide : 4'h0;
      endmodule
    `);
    const assign = new Map<string, 0 | 1>([
      ["sel", 1],
      ["wide_0", 1],
      ["wide_1", 0],
      ["wide_2", 1],
      ["wide_3", 0],
      ["wide_4", 1],
    ]);
    const values = evalNetlist(wide, assign);
    assert.equal(values.get("y_0"), 1);
    assert.equal(values.get("y_1"), 0);
    assert.equal(values.get("y_2"), 1);
    assert.equal(values.get("y_3"), 0);
  });

  it("maps an async set onto the sky130 preset flop", () => {
    const net = parseVerilog(`module m(input clk, rst, d, output reg q);
      always @(posedge clk or posedge rst) if (rst) q <= 1'b1; else q <= d;
    endmodule`);
    const report = mapDesign(net, sky130Hd(), "area");
    assert.match(report.verilog, /sky130_fd_sc_hd__dfstp_1/);
    assert.equal(report.equiv.mismatches, 0);
  });

  it("reads a memory word as a balanced one-hot", () => {
    const net = parseVerilog(
      "module m(input clk, input [1:0] a, input we, input [3:0] d, output [3:0] y); reg [3:0] mem[3:0]; always @(posedge clk) if (we) mem[a] <= d; assign y = mem[a]; endmodule\n",
    );
    const words = [0x1, 0xa, 0x5, 0xc];
    for (let addr = 0; addr < 4; addr += 1) {
      const assign = new Map<string, 0 | 1>([
        ["clk", 0],
        ["we", 0],
        ["a_0", (addr & 1) === 1 ? 1 : 0],
        ["a_1", (addr & 2) === 2 ? 1 : 0],
      ]);
      for (let bit = 0; bit < 4; bit += 1) assign.set(`d_${bit}`, 0);
      for (let word = 0; word < 4; word += 1) {
        for (let bit = 0; bit < 4; bit += 1) {
          assign.set(`mem_${word}_${bit}`, ((words[word] ?? 0) >> bit) & 1 ? 1 : 0);
        }
      }
      assert.equal(readBus(evalNetlist(net, assign), "y", 4), words[addr]);
    }
  });

  it("drops unread memory words and duplicate flops", () => {
    const mem = parseVerilog(`module m(input clk, input [3:0] a, input we, input d, output y);
      reg mem [0:15];
      always @(posedge clk) if (we && a[3]) mem[a] <= d;
      assign y = a[3] ? mem[a] : 1'b0;
    endmodule`);
    const memFlops = mem.gates.filter((gate) => gate.op === "DFF").map((gate) => gate.id);
    assert.deepEqual(
      memFlops,
      Array.from({ length: 8 }, (_, index) => `mem_${index + 8}_0`),
    );
    assert.match(mem.warnings?.join("\n") ?? "", /removed unread flop 'mem_0'/);
    assert.equal(mapDesign(mem, "std", "area").equiv.mismatches, 0);

    const copy = parseVerilog(`module m(input clk, input en, input d, output [3:0] q);
      reg [3:0] r;
      always @(posedge clk) if (en) r <= {4{d}};
      assign q = r;
    endmodule`);
    assert.equal(copy.gates.filter((gate) => gate.op === "DFF").length, 1);
    assert.match(copy.warnings?.join("\n") ?? "", /removed duplicate flop 'r_3'/);
    assert.equal(mapDesign(copy, "std", "area").equiv.mismatches, 0);

    const added = parseVerilog(`module m(input clk, input [3:0] a, input b, output [3:0] y);
      reg [3:0] r;
      always @(posedge clk) r <= {4{b}};
      assign y = a + r;
    endmodule`);
    const site = added.adders?.find((item) => item.b.some((pin) => pin.startsWith("r")));
    assert.ok(site);
    const live = new Set([...added.inputs, ...added.gates.map((gate) => gate.id), "0", "1"]);
    for (const pin of [...site.a, ...site.b, site.cin]) assert.ok(live.has(pin), pin);
    assert.equal(mapDesign(added, "std", "area").equiv.mismatches, 0);
  });
});

function busValue(row: { name: string; net: 0 | 1 }[], name: string, width = 4): number {
  let value = 0;
  for (let bit = 0; bit < width; bit += 1) value |= outputBit(row, `${name}_${bit}`) << bit;
  return value;
}

function bitsOf(a: number, b: number, aName = "a", bName = "b", width = 4): Map<string, 0 | 1> {
  const assign = new Map<string, 0 | 1>();
  for (let bit = 0; bit < width; bit += 1) {
    assign.set(`${aName}_${bit}`, ((a >> bit) & 1) === 1 ? 1 : 0);
    assign.set(`${bName}_${bit}`, ((b >> bit) & 1) === 1 ? 1 : 0);
  }
  return assign;
}

function readBus(values: ReadonlyMap<string, 0 | 1>, name: string, width: number): number {
  let value = 0;
  for (let bit = 0; bit < width; bit += 1) value |= (values.get(`${name}_${bit}`) ?? 0) << bit;
  return value;
}

function checkBus(
  netlist: ReturnType<typeof parseVerilog>,
  fn: (a: number, b: number) => number,
  width = 4,
): void {
  const space = width > 4 ? 32 : 256;
  for (let index = 0; index < space; index += 1) {
    const mask = (1 << width) - 1;
    const a = width > 4 ? (index * 17) & mask : index & 15;
    const b = width > 4 ? (index * 29) & mask : (index >> 4) & 15;
    const assign = bitsOf(a, b, "a", "b", width);
    const values = evalNetlist(netlist, assign);
    assert.equal(readBus(values, "y", width), fn(a, b) & ((1 << width) - 1), `a=${a} b=${b}`);
  }
}
