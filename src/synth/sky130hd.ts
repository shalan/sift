import { parseLiberty } from "./liberty.ts";
import type { Library } from "./library.ts";
import { SKY130_HD } from "./sky130hd.lib.ts";

let cached: Library | undefined;

export function sky130Hd(): Library {
  cached ??= parseLiberty(SKY130_HD);
  return cached;
}
