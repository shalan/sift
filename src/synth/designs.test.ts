import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { checkEquivalence } from "./lec.ts";
import { STD_LIBRARY } from "./library.ts";
import { mapDesign } from "./seq.ts";
import { parseVerilog } from "./verilog.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../designs");
const prove = new Set([
  "arlet6502.v",
  "chacha.v",
  "cpu8.v",
  "dsp8.v",
  "fir10.v",
  "p16c5x.v",
  "pic16.v",
  "pic1826.v",
  "risc8.v",
  "uart_apb.v",
  "x18.v",
  "xfir.v",
]);

function yosysAvailable(): boolean {
  const fromEnv = process.env.YOSYS;
  if (fromEnv && existsSync(fromEnv)) return true;
  if (existsSync("/tmp/oss/oss-cad-suite/bin/yosys")) return true;
  return spawnSync("yosys", ["-V"], { encoding: "utf8" }).status === 0;
}

const yosys = yosysAvailable();

describe("designs", () => {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".v"))
    .sort();
  for (const file of files) {
    it(prove.has(file) ? `proves ${file} against the Verilog` : `maps ${file}`, () => {
      const net = parseVerilog(readFileSync(join(dir, file), "utf8"));
      const report = mapDesign(net, "std", "area");
      assert.equal(report.equiv.mismatches, 0, file);
      if (!prove.has(file) || !yosys) return;
      const lec = checkEquivalence([join(dir, file)], net.name, report.verilog, STD_LIBRARY);
      assert.equal(lec.proved, true, `${file}\n${lec.text}`);
    });
  }
});
