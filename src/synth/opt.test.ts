import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { optimizeDesign, type OptPins, type OptRecipe } from "./opt.ts";
import { parseSources } from "./verilog.ts";

const open: OptPins = {
  mode: false,
  arith: false,
  ppa: false,
  gate: false,
  recover: false,
  maxFanout: false,
};

const start: OptRecipe = { mode: "area", arith: "area", gate: false, recover: false };

function load(text: string, arith: "area" | "delay" = "area") {
  return parseSources([{ text, dir: "/tmp" }], { mode: arith });
}

const WORD = `module m(input clk, input en, output reg [7:0] q);
  always @(posedge clk) if (en) q <= q + 1;
endmodule
`;

const ADD = `module m(input clk, input [7:0] a, input [7:0] b, output reg [7:0] y);
  always @(posedge clk) y <= a + b;
endmodule
`;

describe("opt", () => {
  it("clock-gates a word when area is the objective", () => {
    const netlist = load(WORD);
    const result = optimizeDesign({
      netlist,
      library: "std",
      goal: "area",
      constraints: { period: 40 },
      pins: open,
      recipe: start,
      elaborate: (arith) => load(WORD, arith),
    });
    const first = result.trials[0];
    assert.ok(first);
    assert.equal(result.recipe.gate, true);
    assert.ok(result.report.area < first.area - 0.05);
    assert.ok((result.report.timing?.slack ?? -1) >= 0);
    assert.equal(result.report.equiv.mismatches, 0);
    assert.ok(result.trials.length <= 8);
  });

  it("keeps the area recipe when the period is already loose", () => {
    const netlist = load(ADD);
    const result = optimizeDesign({
      netlist,
      library: "std",
      goal: "area",
      constraints: { period: 40 },
      pins: open,
      recipe: start,
      elaborate: (arith) => load(ADD, arith),
    });
    assert.equal(result.recipe.mode, "area");
    assert.equal(result.recipe.arith, "area");
    assert.ok(result.report.area <= (result.trials[0]?.area ?? 0) + 0.05);
    assert.ok((result.report.timing?.slack ?? -1) >= 0);
    assert.ok(
      result.trials.every((trial) => trial.because !== "adder bias toward area"),
      result.trials.map((trial) => trial.because).join(", "),
    );
  });

  it("switches to faster arithmetic when slack is the objective", () => {
    const netlist = load(ADD);
    const result = optimizeDesign({
      netlist,
      library: "std",
      goal: "delay",
      constraints: { period: 40 },
      pins: open,
      recipe: start,
      elaborate: (arith) => load(ADD, arith),
    });
    const first = result.trials[0];
    assert.ok(first?.slack !== null && first.slack !== undefined);
    assert.ok((result.report.timing?.slack ?? 0) > first.slack + 0.01);
    assert.ok(result.recipe.arith === "delay" || result.recipe.ppa === 1);
  });

  it("does not move a knob the user set", () => {
    const netlist = load(ADD);
    const result = optimizeDesign({
      netlist,
      library: "std",
      goal: "delay",
      constraints: { period: 40 },
      pins: { ...open, mode: true },
      recipe: start,
      elaborate: (arith) => load(ADD, arith),
    });
    assert.equal(result.recipe.mode, "area");
    assert.ok(result.trials.every((trial) => trial.recipe.mode === "area"));
  });
});
