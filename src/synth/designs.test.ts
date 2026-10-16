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
function yosysAvailable(): boolean {
  const fromEnv = process.env.YOSYS;
  if (fromEnv && existsSync(fromEnv)) return true;
  if (existsSync("/tmp/oss/oss-cad-suite/bin/yosys")) return true;
  return spawnSync("yosys", ["-V"], { encoding: "utf8" }).status === 0;
}

const yosys = yosysAvailable();

describe("designs", () => {
  it("finds Yosys when LEC is required", () => {
    if (process.env.SIFT_REQUIRE_LEC !== "1") return;
    assert.equal(yosys, true, "SIFT_REQUIRE_LEC is set and yosys was not found");
  });

  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".v"))
    .sort();
  for (const file of files) {
    it(`proves ${file} against the Verilog`, () => {
      const net = parseVerilog(readFileSync(join(dir, file), "utf8"));
      const report = mapDesign(net, "std", "area");
      assert.equal(report.equiv.mismatches, 0, file);
      if (!yosys) {
        assert.notEqual(process.env.SIFT_REQUIRE_LEC, "1", `${file} was not proved`);
        return;
      }
      const lec = checkEquivalence([join(dir, file)], net.name, report.verilog, STD_LIBRARY);
      assert.equal(lec.proved, true, `${file}\n${lec.text}`);
    });
  }
});
