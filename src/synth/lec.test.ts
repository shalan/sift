import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { VERILOG } from "./examples.ts";
import { checkEquivalence } from "./lec.ts";
import { STD_LIBRARY } from "./library.ts";
import { mapDesign } from "./seq.ts";
import { sky130Hd } from "./sky130hd.ts";
import { parseVerilog } from "./verilog.ts";

function yosysAvailable(): boolean {
  const fromEnv = process.env.YOSYS;
  if (fromEnv && existsSync(fromEnv)) return true;
  if (existsSync("/tmp/oss/oss-cad-suite/bin/yosys")) return true;
  return spawnSync("yosys", ["-V"], { encoding: "utf8" }).status === 0;
}

function writeVerilog(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

describe("liberty reset pins", () => {
  it("inverts an active-high reset onto Sky130 RESET_B", () => {
    const source = VERILOG.find((item) => item.id === "async.v");
    assert.ok(source);
    const flop = sky130Hd().flops.find((cell) => cell.name === "sky130_fd_sc_hd__dfrtp_1");
    assert.equal(flop?.seq?.q, "Q");
    assert.equal(flop?.seq?.clk, "CLK");
    assert.equal(flop?.seq?.clear, "RESET_B");
    assert.equal(flop?.seq?.clearLevel, 0);
    const report = mapDesign(parseVerilog(source.source), sky130Hd(), "area");
    assert.equal(report.equiv.mismatches, 0);
    assert.match(report.verilog, /sky130_fd_sc_hd__dfrtp_1/);
    assert.match(report.verilog, /\.RESET_B\(_rstn_rst\)/);
    assert.match(report.verilog, /\.CLK\(clk\)/);
    assert.doesNotMatch(report.verilog, /1'b0/);
    assert.equal(report.verilog.split("(_rstn_rst, rst)").length - 1, 1);
  });
});

describe("yosys lec", { skip: yosysAvailable() ? false : "Yosys is not installed" }, () => {
  it("proves combinational, bus, and sequential netlists, and rejects a wrong one", () => {
    const dir = mkdtempSync(join(tmpdir(), "sift-lec-test-"));
    const cases = [
      "module m(input a, b, output y); assign y = a & b; endmodule\n",
      "module add4(input [3:0] a, b, output [3:0] y); assign y = a + b; endmodule\n",
      "module hi(input [7:4] a, output [7:4] y); assign y = ~a; endmodule\n",
      "module cnt(input clk, input d, output reg q); always @(posedge clk) q <= d ^ q; endmodule\n",
      "module ov(input clk, input [1:0] s, input en, output reg y); always @(posedge clk) begin y <= 1'b0; case (s) 2'd3: if (en) y <= 1'b1; endcase end endmodule\n",
      "module nest(input clk, input a, b, output reg y); always @(posedge clk) begin y <= 1'b0; if (a) if (b) y <= 1'b1; end endmodule\n",
      "module dc(input s, a, output reg y); always @* y = s ? 1'bx : a; endmodule\n",
    ];
    for (const source of cases) {
      const path = writeVerilog(dir, `${source.match(/module\s+(\w+)/)?.[1] ?? "m"}.v`, source);
      const netlist = parseVerilog(source);
      const report = mapDesign(netlist, "std", "area");
      assert.equal(report.equiv.mismatches, 0, netlist.name);
      const lec = checkEquivalence([path], netlist.name, report.verilog, STD_LIBRARY);
      assert.equal(lec.proved, true, `${netlist.name}\n${lec.text}\n${report.verilog}`);
    }
    const asyncSource = VERILOG.find((item) => item.id === "async.v");
    assert.ok(asyncSource);
    const asyncPath = writeVerilog(dir, "async.v", asyncSource.source);
    const asyncNet = parseVerilog(asyncSource.source);
    const asyncReport = mapDesign(asyncNet, sky130Hd(), "area");
    const asyncLec = checkEquivalence([asyncPath], asyncNet.name, asyncReport.verilog, sky130Hd());
    assert.equal(asyncLec.proved, true, `${asyncLec.text}\n${asyncReport.verilog}`);
    const stdAsync = mapDesign(asyncNet, "std", "area");
    const stdLec = checkEquivalence([asyncPath], asyncNet.name, stdAsync.verilog, STD_LIBRARY);
    assert.equal(stdLec.proved, true, `${stdLec.text}\n${stdAsync.verilog}`);

    const defs = writeVerilog(dir, "defs.v", "`define NOT(x) (~(x))\n");
    const top = writeVerilog(
      dir,
      "top.v",
      "module top(input a, output y); assign y = `NOT(a); endmodule\n",
    );
    const shared = parseVerilog(
      "`define NOT(x) (~(x))\nmodule top(input a, output y); assign y = `NOT(a); endmodule\n",
    );
    const sharedReport = mapDesign(shared, "std", "area");
    const sharedLec = checkEquivalence([defs, top], "top", sharedReport.verilog, STD_LIBRARY);
    assert.equal(sharedLec.proved, true, sharedLec.text);

    const ident = "module m(input a, output y); assign y = a; endmodule\n";
    const identPath = writeVerilog(dir, "ident.v", ident);
    const identNet = parseVerilog(ident);
    const wrong = "module m(input a, output y);\n  BUF_1 g0 (y, 1'b0);\nendmodule\n";
    const failed = checkEquivalence([identPath], identNet.name, wrong, STD_LIBRARY);
    assert.equal(failed.proved, false);

    const deadSource = `module dead(input clk, input d, output reg y);
      reg gone;
      always @(posedge clk) begin
        gone <= gone ^ d;
        y <= d;
      end
    endmodule
`;
    const deadPath = writeVerilog(dir, "dead.v", deadSource);
    const deadNet = parseVerilog(deadSource);
    const deadReport = mapDesign(deadNet, "std", "area");
    assert.equal(
      deadNet.gates.filter((gate) => gate.op === "DFF").map((gate) => gate.id).join(","),
      "y",
    );
    const deadLec = checkEquivalence([deadPath], deadNet.name, deadReport.verilog, STD_LIBRARY);
    assert.equal(deadLec.proved, true, deadLec.text);
  });
});
