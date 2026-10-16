import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { critDesign } from "./crit.ts";
import { parseVerilog } from "./verilog.ts";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");

const ANDS = `module m(input clk, input a, b, c, d, e, f, g, h, output reg y);
  always @(posedge clk) y <= a & b & c & d & e & f & g & h;
endmodule
`;

const FANOUT = `module m(input clk, input a, input [15:0] b, output reg [15:0] y);
  wire n;
  assign n = ~a;
  always @(posedge clk) y <= {16{n}} & b;
endmodule
`;

const ADDER = `module m(input clk, input [3:0] a, b, output reg [3:0] y);
  always @(posedge clk) y <= a + b;
endmodule
`;

describe("critical path cells", () => {
  it("replaces a late and-chain with one cell", () => {
    const report = critDesign(parseVerilog(ANDS), "min", "delay", 10);
    assert.equal(report.mismatches, 0);
    assert.equal(report.reason, "cell");
    assert.ok(report.stretch);
    assert.ok(report.stretch.saved > 0);
    assert.ok(report.used >= 1);
    assert.ok(
      report.delayAfter < report.delayBefore,
      `${report.delayAfter} vs ${report.delayBefore}`,
    );
    const before = report.slackBefore ?? 0;
    const after = report.slackAfter ?? 0;
    assert.ok(after > before, `slack ${before} -> ${after}`);
    assert.match(report.mapped.verilog, /crit0/);
  });

  it("does not invent a cell for a buffer path", () => {
    const report = critDesign(parseVerilog(FANOUT), "std", "delay", { period: 10, maxFanout: 2 });
    assert.equal(report.mismatches, 0);
    assert.equal(report.reason, "buffer");
    assert.equal(report.stretch, null);
    assert.equal(report.used, 0);
    assert.equal(report.delayAfter, report.delayBefore);
  });

  it("points at the adder instead of a new cell", () => {
    const report = critDesign(parseVerilog(ADDER), "std", "delay", 10);
    assert.equal(report.mismatches, 0);
    assert.equal(report.reason, "adder");
    assert.match(report.note, /ripple/);
    assert.equal(report.stretch, null);
    assert.equal(report.used, 0);
  });

  it("prints the critical report from the cli", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "-", "--lib", "min", "--mode", "delay", "--crit"],
      {
        input: ANDS,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /critical {2}cell/);
    assert.match(result.stdout, /crit0/);
    assert.match(result.stdout, /slack/);
  });
});
