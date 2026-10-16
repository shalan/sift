# Sift user guide

Sift reads a small Verilog module, or a gate netlist, and maps it onto a standard-cell library. It reports area, delay, a structural Verilog netlist, and timing when the design has a clock.

It is a pre-placement synthesizer. There is no floorplan, no global route, and no multi-corner analysis. Wire cost is a model you supply, not an extracted net.

## Run it

From the project directory:

```bash
npm run sift -- design.v
npm run sift -- top.v leaf.v --top top --lib sky130 --mode load --sdc design.sdc --netlist out.v --timing out.timing
```

The bench page is the same flow with the example designs filled in. Recover area and clock gate are switches on that page. The page does not read an SDC file and does not offer the port-buffer switches. Use the command line for those.

Several `.v` files are one design, in the order you list them. A `` `define `` in an earlier file is visible in a later one. The top module is the one nothing instantiates. If more than one module qualifies, Sift uses the last of them. `--top name` overrides that. `-` reads one source from stdin and cannot be mixed with files.

Exit status is 0 when every simulated output matches. It is 1 on a syntax error, a mapping error, a mismatch, or a failed `--lec` proof.

## What you can write

One module. The clock port, if there is one, must be named `clk`. Widths are at most 512 bits. A memory is a local `reg` of at most 128 words and 1024 bits. It cannot be a port.

```verilog
module add4 (
  input clk,
  input [3:0] a, b,
  output reg [3:0] y
);
  always @(posedge clk)
    y <= a + b;
endmodule
```

| Construct                                                                                         | What Sift does                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assign`, `always @*`, `always @(posedge clk)`, `always_comb`, `always_ff`                        | Combinational logic, or a flip-flop on `clk`. `always_comb` and `always @*` are combinational and may use `=` or `<=`. `always_ff` is `always @(posedge clk)` and must use `<=`. An undeclared name on a continuous assignment or a port connection is a 1-bit wire                                                                                                                                                       |
| `localparam`, `logic`                                                                             | `localparam` is an integer constant in the module body. It is visible to widths and generate bounds, in source order, after the header parameters. A range on it is ignored. `logic` is a `reg` when an `always` assigns that name, and a net otherwise. An input that becomes a reg is an error. `reg logic` is an error                                                                                                 |
| `if` / `else`, `case` / `default`                                                                 | Muxes. Several constants may share an arm: `2'd0, 2'd1:`. `casex` and `casez` treat `x`, `z`, and `?` in a label as don't-care. A combo path that does not assign a `reg` infers a latch and warns. `// synopsys full_case` or `/* synthesis full_case */` on that `case` drives the missing arm to 0 instead. The same comment on a clocked `case` is ignored. `translate_off` through `translate_on` is not synthesized |
| `for` with a constant bound                                                                       | Unrolled                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `generate for` / `generate if`                                                                    | Unrolled, names get a suffix                                                                                                                                                                                                                                                                                                                                                                                              |
| `+ - * / %`, shifts, comparisons                                                                  | Adders, multipliers, and dividers. See below                                                                                                                                                                                                                                                                                                                                                                              |
| `== !=`, `&& \|\| !`, `& \| ^` and the reductions `~& ~\| ~^ ^~`                                  | Gates                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `{a, b}`, `{N{a}}`, `a[i]`, `a[3:0]`, `a[i +: 8]`, `a[i -: 4]`, `a[i+3:i]`                        | Bit operations. The left-hand side may be a concatenation, `{cout, y} = a + b`. A wider value keeps its low bits. `a[i:j]` is accepted when `i - j + 1` is a constant. Out of range on a variable base reads 0                                                                                                                                                                                                            |
| Instances of other modules in the same text, a later file, or `` `include "file.v" ``             | Flattened. The included file is read from the directory of the file that includes it                                                                                                                                                                                                                                                                                                                                      |
| `` `define ``, `` `undef ``, `` `ifdef ``, `` `ifndef ``, `` `elsif ``, `` `else ``, `` `endif `` | Expanded before parsing. `` `define NAME(a) `` takes arguments when there is no space before `(`. A macro may not expand itself                                                                                                                                                                                                                                                                                           |
| `signed`                                                                                          | Sign-extends through arithmetic and shifts                                                                                                                                                                                                                                                                                                                                                                                |
| Async reset                                                                                       | `always @(posedge clk or posedge rst)`. The reset value must be a constant                                                                                                                                                                                                                                                                                                                                                |

These are rejected:

- A part-select `a[i:j]` whose width is not a constant
- A bit select of a memory word
- An input declared `reg`
- A nested latch
- Two clocks, or a clock that is not named `clk`
- A combinational cycle
- `initial`, tasks, functions, and delays

`--arith area` starts from a ripple adder, an array multiplier, and a restoring divider. `--arith delay` starts from a Brent-Kung adder and a Wallace multiplier. `--ppa N` is a bias from 0 to 1, not a fixed weight. Each adder gets its own weight from the slack of the endpoints it reaches: `clamp(1 - slack / period, 0, 1)`. Slack near the period pulls that toward area, and the leakage that follows it. Slack near zero, or a miss, pins it at delay. `--ppa` shifts the result by `N - 0.5`, so 0 favors area and 1 favors delay, but a tight path can still refuse a slow adder and a loose path can still accept one. Leave `--ppa` unset and the weight is only the slack term. It does not change `--arith`. If you set `--ppa` and not `--arith`, a bias below 0.5 starts from ripple and an array multiplier; 0.5 and above start from Brent-Kung and a Wallace multiplier. An explicit `--arith` still wins the starting structure. After mapping, each adder is chosen again from the slack of the endpoints it reaches. That slack already includes the period, input and output delay, clock uncertainty, and multicycle checks. A false path does not count. Plenty of slack becomes a ripple adder. Slack that covers a 4-bit group but not a full ripple becomes a lookahead adder: carry-lookahead inside groups of four, Brent-Kung between the groups. A late or failing path stays, or becomes, Brent-Kung. The divider still restores; each row subtract is one of those adders. A compare reuses an add or subtract of the same operands, so `a - b` and `a < b` are one subtract. On the bench, load mode uses the delay operators. The command line does not: pass `--arith delay` yourself.

## Libraries

| `--lib`    | Cells                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `std`      | INV, BUF, NAND2, NOR2, NAND3, NAND4, AOI21, OAI21, XOR2, MUX2, each at drive 1, 2, and 4. DFF, ADFF, and LATCH. Unit delay. This is the default                        |
| `min`      | INV, NAND2, NOR2 only. No buffer. A tie or a port buffer is two inverters                                                                                              |
| `sky130`   | A reduced Sky130 HD library with NLDM tables                                                                                                                           |
| `file.lib` | Any Liberty file Sift can parse. It needs an inverter. Functions, pin capacitance, and delay tables are read. `when` arcs are used only when the condition can be true |

## Mapper

Before the cover, Sift rewrites the AND-inverter graph. It folds constants, shares identical ANDs, rewrites 4-input cuts, resubstitutes a node with an existing signal or with one AND of two signals when at most eight inputs prove the match, balances deep AND trees, merges nodes that simulate and prove identical, and resynthesizes cones of up to six inputs. `area` spends that effort on fewer gates. `delay` and `load` also accept a shallower tree when it does not add gates. None of these passes closes capacitance or transition. That happens after mapping, in every mode.

The cover is area-flow. A shared gate is charged once and split across the gates that use it, then the choice is revised with the fanout of that cover. In delay and load mode the second pass may not increase arrival.

`--mode` chooses the cover:

| Mode    | Choice                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------------- |
| `area`  | Smallest legal cell                                                                                       |
| `delay` | Faster cell, sized from a fanout count                                                                    |
| `load`  | Same goal as delay, but delay comes from pin capacitance and the Liberty table. This is the accurate mode |

In load mode the slew out of a gate is the input slew of the next gate. Past the end of a table, the lookup extrapolates, so a wildly large load becomes a large slew. That is the table, not a separate wire.

Sift checks three limits after mapping and prints an `over` line for each miss:

- `max_capacitance` of the cell, or `--max-capacitance` when that is tighter
- `max_fanout` of the cell, or `--max-fanout` when the cell does not have one. The default fallback is 4. The electrical fanout is the sum of the load pin sizes divided by the driver size
- `max_transition` of the cell, or `--max-transition` when that is tighter

Every mode closes max capacitance and max transition with the same pass. The driver is upsized to the smallest cell in its family that meets the load. If none does, the sinks move onto a buffer. If no buffer can take that load, the driver is cloned and the sinks are split across the copies. An explicit max fanout, from the cell or from `--max-fanout`, is closed the same way. Delay and load mode also repair the implicit fanout limit of 4, then size for delay, before that pass. Area mode leaves the implicit limit alone, so a unit library with no capacitance or transition tables still gets no buffers.

A flip-flop is sized the same way in every mode when its Q transition is over the limit. If the largest flop still misses, or its Q capacitance is over the limit, its combinational sinks are buffered. An async reset or preset net is sized, buffered, or cloned the same way. Area mode does not upsize a flop to recover setup slack. Delay and load mode do, up to eight steps, and keep a step only when slack improves and hold does not get worse. A flop that already meets both checks stays where it is.

After that, every mode reorders pins that commute. The later input is moved onto the faster arc. A swap that does not keep the cell function is not tried, and a swap that makes the timed arrival worse is thrown away.

`--recover` runs after sizing, and only when setup slack is greater than 0.02. It tries the next-smaller drive in the same family, combinational cells and flip-flops, largest area save first. A swap is kept only when setup slack stays at least zero, hold slack does not go negative if it started that way, and the swap does not add a capacitance, fanout, or transition violation. It stops after 48 swaps, or sooner when nothing else fits. A path that already misses setup is left alone, and the report then shows zero swaps. A design with no clock is skipped. The line is `recovered A -> B  slack S1 -> S2  N swaps`.

`--gate` finds a flip-flop whose D pin is a nest of muxes that each feed only the next, with the flop's own Q on the disabled leg. `if (en) q <= d` is one mux. `if (ce) if (we) mem[a] <= d` becomes `ce & we & (a == i)`, and every bit of that word shares one clock gate. Constant enables are skipped. An async reset stays on the flop. Flops that share those selects share one latch-based clock gate: the enable is latched while `clk` is low, then AND-ed with `clk`. The unit libraries have no AND, so that gate is a NAND and an inverter. Sky130 uses `and2_1`. The gate cells use named pins. Their delay is added to the launch of those flops and to their capture, so a path inside one gate does not pay it twice. The enable is a half-cycle setup check, printed as `half-cycle` when that endpoint is critical. One flop can grow, because the gate has area of its own; several flops on one enable usually shrink. If nothing matches, the report says `clock gate  none`. `--lec` cuts at the flop's next state, which no longer includes the enable, so `--lec` and `--gate` cannot be combined.

## Timing and constraints

A design with a `clk` input gets a timing report: setup slack, hold slack, the critical edge, and the path. The period defaults to 10. Combo-only designs have no clock report.

Slack is period, minus clock-to-Q, minus the cloud, minus setup, minus output delay. Input delay is how late a primary input arrives. Hold uses the early input arrival. Once `clk` is the clock, it is an ideal net: no clock buffers, no clock latency, and no max-fanout or max-capacitance check on the clock. Clock tree synthesis belongs to place-and-route. The transition on the clock pin is `--clock-slew` or `set_clock_transition`, not a slew computed through buffers.

Wires, in load mode only:

- `--wire-load NAME` picks a model from the Liberty file. The model stores capacitance, resistance, slope, and a fanout-to-length table.
- `--cap-per-fanout N` adds `N` times the number of sinks to every load. It replaces the wire-load model for that run. It is the right model when you do not trust a wire-load table.

### Switches

```text
--period N
--input-delay N
--output-delay N
--input-slew N
--output-load N
--clock-slew N
--max-fanout N
--max-transition N
--max-capacitance N
--recover
--gate
--wire-load NAME
--cap-per-fanout N
```

On the bench, the same numbers are the fields above the results. A per-port line is `name slew=0.1 load=0.02 delay=1.5`, one port per line. A bus bit is the elaborated name, such as `a_0`.

### SDC

`--sdc file.sdc` reads this subset. Anything else, including `set_false_path -through`, is an error. One clock. `-min` and `-max` are accepted and the last value wins. Sift does not keep a separate minimum delay.

```sdc
create_clock -name clk -period 10 [get_ports clk]
set_input_delay -clock clk 1.5 [get_ports {a b}]
set_output_delay -clock clk 0.4 [get_ports y]
set_input_transition 0.2 [all_inputs]
set_load 0.05 [get_ports y]
set_max_fanout 4 [current_design]
set_max_transition 1.5 [current_design]
set_max_capacitance 0.2 [current_design]
set_clock_transition 0.08 [get_clocks clk]
set_clock_uncertainty 0.15 [get_clocks clk]
set_clock_uncertainty -setup 0.2 [get_clocks clk]
set_clock_uncertainty -hold 0.05 [get_clocks clk]
set_multicycle_path 2
set_multicycle_path 1 -hold
set_wire_load_model -name small
set_false_path -from [get_ports rst]
set_false_path -to [get_ports dbg]
set_false_path -hold -from [all_inputs] -to [all_registers]
set_driving_cell -lib_cell sky130_fd_sc_hd__buf_2 -pin Y [all_inputs]
set_driving_cell -lib_cell sky130_fd_sc_hd__inv_2 -pin Y -from_pin A -input_transition_rise 0.02 [get_ports a]
```

`set_driving_cell` sets the cell that drives an input port. The slew at the port is that cell's output transition at the capacitance the port drives. It does not add the cell delay; `set_input_delay` is still the external delay. `-lib_cell` is required. `-pin` is the output pin (`Y` on the unit library, the Liberty pin otherwise). `-from_pin` picks the timing arc. `-input_transition_rise` and `-input_transition_fall` are the slew into the driving cell; if you omit them, Sift uses `set_input_transition` or the library's first characterized slew. A later `set_input_transition` on the same port replaces the driving cell. `--input-slew` does the same for every port that has no driving cell of its own. The cell has to be in the library you map with. `-library` is accepted and ignored. `-clock` is rejected.

`set_clock_uncertainty` subtracts from slack. A bare number applies to setup and hold. `-setup` and `-hold` set one side and leave the other as it was. The clock is the one from `create_clock`, or `*`. With no clock object, it applies to that clock. `-from`, `-to`, and rise/fall are rejected. It does not change the arrival walk or the mapped cells.

`set_multicycle_path N` uses N periods for setup slack. `set_multicycle_path N -hold` checks hold N cycles after the launch edge; N = 0 is that edge. A setup command does not move hold. The usual pair, captured two cycles later with hold one cycle before that capture, is the two lines above. `-setup` is the same as a bare number. Setup and hold on one command is an error. `-from` and `-to` use the same pins as `set_false_path`. A path with many starts ignores `-from`; use `-to` or no pins. The last matching rule wins, and the two sides update separately. Setup N is an integer of at least 1. Hold N is an integer of at least 0. The arrival walk and the mapped cells stay the same. The report prints `cycles N` when setup is not 1 or hold is not 0.

`set_false_path` removes paths from setup, hold, or both. `-from` is a start: a port, `reg/Q`, `[all_inputs]`, or `[all_registers]`. `-to` is an end: a port, `reg/D`, `[all_outputs]`, or `[all_registers]`. One of `-from` or `-to` is required. `-setup` and `-hold` limit the exception to that check; with neither, both checks are dropped. If every path is false, the report says there is no constrained path. A false path does not waive max capacitance, max transition, or max fanout. `-through` is rejected.

`[get_ports d]` and `[get_ports d[*]]` match `d` or the bits `d_0`, `d_1`, and so on. `[all_inputs]`, `[all_outputs]`, and `[current_design]` set the global value.

A command-line switch overrides the same global SDC value. A per-port SDC constraint stays, and it wins over the global for that port.

## Netlist and report files

```bash
npm run sift -- design.v --netlist out.v --timing out.timing --verilog
```

`--netlist` writes structural Verilog. There are no `assign` statements. The cell that drives a port has that port as its output pin. A constant or a feedthrough is a buffer, or two inverters if the library has none. On the unit library, an async reset still connects the reset value as a pin (`1'b0` or `1'b1`). On a Liberty flop, Sift connects the real clear or preset pin. An active-low clear is driven by one shared inverter of the active-high reset.

`--lec` proves that netlist against the Verilog you gave Sift. It is not a comparison with a Yosys-mapped netlist. Sift writes a Verilog model of each library cell, including Liberty flop pins. Gold is elaborated with `proc -norom`, so a combinational `case` stays combinational. Each flop bit is paired with the register it implements (the flop pin itself, or the register an async-reset mux drives). Both sides then replace every flop by its current value and its next value. `yosys-abc` proves those functions match. A latch is not proved. A single-bit X or Z stays one shared input when both netlists still contain it; if synthesis removed it, the proof uses 0. A wider undef fails the proof. The report ends with `lec proved`, or with the failing status. The bench cannot run this check. Yosys must be on `PATH`, or `YOSYS` must name the binary. `yosys-abc` is taken from that same directory, otherwise from `PATH`. The simulation line above this is not that proof: a combinational cloud is exhaustive only through 8 input bits, and a sequential design is an 8-cycle sample.

`--timing` writes the setup line, the hold line, every `over` limit, and both the rise and the fall path.

`--verilog` prints that netlist on stdout as well. `--gates` prints the bit-level netlist before mapping, one gate per line (`id = OP inputs`). `--json` prints a machine-readable report. Passing `--gates` or `--verilog` with `--json` includes the gates or the Verilog in the JSON. When `--recover` or `--gate` ran, the JSON also has `recovery` or `clockGates`. The timing object includes setup and hold uncertainty and the cycle multipliers. A setup multiplier of 0.5 is the clock-gate enable check.

`--buffer-inputs` puts a buffer on every data input. `--buffer-outputs` puts one on every output. `clk` is not buffered. Both are included in the area and the delay. These switches are not in the SDC subset.

## Custom cells

Two passes invent a cell the library does not have, then map again with that cell offered as a pattern. A pattern is wider than the 4-input cut limit. The bench does not run either pass.

The delay and the area are not measured. Both are scaled from the library NAND2. For Sky130 that NAND delay is the NLDM table at the smallest slew and the smallest load (about 0.031 ns for `nand2_1`).

```text
delay = nand.delay * (0.8 + 0.1 * ands)
area  = nand.area  * (0.5 + 0.35 * ands)
```

The new cell has drive 1, the NAND's input capacitance on every pin, and no timing table. In load mode its arc is that formula delay plus the output capacitance. It does not produce its own slew: the input slew is copied to the output, and the next real cell looks its table up at that slew. Each new pin also loads the gate that drives it.

Slack printed after a remap is a new setup check: period, minus setup, minus output delay, minus the worst data arrival. It is not the old slack plus the cover's "saved" figure. That figure is only the mapper's arrival of the folded cone minus the formula delay.

### Repeated cones

```bash
npm run sift -- design.v --propose 8 --mode area
```

`--propose` walks the combinational cloud for AND cones of 3 to 8 gates and at most 8 pins. A shape is kept when it appears at least twice, the library has no NPN match for it (up to 4 pins), and replacing the cover gates would drop at least one cell. Up to N shapes are added as `prop0`, `prop1`, and so on, and the design is mapped again. The report lists what was examined, the cost formula, each cell, and the area and delay before and after.

This pass is for area. A cone that is used once is dropped, so it will not target a single late path.

### Critical path

```bash
npm run sift -- designs/dsp8.v --lib sky130 --mode load --arith delay --crit
```

`--crit` maps once, then decides from that timing report:

| Reason   | Meaning                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `buffer` | Buffer delay on the late path outweighs the logic. Size or buffer it. No new cell.                      |
| `adder`  | The endpoint is an adder sum or carry. Change ripple versus Brent-Kung instead of inventing a function. |
| `cell`   | One cone on the late cover is offered as `crit0`, and the design is mapped again.                       |
| `none`   | No cone of 2 to 8 pins was both legal and faster than the cover's own arrival.                          |

The cone is taken from the mapper's late pin, not from a second timer. It may be two to four cover gates, or the whole cone down to the primary inputs when that stays within 8 pins and 8 ANDs. One cell, one remap. If the cover does not use `crit0`, the first netlist is kept and the slack does not change.

A kept cell can still lose slack. The cover accepts the formula delay. The setup check then sees that delay, the extra pin load, and the Sky130 tables on the rest of the path. On `fir10` and `dsp8` the cell that was kept was a 25-AND cone priced at 0.104 ns, and the slack did not improve.

## Knob search

```bash
npm run sift -- design.v --lib sky130 --period 10 --opt area
```

`--opt area` meets the period, then takes the smallest area. `--opt delay` takes the largest setup slack, then the smallest area. A design with no clock uses the combinational delay instead of slack. A step that makes hold slack negative, when it was not, is dropped. A clock gate on a flop fed straight from a primary input often fails that check: the gated clock is late, and the input is still timed at 0.

The search starts from the defaults: `--mode area`, `--arith area`, no `--ppa`, no `--gate`, no `--recover`, and the library fanout fallback. It maps that point, then changes one knob at a time and keeps the step only when the score improves. A miss, or a delay objective, tries the timed cover (`load` when the library has tables, otherwise `delay`), `--arith delay`, `--ppa 1`, a clock gate, and a tighter fanout if a fanout or slew limit is already missed. Once an area objective meets the period, it tries a clock gate, `--ppa 0`, the area arithmetic, the area cover, `--recover`, and a looser fanout. It stops after eight maps, or when the next step does not help. Each map is printed as it finishes.

A knob you set is fixed. `--mode load --opt area` will not leave load mode, and `--gate` stays on. `--opt` does not search buffers, wire load, `--propose`, or `--crit`, and it cannot be combined with those last two. `--lec` still cannot prove a gated clock. If the search keeps a clock gate, drop `--lec`. A JSON netlist has no Verilog to re-elaborate, so `--arith` stays where it started. The period, input and output delays, and the other SDC values are the constraint, not knobs.

## Examples

The bench lists them. Verilog sources are the `source` strings in [src/synth/examples.ts](../src/synth/examples.ts). Gate-level ones are the `EXAMPLES` array in the same file.

Start with `adder.v` and `counter.v`. `en.v` is a 4-bit load enable, the example for clock gating. The larger designs are files under [designs/](../designs/). `cpu8.v` is an 8-bit CPU with a ROM, a register file, and an ALU. `dsp8.v`, `fir10.v`, and `xfir.v` are an 8-bit DSP slice, a 10-tap 8-bit FIR, and a dual inner product of the same registers. `npm run test:designs` maps those four and proves the netlist against that Verilog when Yosys is available. `uart_apb.v`, `risc8.v`, `pic16.v`, `pic1826.v`, `p16c5x.v`, `arlet6502.v`, `x18.v`, and `chacha.v` are on the delay bench only: a UART-to-APB master, a PIC16C5x-compatible CPU, the PIC16C5x itself with the clock port renamed from `Clk` to `clk`, a PIC16F1826-style CPU with the stack, ROM, and RAM stubbed, Morris's pipelined P16C5x (also clock `clk`), Arlet's 6502, Arlet's X18 with the program image replaced by the address, and a memory-mapped ChaCha. `mem.v` is a 16-word register file and stays in the bench list only. `macro.v` is `` `define `` and `` `ifdef ``. `case.v` is a decoder. `window.v` is a constant-width part-select. `fsm.v` is a clocked `case`. `uart.v` is a UART. `sreg.v` is a shift register. `grow.v` is a generate loop. `genif.v` is `generate if`. `latch.v` is there to show the latch warning. `gray.v` is a Gray counter, `lzd.v` a leading-one index, `pop.v` a popcount, `edges.v` an edge detector, `lfsr.v` a shift register with XOR feedback, `pwm.v` a compare, `dec.v` a one-hot decode that shows the fanout buffers, and `fifo.v` a four-word queue.
