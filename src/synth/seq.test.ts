import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXAMPLES, VERILOG } from "./examples.ts";
import { insertClockGates } from "./clkgate.ts";
import { STD_LIBRARY } from "./library.ts";
import { NetlistError, parseNetlist } from "./netlist.ts";
import { mapDesign } from "./seq.ts";
import { sky130Hd } from "./sky130hd.ts";
import { loadDesign } from "./verilog.ts";
import { parseLiberty } from "./liberty.ts";

function example(id: string) {
  const found = EXAMPLES.find((item) => item.id === id);
  assert.ok(found);
  return found;
}

describe("registers", () => {
  it("maps the full adder in both modes", () => {
    const adder = example("full-adder");
    for (const library of ["min", "std"] as const) {
      for (const mode of ["area", "delay"] as const) {
        const report = mapDesign(adder.netlist, library, mode);
        assert.equal(report.registers, 0);
        assert.equal(report.equiv.mismatches, 0);
      }
    }
    const std = mapDesign(adder.netlist, "std", "area");
    assert.ok(std.cells.includes("XOR2_1"));
  });

  it("keeps a DFF as a register and delays d by one clock", () => {
    const report = mapDesign(example("flop").netlist, "std", "delay");
    assert.equal(report.registers, 1);
    assert.deepEqual(report.cells, ["DFF_1"]);
    assert.equal(report.area, 6);
    assert.match(report.verilog, /DFF_1 ff_q \(q, d, clk\);/);
    assert.equal(report.equiv.mismatches, 0);
    assert.equal(report.equiv.exhaustive, false);
    const q = report.cycles.map((row) => row.outputs[0]?.net);
    const d = report.cycles.map((row) => row.inputs[0]?.value);
    assert.deepEqual(d.slice(0, 4), [0, 1, 0, 1]);
    assert.deepEqual(q.slice(0, 4), [0, 0, 1, 0]);
  });

  it("upsizes a flip-flop only when the small drive misses", () => {
    const pair = {
      name: "pair",
      inputs: [],
      outputs: ["q"],
      gates: [
        { id: "q", op: "DFF" as const, ins: ["a"] },
        { id: "a", op: "DFF" as const, ins: ["q"] },
      ],
    };
    const tight = mapDesign(pair, "std", "delay", { period: 2.5 });
    assert.equal(tight.equiv.mismatches, 0);
    assert.ok(tight.timing);
    assert.ok(tight.timing.slack >= -1e-9);
    assert.ok(tight.cells.every((cell) => cell === "DFF_2" || cell === "DFF_4"));
    const loose = mapDesign(pair, "std", "delay", { period: 10 });
    assert.ok(loose.cells.every((cell) => cell === "DFF_1"));
    const area = mapDesign(pair, "std", "area", { period: 2.5 });
    assert.ok(area.cells.every((cell) => cell === "DFF_1"));
    assert.equal(area.timing?.met, false);
  });

  it("upsizes a flip-flop whose Q slew is over the limit", () => {
    const library = parseLiberty(`library (slew) {
      cell (INVX1) {
        area : 1;
        pin (A) { direction : input; capacitance : 0.01; }
        pin (Y) {
          direction : output;
          function : "!A";
          timing () {
            related_pin : "A";
            cell_rise (d) { index_1 ("0.01"); index_2 ("0.01"); values ("0.05"); }
            cell_fall (d) { index_1 ("0.01"); index_2 ("0.01"); values ("0.05"); }
          }
        }
      }
      cell (DFF_1) {
        area : 6;
        ff (IQ, IQN) { next_state : "D"; clocked_on : "CK"; }
        pin (CK) { direction : input; clock : true; capacitance : 0.001; }
        pin (D) {
          direction : input;
          capacitance : 0.001;
          timing () { related_pin : "CK"; timing_type : setup_rising; intrinsic_rise : 0.05; intrinsic_fall : 0.05; }
        }
        pin (Q) {
          direction : output;
          max_capacitance : 1;
          max_transition : 0.2;
          function : "IQ";
          timing () {
            related_pin : "CK";
            timing_type : rising_edge;
            cell_rise (d) { index_1 ("0.01"); index_2 ("0.01"); values ("0.2"); }
            cell_fall (d) { index_1 ("0.01"); index_2 ("0.01"); values ("0.2"); }
            rise_transition (d) { index_1 ("0.01"); index_2 ("0.01"); values ("0.8"); }
            fall_transition (d) { index_1 ("0.01"); index_2 ("0.01"); values ("0.8"); }
          }
        }
      }
      cell (DFF_2) {
        area : 10;
        ff (IQ, IQN) { next_state : "D"; clocked_on : "CK"; }
        pin (CK) { direction : input; clock : true; capacitance : 0.001; }
        pin (D) {
          direction : input;
          capacitance : 0.001;
          timing () { related_pin : "CK"; timing_type : setup_rising; intrinsic_rise : 0.05; intrinsic_fall : 0.05; }
        }
        pin (Q) {
          direction : output;
          max_capacitance : 1;
          max_transition : 0.2;
          function : "IQ";
          timing () {
            related_pin : "CK";
            timing_type : rising_edge;
            cell_rise (d) { index_1 ("0.01"); index_2 ("0.01"); values ("0.1"); }
            cell_fall (d) { index_1 ("0.01"); index_2 ("0.01"); values ("0.1"); }
            rise_transition (d) { index_1 ("0.01"); index_2 ("0.01"); values ("0.05"); }
            fall_transition (d) { index_1 ("0.01"); index_2 ("0.01"); values ("0.05"); }
          }
        }
      }
    }`);
    const flop = {
      name: "one",
      inputs: ["d"],
      outputs: ["q"],
      gates: [{ id: "q", op: "DFF" as const, ins: ["d"] }],
    };
    const sized = mapDesign(flop, library, "load", { period: 10, wireLoad: "none" });
    assert.equal(sized.equiv.mismatches, 0);
    assert.ok(sized.cells.includes("DFF_2"));
    assert.equal(
      sized.over.some((hit) => hit.maxTran !== null && (hit.slew ?? 0) > hit.maxTran),
      false,
    );
    const area = mapDesign(flop, library, "area", { period: 10, wireLoad: "none" });
    assert.ok(area.cells.includes("DFF_2"));
    assert.equal(
      area.over.some((hit) => hit.maxTran !== null && (hit.slew ?? 0) > hit.maxTran),
      false,
    );
  });

  it("buffers an async reset so the reset net meets max transition", () => {
    const wide = loadDesign(`module m(input clk, rst, d, output reg [79:0] q);
      always @(posedge clk or posedge rst) if (rst) q <= 0; else q <= d;
    endmodule`);
    const report = mapDesign(wide, sky130Hd(), "area", { period: 10, wireLoad: "none" });
    assert.equal(report.equiv.mismatches, 0);
    assert.equal(
      report.over.some((hit) => hit.maxTran !== null && (hit.slew ?? 0) > hit.maxTran),
      false,
    );
    assert.match(report.verilog, /buf_/);
  });

  it("counts on the clock and maps only the cloud between flops", () => {
    const report = mapDesign(example("counter").netlist, "std", "area");
    assert.equal(report.registers, 2);
    assert.equal(report.equiv.mismatches, 0);
    assert.deepEqual(
      report.cycles.slice(0, 5).map((row) => row.outputs.map((output) => output.net)),
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
        [0, 0],
      ],
    );
    assert.ok(report.cells.includes("XOR2_1"));
    assert.ok(report.cells.includes("INV_1"));
    assert.equal(report.cells.filter((cell) => cell === "DFF_1").length, 2);
    assert.match(report.verilog, /DFF_1 ff_q0 \(q0, d0, clk\);/);
    assert.match(report.verilog, /DFF_1 ff_q1 \(q1, d1, clk\);/);
    assert.doesNotMatch(report.verilog, /DFF_1 ff_q0 \(q0, q0/);
  });

  it("accepts a loop through a flop and still rejects a combinational cycle", () => {
    parseNetlist(example("counter").netlist);
    assert.throws(
      () =>
        parseNetlist({
          name: "loop",
          inputs: ["a"],
          outputs: ["y"],
          gates: [
            { id: "y", op: "AND", ins: ["a", "z"] },
            { id: "z", op: "OR", ins: ["y", "a"] },
          ],
        }),
      NetlistError,
    );
  });

  it("offers a flip-flop at three drives", () => {
    const names = new Set(STD_LIBRARY.flops.map((cell) => cell.name));
    for (const family of ["DFF", "ADFF"]) {
      for (const drive of [1, 2, 4]) assert.ok(names.has(`${family}_${drive}`));
    }
  });

  it("misses a tight period and meets a loose one without remapping", () => {
    const netlist = example("counter").netlist;
    const probe = mapDesign(netlist, "std", "area", 10);
    assert.ok(probe.timing);
    assert.equal(
      probe.timing.slack,
      Number((probe.timing.period - probe.timing.setup - probe.timing.arrival).toFixed(3)),
    );
    const edge = probe.timing.arrival + probe.timing.setup;
    const meet = mapDesign(netlist, "std", "area", edge);
    const miss = mapDesign(netlist, "std", "area", edge - 1);
    assert.equal(meet.timing?.met, true);
    assert.equal(meet.timing?.slack, 0);
    assert.equal(miss.timing?.met, false);
    assert.ok((miss.timing?.slack ?? 0) < 0);
    assert.deepEqual(meet.cells, miss.cells);
    assert.equal(meet.verilog, miss.verilog);
    assert.equal(meet.cells.filter((cell) => cell === "DFF_1").length, 2);
    assert.equal(mapDesign(example("and4").netlist, "std", "area", 1).timing, null);
    const held = mapDesign(example("flop").netlist, "std", "area", 10);
    const early = mapDesign(example("flop").netlist, "std", "area", 0);
    assert.equal(held.timing?.met, true);
    assert.equal(early.timing?.met, false);
    assert.deepEqual(held.cells, early.cells);
  });

  it("subtracts clock uncertainty from setup and hold slack", () => {
    const flop = example("flop").netlist;
    const plain = mapDesign(flop, "std", "area", { period: 10 });
    const shifted = mapDesign(flop, "std", "area", {
      period: 10,
      setupUncertainty: 0.4,
      holdUncertainty: 0.25,
    });
    assert.ok(plain.timing && shifted.timing);
    assert.equal(shifted.timing.slack, Number((plain.timing.slack - 0.4).toFixed(3)));
    assert.equal(shifted.timing.holdSlack, Number((plain.timing.holdSlack - 0.25).toFixed(3)));
    assert.equal(shifted.timing.setupUncertainty, 0.4);
    assert.equal(shifted.timing.holdUncertainty, 0.25);
    assert.deepEqual(shifted.cells, plain.cells);
  });

  it("multiplies the setup period and shifts hold by a cycle", () => {
    const flop = example("flop").netlist;
    const plain = mapDesign(flop, "std", "area", { period: 10 });
    const setup = mapDesign(flop, "std", "area", {
      period: 10,
      multiCycles: [{ from: null, to: null, setup: 2, hold: null }],
    });
    assert.ok(plain.timing && setup.timing);
    assert.equal(setup.timing.slack, Number((plain.timing.slack + plain.timing.period).toFixed(3)));
    assert.equal(setup.timing.holdSlack, plain.timing.holdSlack);
    assert.equal(setup.timing.setupCycles, 2);
    assert.equal(setup.timing.holdCycles, 0);
    assert.deepEqual(setup.cells, plain.cells);
    const both = mapDesign(flop, "std", "area", {
      period: 10,
      multiCycles: [
        { from: null, to: null, setup: 2, hold: null },
        { from: null, to: null, setup: null, hold: 1 },
      ],
    });
    assert.ok(both.timing);
    assert.equal(both.timing.slack, Number((plain.timing.slack + plain.timing.period).toFixed(3)));
    assert.equal(
      both.timing.holdSlack,
      Number((plain.timing.holdSlack - plain.timing.period).toFixed(3)),
    );
    assert.equal(both.timing.setupCycles, 2);
    assert.equal(both.timing.holdCycles, 1);
    assert.deepEqual(both.cells, plain.cells);
  });

  it("applies input delay, output delay, and output load", () => {
    const flop = example("flop").netlist;
    const late = mapDesign(flop, "std", "area", { period: 10, inputDelay: 3 });
    assert.equal(late.timing?.endpoint, "d");
    assert.equal(late.timing?.arrival, 3);
    assert.equal(late.timing?.slack, 6);
    const out = mapDesign(flop, "std", "area", { period: 10, outputDelay: 5 });
    assert.equal(out.timing?.endpoint, "q");
    assert.equal(out.timing?.slack, 3);
    const loaded = mapDesign(example("and4").netlist, "std", "load", {
      period: 10,
      outputLoad: 8,
      inputDelay: 1,
    });
    const plain = mapDesign(example("and4").netlist, "std", "load", 10);
    assert.ok(loaded.delay > plain.delay);
    assert.equal(loaded.risePath[0]?.at, (plain.risePath[0]?.at ?? 0) + 1);
  });

  it("keeps a per-port delay, a hold check, and an ideal clock", () => {
    const flop = example("flop").netlist;
    const late = mapDesign(flop, "std", "area", { period: 10, ports: { d: { delay: 3 } } });
    assert.equal(late.timing?.arrival, 3);
    assert.equal(late.timing?.slack, 6);
    assert.equal(late.timing?.holdMet, true);
    const flops = Array.from({ length: 20 }, (_, index) => ({
      id: `q${index}`,
      op: "DFF" as const,
      ins: [`d${index}`],
    }));
    const wide = mapDesign(
      {
        name: "wideclk",
        inputs: flops.map((gate) => gate.ins[0] ?? ""),
        outputs: flops.map((gate) => gate.id),
        gates: flops,
      },
      "std",
      "area",
    );
    assert.equal(wide.equiv.mismatches, 0);
    assert.equal(wide.cells.filter((cell) => cell.startsWith("BUF_")).length, 0);
    assert.equal(wide.timing?.clockLatency, 0);
    assert.equal(
      wide.timing?.slack,
      Number(
        (
          (wide.timing?.period ?? 0) -
          (wide.timing?.setup ?? 0) -
          (wide.timing?.arrival ?? 0)
        ).toFixed(3),
      ),
    );
    const plain = mapDesign(example("and4").netlist, "std", "load", 10);
    const wired = mapDesign(example("and4").netlist, "std", "load", {
      period: 10,
      capPerFanout: 1,
    });
    assert.ok(wired.delay > plain.delay);
  });

  it("drops a false path from setup without dropping hold", () => {
    const design = {
      name: "pair",
      inputs: ["a", "b"],
      outputs: ["q0", "q1"],
      gates: [
        { id: "q0", op: "DFF" as const, ins: ["a"] },
        { id: "q1", op: "DFF" as const, ins: ["b"] },
      ],
    };
    const ports = { a: { delay: 4 }, b: { delay: 6 } };
    const plain = mapDesign(design, "std", "area", { period: 10, ports });
    assert.equal(plain.timing?.endpoint, "b");
    assert.equal(plain.timing?.holdEndpoint, "q0/D");
    const setup = mapDesign(design, "std", "area", {
      period: 10,
      ports,
      falsePaths: [{ from: null, to: { kind: "pins", names: ["q1/D"] }, setup: true, hold: false }],
    });
    assert.equal(setup.timing?.endpoint, "a");
    assert.equal(setup.timing?.holdEndpoint, "q0/D");
    const hold = mapDesign(design, "std", "area", {
      period: 10,
      ports,
      falsePaths: [{ from: null, to: { kind: "pins", names: ["q0/D"] }, setup: false, hold: true }],
    });
    assert.equal(hold.timing?.endpoint, "b");
    assert.equal(hold.timing?.holdEndpoint, "q1/D");
    const none = mapDesign(design, "std", "area", {
      period: 10,
      ports,
      falsePaths: [
        { from: { kind: "inputs", names: [] }, to: null, setup: true, hold: true },
        { from: { kind: "registers", names: [] }, to: null, setup: true, hold: true },
      ],
    });
    assert.equal(none.timing?.constrained, false);
    assert.equal(none.timing?.holdConstrained, false);
    assert.deepEqual(none.cells, plain.cells);
  });
});

const EN = VERILOG.find((item) => item.id === "en.v")?.source ?? "";
const WIDE = `module fan (
  input clk,
  input a, b,
  output reg y0, y1, y2, y3
);
  always @(posedge clk) begin
    y0 <= a & b;
    y1 <= a & b;
    y2 <= a & b;
    y3 <= a & b;
  end
endmodule
`;

describe("area recovery and clock gates", () => {
  it("spends slack on a smaller drive and stays within the constraint", () => {
    const netlist = loadDesign(WIDE);
    const plain = mapDesign(netlist, "std", "delay", { period: 40 });
    const recovered = mapDesign(netlist, "std", "delay", { period: 40, recover: true });
    assert.ok(plain.timing && recovered.timing && recovered.recovery);
    assert.ok(recovered.area < plain.area);
    assert.equal(recovered.recovery.before, plain.area);
    assert.equal(recovered.recovery.after, recovered.area);
    assert.ok(recovered.recovery.steps > 0);
    assert.ok(recovered.timing.slack >= -1e-9);
    assert.ok(recovered.timing.holdSlack >= -1e-9);
    assert.equal(recovered.equiv.mismatches, 0);
    assert.ok(recovered.timing.slack <= plain.timing.slack + 1e-9);
  });

  it("does not spend slack the design does not have", () => {
    const netlist = loadDesign(WIDE);
    const loose = mapDesign(netlist, "std", "delay", { period: 40 });
    assert.ok(loose.timing);
    const tight = mapDesign(netlist, "std", "delay", {
      period: Math.max(0, loose.timing.arrival + loose.timing.setup - 1),
      recover: true,
    });
    assert.ok(tight.timing && tight.recovery);
    assert.equal(tight.timing.met, false);
    assert.equal(tight.recovery.steps, 0);
    assert.equal(
      tight.area,
      mapDesign(netlist, "std", "delay", { period: tight.timing.period }).area,
    );
  });

  it("replaces a shared enable mux with one clock gate and keeps the trace", () => {
    const netlist = loadDesign(EN);
    const plain = mapDesign(netlist, "std", "area", { period: 20 });
    const gated = mapDesign(netlist, "std", "area", { period: 20, clockGate: true });
    assert.equal(gated.equiv.mismatches, 0);
    assert.equal(gated.registers, 4);
    assert.ok(gated.clockGates);
    assert.equal(gated.clockGates.length, 1);
    assert.equal(gated.clockGates[0]?.flops.length, 4);
    assert.equal(gated.clockGates[0]?.level, 1);
    assert.equal(gated.cells.filter((cell) => cell === "LATCH").length, 1);
    assert.match(gated.verilog, /LATCH /);
    assert.doesNotMatch(gated.verilog, /ff_q_\d \([^)]*clk\)/);
    assert.equal(gated.cycles.length, plain.cycles.length);
    gated.cycles.forEach((row, index) => {
      assert.deepEqual(
        row.outputs.map((output) => output.net),
        plain.cycles[index]?.outputs.map((output) => output.net),
      );
      assert.equal(row.match, true);
    });
  });

  it("clock-gates an active-low enable and an async reset", () => {
    const low = loadDesign(
      "module m(input clk, input en, input d, output reg q); always @(posedge clk) if (!en) q <= d; endmodule\n",
    );
    const gated = mapDesign(low, "std", "area", { period: 10, clockGate: true });
    const plain = mapDesign(low, "std", "area");
    assert.equal(gated.clockGates?.length, 1);
    assert.equal(gated.equiv.mismatches, 0);
    assert.deepEqual(
      gated.cycles.map((row) => row.outputs.map((output) => output.net)),
      plain.cycles.map((row) => row.outputs.map((output) => output.net)),
    );
    const reset = loadDesign(
      "module m(input clk, input rst, input en, input d, output reg q); always @(posedge clk or posedge rst) if (rst) q <= 0; else if (en) q <= d; endmodule\n",
    );
    const cleared = mapDesign(reset, "std", "area", { period: 10, clockGate: true });
    const uncleared = mapDesign(reset, "std", "area");
    assert.equal(cleared.equiv.mismatches, 0);
    assert.match(cleared.verilog, /ADFF_1|ADFF /);
    assert.deepEqual(
      cleared.cycles.map((row) => row.outputs[0]?.net),
      uncleared.cycles.map((row) => row.outputs[0]?.net),
    );
  });

  it("clock-gates a nested enable and a whole memory word", () => {
    const byte = loadDesign(
      "module m(input clk, input ce, input we, input [3:0] d, output reg [3:0] q); always @(posedge clk) if (ce) if (we) q <= d; endmodule\n",
    );
    const gatedByte = insertClockGates(byte, STD_LIBRARY, "area");
    assert.ok(gatedByte);
    assert.equal(gatedByte.clockGates?.length, 1);
    assert.equal(gatedByte.clockGates?.[0]?.flops.length, 4);
    assert.equal(gatedByte.clockGates?.[0]?.level, 1);
    assert.equal(gatedByte.gates.filter((gate) => gate.op === "MUX").length, 0);
    const mappedByte = mapDesign(byte, "std", "area", { period: 10, clockGate: true });
    const plainByte = mapDesign(byte, "std", "area");
    assert.equal(mappedByte.equiv.mismatches, 0);
    assert.equal(mappedByte.clockGates?.length, 1);
    assert.deepEqual(
      mappedByte.cycles.map((row) => row.outputs.map((output) => output.net)),
      plainByte.cycles.map((row) => row.outputs.map((output) => output.net)),
    );

    const mem = loadDesign(
      "module m(input clk, input ce, input we, input a, input [3:0] d, output [3:0] q); reg [3:0] mem[1:0]; always @(posedge clk) if (ce) if (we) mem[a] <= d; assign q = mem[a]; endmodule\n",
    );
    const gatedMem = insertClockGates(mem, STD_LIBRARY, "area");
    assert.ok(gatedMem?.clockGates);
    assert.equal(gatedMem.clockGates.length, 2);
    assert.ok(gatedMem.clockGates.every((gate) => gate.flops.length === 4));
    assert.ok(gatedMem.clockGates.every((gate) => gate.level === 1));
    const byId = new Map(gatedMem.gates.map((gate) => [gate.id, gate]));
    for (const flop of gatedMem.gates.filter((gate) => gate.op === "DFF")) {
      const data = flop.ins[0] ?? "";
      assert.equal(byId.get(data), undefined, data);
      assert.match(data, /^d_/);
    }
    const mappedMem = mapDesign(mem, "std", "area", { period: 10, clockGate: true });
    const plainMem = mapDesign(mem, "std", "area");
    assert.equal(mappedMem.equiv.mismatches, 0);
    assert.equal(mappedMem.clockGates?.length, 2);
    assert.deepEqual(
      mappedMem.cycles.map((row) => row.outputs.map((output) => output.net)),
      plainMem.cycles.map((row) => row.outputs.map((output) => output.net)),
    );

    const added = loadDesign(
      "module m(input clk, input ce, input we, input [7:0] a, b, output reg [7:0] y); always @(posedge clk) if (ce) if (we) y <= a + b; endmodule\n",
      "delay",
    );
    const gatedAdd = mapDesign(added, "std", "area", { period: 40, clockGate: true });
    const plainAdd = mapDesign(added, "std", "area", { period: 40 });
    assert.equal(gatedAdd.equiv.mismatches, 0);
    assert.equal(gatedAdd.clockGates?.length, 1);
    assert.equal(gatedAdd.clockGates?.[0]?.flops.length, 8);
    assert.deepEqual(
      gatedAdd.cycles.map((row) => row.outputs.map((output) => output.net)),
      plainAdd.cycles.map((row) => row.outputs.map((output) => output.net)),
    );
  });

  it("simulates a clock-gated constant tied to 1'b0", () => {
    const netlist = loadDesign(
      "module m(input clk, input en, input d, output reg q); always @(posedge clk) if (en) q <= d & 1'b0; endmodule\n",
    );
    const gated = mapDesign(netlist, sky130Hd(), "area", {
      period: 10,
      maxFanout: 9,
      clockGate: true,
    });
    assert.equal(gated.equiv.mismatches, 0);
    assert.equal(gated.clockGates?.length, 1);
  });
});
