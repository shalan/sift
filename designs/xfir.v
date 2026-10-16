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
