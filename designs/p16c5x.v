// Vendored from https://github.com/JeckSmit/MOS6502-microprocessor (src/).
// The sources are Michael Morris's pipelined P16C5x, not a 6502. LGPL-2.1.
// The clock port Clk is renamed clk. The $readmemh inits are removed so
// elaboration does not depend on a file name.
// The async set of Rst is 1'b1. ~0 does not fold to a constant.

////////////////////////////////////////////////////////////////////////////////
//
//  Copyright 2013 by Michael A. Morris, dba M. A. Morris & Associates
//
//  All rights reserved. The source code contained herein is publicly released
//  under the terms and conditions of the GNU Lesser Public License. No part of
//  this source code may be reproduced or transmitted in any form or by any
//  means, electronic or mechanical, including photocopying, recording, or any
//  information storage and retrieval system in violation of the license under
//  which the source code is released.
//
//  The source code contained herein is free; it may be redistributed and/or
//  modified in accordance with the terms of the GNU Lesser General Public
//  License as published by the Free Software Foundation; either version 2.1 of
//  the GNU Lesser General Public License, or any later version.
//
//  The source code contained herein is freely released WITHOUT ANY WARRANTY;
//  without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
//  PARTICULAR PURPOSE. (Refer to the GNU Lesser General Public License for
//  more details.)
//
//  A copy of the GNU Lesser General Public License should have been received
//  along with the source code contained herein; if not, a copy can be obtained
//  by writing to:
//
//  Free Software Foundation, Inc.
//  51 Franklin Street, Fifth Floor
//  Boston, MA  02110-1301 USA
//
//  Further, no use of this source code is permitted in any form or means
//  without inclusion of this banner prominently in any derived works.
//
//  Michael A. Morris
//  Huntsville, AL
//
////////////////////////////////////////////////////////////////////////////////

`timescale 1ns / 1ps

//////////////////////////////////////////////////////////////////////////////////
// Company:         M. A. Morris & Associates 
// Engineer:        Michael A. Morris
// 
// Create Date:     14:53:13 06/15/2013 
// Design Name:     P16C5x-compatible Synthesizable Processor Core
// Module Name:     P16C5x_ALU 
// Project Name:    C:\XProjects\ISE10.1i\M16C5x 
// Target Devices:  RAM-based FPGAs: XC3S50A-xVQ100, XC3S200A-xVQ100 
// Tool versions:   Xilinx ISE 10.1i SP3
//
// Description:
//
//  Module implements the ALU of the P16C5x synthesizable processor core. It has
//  been taken out of the PIC16C5x synthesizable processor core and made into a 
//  separate module. No changes have been made to the ALU code in the process.
//
// Dependencies: 
//
// Revision:
// 
//  1.00    13F15   MAM     Original file creation date.
//
//  1.10    13F23   MAM     Changed order of ALU_Op[10] and ALU_Op[9]. Now the
//                          modules uses ALU_Op[9:0] internally instead of 
//                          {ALU_Op[10], ALU_Op[8:0]} as originally constructed.
// 
// Additional Comments:
//
//  The ALU data output, DO, has been registered to support a higher operating
//  speed when a multi-cycle instruction cycle is used. Parameterization of this
//  may be added in the future, but the current module must be edited to remove
//  the DO register and the un-registered multiplexer, which has been commented
//  out, added back in when single cycle operation is desired.
//
////////////////////////////////////////////////////////////////////////////////

module P16C5x_ALU (
    input   Rst,
    input   clk,
    input   CE,
    
    input   [11:0] ALU_Op,              // ALU Control Word
    input   WE_PSW,                     // Write Enable for {Z, DC, C} from DI

    input   [7:0] DI,                   // Data Input
    input   [7:0] KI,                   // Literal Input
    
    output  reg [7:0] DO,               // ALU Output
    output  Z_Tst,                      // ALU Zero Test Output
    output  g,                          // Bit Test Condition
    
    output  reg [7:0] W,                // Working Register 
    
    output  reg Z,                      // Z(ero) ALU Status Output
    output  reg DC,                     // Digit Carry ALU Status Output
    output  reg C                       // Carry Flag ALU Status Output
);

////////////////////////////////////////////////////////////////////////////////
//
//  Declarations
//

wire    [7:0] A, B, Y;

wire    [7:0] X;
wire    C3, C7;

wire    [1:0] LU_Op;
reg     [7:0] V;

wire    [1:0] S_Sel;
reg     [7:0] S;

wire    [2:0] Bit;
reg     [7:0] Msk;

wire    [7:0] U;
wire    [7:0] T;

wire    [1:0] D_Sel;

////////////////////////////////////////////////////////////////////////////////
//
//  ALU Implementation - ALU[3:0] are overloaded for the four ALU elements:
//                          Arithmetic Unit, Logic Unit, Shift Unit, and Bit
//                          Processor.
//
//  ALU Operations - Arithmetic, Logic, and Shift Units
//
//  ALU_Op[1:0] = ALU Unit Operation Code
//
//      Arithmetic Unit (AU): 00 => Y = A +  B;
//                            01 => Y = A +  B + 1;
//                            10 => Y = A + ~B     = A - B - 1;
//                            11 => Y = A + ~B + 1 = A - B;
//
//      Logic Unit (LU):      00 => V = ~A;
//                            01 => V =  A & B;
//                            10 => V =  A | B;
//                            11 => V =  A ^ B;
//
//      Shift Unit (SU):      00 => S = W;                // MOVWF
//                            01 => S = {A[3:0], A[7:4]}; // SWAPF
//                            10 => S = {C, A[7:1]};      // RRF
//                            11 => S = {A[6:0], C};      // RLF
//
//  ALU_Op[3:2] = ALU Operand:
//                  A      B
//          00 =>  File    0
//          01 =>  File    W
//          10 => Literal  0
//          11 => Literal  W;
//
//  ALU Operations - Bit Processor (BP)
//
//  ALU_Op[2:0] = Bit Select: 000 => Bit 0;
//                            001 => Bit 1;
//                            010 => Bit 2;
//                            011 => Bit 3;
//                            100 => Bit 4;
//                            101 => Bit 5;
//                            110 => Bit 6;
//                            111 => Bit 7;
//
//  ALU_Op[3] = Set: 0 - Clr Selected Bit;
//                   1 - Set Selected Bit;
//
//  ALU_Op[5:4] = Status Flag Update Select
//
//          00 => None
//          01 => C
//          10 => Z
//          11 => Z,DC,C
//
//  ALU_Op[7:6] = ALU Output Data Multiplexer
//
//          00 => AU
//          01 => LU
//          10 => SU
//          11 => BP
//
//  ALU_Op[8]  = Tst: 0 - Normal Operation
//                    1 - Test: INCFSZ/DECFSZ/BTFSC/BTFSS
//
//  ALU_Op[9]  = Write Enable Working Register (W)
//
//  ALU_Op[10] = Indirect Register, INDF, Selected
//
//  ALU_Op[11] = Write Enable File {RAM | Special Function Registers}
//

assign C_In  = ALU_Op[0];  // Adder Carry input
assign B_Inv = ALU_Op[1];  // B Bus input invert
assign B_Sel = ALU_Op[2];  // B Bus select
assign A_Sel = ALU_Op[3];  // A Bus select

//  AU Input Bus Multiplexers

assign A = ((A_Sel) ? KI : DI);
assign B = ((B_Sel) ?  W : 0 );
assign Y = ((B_Inv) ? ~B : B );

//  AU Adder

assign {C3, X[3:0]} = A[3:0] + Y[3:0] + C_In;
assign {C7, X[7:4]} = A[7:4] + Y[7:4] + C3;

//  Logic Unit (LU)

assign LU_Op = ALU_Op[1:0];

always @(*)
begin
    case (LU_Op)
        2'b00 : V <= ~A;
        2'b01 : V <=  A | B;
        2'b10 : V <=  A & B;
        2'b11 : V <=  A ^ B;
    endcase
end

//  Shifter and W Multiplexer

assign S_Sel = ALU_Op[1:0];

always @(*)
begin
    case (S_Sel)
        2'b00 : S <= B;                  // Pass Working Register (MOVWF)
        2'b01 : S <= {A[3:0], A[7:4]};   // Swap Nibbles (SWAPF)
        2'b10 : S <= {C, A[7:1]};        // Shift Right (RRF)
        2'b11 : S <= {A[6:0], C};        // Shift Left (RLF)
    endcase
end

//  Bit Processor

assign Bit = ALU_Op[2:0];
assign Set = ALU_Op[3];
assign Tst = ALU_Op[8];

always @(*)
begin
    case(Bit)
        3'b000  : Msk <= 8'b0000_0001;
        3'b001  : Msk <= 8'b0000_0010;
        3'b010  : Msk <= 8'b0000_0100;
        3'b011  : Msk <= 8'b0000_1000;
        3'b100  : Msk <= 8'b0001_0000;
        3'b101  : Msk <= 8'b0010_0000;
        3'b110  : Msk <= 8'b0100_0000;
        3'b111  : Msk <= 8'b1000_0000;
    endcase
end

assign U = ((Set) ? (DI | Msk) : (DI & ~Msk));

assign T = DI & Msk;
assign g = ((Tst) ? ((Set) ? |T : ~|T) 
                  : 1'b0              );

//  Output Data Mux

assign D_Sel = ALU_Op[7:6];

always @(posedge clk)
begin
    if(Rst)
        DO <= #1 0;
    else
        case (D_Sel)
            2'b00 : DO <= #1 X;     // Arithmetic Unit Output
            2'b01 : DO <= #1 V;     // Logic Unit Output
            2'b10 : DO <= #1 S;     // Shifter Output
            2'b11 : DO <= #1 U;     // Bit Processor Output
        endcase
end

//always @(*)
//begin
//    case (D_Sel)
//        2'b00 : DO <= X;     // Arithmetic Unit Output
//        2'b01 : DO <= V;     // Logic Unit Output
//        2'b10 : DO <= S;     // Shifter Output
//        2'b11 : DO <= U;     // Bit Processor Output
//    endcase
//end

//  Working Register

assign WE_W = ALU_Op[9];

always @(posedge clk)
begin
    if(Rst)
        W <= #1 8'b0;
    else if(CE)
        W <= #1 ((WE_W) ? DO : W);
end

//  Z Register

assign Z_Sel = ALU_Op[5];
assign Z_Tst = ~|DO;

always @(posedge clk)
begin
    if(Rst)
        Z <= #1 1'b0;
    else if(CE)
        Z <= #1 ((Z_Sel) ? Z_Tst 
                         : ((WE_PSW) ? DO[2] : Z));
end

//  Digit Carry (DC) Register

assign DC_Sel = ALU_Op[5] & ALU_Op[4];

always @(posedge clk)
begin
    if(Rst)
        DC <= #1 1'b0;
    else if(CE)
        DC <= #1 ((DC_Sel) ? C3 
                           : ((WE_PSW) ? DO[1] : DC));
end

//  Carry (C) Register

assign C_Sel = ALU_Op[4];
assign S_Dir = ALU_Op[1] & ALU_Op[0];
assign C_Drv = ((~ALU_Op[7] & ~ALU_Op[6]) ? C7
                                          : ((S_Dir) ? A[7] : A[0]));

always @(posedge clk)
begin
    if(Rst)
        C <= #1 1'b0;
    else if(CE)
        C <= #1 ((C_Sel) ? C_Drv 
                         : ((WE_PSW) ? DO[0] : C));
end

endmodule

////////////////////////////////////////////////////////////////////////////////
//
//  Copyright 2009-2013 by Michael A. Morris, dba M. A. Morris & Associates
//
//  All rights reserved. The source code contained herein is publicly released
//  under the terms and conditions of the GNU Lesser Public License. No part of
//  this source code may be reproduced or transmitted in any form or by any
//  means, electronic or mechanical, including photocopying, recording, or any
//  information storage and retrieval system in violation of the license under
//  which the source code is released.
//
//  The source code contained herein is free; it may be redistributed and/or
//  modified in accordance with the terms of the GNU Lesser General Public
//  License as published by the Free Software Foundation; either version 2.1 of
//  the GNU Lesser General Public License, or any later version.
//
//  The source code contained herein is freely released WITHOUT ANY WARRANTY;
//  without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
//  PARTICULAR PURPOSE. (Refer to the GNU Lesser General Public License for
//  more details.)
//
//  A copy of the GNU Lesser General Public License should have been received
//  along with the source code contained herein; if not, a copy can be obtained
//  by writing to:
//
//  Free Software Foundation, Inc.
//  51 Franklin Street, Fifth Floor
//  Boston, MA  02110-1301 USA
//
//  Further, no use of this source code is permitted in any form or means
//  without inclusion of this banner prominently in any derived works.
//
//  Michael A. Morris
//  Huntsville, AL
//
////////////////////////////////////////////////////////////////////////////////

`timescale 1ns / 1ps

///////////////////////////////////////////////////////////////////////////////
// Company:         M. A. Morris & Associates
// Engineer:        Michael A. Morris
// 
// Create Date:     18:05:57 08/18/2009 
// Design Name:     PIC16C5x Verilog Processor Model
// Module Name:     C:/ISEProjects/ISE10.1i/F16C5x/PIC16C5x_IDecode 
// Project Name:    C:/ISEProjects/ISE10.1i/F16C5x.ise
// Target Devices:  N/A 
// Tool versions:   ISE 10.1i SP3 
//
// Description:
//
//  Module implements a pipelined instruction decoder for the PIC16C5x family
//  of processors. The decoder utilizes three decode ROMs to reduce the number 
//  of logic levels in the decode path. All PIC16C5x instructions are decoded, 
//  and registered decoded instruction outputs for certain instructions and a
//  registered ALU Operation output is also provided. A decode error output is
//  also provided. The inputs required are the Instruction Register, IR, and a
//  instruction skip, i.e. pipeline flush/delay, signal.
//
//  ROM1 is used to decode instructions in the range of 0x000-0x007 and 0x800-
//  0xFFF. ROM1 outputs data that is multiplexed into the dIR, decoded IR FFs,
//  based on whether the instruction actually fits into this range. A 4-bit
//  address is used to access the ROM. Thus, DI[11] is the most significant 
//  address bit, and either DI[10:8] or DI[2:0] is used for the lower three
//  bits of the ROM1 address. DI[11] is used to select which set of the lower
//  three addresses are used. In the event that DI[11] is a logic 0, DI[2:0] is
//  decoded by ROM1, but the decode is incomplete. Thus, if DI[11] == 0, then
//  ROM1's output is valid only if DI[10:3] == 0 as well. This comparison and 
//  DI[10:3] <> 0 is used to select the value registered by dDI[8:0].
//
//  ROM2 is also used to decode the same range of instructions as ROM1. Its 
//  12-bit output is multiplexed with the 12-bit output of ROM3. ROM2 is a 16
//  location ROM with a 12-bit output used to drive ALU_Op[11:0], and it shares
//  its address generator with ROM1. Instead of using a single 22-bit wide ROM,
//  two ROMs were used with a common address generator in order to avoid the
//  assignment of the two fields to two different multiplexers for dIR and 
//  ALU_Op. ROM2 provides the registered ALU operation for the instruction for
//  instructions that deal primarily with special processor functions and
//  registers, 0x000-0x007, and for instructions that deal with literal opera-
//  tions, 0x800-0xFFF. As such, ROM2's ALU_Op outputs are fairly sparse.
//
//  ROM3 is used to decode a significantly larger number of IR bits. It decodes
//  DI[10:5] so it covers the remaining instructions not decoded by ROM2/ROM1.
//  ROM3's output drives the ALU_Op multiplexer like ROM2. The instructions
//  decoded by ROM3 support indirect access of the register file through the
//  Indirect File, INDF, access register. The address of INDF is 0, and if
//  DI[4:0] refers to INDF, then the address provided to the register file 
//  address bus should come from the FSR, File Select Register. To achieve a
//  compact decode of the instructions in this region, a 64 x 12 ROM is used,
//  but the indirect addressing function requires a combinatorial signal to 
//  be generated between the ROM and the ALU_Op multiplexer.
//
//  Where possible, a full decode of the instruction set is performed. Err is
//  is generated to properly indicate that the IR contains a reserved op code.
//  If dErr is asserted, a NOP operation is loaded into the ALU_Op, dIR, and
//  the Err output is asserted.
//
// Dependencies:    None 
//
// Revision: 
//
//  0.00    09H18   MAM     File Created
//
//  1.00    13F23   MAM     Changed input data port from IR to DI. When com-
//                          bined with the resulting changes to the upper level
//                          module, the result is to advance the decoding of the
//                          instruction being read from a synchronous ROM to the
//                          point in time when the data out of the ROM is valid
//                          as indicated by CE, i.e. Clock Enable.
//
//  1.10    13F23   MAM     Determined that WE_F bit, ALU_Op[11], was being set
//                          during BTFSC and BTFSS instructions. Changed ROM3 to
//                          clear ROM3[11] (loaded into ALU_Op[11]) when these
//                          instructions are found.
//
//  1.20    13F23   MAM     Added an additional bit to ROM1. New bit defines 
//                          when literal operations are being performed. This is
//                          to be used to create the WE and RE signals for the
//                          various I/O ports supported by the core. Realigned
//                          ROM2 and ROM3 such the ROM2/ROM3 bit 9 and bit 10
//                          are swapped. These two bits are not used within the
//                          ALU, but are used in the P16C5x module. Change is
//                          cosmetic.
//
// Additional Comments:
//
//  This instruction decoder is based on the combinatorial instruction decoder
//  developed for the original implementation of this processor. That decoder
//  is included as comments in this module as a reference for the correct
//  implementation of this module using ROMs and multiplexers.
//
//  ALU_Op[11:0] Mapping
//
//  ALU_Op[1:0] = ALU Unit Operation Code
//
//      Arithmetic Unit (AU): 00 => Y = A +  B; 
//                            01 => Y = A +  B + 1;
//                            10 => Y = A + ~B     = A - B - 1;
//                            11 => Y = A + ~B + 1 = A - B;
//
//      Logic Unit (LU):      00 => V = ~A; 
//                            01 => V =  A | B;
//                            10 => V =  A & B;
//                            11 => V =  A ^ B;
//
//      Shift Unit (SU):      00 => S = W;                // MOVWF
//                            01 => S = {A[3:0], A[7:4]}; // SWAPF
//                            10 => S = {C, A[7:1]};      // RRF
//                            11 => S = {A[6:0], C};      // RLF
//
//  ALU_Op[3:2] = ALU Operand: 
//                  A      B
//          00 =>  File    0 
//          01 =>  File    W
//          10 => Literal  0
//          11 => Literal  W;
//
//  ALU Operations - Bit Processor (BP)
//
//  ALU_Op[2:0] = Bit Select: 000 => Bit 0; 
//                            001 => Bit 1;
//                            010 => Bit 2;
//                            011 => Bit 3;
//                            100 => Bit 4; 
//                            101 => Bit 5;
//                            110 => Bit 6;
//                            111 => Bit 7;
//
//  ALU_Op[3] = Set: 0 - Clr Selected Bit;
//                   1 - Set Selected Bit;
//
//  ALU_Op[5:4] = Status Flag Update Select
//          
//          00 => None
//          01 => C
//          10 => Z
//          11 => Z,DC,C
//
//  ALU_Op[7:6] = ALU Output Data Multiplexer
//
//          00 => AU
//          01 => LU
//          10 => SU
//          11 => BP
//
//  ALU_Op[8]  = Tst: 0 - Normal Operation
//                    1 - Test: INCFSZ/DECFSZ/BTFSC/BTFSS
//
//  ALU_Op[9]  = Write Enable Working Register (W)
//
//  ALU_Op[10] = Indirect Register, INDF, Selected
//
//  ALU_Op[11] = Write Enable File {RAM | Special Function Registers}
//
///////////////////////////////////////////////////////////////////////////////

module P16C5x_IDec(
    input   Rst,
    input   clk,
    input   CE,
    
    input   [11:0] DI,
    input   Skip,

    output  reg [ 9:0] dIR,
    output  reg [11:0] ALU_Op,
    output  reg [ 8:0] KI,

    output  reg Err
);

//
///////////////////////////////////////////////////////////////////////////////
//
//  Unused Opcodes - PIC16C5x Family
//
//localparam pOP_RSVD01 = 12'b0000_0000_0001;   // Reserved - Unused Opcode
//
//localparam pOP_RSVD08 = 12'b0000_0000_1000;   // Reserved - Unused Opcode
//localparam pOP_RSVD09 = 12'b0000_0000_1001;   // Reserved - Unused Opcode
//localparam pOP_RSVD10 = 12'b0000_0000_1010;   // Reserved - Unused Opcode
//localparam pOP_RSVD11 = 12'b0000_0000_1011;   // Reserved - Unused Opcode
//localparam pOP_RSVD12 = 12'b0000_0000_1100;   // Reserved - Unused Opcode
//localparam pOP_RSVD13 = 12'b0000_0000_1101;   // Reserved - Unused Opcode
//localparam pOP_RSVD14 = 12'b0000_0000_1110;   // Reserved - Unused Opcode
//localparam pOP_RSVD15 = 12'b0000_0000_1111;   // Reserved - Unused Opcode
//
//localparam pOP_RSVD16 = 12'b0000_0001_0000;   // Reserved - Unused Opcode
//localparam pOP_RSVD17 = 12'b0000_0001_0001;   // Reserved - Unused Opcode
//localparam pOP_RSVD18 = 12'b0000_0001_0010;   // Reserved - Unused Opcode
//localparam pOP_RSVD19 = 12'b0000_0001_0011;   // Reserved - Unused Opcode
//localparam pOP_RSVD20 = 12'b0000_0001_0100;   // Reserved - Unused Opcode
//localparam pOP_RSVD21 = 12'b0000_0001_0101;   // Reserved - Unused Opcode
//localparam pOP_RSVD22 = 12'b0000_0001_0110;   // Reserved - Unused Opcode
//localparam pOP_RSVD23 = 12'b0000_0001_0111;   // Reserved - Unused Opcode
//localparam pOP_RSVD24 = 12'b0000_0001_1000;   // Reserved - Unused Opcode
//localparam pOP_RSVD25 = 12'b0000_0001_1001;   // Reserved - Unused Opcode
//localparam pOP_RSVD26 = 12'b0000_0001_1010;   // Reserved - Unused Opcode
//localparam pOP_RSVD27 = 12'b0000_0001_1011;   // Reserved - Unused Opcode
//localparam pOP_RSVD28 = 12'b0000_0001_1100;   // Reserved - Unused Opcode
//localparam pOP_RSVD29 = 12'b0000_0001_1101;   // Reserved - Unused Opcode
//localparam pOP_RSVD30 = 12'b0000_0001_1110;   // Reserved - Unused Opcode
//localparam pOP_RSVD31 = 12'b0000_0001_1111;   // Reserved - Unused Opcode
//
//localparam pOP_RSVD65 = 12'b0000_0100_0001;   // Reserved - Unused Opcode
//localparam pOP_RSVD66 = 12'b0000_0100_0010;   // Reserved - Unused Opcode
//localparam pOP_RSVD67 = 12'b0000_0100_0011;   // Reserved - Unused Opcode
//localparam pOP_RSVD68 = 12'b0000_0100_0100;   // Reserved - Unused Opcode
//localparam pOP_RSVD69 = 12'b0000_0100_0101;   // Reserved - Unused Opcode
//localparam pOP_RSVD70 = 12'b0000_0100_0110;   // Reserved - Unused Opcode
//localparam pOP_RSVD71 = 12'b0000_0100_0111;   // Reserved - Unused Opcode
//localparam pOP_RSVD72 = 12'b0000_0100_1000;   // Reserved - Unused Opcode
//localparam pOP_RSVD73 = 12'b0000_0100_1001;   // Reserved - Unused Opcode
//localparam pOP_RSVD74 = 12'b0000_0100_1010;   // Reserved - Unused Opcode
//localparam pOP_RSVD75 = 12'b0000_0100_1011;   // Reserved - Unused Opcode
//localparam pOP_RSVD76 = 12'b0000_0100_1100;   // Reserved - Unused Opcode
//localparam pOP_RSVD77 = 12'b0000_0100_1101;   // Reserved - Unused Opcode
//localparam pOP_RSVD78 = 12'b0000_0100_1110;   // Reserved - Unused Opcode
//localparam pOP_RSVD79 = 12'b0000_0100_1111;   // Reserved - Unused Opcode
//
//localparam pOP_RSVD80 = 12'b0000_0101_0000;   // Reserved - Unused Opcode
//localparam pOP_RSVD81 = 12'b0000_0101_0001;   // Reserved - Unused Opcode
//localparam pOP_RSVD82 = 12'b0000_0101_0010;   // Reserved - Unused Opcode
//localparam pOP_RSVD83 = 12'b0000_0101_0011;   // Reserved - Unused Opcode
//localparam pOP_RSVD84 = 12'b0000_0101_0100;   // Reserved - Unused Opcode
//localparam pOP_RSVD85 = 12'b0000_0101_0101;   // Reserved - Unused Opcode
//localparam pOP_RSVD86 = 12'b0000_0101_0110;   // Reserved - Unused Opcode
//localparam pOP_RSVD87 = 12'b0000_0101_0111;   // Reserved - Unused Opcode
//localparam pOP_RSVD88 = 12'b0000_0101_1000;   // Reserved - Unused Opcode
//localparam pOP_RSVD89 = 12'b0000_0101_1001;   // Reserved - Unused Opcode
//localparam pOP_RSVD90 = 12'b0000_0101_1010;   // Reserved - Unused Opcode
//localparam pOP_RSVD91 = 12'b0000_0101_1011;   // Reserved - Unused Opcode
//localparam pOP_RSVD92 = 12'b0000_0101_1100;   // Reserved - Unused Opcode
//localparam pOP_RSVD93 = 12'b0000_0101_1101;   // Reserved - Unused Opcode
//localparam pOP_RSVD94 = 12'b0000_0101_1110;   // Reserved - Unused Opcode
//localparam pOP_RSVD95 = 12'b0000_0101_1111;   // Reserved - Unused Opcode
//
///////////////////////////////////////////////////////////////////////////////
//
//  PIC16C5x Family Opcodes
//
//localparam pOP_NOP    = 12'b0000_0000_0000;   // No Operation 
//localparam pOP_OPTION = 12'b0000_0000_0010;   // Set Option Register
//localparam pOP_SLEEP  = 12'b0000_0000_0011;   // Set Sleep Register
//localparam pOP_CLRWDT = 12'b0000_0000_0100;   // Clear Watchdog Timer
//localparam pOP_TRISA  = 12'b0000_0000_0101;   // Set Port A Tristate Ctrl Reg
//localparam pOP_TRISB  = 12'b0000_0000_0110;   // Set Port B Tristate Ctrl Reg
//localparam pOP_TRISC  = 12'b0000_0000_0111;   // Set Port C Tristate Ctrl Reg
//localparam pOP_MOVWF  =  7'b0000_001;         // F = W;
//localparam pOP_CLRW   = 12'b0000_0100_0000;   // W = 0; Z;
//localparam pOP_CLRF   =  7'b0000_011; // F = 0; Z;
//localparam pOP_SUBWF  =  6'b0000_10;  // D ? F = F - W : W = F - W; Z, C, DC;
//localparam pOP_DECF   =  6'b0000_11;  // D ? F = F - 1 : W = F - 1; Z;
////
//localparam pOP_IORWF  =  6'b0001_00;  // D ? F = F | W : W = F | W; Z; 
//localparam pOP_ANDWF  =  6'b0001_01;  // D ? F = F & W : W = F & W; Z;
//localparam pOP_XORWF  =  6'b0001_10;  // D ? F = F ^ W : W = F ^ W; Z;
//localparam pOP_ADDWF  =  6'b0001_11;  // D ? F = F + W : W = F + W; Z, C, DC;
////
//localparam pOP_MOVF   =  6'b0010_00;  // D ? F = F     : W = F    ; Z;
//localparam pOP_COMF   =  6'b0010_01;  // D ? F = ~F    : W = ~F   ; Z;
//localparam pOP_INCF   =  6'b0010_10;  // D ? F = F + 1 : W = F + 1; Z;
//localparam pOP_DECFSZ =  6'b0010_11;  // D ? F = F - 1 : W = F - 1; skip if Z
////
//localparam pOP_RRF    =  6'b0011_00;  // D ? F = {C, F[7:1]}
////                                         : W = {C, F[7:1]}; C = F[0]; 
//localparam pOP_RLF    =  6'b0011_01;  // D ? F = {F[6:0], C}
////                                         : W = {F[6:0], C}; C = F[7];
//localparam pOP_SWAPF  =  6'b0011_10;  // D ? F = t
////                                         : W = t; t = {F[3:0], F[7:4]}; 
//localparam pOP_INCFSZ =  6'b0011_11;  // D ? F = F - 1 : W = F - 1; skip if Z
////
//localparam pOP_BCF    =  4'b0100;     // F = F & ~(1 << bit);
//localparam pOP_BSF    =  4'b0101;     // F = F |  (1 << bit);
//localparam pOP_BTFSC  =  4'b0110;     // skip if F[bit] == 0;
//localparam pOP_BTFSS  =  4'b0111;     // skip if F[bit] == 1;
////
//localparam pOP_RETLW  =  4'b1000;     // W = L; Pop(PC = TOS, TOS = NOS);
//localparam pOP_CALL   =  4'b1001;     // Push(TOS = PC + 1);
////                                       PC = {PA[2:0], 0, L[7:0]};
//localparam pOP_GOTO   =  3'b101;      // PC = {PA[2:0], L[8:0]};
//localparam pOP_MOVLW  =  4'b1100;     // W = L[7:0];
//localparam pOP_IORLW  =  4'b1101;     // W = L[7:0] | W; Z;
//localparam pOP_ANDLW  =  4'b1110;     // W = L[7:0] & W; Z;
//localparam pOP_XORLW  =  4'b1111;     // W = L[7:0] ^ W; Z;
//
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//
//  Variable Declarations
//

reg     [ 9:0] ROM1;            // Decode ROM1: 16x10
wire    [ 3:0] ROM1_Addr;       // ROM1 Address
reg     [11:0] ROM2;            // Decode ROM2: 16x12
wire    [ 3:0] ROM2_Addr;       // ROM2 Address (equals ROM1_Addr)
reg     [11:0] ROM3;            // Decode ROM3: 64x12
wire    [ 5:0] ROM3_Addr;       // ROM3 Address

wire    ROM1_Valid;             // ROM1 Output Valid: 1 - if ROM1 decode valid

wire    dErr;                   // Invalid/Reserved Instruction Decode Signal
wire    [11:0] dALU_Op;         // Combined ROM2, ROM3 ALU Pipeline Vector

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//
//  Instruction Decoder Implementation
//
//  ROM1 => dIR, decoded Instruction Register, is used to flag instructions
//          that require special processing in the execution stage.

assign ROM1_Addr = {DI[11], (DI[11] ? DI[10:8] : DI[2:0])};

always @(*)
begin
    case(ROM1_Addr)
        4'b0000 : ROM1 <= 10'b0_0_0000_0000;   // NOP
        4'b0001 : ROM1 <= 10'b0_0_0000_0000;   // Reserved
        4'b0010 : ROM1 <= 10'b0_1_0000_0000;   // OPTION
        4'b0011 : ROM1 <= 10'b0_0_0000_1000;   // SLEEP
        4'b0100 : ROM1 <= 10'b0_0_0001_0000;   // CLRWDT
        4'b0101 : ROM1 <= 10'b0_0_0010_0000;   // TRISA
        4'b0110 : ROM1 <= 10'b0_0_0100_0000;   // TRISB
        4'b0111 : ROM1 <= 10'b0_0_1000_0000;   // TRISC
        4'b1000 : ROM1 <= 10'b1_0_0000_0100;   // RETLW
        4'b1001 : ROM1 <= 10'b1_0_0000_0010;   // CALL
        4'b1010 : ROM1 <= 10'b1_0_0000_0001;   // GOTO
        4'b1011 : ROM1 <= 10'b1_0_0000_0001;   // GOTO
        4'b1100 : ROM1 <= 10'b1_0_0000_0000;   // MOVLW
        4'b1101 : ROM1 <= 10'b1_0_0000_0000;   // IORLW
        4'b1110 : ROM1 <= 10'b1_0_0000_0000;   // ANDLW
        4'b1111 : ROM1 <= 10'b1_0_0000_0000;   // XORLW
    endcase
end

assign ROM1_Valid = (DI[11] ? DI[11] : ~|DI[10:3]);

//  ROM2 => Input to ALU_Op for instructions decoded using ROM1_Addr

assign ROM2_Addr = {DI[11], (DI[11] ? DI[10:8] : DI[2:0])};

always @(*)
begin
    case(ROM2_Addr)
        4'b0000 : ROM2 <= 12'b0000_00_00_00_00;   // NOP
        4'b0001 : ROM2 <= 12'b0000_00_00_00_00;   // Reserved
        4'b0010 : ROM2 <= 12'b0000_00_00_00_00;   // OPTION
        4'b0011 : ROM2 <= 12'b0000_00_00_00_00;   // SLEEP
        4'b0100 : ROM2 <= 12'b0000_00_00_00_00;   // CLRWDT
        4'b0101 : ROM2 <= 12'b0000_00_00_00_00;   // TRISA
        4'b0110 : ROM2 <= 12'b0000_00_00_00_00;   // TRISB
        4'b0111 : ROM2 <= 12'b0000_00_00_00_00;   // TRISC
        4'b1000 : ROM2 <= 12'b0010_00_00_10_00;   // RETLW
        4'b1001 : ROM2 <= 12'b0000_00_00_10_00;   // CALL
        4'b1010 : ROM2 <= 12'b0000_00_00_00_00;   // GOTO
        4'b1011 : ROM2 <= 12'b0000_00_00_00_00;   // GOTO
        4'b1100 : ROM2 <= 12'b0010_00_00_10_00;   // MOVLW
        4'b1101 : ROM2 <= 12'b0010_01_10_11_01;   // IORLW
        4'b1110 : ROM2 <= 12'b0010_01_10_11_10;   // ANDLW
        4'b1111 : ROM2 <= 12'b0010_01_10_11_11;   // XORLW
    endcase
end

//  ROM3 - decode for remaining instructions

assign ROM3_Addr = DI[10:5];

always @(*)
begin
    case(ROM3_Addr)
        6'b000000 : ROM3 <= 12'b0000_00_00_00_00;   // Reserved
                                   
        6'b000001 : ROM3 <= 12'b1100_10_00_01_00;   // MOVWF
        6'b000010 : ROM3 <= 12'b0010_10_00_00_00;   // CLRW
        6'b000011 : ROM3 <= 12'b1100_10_00_00_00;   // CLRF
                                   
        6'b000100 : ROM3 <= 12'b0110_00_11_01_11;   // SUBWF  F,0
        6'b000101 : ROM3 <= 12'b1100_00_11_01_11;   // SUBWF  F,1
        6'b000110 : ROM3 <= 12'b0110_00_10_00_10;   // DECF   F,0
        6'b000111 : ROM3 <= 12'b1100_00_10_00_10;   // DECF   F,1
                                   
        6'b001000 : ROM3 <= 12'b0110_01_10_01_01;   // IORWF  F,0
        6'b001001 : ROM3 <= 12'b1100_01_10_01_01;   // IORWF  F,1
        6'b001010 : ROM3 <= 12'b0110_01_10_01_10;   // ANDWF  F,0
        6'b001011 : ROM3 <= 12'b1100_01_10_01_10;   // ANDWF  F,1
        6'b001100 : ROM3 <= 12'b0110_01_10_01_11;   // XORWF  F,0
        6'b001101 : ROM3 <= 12'b1100_01_10_01_11;   // XORWF  F,1
        6'b001110 : ROM3 <= 12'b0110_00_11_01_00;   // ADDWF  F,0
        6'b001111 : ROM3 <= 12'b1100_00_11_01_00;   // ADDWF  F,1
                                   
        6'b010000 : ROM3 <= 12'b0110_00_10_00_00;   // MOVF   F,0
        6'b010001 : ROM3 <= 12'b1100_00_10_00_00;   // MOVF   F,1
        6'b010010 : ROM3 <= 12'b0110_01_00_00_00;   // COMF   F,0
        6'b010011 : ROM3 <= 12'b1100_01_00_00_00;   // COMF   F,1
        6'b010100 : ROM3 <= 12'b0110_00_10_00_01;   // INCF   F,0
        6'b010101 : ROM3 <= 12'b1100_00_10_00_01;   // INCF   F,1
        6'b010110 : ROM3 <= 12'b0111_00_00_00_10;   // DECFSZ F,0
        6'b010111 : ROM3 <= 12'b1101_00_00_00_10;   // DECFSZ F,1
                                   
        6'b011000 : ROM3 <= 12'b0110_10_01_00_10;   // RRF    F,0
        6'b011001 : ROM3 <= 12'b1100_10_01_00_10;   // RRF    F,1
        6'b011010 : ROM3 <= 12'b0110_10_01_00_11;   // RLF    F,0
        6'b011011 : ROM3 <= 12'b1001_10_01_00_11;   // RLF    F,1
        6'b011100 : ROM3 <= 12'b0110_10_00_00_01;   // SWAPF  F,0
        6'b011101 : ROM3 <= 12'b1100_10_00_00_01;   // SWAPF  F,1
        6'b011110 : ROM3 <= 12'b0111_00_00_00_01;   // INCFSZ F,0
        6'b011111 : ROM3 <= 12'b1101_00_00_00_01;   // INCFSZ F,1
                                   
        6'b100000 : ROM3 <= 12'b1100_11_00_0_000;   // BCF    F,0
        6'b100001 : ROM3 <= 12'b1100_11_00_0_001;   // BCF    F,1
        6'b100010 : ROM3 <= 12'b1100_11_00_0_010;   // BCF    F,2
        6'b100011 : ROM3 <= 12'b1100_11_00_0_011;   // BCF    F,3
        6'b100100 : ROM3 <= 12'b1100_11_00_0_100;   // BCF    F,4
        6'b100101 : ROM3 <= 12'b1100_11_00_0_101;   // BCF    F,5
        6'b100110 : ROM3 <= 12'b1100_11_00_0_110;   // BCF    F,6
        6'b100111 : ROM3 <= 12'b1100_11_00_0_111;   // BCF    F,7
                                   
        6'b101000 : ROM3 <= 12'b1100_11_00_1_000;   // BSF    F,0
        6'b101001 : ROM3 <= 12'b1100_11_00_1_001;   // BSF    F,1
        6'b101010 : ROM3 <= 12'b1100_11_00_1_010;   // BSF    F,2
        6'b101011 : ROM3 <= 12'b1100_11_00_1_011;   // BSF    F,3
        6'b101100 : ROM3 <= 12'b1100_11_00_1_100;   // BSF    F,4
        6'b101101 : ROM3 <= 12'b1100_11_00_1_101;   // BSF    F,5
        6'b101110 : ROM3 <= 12'b1100_11_00_1_110;   // BSF    F,6
        6'b101111 : ROM3 <= 12'b1100_11_00_1_111;   // BSF    F,7
                                   
        6'b110000 : ROM3 <= 12'b0101_11_00_0_000;   // BTFSC  F,0
        6'b110001 : ROM3 <= 12'b0101_11_00_0_001;   // BTFSC  F,1
        6'b110010 : ROM3 <= 12'b0101_11_00_0_010;   // BTFSC  F,2
        6'b110011 : ROM3 <= 12'b0101_11_00_0_011;   // BTFSC  F,3
        6'b110100 : ROM3 <= 12'b0101_11_00_0_100;   // BTFSC  F,4
        6'b110101 : ROM3 <= 12'b0101_11_00_0_101;   // BTFSC  F,5
        6'b110110 : ROM3 <= 12'b0101_11_00_0_110;   // BTFSC  F,6
        6'b110111 : ROM3 <= 12'b0101_11_00_0_111;   // BTFSC  F,7
                                   
        6'b111000 : ROM3 <= 12'b0101_11_00_1_000;   // BTFSS  F,0
        6'b111001 : ROM3 <= 12'b0101_11_00_1_001;   // BTFSS  F,1
        6'b111010 : ROM3 <= 12'b0101_11_00_1_010;   // BTFSS  F,2
        6'b111011 : ROM3 <= 12'b0101_11_00_1_011;   // BTFSS  F,3
        6'b111100 : ROM3 <= 12'b0101_11_00_1_100;   // BTFSS  F,4
        6'b111101 : ROM3 <= 12'b0101_11_00_1_101;   // BTFSS  F,5
        6'b111110 : ROM3 <= 12'b0101_11_00_1_110;   // BTFSS  F,6
        6'b111111 : ROM3 <= 12'b0101_11_00_1_111;   // BTFSS  F,7
    endcase
end

//  Invalid/Reserved Instruction Decode

assign dErr =   (~|DI[11:1] & DI[0])                        // (IR == 1)
              | (~|DI[11:4] & DI[3])                        // ( 8 <= IR <= 16)
              | (~|DI[11:5] & DI[4])                        // (16 <= IR <= 31)
              | (~|DI[11:7] & DI[6] & ~|DI[5:4] & |DI[3:0]) // (65 <= IR <= 79)
              | (~|DI[11:7] & DI[6] & ~DI[5] & DI[4]);      // (80 <= IR <= 95)

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//
//  Instruction Pipeline Registers
//
//  Decoded Instruction Register

always @(posedge clk)
begin
    if(Rst)
        dIR <= #1 0;
    else if(CE)
        dIR <= #1 ((Skip) ? 0
                          : ((ROM1_Valid) ? ROM1 : 0));
end

//  ALU Operation Pipeline Register

assign dALU_Op = (ROM1_Valid ? ROM2
                             : {ROM3[11],(ROM3[10] & ~|DI[4:0]), ROM3[9:0]});

always @(posedge clk)
begin
    if(Rst)
        ALU_Op <= #1 0;
    else if(CE)
        ALU_Op <= #1 ((Skip | dErr) ? 0 : dALU_Op);
end

//  Literal Operand Pipeline Register

always @(posedge clk)
begin
    if(Rst)
        KI <= #1 0;
    else if(CE)
        KI <= #1 ((Skip) ? KI : DI[8:0]);
end

//  Unimplemented Instruction Error Register

always @(posedge clk)
begin
    if(Rst)
        Err <= #1 0;
    else if(CE)
        Err <= #1 dErr;
end

endmodule

////////////////////////////////////////////////////////////////////////////////
//
//  Copyright 2008-2013 by Michael A. Morris, dba M. A. Morris & Associates
//
//  All rights reserved. The source code contained herein is publicly released
//  under the terms and conditions of the GNU Lesser Public License. No part of
//  this source code may be reproduced or transmitted in any form or by any
//  means, electronic or mechanical, including photocopying, recording, or any
//  information storage and retrieval system in violation of the license under
//  which the source code is released.
//
//  The source code contained herein is free; it may be redistributed and/or
//  modified in accordance with the terms of the GNU Lesser General Public
//  License as published by the Free Software Foundation; either version 2.1 of
//  the GNU Lesser General Public License, or any later version.
//
//  The source code contained herein is freely released WITHOUT ANY WARRANTY;
//  without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
//  PARTICULAR PURPOSE. (Refer to the GNU Lesser General Public License for
//  more details.)
//
//  A copy of the GNU Lesser General Public License should have been received
//  along with the source code contained herein; if not, a copy can be obtained
//  by writing to:
//
//  Free Software Foundation, Inc.
//  51 Franklin Street, Fifth Floor
//  Boston, MA  02110-1301 USA
//
//  Further, no use of this source code is permitted in any form or means
//  without inclusion of this banner prominently in any derived works.
//
//  Michael A. Morris
//  Huntsville, AL
//
////////////////////////////////////////////////////////////////////////////////

`timescale 1ns / 1ps

////////////////////////////////////////////////////////////////////////////////
// Company:         M. A. Morris & Associates
// Engineer:        Michael A. Morris
//
// Create Date:     11:30:15 01/13/2008
// Design Name:     PIC16C5x
// Module Name:     C:/ISEProjects/ISE10.1i/P16C5x/PIC16C5x_Top.v
// Project Name:    PIC16C5x
// Target Devices:  N/A
// Tool versions:   ISEWebPACK 10.1i SP3
//
// Description:
//
//  Module implements a pipelined PIC16C5x processor. The processor implements
//  all PIC16C5x instructions. The module is derived from the PIC16C5x.v module
//  and removes the tristate control, output, and input registers associated
//  with Ports A...C. These ports are replaced by decoded 6 WE and 3 RE and an
//  I/O data bus. Three WEs assert when the TRIS A, TRIS B, or TRIS C instruc-
//  tions are exectued. The remaining three WEs assert when a register file
//  operation writes to addresses 0x05-0x07, which represent writes to the out-
//  put registers of Ports A...C, respectively. The three REs assert when regis-
//  ter file operations read addresses 0x05-0x07, which represent reads from the
//  input registers of Ports A...C, respectively.
//
//  Note:   Read-Modify-Write operations to register file addresses 0x05-0x07
//          only assert the corresponding WEs. The external logic is expected to
//          multiplex the input registers onto the I/O Data Input (IO_DI) bus on
//          the basis of the addresses. The core reads IO_DI and writes out the
//          modified data on the I/O Data Output (IO_DO) bus. In the event that
//          the input registers are implemented as FIFOs, this approach prevents
//          the assertion of a read strobe to the FIFO, which would advance the
//          pointers and cause the loss of the data at the head of the FIFO.
//
// Dependencies:    None
//
// Revision:
//
//  1.00    13F15   MAM     Converted PIC16C5x.v. The conversion entails remov-
//                          ing I/O ports and adding external DI/DO data bus, 
//                          write and read enables for I/O port registers and
//                          input buffers. This will demonstrate how PIC16C5x
//                          can be modified to support more sophisticated I/O.
//
//  1.10    13F15   MAM     Pulled in the optimized instruction decoder from
//                          F16C5x.v. Also converted the ALU section into a
//                          separate module.
//
//  1.30    13F20   MAM     Added parameter to determine reset vector. Although
//                          a full 4k x 12 program memory is available, no stan-
//                          dard 12-bit instruction length PIC supports that
//                          amount of program memory. To use free PIC-compatible
//                          tools, the parameter can be set to a value in the
//                          range of the supported devices.
//
//  1.40    13G07   MAM     Corrected error with the test conditional pertaining
//                          to BTFSC/BTFSS instructions. Qualifier was using
//                          ALU_Op[1:0] instead of ALU_Op[7:6]. Under certain
//                          combinations, results were correct.
//
// Additional Comments:
//
////////////////////////////////////////////////////////////////////////////////

module P16C5x #(
    parameter pRstVector = 12'h7FF,         // Reset Vector Location (PIC16F59)
    parameter pWDT_Size  = 20,              // Use 20 for synth. and 10 for Sim.

)(
    input   POR,                // In  - System Power-On Reset

    input   clk,                // In  - System Clock
    input   ClkEn,              // In  - Processor Clock Enable

    input   MCLR,               // In  - Master Clear Input
    input   T0CKI,              // In  - Timer 0 Clock Input

    input   WDTE,               // In  - Watchdog Timer Enable

    output  reg [11:0] PC,      // Out - Program Counter
    input   [11:0] ROM,         // In  - Instruction Data Input
    
    output  WE_TRISA, WE_TRISB, WE_TRISC,   // Out - Tristate Register X WE
    output  WE_PORTA, WE_PORTB, WE_PORTC,   // Out - Port X Output Register
    output  RE_PORTA, RE_PORTB, RE_PORTC,   // In  - Port X Input Register

    output  [7:0] IO_DO,        // Out - I/O Bus Data Output
    input   [7:0] IO_DI,        // In  - I/O Bus Data Input

//
//  Debug Outputs
//

    output  reg Rst,            // Out - Internal Core Reset

    output  reg [5:0] OPTION,   // Out - Processor Configuration Register Output
    
    output  reg [11:0] IR,      // Out - Internal Instruction Register
    output  [ 9:0] dIR,         // Out - Pipeline Register (Non-ALU Instruct.)
    output  [11:0] ALU_Op,      // Out - Pipeline Register (ALU Instructions)
    output  [ 8:0] KI,          // Out - Pipeline Register (Literal)
    output  Err,                // Out - Instruction Decode Error Output

    output  reg Skip,           // Out - Skip Next Instruction

    output  reg [11:0] TOS,     // Out - Top-Of-Stack Register Output
    output  reg [11:0] NOS,     // Out - Next-On-Stack Register Output

    output  [7:0] W,            // Out - Working Register Output

    output  [7:0] FA,           // Out - File Address Output
    output  [7:0] DO,           // Out - File Data Input/ALU Data Output
    output  [7:0] DI,           // Out - File Data Output/ALU Data Input

    output  reg [7:0] TMR0,     // Out - Timer 0 Timer/Counter Output
    output  reg [7:0] FSR,      // Out - File Select Register Output
    output  [7:0] STATUS,       // Out - Processor Status Register Output

    output  T0CKI_Pls,          // Out - Timer 0 Clock Edge Pulse Output

    output  reg WDTClr,         // Out - Watchdog Timer Clear Output
    output  reg [pWDT_Size-1:0] WDT, // Out - Watchdog Timer
    output  reg WDT_TC,
    output  WDT_TO,             // Out - Watchdog Timer Timeout Output

    output  reg [7:0] PSCntr,   // Out - Prescaler Counter Output
    output  PSC_Pls             // Out - Prescaler Count Pulse Output
);

////////////////////////////////////////////////////////////////////////////////
//
//  Local Parameter Declarations
//

//  Special Function Register Addresses

localparam pINDF   = 5'b0_0000;     // Indirect Rd/Wr -- Address in FSR (0x04)
localparam pTMR0   = 5'b0_0001;     // Timer 0
localparam pPCL    = 5'b0_0010;     // Lower 8-bits of PC
localparam pSTATUS = 5'b0_0011;     // Status Register
localparam pFSR    = 5'b0_0100;     // File Select Register - Extended RAM ptr
localparam pPORTA  = 5'b0_0101;     // Port A: Tristate, Output, Input Registers
localparam pPORTB  = 5'b0_0110;     // Port B: Tristate, Output, Input Registers
localparam pPORTC  = 5'b0_0111;     // Port C: Tristate, Output, Input Registers

////////////////////////////////////////////////////////////////////////////////
//
//  Module Level Declarations
//

wire    Rst_M16C5x;         // Internal Core Reset (asynchronous)

wire    CE;                 // Internal Clock Enable: CE <= ClkEn & ~PD;

reg     [2:0] PA;           // PC Load Register PC[11:9] = PA[2:0]
reg     [7:0] SFR;          // Special Function Registers Data Output

wire    Rst_TO;             // Rst TO FF signal
reg     TO;                 // Time Out FF (STATUS Register)
wire    Rst_PD;             // Rst Power Down FF signal
reg     PD;                 // Power Down FF (STATUS Register)
reg     PwrDn;              // Power Down FF

// RAM Address: FA[4] ? {2'b0, FA[3:0]} : {FSR[6:5], FA[3:0]}

wire    [5:0] Addrs;
reg     [7:0] RAMA[ 7:0];   // RAM Block 0    = 0x08 - 0x0F      (Non-Banked)
reg     [7:0] RAMB[63:0];   // RAM Block 1..8 = @{FSR[6:5],FSR[3:0]} (Banked)

wire    T0CS;               // Timer 0 Clock Source Select
wire    T0SE;               // Timer 0 Source Edge
wire    PSA;                // Prescaler Assignment
wire    [2:0] PS;           // Prescaler Counter Output Bit Select

reg     [2:0] dT0CKI;       // Ext T0CKI Synchronized RE/RE FF chain
reg     PSC_Out;            // Synchronous Prescaler TC register
reg     [1:0] dPSC_Out;     // Rising Edge Detector for Prescaler output

wire    GOTO, CALL, RETLW;  // Signals for Decoded Instruction Register
wire    WE_SLEEP, WE_WDTCLR;
wire    WE_OPTION;

wire    WE_TMR0;            // Write Enable Signals Decoded from FA[4:0]
wire    WE_PCL;
wire    WE_STATUS;
wire    WE_FSR;

wire    WE_PSW;             // Write Enable for STATUS[2:0]: {Z, DC, C}

////////////////////////////////////////////////////////////////////////////////
//
//  ALU Declarations
//

wire    C, DC, Z;       // ALU Status Outputs
wire    Z_Tst, g;       // Zero and Bit Test Condition Code 

//
////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
//
//  Top Level Implementation
//

assign CE = ClkEn & ~PwrDn;         // Internal Clock Enable, refer to comments

assign Rst_M16C5x = (POR | MCLR | WDT_TO);      // Internal Processor Reset

always @(posedge clk or posedge Rst_M16C5x)
begin
    if(Rst_M16C5x)
        Rst <= #1 1'b1;
    else if(CE)
        Rst <= #1  0;
end

//  Capture Program ROM input into Instruction Register (IR)

always @(posedge clk)
begin
    if(Rst)
        IR <= #1 0;
    else if(CE)
        IR <= #1 ROM;
end

//  Instantiate Optimized Instruction Decoder - ROMs used to speed decode

P16C5x_IDec IDEC (
                .Rst(Rst),
                .clk(clk),
                .CE(CE),
                
                .DI(ROM),
                .Skip(Skip),

                .dIR(dIR),
                .ALU_Op(ALU_Op),
                .KI(KI),

                .Err(Err)
            );

//  Instantiate ALU module

P16C5x_ALU  ALU (
                .Rst(Rst),
                .clk(clk),
                .CE(CE),
                
                .ALU_Op(ALU_Op),
                
                .DI(DI),
                .KI(KI[7:0]),
                .WE_PSW(WE_PSW),

                .DO(DO),
                .Z_Tst(Z_Tst),
                .g(g),
                
                .W(W),
                
                .Z(Z),
                .DC(DC),
                .C(C)
            );

////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
//
//  Microprocessor Core Implementation
//
//  Pipeline Instruction Register Assignments

assign GOTO      = dIR[0];
assign CALL      = dIR[1];
assign RETLW     = dIR[2];
assign WE_SLEEP  = dIR[3];
assign WE_WDTCLR = dIR[4];
assign WE_TRISA  = dIR[5];
assign WE_TRISB  = dIR[6];
assign WE_TRISC  = dIR[7];
assign WE_OPTION = dIR[8];
assign LITERAL   = dIR[9];      // Added to support WE/RE PortX external I/F

//  Skip Logic

assign Tst = ALU_Op[8];

always @(*)
begin
    Skip <= WE_SLEEP | WE_PCL
            | ((Tst) ? ((ALU_Op[7] & ALU_Op[6]) ? g    : Z_Tst)
                     : ((GOTO | CALL | RETLW)   ? 1'b1 : 1'b0 ));
end

//  File Register Address Multiplexer

assign INDF = ALU_Op[10];
assign FA   = ((INDF) ? FSR
                      : ((KI[4]) ? {FSR[6:5], KI[4:0]}
                                 : {    2'b0, KI[4:0]}));

//  File Register Write Enable

assign WE_F = ALU_Op[11];

//  Special Function Register Write Enables

assign WE_TMR0   =  WE_F & (FA[4:0] == pTMR0);
assign WE_PCL    =  WE_F & (FA[4:0] == pPCL);
assign WE_STATUS =  WE_F & (FA[4:0] == pSTATUS);
assign WE_FSR    =  WE_F & (FA[4:0] == pFSR);
//
//  I/O Ports moved to an external implementation
//      WE_PortX asserts for an FA address match when LITERAL not asserted and a
//          WE_F is asserted.
//      RE_PortX asserts for an FA address match whn LITERAL not asserted, WE_F
//          is not asserted, and WE_TrisX not asserted. Tris X has the same FA
//          field. Tristate control for port A is instruction 0x005, and FA is
//          the least significant 5 bits of the instruction. FA of 0x05 is the
//          file address of Port A. (The same applies for Tris B and Tris C.)
//
assign WE_PORTA  =  WE_F & (FA[4:0] == pPORTA) & ~LITERAL;
assign WE_PORTB  =  WE_F & (FA[4:0] == pPORTB) & ~LITERAL;
assign WE_PORTC  =  WE_F & (FA[4:0] == pPORTC) & ~LITERAL;
//
assign RE_PORTA  = ~WE_F & (FA[4:0] == pPORTA) & ~LITERAL & ~WE_TRISA;
assign RE_PORTB  = ~WE_F & (FA[4:0] == pPORTB) & ~LITERAL & ~WE_TRISB;
assign RE_PORTC  = ~WE_F & (FA[4:0] == pPORTC) & ~LITERAL & ~WE_TRISC;

//  Assign Write Enable for STATUS register Processor Status Word (PSW) bits
//      Allow write to the STATUS[2:0] bits, {Z, DC, C}, only for instructions
//      MOVWF, BCF, BSF, and SWAPF. Exclude instructions DECFSZ and INCFSZ.

assign WE_PSW = WE_STATUS & (ALU_Op[5:4] == 2'b00) & (ALU_Op[8] == 1'b0);

////////////////////////////////////////////////////////////////////////////////
//
// Program Counter Implementation
//
//  On CALL or MOVWF PCL (direct or indirect), load PCL from the ALU output
//  and the upper bits with {PA, 0}, i.e. PC[8] = 0.
//

assign Ld_PCL = CALL | WE_PCL;

always @(posedge clk)
begin
    if(Rst)
        PC <= #1 pRstVector;    // Set PC to Reset Vector on Rst or WDT Timeout
    else if(CE)
        PC <= #1 (GOTO ? {PA, KI}
                       : (Ld_PCL ? {PA, 1'b0, DO}
                                 : (RETLW ? TOS : PC + 1)));
end

//  Stack Implementation (2 Level Stack)

always @(posedge clk)
begin
    if(POR)
        TOS <= #1 pRstVector;       // Set TOS on Rst or WDT Timeout
    else if(CE)
        TOS <= #1 (CALL ? PC : (RETLW ? NOS : TOS));
end

always @(posedge clk)
begin
    if(POR)
        NOS <= #1 pRstVector;       // Set NOS on Rst or WDT Timeout
    else if(CE)
        NOS <= #1 (CALL ? TOS : NOS);
end

////////////////////////////////////////////////////////////////////////////////
//
//  Port Configuration and Option Registers

always @(posedge clk)
begin
    if(POR)
        OPTION <= #1 8'b0011_1111;
    else if(CE)
        OPTION <= #1 ((WE_OPTION) ? W : OPTION);
end

////////////////////////////////////////////////////////////////////////////////
//
//  CLRWDT Strobe Pulse Generator

always @(posedge clk)
begin
    if(Rst)
        WDTClr <= #1 0;
    else
        WDTClr <= #1 (WE_WDTCLR | WE_SLEEP) & ~PwrDn;
end

////////////////////////////////////////////////////////////////////////////////
//
//  TO (Time Out) STATUS Register Bit

assign Rst_TO = (POR | (MCLR & PD) | WE_WDTCLR);

always @(posedge clk)
begin
    if(Rst_TO)
        TO <= #1  0;
    else if(WDT_TO)
        TO <= #1 ~0;
end

////////////////////////////////////////////////////////////////////////////////
//
//  PD (Power Down) STATUS Register Bit - Sleep Mode

assign Rst_PD = POR | (WE_WDTCLR & ~PwrDn);

always @(posedge clk)
begin
    if(Rst_PD)
        PD <= #1 0;
    else if(CE)
        PD <= #1 ((WE_SLEEP) ? 1'b1 : PD);
end

//  PwrDn - Sleep Mode Control FF: Set by SLEEP instruction, cleared by Rst
//          Differs from PD in that it is not readable and does not maintain
//          its state through Reset. Gates CE to rest of the processor.

always @(posedge clk)
begin
    if(Rst)
        PwrDn <= #1 0;
    else if(ClkEn)
        PwrDn <= #1 ((WE_SLEEP) ? 1'b1 : PwrDn);
end

////////////////////////////////////////////////////////////////////////////////
//
//  File Register RAM

assign Addrs = {FA[6:5], FA[3:0]};

//  RAM A - 16 Word Distributed RAM

assign WE_RAMA = WE_F & ~FA[4] & FA[3];

always @(posedge clk)
begin
    if(CE)
        if(WE_RAMA)
            RAMA[Addrs[2:0]] <= #1 DO;
end

//  RAM B - 64 Word Distributed RAM

assign WE_RAMB = WE_F & FA[4];

always @(posedge clk)
begin
    if(CE)
        if(WE_RAMB)
            RAMB[Addrs] <= #1 DO;
end

////////////////////////////////////////////////////////////////////////////////
//
// Special Function Registers

always @(posedge clk)
begin
    if(POR)
        PA  <= #1 0;
    else if(CE)
        PA  <= #1 ((WE_STATUS) ? DO[7:5] : PA);
end

always @(posedge clk)
begin
    if(POR)
        FSR <= #1 0;
    else if(CE)
        FSR <= #1 ((WE_FSR) ? DO : FSR);
end

//  Generate STATUS Register

assign STATUS = {PA, ~TO, ~PD, Z, DC, C};

//  Special Function Register (SFR) Multiplexers

always @(*)
begin
    case(FA[2:0])
        3'b000 :  SFR <= 0;
        3'b001 :  SFR <= TMR0;
        3'b010 :  SFR <= PC[7:0];
        3'b011 :  SFR <= STATUS;
        3'b100 :  SFR <= FSR;
        3'b101 :  SFR <= IO_DI;
        3'b110 :  SFR <= IO_DI;
        3'b111 :  SFR <= IO_DI;
    endcase
end

//  File Data Output Multiplexer

assign DI = (FA[4] ? RAMB[Addrs] : (FA[3] ? RAMA[Addrs[2:0]] : SFR));

//  IO Data Output Multiplexer

assign IO_DO = ((|{WE_TRISA, WE_TRISB, WE_TRISC}) ? W : DO);

////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
//
//  Watchdog Timer and Timer0 Implementation- see Figure 8-6
//
//  OPTION Register Assignments

assign T0CS = OPTION[5];     // Timer0 Clock Source:   1 - T0CKI,  0 - clk
assign T0SE = OPTION[4];     // Timer0 Source Edge:    1 - FE,     0 - RE
assign PSA  = OPTION[3];     // Pre-Scaler Assignment: 1 - WDT,    0 - Timer0
assign PS   = OPTION[2:0];   // Pre-Scaler Count: Timer0 - 2^(PS+1), WDT - 2^PS

// WDT - Watchdog Timer

assign WDT_Rst = Rst | WDTClr;

always @(posedge clk)
begin
    if(WDT_Rst)
        WDT <= #1 0;
    else if(WDTE)
        WDT <= #1 WDT + 1;
end

//  WDT synchronous TC FF

always @(posedge clk)
begin
    if(WDT_Rst)
        WDT_TC <= #1 0;
    else
        WDT_TC <= #1 &WDT;
end

// WDT Timeout multiplexer

assign WDT_TO = (PSA ? PSC_Pls : WDT_TC);

////////////////////////////////////////////////////////////////////////////////
//
//  T0CKI RE/FE Pulse Generator (on Input rather than after PSCntr)
//
//      Device implements an XOR on T0CKI and a clock multiplexer for the
//      Prescaler since it has two clock asynchronous clock sources: the WDT
//      or the external T0CKI (Timer0 Clock Input). Instead of this type of
//      gated clock ripple counter implementation of the Prescaler, a fully
//      synchronous implementation has been selected. Thus, the T0CKI must be
//      synchronized and the falling or rising edge detected as determined by
//      the T0CS bit in the OPTION register. Similarly, the WDT is implemented
//      using the processor clock, which means that the WDT TC pulse is in the
//      same clock domain as the rest of the logic.
//

always @(posedge clk)
begin
    if(Rst)
        dT0CKI <= #1 0;
    else begin
        dT0CKI[0] <= #1 T0CKI;                              // Synch FF #1
        dT0CKI[1] <= #1 dT0CKI[0];                          // Synch FF #2
        dT0CKI[2] <= #1 (T0SE ? (dT0CKI[1] & ~dT0CKI[0])    // Falling Edge
                              : (dT0CKI[0] & ~dT0CKI[1]));  // Rising Edge
    end
end

assign T0CKI_Pls = dT0CKI[2]; // T0CKI Pulse out, either FE/RE

//  Tmr0 Clock Source Multiplexer

assign Tmr0_CS = (T0CS ? T0CKI_Pls : CE);

////////////////////////////////////////////////////////////////////////////////
//
// Pre-Scaler Counter

assign Rst_PSC   = (PSA ? WDTClr : WE_TMR0) | Rst;
assign CE_PSCntr = (PSA ? WDT_TC : Tmr0_CS);

always @(posedge clk)
begin
    if(Rst_PSC)
        PSCntr <= #1 0;
    else if(CE_PSCntr)
        PSCntr <= #1 PSCntr + 1;
end

//  Prescaler Counter Output Multiplexer

always @(*)
begin
    case (PS)
        3'b000 : PSC_Out <= PSCntr[0];
        3'b001 : PSC_Out <= PSCntr[1];
        3'b010 : PSC_Out <= PSCntr[2];
        3'b011 : PSC_Out <= PSCntr[3];
        3'b100 : PSC_Out <= PSCntr[4];
        3'b101 : PSC_Out <= PSCntr[5];
        3'b110 : PSC_Out <= PSCntr[6];
        3'b111 : PSC_Out <= PSCntr[7];
    endcase
end

// Prescaler Counter Rising Edge Detector

always @(posedge clk)
begin
    if(POR)
        dPSC_Out <= #1 0;
    else begin
        dPSC_Out[0] <= #1 PSC_Out;
        dPSC_Out[1] <= #1 PSC_Out & ~dPSC_Out[0];
    end
end

assign PSC_Pls = dPSC_Out[1];

////////////////////////////////////////////////////////////////////////////////
//
// Tmr0 Counter/Timer

assign CE_Tmr0 = (PSA ? Tmr0_CS : PSC_Pls);

always @(posedge clk)
begin
    if(POR)
        TMR0 <= #1 0;
    else if(WE_TMR0)
        TMR0 <= #1 DO;
    else if(CE_Tmr0)
        TMR0 <= #1 TMR0 + 1;
end

endmodule
