// Vendored from https://github.com/shalan/uart_apb_master (rtl/).
// Top is uart_apb_master. uart_apb_sys is left out: its splitter is wider than 32 bits.

module baud_gen (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [15:0] divisor,    // clk_freq / baud_rate
    output reg         tick
);

    reg [15:0] counter;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            counter <= 16'd0;
            tick    <= 1'b0;
        end else begin
            if (counter == divisor - 1) begin
                counter <= 16'd0;
                tick    <= 1'b1;
            end else begin
                counter <= counter + 1;
                tick    <= 1'b0;
            end
        end
    end

endmodule

module uart_rx (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       tick,       // 16x baud rate tick
    input  wire       rx,
    output reg  [7:0] data,
    output reg        valid
);

    localparam IDLE  = 2'd0,
               START = 2'd1,
               DATA  = 2'd2,
               STOP  = 2'd3;

    reg [1:0] state;
    reg [3:0] tick_cnt;
    reg [2:0] bit_cnt;
    reg [7:0] shift_reg;
    reg       rx_sync1, rx_sync2;

    // Double-flop synchronizer
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rx_sync1 <= 1'b1;
            rx_sync2 <= 1'b1;
        end else begin
            rx_sync1 <= rx;
            rx_sync2 <= rx_sync1;
        end
    end

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state     <= IDLE;
            tick_cnt  <= 4'd0;
            bit_cnt   <= 3'd0;
            shift_reg <= 8'd0;
            data      <= 8'd0;
            valid     <= 1'b0;
        end else begin
            valid <= 1'b0;
            case (state)
                IDLE: begin
                    if (~rx_sync2) begin
                        state    <= START;
                        tick_cnt <= 4'd0;
                    end
                end

                START: begin
                    if (tick) begin
                        if (tick_cnt == 4'd7) begin
                            if (~rx_sync2) begin
                                state    <= DATA;
                                tick_cnt <= 4'd0;
                                bit_cnt  <= 3'd0;
                            end else begin
                                state <= IDLE;
                            end
                        end else begin
                            tick_cnt <= tick_cnt + 1;
                        end
                    end
                end

                DATA: begin
                    if (tick) begin
                        if (tick_cnt == 4'd15) begin
                            tick_cnt  <= 4'd0;
                            shift_reg <= {rx_sync2, shift_reg[7:1]};
                            if (bit_cnt == 3'd7) begin
                                state <= STOP;
                            end else begin
                                bit_cnt <= bit_cnt + 1;
                            end
                        end else begin
                            tick_cnt <= tick_cnt + 1;
                        end
                    end
                end

                STOP: begin
                    if (tick) begin
                        if (tick_cnt == 4'd15) begin
                            state <= IDLE;
                            if (rx_sync2) begin
                                data  <= shift_reg;
                                valid <= 1'b1;
                            end
                        end else begin
                            tick_cnt <= tick_cnt + 1;
                        end
                    end
                end
            endcase
        end
    end

endmodule

module uart_tx (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       tick,       // 16x baud rate tick
    input  wire [7:0] data,
    input  wire       start,
    output reg        tx,
    output reg        busy
);

    localparam IDLE  = 2'd0,
               START = 2'd1,
               DATA  = 2'd2,
               STOP  = 2'd3;

    reg [1:0] state;
    reg [3:0] tick_cnt;
    reg [2:0] bit_cnt;
    reg [7:0] shift_reg;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state     <= IDLE;
            tick_cnt  <= 4'd0;
            bit_cnt   <= 3'd0;
            shift_reg <= 8'd0;
            tx        <= 1'b1;
            busy      <= 1'b0;
        end else begin
            case (state)
                IDLE: begin
                    tx <= 1'b1;
                    if (start) begin
                        state     <= START;
                        shift_reg <= data;
                        tick_cnt  <= 4'd0;
                        busy      <= 1'b1;
                    end
                end

                START: begin
                    tx <= 1'b0;
                    if (tick) begin
                        if (tick_cnt == 4'd15) begin
                            state    <= DATA;
                            tick_cnt <= 4'd0;
                            bit_cnt  <= 3'd0;
                        end else begin
                            tick_cnt <= tick_cnt + 1;
                        end
                    end
                end

                DATA: begin
                    tx <= shift_reg[0];
                    if (tick) begin
                        if (tick_cnt == 4'd15) begin
                            tick_cnt <= 4'd0;
                            shift_reg <= {1'b0, shift_reg[7:1]};
                            if (bit_cnt == 3'd7) begin
                                state <= STOP;
                            end else begin
                                bit_cnt <= bit_cnt + 1;
                            end
                        end else begin
                            tick_cnt <= tick_cnt + 1;
                        end
                    end
                end

                STOP: begin
                    tx <= 1'b1;
                    if (tick) begin
                        if (tick_cnt == 4'd15) begin
                            state <= IDLE;
                            busy  <= 1'b0;
                        end else begin
                            tick_cnt <= tick_cnt + 1;
                        end
                    end
                end
            endcase
        end
    end

endmodule

// Command Parser
// Protocol: SYNC0(0xDE) SYNC1(0xAD) CMD ADDR[3:0] DATA[3:0](write only)
// CMD: 0xA5 = write, 0x5A = read
// Includes a timeout: resets to SYNC0 if no byte arrives within TIMEOUT_CYCLES
module cmd_parser #(
    parameter TIMEOUT_CYCLES = 32'd5_000_000  // ~312ms at 16MHz
)(
    input  wire        clk,
    input  wire        rst_n,
    input  wire [7:0]  rx_data,
    input  wire        rx_valid,
    output reg  [31:0] cmd_addr,
    output reg  [31:0] cmd_wdata,
    output reg         cmd_write,
    output reg         cmd_valid
);

    localparam S_SYNC0 = 3'd0,
               S_SYNC1 = 3'd1,
               S_CMD   = 3'd2,
               S_ADDR  = 3'd3,
               S_DATA  = 3'd4;

    reg [2:0]  state;
    reg [1:0]  byte_cnt;
    reg        is_write;
    reg [31:0] timeout_cnt;

    // Timeout: reset parser if stuck mid-frame
    wire timeout = (state != S_SYNC0) && (timeout_cnt == TIMEOUT_CYCLES);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            timeout_cnt <= 32'd0;
        end else begin
            if (rx_valid || state == S_SYNC0)
                timeout_cnt <= 32'd0;
            else
                timeout_cnt <= timeout_cnt + 1;
        end
    end

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state     <= S_SYNC0;
            byte_cnt  <= 2'd0;
            cmd_addr  <= 32'd0;
            cmd_wdata <= 32'd0;
            cmd_write <= 1'b0;
            cmd_valid <= 1'b0;
            is_write  <= 1'b0;
        end else begin
            cmd_valid <= 1'b0;

            if (timeout) begin
                state <= S_SYNC0;
            end else if (rx_valid) begin
                case (state)
                    S_SYNC0: begin
                        if (rx_data == 8'hDE)
                            state <= S_SYNC1;
                    end

                    S_SYNC1: begin
                        if (rx_data == 8'hAD)
                            state <= S_CMD;
                        else if (rx_data == 8'hDE)
                            state <= S_SYNC1;
                        else
                            state <= S_SYNC0;
                    end

                    S_CMD: begin
                        if (rx_data == 8'hA5) begin
                            is_write <= 1'b1;
                            state    <= S_ADDR;
                            byte_cnt <= 2'd0;
                        end else if (rx_data == 8'h5A) begin
                            is_write <= 1'b0;
                            state    <= S_ADDR;
                            byte_cnt <= 2'd0;
                        end else begin
                            state <= S_SYNC0;
                        end
                    end

                    S_ADDR: begin
                        cmd_addr <= {cmd_addr[23:0], rx_data};
                        if (byte_cnt == 2'd3) begin
                            if (is_write) begin
                                state    <= S_DATA;
                                byte_cnt <= 2'd0;
                            end else begin
                                cmd_write <= 1'b0;
                                cmd_valid <= 1'b1;
                                state     <= S_SYNC0;
                            end
                        end else begin
                            byte_cnt <= byte_cnt + 1;
                        end
                    end

                    S_DATA: begin
                        cmd_wdata <= {cmd_wdata[23:0], rx_data};
                        if (byte_cnt == 2'd3) begin
                            cmd_write <= 1'b1;
                            cmd_valid <= 1'b1;
                            state     <= S_SYNC0;
                        end else begin
                            byte_cnt <= byte_cnt + 1;
                        end
                    end

                    default: state <= S_SYNC0;
                endcase
            end
        end
    end

endmodule

// Response Builder
// Response format: STATUS DATA[3:0](read only)
// STATUS: 0xAC = ACK, 0xEE = error
module resp_builder (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [31:0] resp_data,
    input  wire        resp_error,
    input  wire        resp_is_read,
    input  wire        resp_valid,
    input  wire        tx_busy,
    output reg  [7:0]  tx_data,
    output reg         tx_start,
    output wire        resp_ready
);

    localparam S_IDLE   = 3'd0,
               S_STATUS = 3'd1,
               S_WAIT   = 3'd2,
               S_DATA   = 3'd3,
               S_DONE   = 3'd4;

    reg [2:0]  state;
    reg [1:0]  byte_cnt;
    reg [31:0] data_reg;
    reg        is_read;
    reg        error_reg;

    assign resp_ready = (state == S_IDLE);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state     <= S_IDLE;
            byte_cnt  <= 2'd0;
            data_reg  <= 32'd0;
            tx_data   <= 8'd0;
            tx_start  <= 1'b0;
            is_read   <= 1'b0;
            error_reg <= 1'b0;
        end else begin
            tx_start <= 1'b0;
            case (state)
                S_IDLE: begin
                    if (resp_valid) begin
                        data_reg  <= resp_data;
                        is_read   <= resp_is_read;
                        error_reg <= resp_error;
                        state     <= S_STATUS;
                    end
                end

                S_STATUS: begin
                    if (!tx_busy) begin
                        tx_data  <= error_reg ? 8'hEE : 8'hAC;
                        tx_start <= 1'b1;
                        if (is_read && !error_reg) begin
                            state    <= S_WAIT;
                            byte_cnt <= 2'd0;
                        end else begin
                            state <= S_DONE;
                        end
                    end
                end

                S_WAIT: begin
                    // Wait for TX to finish before sending next byte
                    if (!tx_busy && !tx_start) begin
                        state <= S_DATA;
                    end
                end

                S_DATA: begin
                    if (!tx_busy) begin
                        tx_data  <= data_reg[31:24];
                        tx_start <= 1'b1;
                        data_reg <= {data_reg[23:0], 8'd0};
                        if (byte_cnt == 2'd3) begin
                            state <= S_DONE;
                        end else begin
                            byte_cnt <= byte_cnt + 1;
                            state    <= S_WAIT;
                        end
                    end
                end

                S_DONE: begin
                    if (!tx_busy && !tx_start)
                        state <= S_IDLE;
                end
            endcase
        end
    end

endmodule

// APB Master FSM
// Executes single-word read/write transactions on the APB bus
module apb_master (
    input  wire        clk,
    input  wire        rst_n,
    // Command interface
    input  wire [31:0] cmd_addr,
    input  wire [31:0] cmd_wdata,
    input  wire        cmd_write,
    input  wire        cmd_valid,
    output wire        cmd_ready,
    // Response interface
    output reg  [31:0] resp_data,
    output reg         resp_error,
    output reg         resp_is_read,
    output reg         resp_valid,
    input  wire        resp_ready,
    // APB Master signals
    output reg  [31:0] PADDR,
    output reg         PSEL,
    output reg         PENABLE,
    output reg         PWRITE,
    output reg  [31:0] PWDATA,
    input  wire [31:0] PRDATA,
    input  wire        PREADY,
    input  wire        PSLVERR
);

    localparam S_IDLE   = 2'd0,
               S_SETUP  = 2'd1,
               S_ACCESS = 2'd2,
               S_RESP   = 2'd3;

    reg [1:0] state;

    assign cmd_ready = (state == S_IDLE);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state       <= S_IDLE;
            PADDR       <= 32'd0;
            PSEL        <= 1'b0;
            PENABLE     <= 1'b0;
            PWRITE      <= 1'b0;
            PWDATA      <= 32'd0;
            resp_data   <= 32'd0;
            resp_error  <= 1'b0;
            resp_is_read<= 1'b0;
            resp_valid  <= 1'b0;
        end else begin
            case (state)
                S_IDLE: begin
                    resp_valid <= 1'b0;
                    if (cmd_valid) begin
                        PADDR  <= cmd_addr;
                        PWRITE <= cmd_write;
                        PWDATA <= cmd_wdata;
                        PSEL   <= 1'b1;
                        state  <= S_SETUP;
                    end
                end

                S_SETUP: begin
                    PENABLE <= 1'b1;
                    state   <= S_ACCESS;
                end

                S_ACCESS: begin
                    if (PREADY) begin
                        resp_data    <= PRDATA;
                        resp_error   <= PSLVERR;
                        resp_is_read <= ~PWRITE;
                        PSEL         <= 1'b0;
                        PENABLE      <= 1'b0;
                        state        <= S_RESP;
                    end
                end

                S_RESP: begin
                    if (resp_ready) begin
                        resp_valid <= 1'b1;
                        state      <= S_IDLE;
                    end
                end
            endcase
        end
    end

endmodule

// UART-to-APB Master Bridge (Debug Backdoor)
// Protocol: SYNC(0xDEAD) + CMD + ADDR[31:0] + DATA[31:0](write only)
// Response: STATUS + DATA[31:0](read only)
//
// Lock register: writing 0xDEAD10CC to address 0xFFFFFFF0 permanently
// disables the bridge until the next reset. All subsequent commands
// receive an error (0xEE) response.
module uart_apb_master #(
    parameter DEFAULT_DIVISOR  = 16'd87,       // clk_freq / (baud * 16)
    parameter LOCK_ADDR        = 32'hFFFF_FFF0,
    parameter LOCK_KEY         = 32'hDEAD_10CC,
    parameter TIMEOUT_CYCLES   = 32'd5_000_000
)(
    input  wire        clk,
    input  wire        rst_n,
    // UART interface
    input  wire        uart_rx,
    output wire        uart_tx,
    // APB Master interface
    output wire [31:0] PADDR,
    output wire        PSEL,
    output wire        PENABLE,
    output wire        PWRITE,
    output wire [31:0] PWDATA,
    input  wire [31:0] PRDATA,
    input  wire        PREADY,
    input  wire        PSLVERR,
    // Status
    output wire        locked
);

    // Internal signals
    wire        baud_tick;
    wire [7:0]  rx_data;
    wire        rx_valid;
    wire [7:0]  tx_data;
    wire        tx_start;
    wire        tx_busy;
    wire [31:0] cmd_addr;
    wire [31:0] cmd_wdata;
    wire        cmd_write;
    wire        cmd_valid;
    wire        cmd_ready;
    wire [31:0] resp_data;
    wire        resp_error;
    wire        resp_is_read;
    wire        resp_valid;
    wire        resp_ready;

    // Lock register: two-stage so the lock command itself completes normally.
    // lock_armed latches immediately; lock_reg activates once the APB master
    // returns to idle, ensuring the lock command's own response is sent first.
    reg lock_armed;
    reg lock_reg;
    assign locked = lock_reg;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            lock_armed <= 1'b0;
            lock_reg   <= 1'b0;
        end else begin
            if (cmd_valid && cmd_write && cmd_addr == LOCK_ADDR && cmd_wdata == LOCK_KEY)
                lock_armed <= 1'b1;
            if (lock_armed && cmd_ready)
                lock_reg <= 1'b1;
        end
    end

    // Gate: when locked, block commands from reaching APB master and
    // inject an error response directly.
    wire        gated_cmd_valid;
    wire        locked_cmd_valid;

    assign gated_cmd_valid  = cmd_valid & ~lock_reg;
    assign locked_cmd_valid = cmd_valid &  lock_reg;

    // Mux response: from APB master normally, or error when locked
    wire [31:0] mux_resp_data;
    wire        mux_resp_error;
    wire        mux_resp_is_read;
    wire        mux_resp_valid;

    assign mux_resp_data    = lock_reg ? 32'd0       : resp_data;
    assign mux_resp_error   = lock_reg ? 1'b1        : resp_error;
    assign mux_resp_is_read = lock_reg ? ~cmd_write  : resp_is_read;
    assign mux_resp_valid   = lock_reg ? (locked_cmd_valid & resp_ready) : resp_valid;

    baud_gen u_baud_gen (
        .clk     (clk),
        .rst_n   (rst_n),
        .divisor (DEFAULT_DIVISOR[15:0]),
        .tick    (baud_tick)
    );

    uart_rx u_uart_rx (
        .clk   (clk),
        .rst_n (rst_n),
        .tick  (baud_tick),
        .rx    (uart_rx),
        .data  (rx_data),
        .valid (rx_valid)
    );

    uart_tx u_uart_tx (
        .clk   (clk),
        .rst_n (rst_n),
        .tick  (baud_tick),
        .data  (tx_data),
        .start (tx_start),
        .tx    (uart_tx),
        .busy  (tx_busy)
    );

    cmd_parser #(
        .TIMEOUT_CYCLES (TIMEOUT_CYCLES)
    ) u_cmd_parser (
        .clk      (clk),
        .rst_n    (rst_n),
        .rx_data  (rx_data),
        .rx_valid (rx_valid),
        .cmd_addr (cmd_addr),
        .cmd_wdata(cmd_wdata),
        .cmd_write(cmd_write),
        .cmd_valid(cmd_valid)
    );

    apb_master u_apb_master (
        .clk         (clk),
        .rst_n       (rst_n),
        .cmd_addr    (cmd_addr),
        .cmd_wdata   (cmd_wdata),
        .cmd_write   (cmd_write),
        .cmd_valid   (gated_cmd_valid),
        .cmd_ready   (cmd_ready),
        .resp_data   (resp_data),
        .resp_error  (resp_error),
        .resp_is_read(resp_is_read),
        .resp_valid  (resp_valid),
        .resp_ready  (resp_ready),
        .PADDR       (PADDR),
        .PSEL        (PSEL),
        .PENABLE     (PENABLE),
        .PWRITE      (PWRITE),
        .PWDATA      (PWDATA),
        .PRDATA      (PRDATA),
        .PREADY      (PREADY),
        .PSLVERR     (PSLVERR)
    );

    resp_builder u_resp_builder (
        .clk         (clk),
        .rst_n       (rst_n),
        .resp_data   (mux_resp_data),
        .resp_error  (mux_resp_error),
        .resp_is_read(mux_resp_is_read),
        .resp_valid  (mux_resp_valid),
        .tx_busy     (tx_busy),
        .tx_data     (tx_data),
        .tx_start    (tx_start),
        .resp_ready  (resp_ready)
    );

endmodule
