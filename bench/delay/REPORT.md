# Sift vs Yosys+ABC, delay synthesis

Both mappers target the same 24 Sky130 HD cells (the cells Sift knows). The clock is propagated from the clk port, period 8 ns, input delay 0, output delay 0. Input slew and the clock source slew are the first liberty slew index. The output load is one inverter pin. Wires are pin capacitance only: the liberty default wire-load was removed so OpenSTA matches Sift. Activity is 0.1 transitions per cycle, duty 0.5.

Sift is `--opt area` with max fanout 9 pinned. The search starts at `--mode area --arith area` and changes one free knob at a time, up to eight maps. It keeps a step only when the period is met and the area drops, or, while the period is missed, when slack improves. `load` is the timed cover, because Sky130 has NLDM tables. Yosys is `synth -flatten`, `dfflibmap`, then `abc -D 8000` (8 ns) with the same output load and no fanout cap, so both netlists are flat. Runtime is wall clock of each tool, not of OpenSTA, and for Sift it includes every map the search tried. `uart_apb`, `risc8`, and `pic16` are vendored cores. `pic16` renames the clock port `Clk` to `clk`. `uart_apb` is the master only. `pic1826`, `p16c5x`, `arlet6502`, `x18`, and `chacha` are vendored the same way. `pic1826` stubs the stack, ROM, and RAM. `p16c5x` is Morris's P16C5x (the repo is named 6502) and renames `Clk` to `clk`. `x18` replaces the missing program image with the address.

Input slew 0.01 ns. Output load 0.002302 pF (2.302 fF into ABC). Max slew is the largest transition OpenSTA or Sift records on any pin. Leakage from Sift is the sum of `cell_leakage_power` on the mapped cells. OpenSTA leakage is state-dependent at the activity above, so the two leakage numbers are not the same model.

## Sift's report against OpenSTA on the Sift netlist

| Design | Cells Sift | Cells STA | Area Sift | Area STA | Slack Sift | Slack STA | Leak nW Sift | Leak nW STA | Sift s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cpu8 | 653 | 653 | 4815.9 | 4815.9 | 3.272 | 3.348 | 1.87 | 1.87 | 3.09 |
| dsp8 | 1155 | 1155 | 6802.8 | 6802.8 | 1.658 | 1.292 | 2.95 | 2.95 | 4.85 |
| fir10 | 4620 | 4620 | 28214.6 | 28214.6 | 0.606 | 0.347 | 12.33 | 12.33 | 18.37 |
| xfir | 10553 | 10553 | 56963.4 | 56963.4 | 0.322 | 0.086 | 24.65 | 24.65 | 98.38 |
| uart | 302 | 302 | 2039.5 | 2039.5 | 5.230 | 5.253 | 0.87 | 0.87 | 2.36 |
| fifo | 282 | 282 | 1931.9 | 1931.9 | 6.336 | 6.396 | 0.80 | 0.80 | 0.96 |
| mem | 776 | 776 | 5973.2 | 5973.2 | 4.005 | 4.030 | 2.33 | 2.33 | 1.21 |
| pwm | 27 | 27 | 182.7 | 182.7 | 7.240 | 7.269 | 0.09 | 0.09 | 0.32 |
| lfsr | 28 | 28 | 267.8 | 267.8 | 7.080 | 7.082 | 0.11 | 0.11 | 0.27 |
| gray | 17 | 17 | 156.4 | 156.4 | 7.191 | 7.231 | 0.07 | 0.07 | 0.28 |
| uart_apb | 2253 | 2253 | 17246.5 | 17246.5 | 2.520 | 2.380 | 7.55 | 7.55 | 9.78 |
| risc8 | 4233 | 4233 | 32695.1 | 32695.1 | 0.345 | 0.508 | 12.72 | 12.72 | 69.08 |
| pic16 | 3933 | 3933 | 31569.0 | 31569.0 | 1.716 | 1.131 | 12.19 | 12.19 | 57.19 |
| pic1826 | 5219 | 5219 | 45922.8 | 45922.8 | 0.669 | 0.733 | 17.10 | 17.10 | 140.13 |
| p16c5x | 7410 | 7410 | 45760.1 | 45760.1 | 3.569 | 3.507 | 17.04 | 17.04 | 68.37 |
| arlet6502 | 4105 | 4105 | 21852.2 | 21852.2 | 1.596 | 1.548 | 8.43 | 8.43 | 53.27 |
| x18 | 8102 | 8102 | 54202.0 | 54202.0 | 0.420 | 0.137 | 20.42 | 20.42 | 115.33 |
| chacha | 24955 | 24955 | 156830.4 | 156830.4 | -1.563 | -1.722 | 64.05 | 64.04 | 798.44 |

## Timing: Sift against OpenSTA on the Sift netlist

Slack and arrival are the setup check, nanoseconds. Hold slack is the worst min-path slack. Slew is the largest transition in the design, nanoseconds. Δ is Sift minus OpenSTA.

| Design | Slack Sift | Slack STA | Δslack | Arrival Sift | Arrival STA | Hold Sift | Hold STA | Slew Sift | Slew STA |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cpu8 | 3.272 | 3.348 | -0.076 | 4.606 | 4.528 | 0.074 | 0.071 | 3.960 | 4.023 |
| dsp8 | 1.658 | 1.292 | 0.366 | 6.230 | 6.596 | 0.074 | 0.071 | 1.841 | 1.899 |
| fir10 | 0.606 | 0.347 | 0.259 | 7.282 | 7.541 | 0.074 | 0.071 | 3.574 | 3.650 |
| xfir | 0.322 | 0.086 | 0.236 | 7.566 | 7.792 | 0.151 | 0.146 | 0.250 | 0.259 |
| uart | 5.230 | 5.253 | -0.023 | 2.705 | 2.682 | 0.074 | 0.071 | 1.584 | 1.502 |
| fifo | 6.336 | 6.396 | -0.060 | 1.599 | 1.541 | 0.074 | 0.071 | 0.723 | 0.740 |
| mem | 4.005 | 4.030 | -0.025 | 3.689 | 3.673 | 0.189 | 0.167 | 4.928 | 4.957 |
| pwm | 7.240 | 7.269 | -0.029 | 0.647 | 0.619 | 0.077 | 0.074 | 0.122 | 0.124 |
| lfsr | 7.080 | 7.082 | -0.002 | 0.808 | 0.802 | 0.156 | 0.147 | 0.154 | 0.156 |
| gray | 7.191 | 7.231 | -0.040 | 0.696 | 0.658 | 0.077 | 0.074 | 0.159 | 0.165 |
| uart_apb | 2.520 | 2.380 | 0.140 | 5.149 | 5.288 | 0.010 | -0.224 | 5.613 | 5.846 |
| risc8 | 0.345 | 0.508 | -0.163 | 3.429 | 3.520 | 0.109 | 0.087 | 0.463 | 1.356 |
| pic16 | 1.716 | 1.131 | 0.585 | 2.058 | 6.744 | 0.136 | 0.129 | 0.362 | 1.253 |
| pic1826 | 0.669 | 0.733 | -0.064 | 3.105 | 7.210 | 0.099 | 0.174 | 0.342 | 3.847 |
| p16c5x | 3.569 | 3.507 | 0.062 | 4.319 | 4.369 | 0.136 | 0.057 | 0.499 | 0.513 |
| arlet6502 | 1.596 | 1.548 | 0.048 | 6.340 | 6.330 | 0.029 | -0.208 | 0.421 | 0.424 |
| x18 | 0.420 | 0.137 | 0.283 | 7.510 | 7.796 | 0.211 | 0.203 | 0.468 | 0.483 |
| chacha | -1.563 | -1.722 | 0.159 | 9.442 | 9.596 | 0.156 | 0.152 | 0.474 | 0.492 |

## Kept recipe

`--opt area` tried up to eight maps. Max fanout stays 9. Maps is how many recipes were mapped. The other columns are the recipe OpenSTA scored.

| Design | Maps | Mode | Arith | PPA | Gate | Recover |
| --- | ---: | --- | --- | ---: | --- | --- |
| cpu8 | 4 | area | area | — | off | off |
| dsp8 | 4 | area | area | — | off | off |
| fir10 | 4 | area | area | — | off | off |
| xfir | 5 | load | area | — | off | off |
| uart | 4 | area | area | — | off | off |
| fifo | 4 | area | area | — | off | off |
| mem | 3 | area | area | — | off | off |
| pwm | 4 | area | area | — | off | off |
| lfsr | 3 | area | area | — | off | off |
| gray | 4 | area | area | — | off | off |
| uart_apb | 3 | area | area | — | off | off |
| risc8 | 6 | load | area | — | on | off |
| pic16 | 6 | load | area | — | on | off |
| pic1826 | 6 | load | area | — | on | off |
| p16c5x | 5 | load | area | — | off | off |
| arlet6502 | 5 | load | area | — | off | off |
| x18 | 5 | load | area | — | off | off |
| chacha | 5 | load | delay | — | off | off |

## OpenSTA scoreboard

Area is µm² from the liberty. Slack is setup, nanoseconds. Slew is the largest pin transition, nanoseconds. Power is OpenSTA total (internal + switching + leakage), microwatts. A higher slack is faster. A lower area, power, cell count, slew, or runtime is smaller.

| Design | What | Cells S/Y | Area S/Y | Slack S/Y | Slew S/Y | Power µW S/Y | Runtime s S/Y |
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
| uart_apb | UART-to-APB master, not the 256-bit system | 2253/1407 | 17246.5/13455.4 | 2.380/5.193 | 5.846/0.413 | 2149.98/1992.72 | 9.78/0.80 |
| risc8 | PIC16C5x-compatible CPU | 4233/3734 | 32695.1/27990.6 | 0.508/2.893 | 1.356/0.423 | 5354.76/4255.25 | 69.08/2.25 |
| pic16 | PIC16C5x, clock port renamed clk | 3933/4074 | 31569.0/31061.0 | 1.131/1.774 | 1.253/0.430 | 5631.67/4768.47 | 57.19/2.25 |
| pic1826 | PIC16F1826-style CPU, ROM and RAM stubbed | 5219/3942 | 45922.8/28901.5 | 0.733/3.403 | 3.847/0.439 | 8924.14/4182.86 | 140.13/3.00 |
| p16c5x | Morris P16C5x, clock port renamed clk | 7410/3665 | 45760.1/32222.2 | 3.507/3.829 | 0.513/0.525 | 5280.81/4666.39 | 68.37/1.94 |
| arlet6502 | Arlet 6502 | 4105/1667 | 21852.2/10163.5 | 1.548/2.997 | 0.424/0.506 | 1535.68/1061.75 | 53.27/1.42 |
| x18 | Arlet X18, program image is the address | 8102/6781 | 54202.0/43889.6 | 0.137/-0.109 | 0.483/0.466 | 5961.06/5572.48 | 115.33/3.40 |
| chacha | memory-mapped ChaCha | 24955/16828 | 156830.4/115718.5 | -1.722/-10.316 | 0.492/0.459 | 14971.74/13457.72 | 798.44/8.36 |
| **sum** | 18 designs | 78623/58818 | 513426.2/407459.5 | | | 57175.40/47283.61 | 1441.7/33.9 |

On the OpenSTA scoreboard Yosys is smaller in area on 15 of 18, uses fewer cells on 13, and uses less power on 13. Sift has more setup slack on 4 and is faster to run on 0.
