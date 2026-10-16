export type LibraryName = "min" | "std";

export type Drive = number;

export interface TimingArc {
  pin: string;
  sense: "pos" | "neg" | "non";
  table: LoadTable;
  slew?: LoadTable;
  when?: (known: ReadonlyMap<string, 0 | 1 | undefined>) => boolean;
}

export interface Cell {
  name: string;
  family: string;
  drive: Drive;
  area: number;
  delay: number;
  cap: number;
  inputs: string[];
  fn: (mask: number) => 0 | 1;
  table?: LoadTable;
  slew?: LoadTable;
  sense?: "pos" | "neg" | "non";
  arcs?: TimingArc[];
  maxCap?: number;
  maxFanout?: number;
  maxTran?: number;
  output?: string;
}

export interface LoadTable {
  slews: number[];
  loads: number[];
  rise: number[][];
  fall: number[][];
}

export function tableDelay(table: LoadTable, load: number, slew?: number): number {
  const at = slew ?? table.slews[0] ?? 0;
  return Math.max(tableEdge(table, "rise", load, at), tableEdge(table, "fall", load, at));
}

export function tableEdge(
  table: LoadTable,
  edge: "rise" | "fall",
  load: number,
  slew: number,
): number {
  const grid = edge === "rise" ? table.rise : table.fall;
  const other = edge === "rise" ? table.fall : table.rise;
  const rows = grid.length > 0 ? grid : other;
  if (rows.length === 0) return 0;
  return Math.max(0, sampleGrid(table.slews, table.loads, rows, slew, load, false));
}

/** Constraint lookup. `dataSlew` is index 2 and `clockSlew` is index 1. Negative values stand. */
export function tableCheck(
  table: LoadTable,
  edge: "rise" | "fall",
  dataSlew: number,
  clockSlew: number,
): number {
  const grid = edge === "rise" ? table.rise : table.fall;
  const other = edge === "rise" ? table.fall : table.rise;
  const rows = grid.length > 0 ? grid : other;
  if (rows.length === 0) return 0;
  return sampleGrid(table.slews, table.loads, rows, clockSlew, dataSlew, true);
}

/** Worst constraint across arcs. A library with no table keeps `fallback`. */
export function checkTime(
  tables: LoadTable[] | undefined,
  fallback: number,
  edge: "rise" | "fall",
  dataSlew: number,
  clockSlew: number,
): number {
  if (!tables || tables.length === 0) return fallback;
  let best = Number.NEGATIVE_INFINITY;
  for (const table of tables) best = Math.max(best, tableCheck(table, edge, dataSlew, clockSlew));
  return Number.isFinite(best) ? best : fallback;
}

function sampleGrid(
  slews: number[],
  loads: number[],
  grid: number[][],
  slew: number,
  load: number,
  low: boolean,
): number {
  const last = Math.min(slews.length, grid.length) - 1;
  const row = (index: number) => sample(loads, grid[index] ?? [], load, low);
  if (last <= 0) return row(0);
  const start = slews[0] ?? 0;
  if (slew <= start) {
    if (!low) return row(0);
    const next = slews[1] ?? start;
    const span = next - start;
    const slope = span === 0 ? 0 : (row(1) - row(0)) / span;
    return row(0) + slope * (slew - start);
  }
  const end = slews[last] ?? start;
  if (slew >= end) {
    const prev = slews[last - 1] ?? end;
    const span = end - prev;
    const slope = span === 0 ? 0 : (row(last) - row(last - 1)) / span;
    return row(last) + slope * (slew - end);
  }
  for (let index = 1; index <= last; index += 1) {
    const hi = slews[index] ?? 0;
    if (slew > hi) continue;
    const lo = slews[index - 1] ?? hi;
    const span = hi - lo;
    const mix = span === 0 ? 0 : (slew - lo) / span;
    return row(index - 1) + mix * (row(index) - row(index - 1));
  }
  return row(last);
}

function sample(axis: number[], row: number[], load: number, low: boolean): number {
  const last = Math.min(axis.length, row.length) - 1;
  if (last < 0) return 0;
  const start = axis[0] ?? 0;
  if (load <= start) {
    if (!low || last === 0) return row[0] ?? 0;
    const next = axis[1] ?? start;
    const span = next - start;
    const slope = span === 0 ? 0 : ((row[1] ?? 0) - (row[0] ?? 0)) / span;
    return (row[0] ?? 0) + slope * (load - start);
  }
  const end = axis[last] ?? start;
  if (load >= end) {
    if (last === 0) return row[0] ?? 0;
    const span = end - (axis[last - 1] ?? end);
    const slope = span === 0 ? 0 : ((row[last] ?? 0) - (row[last - 1] ?? 0)) / span;
    return (row[last] ?? 0) + slope * (load - end);
  }
  for (let index = 1; index <= last; index += 1) {
    const hi = axis[index] ?? 0;
    if (load > hi) continue;
    const lo = axis[index - 1] ?? hi;
    const span = hi - lo;
    const mix = span === 0 ? 0 : (load - lo) / span;
    return (row[index - 1] ?? 0) + mix * ((row[index] ?? 0) - (row[index - 1] ?? 0));
  }
  return row[last] ?? 0;
}

function bit(mask: number, index: number): 0 | 1 {
  return ((mask >> index) & 1) === 1 ? 1 : 0;
}

function unit(family: string, area: number, delay: number, inputs: string[], fn: Cell["fn"]): Cell {
  return { name: family, family, drive: 1, area, delay, cap: 1, inputs, fn };
}

function drives(cell: Cell): Cell[] {
  return ([1, 2, 4] as const).map((drive) => ({
    ...cell,
    name: `${cell.family}_${drive}`,
    drive,
    area: cell.area * drive,
    cap: drive,
  }));
}

const INV = unit("INV", 1, 1, ["a"], (mask) => (bit(mask, 0) === 0 ? 1 : 0));
const BUF = unit("BUF", 1, 1, ["a"], (mask) => bit(mask, 0));
const NAND2 = unit("NAND2", 2, 2, ["a", "b"], (mask) => (bit(mask, 0) & bit(mask, 1) ? 0 : 1));
const NOR2 = unit("NOR2", 2, 2, ["a", "b"], (mask) => (bit(mask, 0) | bit(mask, 1) ? 0 : 1));
const NAND3 = unit("NAND3", 3, 2, ["a", "b", "c"], (mask) =>
  bit(mask, 0) & bit(mask, 1) & bit(mask, 2) ? 0 : 1,
);
const NAND4 = unit("NAND4", 6, 2, ["a", "b", "c", "d"], (mask) =>
  bit(mask, 0) & bit(mask, 1) & bit(mask, 2) & bit(mask, 3) ? 0 : 1,
);
const AOI21 = unit("AOI21", 3, 2, ["a", "b", "c"], (mask) =>
  (bit(mask, 0) & bit(mask, 1)) | bit(mask, 2) ? 0 : 1,
);
const OAI21 = unit("OAI21", 3, 2, ["a", "b", "c"], (mask) =>
  (bit(mask, 0) | bit(mask, 1)) & bit(mask, 2) ? 0 : 1,
);
const XOR2 = unit("XOR2", 4, 4, ["a", "b"], (mask) => (bit(mask, 0) ^ bit(mask, 1) ? 1 : 0));
const MUX2 = unit("MUX2", 4, 3, ["s", "a", "b"], (mask) =>
  bit(mask, 0) === 1 ? bit(mask, 1) : bit(mask, 2),
);

export interface FlopPins {
  q: string;
  d: string;
  clk?: string;
  en?: string;
  enLevel?: 0 | 1;
  clear?: string;
  clearLevel?: 0 | 1;
  preset?: string;
  presetLevel?: 0 | 1;
}

export interface FlopCell {
  name: string;
  family: string;
  drive: Drive;
  area: number;
  clkToQ: number;
  setup: number;
  qTable?: LoadTable;
  qSlew?: LoadTable;
  maxCap?: number;
  maxFanout?: number;
  maxTran?: number;
  clockCap?: number;
  /** Async clear-pin capacitance. Used to size the reset net. */
  clearCap?: number;
  /** Async preset-pin capacitance. Used to size the preset net. */
  presetCap?: number;
  hold?: number;
  /** Setup arcs. Index 1 is the related pin slew, index 2 the constrained pin slew. */
  setupArcs?: LoadTable[];
  /** Hold arcs, on the same axes as `setupArcs`. */
  holdArcs?: LoadTable[];
  seq?: FlopPins;
}

function flopFamily(
  family: string,
  area: number,
  clkToQ: number,
  setup: number,
  sized: boolean,
): FlopCell[] {
  const drives: Drive[] = sized ? [1, 2, 4] : [1];
  return drives.map((drive) => ({
    name: sized ? `${family}_${drive}` : family,
    family,
    drive,
    area: area * drive,
    clkToQ: Math.round((clkToQ / drive) * 1000) / 1000,
    setup,
  }));
}

export interface WireLoad {
  name: string;
  capacitance: number;
  resistance: number;
  slope: number;
  fanouts: { fanout: number; length: number }[];
}

export function wireOf(model: WireLoad, fanout: number): { cap: number; res: number } {
  const length = wireLength(model, fanout);
  return { cap: length * model.capacitance, res: length * model.resistance };
}

function wireLength(model: WireLoad, fanout: number): number {
  const rows = [...model.fanouts].sort((left, right) => left.fanout - right.fanout);
  const first = rows[0];
  if (!first) return 0;
  if (fanout <= first.fanout) return first.length;
  const last = rows[rows.length - 1] ?? first;
  if (fanout >= last.fanout) return last.length + model.slope * (fanout - last.fanout);
  for (let index = 1; index < rows.length; index += 1) {
    const hi = rows[index];
    if (!hi || fanout > hi.fanout) continue;
    const lo = rows[index - 1] ?? hi;
    const span = hi.fanout - lo.fanout;
    const mix = span === 0 ? 0 : (fanout - lo.fanout) / span;
    return lo.length + mix * (hi.length - lo.length);
  }
  return last.length;
}

export interface Library {
  name: string;
  cells: Cell[];
  flops: FlopCell[];
  wireLoads?: WireLoad[];
  defaultWireLoad?: string;
}

export type LibrarySource = LibraryName | Library;

export function libraryByName(name: LibraryName): Library {
  return name === "min" ? MIN_LIBRARY : STD_LIBRARY;
}

export function resolveLibrary(source: LibrarySource): Library {
  return typeof source === "string" ? libraryByName(source) : source;
}

export function isInverter(cell: Cell): boolean {
  return cell.inputs.length === 1 && cell.fn(0) === 1 && cell.fn(1) === 0;
}

export function isBuffer(cell: Cell): boolean {
  return cell.inputs.length === 1 && cell.fn(0) === 0 && cell.fn(1) === 1;
}

export function byArea<T extends { area: number; name: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (left, right) => left.area - right.area || left.name.localeCompare(right.name),
  );
}

export function pickByFanout<T>(options: readonly T[], fanout: number): T | undefined {
  if (options.length === 0) return undefined;
  if (fanout >= 4) return options[options.length - 1];
  if (fanout >= 2) return options[Math.min(options.length - 1, Math.floor(options.length / 2))];
  return options[0];
}

export function portCap(library: Library): number {
  if (!library.cells.some((cell) => cell.table)) return 1;
  const inv = byArea(library.cells.filter(isInverter))[0];
  return inv && inv.cap > 0 ? inv.cap : 1;
}

export function inverterOf(library: Library): Cell {
  const inv = byArea(library.cells.filter(isInverter))[0];
  if (!inv) throw new Error(`${library.name} has no inverter`);
  return inv;
}

export function baseCells(library: Library): Cell[] {
  const best = new Map<string, Cell>();
  for (const cell of library.cells) {
    if (isInverter(cell) || isBuffer(cell)) continue;
    const current = best.get(cell.family);
    if (
      !current ||
      cell.area < current.area ||
      (cell.area === current.area && cell.name < current.name)
    ) {
      best.set(cell.family, cell);
    }
  }
  return [...best.values()];
}

const MIN_FLOPS = [
  ...flopFamily("DFF", 6, 2, 1, false),
  ...flopFamily("ADFF", 8, 2, 1, false),
  ...flopFamily("LATCH", 5, 0, 0, false),
];
const STD_FLOPS = [
  ...flopFamily("DFF", 6, 2, 1, true),
  ...flopFamily("ADFF", 8, 2, 1, true),
  ...flopFamily("LATCH", 5, 0, 0, false),
];

export const MIN_LIBRARY: Library = { name: "min", cells: [INV, NAND2, NOR2], flops: MIN_FLOPS };
export const STD_LIBRARY: Library = {
  name: "std",
  cells: [INV, BUF, NAND2, NOR2, NAND3, NAND4, AOI21, OAI21, XOR2, MUX2].flatMap(drives),
  flops: STD_FLOPS,
};
