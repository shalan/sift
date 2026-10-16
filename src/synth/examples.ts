import type { Netlist } from "./netlist.ts";

export interface Example {
  id: string;
  blurb: string;
  netlist: Netlist;
}

export const EXAMPLES: Example[] = [
  {
    id: "invert",
    blurb: "An inverter is a flipped edge, not a node.",
    netlist: {
      name: "invert",
      inputs: ["a"],
      outputs: ["y"],
      gates: [{ id: "y", op: "INV", ins: ["a"] }],
    },
  },
  {
    id: "half-adder",
    blurb: "XOR lowers to three ANDs. The carry is one more.",
    netlist: {
      name: "half-adder",
      inputs: ["a", "b"],
      outputs: ["sum", "cout"],
      gates: [
        { id: "sum", op: "XOR", ins: ["a", "b"] },
        { id: "cout", op: "AND", ins: ["a", "b"] },
      ],
    },
  },
  {
    id: "mux",
    blurb: "sel ? a : b, still only ANDs and inversions.",
    netlist: {
      name: "mux",
      inputs: ["s", "a", "b"],
      outputs: ["y"],
      gates: [{ id: "y", op: "MUX", ins: ["s", "a", "b"] }],
    },
  },
  {
    id: "and4",
    blurb: "Area keeps two NAND2_1s and a NOR2_1. Delay pays for one NAND4_1.",
    netlist: {
      name: "and4",
      inputs: ["a", "b", "c", "d"],
      outputs: ["y"],
      gates: [
        { id: "ab", op: "AND", ins: ["a", "b"] },
        { id: "cd", op: "AND", ins: ["c", "d"] },
        { id: "y", op: "AND", ins: ["ab", "cd"] },
      ],
    },
  },
  {
    id: "fan",
    blurb: "a feeds six ANDs. Area stays at drive 1. Delay inserts BUF_4 and BUF_2.",
    netlist: {
      name: "fan",
      inputs: ["a", "b0", "b1", "b2", "b3", "b4", "b5"],
      outputs: ["y0", "y1", "y2", "y3", "y4", "y5"],
      gates: [
        { id: "y0", op: "AND", ins: ["a", "b0"] },
        { id: "y1", op: "AND", ins: ["a", "b1"] },
        { id: "y2", op: "AND", ins: ["a", "b2"] },
        { id: "y3", op: "AND", ins: ["a", "b3"] },
        { id: "y4", op: "AND", ins: ["a", "b4"] },
        { id: "y5", op: "AND", ins: ["a", "b5"] },
      ],
    },
  },
  {
    id: "stage",
    blurb:
      "One AND feeds four others. Delay mode picks NAND4_4 from the fanout. Load mode picks NAND4_2, because a stronger gate is a heavier load.",
    netlist: {
      name: "stage",
      inputs: ["a", "b", "c", "d", "e0", "e1", "e2", "e3"],
      outputs: ["y0", "y1", "y2", "y3"],
      gates: [
        { id: "ab", op: "AND", ins: ["a", "b"] },
        { id: "abc", op: "AND", ins: ["ab", "c"] },
        { id: "p", op: "AND", ins: ["abc", "d"] },
        { id: "y0", op: "AND", ins: ["p", "e0"] },
        { id: "y1", op: "AND", ins: ["p", "e1"] },
        { id: "y2", op: "AND", ins: ["p", "e2"] },
        { id: "y3", op: "AND", ins: ["p", "e3"] },
      ],
    },
  },
  {
    id: "shared",
    blurb: "The same cone written twice becomes one cone.",
    netlist: {
      name: "shared",
      inputs: ["a", "b", "c"],
      outputs: ["y1", "y2"],
      gates: [
        { id: "ab", op: "AND", ins: ["a", "b"] },
        { id: "y1", op: "OR", ins: ["ab", "c"] },
        { id: "ab2", op: "AND", ins: ["a", "b"] },
        { id: "y2", op: "OR", ins: ["ab2", "c"] },
      ],
    },
  },
  {
    id: "contradiction",
    blurb: "a AND ~a is 0. The unread OR is swept.",
    netlist: {
      name: "contradiction",
      inputs: ["a", "b"],
      outputs: ["z", "y"],
      gates: [
        { id: "na", op: "INV", ins: ["a"] },
        { id: "z", op: "AND", ins: ["a", "na"] },
        { id: "y", op: "AND", ins: ["a", "b"] },
        { id: "dead", op: "OR", ins: ["a", "b"] },
      ],
    },
  },
  {
    id: "aoi",
    blurb: "The whole cone is one AOI21 when that cell exists.",
    netlist: {
      name: "aoi",
      inputs: ["a", "b", "c"],
      outputs: ["y"],
      gates: [
        { id: "ab", op: "AND", ins: ["a", "b"] },
        { id: "term", op: "OR", ins: ["ab", "c"] },
        { id: "y", op: "INV", ins: ["term"] },
      ],
    },
  },
  {
    id: "full-adder",
    blurb: "Sum is two XORs. Carry is the majority of the three bits.",
    netlist: {
      name: "full-adder",
      inputs: ["a", "b", "cin"],
      outputs: ["sum", "cout"],
      gates: [
        { id: "axb", op: "XOR", ins: ["a", "b"] },
        { id: "sum", op: "XOR", ins: ["axb", "cin"] },
        { id: "ab", op: "AND", ins: ["a", "b"] },
        { id: "abc", op: "AND", ins: ["cin", "axb"] },
        { id: "cout", op: "OR", ins: ["ab", "abc"] },
      ],
    },
  },
  {
    id: "flop",
    blurb: "q takes d on the next clock. A register is not an AND.",
    netlist: {
      name: "flop",
      inputs: ["d"],
      outputs: ["q"],
      gates: [{ id: "q", op: "DFF", ins: ["d"] }],
    },
  },
  {
    id: "counter",
    blurb: "q0 toggles every clock. Slack is the period minus clock-to-Q, the cloud, and setup.",
    netlist: {
      name: "counter",
      inputs: [],
      outputs: ["q0", "q1"],
      gates: [
        { id: "d0", op: "INV", ins: ["q0"] },
        { id: "q0", op: "DFF", ins: ["d0"] },
        { id: "d1", op: "XOR", ins: ["q1", "q0"] },
        { id: "q1", op: "DFF", ins: ["d1"] },
      ],
    },
  },
];

export function formatNetlist(netlist: Netlist): string {
  return JSON.stringify(netlist, null, 2);
}

export interface VerilogExample {
  id: string;
  blurb: string;
  source: string;
}

export const VERILOG: VerilogExample[] = [
  {
    id: "and4.v",
    blurb: "Four-input AND, written as Verilog. The & chain becomes AND gates.",
    source: `module and4 (
  input a, b, c, d,
  output y
);
  assign y = a & b & c & d;
endmodule
`,
  },
  {
    id: "adder.v",
    blurb: "The full adder, elaborated from assign.",
    source: `module full_adder (
  input a, b, cin,
  output sum, cout
);
  assign sum = a ^ b ^ cin;
  assign cout = (a & b) | (cin & (a ^ b));
endmodule
`,
  },
  {
    id: "counter.v",
    blurb:
      "posedge clk lowers to two DFFs. Slack is the period minus clock-to-Q, the cloud, and setup.",
    source: `module counter (
  input clk,
  output reg q0, q1
);
  always @(posedge clk) begin
    q0 <= ~q0;
    q1 <= q1 ^ q0;
  end
endmodule
`,
  },
  {
    id: "bus.v",
    blurb: "A 4-bit AND. Each bit becomes its own gate.",
    source: `module band (
  input [3:0] a, b,
  output [3:0] y
);
  assign y = a & b;
endmodule
`,
  },
  {
    id: "add.v",
    blurb: "a + b is a ripple of full adders. The sum wraps at 16.",
    source: `module add4 (
  input [3:0] a, b,
  output [3:0] y
);
  assign y = a + b;
endmodule
`,
  },
  {
    id: "if.v",
    blurb: "if / else lowers to one MUX. The select is s.",
    source: `module cif (
  input s, a, b,
  output y
);
  always @* begin
    if (s) y = a;
    else y = b;
  end
endmodule
`,
  },
  {
    id: "count4.v",
    blurb:
      "Synchronous reset. rst clears q, q counts, and the later rst pulse clears on the next row.",
    source: `module count4 (
  input clk, rst,
  output reg [3:0] q
);
  always @(posedge clk) begin
    if (rst) q <= 0;
    else q <= q + 1;
  end
endmodule
`,
  },
  {
    id: "pack.v",
    blurb: "Left-hand slices. swap exchanges the two nibbles.",
    source: `module pack (
  input [3:0] hi, lo,
  input swap,
  output [7:0] y
);
  assign y[7:4] = swap ? lo : hi;
  assign y[3:0] = swap ? hi : lo;
endmodule
`,
  },
  {
    id: "alu.v",
    blurb: "8-bit ALU. In area mode the add and subtract share one ripple adder.",
    source: `module alu (
  input [7:0] a, b,
  input [1:0] op,
  output reg [7:0] y
);
  always @* begin
    case (op)
      2'd0: y = a + b;
      2'd1: y = a - b;
      2'd2: y = a & b;
      default: y = {7'b0, a < b};
    endcase
  end
endmodule
`,
  },
  {
    id: "async.v",
    blurb: "Asynchronous reset. The pulse on clock 6 clears q in that same row.",
    source: `module acount (
  input clk, rst,
  output reg [7:0] q
);
  always @(posedge clk or posedge rst) begin
    if (rst) q <= 0;
    else q <= q + 1;
  end
endmodule
`,
  },
  {
    id: "latch.v",
    blurb: "Transparent while en is 1. Holds q when en is 0.",
    source: `module dlatch (
  input en, d,
  output reg q
);
  always @* begin
    if (en) q = d;
  end
endmodule
`,
  },
  {
    id: "en.v",
    blurb: "Four-bit load enable. Clock gate replaces the recirculation mux.",
    source: `module enreg (
  input clk,
  input en,
  input [3:0] d,
  output reg [3:0] q
);
  always @(posedge clk)
    if (en) q <= d;
endmodule
`,
  },
  {
    id: "wide.v",
    blurb: "16-bit subtract, plus a less-than flag.",
    source: `module wide (
  input [15:0] a, b,
  output [15:0] y,
  output lt
);
  assign y = a - b;
  assign lt = a < b;
endmodule
`,
  },
  {
    id: "shift.v",
    blurb: "Barrel shift. dir picks << or >>.",
    source: `module shift (
  input [7:0] a,
  input [2:0] s,
  input dir,
  output [7:0] y
);
  assign y = dir ? a << s : a >> s;
endmodule
`,
  },
  {
    id: "index.v",
    blurb: "y is the bit of a selected by i.",
    source: `module pick (
  input [7:0] a,
  input [2:0] i,
  output y
);
  assign y = a[i];
endmodule
`,
  },
  {
    id: "hier.v",
    blurb: "A parameterized adder, instantiated at W=8. The last module is the top.",
    source: `module adder #(parameter W = 4) (
  input [W-1:0] a, b,
  output [W-1:0] y
);
  assign y = a + b;
endmodule

module top (
  input [7:0] a, b,
  output [7:0] y
);
  adder #(.W(8)) u (.a(a), .b(b), .y(y));
endmodule
`,
  },
  {
    id: "mul.v",
    blurb: "4-bit multiply, full 8-bit product. Area builds an array. Delay builds a Wallace tree.",
    source: `module mul (
  input [3:0] a, b,
  output [7:0] y
);
  assign y = a * b;
endmodule
`,
  },
  {
    id: "share.v",
    blurb:
      "Area shares one adder for add and subtract. Delay keeps both and uses a Brent-Kung adder.",
    source: `module share (
  input op,
  input [3:0] a, b,
  output reg [3:0] y
);
  always @* begin
    if (op) y = a + b;
    else y = a - b;
  end
endmodule
`,
  },
  {
    id: "rep.v",
    blurb: "Replication. {4{a}} tiles the 2-bit word four times.",
    source: `module rep (
  input [1:0] a,
  output [7:0] y
);
  assign y = {4{a}};
endmodule
`,
  },
  {
    id: "ashift.v",
    blurb: ">>> copies the sign bit. >> still fills with 0. They differ when a is negative.",
    source: `module ashift (
  input signed [7:0] a,
  input [2:0] s,
  output signed [7:0] y,
  output [7:0] z
);
  assign y = a >>> s;
  assign z = a >> s;
endmodule
`,
  },
  {
    id: "signed.v",
    blurb: "Signed multiply and add. Negatives sign-extend, so the 8-bit product matches.",
    source: `module smul (
  input signed [3:0] a, b,
  output signed [7:0] y,
  output signed [7:0] s
);
  assign y = a * b;
  assign s = a + b;
endmodule
`,
  },
  {
    id: "div.v",
    blurb:
      "Area restores after each ripple subtract. Delay uses a prefix array in each row. The quotient matches either way.",
    source: `module div4 (
  input [3:0] a, b,
  output [3:0] q,
  output [3:0] r
);
  assign q = a / b;
  assign r = a % b;
endmodule
`,
  },
  {
    id: "mem.v",
    blurb: "16 words of 8 flops. On the clock, we writes d at addr. q reads that word.",
    source: `module rf (
  input clk,
  input we,
  input [3:0] addr,
  input [7:0] d,
  output [7:0] q
);
  reg [7:0] mem [0:15];
  always @(posedge clk) begin
    if (we) mem[addr] <= d;
  end
  assign q = mem[addr];
endmodule
`,
  },
  {
    id: "gray.v",
    blurb: "A binary counter, then adjacent bits are XORed. y is the Gray code of q.",
    source: `module gray (
  input clk,
  input rst,
  output [3:0] y
);
  reg [3:0] q;
  always @(posedge clk) begin
    if (rst) q <= 4'd0;
    else q <= q + 4'd1;
  end
  assign y = q ^ {1'b0, q[3:1]};
endmodule
`,
  },
  {
    id: "lzd.v",
    blurb: "The index of the highest 1. Each test is a mux. none is 1 when a is zero.",
    source: `module lzd (
  input [7:0] a,
  output reg [3:0] y,
  output none
);
  always @* begin
    if (a[7]) y = 4'd0;
    else if (a[6]) y = 4'd1;
    else if (a[5]) y = 4'd2;
    else if (a[4]) y = 4'd3;
    else if (a[3]) y = 4'd4;
    else if (a[2]) y = 4'd5;
    else if (a[1]) y = 4'd6;
    else if (a[0]) y = 4'd7;
    else y = 4'd8;
  end
  assign none = a == 8'd0;
endmodule
`,
  },
  {
    id: "pop.v",
    blurb: "The number of ones. Each bit is zero-extended, so the sum is an adder tree.",
    source: `module pop (
  input [7:0] a,
  output [3:0] y
);
  assign y = {3'b0, a[0]} + {3'b0, a[1]} + {3'b0, a[2]} + {3'b0, a[3]}
            + {3'b0, a[4]} + {3'b0, a[5]} + {3'b0, a[6]} + {3'b0, a[7]};
endmodule
`,
  },
  {
    id: "edges.v",
    blurb: "Two flops. rise is high for the clock after d goes from 0 to 1.",
    source: `module edges (
  input clk,
  input d,
  output rise,
  output fall
);
  reg q0, q1;
  always @(posedge clk) begin
    q0 <= d;
    q1 <= q0;
  end
  assign rise = q0 & ~q1;
  assign fall = ~q0 & q1;
endmodule
`,
  },
  {
    id: "genif.v",
    blurb:
      "generate if keeps the register when EN is not 0 and drops that branch otherwise. The last module is the top.",
    source: `module hold (
  input clk,
  input [3:0] d,
  output reg [3:0] q
);
  always @(posedge clk) q <= d;
endmodule

module pipe #(parameter EN = 0) (
  input clk,
  input [3:0] d,
  output [3:0] q
);
  generate
    if (EN != 0) begin
      hold u (.clk(clk), .d(d), .q(q));
    end else begin
      assign q = d;
    end
  endgenerate
endmodule

module staged (
  input clk,
  input [3:0] d,
  output [3:0] q
);
  pipe #(.EN(1)) u (.clk(clk), .d(d), .q(q));
endmodule
`,
  },
  {
    id: "lfsr.v",
    blurb:
      "Eight flops. The new low bit is the XOR of four taps. Reset loads 1 so the register is never stuck at 0.",
    source: `module lfsr (
  input clk,
  input rst,
  output [7:0] q
);
  reg [7:0] s;
  wire fb;
  assign fb = s[7] ^ s[5] ^ s[4] ^ s[3];
  always @(posedge clk) begin
    if (rst) s <= 8'h01;
    else s <= {s[6:0], fb};
  end
  assign q = s;
endmodule
`,
  },
  {
    id: "pwm.v",
    blurb: "A free-running counter. y is high while the count is below duty.",
    source: `module pwm (
  input clk,
  input rst,
  input [3:0] duty,
  output y
);
  reg [3:0] count;
  always @(posedge clk) begin
    if (rst) count <= 4'd0;
    else count <= count + 4'd1;
  end
  assign y = count < duty;
endmodule
`,
  },
  {
    id: "dec.v",
    blurb:
      "One output bit per value of a. In load mode each bit of a fans out to every product, so the fanout limit inserts buffers.",
    source: `module dec (
  input [3:0] a,
  output reg [15:0] y
);
  integer i;
  always @* begin
    for (i = 0; i < 16; i = i + 1) y[i] = a == i;
  end
endmodule
`,
  },
  {
    id: "fifo.v",
    blurb:
      "Four words. push writes d and steps the write pointer. pop steps the read pointer. q is the word at the read pointer.",
    source: `module fifo (
  input clk,
  input rst,
  input we,
  input re,
  input [7:0] d,
  output [7:0] q,
  output empty,
  output full
);
  reg [7:0] mem [0:3];
  reg [1:0] wptr;
  reg [1:0] rptr;
  reg [2:0] count;
  wire push;
  wire pop;
  assign push = we & ~full;
  assign pop = re & ~empty;
  always @(posedge clk) begin
    if (rst) begin
      wptr <= 2'd0;
      rptr <= 2'd0;
      count <= 3'd0;
    end else begin
      if (push) begin
        mem[wptr] <= d;
        wptr <= wptr + 2'd1;
      end
      if (pop) rptr <= rptr + 2'd1;
      if (push && !pop) count <= count + 3'd1;
      else if (!push && pop) count <= count - 3'd1;
    end
  end
  assign q = mem[rptr];
  assign empty = count == 3'd0;
  assign full = count == 3'd4;
endmodule
`,
  },
  {
    id: "uart.v",
    blurb:
      "8-bit UART. The divider ticks every 16 clocks. tx shifts start, data, and stop. rx shifts a byte in after a low start bit.",
    source: `module uart (
  input clk,
  input rst,
  input [7:0] tx_data,
  input tx_valid,
  output reg tx,
  output reg tx_ready,
  input rx,
  output reg [7:0] rx_data,
  output reg rx_valid
);
  reg [3:0] div;
  wire baud;
  assign baud = div == 4'd15;
  always @(posedge clk) begin
    if (rst) div <= 4'd0;
    else div <= baud ? 4'd0 : div + 4'd1;
  end

  reg [1:0] tstate;
  reg [2:0] tbit;
  reg [7:0] tsh;
  always @(posedge clk) begin
    if (rst) begin
      tstate <= 2'd0;
      tbit <= 3'd0;
      tsh <= 8'd0;
      tx <= 1'b1;
      tx_ready <= 1'b1;
    end else if (tstate == 2'd0) begin
      tx <= 1'b1;
      tx_ready <= 1'b1;
      if (tx_valid) begin
        tsh <= tx_data;
        tx_ready <= 1'b0;
        tstate <= 2'd1;
      end
    end else if (baud) begin
      if (tstate == 2'd1) begin
        tx <= 1'b0;
        tbit <= 3'd0;
        tstate <= 2'd2;
      end else if (tstate == 2'd2) begin
        tx <= tsh[0];
        tsh <= {1'b0, tsh[7:1]};
        if (tbit == 3'd7) tstate <= 2'd3;
        else tbit <= tbit + 3'd1;
      end else begin
        tx <= 1'b1;
        tstate <= 2'd0;
      end
    end
  end

  reg [1:0] rstate;
  reg [2:0] rbit;
  reg [7:0] rsh;
  always @(posedge clk) begin
    if (rst) begin
      rstate <= 2'd0;
      rbit <= 3'd0;
      rsh <= 8'd0;
      rx_data <= 8'd0;
      rx_valid <= 1'b0;
    end else if (rstate == 2'd0) begin
      rx_valid <= 1'b0;
      if (rx == 1'b0) begin
        rbit <= 3'd0;
        rstate <= 2'd1;
      end
    end else if (baud) begin
      if (rstate == 2'd1) begin
        if (rx == 1'b0) rstate <= 2'd2;
        else rstate <= 2'd0;
      end else if (rstate == 2'd2) begin
        rsh <= {rx, rsh[7:1]};
        if (rbit == 3'd7) rstate <= 2'd3;
        else rbit <= rbit + 3'd1;
      end else begin
        rx_data <= rsh;
        rx_valid <= 1'b1;
        rstate <= 2'd0;
      end
    end
  end
endmodule
`,
  },
  {
    id: "reduce.v",
    blurb:
      "A reduction is one bit. &a is every bit. |b is any bit. !a is true when a is zero. a && b is true when both are nonzero, which is not a & b.",
    source: `module reduce (
  input [3:0] a,
  input [3:0] b,
  output y,
  output z,
  output n,
  output both
);
  assign y = &a;
  assign z = |b;
  assign n = !a;
  assign both = a && b;
endmodule
`,
  },
  {
    id: "sreg.v",
    blurb:
      "The for unrolls into eight flops. Reset clears every bit. Each clock shifts d into s[0].",
    source: `module shift (
  input clk,
  input rst,
  input d,
  output [7:0] q
);
  integer i;
  reg [7:0] s;
  always @(posedge clk) begin
    if (rst) begin
      for (i = 0; i < 8; i = i + 1) s[i] <= 1'b0;
    end else begin
      s[0] <= d;
      for (i = 1; i < 8; i = i + 1) s[i] <= s[i - 1];
    end
  end
  assign q = s;
endmodule
`,
  },
  {
    id: "slice.v",
    blurb:
      "a[s +: 4] is four bits starting at s. A constant base is a fixed slice. A variable base is a mux, and a bit past the end is 0.",
    source: `module slice (
  input [7:0] a,
  input [2:0] s,
  output [3:0] y,
  output [3:0] z
);
  assign y = a[s +: 4];
  assign z = a[5 -: 4];
endmodule
`,
  },
  {
    id: "grow.v",
    blurb:
      "generate unrolls one inverter per bit. The index is a constant, so .y(y[i]) is a real net.",
    source: `module inv (
  input a,
  output y
);
  assign y = ~a;
endmodule

module grow (
  input [3:0] a,
  output [3:0] y
);
  genvar i;
  generate
    for (i = 0; i < 4; i = i + 1) begin
      inv u (.a(a[i]), .y(y[i]));
    end
  endgenerate
endmodule
`,
  },
  {
    id: "macro.v",
    blurb:
      "`define WIDTH sets the bus. `ifdef keeps the invert and drops the other branch, so that text is never parsed.",
    source: `\`define WIDTH 4
\`define INVERT
module wide (
  input [\`WIDTH-1:0] a,
  output [\`WIDTH-1:0] y
);
\`ifdef INVERT
  assign y = ~a;
\`else
  assign y = a;
\`endif
endmodule
`,
  },
  {
    id: "case.v",
    blurb:
      "case lowers to a mux. Each arm is a constant. default is the arm that matches nothing else.",
    source: `module decode (
  input [1:0] s,
  input [3:0] a,
  output reg [3:0] y
);
  always @* begin
    case (s)
      2'd0: y = a;
      2'd1: y = {a[2:0], 1'b0};
      2'd2: y = {a[0], a[3:1]};
      default: y = 4'd0;
    endcase
  end
endmodule
`,
  },
  {
    id: "window.v",
    blurb:
      "a[i+3:i] is four bits. The width is constant, so it lowers to the same mux as a[i +: 4].",
    source: `module window (
  input [7:0] a,
  input [1:0] i,
  output [3:0] y
);
  assign y = a[i + 3:i];
endmodule
`,
  },
  {
    id: "fsm.v",
    blurb:
      "A clocked case is a state machine. A bit with no assignment on a path holds. y is high for one cycle after go.",
    source: `module fsm (
  input clk,
  input go,
  output reg y
);
  reg [1:0] state;
  always @(posedge clk) begin
    case (state)
      2'd0: begin
        y <= 1'b0;
        if (go) state <= 2'd1;
        else state <= 2'd0;
      end
      2'd1: begin
        y <= 1'b1;
        state <= 2'd2;
      end
      default: begin
        y <= 1'b0;
        state <= 2'd0;
      end
    endcase
  end
endmodule
`,
  },
  {
    id: "cpu8.v",
    blurb:
      "8-bit CPU. A 16-word ROM, an 8-register file, and an ALU. One instruction per clock. The critical path is the ROM, the register read, and the ALU.",
    source: `module alu8 (
  input [7:0] a,
  input [7:0] b,
  input [2:0] op,
  output reg [7:0] y
);
  wire [8:0] sum;
  wire [8:0] diff;
  assign sum = {1'b0, a} + {1'b0, b};
  assign diff = {1'b0, a} - {1'b0, b};
  always @* begin
    case (op)
      3'd0: y = sum[7:0];
      3'd1: y = diff[7:0];
      3'd2: y = a & b;
      3'd3: y = a | b;
      3'd4: y = a ^ b;
      3'd5: y = {a[6:0], 1'b0};
      3'd6: y = {1'b0, a[7:1]};
      default: y = b;
    endcase
  end
endmodule

module regfile (
  input clk,
  input we,
  input [2:0] wa,
  input [7:0] wd,
  input [2:0] ra,
  input [2:0] rb,
  output [7:0] qa,
  output [7:0] qb
);
  reg [7:0] mem [0:7];
  always @(posedge clk) begin
    if (we) mem[wa] <= wd;
  end
  assign qa = mem[ra];
  assign qb = mem[rb];
endmodule

// 16-instruction ROM, 8 registers, one ALU. One instruction per clock.
// insn[15:12] op, insn[11:9] rd, insn[8:6] ra, insn[5:3] rb.
module cpu8 (
  input clk,
  input rst,
  input [7:0] din,
  output [7:0] dout,
  output [3:0] pc_out,
  output reg halt
);
  reg [3:0] pc;
  reg [15:0] insn;
  wire [3:0] op;
  wire [2:0] rd;
  wire [2:0] ra;
  wire [2:0] rb;
  wire [7:0] qa;
  wire [7:0] qb;
  wire [7:0] y;
  wire use_din;
  wire we;
  wire [2:0] alu_op;
  assign op = insn[15:12];
  assign rd = insn[11:9];
  assign ra = insn[8:6];
  assign rb = insn[5:3];
  assign use_din = op == 4'd6;
  assign we = op != 4'd0 && op != 4'hf;
  assign alu_op = op[2:0];

  regfile rf (
    .clk(clk),
    .we(we),
    .wa(rd),
    .wd(use_din ? din : y),
    .ra(ra),
    .rb(rb),
    .qa(qa),
    .qb(qb)
  );
  alu8 alu (
    .a(qa),
    .b(qb),
    .op(alu_op),
    .y(y)
  );

  always @* begin
    case (pc)
      4'd0: insn = 16'h6000;
      4'd1: insn = 16'h6480;
      4'd2: insn = 16'h1898;
      4'd3: insn = 16'h2a20;
      4'd4: insn = 16'h32a8;
      4'd5: insn = 16'h4348;
      4'd6: insn = 16'h53d0;
      4'd7: insn = 16'h1458;
      4'd8: insn = 16'h6c60;
      4'd9: insn = 16'h1ce8;
      4'd10: insn = 16'h2570;
      4'd11: insn = 16'h3df8;
      4'd12: insn = 16'h4680;
      4'd13: insn = 16'h5708;
      4'd14: insn = 16'h1788;
      default: insn = 16'hf000;
    endcase
  end

  always @(posedge clk) begin
    if (rst) begin
      pc <= 4'd0;
      halt <= 1'b0;
    end else if (!halt) begin
      if (op == 4'hf) halt <= 1'b1;
      else pc <= pc + 4'd1;
    end
  end

  assign dout = y;
  assign pc_out = pc;
endmodule
`,
  },
  {
    id: "fir10.v",
    blurb:
      "10-tap 8-bit FIR. Ten 8x8 products sum in a wrapping 16-bit tree. load shifts coefficients in; otherwise a sample shifts in and acc adds the dot product.",
    source: `
// 10-tap 8-bit FIR. Each tap is an 8x8 product, summed in a
// 16-bit tree that wraps (this build allows at most 16-bit wires).
// load shifts din into the coefficients. Otherwise din shifts into
// the samples and acc adds the dot product.
module fir10 (
  input clk,
  input rst,
  input load,
  input [7:0] din,
  output reg [15:0] acc
);
  reg [7:0] s0, s1, s2, s3, s4, s5, s6, s7, s8, s9;
  reg [7:0] c0, c1, c2, c3, c4, c5, c6, c7, c8, c9;
  wire [15:0] p0, p1, p2, p3, p4, p5, p6, p7, p8, p9;
  wire [15:0] t0_0, t0_1, t0_2, t0_3, t0_4;
  wire [15:0] t1_0, t1_1;
  wire [15:0] t2_0;
  wire [15:0] t3_0;
  wire [15:0] dot;
  assign p0 = s0 * c0;
  assign p1 = s1 * c1;
  assign p2 = s2 * c2;
  assign p3 = s3 * c3;
  assign p4 = s4 * c4;
  assign p5 = s5 * c5;
  assign p6 = s6 * c6;
  assign p7 = s7 * c7;
  assign p8 = s8 * c8;
  assign p9 = s9 * c9;
  assign t0_0 = p0 + p1;
  assign t0_1 = p2 + p3;
  assign t0_2 = p4 + p5;
  assign t0_3 = p6 + p7;
  assign t0_4 = p8 + p9;
  assign t1_0 = t0_0 + t0_1;
  assign t1_1 = t0_2 + t0_3;
  assign t2_0 = t1_0 + t1_1;
  assign t3_0 = t2_0 + t0_4;
  assign dot = t3_0;
  always @(posedge clk) begin
    if (rst) begin
      s0 <= 8'd0;
      s1 <= 8'd0;
      s2 <= 8'd0;
      s3 <= 8'd0;
      s4 <= 8'd0;
      s5 <= 8'd0;
      s6 <= 8'd0;
      s7 <= 8'd0;
      s8 <= 8'd0;
      s9 <= 8'd0;
      c0 <= 8'd0;
      c1 <= 8'd0;
      c2 <= 8'd0;
      c3 <= 8'd0;
      c4 <= 8'd0;
      c5 <= 8'd0;
      c6 <= 8'd0;
      c7 <= 8'd0;
      c8 <= 8'd0;
      c9 <= 8'd0;
      acc <= 16'd0;
    end else if (load) begin
      c0 <= din;
      c1 <= c0;
      c2 <= c1;
      c3 <= c2;
      c4 <= c3;
      c5 <= c4;
      c6 <= c5;
      c7 <= c6;
      c8 <= c7;
      c9 <= c8;
    end else begin
      s0 <= din;
      s1 <= s0;
      s2 <= s1;
      s3 <= s2;
      s4 <= s3;
      s5 <= s4;
      s6 <= s5;
      s7 <= s6;
      s8 <= s7;
      s9 <= s8;
      acc <= acc + dot;
    end
  end
endmodule
`,
  },
  {
    id: "xfir.v",
    blurb:
      "10-tap dual inner product. Each sample is multiplied by its coefficient and by the next one. Both 16-bit sums wrap, then add into acc. The extra products share the fir10 registers.",
    source: `
// 10-tap dual inner product. Each sample is multiplied by its
// coefficient and by the next coefficient. Both sums wrap at 16
// bits, then add into acc. The extra products share the same
// registers: a 20-tap delay line would exceed the 192-input
// combinational cloud.
// load shifts din into the coefficients. Otherwise din shifts
// into the samples and acc adds both inner products.
module xfir (
  input clk,
  input rst,
  input load,
  input [7:0] din,
  output reg [15:0] acc
);
  reg [7:0] s0, s1, s2, s3, s4, s5, s6, s7, s8, s9;
  reg [7:0] c0, c1, c2, c3, c4, c5, c6, c7, c8, c9;
  wire [15:0] p0, p1, p2, p3, p4, p5, p6, p7, p8, p9;
  wire [15:0] q0, q1, q2, q3, q4, q5, q6, q7, q8, q9;
  wire [15:0] d0_0, d0_1, d0_2, d0_3, d0_4;
  wire [15:0] d1_0, d1_1;
  wire [15:0] d2_0;
  wire [15:0] d3_0;
  wire [15:0] x0_0, x0_1, x0_2, x0_3, x0_4;
  wire [15:0] x1_0, x1_1;
  wire [15:0] x2_0;
  wire [15:0] x3_0;
  wire [15:0] dot, cross, sum;
  assign p0 = s0 * c0;
  assign q0 = s0 * c1;
  assign p1 = s1 * c1;
  assign q1 = s1 * c2;
  assign p2 = s2 * c2;
  assign q2 = s2 * c3;
  assign p3 = s3 * c3;
  assign q3 = s3 * c4;
  assign p4 = s4 * c4;
  assign q4 = s4 * c5;
  assign p5 = s5 * c5;
  assign q5 = s5 * c6;
  assign p6 = s6 * c6;
  assign q6 = s6 * c7;
  assign p7 = s7 * c7;
  assign q7 = s7 * c8;
  assign p8 = s8 * c8;
  assign q8 = s8 * c9;
  assign p9 = s9 * c9;
  assign q9 = s9 * c0;
  assign d0_0 = p0 + p1;
  assign d0_1 = p2 + p3;
  assign d0_2 = p4 + p5;
  assign d0_3 = p6 + p7;
  assign d0_4 = p8 + p9;
  assign d1_0 = d0_0 + d0_1;
  assign d1_1 = d0_2 + d0_3;
  assign d2_0 = d1_0 + d1_1;
  assign d3_0 = d2_0 + d0_4;
  assign x0_0 = q0 + q1;
  assign x0_1 = q2 + q3;
  assign x0_2 = q4 + q5;
  assign x0_3 = q6 + q7;
  assign x0_4 = q8 + q9;
  assign x1_0 = x0_0 + x0_1;
  assign x1_1 = x0_2 + x0_3;
  assign x2_0 = x1_0 + x1_1;
  assign x3_0 = x2_0 + x0_4;
  assign dot = d3_0;
  assign cross = x3_0;
  assign sum = dot + cross;
  always @(posedge clk) begin
    if (rst) begin
      s0 <= 8'd0;
      s1 <= 8'd0;
      s2 <= 8'd0;
      s3 <= 8'd0;
      s4 <= 8'd0;
      s5 <= 8'd0;
      s6 <= 8'd0;
      s7 <= 8'd0;
      s8 <= 8'd0;
      s9 <= 8'd0;
      c0 <= 8'd0;
      c1 <= 8'd0;
      c2 <= 8'd0;
      c3 <= 8'd0;
      c4 <= 8'd0;
      c5 <= 8'd0;
      c6 <= 8'd0;
      c7 <= 8'd0;
      c8 <= 8'd0;
      c9 <= 8'd0;
      acc <= 16'd0;
    end else if (load) begin
      c0 <= din;
      c1 <= c0;
      c2 <= c1;
      c3 <= c2;
      c4 <= c3;
      c5 <= c4;
      c6 <= c5;
      c7 <= c6;
      c8 <= c7;
      c9 <= c8;
    end else begin
      s0 <= din;
      s1 <= s0;
      s2 <= s1;
      s3 <= s2;
      s4 <= s3;
      s5 <= s4;
      s6 <= s5;
      s7 <= s6;
      s8 <= s7;
      s9 <= s8;
      acc <= acc + sum;
    end
  end
endmodule
`,
  },
];
