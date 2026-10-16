import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { proposeDesign } from "./propose.ts";
import { parseVerilog } from "./verilog.ts";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");

const XOR = `module m(input a, b, c, d, output y, z);
  assign y = a ^ b;
  assign z = c ^ d;
endmodule
`;

const AND4 = `module m(input a, b, c, d, e, f, g, h, output y, z);
  assign y = a & b & c & d;
  assign z = e & f & g & h;
endmodule
`;

const FLOP = `module m(input clk, input a, b, c, d, output reg y, z);
  always @(posedge clk) begin
    y <= a ^ b;
    z <= c ^ d;
  end
endmodule
`;

describe("cell proposals", () => {
  it("proposes the repeated xor cone and remaps it cheaper", () => {
    const netlist = parseVerilog(XOR);
    const report = proposeDesign(netlist, "min", "area");
    assert.equal(report.mismatches, 0);
    assert.ok(report.cells.length >= 1, "expected a proposed cell");
    const cell = report.cells[0];
    assert.ok(cell);
    assert.ok(cell.occurrences >= 2);
    assert.ok(cell.score > 0);
    assert.ok(cell.ands >= 3 && cell.ands <= 8);
    assert.ok(
      report.after.area < report.before.area,
      `${report.after.area} vs ${report.before.area}`,
    );
    assert.ok(report.used.some((item) => item.count >= 2));
    assert.match(report.mapped.verilog, /prop0/);
  });

  it("drops the xor cone when the library already has an NPN match", () => {
    const netlist = parseVerilog(XOR);
    const report = proposeDesign(netlist, "std", "area");
    assert.equal(report.mismatches, 0);
    assert.equal(report.cells.length, 0);
    assert.ok(report.skippedNpn >= 1);
    assert.equal(report.after.area, report.before.area);
  });

  it("proposes a 4-input and that min cannot cover in one cell", () => {
    const netlist = parseVerilog(AND4);
    const report = proposeDesign(netlist, "min", "area");
    assert.equal(report.mismatches, 0);
    assert.equal(report.mapped.equiv.exhaustive, true);
    assert.ok(report.cells.some((cell) => cell.pins === 4 && cell.occurrences >= 2));
    assert.ok(report.after.area < report.before.area);
  });

  it("mines the combo cloud of a sequential design", () => {
    const netlist = parseVerilog(FLOP);
    const report = proposeDesign(netlist, "min", "area");
    assert.equal(report.mismatches, 0);
    assert.ok(report.used.some((item) => item.count >= 2));
    assert.ok(report.after.area < report.before.area);
  });

  it("drops a 4-input and when NAND4 is already in the library", () => {
    const netlist = parseVerilog(AND4);
    const report = proposeDesign(netlist, "std", "area");
    assert.equal(report.mismatches, 0);
    assert.equal(report.cells.length, 0);
    assert.ok(report.skippedNpn >= 1);
  });

  it("prints the proposal from the cli", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "-", "--lib", "min", "--propose", "4"],
      {
        input: XOR,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /prop0/);
    assert.match(result.stdout, /before/);
    assert.match(result.stdout, /delta/);
    assert.match(result.stdout, /cost/);
  });
});
