import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");

function sift(args: string[], input?: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], {
    input,
    encoding: "utf8",
  });
}

const INV = "module m(input a, output y); assign y = ~a; endmodule\n";

describe("sift cli", () => {
  it("prints help", () => {
    const result = sift(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--lib/);
    assert.match(result.stdout, /--period/);
    assert.match(result.stdout, /--lec/);
    assert.match(result.stdout, /--recover/);
    assert.match(result.stdout, /--gate/);
    assert.match(result.stdout, /--opt/);
  });

  it("maps a module from stdin", () => {
    const result = sift(["-", "--json", "--gates"], INV);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      name: string;
      mismatches: number;
      cells: string[];
      gates: { id: string; op: string }[];
      timing: null;
    };
    assert.equal(report.name, "m");
    assert.equal(report.mismatches, 0);
    assert.ok(report.cells.some((cell) => cell.startsWith("INV")));
    assert.equal(report.gates[0]?.op, "INV");
    assert.equal(report.timing, null);
  });

  it("reports a clock and prints the gate netlist", () => {
    const result = sift(
      ["-", "--period", "20"],
      "module m(input clk, input d, output reg q); always @(posedge clk) q <= ~d; endmodule\n",
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /meets/);
    assert.match(result.stdout, /slack/);
    assert.match(result.stdout, /1 registers/);
    const gates = sift(
      ["-", "--gates"],
      "module m(input a, b, output y); assign y = a & b; endmodule\n",
    );
    assert.match(gates.stdout, / = AND /);
  });

  it("fails on a syntax error", () => {
    const result = sift(["-"], "module m(input a, output y); assign y = ; endmodule\n");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected an expression/);
  });

  it("searches knobs with --opt", () => {
    const result = sift(["-", "--opt", "area", "--json"], INV);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      mode: string;
      opt: { goal: string; trials: unknown[]; recipe: { mode: string } };
    };
    assert.equal(report.opt.goal, "area");
    assert.ok(report.opt.trials.length >= 1);
    assert.equal(report.opt.recipe.mode, report.mode);
  });

  it("rejects --opt with --propose", () => {
    const result = sift(["-", "--opt", "--propose"], INV);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--opt/);
  });

  it("writes a netlist without assign and a timing report from SDC", () => {
    const dir = mkdtempSync(join(tmpdir(), "sift-"));
    const sdc = join(dir, "m.sdc");
    const netlist = join(dir, "m.v");
    const timing = join(dir, "m.timing");
    writeFileSync(
      sdc,
      "create_clock -name clk -period 8 [get_ports clk]\nset_input_delay -clock clk 1 [get_ports d]\nset_clock_uncertainty 0.3 [get_clocks clk]\nset_multicycle_path 2\n",
    );
    const result = sift(
      [
        "-",
        "--sdc",
        sdc,
        "--netlist",
        netlist,
        "--timing",
        timing,
        "--buffer-inputs",
        "--buffer-outputs",
      ],
      "module m(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule\n",
    );
    assert.equal(result.status, 0, result.stderr);
    const written = readFileSync(netlist, "utf8");
    assert.doesNotMatch(written, /assign /);
    assert.match(written, /BUF_1 /);
    assert.match(written, /_ib_d/);
    assert.match(written, /_ob_q/);
    const report = readFileSync(timing, "utf8");
    assert.match(report, /period 8/);
    assert.match(report, /uncertainty 0.3/);
    assert.match(report, /cycles 2/);
    assert.match(result.stdout, /period 8/);
  });

  it("reads several Verilog files and a shared define", () => {
    const dir = mkdtempSync(join(tmpdir(), "sift-"));
    const defs = join(dir, "defs.v");
    const leaf = join(dir, "leaf.v");
    const top = join(dir, "top.v");
    writeFileSync(defs, "`define NOT(x) (~(x))\n");
    writeFileSync(leaf, "module leaf(input a, output y);\n  assign y = `NOT(a);\nendmodule\n");
    writeFileSync(top, "module top(input a, output y);\n  leaf u(.a(a), .y(y));\nendmodule\n");
    const result = sift([top, defs, leaf, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { name: string; mismatches: number };
    assert.equal(report.name, "top");
    assert.equal(report.mismatches, 0);
    const picked = sift([top, defs, leaf, "--top", "leaf", "--json"]);
    assert.equal(picked.status, 0, picked.stderr);
    assert.equal((JSON.parse(picked.stdout) as { name: string }).name, "leaf");
  });

  it("recovers area and clock-gates from the flags", () => {
    const fan = sift(
      ["-", "--mode", "delay", "--period", "40", "--recover", "--json"],
      "module m(input clk, input a, b, output reg y0, y1, y2, y3); always @(posedge clk) begin y0 <= a & b; y1 <= a & b; y2 <= a & b; y3 <= a & b; end endmodule\n",
    );
    assert.equal(fan.status, 0, fan.stderr);
    const recovered = JSON.parse(fan.stdout) as {
      recovery: { steps: number; before: number; after: number };
      mismatches: number;
    };
    assert.ok(recovered.recovery.steps > 0);
    assert.ok(recovered.recovery.after < recovered.recovery.before);
    assert.equal(recovered.mismatches, 0);
    const gated = sift(
      ["-", "--gate", "--json", "--verilog"],
      "module m(input clk, input en, input d, output reg q); always @(posedge clk) if (en) q <= d; endmodule\n",
    );
    assert.equal(gated.status, 0, gated.stderr);
    const report = JSON.parse(gated.stdout) as {
      clockGates: { flops: string[] }[];
      verilog: string;
      mismatches: number;
    };
    assert.equal(report.clockGates.length, 1);
    assert.equal(report.mismatches, 0);
    assert.match(report.verilog, /LATCH /);
    const both = sift(
      ["-", "--lec", "--gate"],
      "module m(input clk, input en, input d, output reg q); always @(posedge clk) if (en) q <= d; endmodule\n",
    );
    assert.equal(both.status, 1);
    assert.match(both.stderr, /gated clock/);
  });
});
