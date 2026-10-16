import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXAMPLES, VERILOG } from "./examples.ts";
import { parseLiberty } from "./liberty.ts";
import { checkTime, tableCheck } from "./library.ts";
import { sky130Hd } from "./sky130hd.ts";
import { arrivals, mapNetlist, type MapGate } from "./map.ts";
import { mapDesign } from "./seq.ts";
import { parseVerilog } from "./verilog.ts";

const TINY = `library (tiny) {
  cell (INVX1) {
    area : 1;
    pin (A) { direction : input; capacitance : 1; }
    pin (Y) { direction : output; function : "!A"; timing () { related_pin : "A"; intrinsic_rise : 1; intrinsic_fall : 1.2; } }
  }
  cell (NAND2X1) {
    area : 2;
    pin (A) { direction : input; capacitance : 1; }
    pin (B) { direction : input; capacitance : 1.5; }
    pin (Y) { direction : output; function : "!(A*B)"; timing () { related_pin : "A"; intrinsic_rise : 2; intrinsic_fall : 2; } }
  }
  cell (GATED) { dont_use : true; area : 9; pin (A) { direction : input; } pin (Y) { direction : output; function : "!A"; } }
}
`;

describe("liberty", () => {
  it("reads area, function, capacitance, and the slower intrinsic edge", () => {
    const library = parseLiberty(TINY);
    assert.equal(library.name, "tiny");
    const nand = library.cells.find((cell) => cell.name === "NAND2X1");
    assert.ok(nand);
    assert.equal(nand.area, 2);
    assert.equal(nand.delay, 2);
    assert.equal(nand.cap, 1.5);
    assert.equal(nand.fn(3), 0);
    assert.equal(nand.fn(1), 1);
    assert.equal(
      library.cells.some((cell) => cell.name === "GATED"),
      false,
    );
  });

  it("uses the first number of a delay table when there is no intrinsic", () => {
    const library = parseLiberty(`library (tab) {
      cell (INVX1) {
        area : 1;
        pin (A) { direction : input; capacitance : 1; }
        pin (Y) {
          direction : output;
          function : "!A";
          timing () {
            related_pin : "A";
            cell_rise (delay_template_5x5) { values ( "0.3, 0.5", "0.8, 0.9" ); }
          }
        }
      }
      cell (NAND2X1) {
        area : 2;
        pin (A) { direction : input; }
        pin (B) { direction : input; }
        pin (Y) { direction : output; function : "!(A+B)"; timing () { related_pin : "A"; intrinsic_rise : 2; } }
      }
    }`);
    assert.equal(library.cells.find((cell) => cell.name === "INVX1")?.delay, 0.3);
  });

  it("maps an XOR onto a cell whose name is not XOR", () => {
    const library = parseLiberty(`library (odd) {
      cell (INVX1) {
        area : 1;
        pin (A) { direction : input; capacitance : 1; }
        pin (Y) { direction : output; function : "A'"; timing () { related_pin : "A"; intrinsic_rise : 1; } }
      }
      cell (NAND2X1) {
        area : 2;
        pin (A) { direction : input; capacitance : 1; }
        pin (B) { direction : input; capacitance : 1; }
        pin (Y) { direction : output; function : "!(A * B)"; timing () { related_pin : "A"; intrinsic_rise : 2; } }
      }
      cell (EXOR) {
        area : 4;
        pin (A) { direction : input; capacitance : 1; }
        pin (B) { direction : input; capacitance : 1; }
        pin (Y) { direction : output; function : "(A ^ B)"; timing () { related_pin : "A"; intrinsic_rise : 4; intrinsic_fall : 4; } }
      }
    }`);
    const report = mapNetlist(
      {
        name: "x",
        inputs: ["a", "b"],
        outputs: ["y"],
        gates: [{ id: "y", op: "XOR", ins: ["a", "b"] }],
      },
      library,
      "area",
    );
    assert.equal(report.equiv.mismatches, 0);
    assert.ok(report.cells.includes("EXOR"));
    assert.equal(report.library, "odd");
  });

  it("maps the adder and the counter from the sample library", () => {
    const library = parseLiberty(`library (sample) {
      cell (INVX1) {
        area : 1; pin (A) { direction : input; capacitance : 1; }
        pin (Y) { direction : output; function : "!A"; timing () { related_pin : "A"; intrinsic_rise : 1; } }
      }
      cell (NAND2X1) {
        area : 2;
        pin (A) { direction : input; capacitance : 1; }
        pin (B) { direction : input; capacitance : 1; }
        pin (Y) { direction : output; function : "!(A * B)"; timing () { related_pin : "A"; intrinsic_rise : 2; } }
      }
      cell (NAND2X4) {
        area : 8; drive_strength : 4;
        pin (A) { direction : input; capacitance : 4; }
        pin (B) { direction : input; capacitance : 4; }
        pin (Y) { direction : output; function : "!(A * B)"; timing () { related_pin : "A"; intrinsic_rise : 2; } }
      }
      cell (DFFX1) {
        area : 6;
        ff (IQ, IQN) { next_state : "D"; clocked_on : "CK"; }
        pin (CK) { direction : input; clock : true; }
        pin (D) { direction : input; capacitance : 1; }
        pin (Q) {
          direction : output; function : "IQ";
          timing () { related_pin : "CK"; timing_type : rising_edge; intrinsic_rise : 2; }
        }
        pin (D) { timing () { related_pin : "CK"; timing_type : setup_rising; intrinsic_rise : 1; } }
      }
    }`);
    const adder = EXAMPLES.find((item) => item.id === "full-adder");
    assert.ok(adder);
    const mapped = mapNetlist(adder.netlist, library, "area");
    assert.equal(mapped.equiv.mismatches, 0);
    assert.ok(mapped.cells.every((cell) => cell === "INVX1" || cell === "NAND2X1"));
    const counter = EXAMPLES.find((item) => item.id === "counter");
    assert.ok(counter);
    const clocked = mapDesign(counter.netlist, library, "area");
    assert.equal(clocked.equiv.mismatches, 0);
    assert.ok(clocked.cells.includes("DFFX1"));
    assert.equal(clocked.timing?.setup, 1);
    assert.equal(library.flops[0]?.clkToQ, 2);
  });

  it("looks up a standard-cell NLDM table at the output capacitance", () => {
    const library = parseLiberty(`library (NangateOpenCellLibrary) {
      capacitive_load_unit (1, ff);
      lu_table_template (Timing_7_7) {
        variable_1 : input_net_transition;
        variable_2 : total_output_net_capacitance;
        index_1 ("0.001, 0.02");
        index_2 ("0.5, 5");
      }
      cell (INV_X1) {
        drive_strength : 1;
        area : 0.532;
        pg_pin (VDD) { voltage_name : VDD; pg_type : primary_power; }
        leakage_power () { when : "!A"; value : 10.1; }
        pin (A) { direction : input; capacitance : 1.7; }
        pin (ZN) {
          direction : output;
          function : "!A";
          timing () {
            related_pin : "A";
            timing_sense : negative_unate;
            cell_fall (Timing_7_7) {
              index_1 ("0.001, 0.02");
              index_2 ("0.5, 5");
              values ("0.004, 0.020", "0.008, 0.030");
            }
            cell_rise (Timing_7_7) {
              index_1 ("0.001, 0.02");
              index_2 ("0.5, 5");
              values ("0.005, 0.030", "0.009, 0.040");
            }
          }
        }
      }
      cell (NAND2_X1) {
        drive_strength : 1;
        area : 0.798;
        pin (A1) { direction : input; capacitance : 1.6; }
        pin (A2) { direction : input; capacitance : 1.6; }
        pin (ZN) {
          direction : output;
          function : "!(A1 & A2)";
          timing () {
            related_pin : "A1";
            cell_rise (Timing_7_7) {
              index_1 ("0.001");
              index_2 ("0.5, 5");
              values ("0.010, 0.040");
            }
          }
        }
      }
    }`);
    const inv = library.cells.find((cell) => cell.name === "INV_X1");
    assert.ok(inv?.table);
    assert.equal(inv.delay, 0.005);
    const nand = library.cells.find((cell) => cell.name === "NAND2_X1");
    assert.ok(nand?.table);
    const report = mapNetlist(
      {
        name: "and2",
        inputs: ["a", "b"],
        outputs: ["y"],
        gates: [{ id: "y", op: "AND", ins: ["a", "b"] }],
      },
      library,
      "area",
    );
    assert.equal(report.equiv.mismatches, 0);
    assert.ok(report.cells.includes("NAND2_X1"));
    assert.ok(report.cells.includes("INV_X1"));
    assert.ok(report.delay < 0.2);
    assert.ok(report.delay > 0.01);
  });

  it("times the next gate at the slew of the gate before it", () => {
    const library = parseLiberty(`library (slew) {
      cell (INV) {
        area : 1;
        pin (A) { direction : input; capacitance : 1; }
        pin (Y) {
          direction : output;
          function : "!A";
          timing () {
            related_pin : "A";
            cell_rise (d) {
              index_1 ("0.01, 0.10");
              index_2 ("1");
              values ("0.02", "0.05");
            }
            cell_fall (d) {
              index_1 ("0.01, 0.10");
              index_2 ("1");
              values ("0.02", "0.05");
            }
            rise_transition (d) {
              index_1 ("0.01, 0.10");
              index_2 ("1");
              values ("0.10", "0.20");
            }
            fall_transition (d) {
              index_1 ("0.01, 0.10");
              index_2 ("1");
              values ("0.10", "0.20");
            }
          }
        }
      }
    }`);
    const report = arrivals(
      library,
      [
        { cell: "INV", output: "n1", inputs: ["a"] },
        { cell: "INV", output: "y", inputs: ["n1"] },
      ],
      [{ name: "y", wire: "y" }],
      ["a"],
      new Map(),
      "cap",
    );
    assert.equal(report.delay, 0.07);
    assert.equal(report.rise, 0.07);
    assert.equal(report.fall, 0.07);
  });

  it("takes the input slew from the driving cell", () => {
    const library = parseLiberty(`library (drive) {
      cell (BUF) {
        area : 1;
        pin (A) { direction : input; capacitance : 1; }
        pin (Y) {
          direction : output;
          function : "A";
          timing () {
            related_pin : "A";
            cell_rise (d) { index_1 ("0.01"); index_2 ("1"); values ("0.01"); }
            cell_fall (d) { index_1 ("0.01"); index_2 ("1"); values ("0.01"); }
            rise_transition (d) { index_1 ("0.01"); index_2 ("0.01, 1"); values ("0.01, 0.20"); }
            fall_transition (d) { index_1 ("0.01"); index_2 ("0.01, 1"); values ("0.01, 0.20"); }
          }
        }
      }
      cell (INV) {
        area : 1;
        pin (A) { direction : input; capacitance : 1; }
        pin (Y) {
          direction : output;
          function : "!A";
          timing () {
            related_pin : "A";
            cell_rise (d) { index_1 ("0.01, 0.20"); index_2 ("1"); values ("0.02", "0.08"); }
            cell_fall (d) { index_1 ("0.01, 0.20"); index_2 ("1"); values ("0.02", "0.08"); }
            rise_transition (d) { index_1 ("0.01"); index_2 ("1"); values ("0.01"); }
            fall_transition (d) { index_1 ("0.01"); index_2 ("1"); values ("0.01"); }
          }
        }
      }
    }`);
    const gates = [{ cell: "INV", output: "y", inputs: ["a"] }];
    const ties = [{ name: "y", wire: "y" }];
    const plain = arrivals(library, gates, ties, ["a"], new Map(), "cap");
    const driven = arrivals(library, gates, ties, ["a"], new Map(), "cap", new Map(), {
      drivingCell: { cell: "BUF", pin: "Y" },
      drivingInputs: new Set(["a"]),
    });
    assert.equal(plain.delay, 0.02);
    assert.equal(driven.delay, 0.08);
    assert.throws(
      () =>
        arrivals(library, gates, ties, ["a"], new Map(), "cap", new Map(), {
          drivingCell: { cell: "NOPE" },
          drivingInputs: new Set(["a"]),
        }),
      /no driving cell/,
    );
    assert.throws(
      () =>
        arrivals(library, gates, ties, ["a"], new Map(), "cap", new Map(), {
          drivingCell: { cell: "BUF", pin: "Z" },
          drivingInputs: new Set(["a"]),
        }),
      /no pin Z/,
    );
  });

  it("uses every arc on a pin, and a when arc only when that condition can be true", () => {
    const library = parseLiberty(`library (cond) {
      cell (INV) {
        area : 1;
        pin (A) { direction : input; capacitance : 1; }
        pin (Y) { direction : output; function : "!A"; timing () { related_pin : "A"; intrinsic_rise : 0.01; intrinsic_fall : 0.01; } }
      }
      cell (XOR) {
        area : 4;
        pin (A) { direction : input; capacitance : 1; }
        pin (B) { direction : input; capacitance : 1; }
        pin (Y) {
          direction : output;
          function : "A^B";
          timing () { related_pin : "A"; timing_sense : positive_unate; when : "B"; intrinsic_rise : 0.02; intrinsic_fall : 0.02; }
          timing () { related_pin : "A"; timing_sense : negative_unate; when : "!B"; intrinsic_rise : 0.08; intrinsic_fall : 0.08; }
          timing () { related_pin : "B"; timing_sense : positive_unate; when : "A"; intrinsic_rise : 0.01; intrinsic_fall : 0.01; }
          timing () { related_pin : "B"; timing_sense : negative_unate; when : "!A"; intrinsic_rise : 0.01; intrinsic_fall : 0.01; }
        }
      }
    }`);
    const xor = library.cells.find((cell) => cell.name === "XOR");
    assert.equal(xor?.arcs?.length, 4);
    const gates: MapGate[] = [{ cell: "XOR", output: "y", inputs: ["a", "b"] }];
    const open = arrivals(library, gates, [{ name: "y", wire: "y" }], ["a", "b"], new Map(), "cap");
    assert.equal(open.delay, 0.08);
    const tied = arrivals(
      library,
      [{ cell: "XOR", output: "y", inputs: ["a", "1"] }],
      [{ name: "y", wire: "y" }],
      ["a"],
      new Map(),
      "cap",
    );
    assert.equal(tied.delay, 0.02);
  });

  it("reports the rise path and the fall path separately", () => {
    const library = parseLiberty(`library (edges) {
      cell (INV) {
        area : 1;
        pin (A) { direction : input; capacitance : 1; }
        pin (Y) {
          direction : output;
          function : "!A";
          timing () {
            related_pin : "A";
            timing_sense : negative_unate;
            cell_rise (d) { index_1 ("0.01"); index_2 ("1"); values ("0.02"); }
            cell_fall (d) { index_1 ("0.01"); index_2 ("1"); values ("0.09"); }
          }
        }
      }
    }`);
    const report = arrivals(
      library,
      [{ cell: "INV", output: "y", inputs: ["a"] }],
      [{ name: "y", wire: "y" }],
      ["a"],
      new Map(),
      "cap",
    );
    assert.equal(report.rise, 0.02);
    assert.equal(report.fall, 0.09);
    assert.equal(report.delay, 0.09);
    assert.equal(report.risePath.at(-1)?.edge, "rise");
    assert.equal(report.fallPath.at(-1)?.edge, "fall");
  });

  it("maps onto a reduced Sky130 HD library", () => {
    const library = sky130Hd();
    const inv = library.cells.find((cell) => cell.name === "sky130_fd_sc_hd__inv_1");
    assert.ok(inv?.maxCap);
    assert.ok(Math.abs(inv.maxCap - 0.181284) < 1e-6);
    assert.equal(
      library.cells.some((cell) => cell.name === "sky130_fd_sc_hd__inv_1"),
      true,
    );
    assert.equal(
      library.flops.some((cell) => cell.name === "sky130_fd_sc_hd__dfxtp_1"),
      true,
    );
    const and4 = EXAMPLES.find((item) => item.id === "and4");
    assert.ok(and4);
    const mapped = mapNetlist(and4.netlist, library, "area");
    assert.equal(mapped.equiv.mismatches, 0);
    assert.ok(mapped.cells.every((cell) => cell.startsWith("sky130_fd_sc_hd__")));
    assert.ok(mapped.delay < 1);
    const counter = EXAMPLES.find((item) => item.id === "counter");
    assert.ok(counter);
    const clocked = mapDesign(counter.netlist, library, "area");
    assert.equal(clocked.equiv.mismatches, 0);
    assert.ok(clocked.cells.includes("sky130_fd_sc_hd__dfxtp_1"));
    const sreg = VERILOG.find((item) => item.id === "sreg.v");
    assert.ok(sreg);
    const shift = mapDesign(parseVerilog(sreg.source), library, "load", {
      period: 10,
      maxFanout: 4,
    });
    const qSlew = [...shift.risePath, ...shift.fallPath].find((step) => step.label.endsWith("/Q"));
    assert.ok(qSlew);
    assert.ok(qSlew.slew < 0.2);
    assert.equal(shift.over.length, 0);
  });

  it("rejects a library with no inverter", () => {
    assert.throws(
      () =>
        parseLiberty(
          `library (empty) { cell (BUF) { area : 1; pin (A) { direction : input; } pin (Y) { direction : output; function : "A"; } } }`,
        ),
      /no inverter/,
    );
  });

  it("reads a wire load, a hold check, and max transition", () => {
    const sky = sky130Hd();
    assert.equal(sky.wireLoads, undefined);
    assert.ok((sky.cells.find((cell) => cell.slew)?.maxTran ?? 0) >= 1.5);
    const library = parseLiberty(`library (rules) {
      default_wire_load : "wlm";
      wire_load (wlm) {
        capacitance : 1;
        resistance : 2;
        slope : 0.5;
        fanout_length (1, 1);
        fanout_length (4, 2);
      }
      cell (INV_X1) {
        area : 1;
        pin (A) { direction : input; capacitance : 1; max_transition : 0.01; }
        pin (Y) {
          direction : output;
          max_capacitance : 8;
          max_transition : 0.01;
          function : "!A";
          timing () {
            related_pin : "A";
            cell_rise (d) { index_1 ("0.01"); index_2 ("1"); values ("0.2"); }
            cell_fall (d) { index_1 ("0.01"); index_2 ("1"); values ("0.2"); }
            rise_transition (d) { index_1 ("0.01"); index_2 ("1"); values ("0.4"); }
            fall_transition (d) { index_1 ("0.01"); index_2 ("1"); values ("0.4"); }
          }
        }
      }
      cell (DFF_X1) {
        area : 6;
        ff (IQ, IQN) { next_state : "D"; clocked_on : "CK"; }
        pin (CK) { direction : input; clock : true; capacitance : 1; }
        pin (D) {
          direction : input;
          capacitance : 1;
          timing () { related_pin : "CK"; timing_type : hold_rising; intrinsic_rise : 4; }
          timing () { related_pin : "CK"; timing_type : setup_rising; intrinsic_rise : 1; }
        }
        pin (Q) {
          direction : output;
          function : "IQ";
          timing () { related_pin : "CK"; timing_type : rising_edge; intrinsic_rise : 2; intrinsic_fall : 2; }
        }
      }
    }`);
    assert.equal(library.defaultWireLoad, "wlm");
    assert.equal(library.wireLoads?.[0]?.fanouts[1]?.length, 2);
    assert.equal(library.flops[0]?.hold, 4);
    assert.equal(library.flops[0]?.clockCap, 1);
    const inv = {
      name: "inv",
      inputs: ["a"],
      outputs: ["y"],
      gates: [{ id: "y", op: "INV" as const, ins: ["a"] }],
    };
    const loaded = mapDesign(inv, library, "load");
    const bare = mapDesign(inv, library, "load", { period: 10, wireLoad: "none" });
    assert.ok(loaded.delay > bare.delay);
    const per = mapDesign(inv, library, "load", { period: 10, capPerFanout: 1 });
    const both = mapDesign(inv, library, "load", { period: 10, wireLoad: "wlm", capPerFanout: 1 });
    assert.equal(per.delay, both.delay);
    assert.notEqual(per.delay, loaded.delay);
    const flop = {
      name: "ff",
      inputs: ["d"],
      outputs: ["q"],
      gates: [{ id: "q", op: "DFF" as const, ins: ["d"] }],
    };
    const held = mapDesign(flop, library, "area", { period: 10, wireLoad: "none" });
    assert.equal(held.timing?.hold, 4);
    assert.equal(held.timing?.holdMet, false);
    assert.ok(
      mapDesign(inv, library, "area", { period: 10, wireLoad: "none" }).over.some(
        (hit) => hit.maxTran === 0.01,
      ),
    );
    assert.ok(
      mapDesign(inv, library, "area", {
        period: 10,
        wireLoad: "none",
        maxTransition: 0.001,
      }).over.some((hit) => hit.maxTran === 0.001),
    );
    const capped = mapDesign(inv, "std", "area", { period: 10, maxCapacitance: 0.5 });
    assert.ok(capped.over.some((hit) => hit.maxCap === 0.5 && hit.cap > 0.5));
  });

  it("interpolates setup and hold at the clock and data slews", () => {
    const text = (swap: boolean) => `library (check) {
      lu_table_template (vio) {
        variable_1 : ${swap ? "constrained_pin_transition" : "related_pin_transition"};
        variable_2 : ${swap ? "related_pin_transition" : "constrained_pin_transition"};
      }
      cell (INVX1) {
        area : 1;
        pin (A) { direction : input; capacitance : 0.01; }
        pin (Y) { direction : output; function : "!A"; timing () { related_pin : "A"; intrinsic_rise : 0.01; intrinsic_fall : 0.01; } }
      }
      cell (DFF_X1) {
        area : 6;
        ff (IQ, IQN) { next_state : "D"; clocked_on : "CK"; }
        pin (CK) { direction : input; clock : true; capacitance : 0.01; }
        pin (D) {
          direction : input;
          capacitance : 0.01;
          timing () {
            related_pin : "CK";
            timing_type : setup_rising;
            rise_constraint (vio) {
              index_1 ("0.01, 0.50");
              index_2 ("0.01, 0.50");
              values (${swap ? '"0.10, 0.00", "0.30, 0.20"' : '"0.10, 0.30", "0.00, 0.20"'});
            }
            fall_constraint (vio) {
              index_1 ("0.01, 0.50");
              index_2 ("0.01, 0.50");
              values (${swap ? '"0.10, 0.05", "0.40, 0.25"' : '"0.10, 0.40", "0.05, 0.25"'});
            }
          }
          timing () {
            related_pin : "CK";
            timing_type : hold_rising;
            rise_constraint (vio) {
              index_1 ("0.01, 0.50");
              index_2 ("0.01, 0.50");
              values (${swap ? '"-0.02, -0.08", "0.10, 0.05"' : '"-0.02, 0.10", "-0.08, 0.05"'});
            }
            fall_constraint (vio) {
              index_1 ("0.01, 0.50");
              index_2 ("0.01, 0.50");
              values (${swap ? '"-0.05, -0.10", "0.20, 0.00"' : '"-0.05, 0.20", "-0.10, 0.00"'});
            }
          }
        }
        pin (Q) {
          direction : output;
          function : "IQ";
          timing () { related_pin : "CK"; timing_type : rising_edge; intrinsic_rise : 0.01; intrinsic_fall : 0.01; }
        }
      }
    }`;
    const library = parseLiberty(text(false));
    const arc = library.flops[0]?.setupArcs?.[0];
    assert.ok(arc);
    assert.equal(tableCheck(arc, "fall", 0.5, 0.01), 0.4);
    assert.ok(tableCheck(arc, "fall", 0.01, 0) > 0.1);
    const flipped = parseLiberty(text(true)).flops[0]?.setupArcs?.[0];
    assert.ok(flipped);
    assert.equal(Number(tableCheck(flipped, "fall", 0.5, 0.01).toFixed(6)), 0.4);
    assert.equal(
      Number(checkTime(library.flops[0]?.setupArcs, 0, "fall", 0.255, 0.255).toFixed(3)),
      0.2,
    );
    const flop = {
      name: "ff",
      inputs: ["d"],
      outputs: [] as string[],
      gates: [{ id: "q", op: "DFF" as const, ins: ["d"] }],
    };
    const timed = mapDesign(flop, library, "load", {
      period: 10,
      wireLoad: "none",
      inputDelay: 0,
      inputTransition: 0.5,
      clockTransition: 0.01,
    });
    assert.equal(timed.timing?.setup, 0.4);
    assert.equal(timed.timing?.hold, 0.2);
    assert.equal(timed.timing?.holdMet, false);
    const sky = sky130Hd().flops.find((cell) => cell.name.endsWith("dfxtp_1"));
    const looked = Math.max(
      checkTime(sky?.setupArcs, 0, "rise", 1.5, 0.01),
      checkTime(sky?.setupArcs, 0, "fall", 1.5, 0.01),
    );
    assert.ok(Math.abs(looked - 0.6207) < 1e-4, `sky130 setup ${looked}`);
  });
});
