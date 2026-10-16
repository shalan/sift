// 8-bit DSP slice. One opcode per clock.
// cpu8 has an 8-bit add/sub ALU and a register file. This one multiplies.
//
// State: operands a and b, a 16-bit accumulator, a 4-sample delay line, and dout.
// prod is the full 8x8 product. sum, diff, and mac are 16-bit.
// shl and shr move acc by din[1:0]. sat clips to 255 when the high byte is not zero.
// The delay line shifts the sample port x every clock that rst is low.
// z and n are the accumulator flags, combinational.
module dsp8 (
  input clk,
  input rst,
  input [3:0] op,
  input [7:0] din,
  input [7:0] x,
  output reg [7:0] dout,
  output reg [15:0] acc,
  output z,
  output n
);
  reg [7:0] a, b;
  reg [7:0] x0, x1, x2, x3;
  wire [15:0] prod;
  wire [15:0] sum;
  wire [15:0] diff;
  wire [15:0] mac;
  wire [15:0] shl;
  wire [15:0] shr;
  wire [7:0] sat;

  assign prod = a * b;
  assign sum = acc + {8'b0, a};
  assign diff = acc - {8'b0, b};
  assign mac = acc + prod;
  assign shl = acc << din[1:0];
  assign shr = acc >> din[1:0];
  assign sat = |acc[15:8] ? 8'hff : acc[7:0];
  assign z = acc == 16'd0;
  assign n = acc[15];

  always @(posedge clk) begin
    if (rst) begin
      a <= 8'd0;
      b <= 8'd0;
      x0 <= 8'd0;
      x1 <= 8'd0;
      x2 <= 8'd0;
      x3 <= 8'd0;
      acc <= 16'd0;
      dout <= 8'd0;
    end else begin
      x0 <= x;
      x1 <= x0;
      x2 <= x1;
      x3 <= x2;
      case (op)
        4'd0: a <= din;
        4'd1: b <= din;
        4'd2: acc <= prod;
        4'd3: acc <= sum;
        4'd4: acc <= diff;
        4'd5: acc <= mac;
        4'd6: acc <= shl;
        4'd7: acc <= shr;
        4'd8: dout <= sat;
        4'd9: a <= a + b;
        4'd10: a <= a ^ b;
        4'd11: a <= a & b;
        4'd12: a <= a | x0;
        4'd13: a <= x0;
        4'd14: b <= x3;
        default: dout <= a;
      endcase
    end
  end
endmodule
