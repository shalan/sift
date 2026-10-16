<p align="center">
  <img src="docs/logo.svg" alt="Sift" width="720">
</p>

Sift reads Verilog and maps it onto a standard-cell library. It lowers a module to an AND-inverter graph, covers that graph, and reports area, cell count, and setup slack. The mapped netlist is structural Verilog with no `assign`.

The same functions drive the command line and the bench page. There is no floorplan, no clock tree, and no multi-corner analysis. Wire cost is a model you pass in.

Mohamed Shalan · [mshalan@aucegypt.edu](mailto:mshalan@aucegypt.edu)

## Features

- Verilog subset in, structural Verilog out. `assign`, `always`, `generate`, macros, signed arithmetic, memories, and async reset lower to gates. The mapped netlist has no `assign`.
- AND-inverter graph, then a 4-input area-flow cover. Area mode spends the rewriting on fewer gates. Delay and load mode may take a shallower tree when it does not add gates.
- Three goals. `area` keeps the smallest legal cell. `delay` sizes from a fanout count, still on a unit delay. `load` has the same goal as delay, but each gate's delay is its Liberty NLDM table at the real input slew and output capacitance.
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

Each design is mapped in area, then delay, then load. Every run pins that mode and passes `--opt area` and `--recover`. Max fanout stays 20. The search may change the adder or turn on a clock gate. It keeps a trial when the period stays met and the area drops, and, while the period is missed, when slack improves. The pinned mode and recovery stay on. Every map also sizes, buffers, or clones a driver that misses max capacitance or max transition.

Load mode is the timed cover. Area mode picks the smallest legal cell. Delay mode sizes from a fanout count: a net with more sinks gets a stronger cell, and the cost model is still a unit delay. Load mode has the same goal as delay, but the delay of a gate is read from its Liberty NLDM table at that gate's input slew and the capacitance on its output. On Sky130 that capacitance is the pin caps it drives, since this run has no wire load. Load is the mode whose internal timer matches a real cell table.

All three tables share one Yosys result: `synth -flatten`, `dfflibmap`, then `abc -D 8000`. Same 24 Sky130 HD cells, period 8 ns, input and output delay 0, input slew 0.01 ns, output load one inverter pin (2.302 fF), wires equal to pin capacitance. OpenSTA scores every netlist. Columns are Sift / Yosys. Area is µm², slack and slew are nanoseconds, power is total microwatts, runtime is the mapper only, including every trial the search tried.

### Area

Smallest legal cell, then area recovery. Sift is 1.45× the cells, 1.35× the area, and 1.16× the power (439.3 s against 22.0 s). Yosys is smaller in area on 14 designs, uses fewer cells on 13, and uses less power on 12. Sift has more setup slack on fifo, mem, pwm, x18, and chacha. xfir misses the period by 0.206 ns. chacha misses by 2.920 ns; Yosys misses it by 10.316 ns. x18 meets the period. Yosys misses it by 0.109 ns.

| Design | What | Cells | Area µm² | Slack ns | Slew ns | Power µW | Runtime s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cpu8 | 8-bit CPU, register file, and ALU | 659/693 | 4847.1/4606.9 | 3.414/4.181 | 0.729/0.442 | 502.24/556.68 | 1.16/0.39 |
| dsp8 | 8-bit DSP slice: product, MAC, delay line | 1174/1069 | 6920.4/6535.0 | 1.579/3.522 | 0.694/0.402 | 596.24/584.44 | 2.24/0.50 |
| fir10 | 10-tap 8-bit FIR | 4623/4903 | 28234.6/29907.4 | 0.347/1.596 | 0.512/0.298 | 1866.83/1946.17 | 6.35/1.47 |
| xfir | dual 10-tap inner product | 8695/9081 | 51525.7/53869.2 | −0.206/0.864 | 0.512/0.297 | 2741.96/2845.83 | 27.58/3.16 |
| uart | UART | 303/223 | 2062.0/1680.4 | 6.161/6.534 | 0.808/0.417 | 269.00/273.27 | 0.95/0.19 |
| fifo | four-word FIFO | 282/172 | 1939.4/1686.6 | 6.422/6.182 | 0.627/0.502 | 254.06/247.75 | 0.43/0.17 |
| mem | 16×8 register file | 780/506 | 6000.8/5167.5 | 6.740/6.733 | 0.695/0.502 | 815.51/776.26 | 0.66/0.24 |
| pwm | PWM compare | 27/29 | 182.7/205.2 | 7.269/7.230 | 0.124/0.146 | 24.93/25.50 | 0.20/0.12 |
| lfsr | LFSR | 28/26 | 267.8/240.2 | 7.082/7.253 | 0.156/0.164 | 47.05/45.74 | 0.19/0.11 |
| gray | Gray-code counter | 17/18 | 156.4/158.9 | 7.231/7.241 | 0.165/0.163 | 24.27/24.35 | 0.18/0.12 |
| uart_apb | UART-to-APB master | 2273/1407 | 17456.7/13455.4 | 3.284/5.193 | 0.523/0.413 | 2148.74/1992.72 | 4.92/0.54 |
| risc8 | PIC16C5x-compatible CPU | 6658/3734 | 43465.4/27990.6 | 0.540/2.893 | 0.755/0.423 | 4846.04/4255.25 | 16.37/1.62 |
| pic16 | PIC16C5x, clock port renamed clk | 7132/4074 | 44970.6/31061.0 | 1.167/1.774 | 0.783/0.430 | 5289.88/4768.47 | 14.69/1.43 |
| pic1826 | PIC16F1826-style CPU, ROM and RAM stubbed | 10162/3942 | 67862.6/28901.5 | 0.732/3.403 | 1.023/0.439 | 8026.99/4182.86 | 32.32/1.90 |
| p16c5x | Morris P16C5x, clock port renamed clk | 8554/3665 | 49701.4/32222.2 | 2.052/3.829 | 0.786/0.525 | 5394.02/4666.39 | 12.90/1.37 |
| arlet6502 | Arlet 6502 | 3538/1667 | 19651.3/10163.5 | 0.915/2.997 | 0.909/0.506 | 1445.46/1061.75 | 16.52/1.01 |
| x18 | Arlet X18, program image is the address | 7666/6781 | 53550.1/43889.6 | 2.558/−0.109 | 0.925/0.466 | 5890.39/5572.48 | 31.27/2.17 |
| chacha | memory-mapped ChaCha | 22800/16828 | 152332.3/115718.5 | −2.920/−10.316 | 0.998/0.459 | 14709.78/13457.72 | 270.40/5.53 |
| **18 designs** | | **85371/58818** | **551127.3/407459.5** | | | **54893.38/47283.61** | **439.3/22.0** |

### Delay

Fanout sizing on a unit-delay cost, then area recovery. Sift is 2.21× the cells, 2.05× the area, and 1.47× the power (556.5 s against 22.0 s). Yosys is smaller on every design. Sift has more setup slack on cpu8, fifo, pic16, x18, and chacha. chacha is the only Sift miss, by 2.454 ns. x18 meets the period. Yosys misses it by 0.109 ns.

| Design | What | Cells | Area µm² | Slack ns | Slew ns | Power µW | Runtime s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cpu8 | 8-bit CPU, register file, and ALU | 1113/693 | 6353.6/4606.9 | 4.436/4.181 | 0.371/0.442 | 582.00/556.68 | 1.63/0.39 |
| dsp8 | 8-bit DSP slice: product, MAC, delay line | 1897/1069 | 12598.3/6535.0 | 2.290/3.522 | 0.473/0.402 | 886.26/584.44 | 3.42/0.50 |
| fir10 | 10-tap 8-bit FIR | 8733/4903 | 70764.1/29907.4 | 0.961/1.596 | 0.418/0.298 | 4133.70/1946.17 | 15.95/1.47 |
| xfir | dual 10-tap inner product | 16315/9081 | 135103.3/53869.2 | 0.618/0.864 | 0.421/0.297 | 7239.35/2845.83 | 34.47/3.16 |
| uart | UART | 497/223 | 2637.5/1680.4 | 6.382/6.534 | 0.535/0.417 | 289.66/273.27 | 1.18/0.19 |
| fifo | four-word FIFO | 451/172 | 2484.9/1686.6 | 6.332/6.182 | 0.527/0.502 | 276.78/247.75 | 0.53/0.17 |
| mem | 16×8 register file | 1163/506 | 7078.0/5167.5 | 6.534/6.733 | 0.892/0.502 | 866.93/776.26 | 1.18/0.24 |
| pwm | PWM compare | 42/29 | 240.2/205.2 | 7.202/7.230 | 0.167/0.146 | 26.91/25.50 | 0.21/0.12 |
| lfsr | LFSR | 44/26 | 299.0/240.2 | 7.196/7.253 | 0.101/0.164 | 48.10/45.74 | 0.27/0.11 |
| gray | Gray-code counter | 34/18 | 198.9/158.9 | 7.234/7.241 | 0.167/0.163 | 26.04/24.35 | 0.19/0.12 |
| uart_apb | UART-to-APB master | 3463/1407 | 21325.5/13455.4 | 4.611/5.193 | 0.996/0.413 | 2307.99/1992.72 | 6.04/0.54 |
| risc8 | PIC16C5x-compatible CPU | 8531/3734 | 49267.3/27990.6 | 2.564/2.893 | 0.684/0.423 | 5183.89/4255.25 | 21.04/1.62 |
| pic16 | PIC16C5x, clock port renamed clk | 9382/4074 | 54005.5/31061.0 | 2.910/1.774 | 0.762/0.430 | 5685.11/4768.47 | 17.02/1.43 |
| pic1826 | PIC16F1826-style CPU, ROM and RAM stubbed | 12260/3942 | 75070.7/28901.5 | 2.697/3.403 | 0.514/0.439 | 8496.49/4182.86 | 40.92/1.90 |
| p16c5x | Morris P16C5x, clock port renamed clk | 9671/3665 | 54756.3/32222.2 | 3.173/3.829 | 0.898/0.525 | 5624.86/4666.39 | 16.64/1.37 |
| arlet6502 | Arlet 6502 | 5512/1667 | 29350.6/10163.5 | 2.524/2.997 | 0.580/0.506 | 1894.40/1061.75 | 18.36/1.01 |
| x18 | Arlet X18, program image is the address | 10883/6781 | 65586.7/43889.6 | 1.162/−0.109 | 0.513/0.466 | 6556.65/5572.48 | 28.70/2.17 |
| chacha | memory-mapped ChaCha | 40116/16828 | 246924.3/115718.5 | −2.454/−10.316 | 0.908/0.459 | 19325.20/13457.72 | 348.75/5.53 |
| **18 designs** | | **130107/58818** | **834044.9/407459.5** | | | **69450.32/47283.61** | **556.5/22.0** |

### Load

NLDM tables at the real slew and capacitance, then area recovery. Sift is 1.28× the cells, 1.23× the area, and 1.20× the power (484.6 s against 22.0 s). Yosys is smaller in area on 15 designs, uses fewer cells on 15, and uses less power on 15. Sift has more setup slack on fifo, pwm, uart_apb, x18, and chacha. xfir misses by 0.164 ns. pic1826 misses by 0.180 ns. chacha misses by 2.335 ns; Yosys misses it by 10.316 ns. x18 meets the period. Load mode kept a clock gate on risc8, pic16, and pic1826. OpenSTA then reports a 3.848 ns transition on pic1826. Sift still treats that gated clock as an ideal net, so the mapper did not count it as a transition miss.

| Design | What | Cells | Area µm² | Slack ns | Slew ns | Power µW | Runtime s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cpu8 | 8-bit CPU, register file, and ALU | 710/693 | 5326.4/4606.9 | 3.096/4.181 | 0.834/0.442 | 516.94/556.68 | 1.25/0.39 |
| dsp8 | 8-bit DSP slice: product, MAC, delay line | 1248/1069 | 7255.7/6535.0 | 1.583/3.522 | 0.802/0.402 | 610.12/584.44 | 1.97/0.50 |
| fir10 | 10-tap 8-bit FIR | 5307/4903 | 30132.6/29907.4 | 0.296/1.596 | 0.551/0.298 | 1951.14/1946.17 | 8.22/1.47 |
| xfir | dual 10-tap inner product | 10041/9081 | 55037.8/53869.2 | −0.164/0.864 | 0.551/0.297 | 2883.78/2845.83 | 19.97/3.16 |
| uart | UART | 330/223 | 2133.3/1680.4 | 6.235/6.534 | 0.786/0.417 | 274.44/273.27 | 0.94/0.19 |
| fifo | four-word FIFO | 331/172 | 2164.6/1686.6 | 6.221/6.182 | 0.564/0.502 | 266.84/247.75 | 0.41/0.17 |
| mem | 16×8 register file | 882/506 | 6033.3/5167.5 | 5.801/6.733 | 0.785/0.502 | 836.28/776.26 | 0.69/0.24 |
| pwm | PWM compare | 27/29 | 185.2/205.2 | 7.269/7.230 | 0.139/0.146 | 24.96/25.50 | 0.21/0.12 |
| lfsr | LFSR | 28/26 | 267.8/240.2 | 7.082/7.253 | 0.156/0.164 | 47.05/45.74 | 0.23/0.11 |
| gray | Gray-code counter | 17/18 | 156.4/158.9 | 7.231/7.241 | 0.165/0.163 | 24.27/24.35 | 0.18/0.12 |
| uart_apb | UART-to-APB master | 2160/1407 | 18179.9/13455.4 | 5.199/5.193 | 0.954/0.413 | 2152.65/1992.72 | 4.62/0.54 |
| risc8 | PIC16C5x-compatible CPU | 3958/3734 | 31236.2/27990.6 | 0.251/2.893 | 1.350/0.423 | 5289.37/4255.25 | 12.29/1.62 |
| pic16 | PIC16C5x, clock port renamed clk | 3670/4074 | 30427.9/31061.0 | 0.564/1.774 | 1.266/0.430 | 5586.01/4768.47 | 10.41/1.43 |
| pic1826 | PIC16F1826-style CPU, ROM and RAM stubbed | 4777/3942 | 44251.2/28901.5 | −0.180/3.403 | 3.848/0.439 | 8858.36/4182.86 | 25.90/1.90 |
| p16c5x | Morris P16C5x, clock port renamed clk | 6725/3665 | 43173.9/32222.2 | 3.016/3.829 | 0.669/0.525 | 5181.59/4666.39 | 12.98/1.37 |
| arlet6502 | Arlet 6502 | 3760/1667 | 20363.3/10163.5 | 0.889/2.997 | 0.822/0.506 | 1474.48/1061.75 | 10.98/1.01 |
| x18 | Arlet X18, program image is the address | 7644/6781 | 52416.5/43889.6 | 1.862/−0.109 | 0.937/0.466 | 5890.77/5572.48 | 28.74/2.17 |
| chacha | memory-mapped ChaCha | 23546/16828 | 151417.7/115718.5 | −2.335/−10.316 | 0.762/0.459 | 14769.81/13457.72 | 344.66/5.53 |
| **18 designs** | | **75161/58818** | **500159.7/407459.5** | | | **56638.85/47283.61** | **484.6/22.0** |

The full tables are also in [bench/delay/MODES.md](bench/delay/MODES.md). [bench/delay/REPORT.md](bench/delay/REPORT.md) is an older `--opt area` search that was free to leave area mode, scored before this electrical repair.

## Docs

|                                                    |                                                       |
| -------------------------------------------------- | ----------------------------------------------------- |
| [docs/user-guide.md](docs/user-guide.md)           | Verilog subset, libraries, modes, SDC, reports        |
| [docs/developer-guide.md](docs/developer-guide.md) | Pipeline, AIG passes, cover, timing, how to extend it |
| [bench/delay/MODES.md](bench/delay/MODES.md)       | Area, delay, and load with `--opt area` and `--recover` |
| [bench/delay/REPORT.md](bench/delay/REPORT.md)     | Older free-mode `--opt area` search                   |

## Layout

```text
src/synth/     mapper, Verilog, Liberty, SDC, equivalence
designs/       larger Verilog sources
docs/          user guide, developer guide, logo
bench/delay/   published delay comparison
```

The bench examples live in `src/synth/examples.ts`. `designs/` holds the larger modules as files the CLI can read. `npm run test:designs` maps every file there and, when Yosys and `yosys-abc` are installed, proves it against the Verilog with ABC. CI runs that proof on every push. `pic16` and `p16c5x` rename the clock port `Clk` to `clk`. `pic1826` stubs the missing stack, ROM, and RAM. `x18` uses the address in place of the missing program image.

## Limits

- Wires are at most 512 bits. A memory is a local `reg` of at most 128 words and 1024 bits.
- The combinational cloud, including flop outputs treated as inputs, has at most 2048 inputs.
- The clock port must be named `clk`. It is an ideal net: no clock tree and no clock latency. `--gate` adds one integrated clock gate per enable; that delay is per-flop latency, not a clock tree.
- Cuts are 4-input. A pattern seed can be wider. See the user guide for `--propose` and `--crit`.
- Every mode sizes, buffers, or clones a driver that misses max capacitance or max transition, when the library can meet the load. Max fanout defaults to 20 for every library. A cell `max_fanout`, `--max-fanout`, or `set_max_fanout` replaces it. A direct area-mode map that leaves fanout unset does not invent one, so a unit library with no tables still gets no fanout buffers. A miss the library cannot repair stays in the report.

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
