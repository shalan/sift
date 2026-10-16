<p align="center">
  <img src="docs/logo.svg" alt="Sift" width="720">
</p>

Sift reads Verilog and maps it onto a standard-cell library. It lowers a module to an AND-inverter graph, covers that graph, and reports area, cell count, and setup slack. The mapped netlist is structural Verilog with no `assign`.

The same functions drive the command line and the bench page. There is no floorplan, no clock tree, and no multi-corner analysis. Wire cost is a model you pass in.

Mohamed Shalan · [mshalan@aucegypt.edu](mailto:mshalan@aucegypt.edu)

## Features

- Verilog subset in, structural Verilog out. `assign`, `always`, `generate`, macros, signed arithmetic, memories, and async reset lower to gates. The mapped netlist has no `assign`.
- AND-inverter graph, then a 4-input area-flow cover. Area mode spends the rewriting on fewer gates. Delay and load mode may take a shallower tree when it does not add gates.
- Three goals. `area` keeps the smallest legal cell. `delay` sizes from a fanout count. `load` times from pin capacitance and NLDM tables.
- Libraries. `std` and `min` are unit-delay. `sky130` is a reduced Sky130 HD library. Any Liberty file with an inverter can be the target.
- Adders and multipliers. Ripple and an array multiplier, or Brent-Kung and a Wallace tree. After mapping, each adder is chosen again from the slack at its endpoints. `--ppa` biases that choice.
- Electrical limits in every mode. A driver that misses max capacitance or max transition is upsized, then buffered, then cloned, when the library can meet the load. An explicit max fanout uses the same pass. A miss that cannot be repaired stays in the report.
- Timing. Setup and hold on an ideal clock named `clk`, with period, input and output delay, input slew, output load, clock slew, a Liberty wire-load, or capacitance per fanout. An SDC subset covers the same constraints.
- Area recovery and clock gating, both off unless asked. `--recover` downsizes a cell while setup slack stays non-negative and no limit hit is added. `--gate` replaces a nest of enable muxes with one latch-based clock gate.
- `--opt area` meets the period and then shrinks area. `--opt delay` grows slack. The search changes one free knob at a time, and a knob you set stays fixed.
- Simulation of every output, a JSON report, and `--lec` to prove the netlist against the RTL with Yosys.
- `--propose` and `--crit` mine a repeated cone, or the late path, for one new cell priced from the library NAND2, then remap.
- The same mapper drives the command line and the bench page.

<p align="center">
  <img src="docs/bench.png" alt="Sift bench, mapping a shared adder in area mode" width="720">
</p>

## Run

Node 22. The command line runs TypeScript directly.

```bash
npm install
npm run sift -- designs/dsp8.v --lib sky130 --mode load --arith delay --period 10 --max-fanout 10
```

`--lib` is `std` (default), `min`, `sky130`, or a Liberty file. `--mode` is `area`, `delay`, or `load`. Load mode times gates from pin capacitance and NLDM tables. `--arith delay` builds Brent-Kung adders and a Wallace multiplier; the default is a ripple adder and an array multiplier. `--ppa N` (0 to 1) biases that choice toward area or delay. Slack still sets each adder's weight: near the period it spends area, near zero it keeps delay. `--recover` spends positive setup slack on a smaller drive. `--gate` replaces a nest of enable muxes with one latch-based clock gate, so a memory word shares one gate. Both stay off unless you ask. `--opt area` meets the period and then shrinks area; `--opt delay` grows slack. It starts from those defaults and changes one free knob at a time. A knob you set stays fixed. `--lec` cannot be combined with `--gate`.

```bash
npm run sift -- top.v leaf.v --top top --lib sky130 --mode load --sdc design.sdc --netlist out.v --timing out.timing
npm run sift -- design.v --lec          # prove the netlist against the RTL with Yosys
npm test
npm run typecheck
npm run dev                             # bench UI
```

Exit status is 0 when every simulated output matches. It is 1 on a syntax error, a mapping error, a mismatch, or a failed `--lec` proof.

`--lec` needs Yosys. The delay bench in `scripts/bench-delay.ts` also needs OpenSTA. Paths can be set with `SIFT_YOSYS`, `SIFT_STA`, `SIFT_SKY130_LIB`, and `SIFT_BENCH_ROOT`.

## Benchmark against Yosys

Eighteen designs, same 24 Sky130 HD cells, flat netlists, period 8 ns, input and output delay 0. Input slew is 0.01 ns. The output load is one inverter pin (2.302 fF). Wires are pin capacitance only. OpenSTA scores both netlists: area in µm², setup slack and the worst slew in nanoseconds, total power in µW. Sift is `--opt area` with max fanout 9. The search starts at area mode and changes one knob at a time, up to eight maps, and the runtime includes every map. Yosys is `synth -flatten`, `dfflibmap`, then `abc -D 8000` with the same output load and no fanout cap. Columns are Sift / Yosys.

| Design | What | Cells | Area µm² | Slack ns | Slew ns | Power µW | Runtime s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cpu8 | 8-bit CPU, register file, and ALU | 653/693 | 4815.9/4606.9 | 3.348/4.181 | 4.023/0.442 | 502.85/556.68 | 3.09/0.61 |
| dsp8 | 8-bit DSP slice: product, MAC, delay line | 1155/1069 | 6802.8/6535.0 | 1.292/3.522 | 1.899/0.402 | 591.97/584.44 | 4.85/0.70 |
| fir10 | 10-tap 8-bit FIR | 4620/4903 | 28214.6/29907.4 | 0.347/1.596 | 3.650/0.298 | 1871.83/1946.17 | 18.37/3.17 |
| xfir | dual 10-tap inner product | 10553/9081 | 56963.4/53869.2 | 0.086/0.864 | 0.259/0.297 | 2958.32/2845.83 | 98.38/4.58 |
| uart | UART | 302/223 | 2039.5/1680.4 | 5.253/6.534 | 1.502/0.417 | 268.39/273.27 | 2.36/0.30 |
| fifo | four-word FIFO | 282/172 | 1931.9/1686.6 | 6.396/6.182 | 0.740/0.502 | 253.92/247.75 | 0.96/0.23 |
| mem | 16×8 register file | 776/506 | 5973.2/5167.5 | 4.030/6.733 | 4.957/0.502 | 822.03/776.26 | 1.21/0.32 |
| pwm | PWM compare | 27/29 | 182.7/205.2 | 7.269/7.230 | 0.124/0.146 | 24.93/25.50 | 0.32/0.17 |
| lfsr | LFSR | 28/26 | 267.8/240.2 | 7.082/7.253 | 0.156/0.164 | 47.05/45.74 | 0.27/0.16 |
| gray | Gray-code counter | 17/18 | 156.4/158.9 | 7.231/7.241 | 0.165/0.163 | 24.27/24.35 | 0.28/0.21 |
| uart_apb | UART-to-APB master | 2253/1407 | 17246.5/13455.4 | 2.380/5.193 | 5.846/0.413 | 2149.98/1992.72 | 9.78/0.80 |
| risc8 | PIC16C5x-compatible CPU | 4233/3734 | 32695.1/27990.6 | 0.508/2.893 | 1.356/0.423 | 5354.76/4255.25 | 69.08/2.25 |
| pic16 | PIC16C5x, clock port renamed clk | 3933/4074 | 31569.0/31061.0 | 1.131/1.774 | 1.253/0.430 | 5631.67/4768.47 | 57.19/2.25 |
| pic1826 | PIC16F1826-style CPU, ROM and RAM stubbed | 5219/3942 | 45922.8/28901.5 | 0.733/3.403 | 3.847/0.439 | 8924.14/4182.86 | 140.13/3.00 |
| p16c5x | Morris P16C5x, clock port renamed clk | 7410/3665 | 45760.1/32222.2 | 3.507/3.829 | 0.513/0.525 | 5280.81/4666.39 | 68.37/1.94 |
| arlet6502 | Arlet 6502 | 4105/1667 | 21852.2/10163.5 | 1.548/2.997 | 0.424/0.506 | 1535.68/1061.75 | 53.27/1.42 |
| x18 | Arlet X18, program image is the address | 8102/6781 | 54202.0/43889.6 | 0.137/−0.109 | 0.483/0.466 | 5961.06/5572.48 | 115.33/3.40 |
| chacha | memory-mapped ChaCha | 24955/16828 | 156830.4/115718.5 | −1.722/−10.316 | 0.492/0.459 | 14971.74/13457.72 | 798.44/8.36 |
| **18 designs** | | **78623/58818** | **513426/407460** | | | **57175/47284** | **1442/34** |

Across the eighteen designs Sift is 1.34× the cells, 1.26× the area, and 1.21× the power, and the search takes 1442 s against 34 s. Yosys is smaller in area on 15 designs, uses fewer cells on 13, and uses less power on 13. Sift has more setup slack on fifo, pwm, x18, and chacha. x18 meets the 8 ns period under Sift and misses it under Yosys. chacha misses on both sides. Sift's miss is 1.722 ns and Yosys's is 10.316 ns.

Sift's own timer matches OpenSTA area and cell count on every design. Setup slack differs by less than 0.2 ns on 13 of the 18. The larger gaps are dsp8, fir10, xfir, x18, and pic16. On pic16 and pic1826 a gated clock makes Sift's arrival optimistic. The full correlation, hold slack, and the recipe each design kept are in [bench/delay/REPORT.md](bench/delay/REPORT.md).

This scoreboard was taken before the shared electrical pass. That pass sizes, buffers, or clones a driver that misses max capacitance or max transition, so a later map spends cells to pull the large slew numbers down.

## Docs

|                                                    |                                                       |
| -------------------------------------------------- | ----------------------------------------------------- |
| [docs/user-guide.md](docs/user-guide.md)           | Verilog subset, libraries, modes, SDC, reports        |
| [docs/developer-guide.md](docs/developer-guide.md) | Pipeline, AIG passes, cover, timing, how to extend it |
| [bench/delay/REPORT.md](bench/delay/REPORT.md)     | Delay comparison against Yosys and OpenSTA            |

## Layout

```text
src/synth/     mapper, Verilog, Liberty, SDC, equivalence
designs/       larger Verilog sources
docs/          user guide, developer guide, logo
bench/delay/   published delay comparison
```

The bench examples live in `src/synth/examples.ts`. `designs/` holds the larger modules as files the CLI can read. `cpu8`, `dsp8`, `fir10`, and `xfir` are proved against the Verilog by `npm run test:designs`. `uart_apb`, `risc8`, `pic16`, `pic1826`, `p16c5x`, `arlet6502`, `x18`, and `chacha` are on the delay bench. `pic16` and `p16c5x` rename the clock port `Clk` to `clk`. `pic1826` stubs the missing stack, ROM, and RAM. `x18` uses the address in place of the missing program image.

## Limits

- Wires are at most 512 bits. A memory is a local `reg` of at most 128 words and 1024 bits.
- The combinational cloud, including flop outputs treated as inputs, has at most 2048 inputs.
- The clock port must be named `clk`. It is an ideal net: no clock tree and no clock latency. `--gate` adds one integrated clock gate per enable; that delay is per-flop latency, not a clock tree.
- Cuts are 4-input. A pattern seed can be wider. See the user guide for `--propose` and `--crit`.
- Every mode sizes, buffers, or clones a driver that misses max capacitance or max transition, when the library can meet the load. An explicit max fanout uses that same pass. Area mode leaves the implicit fanout of 4 alone. A miss the library cannot repair stays in the report.

## Custom cells

`--propose` mines repeated cones for area and remaps with up to N new cells. `--crit` looks at the late path and tries one cell, then remaps once.

Both price the new cell from the library NAND2, not from a characterized table:

```text
delay = nand.delay * (0.8 + 0.1 * ands)
area  = nand.area  * (0.5 + 0.35 * ands)
```

`nand.delay` is that cell's table at the smallest slew and the smallest load. The cell has drive 1 and no slew table. The timer uses that scalar plus `Cload / drive`. A reported slack is a fresh setup check after the remap. It is not the cover's internal "saved" number. On Sky130 that estimate can be optimistic: a kept cell may not improve slack.

## License

Sift is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Mohamed Shalan.

Some files in `designs/` are vendored benchmarks and keep the copyright and license in their headers, including GPL and LGPL sources. Those notices win for those files.
