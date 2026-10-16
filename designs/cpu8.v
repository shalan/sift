module alu8 (
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
