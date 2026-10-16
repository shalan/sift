import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSdc } from "./sdc.ts";

const ports = { inputs: ["clk", "d_0", "d_1"], outputs: ["q"] };

describe("sdc", () => {
  it("reads a clock, port delays, and a wire load", () => {
    const constraints = parseSdc(
      `
      create_clock -name clk -period 12 [get_ports clk]
      set_input_delay -clock clk 1.5 [get_ports d[*]]
      set_output_delay -clock clk 0.4 [get_ports q]
      set_input_transition 0.2 [get_ports d_0]
      set_load 0.05 [get_ports q]
      set_max_fanout 6 [current_design]
      set_max_transition 1.5 [current_design]
      set_max_capacitance 0.2 [current_design]
      set_clock_transition 0.08 [get_clocks clk]
      set_wire_load_model -name small
      set_false_path -from [get_ports d*] -to [get_pins q/D]
      set_false_path -hold -from [all_inputs] -to [all_registers]
      set_driving_cell -lib_cell BUF_2 -pin Y [all_inputs]
      set_driving_cell -lib_cell INV_X1 -from_pin A -input_transition_rise 0.05 [get_ports d_0]
    `,
      ports,
    );
    assert.equal(constraints.period, 12);
    assert.equal(constraints.ports?.d_0?.delay, 1.5);
    assert.equal(constraints.ports?.d_1?.delay, 1.5);
    assert.equal(constraints.ports?.d_0?.slew, undefined);
    assert.equal(constraints.ports?.q?.delay, 0.4);
    assert.equal(constraints.ports?.q?.load, 0.05);
    assert.equal(constraints.maxFanout, 6);
    assert.equal(constraints.maxTransition, 1.5);
    assert.equal(constraints.maxCapacitance, 0.2);
    assert.equal(constraints.clockTransition, 0.08);
    assert.equal(constraints.wireLoad, "small");
    assert.equal(constraints.falsePaths?.length, 2);
    assert.equal(constraints.falsePaths?.[0]?.setup, true);
    assert.equal(constraints.falsePaths?.[0]?.hold, true);
    assert.deepEqual(constraints.falsePaths?.[0]?.from, { kind: "ports", names: ["d*"] });
    assert.deepEqual(constraints.falsePaths?.[0]?.to, { kind: "pins", names: ["q/D"] });
    assert.equal(constraints.falsePaths?.[1]?.setup, false);
    assert.equal(constraints.falsePaths?.[1]?.hold, true);
    assert.equal(constraints.falsePaths?.[1]?.from?.kind, "inputs");
    assert.equal(constraints.falsePaths?.[1]?.to?.kind, "registers");
    assert.equal(constraints.drivingCell?.cell, "BUF_2");
    assert.equal(constraints.drivingCell?.pin, "Y");
    assert.equal(constraints.ports?.d_0?.drive?.cell, "INV_X1");
    assert.equal(constraints.ports?.d_0?.drive?.fromPin, "A");
    assert.equal(constraints.ports?.d_0?.drive?.rise, 0.05);
    assert.equal(constraints.ports?.d_1?.drive, undefined);
    const replaced = parseSdc(
      "set_driving_cell -lib_cell BUF [get_ports d_0]\nset_input_transition 0.2 [get_ports d_0]\n",
      ports,
    );
    assert.equal(replaced.ports?.d_0?.slew, 0.2);
    assert.equal(replaced.ports?.d_0?.drive, undefined);
  });

  it("rejects a command outside the subset", () => {
    assert.throws(
      () => parseSdc("set_false_path -through [get_nets a]\n", ports),
      /not in the SDC subset/,
    );
    assert.throws(() => parseSdc("set_false_path\n", ports), /needs -from or -to/);
    assert.throws(
      () => parseSdc("set_driving_cell -lib_cell BUF [get_ports q]\n", ports),
      /input ports/,
    );
    assert.throws(
      () => parseSdc("set_driving_cell -pin Y [all_inputs]\n", ports),
      /needs -lib_cell/,
    );
    assert.throws(
      () => parseSdc("set_driving_cell -lib_cell BUF -clock clk [all_inputs]\n", ports),
      /not in the SDC subset/,
    );
  });

  it("reads clock uncertainty for setup, hold, or both", () => {
    const both = parseSdc(
      "create_clock -name clk -period 10\nset_clock_uncertainty 0.15 [get_clocks clk]\n",
      ports,
    );
    assert.equal(both.setupUncertainty, 0.15);
    assert.equal(both.holdUncertainty, 0.15);
    const split = parseSdc(
      "create_clock -name clk -period 10\nset_clock_uncertainty -setup 0.2 [get_clocks *]\nset_clock_uncertainty -hold 0.05\n",
      ports,
    );
    assert.equal(split.setupUncertainty, 0.2);
    assert.equal(split.holdUncertainty, 0.05);
    assert.throws(
      () =>
        parseSdc(
          "create_clock -name clk -period 10\nset_clock_uncertainty 0.1 [get_clocks other]\n",
          ports,
        ),
      /unknown clock/,
    );
    assert.throws(
      () => parseSdc("set_clock_uncertainty -from [get_clocks clk] 0.1\n", ports),
      /not in the SDC subset/,
    );
    assert.throws(
      () => parseSdc("set_clock_uncertainty 0.1 [get_ports d_0]\n", ports),
      /applies to a clock/,
    );
    assert.throws(
      () => parseSdc("set_clock_uncertainty -setup -0.1 [get_clocks clk]\n", ports),
      /needs a value/,
    );
  });

  it("reads multicycle setup and hold as two commands", () => {
    const both = parseSdc(
      "set_multicycle_path 2\nset_multicycle_path 1 -hold\nset_multicycle_path 0 -hold\n",
      ports,
    );
    assert.equal(both.multiCycles?.[0]?.setup, 2);
    assert.equal(both.multiCycles?.[0]?.hold, null);
    assert.equal(both.multiCycles?.[1]?.hold, 1);
    assert.equal(both.multiCycles?.[1]?.setup, null);
    assert.equal(both.multiCycles?.[2]?.hold, 0);
    const pins = parseSdc(
      "set_multicycle_path -setup 2 -from [get_ports d_0] -to [get_pins q/D]\n",
      ports,
    );
    assert.equal(pins.multiCycles?.[0]?.setup, 2);
    assert.deepEqual(pins.multiCycles?.[0]?.from, { kind: "ports", names: ["d_0"] });
    assert.deepEqual(pins.multiCycles?.[0]?.to, { kind: "pins", names: ["q/D"] });
    assert.throws(() => parseSdc("set_multicycle_path -setup 2 -hold 1\n", ports), /two commands/);
    assert.throws(
      () => parseSdc("set_multicycle_path 2 -through [get_nets a]\n", ports),
      /not in the SDC subset/,
    );
    assert.throws(() => parseSdc("set_multicycle_path 0\n", ports), /at least 1/);
    assert.throws(() => parseSdc("set_multicycle_path 1.5\n", ports), /at least 1/);
    assert.throws(() => parseSdc("set_multicycle_path -1\n", ports), /not in the SDC subset/);
  });
});
