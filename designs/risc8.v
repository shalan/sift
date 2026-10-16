// Vendored from https://github.com/brabect1/risc8 (hdl/verilog/). Top is cpu.

module alu (
   op,
   a,
   b,
   y,
   cin,
   cout,
   zout
);

input  [3:0]	op;	// ALU Operation
input  [7:0]	a;	// 8-bit Input a
input  [7:0]	b;	// 8-bit Input b
output [7:0]	y;	// 8-bit Output
input		cin;
output		cout;
output		zout;
//
// Copyright (c) 1999 Thomas Coonan (tcoonan@mindspring.com)
//
//    This source code is free software; you can redistribute it
//    and/or modify it in source code form under the terms of the GNU
//    General Public License as published by the Free Software
//    Foundation; either version 2 of the License, or (at your option)
//    any later version.
//
//    This program is distributed in the hope that it will be useful,
//    but WITHOUT ANY WARRANTY; without even the implied warranty of
//    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//    GNU General Public License for more details.
//
//    You should have received a copy of the GNU General Public License
//    along with this program; if not, write to the Free Software
//    Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA 02111-1307, USA
//

// Reg declarations for outputs
reg		cout;
reg		zout;
reg [7:0]	y;

// Internal declarations
reg		addercout; // Carry out straight from the adder itself.
 
parameter [3:0] ALUOP_ADD  = 4'b0000;
parameter [3:0] ALUOP_SUB  = 4'b1000;
parameter [3:0] ALUOP_AND  = 4'b0001;
parameter [3:0] ALUOP_OR   = 4'b0010;
parameter [3:0] ALUOP_XOR  = 4'b0011;
parameter [3:0] ALUOP_COM  = 4'b0100;
parameter [3:0] ALUOP_ROR  = 4'b0101;
parameter [3:0] ALUOP_ROL  = 4'b0110;
parameter [3:0] ALUOP_SWAP = 4'b0111;


always @(a or b or cin or op) begin
   case (op) // synopsys parallel_case
      ALUOP_ADD:  {addercout,  y}  = a + b;
      ALUOP_SUB:  {addercout,  y}  = a - b; // Carry out is really "borrow"
      ALUOP_AND:  {addercout,  y}  = {1'b0, a & b};
      ALUOP_OR:   {addercout,  y}  = {1'b0, a | b};
      ALUOP_XOR:  {addercout,  y}  = {1'b0, a ^ b};
      ALUOP_COM:  {addercout,  y}  = {1'b0, ~a};
      ALUOP_ROR:  {addercout,  y}  = {a[0], cin, a[7:1]};
      ALUOP_ROL:  {addercout,  y}  = {a[7], a[6:0], cin};
      ALUOP_SWAP: {addercout,  y}  = {1'b0, a[3:0], a[7:4]};
      default:    {addercout,  y}  = {1'b0, 8'h00};
   endcase
end

always @(y)
   zout = (y == 8'h00);

always @(addercout or op)
   if (op == ALUOP_SUB) cout = ~addercout; // Invert adder's carry to get borrow
   else                 cout =  addercout;
      
endmodule

// picdram stands for PIC "Data" RAM.
//
//
// Synchronous Data RAM, 8 bits wide, N words deep.
//
// ** Must support SYNCHRONOUS WRITEs and ASYNCHRONOUS READs **
//    This is so that we can do a Read/Modify/Write in one cycle which
//    is required to do something like this:
//
//       incf 0x20, f   // M[20] <= M[20] + 1
//       incf 0x22, f   // M[22] <= M[22] + 1
//       incf 0x18, f   // M[18] <= M[18] + 1
//
// Replace with your actual memory model..
//
module dram (
   clk,
   address,
   we,
   re,
   din,
   dout
);

input		clk;
input [6:0]	address;
input		we;
input		re;
input [7:0]	din;
output [7:0]	dout;
reg [7:0]	dout;

// Number of data memory words.  This is somewhat tricky, since remember
// that lowest registers (e.g. special registers) are not really in this
// data memory at all, but are explicit registers at the top-level.  Also,
// the banking scheme has some of the other registers in each bank being
// mapped to the same physical registers.  The bottom line is that for
// the 16C57, you at most need to set this to 72.  Note we are reserving
// the last 2 words for our little "expansion circuit" so we really want
// only 70.
//

//
// Copyright (c) 1999 Thomas Coonan (tcoonan@mindspring.com)
//
//    This source code is free software; you can redistribute it
//    and/or modify it in source code form under the terms of the GNU
//    General Public License as published by the Free Software
//    Foundation; either version 2 of the License, or (at your option)
//    any later version.
//
//    This program is distributed in the hope that it will be useful,
//    but WITHOUT ANY WARRANTY; without even the implied warranty of
//    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//    GNU General Public License for more details.
//
//    You should have received a copy of the GNU General Public License
//    along with this program; if not, write to the Free Software
//    Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA 02111-1307, USA
//

parameter word_depth = 70; // Maximum minus 2 words for expansion circuit demo
//parameter word_depth = 24;  // This would be like a 16C54 

// reg [6:0]	address_latched; <--- NO!  We need ASYNCHRONOUS READs

// Instantiate the memory array itself.
reg [7:0]	mem[0:word_depth-1];

// Latch address <--- NO! 
//always @(posedge clk)
//   address_latched <= address;
   
// READ
//assign dout = mem[address_latched];

// SYNCHRONOUS READ
always @(posedge clk)
   if (re) dout <= mem[address];

// SYNCHRONOUS WRITE
always @(posedge clk)
   if (we) mem[address] <= din;

endmodule

//
// Copyright (c) 1999 Thomas Coonan (tcoonan@mindspring.com)
//
//    This source code is free software; you can redistribute it
//    and/or modify it in source code form under the terms of the GNU
//    General Public License as published by the Free Software
//    Foundation; either version 2 of the License, or (at your option)
//    any later version.
//
//    This program is distributed in the hope that it will be useful,
//    but WITHOUT ANY WARRANTY; without even the implied warranty of
//    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//    GNU General Public License for more details.
//
//    You should have received a copy of the GNU General Public License
//    along with this program; if not, write to the Free Software
//    Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA 02111-1307, USA
//

module idec (
	inst,
	aluasel,
	alubsel,
	aluop,
	wwe,
	fwe,
	zwe,
	cwe,
	bdpol,
	option,
	tris
);

input  [11:0]	inst;

output [1:0]	aluasel;
output [1:0]	alubsel;
output [3:0]	aluop;
output		wwe;
output		fwe;
output		zwe;
output		cwe;
output		bdpol;
output		option;
output		tris;

reg [14:0] decodes;

// For reference, the ALU Op codes are:
//
//   ADD  0000
//   SUB  1000
//   AND  0001
//   OR   0010
//   XOR  0011
//   COM  0100
//   ROR  0101
//   ROL  0110
//   SWAP 0111

assign {	aluasel,	// Select source for ALU A input. 00=W, 01=SBUS, 10=K, 11=BD
		alubsel,	// Select source for ALU B input. 00=W, 01=SBUS, 10=K, 11="1"
		aluop,		// ALU Operation (see comments above for these codes)
		wwe,		// W register Write Enable
		fwe,		// File Register Write Enable
		zwe,		// Status register Z bit update
		cwe,		// Status register Z bit update
		bdpol,		// Polarity on bit decode vector (0=no inversion, 1=invert)
		tris,		// Instruction is an TRIS instruction
		option		// Instruction is an OPTION instruction
	} = decodes;

// This is a large combinatorial decoder.
// I use the casex statement.

always @(inst) begin
	casex (inst) // synopsys parallel_case
		// *** Byte-Oriented File Register Operations
		//
		//                                 A  A  ALU  W F Z C B T O
		//                                 L  L   O   W W W W D R P
		//                                 U  U   P   E E E E P I T
		//                                 A  B               O S
		//                                                    L
		12'b0000_0000_0000: decodes = 15'b00_00_0000_0_0_0_0_0_0_0; // NOP
		12'b0000_001X_XXXX: decodes = 15'b00_00_0010_0_1_0_0_0_0_0; // MOVWF
		12'b0000_0100_0000: decodes = 15'b00_00_0011_1_0_1_0_0_0_0; // CLRW
		12'b0000_011X_XXXX: decodes = 15'b00_00_0011_0_1_1_0_0_0_0; // CLRF
		12'b0000_100X_XXXX: decodes = 15'b01_00_1000_1_0_1_1_0_0_0; // SUBWF (d=0)
		12'b0000_101X_XXXX: decodes = 15'b01_00_1000_0_1_1_1_0_0_0; // SUBWF (d=1)
		12'b0000_110X_XXXX: decodes = 15'b01_11_1000_1_0_1_0_0_0_0; // DECF  (d=0)
		12'b0000_111X_XXXX: decodes = 15'b01_11_1000_0_1_1_0_0_0_0; // DECF  (d=1)
		12'b0001_000X_XXXX: decodes = 15'b00_01_0010_1_0_1_0_0_0_0; // IORWF (d=0)
		12'b0001_001X_XXXX: decodes = 15'b00_01_0010_0_1_1_0_0_0_0; // IORWF (d=1)
		12'b0001_010X_XXXX: decodes = 15'b00_01_0001_1_0_1_0_0_0_0; // ANDWF (d=0)
		12'b0001_011X_XXXX: decodes = 15'b00_01_0001_0_1_1_0_0_0_0; // ANDWF (d=1)
		12'b0001_100X_XXXX: decodes = 15'b00_01_0011_1_0_1_0_0_0_0; // XORWF (d=0)
		12'b0001_101X_XXXX: decodes = 15'b00_01_0011_0_1_1_0_0_0_0; // XORWF (d=1)
		12'b0001_110X_XXXX: decodes = 15'b00_01_0000_1_0_1_1_0_0_0; // ADDWF (d=0)
		12'b0001_111X_XXXX: decodes = 15'b00_01_0000_0_1_1_1_0_0_0; // ADDWF (d=1)
		12'b0010_000X_XXXX: decodes = 15'b01_01_0010_1_0_1_0_0_0_0; // MOVF  (d=0)
		12'b0010_001X_XXXX: decodes = 15'b01_01_0010_0_1_1_0_0_0_0; // MOVF  (d=1)
		12'b0010_010X_XXXX: decodes = 15'b01_01_0100_1_0_1_0_0_0_0; // COMF  (d=0)
		12'b0010_011X_XXXX: decodes = 15'b01_01_0100_0_1_1_0_0_0_0; // COMF  (d=1)
		12'b0010_100X_XXXX: decodes = 15'b01_11_0000_1_0_1_0_0_0_0; // INCF  (d=0)
		12'b0010_101X_XXXX: decodes = 15'b01_11_0000_0_1_1_0_0_0_0; // INCF  (d=1)
		12'b0010_110X_XXXX: decodes = 15'b01_11_1000_1_0_0_0_0_0_0; // DECFSZ(d=0)
		12'b0010_111X_XXXX: decodes = 15'b01_11_1000_0_1_0_0_0_0_0; // DECFSZ(d=1)
		12'b0011_000X_XXXX: decodes = 15'b01_01_0101_1_0_0_1_0_0_0; // RRF   (d=0)
		12'b0011_001X_XXXX: decodes = 15'b01_01_0101_0_1_0_1_0_0_0; // RRF   (d=1)
		12'b0011_010X_XXXX: decodes = 15'b01_01_0110_1_0_0_1_0_0_0; // RLF   (d=0)
		12'b0011_011X_XXXX: decodes = 15'b01_01_0110_0_1_0_1_0_0_0; // RLF   (d=1)
		12'b0011_100X_XXXX: decodes = 15'b01_01_0111_1_0_0_0_0_0_0; // SWAPF (d=0)
		12'b0011_101X_XXXX: decodes = 15'b01_01_0111_0_1_0_0_0_0_0; // SWAPF (d=1)
		12'b0011_110X_XXXX: decodes = 15'b01_11_0000_1_0_0_0_0_0_0; // INCFSZ(d=0)
		12'b0011_111X_XXXX: decodes = 15'b01_11_0000_0_1_0_0_0_0_0; // INCFSZ(d=1)

		// *** Bit-Oriented File Register Operations
                //
		//                                 A  A  ALU  W F Z C B T O
		//                                 L  L   O   W W W W D R P
		//                                 U  U   P   E E E E P I T
		//                                 A  B               O S
		//                                                    L
		12'b0100_XXXX_XXXX: decodes = 15'b11_01_0001_0_1_0_0_1_0_0; // BCF
		12'b0101_XXXX_XXXX: decodes = 15'b11_01_0010_0_1_0_0_0_0_0; // BSF
		12'b0110_XXXX_XXXX: decodes = 15'b11_01_0001_0_0_0_0_0_0_0; // BTFSC
		12'b0111_XXXX_XXXX: decodes = 15'b11_01_0001_0_0_0_0_0_0_0; // BTFSS

		// *** Literal and Control Operations
                //
		//                                 A  A  ALU  W F Z C B T O
		//                                 L  L   O   W W W W D R P
		//                                 U  U   P   E E E E P I T
		//                                 A  B               O S
		//                                                    L
		12'b0000_0000_0010: decodes = 15'b00_00_0010_0_1_0_0_0_0_1; // OPTION
		12'b0000_0000_0011: decodes = 15'b00_00_0000_0_0_0_0_0_0_0; // SLEEP
		12'b0000_0000_0100: decodes = 15'b00_00_0000_0_0_0_0_0_0_0; // CLRWDT
		12'b0000_0000_0101: decodes = 15'b00_00_0000_0_1_0_0_0_1_0; // TRIS 5
		12'b0000_0000_0110: decodes = 15'b00_00_0010_0_1_0_0_0_1_0; // TRIS 6
		12'b0000_0000_0111: decodes = 15'b00_00_0010_0_1_0_0_0_1_0; // TRIS 7
                //
		//                                 A  A  ALU  W F Z C B T O
		//                                 L  L   O   W W W W D R P
		//                                 U  U   P   E E E E P I T
		//                                 A  B               O S
		//                                                    L
		12'b1000_XXXX_XXXX: decodes = 15'b10_10_0010_1_0_0_0_0_0_0; // RETLW
		12'b1001_XXXX_XXXX: decodes = 15'b10_10_0010_0_0_0_0_0_0_0; // CALL
		12'b101X_XXXX_XXXX: decodes = 15'b10_10_0010_0_0_0_0_0_0_0; // GOTO
		12'b1100_XXXX_XXXX: decodes = 15'b10_10_0010_1_0_0_0_0_0_0; // MOVLW
		12'b1101_XXXX_XXXX: decodes = 15'b00_10_0010_1_0_1_0_0_0_0; // IORLW
		12'b1110_XXXX_XXXX: decodes = 15'b00_10_0001_1_0_1_0_0_0_0; // ANDLW
		12'b1111_XXXX_XXXX: decodes = 15'b00_10_0011_1_0_1_0_0_0_0; // XORLW

		default:
			decodes = 15'b00_00_0000_0_0_0_0_0_0_0;
	endcase
end

endmodule

//
// Copyright (c) 1999 Thomas Coonan (tcoonan@mindspring.com)
//
//    This source code is free software; you can redistribute it
//    and/or modify it in source code form under the terms of the GNU
//    General Public License as published by the Free Software
//    Foundation; either version 2 of the License, or (at your option)
//    any later version.
//
//    This program is distributed in the hope that it will be useful,
//    but WITHOUT ANY WARRANTY; without even the implied warranty of
//    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//    GNU General Public License for more details.
//
//    You should have received a copy of the GNU General Public License
//    along with this program; if not, write to the Free Software
//    Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA 02111-1307, USA
//

`define DEBUG_SHOWREADS
`define DEBUG_SHOWWRITES

// Memory Map:
//
// PIC Data Memory addressing is complicated.  See the Data Book for full explanation..
//
// Basically, each BANK contains 32 locations.  The lowest 16 locations in ALL Banks
// are really all mapped to the same bank (bank #0).  The first 8 locations are the Special
// registers like the STATUS and PC registers.  The upper 16 words in each bank, really are
// unique to each bank.  The smallest PIC (16C54) only has the one bank #0.
//
// So, as a programmer, what you get is this.  No matter what bank you are in (FSR[6:5])
// you always have access to your special registers and also to registers 8-15.  You can
// change to a 1 of 4 banks by setting FSR[6:5] and get 4 different sets of registers
// 16-31.
//
//
//   bank location 
//     XX 00rrr  -  The special registers are not implemented in this register file.
//     XX 01rrr  -  The 8 common words, just above the Special Regs, same for all Banks
//     00 1rrrr  -  The 16 words unique to Bank #0
//     01 1rrrr  -  The 16 words unique to Bank #1
//     10 1rrrr  -  The 16 words unique to Bank #2
//     11 1rrrr  -  The 16 words unique to Bank #3
//
//  So, 
//     Special Regs are location[4:3] == 00
//     Common Regs are  location[4:3] == 01
//     Words in banks   location[4]   == 1
// 
//  Remap to a new single memory space.  Remap in chunks of 8 words.  The PIC words
//  will get remapped to the RAM in a contiguous manner.  The Common registers are
//  mapped to the first 8 words of our RAM.  Next, each bank's words in the upper
//  half of the bank are mapped to the RAM in a contiguous manner:
//
//      PIC View        Our RAM
//   bank location      Address
//     00 01rrr  =>     0  -   7   (common words)
//     00 10rrr  =>     8  -  15
//     00 11rrr  =>    16  -  23
//     01 01rrr  =>     0  -   7   (common words)
//     01 10rrr  =>    24  -  31
//     01 11rrr  =>    32  -  39
//     10 01rrr  =>     0  -   7   (common words)
//     10 10rrr  =>    40  -  47
//     10 11rrr  =>    48  -  55
//     11 01rrr  =>     0  -   7   (common words)
//     11 10rrr  =>    56  -  63
//     11 11rrr  =>    64  -  71 <-- last four locations are not implemented
//
// 
//
module regs (clk, reset, we, re, bank, location, din, dout);

input		clk;
input		reset;
input		we;
input		re;
input  [1:0]	bank;		// Bank 0,1,2,3
input  [4:0]	location;	// Location
input  [7:0]	din;		// Input 
output [7:0]	dout;		// Output 

// The top-level modulke, piccpu, is supposed to garuntee that re and we
// are asserted for only valid locations.  So, we don't need to worry about
// safely mapping invalid addresses.
//

reg [6:0]	final_address;

// Instatiate the final memory model.
//
dram dram (
   .clk		(clk),
   .address	(final_address),
   .we		(we),
   .re		(re),
   .din		(din),
   .dout	(dout)
);

// The final_address is our remapped address.  This combinational logic
// is performed immediate on the input address signals, before any latching.
// This is because a WRITE doesn't use the latched values whereas the READ does.
//
always @(bank or location) begin
   casex ({bank, location})
      // First, let's handle the locations that all get mirrored back
      // into the bank #0 words from 8-15.
      //
      7'b00_01XXX: final_address = {4'b0000, location[2:0]};
      7'b01_01XXX: final_address = {4'b0000, location[2:0]};
      7'b10_01XXX: final_address = {4'b0000, location[2:0]};
      7'b11_01XXX: final_address = {4'b0000, location[2:0]};
      
      // Now, handle words in the upper halves of each bank.
      //
      // Bank #0
      7'b00_10XXX: final_address = {4'b0001, location[2:0]};
      7'b00_11XXX: final_address = {4'b0010, location[2:0]};

      // Bank #1
      7'b01_10XXX: final_address = {4'b0011, location[2:0]};
      7'b01_11XXX: final_address = {4'b0100, location[2:0]};
      
      // Bank #2
      7'b10_10XXX: final_address = {4'b0101, location[2:0]};
      7'b10_11XXX: final_address = {4'b0110, location[2:0]};
      
      // Bank #3
      7'b11_10XXX: final_address = {4'b0111, location[2:0]};
      7'b11_11XXX: final_address = {4'b1000, location[2:0]};
      
      default:     final_address = {4'b0000, location[2:0]};
   endcase
end

endmodule

module cpu (
   clk,
   reset,
   
   paddr,
   pdata,
   portain,
   portbout,
   portcout,
   
   expdin,
   expdout,
   expaddr,
   expread,
   expwrite,
   
   debugw,
   debugpc,
   debuginst,
   debugstatus
);

// Basic Core I/O.
input		clk;
input		reset;

// Program memory interface
output [10:0]	paddr;
input  [11:0]	pdata;

// Basic I/O Ports
input  [7:0]	portain;
output [7:0]	portbout;
output [7:0]	portcout;

// Expansion Interface
input [7:0]	expdin;		// Data from expansion circuits TO the PIC Core
output [7:0]	expdout;	// Data to the expansion circuits FROM the PIC Core
output [6:0]	expaddr;	// File address
output		expread;	// Active high read signal (read FROM expansion circuit)
output		expwrite;	// Active high write signal (write TO expansion circuit)

// Debugging
output [7:0]	debugw;
output [10:0]	debugpc;
output [11:0]	debuginst;
output [7:0]	debugstatus;

// Register declarations for outputs
reg [10:0]	paddr;
reg [7:0]	portbout;
reg [7:0]	portcout;
reg [7:0]	expdout;
reg [6:0]	expaddr;
reg		expread;
reg		expwrite;

//
// Copyright (c) 1999 Thomas Coonan (tcoonan@mindspring.com)
//
//    This source code is free software; you can redistribute it
//    and/or modify it in source code form under the terms of the GNU
//    General Public License as published by the Free Software
//    Foundation; either version 2 of the License, or (at your option)
//    any later version.
//
//    This program is distributed in the hope that it will be useful,
//    but WITHOUT ANY WARRANTY; without even the implied warranty of
//    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//    GNU General Public License for more details.
//
//    You should have received a copy of the GNU General Public License
//    along with this program; if not, write to the Free Software
//    Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA 02111-1307, USA
//


// This should be set to the ROM location where our restart vector is.
// As set here, we have 512 words of program space.
//
parameter [10:0] RESET_VECTOR = 11'h7FF;

parameter [2:0]	INDF_ADDRESS	= 3'h0,
		TMR0_ADDRESS	= 3'h1,
		PCL_ADDRESS	= 3'h2,
		STATUS_ADDRESS	= 3'h3,
		FSR_ADDRESS	= 3'h4,
		PORTA_ADDRESS	= 3'h5,
		PORTB_ADDRESS	= 3'h6,
		PORTC_ADDRESS	= 3'h7;

// *********  Special internal registers

// Instruction Register
reg  [11:0]	inst;

// Program Counter
reg  [10:0]	pc, pc_in;

// Stack Registers and Stack "levels" register.
reg [ 1:0]	stacklevel;
reg [10:0]	stack1;
reg [10:0]	stack2;

// W Register
reg [ 7:0]	w;

// The STATUS register (#3) is 8 bits wide, however, we only currently use 2 bits
// of it; the C and Z bit.
//
// bit 0  -  C
// bit 2  -  Z
//
reg [ 7:0]	status;

// The FSR register is the pointer register used for Indirect addressing (e.g. using INDF).
reg  [ 7:0]	fsr;

// Timer 0
reg  [ 7:0]	tmr0;
reg  [ 7:0]	prescaler;

// Option Register
reg [7:0]	option;

// Tristate Control registers. We do not neccessarily support bidirectional ports, but
//    will save a place for these registers and the TRIS instruction.  Use for debug.
reg [7:0]	trisa;
reg [7:0]	trisb;
reg [7:0]	trisc;

// I/O Port registers
//
reg [7:0]	porta;	// Input PORT
reg [7:0]	portb;	// Output PORT
reg [7:0]	portc;	// Output PORT

// ********** Instruction Related signals ******

reg 		skip;  // When HI force a NOP (all zeros) into inst

// Derive special sub signals from inst register
wire [ 7:0]	k;
wire [ 4:0]	fsel;
wire		d;
wire [ 2:0]	b;

// ********** File Address ************
//
// This is the 7-bit Data Address that includes the lower 5-bit fsel, the
// FSR bits and any indirect addressing.
// Use this bus to address the Register File as well as all special registers, etc.
//
reg [6:0]	fileaddr;

// Address Selects
reg		specialsel;
reg		regfilesel;
reg		expsel;

// ******  Instruction Decoder Outputs **************

// Write enable for the actual ZERO and CARRY bits within the status register.
// Generated by the Instruction Decoder.
//
wire [1:0]	aluasel;
wire [1:0]	alubsel;
wire [3:0]	aluop;

wire		zwe;
wire		cwe;

wire		isoption;
wire		istris;

wire		fwe;	// High if any "register" is being written to at all.
wire		wwe;	// Write Enable for the W register.  Produced by Instruction Decoder.

// *************  Internal Busses, mux connections, etc.  ********************

// Bit decoder bits.  
reg [7:0]	bd;	// Final decoder value after any polarity inversion.
reg [7:0]	bdec;	// e.g. "Bit Decoded"
wire		bdpol;	// Polarity bit for the bit test operations.

// Data in and out of the and out of the register file
//
reg [7:0]	regfilein;	// Input into Register File, is connected to the dbus.
wire [7:0]	regfileout;	// Path leaving the register file, goes to SBUS Mux
reg		regfilewe;	// Write Enable
reg		regfilere;	// Read Enable

//
// The dbus (Destination Bus) comes out of the ALU.  It is available to all
// writable registers.
//
// The sbus (Source Bus) comes from all readable registers as well as the output
// of the Register File.  It is one of the primary inputs into the ALU muxes.
//
// The (Expansion Bus) is another potential source.  See the 'exp' signals.
//
reg  [7:0]	dbus;
reg  [7:0]	sbus;


// ALU Signals
//
reg  [7:0]	alua;
reg  [7:0]	alub;
wire [7:0]	aluout;
wire		alucout;
wire       	aluz;

// ALU A and B mux selects.
//
parameter [1:0]	ALUASEL_W	= 2'b00,
		ALUASEL_SBUS	= 2'b01,
		ALUASEL_K	= 2'b10,
		ALUASEL_BD	= 2'b11;
		
parameter [1:0]	ALUBSEL_W	= 2'b00,
		ALUBSEL_SBUS	= 2'b01,
		ALUBSEL_K	= 2'b10,
		ALUBSEL_1	= 2'b11;

// ALU Operation codes.
//		
parameter  [3:0] ALUOP_ADD  = 4'b0000;
parameter  [3:0] ALUOP_SUB  = 4'b1000;
parameter  [3:0] ALUOP_AND  = 4'b0001;
parameter  [3:0] ALUOP_OR   = 4'b0010;
parameter  [3:0] ALUOP_XOR  = 4'b0011;
parameter  [3:0] ALUOP_COM  = 4'b0100;
parameter  [3:0] ALUOP_ROR  = 4'b0101;
parameter  [3:0] ALUOP_ROL  = 4'b0110;
parameter  [3:0] ALUOP_SWAP = 4'b0111;

reg [1:0] phase_cnt;
wire [1:0] phase_cnt_inc;
wire [1:0] phase_cnt_next;

reg q1;
reg q4;

parameter [1:0] PHASE_CNT_OVF = 2'b10;

always @(posedge clk) begin
    if (reset) begin
        phase_cnt <= 2'b00;
    end
    else begin
        phase_cnt <= phase_cnt_next;
    end
end

assign phase_cnt_inc = phase_cnt + 2'b01;
assign phase_cnt_next = phase_cnt_inc == PHASE_CNT_OVF ? 2'b00 : phase_cnt_inc;

always @(posedge clk) begin
    if (reset) begin
        q1 <= 1'b1;
        q4 <= 1'b0;
    end
    else begin
        q1 <= phase_cnt_inc == (PHASE_CNT_OVF        ) ? 1'b1 : 1'b0;
        q4 <= phase_cnt_inc == (PHASE_CNT_OVF - 2'b01) ? 1'b1 : 1'b0;
    end
end

// Instantiate each of our subcomponents
//
regs  regs (
   .clk		(clk), 
   .reset	(reset),
   .we  	(regfilewe),
   .re		(regfilere),
   .bank	(fileaddr[6:5]), 
   .location	(fileaddr[4:0]),
   .din		(regfilein), 
   .dout	(regfileout)
);

// Instatiate the ALU.
//
alu alu  (
   .op         (aluop), 
   .a          (alua), 
   .b          (alub),
   .y          (aluout),
   .cin        (status[0]), 
   .cout       (alucout), 
   .zout       (aluz)
);

// Instantiate the Instruction Decoder.  This is really just a lookup table.
// Given the instruction, generate all the signals we need.  
//
// For example, each instruction implies a specific ALU operation.  Some of
// these are obvious such as the ADDW uses an ADD alu op.  Less obvious is
// that a mov instruction uses an OR op which lets us do a simple copy.
// 
// Data has to funnel through the ALU, which sometimes makes for contrived
// ALU ops.
//
wire		idecwwe;
wire		idecfwe;
wire		ideczwe;
wire		ideccwe;

idec idec (
   .inst     (inst),
   .aluasel  (aluasel),
   .alubsel  (alubsel),
   .aluop    (aluop),
   .wwe      (idecwwe),
   .fwe      (idecfwe),
   .zwe      (ideczwe),
   .cwe      (ideccwe),
   .bdpol    (bdpol),
   .option   (isoption),
   .tris     (istris)
);

// Wire decoder enables to enables in at this module.  I did this because at
// one time I had another global 'enable' that was ANDed in, but I removed that.
//
assign wwe = idecwwe;
assign fwe = idecfwe;
assign zwe = ideczwe;
assign cwe = ideccwe;

// *********** Debug ****************
assign	debugw = w;
assign	debugpc = pc;
assign	debuginst = inst;
assign	debugstatus = status;

// *********** REGISTER FILE Addressing ****************
//
// We implement the following:
//    - The 5-bit fsel address is within a "BANK" which is 32 bytes.
//    - The FSR bits 6:5 are the BANK select, so there are 4 BANKS, a 
//      total of 128 bytes.  Minus the 8 special registers, that's 
//      really 120 bytes.
//    - The INDF register is for indirect addressing.  Referencing INDF
//      uses FSR as the pointer.  Therefore, using INDF/FSR you address
//      7-bits of memory.
// We DO NOT currently implement the PAGE for program (e.g. STATUS register
// bits 6:5)
//
// The fsel address *may* be zero in which case, we are to do indirect
// addressing, using FSR register as the 8-bit pointer.
//
// Otherwise, use the 5-bits of FSEL (from the Instruction itself) and 
// 2 bank bits from the FSR register (bits 6:5).
//
always @(fsel or fsr or status) begin
   if (fsel == INDF_ADDRESS) begin
      // The INDEX register is addressed.  There really is no INDEX register.
      // Use the FSR as an index, e.g. the FSR contents are the fsel.
      //
      fileaddr = fsr[6:0];
   end
   else begin
      // Use FSEL field and status bank select bits
      //
      fileaddr = {status[6:5], fsel};
   end
end

// Write Enable to Register File.  
// Assert this when the general fwe (write enable to *any* register) is true AND Register File
//    address range is specified.
//  
always @(regfilesel or fwe or q4)
   regfilewe = q4 & regfilesel & fwe;

// Read Enable (this if nothing else, helps in debug.)
// Assert if Register File address range is specified AND the ALU is actually using some
//    data off the SBUS.
//   
always @(regfilesel or aluasel or alubsel or q1)
   regfilere = q1 & regfilesel & ((aluasel == ALUASEL_SBUS) | (alubsel == ALUBSEL_SBUS));

// *********** Address Decodes **************
//
// Generate 3 selects: specialsel, regfilesel and expsel
//
// ** NOTE:	Must change this whenever more or few expansion addresses are
//		added or removed from the memory map.  Otherwise, the dbus mux
// 		won't be controlled properly!
//
always @(fileaddr) begin
   casex (fileaddr) // synopsys full_case parallel_case
      // This shouldn't really change.
      //
      7'bXX00XXX: // The SPECIAL Registers are lower 8 addresses, in ALL BANKS
         begin
            specialsel	= 1'b1;
            regfilesel	= 1'b0;
            expsel	= 1'b0;
         end
         
      // Adjust this case as EXPANSION locations change!
      //
      7'b11111XX: // EXPANSION Registers are the top (4) addresses
         begin
            specialsel	= 1'b0;
            regfilesel	= 1'b0;
            expsel	= 1'b1;
         end
         
      // Assume everything else must be the Register File..
      //
      default:
         begin
            specialsel	= 1'b0;
            regfilesel	= 1'b1;
            expsel	= 1'b0;
         end
   endcase
end
  

// *********** Expansion Interface **************

always @(dbus)
   expdout = dbus;
   
always @(fileaddr)
   expaddr = fileaddr;

always @(expsel or aluasel or alubsel or q1)
   expread = q1 & expsel & ((aluasel == ALUASEL_SBUS) | (alubsel == ALUBSEL_SBUS));

always @(expsel or fwe or q4)
   expwrite = q4 & expsel & fwe;


//
// *********** SBUS **************
// The sbus (Source Bus) is the output of a multiplexor that takes
// inputs from the Register File, and all other special registers
// and input ports.  The Source Bus then, one of the inputs to the ALU


// First MUX selects from all the special regsiters
//
always @(fsel or fsr or tmr0 or pc or status
         or porta or portb or portc or regfileout or expdin
         or specialsel or regfilesel or expsel) begin
         
   // For our current mix of registers and peripherals, only the first 8 addresses
   // are "special" registers (e.g. not in the Register File).  As more peripheral
   // registers are added, they must be muxed into this MUX as well.
   //
   // We currently prohibit tristates.
   //
   //
   if (specialsel) begin
      // Special register
      case (fsel[2:0]) // synopsys parallel_case full_case
         3'h0:	sbus = fsr;
         3'h1:	sbus = tmr0;
         3'h2:	sbus = pc[7:0];
         3'h3:	sbus = status;
         3'h4:	sbus = fsr;
         3'h5:	sbus = porta; // PORTA is an input-only port
         3'h6:	sbus = portb; // PORTB is an output-only port
         3'h7:	sbus = portc; // PORTC is an output-only port
      endcase
   end
   else begin
      //
      // Put whatever address equation is neccessary here.  Remember to remove unnecessary
      // memory elements from Register File (regs.v).  It'll still work, but they'd be
      // wasted flip-flops.
      //
      if (expsel) begin
         sbus = expdin;
      end
      else begin
         if (regfilesel) begin
            // Final Priority is Choose the register file
            sbus = regfileout;
         end
         else begin
            sbus = 8'h00;
         end
      end
   end
end

// ************** DBUS ******
//  The Destination bus is just the output of the ALU.
//
always @(aluout)
   dbus = aluout;

always @(dbus)
   regfilein = dbus;
   
// Drive the ROM address bus straight from the PC bus
//
always @(pc)
   paddr = pc;


// Define sub-signals out of inst
//
assign k =     inst[7:0];
assign fsel  = inst[4:0];
assign d     = inst[5];
assign b     = inst[7:5];

// Bit Decoder.
//
// Simply take the 3-bit b field in the PIC instruction and create the
// expanded 8-bit decoder field, which is used as a mask.
//


always @(b) begin
   case (b) // synopsys parallel_case
      3'b000: bdec = 8'b00000001;
      3'b001: bdec = 8'b00000010;
      3'b010: bdec = 8'b00000100;
      3'b011: bdec = 8'b00001000;
      3'b100: bdec = 8'b00010000;
      3'b101: bdec = 8'b00100000;
      3'b110: bdec = 8'b01000000;
      3'b111: bdec = 8'b10000000;
   endcase
end

always @(bdec or bdpol)
   bd = (bdpol) ? ~bdec : bdec;

// Instruction regsiter usually get the ROM data as its input, but
// sometimes for branching, the skip signal must cause a NOP.
//
always @(posedge clk) begin
   if (reset) begin
      inst <= 12'h000;
   end
   else if (q4) begin
      if (skip == 1'b1) begin
         inst <= 12'b000000000000; // FORCE NOP
      end
      else begin
         inst <= pdata;
      end
   end
end

// SKIP signal.
//
// We want to insert the NOP instruction for the following conditions:
//    GOTO,CALL and RETLW instructions (All have inst[11:10] = 2'b10
//    BTFSS instruction when aluz is HI  (
//    BTFSC instruction when aluz is LO
//
always @(inst or aluz) begin
   casex ({inst, aluz}) // synopsys parallel_case
      13'b10??_????_????_?:    // A GOTO, CALL or RETLW instructions
         skip = 1'b1;
         
      13'b0110_????_????_1:    // BTFSC instruction and aluz == 1
         skip = 1'b1;
	
      13'b0111_????_????_0:    // BTFSS instruction and aluz == 0
         skip = 1'b1;
      
      13'b0010_11??_????_1:    // DECFSZ instruction and aluz == 1
         skip = 1'b1;
	
      13'b0011_11??_????_1:    // INCFSZ instruction and aluz == 1
         skip = 1'b1;
	
      default:
         skip = 1'b0;
   endcase
end

// 4:1 Data MUX into alua
//
//
always @(aluasel or w or sbus or k or bd) begin
   case (aluasel) // synopsys parallel_case
      2'b00: alua = w;
      2'b01: alua = sbus;
      2'b10: alua = k;
      2'b11: alua = bd;
   endcase
end

// 4:1 Data MUX into alub
//
//
always @(alubsel or w or sbus or k) begin
   case (alubsel) // synopsys parallel_case
      2'b00: alub = w;
      2'b01: alub = sbus;
      2'b10: alub = k;
      2'b11: alub = 8'b00000001;
   endcase
end

// W Register
always @(posedge clk) begin
   if (reset) begin
      w <= 8'h00;
   end
   else if (q4) begin
      if (wwe) begin
         w <= dbus;
      end
   end   
end

// ************ Writes to various Special Registers (fsel between 0 and 7)

// INDF Register (Register #0)
//
//    Not a real register.  This is the Indirect Addressing mode register.
//    See the regfileaddr logic.

// TMR0 Register (Register #1)
//
//    Timer0 is currently only a free-running timer clocked by the main system clock.
//
always @(posedge clk) begin
   if (reset) begin
      tmr0 <= 8'h00;
   end
   else if (q4) begin
      // See if the status register is actually being written to
      if (fwe & specialsel & (fileaddr[2:0] == TMR0_ADDRESS)) begin
         // Yes, so just update the register from the dbus
         tmr0 <= dbus;
      end
      else begin
         if (~option[5]) begin
            // OPTION[3]  -  Assigns prescaler to either WDT or TIMER0.  We don't implement WDT.
            //               If this bit is 0, then use the prescaler.  If 1 then increment.
            //
            // Mask off the prescaler value based on desired divide ratio.
            // Whenever this is zero, then that is our divided pulse.  Increment
            // the final timer value when it's zero.
            //
            casex (option[3:0]) // synopsys parallel_case full_case
               4'b1XXX: tmr0 <= tmr0 + 1;
               4'b0000: if (~|(prescaler & 8'b00000001)) tmr0 <= tmr0 + 1;
               4'b0001: if (~|(prescaler & 8'b00000011)) tmr0 <= tmr0 + 1;
               4'b0010: if (~|(prescaler & 8'b00000111)) tmr0 <= tmr0 + 1;
               4'b0011: if (~|(prescaler & 8'b00001111)) tmr0 <= tmr0 + 1;
               4'b0100: if (~|(prescaler & 8'b00011111)) tmr0 <= tmr0 + 1;
               4'b0101: if (~|(prescaler & 8'b00111111)) tmr0 <= tmr0 + 1;
               4'b0110: if (~|(prescaler & 8'b01111111)) tmr0 <= tmr0 + 1;
               4'b0111: if (~|(prescaler & 8'b11111111)) tmr0 <= tmr0 + 1;
            endcase            
         end
      end
   end
end

// The prescaler is always counting from 00 to FF whenever OPTION[5] is cleared (e.g. T0CS)
always @(posedge clk) begin
   if (reset) begin
      prescaler <= 8'h00;
   end
   else if (q4) begin
      if (~option[5]) begin
         prescaler <= prescaler + 1;
      end
   end
end

// PCL Register (Register #2)
//
//    PC Lower 8 bits.  This is handled in the PC section below...


// STATUS Register (Register #3)
//
parameter [7:0] STATUS_RESET_VALUE = 8'h18;

always @(posedge clk) begin
   if (reset) begin
      status <= STATUS_RESET_VALUE;
   end
   else if (q4) begin
      // See if the status register is actually being written to
      if (fwe & specialsel & (fileaddr[2:0] == STATUS_ADDRESS)) begin
         // Yes, so just update the register from the dbus
         status <= dbus;
      end
      else begin
         // Update status register on a bit-by-bit basis.
         //
         // For the carry and zero flags, each instruction has its own rule as
         // to whether to update this flag or not.  The instruction decoder is
         // providing us with an enable for C and Z.  Use this to decide whether
         // to retain the existing value, or update with the new alu status output.
         //
         status <= {
            status[7],			// BIT 7: Undefined.. (maybe use for debugging)
            status[6],			// BIT 6: Program Page, HI bit
            status[5],			// BIT 5: Program Page, LO bit
            status[4],			// BIT 4: Time Out bit (not implemented at this time)
            status[3],			// BIT 3: Power Down bit (not implemented at this time)
            (zwe) ? aluz : status[2],	// BIT 2: Z
            status[1],			// BIT 1: DC
            (cwe) ? alucout : status[0]	// BIT 0: C
         };
      end
   end
end

// FSR Register  (Register #4)
//            
always @(posedge clk) begin
   if (reset) begin
      fsr <= 8'h00;
   end
   else if (q4) begin
      // See if the status register is actually being written to
      if (fwe & specialsel & (fileaddr[2:0] == FSR_ADDRESS)) begin
         fsr <= dbus;
      end
   end
end

// OPTION Register
//
// The special OPTION instruction should move W into the OPTION register.
//
parameter [7:0] OPTION_RESET_VALUE = 8'h3F;
always @(posedge clk) begin
   if (reset) begin
      option <= OPTION_RESET_VALUE;
   end
   else if (q4) begin
      if (isoption)
         option <= dbus;
   end   
end

// PORTA Input Port   (Register #5)
//
// Register anything on the module's porta input on every single clock.
//
always @(posedge clk)
   if (reset) porta <= 8'h00;
   else if (q1) porta <= portain;

// PORTB Output Port  (Register #6)
always @(posedge clk) begin
   if (reset) begin
      portb <= 8'h00;
   end
   else if (q4) begin
      if (fwe & specialsel & (fileaddr[2:0] == PORTB_ADDRESS) & ~istris) begin
         portb <= dbus;
      end
   end   
end

// Connect the output ports to the register output.
always @(portb)
   portbout = portb;
   
// PORTC Output Port  (Register #7)
always @(posedge clk) begin
   if (reset) begin
      portc <= 8'h00;
   end
   else if (q4) begin
      if (fwe & specialsel & (fileaddr[2:0] == PORTC_ADDRESS) & ~istris) begin
         portc <= dbus;
      end
   end   
end

// Connect the output ports to the register output.
always @(portc)
   portcout = portc;
 
// TRIS Registers
always @(posedge clk) begin
   if (reset) begin
      trisa <= 8'hff; // Default is to tristate them
   end
   else if (q4) begin
      if (fwe & specialsel & (fileaddr[2:0] == PORTA_ADDRESS) & istris) begin
         trisa <= dbus;
      end
   end   
end

always @(posedge clk) begin
   if (reset) begin
      trisb <= 8'hff; // Default is to tristate them
   end
   else if (q4) begin
      if (fwe & specialsel & (fileaddr[2:0] == PORTB_ADDRESS) & istris) begin
         trisb <= dbus;
      end
   end   
end

always @(posedge clk) begin
   if (reset) begin
      trisc <= 8'hff; // Default is to tristate them
   end
   else if (q4) begin
      if (fwe & specialsel & (fileaddr[2:0] == PORTC_ADDRESS) & istris) begin
         trisc <= dbus;
      end
   end   
end
  

// ********** PC AND STACK *************************
//
// There are 4 ways to change the PC.  They are:
//    GOTO  101k_kkkk_kkkk
//    CALL  1001_kkkk_kkkk
//    RETLW 1000_kkkk_kkkk
//    MOVF  0010_0010_0010  (e.g. a write to reg #2)
//    MOVWF 0000_0010_0010  (write from W to reg #2)
//
// Remember that the skip instructions work by inserting
// a NOP instruction or not into program stream and don't
// change the PC.
//


// Implmenent PC
//
// Seperate the PC_IN input bus into PC from the sequential register so that we
// can feed the PC_IN bus into the PRAM address input.

always @(posedge clk)
   if (reset) pc <= RESET_VECTOR;
   else if (q4) pc <= pc_in;

always @(inst or stacklevel or status or stack1 or stack2 or pc or dbus) begin
   casex ({inst, stacklevel}) // synopsys parallel_case
      14'b101?_????_????_??: pc_in = {status[6:5],       inst[8:0]};	// GOTO
      14'b1001_????_????_??: pc_in = {status[6:5], 1'b0, inst[7:0]};	// CALL
      14'b1000_????_????_00: pc_in = stack1;				// RETLW
      14'b1000_????_????_01: pc_in = stack1;				// RETLW
      14'b1000_????_????_10: pc_in = stack2;				// RETLW
      14'b1000_????_????_11: pc_in = stack2;				// RETLW
      14'b00?0_0010_0010_??: pc_in = {pc[10:8], dbus};		// MOVF or MOVWF where f=PC
      default:
         pc_in = pc + 1;
   endcase
end


// Implement STACK1 and STACK2 registers
//
// The Stack registers are only fed from the PC itself!
//
always @(posedge clk) begin
   if (reset) begin
      stack1 <= 9'h000;
   end
   else if (q4) begin
      // CALL instruction
      if (inst[11:8] == 4'b1001) begin
         case (stacklevel) // synopsys parallel_case
            2'b00:
               // No previous CALLs 
               begin
                  stack1 <= pc;
               end
            2'b01:
               // ONE previous CALL 
               begin
                  stack2 <= pc;
               end
            2'b10:
               // TWO previous CALLs -- This is illegal on the 16C5X.
               begin
               end
            2'b11: 
               begin
               end
         endcase
      end
   end
end

// Write to stacklevel
//
// The stacklevel register keeps track of the current stack depth.  On this
// puny processor, there are only 2 levels (you could fiddle with this and
// increase the stack depth).  There are two stack registers, stack1 and stack2.
// The stack1 register is used first (e.g. the first time a call is performed),
// then stack2.  As CALLs are done, stacklevel increments.  Conversely, as
// RETs are done, stacklevel goes down. 

always @(posedge clk) begin
   if (reset == 1'b1) begin
      stacklevel <= 2'b00;  // On reset, there should be no CALLs in progress
   end
   else if (q4) begin
      casex ({inst, stacklevel}) // synopsys parallel_case
         // Call instructions
         14'b1001_????_????_00: stacklevel <= 2'b01;  // Record 1st CALL
         14'b1001_????_????_01: stacklevel <= 2'b10;  // Record 2nd CALL
         14'b1001_????_????_10: stacklevel <= 2'b10;  // Already 2! Ignore
         14'b1001_????_????_11: stacklevel <= 2'b00;  // {shouldn't happen}

         // Return instructions
         14'b1000_????_????_00: stacklevel <= 2'b00;  // {shouldn't happen}
         14'b1000_????_????_01: stacklevel <= 2'b00;  // Go back to no CALL in progress
         14'b1000_????_????_10: stacklevel <= 2'b01;  // Go back to 1 CALL in progress
         14'b1000_????_????_11: stacklevel <= 2'b10;  // {shouldn't happen} sort of like, Go back to 2 calls in progress
         default:
            stacklevel <= stacklevel;
      endcase
   end
end

// *******  Debug Stuff  ******** //
//
// The following is NOT synthesizable.  This code simply allows you to see the ASCII name
// for the instruction in the INST register while in a waveform viewer.
//
// synopsys translate_off
reg [8*8-1:0] inst_string;

always @(inst) begin
   casex (inst)
      12'b0000_0000_0000: inst_string = "NOP     ";
      12'b0000_001X_XXXX: inst_string = "MOVWF   ";
      12'b0000_0100_0000: inst_string = "CLRW    ";
      12'b0000_011X_XXXX: inst_string = "CLRF    ";
      12'b0000_10XX_XXXX: inst_string = "SUBWF   ";
      12'b0000_11XX_XXXX: inst_string = "DECF    ";
      12'b0001_00XX_XXXX: inst_string = "IORWF   ";
      12'b0001_01XX_XXXX: inst_string = "ANDWF   ";
      12'b0001_10XX_XXXX: inst_string = "XORWF   ";
      12'b0001_11XX_XXXX: inst_string = "ADDWF   ";
      12'b0010_00XX_XXXX: inst_string = "MOVF    ";
      12'b0010_01XX_XXXX: inst_string = "COMF    ";
      12'b0010_10XX_XXXX: inst_string = "INCF    ";
      12'b0010_11XX_XXXX: inst_string = "DECFSZ  ";
      12'b0011_00XX_XXXX: inst_string = "RRF     ";
      12'b0011_01XX_XXXX: inst_string = "RLF     ";
      12'b0011_10XX_XXXX: inst_string = "SWAPF   ";
      12'b0011_11XX_XXXX: inst_string = "INCFSZ  ";

      // *** Bit-Oriented File Register Operations
      12'b0100_XXXX_XXXX: inst_string = "BCF     ";
      12'b0101_XXXX_XXXX: inst_string = "BSF     ";
      12'b0110_XXXX_XXXX: inst_string = "BTFSC   ";
      12'b0111_XXXX_XXXX: inst_string = "BTFSS   ";

      // *** Literal and Control Operations
      12'b0000_0000_0010: inst_string = "OPTION  ";
      12'b0000_0000_0011: inst_string = "SLEEP   ";
      12'b0000_0000_0100: inst_string = "CLRWDT  ";
      12'b0000_0000_0101: inst_string = "TRIS    ";
      12'b0000_0000_0110: inst_string = "TRIS    ";
      12'b0000_0000_0111: inst_string = "TRIS    ";
      12'b1000_XXXX_XXXX: inst_string = "RETLW   ";
      12'b1001_XXXX_XXXX: inst_string = "CALL    ";
      12'b101X_XXXX_XXXX: inst_string = "GOTO    ";
      12'b1100_XXXX_XXXX: inst_string = "MOVLW   ";
      12'b1101_XXXX_XXXX: inst_string = "IORLW   ";
      12'b1110_XXXX_XXXX: inst_string = "ANDLW   ";
      12'b1111_XXXX_XXXX: inst_string = "XORLW   ";

      default:            inst_string = "-XXXXXX-";
   endcase
end
   
// synopsys translate_on

endmodule
