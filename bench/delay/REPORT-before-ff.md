# Sift vs Yosys+ABC, delay synthesis

Both mappers target the same 24 Sky130 HD cells (the cells Sift knows). The clock is propagated from the clk port, period 8 ns, input delay 0, output delay 0. Input slew and the clock source slew are the first liberty slew index. The output load is one inverter pin. Wires are pin capacitance only: the liberty default wire-load was removed so OpenSTA matches Sift. Activity is 0.1 transitions per cycle, duty 0.5.

Sift is `--opt area` with max fanout 9 pinned. The search starts at `--mode area --arith area` and changes one free knob at a time, up to eight maps. It keeps a step only when the period is met and the area drops, or, while the period is missed, when slack improves. `load` is the timed cover, because Sky130 has NLDM tables. Yosys is `synth -flatten`, `dfflibmap`, then `abc -D 8000` (8 ns) with the same output load and no fanout cap, so both netlists are flat. Runtime is wall clock of each tool, not of OpenSTA, and for Sift it includes every map the search tried. `uart_apb`, `risc8`, and `pic16` are vendored cores. `pic16` renames the clock port `Clk` to `clk`. `uart_apb` is the master only. `pic1826`, `p16c5x`, `arlet6502`, `x18`, and `chacha` are vendored the same way. `pic1826` stubs the stack, ROM, and RAM. `p16c5x` is Morris's P16C5x (the repo is named 6502) and renames `Clk` to `clk`. `x18` replaces the missing program image with the address.

Input slew 0.01 ns. Output load 0.002302 pF (2.302 fF into ABC). Max slew is the largest transition OpenSTA or Sift records on any pin. Leakage from Sift is the sum of `cell_leakage_power` on the mapped cells. OpenSTA leakage is state-dependent at the activity above, so the two leakage numbers are not the same model.

## Sift's report against OpenSTA on the Sift netlist

| Design | Cells Sift | Cells STA | Area Sift | Area STA | Slack Sift | Slack STA | Leak nW Sift | Leak nW STA | Sift s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dsp8 | 1155 | 1155 | 6802.8 | 6802.8 | 1.515 | 1.131 | 2.95 | 2.95 | 5.93 |
| fir10 | 4620 | 4620 | 28214.6 | 28214.6 | 0.487 | 0.237 | 12.33 | 12.33 | 19.35 |
| xfir | 10553 | 10553 | 56963.4 | 56963.4 | 0.190 | -0.018 | 24.65 | 24.65 | 92.99 |
| uart_apb | 2364 | 2364 | 17659.4 | 17659.4 | 2.475 | 2.167 | 7.67 | 7.67 | 16.48 |
| risc8 | 6450 | 6450 | 42122.9 | 42122.9 | 0.363 | 0.554 | 17.99 | 17.99 | 92.58 |
| pic16 | 4136 | 4136 | 33641.0 | 33641.0 | 1.628 | 0.864 | 12.96 | 12.96 | 58.40 |
| pic1826 | 5252 | 5252 | 46231.8 | 46231.8 | 0.505 | 0.448 | 17.33 | 17.33 | 144.15 |
| p16c5x | 7401 | 7401 | 45701.3 | 45701.3 | 3.767 | 3.736 | 17.01 | 17.01 | 68.02 |
| arlet6502 | 2095 | 2095 | 13208.9 | 13208.9 | 1.344 | 1.253 | 5.41 | 5.41 | 21.35 |
| x18 | 8807 | 8807 | 58524.9 | 58524.9 | 2.559 | 2.519 | 22.42 | 22.42 | 180.72 |
| chacha | 14212 | 14212 | 89943.8 | 89943.8 | -2.241 | -2.498 | 37.06 | 37.05 | 449.45 |

## Timing: Sift against OpenSTA on the Sift netlist

Slack and arrival are the setup check, nanoseconds. Hold slack is the worst min-path slack. Slew is the largest transition in the design, nanoseconds. Δ is Sift minus OpenSTA.

| Design | Slack Sift | Slack STA | Δslack | Arrival Sift | Arrival STA | Hold Sift | Hold STA | Slew Sift | Slew STA |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dsp8 | 1.515 | 1.131 | 0.384 | 6.382 | 6.758 | 0.022 | 0.071 | 1.840 | 1.880 |
| fir10 | 0.487 | 0.237 | 0.250 | 7.410 | 7.652 | 0.022 | 0.071 | 3.574 | 3.643 |
| xfir | 0.190 | -0.018 | 0.208 | 7.707 | 7.896 | 0.093 | 0.146 | 0.250 | 0.259 |
| uart_apb | 2.475 | 2.167 | 0.308 | 5.418 | 5.500 | 0.000 | 0.010 | 5.612 | 5.904 |
| risc8 | 0.363 | 0.554 | -0.191 | 7.534 | 7.320 | 0.084 | 0.137 | 0.463 | 0.462 |
| pic16 | 1.628 | 0.864 | 0.764 | 2.146 | 7.011 | 0.094 | 0.124 | 0.363 | 1.369 |
| pic1826 | 0.505 | 0.448 | 0.057 | 3.269 | 7.495 | 0.064 | 0.175 | 0.452 | 3.847 |
| p16c5x | 3.767 | 3.736 | 0.031 | 4.130 | 4.201 | 0.084 | 0.124 | 0.499 | 0.515 |
| arlet6502 | 1.344 | 1.253 | 0.091 | 6.553 | 6.592 | 0.000 | -0.208 | 2.149 | 2.222 |
| x18 | 2.559 | 2.519 | 0.040 | 5.338 | 5.414 | 0.181 | 0.201 | 0.466 | 1.034 |
| chacha | -2.241 | -2.498 | 0.257 | 10.138 | 10.385 | 0.103 | 0.149 | 0.383 | 0.376 |

## Kept recipe

`--opt area` tried up to eight maps. Max fanout stays 9. Maps is how many recipes were mapped. The other columns are the recipe OpenSTA scored.

| Design | Maps | Mode | Arith | PPA | Gate | Recover |
| --- | ---: | --- | --- | ---: | --- | --- |
| dsp8 | 4 | area | area | — | off | off |
| fir10 | 4 | area | area | — | off | off |
| xfir | 5 | load | area | — | off | off |
| uart_apb | 3 | area | area | — | off | off |
| risc8 | 5 | load | area | — | off | off |
| pic16 | 6 | load | area | — | on | off |
| pic1826 | 6 | load | area | — | on | off |
| p16c5x | 5 | load | area | — | off | off |
| arlet6502 | 4 | area | area | — | off | off |
| x18 | 5 | load | area | — | off | off |
| chacha | 5 | load | delay | — | off | off |

## OpenSTA scoreboard

Area is µm² from the liberty. Slack is setup, nanoseconds. Slew is the largest pin transition, nanoseconds. Power is OpenSTA total (internal + switching + leakage), microwatts. A higher slack is faster. A lower area, power, cell count, slew, or runtime is smaller.

| Design | What | Cells S/Y | Area S/Y | Slack S/Y | Slew S/Y | Power µW S/Y | Runtime s S/Y |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dsp8 | 8-bit DSP slice: product, MAC, delay line | 1155/1077 | 6802.8/6576.3 | 1.131/3.439 | 1.880/0.396 | 592.19/585.90 | 5.93/0.53 |
| fir10 | 10-tap 8-bit FIR | 4620/4941 | 28214.6/29967.5 | 0.237/1.671 | 3.643/0.301 | 1871.98/1955.05 | 19.35/1.07 |
| xfir | dual 10-tap inner product | 10553/9146 | 56963.4/54173.2 | -0.018/0.808 | 0.259/0.301 | 2958.08/2862.67 | 92.99/2.12 |
| uart_apb | UART-to-APB master, not the 256-bit system | 2364/1366 | 17659.4/13465.4 | 2.167/5.240 | 5.904/0.472 | 2169.84/1991.17 | 16.48/0.58 |
| risc8 | PIC16C5x-compatible CPU | 6450/4294 | 42122.9/30007.5 | 0.554/2.951 | 0.462/0.463 | 4818.79/4412.25 | 92.58/1.87 |
| pic16 | PIC16C5x, clock port renamed clk | 4136/4141 | 33641.0/31261.2 | 0.864/1.931 | 1.369/0.437 | 6107.31/4779.35 | 58.40/1.70 |
| pic1826 | PIC16F1826-style CPU, ROM and RAM stubbed | 5252/6328 | 46231.8/46583.4 | 0.448/3.012 | 3.847/0.461 | 8934.89/7285.48 | 144.15/2.26 |
| p16c5x | Morris P16C5x, clock port renamed clk | 7401/3770 | 45701.3/33099.2 | 3.736/3.644 | 0.515/0.553 | 5278.43/4676.75 | 68.02/1.60 |
| arlet6502 | Arlet 6502 | 2095/1725 | 13208.9/10266.1 | 1.253/3.232 | 2.222/0.441 | 1170.19/1066.22 | 21.35/1.17 |
| x18 | Arlet X18, program image is the address | 8807/6784 | 58524.9/44237.4 | 2.519/-0.299 | 1.034/0.467 | 6366.05/5587.22 | 180.72/1.95 |
| chacha | memory-mapped ChaCha | 14212/16612 | 89943.8/116650.6 | -2.498/-9.891 | 0.376/0.459 | 7935.02/13488.80 | 449.45/5.17 |
| **sum** | 11 designs | 67045/60184 | 439014.8/416288.0 | | | 48202.76/48690.86 | 1149.4/20.0 |

On the OpenSTA scoreboard Yosys is smaller in area on 8 of 11, uses fewer cells on 7, and uses less power on 9. Sift has more setup slack on 3 and is faster to run on 0.
