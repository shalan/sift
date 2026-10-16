# Sift vs Yosys+ABC, three mapper modes

Both sides use the same 24 Sky130 HD cells. Period 8 ns, input delay 0, output delay 0. Input slew 0.01 ns, clock slew the same, output load 0.002302 pF (2.302 fF). Wires are pin capacitance only. Activity 0.1, duty 0.5. OpenSTA scores every netlist.

Each Sift run pins `--mode` to area, delay, or load, then runs `--opt area` and `--recover`. Max fanout stays 9. The search may change arithmetic, the adder bias, and clock gating. It does not leave the pinned mode, and it does not turn recovery off. Every map also sizes, buffers, or clones a driver that misses max capacitance or max transition. `area` picks the smallest legal cell. `delay` sizes from a fanout count. `load` uses the same goal as delay, but each gate's delay is the Liberty NLDM table at that gate's input slew and output capacitance. Yosys is `synth -flatten`, `dfflibmap`, then `abc -D 8000` once per design, and that one result is the right-hand side of every table.

Columns are Sift / Yosys. Area is µm². Slack is setup slack, nanoseconds. Slew is the largest pin transition, nanoseconds. Power is OpenSTA total power, microwatts. Runtime is wall clock of the mapper, not of OpenSTA.

## area

| Design | What | Cells S/Y | Area S/Y | Slack S/Y | Slew S/Y | Power µW S/Y | Runtime s S/Y |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cpu8 | 8-bit CPU, register file, and ALU | 666/693 | 4928.5/4606.9 | 3.419/4.181 | 0.371/0.442 | 506.63/556.68 | 2.68/0.56 |
| dsp8 | 8-bit DSP slice: product, MAC, delay line | 1183/1069 | 7055.5/6535.0 | 1.729/3.522 | 0.483/0.402 | 603.66/584.44 | 5.38/0.52 |
| fir10 | 10-tap 8-bit FIR | 4786/4903 | 29283.1/29907.4 | 0.428/1.596 | 0.234/0.298 | 1916.84/1946.17 | 104.04/1.85 |
| xfir | dual 10-tap inner product | 8698/9081 | 51948.6/53869.2 | -0.073/0.864 | 0.234/0.297 | 2771.54/2845.83 | 228.54/3.47 |
| uart | UART | 308/223 | 2119.5/1680.4 | 6.487/6.534 | 0.315/0.417 | 271.90/273.27 | 1.32/0.23 |
| fifo | four-word FIFO | 286/172 | 1996.9/1686.6 | 6.564/6.182 | 0.365/0.502 | 257.02/247.75 | 0.79/0.22 |
| mem | 16×8 register file | 788/506 | 6145.9/5167.5 | 6.938/6.733 | 0.277/0.502 | 822.25/776.26 | 1.10/0.28 |
| pwm | PWM compare | 27/29 | 182.7/205.2 | 7.269/7.230 | 0.124/0.146 | 24.93/25.50 | 0.28/0.14 |
| lfsr | LFSR | 28/26 | 267.8/240.2 | 7.082/7.253 | 0.156/0.164 | 47.05/45.74 | 0.23/0.13 |
| gray | Gray-code counter | 17/18 | 156.4/158.9 | 7.231/7.241 | 0.165/0.163 | 24.27/24.35 | 0.22/0.12 |
| uart_apb | UART-to-APB master, not the 256-bit system | 2341/1407 | 17852.1/13455.4 | 3.284/5.193 | 0.435/0.413 | 2166.63/1992.72 | 48.42/0.52 |
| risc8 | PIC16C5x-compatible CPU | 6944/3734 | 45138.3/27990.6 | 0.992/2.893 | 0.353/0.423 | 4923.50/4255.25 | 1977.97/3.17 |
| pic16 | PIC16C5x, clock port renamed clk | 7383/4074 | 45995.4/31061.0 | 1.815/1.774 | 0.358/0.430 | 5325.98/4768.47 | 159.06/1.54 |
| pic1826 | PIC16F1826-style CPU, ROM and RAM stubbed | 10762/3942 | 71248.3/28901.5 | 1.450/3.403 | 0.407/0.439 | 8172.03/4182.86 | 485.98/2.03 |
| p16c5x | Morris P16C5x, clock port renamed clk | 8881/3665 | 51578.2/32222.2 | 2.411/3.829 | 0.431/0.525 | 5472.32/4666.39 | 331.69/1.38 |
| arlet6502 | Arlet 6502 | 3667/1667 | 20445.9/10163.5 | 0.684/2.997 | 0.816/0.506 | 1479.68/1061.75 | 58.38/1.75 |
| x18 | Arlet X18, program image is the address | 8009/6781 | 55503.2/43889.6 | 3.175/-0.109 | 0.491/0.466 | 5980.08/5572.48 | 459.71/3.36 |
| chacha | memory-mapped ChaCha | 23595/16828 | 156143.5/115718.5 | -4.251/-10.316 | 0.967/0.459 | 14853.01/13457.72 | 475.00/7.62 |
| **sum** | 18 designs | 88369/58818 | 567989.7/407459.5 | | | 55619.33/47283.61 | 4340.8/28.9 |

Yosys is smaller in area on 14 of 18, uses fewer cells on 13, and uses less power on 12. Sift has more setup slack on 6.

## delay

| Design | What | Cells S/Y | Area S/Y | Slack S/Y | Slew S/Y | Power µW S/Y | Runtime s S/Y |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cpu8 | 8-bit CPU, register file, and ALU | 1165/693 | 6732.7/4606.9 | 4.595/4.181 | 0.357/0.442 | 601.03/556.68 | 8.15/0.56 |
| dsp8 | 8-bit DSP slice: product, MAC, delay line | 1982/1069 | 13187.6/6535.0 | 2.566/3.522 | 0.361/0.402 | 917.10/584.44 | 10.52/0.52 |
| fir10 | 10-tap 8-bit FIR | 8943/4903 | 72498.3/29907.4 | 1.156/1.596 | 0.250/0.298 | 4228.43/1946.17 | 63.99/1.85 |
| xfir | dual 10-tap inner product | 16695/9081 | 137607.0/53869.2 | 0.664/0.864 | 0.250/0.297 | 7364.30/2845.83 | 83.88/3.47 |
| uart | UART | 522/223 | 2795.2/1680.4 | 6.578/6.534 | 0.234/0.417 | 297.43/273.27 | 6.45/0.23 |
| fifo | four-word FIFO | 481/172 | 2643.8/1686.6 | 6.527/6.182 | 0.256/0.502 | 284.57/247.75 | 3.10/0.22 |
| mem | 16×8 register file | 1246/506 | 7683.6/5167.5 | 6.801/6.733 | 0.274/0.502 | 904.34/776.26 | 7.24/0.28 |
| pwm | PWM compare | 44/29 | 247.7/205.2 | 7.103/7.230 | 0.207/0.146 | 27.18/25.50 | 0.29/0.14 |
| lfsr | LFSR | 44/26 | 299.0/240.2 | 7.196/7.253 | 0.101/0.164 | 48.10/45.74 | 0.25/0.13 |
| gray | Gray-code counter | 35/18 | 202.7/158.9 | 7.131/7.241 | 0.207/0.163 | 26.17/24.35 | 0.22/0.12 |
| uart_apb | UART-to-APB master, not the 256-bit system | 3683/1407 | 22856.9/13455.4 | 4.759/5.193 | 0.485/0.413 | 2382.08/1992.72 | 31.64/0.52 |
| risc8 | PIC16C5x-compatible CPU | 9145/3734 | 53606.4/27990.6 | 2.992/2.893 | 0.409/0.423 | 5397.11/4255.25 | 605.42/3.17 |
| pic16 | PIC16C5x, clock port renamed clk | 9942/4074 | 58088.2/31061.0 | 3.355/1.774 | 0.461/0.430 | 5890.13/4768.47 | 93.72/1.54 |
| pic1826 | PIC16F1826-style CPU, ROM and RAM stubbed | 13304/3942 | 82360.2/28901.5 | 3.066/3.403 | 0.483/0.439 | 8854.81/4182.86 | 182.35/2.03 |
| p16c5x | Morris P16C5x, clock port renamed clk | 10425/3665 | 60284.1/32222.2 | 4.161/3.829 | 0.407/0.525 | 5903.69/4666.39 | 102.22/1.38 |
| arlet6502 | Arlet 6502 | 5833/1667 | 31747.9/10163.5 | 2.936/2.997 | 0.358/0.506 | 2015.18/1061.75 | 48.63/1.75 |
| x18 | Arlet X18, program image is the address | 11617/6781 | 71362.2/43889.6 | 1.430/-0.109 | 0.497/0.466 | 6843.40/5572.48 | 204.47/3.36 |
| chacha | memory-mapped ChaCha | 42110/16828 | 260501.1/115718.5 | -1.487/-10.316 | 0.295/0.459 | 19983.41/13457.72 | 606.87/7.62 |
| **sum** | 18 designs | 137216/58818 | 884704.7/407459.5 | | | 71968.45/47283.61 | 2059.4/28.9 |

Yosys is smaller in area on 18 of 18, uses fewer cells on 18, and uses less power on 18. Sift has more setup slack on 9.

## load

| Design | What | Cells S/Y | Area S/Y | Slack S/Y | Slew S/Y | Power µW S/Y | Runtime s S/Y |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cpu8 | 8-bit CPU, register file, and ALU | 777/693 | 5622.9/4606.9 | 3.525/4.181 | 0.306/0.442 | 529.04/556.68 | 2.02/0.56 |
| dsp8 | 8-bit DSP slice: product, MAC, delay line | 1300/1069 | 7553.5/6535.0 | 1.889/3.522 | 0.469/0.402 | 623.99/584.44 | 3.48/0.52 |
| fir10 | 10-tap 8-bit FIR | 5736/4903 | 31746.7/29907.4 | 0.565/1.596 | 0.259/0.298 | 2013.70/1946.17 | 21.57/1.85 |
| xfir | dual 10-tap inner product | 10553/9081 | 56963.4/53869.2 | 0.086/0.864 | 0.259/0.297 | 2958.32/2845.83 | 34.29/3.47 |
| uart | UART | 348/223 | 2238.4/1680.4 | 6.456/6.534 | 0.356/0.417 | 279.54/273.27 | 1.75/0.23 |
| fifo | four-word FIFO | 353/172 | 2259.7/1686.6 | 6.333/6.182 | 0.256/0.502 | 270.92/247.75 | 0.70/0.22 |
| mem | 16×8 register file | 949/506 | 6391.1/5167.5 | 6.632/6.733 | 0.362/0.502 | 851.91/776.26 | 1.38/0.28 |
| pwm | PWM compare | 27/29 | 185.2/205.2 | 7.269/7.230 | 0.139/0.146 | 24.96/25.50 | 0.28/0.14 |
| lfsr | LFSR | 28/26 | 267.8/240.2 | 7.082/7.253 | 0.156/0.164 | 47.05/45.74 | 0.24/0.13 |
| gray | Gray-code counter | 17/18 | 156.4/158.9 | 7.231/7.241 | 0.165/0.163 | 24.27/24.35 | 0.21/0.12 |
| uart_apb | UART-to-APB master, not the 256-bit system | 2307/1407 | 18799.3/13455.4 | 5.199/5.193 | 0.368/0.413 | 2177.31/1992.72 | 6.62/0.52 |
| risc8 | PIC16C5x-compatible CPU | 4233/3734 | 32695.1/27990.6 | 0.508/2.893 | 1.356/0.423 | 5354.76/4255.25 | 73.64/3.17 |
| pic16 | PIC16C5x, clock port renamed clk | 3933/4074 | 31569.0/31061.0 | 1.131/1.774 | 1.253/0.430 | 5631.67/4768.47 | 39.39/1.54 |
| pic1826 | PIC16F1826-style CPU, ROM and RAM stubbed | 5219/3942 | 45922.8/28901.5 | 0.733/3.403 | 3.847/0.439 | 8924.14/4182.86 | 116.43/2.03 |
| p16c5x | Morris P16C5x, clock port renamed clk | 7410/3665 | 45760.1/32222.2 | 3.507/3.829 | 0.513/0.525 | 5280.81/4666.39 | 72.09/1.38 |
| arlet6502 | Arlet 6502 | 4105/1667 | 21852.2/10163.5 | 1.548/2.997 | 0.424/0.506 | 1535.70/1061.75 | 37.04/1.75 |
| x18 | Arlet X18, program image is the address | 8102/6781 | 54202.0/43889.6 | 0.137/-0.109 | 0.483/0.466 | 5961.06/5572.48 | 163.44/3.36 |
| chacha | memory-mapped ChaCha | 24955/16828 | 156830.4/115718.5 | -1.722/-10.316 | 0.492/0.459 | 14971.74/13457.72 | 591.89/7.62 |
| **sum** | 18 designs | 80352/58818 | 521015.9/407459.5 | | | 57460.89/47283.61 | 1166.4/28.9 |

Yosys is smaller in area on 16 of 18, uses fewer cells on 15, and uses less power on 15. Sift has more setup slack on 5.
