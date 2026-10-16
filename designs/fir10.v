// 10-tap 8-bit FIR. Each tap is an 8x8 product, summed in a
// 16-bit tree that wraps.
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
