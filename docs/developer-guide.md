# Sift developer guide

Sift is a Verilog-to-gates synthesizer and a Liberty technology mapper, written in TypeScript. Mapping does not call Yosys, ABC, or OpenSTA. `--lec` does: it shells out to Yosys and `yosys-abc`. The bench is a thin page over the same functions the command line calls.

## Pipeline

```text
Verilog or JSON
    loadDesign            src/synth/verilog.ts
    Netlist               bit gates: INV AND OR XOR MUX DFF LATCH
    insertClockGates      src/synth/clkgate.ts optional, before the cloud
    flopsOf / comboCloud  src/synth/seq.ts
    subjectGraph          src/synth/aig.ts     AND-inverter graph
    mapNetlist            src/synth/map.ts     cuts, cover, size, time
    mapDesign             src/synth/seq.ts     flops, ideal clock, setup, hold, optional recovery
    DesignReport          area, paths, structural Verilog, equivalence
```

`loadDesign` in [src/synth/verilog.ts](../src/synth/verilog.ts) accepts either a Verilog module or the JSON netlist from [src/synth/netlist.ts](../src/synth/netlist.ts). The CLI in [src/synth/cli.ts](../src/synth/cli.ts) and the bench in [src/components/sift-bench.tsx](../src/components/sift-bench.tsx) both stop at `mapDesign`. A continuous assignment or a port connection creates a 1-bit wire for an undeclared name. `translate_off` through `translate_on` is dropped, in either comment form. A value wider than its context keeps the low bits. Combinational `always` accepts `<=`.

Everyday equivalence is simulation of the mapped cells against the elaborated gates, not against the Verilog. Combo designs are exhaustive up to 8 input bits and sampled after that. A sequential design is an 8-cycle trace, so that report is sampled, not a proof. `--lec` is the proof: the mapped netlist and the Verilog are cut at paired flop bits, and ABC proves the next-state and output functions.

## Modules

| File                                    | Responsibility                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [verilog.ts](../src/synth/verilog.ts)   | Lex, parse, elaborate. Bit-blasts, unrolls constant `for` and `generate`, lowers arithmetic through [arith.ts](../src/synth/arith.ts) |
| [arith.ts](../src/synth/arith.ts)       | Ripple or prefix add, array or Wallace multiply, restoring divide                                                                     |
| [netlist.ts](../src/synth/netlist.ts)   | `Netlist` type, validation, topological eval, dead-gate sweep                                                                         |
| [aig.ts](../src/synth/aig.ts)           | Subject graph, constant folding, structural hash, `shrink`                                                                            |
| [aig-opt.ts](../src/synth/aig-opt.ts)   | Rewrite, balance, functional sweep, refactor                                                                                          |
| [library.ts](../src/synth/library.ts)   | `Cell`, `FlopCell`, wire-load length, the `min` and `std` libraries                                                                   |
| [liberty.ts](../src/synth/liberty.ts)   | Liberty parser. Functions, NLDM tables, `when` arcs, pin caps, wire loads                                                             |
| [sky130hd.ts](../src/synth/sky130hd.ts) | `sky130Hd()` returns the reduced library in [sky130hd.lib.ts](../src/synth/sky130hd.lib.ts)                                           |
| [map.ts](../src/synth/map.ts)           | Cut enumeration (K = 4), area/delay/load cover, pattern seeds, drive sizing, slew propagation, structural Verilog                     |
| [seq.ts](../src/synth/seq.ts)           | Flop extraction, combo cloud, ideal clock, setup and hold, area recovery                                                              |
| [propose.ts](../src/synth/propose.ts)   | Repeated-cone miner. Adds `propN` cells and remaps                                                                                    |
| [crit.ts](../src/synth/crit.ts)         | One cell for the late path. Vetoes a buffer path and an adder endpoint                                                                |
| [clkgate.ts](../src/synth/clkgate.ts)   | Nested enable muxes become one latch-based clock gate per enable                                                                      |
| [opt.ts](../src/synth/opt.ts)           | `--opt` maps a starting recipe, then keeps a one-knob step when the objective improves                                                |
| [sdc.ts](../src/synth/sdc.ts)           | SDC subset to a `Constraints` object                                                                                                  |
| [cli.ts](../src/synth/cli.ts)           | Arguments, file output, process exit                                                                                                  |
| [lec.ts](../src/synth/lec.ts)           | Yosys elaboration and ABC equivalence of the mapped netlist                                                                           |
| [examples.ts](../src/synth/examples.ts) | Bench examples, gate-level and Verilog                                                                                                |

## Netlist

A `Netlist` is a name, input bit names, output bit names, and gates. A 4-bit port `a` becomes `a_0` through `a_3`, LSB first in the vector sense (`a_0` is bit 0). The clock is not a data input. `clk` is rejected if it appears as a gate pin.

```ts
interface Netlist {
  name: string;
  inputs: string[];
  outputs: string[];
  gates: { id: string; op: Op; ins: string[] }[];
  warnings?: string[];
  notes?: string[];
  clockGates?: { id: string; en: string; level: 0 | 1; flops: string[] }[];
}
```

`Op` is `INV | AND | OR | XOR | MUX | DFF | LATCH`. `MUX` pins are select, then the true data, then the false data. A `DFF` with a reset is `ins = [d, rst, rstValue]`. Constants are the nets `"0"` and `"1"`. `clockGates` is absent until the gating pass runs. An empty array means it ran and found no enable, so a later `mapDesign` does not try again. Do not add a clock-gate `Op`. The gate is structural cells plus this side table.

`validate` rejects a combinational cycle, a missing driver, and a latch that was not asked for. Latch warnings are strings on `warnings`, not errors. The elaborator sets them when a combo `if` or `case` leaves a reg unassigned.

## Elaborate

[verilog.ts](../src/synth/verilog.ts) is one recursive-descent parser and one elaborator. Width is capped by `MAX_WIDTH` (512). A constant bit is peeled by division, not a JavaScript shift, so bit 31 of a 32-bit value stays exact. Memory depth is capped at 128 words and 1024 bits. A variable memory read is a balanced OR of `AND(word bit, address match)`, so a pair of products is a 4-input cut. The address compare is shared across the byte. `localparam` is folded into the same map as header parameters before widths are resolved. `logic` becomes a `reg` only when an `always` assigns that name.

Operators lower to gates in the elaborator, not in the mapper. `+` and `-` call `addBits`: ripple carry for `--arith area`, Brent-Kung for `--arith delay`. A multiplier's final adder and each divider-row subtract are recorded as adder sites too. An adder is cached by its operands and carry-in, so `a - b` and `a < b` (and `a >= b`) share one subtract, including the inverted operand. The mapper never sees an adder, only ANDs, XORs, and muxes. `--arith` is the starting point. `tuneAdders` then rewrites each site to ripple, lookahead, or Brent-Kung from the setup slack of the endpoints in its fanout. Lookahead is a 4-bit group carry-lookahead with a Brent-Kung prefix between groups, so its depth and gate count sit between the other two. The slack comes from the same constraints as the timing report: period, I/O delay, uncertainty, multicycle, and false paths. The level gap is priced at the critical path's nanoseconds per level. Each site's weight is `clamp(1 - slack / period, 0, 1)`, shifted by `--ppa - 0.5` when that bias is set. A site steps down only when the slack left after the gap is still above `0.02 + weight * gap`. A loose path therefore demotes; a path that just meets does not. A miss whose weight is at least 0.5 goes straight to Brent-Kung; below that, lookahead is tried first. One remap checks the result; a miss drops the tightest demotion and tries once more. Hold slack is not allowed to go from met to missed.

A constant `for` substitutes the index through `loopVars` and unrolls. `generate` unrolls at module scope and suffixes names. An indexed part-select with a constant base becomes a slice. A variable base becomes a mux, and an out-of-range bit is 0. `a[hi:lo]` is the same mux when `hi - lo + 1` simplifies to a constant, including forms such as `a[i+3:i]`. A width that still depends on a signal is an error.

`connect` renames a private `_t` net onto its single sink. Anything else, including a flop output, is buffered with two inverters so the netlist stays single-driver. That is why `assign q = s` is not a wire alias.

## Logic optimization

`subjectGraph` sweeps the AIG, then [aig-opt.ts](../src/synth/aig-opt.ts) runs five passes before the mapper sees the graph. `area` accepts a rewrite only when the AND count drops. `delay` and `load` also accept a shallower network when the count does not grow.

1. **Rewrite.** For each AND, try a cut of at most four leaves. That truth table is resynthesized over every variable order, and the cone is replaced only when the maximum fanout-free cone shrinks. A node used outside the cone is kept. The pass repeats, then structural hashing runs again.
2. **Resubstitution.** A node's own support is the cut when it has at most eight inputs; otherwise the MFFC boundary is, on the same limit. Zero-resub replaces the node by an existing signal whose truth table matches. One-resub replaces it by one new AND of two such signals. The proof is exhaustive on that cut, not the simulator. Divisors are other nodes whose support sits inside the cut.
3. **Balance.** A fanout-free AND tree is rebuilt by pairing the shallowest leaves first. Inverters are free, so an OR tree is the same AND tree seen through a complemented edge. Node count does not grow. Area mode does one pass. Delay and load repeat.
4. **Functional sweep.** Nodes are simulated. A later node is replaced by an earlier node, or by a primary input, only when their support has at most ten inputs and exhaustive evaluation agrees. The simulator is a filter, not the proof.
5. **Refactor.** An MFFC of four to sixteen ANDs whose boundary has at most six leaves is resynthesized from that boundary. Five inputs are exact. Six inputs use a greedy Shannon order. This is what factors `a&b | a&c | a&d | a&e` after 4-cuts have stopped.

If refactor removed nodes, resubstitution runs again. If sweep, refactor, or resubstitution removed nodes, rewrite runs once more. Delay and load then balance once more. Equivalence of the AIG is still the simulator in `shrink` and `mapNetlist`. `--lec` is the proof of the mapped netlist against the Verilog, including flop bits that are not ports.

## Map

`mapNetlist` builds the subject graph, enumerates cuts, and picks a cover.

- `area` prefers the smallest area-flow. A match costs its cell area plus the flow of each leaf, and a leaf's flow is that match divided by how many times the cover uses that polarity. A complemented input does not share an inverter with the true input. A second iteration recomputes the flow from the cover that was just chosen.
- `delay` uses a unit-delay estimate and `pickByFanout` (drive 1, then the middle drive, then the strongest). Arrival wins over flow. The second iteration may not exceed the first iteration's arrival.
- `load` uses pin capacitance. `arrivals` looks up the NLDM table with the incoming slew and the output load, and records the output slew for the next gate. The first cover is the delay cover. When `arrivalBudget` beats that cover by more than 0.02, a second cover may spend the slack: every literal's cap is its fast arrival plus the slack, and the backward walk tightens nodes already on the fast cover. Within the cap, area wins, so a cut the fast cover skipped can still be chosen.

`prepareDrive` ends in `repairLimits` in every mode. That pass upsizes a driver, then buffers its sinks, then clones the driver, until max capacitance and max transition are met. An explicit max fanout is closed there too. Delay and load still legalize `DEFAULT_MAX_FANOUT` (20) and size for delay before that pass. Area does not insert those buffers when the library states no max fanout and the query states no max fanout, so a direct area-mode map of the unit library still inserts no fanout buffers. `mapDesign` and the command line fill that default, so a normal run uses 20 on every library. A cell `max_fanout` replaces it. Electrical fanout is the sum of load sizes divided by the driver size. A buffer layer is kept when it strictly cuts the driver load, so a net that one layer cannot legalize grows a tree on the next pass. Buffers are scored at the driver slew after that load drops. A clone still has to make its copy legal. `reorderInputs` runs in every mode before that repair. Pins are grouped by swapping bits in the cell function. A group is reordered so the output arrival falls, and the pass is kept only when the timed delay does not rise. Three passes are enough for the slew of one gate to settle into the next.

Flip-flops are chosen by `pickFlop`: the smallest drive that meets `max_capacitance` and `max_fanout` when the cell has those limits, otherwise the fanout bucket in delay mode and the smallest cell in area mode. `sizeFlops` then runs in every mode. It steps a flop up while `qSlew` is over `max_transition` (the tighter of the cell and `--max-transition`) and keeps that step even when slack gets worse. If the flop still misses, combinational Q sinks move onto buffers and the cloud is repaired again at the flop's real output slew. Q capacitance is closed by the same pass, which buffers the sinks. An async reset or preset inverter uses that pass too: the pin capacitance of the clear or preset pin is the load, and the net is upsized, buffered, or cloned until its capacitance and slew meet the limit. While setup slack is negative, delay and load mode also try the next drive of the launching flop, at most eight times, and keep a step only when slack improves and hold does not get worse.

After legalization, `stitchTies` removes `assign` from the structural Verilog. A gate that only feeds one port is renamed so its output pin is the port. A constant is a buffer driven by `1'b0` or `1'b1`, or an inverter from the opposite constant when the library has no buffer. A feedthrough is the same buffer. `isolatePorts` runs only when `ArrivalQuery.bufferInputs` or `bufferOutputs` is set. Those sets are the primary-port names. Flop outputs that are also ports are buffered later in `mapDesign`, because they are not combo-cloud gates.

`evalMapped` simulates the mapped cells, including `1'b0` and `1'b1` on pins, and compares them to `evalNetlist`.

A `PatternSeed` bypasses the K = 4 cut match. It names a library cell, the subject-graph leaves, and a polarity per leaf. `outputInv` offers that cell to the negative cover. Seeds that omit it still update only the positive cover. The cover does not re-check the cell function. Equivalence is the simulator, and `--lec` when you ask for it.

## Custom cells

[propose.ts](../src/synth/propose.ts) and [crit.ts](../src/synth/crit.ts) both append a synthetic cell and call `mapDesign` with seeds. They share `coneFragment`, `coveredByLibrary`, and `estimatedCell`.

`estimatedCell` copies the reference NAND2 found by `referenceCell` (the smallest 2-input NAND in `baseCells`, else any 2-input cell, else the inverter):

```text
area  = nand.area  * (0.5 + 0.35 * ands)
delay = nand.delay * (0.8 + 0.1 * ands)
```

`nand.delay` is the Liberty scalar, which is `tableDelay` at the first load index and the first slew. The synthetic cell stores that number only. It has no `table`, no `arcs`, and no `slew`. Drive is 1. Every input pin uses the NAND input capacitance.

In `arrivals`, a gate with no table uses `cell.delay + Cload / drive`. Sense is `non`, so the latest input edge wins. Output slew is the input slew, unchanged. Downstream Sky130 cells then index their own tables at that slew. The extra pin caps slow the drivers through those tables. None of that is inside the "saved" number the critical-path report prints.

### Area miner

`proposeDesign` enumerates AND cones of `MIN_ANDS` (3) to `MAX_ANDS` (8) pins, at most `MAX_PINS` (8). Cones are grouped by canonical shape and truth table. A group is dropped when:

- some base cell already matches the function after dropping unused pins, for width 2 to 4
- it occurs fewer than `MIN_HITS` (2) times
- the score is not positive

The score is the sum of `coverCells - 1` over the hits. The top `--propose` groups (default 8) become `prop0` onward. Seeds carry no `outputInv`. The second map's area and delay are the report's "after". This miner is the wrong tool for a single late cone, because a one-use cone is dropped.

### Critical path

`critDesign` maps first, then classifies the STA endpoint of that report.

- `adderKind` matches the flop D, the endpoint name, or the flop Q against `AdderSite.sums` and `cout` on the original netlist. The combo cloud does not carry adder sites, so the check has to use the pre-cloud netlist. The note names `ripple`, `lookahead`, or `brent-kung`.
- `bufferDominated` sums path increments whose label is an `isBuffer` cell and compares that with the other library cells on the path. Wires and the endpoint name are ignored.
- Otherwise `criticalSpine` runs `chooseCover` with no seeds and walks the late pin from the worst output. An inverter hop flips polarity on the same node and is not a cell. The walk stops at 64 hops.

`bestStretch` scores two kinds of cone. For each cell hop it takes the AND cone down to the primary inputs. It also slides a window of 2 to 4 cell hops along that spine. A candidate needs 2 to 8 pins and at least 2 ANDs, must not be `coveredByLibrary`, and must beat the cover arrival by more than 0.05:

```text
saved = (hop arrival − latest leaf arrival) − estimatedCell.delay
```

Leaf arrivals that are not on the window, including primary inputs, are 0. The best saved value wins. Ties prefer fewer ANDs. One seed is planted on that root. `outputInv` is set when the hop polarity is negative, and the cell function is the complement, because a positive AND in the `min` library is an inverter on top of a NAND.

The remap is kept only when `crit0` appears in the mapped cell list. Slack and delay in the report are `DesignReport.timing` and `DesignReport.delay` from that map, or from the first map when the cell is unused. A positive `saved` does not mean the setup slack improved.

### Area recovery

`Constraints.recover` (CLI `--recover`, or "recover area" on the bench) runs after the timed map, and only when setup slack is greater than 0.02. `evaluate` is the same setup and hold walk as the report. Each trial replaces one gate or one flop with the next-smaller drive in its family, largest area save first. The trial is kept when setup slack stays non-negative, hold slack stays non-negative if it started that way, `limitHits` does not grow, and area drops. The loop stops after 48 swaps or when no swap fits. `DesignReport.recovery` records the area and slack before and after. Port-buffer area and clock-gate area are included in both numbers. Combo-only designs skip the pass. Cell names in the report are read from `combo.gates` after the swaps, because the cover's cell list is not rewritten. If adder tuning remaps, recovery runs on that second map, and that report is the one returned.

### Clock gating

`Constraints.clockGate` (CLI `--gate`, or "clock gate" on the bench) calls `insertClockGates` before mapping. A hit is a `DFF` whose D pin is a nest of `MUX`es that each feed only the next mux, with one data leg equal to the flop's Q. One mux is `if (en) q <= d`. A memory word `if (ce) if (we) mem[a] <= d` peels to `ce & we & (a == i)`, and the eight bits share that AND. Constant enables are ignored. An async reset stays on the flop; a reset mux is not peeled, because neither leg is Q. Hits that share the same selects become one `ClockGate`. The muxes are removed and the flop's D becomes the data leg. A single select keeps its polarity. Two or more are AND-ed into one active-high enable. The enable is passed to `comboCloud` as an extra output so its cone is mapped instead of swept. `flopsOf` stores the enable on `Flop.clock`, and `step` holds Q when the enable is off. The cycle trace is the check. The gate cells are not simulated as logic, and they are not added to `report.gates`, so the timer does not treat them as data paths.

`realizeClockGates` builds the gate from the smallest latch, an inverter on `clk` so the latch is transparent while `clk` is low, and the smallest 2-input AND. The `std` and `min` libraries have no AND, so the gate is a NAND plus an inverter. An active-low enable is inverted into the latch. The structural Verilog uses named pins (`.Y`, `.GATE`, `.CLK`) even when the flop itself is positional. The flop's clock pin is that AND (or inverter) output, not `clk`. `clockLatency` stays 0. The gate delay is launch latency on those Q pins and capture latency on those D pins, so it cancels on a path that launches and captures inside the same gate. In load mode the delay is the NLDM arc. Otherwise it is the cell delay plus a fanout term. The enable is an extra setup endpoint, `id/EN`, with `setupCycles` 0.5. That required time is half the period, minus the latch setup and the clock-inverter delay. The printed slack line says `half-cycle`.

`--lec` is rejected together with `--gate`. The proof cuts at the next-state pin, and the gated flop's next state is the data pin, not the recirculation mux.

## Sequential

`comboCloud` drops the flops and treats each flop Q as an input of the cloud and each flop D as an output of the cloud. `mapNetlist` maps that cloud. `mapDesign` picks a flop cell per Q and runs `arrivals` twice: once for setup (`extreme` defaults to max) and once for hold (`extreme: "min"`).

`clk` is an ideal net. Sift does not build a clock tree and does not put clock latency on the path. `clockLatency` in the report is 0. The clock pin uses `clockTransition` as its slew and is not checked for fanout or capacitance. CTS is left to place-and-route.

A Liberty flop with `seq` pins is emitted with named connections (`.Q`, `.D`, `.CLK`, `.RESET_B`). The unit-library flops have no `seq` record and stay positional, including the reset-value constant. When the Liberty clear or preset is active-low, one inverter of the active-high reset is shared by every flop on that net (`_rstn_<net>`). A reset value the cell cannot express is an error.

`falsePaths` drops endpoints from the setup walk, the hold walk, or both. `-to` with no `-from` removes the endpoint. `-from` reruns the arrival walk with those startpoints removed, because one wire otherwise keeps only the worst arrival. A path that is still not finite after that is unconstrained. The netlist and the `over` limits are unchanged.

`` `include ``, `` `define ``, `` `undef ``, and `` `ifdef `` / `` `ifndef `` / `` `elsif `` / `` `else `` / `` `endif `` are expanded before parsing. An include is read from the directory of the file that includes it. `parseSources` preprocesses every file with one macro table, so a define in an earlier file is visible later. The bench has no `read`, so `` `include `` in the page text is an error; `` `define `` in the page text works. The top module is the one nothing instantiates, unless `top` is set. A repeated module name is an error.

`Constraints` is the contract shared by the CLI, the SDC parser, and the bench:

```ts
interface Constraints {
  period: number;
  inputTransition?: number;
  outputLoad?: number;
  inputDelay?: number;
  outputDelay?: number;
  maxFanout?: number;
  maxTransition?: number;
  maxCapacitance?: number;
  clockTransition?: number;
  setupUncertainty?: number;
  holdUncertainty?: number;
  wireLoad?: string;
  capPerFanout?: number;
  ports?: Record<string, { slew?: number; load?: number; delay?: number }>;
  falsePaths?: FalsePath[];
  multiCycles?: MultiCycle[];
  drivingCell?: { cell: string; pin?: string; fromPin?: string; rise?: number; fall?: number };
  bufferInputs?: boolean;
  bufferOutputs?: boolean;
  recover?: boolean;
  clockGate?: boolean;
}
```

`normalize` fills defaults and rejects a negative delay, a negative max transition, a negative max capacitance, a negative clock uncertainty, a multicycle that is not an integer, or a max fanout below 1. `recover` and `clockGate` stay off unless set. `setupUncertainty` comes off the setup slack. `holdUncertainty` comes off the hold slack. `multiCycles` changes only the slack: setup uses `setupCycles * period` (default 1) and hold subtracts `holdCycles * period` (default 0). A setup rule does not change hold. A cloud path ignores `-from`. Neither uncertainty nor a multicycle changes the arrival walk or the mapped cells. A per-port `delay` overrides the global on that input or output. A per-port `slew` or `load` overrides the global pin constraint. `drivingCell` is resolved when the net is timed: the port slew is the cell's output transition at the net capacitance, unless that port has an explicit slew. `maxTransition` and `maxCapacitance` are design limits. The check uses the tighter of the design limit and the cell limit.

`capPerFanout` adds `pins * cap` inside `capOf`. It is not applied to `clk`. When it is set, the Liberty wire-load model is not also added. `wireLoad: "none"` suppresses the library default.

## Liberty

`parseLiberty` does not implement the whole Liberty language. It reads library-level wire loads and default wire load, and per cell: area, pin direction, capacitance, function, `max_capacitance`, `max_fanout`, `max_transition`, and timing arcs with `related_pin`, `timing_sense`, `timing_type`, `when`, and `cell_rise` / `cell_fall` / `rise_transition` / `fall_transition` tables. An `ff` or `latch` group stores `FlopCell.seq`. Q is the timing output pin, not the internal `IQ`. `clear : "!RESET_B"` is active-low.

`tableEdge` interpolates inside the slew and load indexes and extrapolates linearly outside them. A `when` arc is ignored unless the condition is satisfiable for that input pattern.

Adding a cell family to `std` means a `unit(...)` cell plus a row in `STD_LIBRARY`. The mapper discovers inverters and buffers with `isInverter` and `isBuffer`. It does not have a list of cell names. A new Liberty function works if it fits a 4-input cut. Wider functions never match and the cover falls back to smaller cells.

## SDC

[sdc.ts](../src/synth/sdc.ts) tokenizes a subset and returns `Constraints`. Keep a new command in that set only when `Constraints` has a field for it. `parseSdc` throws `SdcError` with a line number. The CLI prints that and exits 1.

Port matching is exact, then `name_<digits>`, then a trailing `*`. The elaborator’s bit names are the match space, so the SDC file is applied after `loadDesign`.

## Command line

`run(argv)` is exported so [cli.test.ts](../src/synth/cli.test.ts) can spawn `node --experimental-strip-types src/synth/cli.ts`. `npm run sift` is that entry. `isMain` guards the `process.exit` so importing the module from a test does not exit.

`--json` is the stable machine interface. Add a field there only when a caller needs it. The human report and `--timing` are not stable text. `--lec` adds `lec.proved` and `lec.text` to the JSON. It shells out to Yosys (`YOSYS`, else a known local binary, else `yosys` on `PATH`) and proves the mapped netlist against the original Verilog in [lec.ts](../src/synth/lec.ts). Gold is the RTL, not a Yosys-mapped netlist. Flop bits are paired by register name, cut to current and next state, written as AIGER, and compared with `yosys-abc` (`&cec`). A latch fails. A single-bit X or Z stays one shared input when both netlists still contain it; if synthesis removed it, the proof uses 0. A wider undef fails. `SIFT_LEC_KEEP=1` leaves the temporary directory. The bench does not offer the proof. `--propose` and `--crit` add `proposals` and `critical` to the JSON. `--recover` and `--gate` add `recovery` and `clockGates` when those passes ran. An empty `clockGates` array means gating found nothing. Do not combine `--lec` with `--gate`. `--lec` together with `--crit` still proves against the library before `crit0` was added, so do not combine those either.

The bench does not call the CLI. A new constraint has to be added in three places: `Constraints`, the CLI flags and `constraintsOf`, and the bench state in [sift-bench.tsx](../src/components/sift-bench.tsx). `recover` and `clockGate` are on the bench. Port buffers, SDC, `--propose`, and `--crit` are CLI-only on purpose.

## Tests

```bash
npm run typecheck
npm test
node --experimental-strip-types --test src/synth/liberty.test.ts
```

`npm test` runs the application tests and the synth tests listed in `package.json`, including `propose.test.ts`, `crit.test.ts`, and `designs.test.ts`. `npm run test:designs` is that last file alone: it maps every Verilog file under `designs/` and, when Yosys is available, proves the netlist. Without Yosys it only checks that the cycle trace matches. `liberty.test.ts` is separate. Verilog tests elaborate and simulate. Map tests compare area, cell choice, and equivalence across `area`, `delay`, and `load`. Liberty tests use inline Liberty strings and the Sky130 sample. CLI tests spawn the binary.

When a change alters the structural Verilog, search for `assign` in the tests. The mapped netlist is not allowed to contain an `assign` statement. The CLI refuses to finish if one appears.

## Extending the language

Add the token in the lexer, the expression or statement in the parser, and the lowering in the elaborator. Return bits, do not invent a new `Op` unless the mapper must see it. If the construct can infer a latch, push a warning the same way the `if` path does. Add a Verilog example in `VERILOG` and a simulation test in [verilog.test.ts](../src/synth/verilog.test.ts) that compares `evalNetlist` to the expected bits.

Reject what you do not implement. `this.fail("... is later")` is the existing pattern. Do not silently drop a statement.
