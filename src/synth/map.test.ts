import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXAMPLES } from "./examples.ts";
import { STD_LIBRARY } from "./library.ts";
import {
  arrivals,
  limitHits,
  mapNetlist,
  repairLimits,
  type MapGate,
  type MapMode,
} from "./map.ts";
import type { Netlist } from "./netlist.ts";
import { flopsOf, mapDesign } from "./seq.ts";
import { sky130Hd } from "./sky130hd.ts";
import { parseLiberty } from "./liberty.ts";

function sorted(cells: string[]): string[] {
  return [...cells].sort();
}

function cover(netlist: Netlist, library: "min" | "std", mode: MapMode = "area") {
  const report = mapNetlist(netlist, library, mode);
  assert.equal(report.equiv.mismatches, 0, `${netlist.name} ${library} ${mode}`);
  return report;
}

describe("area map", () => {
  it("matches every example in area, delay, and load mode", () => {
    for (const example of EXAMPLES) {
      if (flopsOf(example.netlist).length > 0) continue;
      for (const library of ["min", "std"] as const) {
        for (const mode of ["area", "delay", "load"] as const) {
          const report = mapNetlist(example.netlist, library, mode);
          assert.equal(report.equiv.mismatches, 0, `${example.id} ${library} ${mode}`);
          assert.equal(report.equiv.exhaustive, true);
        }
      }
    }
  });

  it("keeps the cheaper NAND2 tree in area mode", () => {
    const example = EXAMPLES.find((item) => item.id === "and4");
    assert.ok(example);
    const report = cover(example.netlist, "std", "area");
    assert.equal(report.area, 6);
    assert.equal(report.delay, 4);
    assert.deepEqual(sorted(report.cells), ["NAND2_1", "NAND2_1", "NOR2_1"]);
    assert.equal(report.path.map((step) => step.label).join(" → "), "a → NAND2_1 → NOR2_1 → y");
  });

  it("spends area for a NAND4 when delay is the cost", () => {
    const example = EXAMPLES.find((item) => item.id === "and4");
    assert.ok(example);
    const report = cover(example.netlist, "std", "delay");
    assert.equal(report.area, 7);
    assert.equal(report.delay, 3);
    assert.deepEqual(sorted(report.cells), ["INV_1", "NAND4_1"]);
    assert.equal(report.path.map((step) => step.label).join(" → "), "a → NAND4_1 → INV_1 → y");
    assert.match(report.verilog, /NAND4_1 g0 \(_0, a, b, c, d\);/);
  });

  it("covers a 4-AND with two NAND2 and a NOR2 on min", () => {
    const example = EXAMPLES.find((item) => item.id === "and4");
    assert.ok(example);
    const report = cover(example.netlist, "min");
    assert.equal(report.area, 6);
    assert.deepEqual(sorted(report.cells), ["NAND2", "NAND2", "NOR2"]);
  });

  it("uses MUX2, XOR2, and AOI21 when they are in the library", () => {
    const mux = EXAMPLES.find((item) => item.id === "mux");
    const half = EXAMPLES.find((item) => item.id === "half-adder");
    const aoi = EXAMPLES.find((item) => item.id === "aoi");
    assert.ok(mux && half && aoi);
    const muxReport = cover(mux.netlist, "std");
    assert.equal(muxReport.area, 4);
    assert.deepEqual(muxReport.cells, ["MUX2_1"]);
    const halfReport = cover(half.netlist, "std");
    assert.equal(halfReport.area, 7);
    assert.deepEqual(sorted(halfReport.cells), ["INV_1", "NAND2_1", "XOR2_1"]);
    const aoiReport = cover(aoi.netlist, "std");
    assert.equal(aoiReport.area, 3);
    assert.deepEqual(aoiReport.cells, ["AOI21_1"]);
  });

  it("does not map swept gates", () => {
    const example = EXAMPLES.find((item) => item.id === "contradiction");
    assert.ok(example);
    const report = cover(example.netlist, "std");
    assert.equal(report.area, 4);
    assert.deepEqual(sorted(report.cells), ["BUF_1", "INV_1", "NAND2_1"]);
    assert.doesNotMatch(report.verilog, /assign /);
    assert.match(report.verilog, /BUF_1 g\d+ \(z, 1'b0\);/);
  });

  it("covers a 3-AND with NAND3 plus INV", () => {
    const netlist: Netlist = {
      name: "and3",
      inputs: ["a", "b", "c"],
      outputs: ["y"],
      gates: [
        { id: "ab", op: "AND", ins: ["a", "b"] },
        { id: "y", op: "AND", ins: ["ab", "c"] },
      ],
    };
    const report = cover(netlist, "std");
    assert.equal(report.area, 4);
    assert.deepEqual(sorted(report.cells), ["INV_1", "NAND3_1"]);
  });

  it("uses OAI21 for the complementary cone", () => {
    const netlist: Netlist = {
      name: "oai",
      inputs: ["a", "b", "c"],
      outputs: ["y"],
      gates: [
        { id: "ab", op: "OR", ins: ["a", "b"] },
        { id: "term", op: "AND", ins: ["ab", "c"] },
        { id: "y", op: "INV", ins: ["term"] },
      ],
    };
    const report = cover(netlist, "std");
    assert.equal(report.area, 3);
    assert.deepEqual(report.cells, ["OAI21_1"]);
  });

  it("keeps a drive 1, 2, and 4 of every std cell, plus a buffer", () => {
    const families = [
      "INV",
      "BUF",
      "NAND2",
      "NOR2",
      "NAND3",
      "NAND4",
      "AOI21",
      "OAI21",
      "XOR2",
      "MUX2",
    ];
    const names = new Set(STD_LIBRARY.cells.map((cell) => cell.name));
    for (const family of families) {
      for (const drive of [1, 2, 4])
        assert.ok(names.has(`${family}_${drive}`), `${family}_${drive}`);
    }
  });

  it("buffers a fanout above four and upsizes the buffers", () => {
    const example = EXAMPLES.find((item) => item.id === "fan");
    assert.ok(example);
    const area = cover(example.netlist, "std", "area");
    const delay = mapNetlist(example.netlist, "std", "delay", { maxFanout: 4 });
    assert.equal(delay.equiv.mismatches, 0);
    assert.ok(area.cells.every((cell) => cell.endsWith("_1")));
    assert.equal(
      area.cells.some((cell) => cell.startsWith("BUF")),
      false,
    );
    assert.ok(delay.cells.includes("BUF_2"));
    assert.ok(delay.cells.includes("BUF_4"));
    assert.ok(delay.delay < area.delay);
    assert.ok(delay.area > area.area);
  });

  it("sizes a shared NAND4 for capacitance, not for a fanout bucket", () => {
    const example = EXAMPLES.find((item) => item.id === "stage");
    assert.ok(example);
    const delay = cover(example.netlist, "std", "delay");
    const load = cover(example.netlist, "std", "load");
    assert.ok(delay.cells.includes("NAND4_4"));
    assert.ok(load.cells.includes("NAND4_2"));
    assert.equal(load.cells.includes("NAND4_4"), false);
    const inputs = example.netlist.inputs;
    const delayCap = arrivals(
      STD_LIBRARY,
      delay.gates,
      delay.drives,
      inputs,
      new Map(),
      "cap",
    ).delay;
    const loadCap = arrivals(STD_LIBRARY, load.gates, load.drives, inputs, new Map(), "cap").delay;
    assert.ok(loadCap < delayCap);
    assert.ok(load.area < delay.area);
  });

  it("keeps a Sky130 net inside max capacitance", () => {
    const arms = 160;
    const inputs = ["d", ...Array.from({ length: arms }, (_, index) => `c${index}`)];
    const outputs = ["q", ...Array.from({ length: arms }, (_, index) => `y${index}`)];
    const netlist: Netlist = {
      name: "wideq",
      inputs,
      outputs,
      gates: [
        { id: "q", op: "DFF", ins: ["d"] },
        ...outputs
          .slice(1)
          .map((id, index) => ({ id, op: "AND" as const, ins: ["q", `c${index}`] })),
      ],
    };
    const library = sky130Hd();
    const area = mapDesign(netlist, library, "area");
    const delay = mapDesign(netlist, library, "delay");
    const load = mapDesign(netlist, library, "load");
    const slewHit = (hit: { maxTran: number | null; slew: number | null }) =>
      hit.maxTran !== null && (hit.slew ?? 0) > hit.maxTran;
    assert.equal(area.equiv.mismatches, 0);
    assert.equal(delay.equiv.mismatches, 0);
    assert.equal(load.equiv.mismatches, 0);
    assert.equal(area.over.some(slewHit), false);
    assert.equal(delay.over.some(slewHit), false);
    assert.equal(load.over.some(slewHit), false);
    const capHit = (hit: { maxCap: number | null; cap: number }) =>
      hit.maxCap !== null && hit.cap > hit.maxCap;
    assert.equal(area.over.some(capHit), false);
    assert.equal(delay.over.some(capHit), false);
    assert.equal(load.over.some(capHit), false);
    assert.equal(delay.over.length, 0);
    assert.equal(load.over.length, 0);
    assert.ok(area.cells.some((cell) => cell.includes("buf_")));
    assert.ok(delay.cells.some((cell) => cell.includes("buf_")));
  });

  it("applies the fanout fallback when Sky130 omits max_fanout", () => {
    const arms = 40;
    const inputs = ["d", ...Array.from({ length: arms }, (_, index) => `c${index}`)];
    const outputs = ["q", ...Array.from({ length: arms }, (_, index) => `y${index}`)];
    const netlist: Netlist = {
      name: "fanq",
      inputs,
      outputs,
      gates: [
        { id: "q", op: "DFF", ins: ["d"] },
        ...outputs
          .slice(1)
          .map((id, index) => ({ id, op: "AND" as const, ins: ["q", `c${index}`] })),
      ],
    };
    const library = sky130Hd();
    assert.equal(
      library.cells.every((cell) => cell.maxFanout === undefined),
      true,
    );
    const area = mapDesign(netlist, library, "area");
    const delay = mapDesign(netlist, library, "delay");
    const load = mapDesign(netlist, library, "load");
    const slewHit = (hit: { maxTran: number | null; slew: number | null }) =>
      hit.maxTran !== null && (hit.slew ?? 0) > hit.maxTran;
    assert.equal(area.over.some(slewHit), false);
    assert.equal(delay.over.some(slewHit), false);
    assert.equal(load.over.some(slewHit), false);
    const capHit = (hit: { maxCap: number | null; cap: number }) =>
      hit.maxCap !== null && hit.cap > hit.maxCap;
    assert.equal(area.over.some(capHit), false);
    assert.equal(delay.over.length, 0);
    assert.equal(load.over.length, 0);
    assert.ok(delay.cells.some((cell) => cell.includes("buf_")));
  });

  it("sizes, buffers, or clones a capacitance miss in area and delay", () => {
    const pins = (maxCap: string, fn: string) =>
      `pin (A) { direction : input; capacitance : 1; }
       pin (Y) { direction : output; max_capacitance : ${maxCap}; function : "${fn}"; }`;
    const cell = (name: string, area: number, maxCap: string, fn: string) =>
      `cell (${name}) { area : ${area}; ${pins(maxCap, fn)} }`;
    const loads = (): MapGate[] => [
      { cell: "INVX1", output: "n", inputs: ["a"] },
      { cell: "INVX1", output: "y0", inputs: ["n"] },
      { cell: "INVX1", output: "y1", inputs: ["n"] },
      { cell: "INVX1", output: "y2", inputs: ["n"] },
      { cell: "INVX1", output: "y3", inputs: ["n"] },
    ];
    const drivers = (gates: readonly MapGate[]) => gates.filter((gate) => gate.inputs[0] === "a");
    const capMiss = (library: ReturnType<typeof parseLiberty>, gates: MapGate[]) =>
      limitHits(library, gates, [], ["a"], "count", {}).some(
        (hit) => hit.maxCap !== null && hit.cap > hit.maxCap,
      );
    const sized = parseLiberty(
      `library (sized) { ${cell("INVX1", 1, "2", "!A")} ${cell("INVX2", 2, "5", "!A")} }`,
    );
    const buffered = parseLiberty(
      `library (buffered) { ${cell("INVX1", 3, "2", "!A")} ${cell("BUFX1", 1, "5", "A")} }`,
    );
    const cloned = parseLiberty(`library (cloned) { ${cell("INVX1", 1, "2.5", "!A")} }`);
    for (const mode of ["area", "delay"] as const) {
      const up = repairLimits(sized, loads(), [], ["a"], mode);
      assert.deepEqual(
        drivers(up).map((gate) => gate.cell),
        ["INVX2"],
        `${mode} sizes`,
      );
      assert.equal(capMiss(sized, up), false, `${mode} size still over`);
      const buf = repairLimits(buffered, loads(), [], ["a"], mode);
      assert.equal(drivers(buf).length, 1, `${mode} buffer keeps one driver`);
      assert.ok(
        buf.some((gate) => gate.cell === "BUFX1" && gate.inputs[0] === "n"),
        `${mode} buffers`,
      );
      assert.equal(
        buf.filter((gate) => gate.cell === "INVX1" && gate.inputs[0] === "a").length,
        1,
        `${mode} does not clone when a buffer fits`,
      );
      assert.equal(capMiss(buffered, buf), false, `${mode} buffer still over`);
      const copy = repairLimits(cloned, loads(), [], ["a"], mode);
      assert.equal(drivers(copy).length, 2, `${mode} clones`);
      assert.equal(
        copy.some((gate) => gate.cell.startsWith("BUF")),
        false,
        `${mode} clone has no buffer`,
      );
      assert.equal(capMiss(cloned, copy), false, `${mode} clone still over`);
    }
    const stuck = parseLiberty(`library (stuck) { ${cell("INVX1", 1, "0.5", "!A")} }`);
    const one: MapGate[] = [
      { cell: "INVX1", output: "n", inputs: ["a"] },
      { cell: "INVX1", output: "y", inputs: ["n"] },
    ];
    const left = repairLimits(stuck, one, [], ["a"], "area");
    assert.equal(left.length, 2);
    assert.equal(capMiss(stuck, left), true);
    const treeLib = parseLiberty(
      `library (tree) { ${cell("INVX1", 5, "100", "!A")} ${cell("BUFX1", 1, "2", "A")} }`,
    );
    const wide = (): MapGate[] => [
      { cell: "INVX1", output: "n", inputs: ["a"] },
      ...Array.from({ length: 6 }, (_, index) => ({
        cell: "INVX1",
        output: `y${index}`,
        inputs: ["n"],
      })),
    ];
    const sourceLimit = new Map([["n", { maxCap: 2, drive: 1 }]]);
    for (const mode of ["area", "delay"] as const) {
      const tree = repairLimits(treeLib, wide(), [], ["a"], mode, { sourceLimit });
      const hits = limitHits(treeLib, tree, [], ["a"], "count", { sourceLimit });
      assert.equal(
        hits.some((hit) => hit.cell === "source" && hit.maxCap !== null && hit.cap > hit.maxCap),
        false,
        `${mode} source still over`,
      );
      assert.ok(
        tree.filter((gate) => gate.cell === "BUFX1").length >= 2,
        `${mode} grows a buffer tree`,
      );
    }
  });

  it("puts the later input on the faster pin", () => {
    const library = parseLiberty(`library (pins) {
      cell (INVX1) {
        area : 1;
        pin (A) { direction : input; capacitance : 1; }
        pin (Y) {
          direction : output;
          function : "!A";
          timing () {
            related_pin : "A";
            cell_rise (d) { index_1 ("0.01"); index_2 ("1"); values ("0.1"); }
            cell_fall (d) { index_1 ("0.01"); index_2 ("1"); values ("0.1"); }
          }
        }
      }
      cell (NAND2X1) {
        area : 2;
        pin (A) { direction : input; capacitance : 1; }
        pin (B) { direction : input; capacitance : 1; }
        pin (Y) {
          direction : output;
          function : "!(A & B)";
          timing () {
            related_pin : "A";
            cell_rise (d) { index_1 ("0.01"); index_2 ("1"); values ("2"); }
            cell_fall (d) { index_1 ("0.01"); index_2 ("1"); values ("2"); }
          }
          timing () {
            related_pin : "B";
            cell_rise (d) { index_1 ("0.01"); index_2 ("1"); values ("0.1"); }
            cell_fall (d) { index_1 ("0.01"); index_2 ("1"); values ("0.1"); }
          }
        }
      }
    }`);
    const netlist: Netlist = {
      name: "latepin",
      inputs: ["late", "early"],
      outputs: ["y"],
      gates: [
        { id: "n", op: "AND", ins: ["late", "early"] },
        { id: "y", op: "INV", ins: ["n"] },
      ],
    };
    const report = mapDesign(netlist, library, "load", {
      period: 20,
      wireLoad: "none",
      ports: { late: { delay: 3 }, early: { delay: 0 } },
    });
    assert.equal(report.equiv.mismatches, 0);
    const line = report.verilog.split("\n").find((row) => row.includes("NAND2X1"));
    assert.ok(line);
    assert.match(line, /NAND2X1 \S+ \(\S+, early, late\)/);
  });
});
