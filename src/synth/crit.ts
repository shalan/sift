import {
  isBuffer,
  resolveLibrary,
  type Cell,
  type Library,
  type LibrarySource,
} from "./library.ts";
import { criticalSpine, type PathStep, type PatternSeed } from "./map.ts";
import type { Netlist } from "./netlist.ts";
import { coneFragment, coveredByLibrary, estimatedCell } from "./propose.ts";
import { comboCloud, flopsOf, mapDesign, type Constraints, type DesignReport } from "./seq.ts";

export interface CritStretch {
  gates: number;
  pins: number;
  ands: number;
  saved: number;
  area: number;
  delay: number;
  expr: string;
}

export interface CritReport {
  reason: "cell" | "buffer" | "adder" | "none";
  note: string;
  endpoint: string;
  slackBefore: number | null;
  slackAfter: number | null;
  delayBefore: number;
  delayAfter: number;
  stretch: CritStretch | null;
  mismatches: number;
  used: number;
  path: string[];
  mapped: DesignReport;
}

function tidy(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function nodeOf(lit: number): number {
  return lit >>> 1;
}

function slackOf(report: DesignReport): number | null {
  return report.timing ? report.timing.slack : null;
}

function endpointOf(report: DesignReport): string {
  return report.timing?.endpoint || report.path[report.path.length - 1]?.label || "";
}

function bufferDominated(library: Library, path: PathStep[]): boolean {
  const cells = new Map(library.cells.map((cell) => [cell.name, cell]));
  let buf = 0;
  let logic = 0;
  for (const step of path) {
    const cell = cells.get(step.label);
    if (!cell) continue;
    if (isBuffer(cell)) buf += Math.max(0, step.incr);
    else logic += Math.max(0, step.incr);
  }
  return buf > logic && buf > 0;
}

function adderKind(netlist: Netlist, endpoint: string): string | null {
  const q = endpoint.endsWith("/D") ? endpoint.slice(0, -2) : endpoint;
  const flop = flopsOf(netlist).find((item) => item.q === q);
  const nets = new Set([q, endpoint, ...(flop ? [flop.d] : [])]);
  for (const site of netlist.adders ?? []) {
    if (site.sums.some((bit) => nets.has(bit)) || nets.has(site.cout)) return site.kind;
  }
  return null;
}

function coneIds(
  root: number,
  stop: Set<number>,
  andBy: Map<number, { a: number; b: number }>,
): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || node === 0 || stop.has(node) || seen.has(node)) continue;
    const and = andBy.get(node);
    if (!and) continue;
    seen.add(node);
    ids.push(node);
    stack.push(nodeOf(and.a), nodeOf(and.b));
  }
  return ids;
}

interface Candidate {
  root: number;
  outputInv: boolean;
  saved: number;
  gates: number;
  pins: number[];
  ands: number;
  expr: string;
  fn: (mask: number) => 0 | 1;
  cell: Cell;
}

function bestStretch(
  netlist: Netlist,
  library: Library,
  mode: DesignReport["mode"],
): Candidate | null {
  const { graph, hops } = criticalSpine(netlist, library, mode);
  const cells = hops.filter((hop) => hop.kind === "cell");
  const andBy = new Map(graph.ands.map((and) => [and.node, { a: and.a, b: and.b }]));
  const inputs = new Set(graph.inputs.map((input) => input.node));
  let best: Candidate | null = null;

  const take = (
    ids: number[],
    top: (typeof cells)[number],
    at: Map<number, number>,
    gates: number,
  ) => {
    if (!top || ids.length < 2) return;
    const frag = coneFragment(ids, top.node, andBy);
    if (!frag || frag.ands < 2 || frag.pins.length < 2 || frag.pins.length > 8) return;
    const outputInv = top.pol === "neg";
    const fn = outputInv ? (mask: number): 0 | 1 => (frag.fn(mask) === 1 ? 0 : 1) : frag.fn;
    if (coveredByLibrary(fn, frag.pins.length, library)) return;
    const arrival = frag.pins.reduce((max, pin) => Math.max(max, at.get(pin) ?? 0), 0);
    const measured = top.arrival - arrival;
    const cell = estimatedCell(library, "crit0", frag.ands, frag.pins.length, fn);
    const saved = measured - cell.delay;
    if (!(saved > 0.05)) return;
    if (best && (saved < best.saved || (saved === best.saved && frag.ands >= best.ands))) return;
    best = {
      root: top.node,
      outputInv,
      saved,
      gates,
      pins: frag.pins,
      ands: frag.ands,
      expr: outputInv ? `~(${frag.expr})` : frag.expr,
      fn,
      cell,
    };
  };

  for (const top of cells) {
    const ids = coneIds(top.node, inputs, andBy);
    const inside = new Set(ids);
    let gates = 0;
    let armed = false;
    for (const hop of cells) {
      if (hop === top) armed = true;
      if (armed && inside.has(hop.node)) gates += 1;
    }
    take(ids, top, new Map(), Math.max(gates, 1));
  }

  for (let start = 0; start < cells.length; start += 1) {
    for (let length = 2; length <= 4 && start + length <= cells.length; length += 1) {
      const chain = cells.slice(start, start + length);
      const top = chain[0];
      if (!top) continue;
      const internal = new Set(chain.slice(1).map((hop) => hop.node));
      const stop = new Set<number>();
      const at = new Map<number, number>();
      for (const hop of chain) {
        hop.leaves.forEach((leaf, index) => {
          if (internal.has(leaf)) return;
          stop.add(leaf);
          at.set(leaf, hop.leafAt[index] ?? 0);
        });
      }
      if (stop.size < 2) continue;
      take(coneIds(top.node, stop, andBy), top, at, chain.length);
    }
  }
  return best;
}

function finish(
  reason: CritReport["reason"],
  note: string,
  before: DesignReport,
  mapped: DesignReport,
  stretch: CritStretch | null,
  used: number,
): CritReport {
  return {
    reason,
    note,
    endpoint: endpointOf(before),
    slackBefore: slackOf(before),
    slackAfter: slackOf(mapped),
    delayBefore: tidy(before.delay),
    delayAfter: tidy(mapped.delay),
    stretch,
    mismatches: mapped.equiv.mismatches,
    used,
    path: before.path.map((step) => step.label),
    mapped,
  };
}

export function critDesign(
  netlist: Netlist,
  source: LibrarySource,
  mode: DesignReport["mode"] = "delay",
  timing: number | Constraints = 10,
): CritReport {
  const library = resolveLibrary(source);
  const before = mapDesign(netlist, library, mode, timing);
  const endpoint = endpointOf(before);
  const adder = adderKind(netlist, endpoint);
  if (adder) {
    return finish(
      "adder",
      `${adder} carry is the late path; swap ripple, lookahead, and Brent-Kung instead of a new cell`,
      before,
      before,
      null,
      0,
    );
  }
  if (bufferDominated(library, before.path)) {
    return finish(
      "buffer",
      "the late path is buffers; size or buffer it, a new function will not help",
      before,
      before,
      null,
      0,
    );
  }
  const cloud = flopsOf(netlist).length === 0 ? netlist : comboCloud(netlist);
  const stretch = cloud ? bestStretch(cloud, library, mode) : null;
  if (!stretch)
    return finish(
      "none",
      "no stretch on the late path is faster as one cell",
      before,
      before,
      null,
      0,
    );
  const extended: Library = {
    ...library,
    name: `${library.name}+crit`,
    cells: [...library.cells, stretch.cell],
  };
  const seeds = new Map<number, PatternSeed[]>([
    [
      stretch.root,
      [
        {
          cell: stretch.cell.name,
          leaves: stretch.pins,
          pinInv: stretch.pins.map(() => false),
          outputInv: stretch.outputInv,
        },
      ],
    ],
  ]);
  const mapped = mapDesign(netlist, extended, mode, timing, seeds);
  const used = mapped.cells.filter((name) => name === stretch.cell.name).length;
  return finish(
    "cell",
    used > 0
      ? "one cell replaces a stretch of the late path"
      : "the cell was slower than the cover that was already there",
    before,
    used > 0 ? mapped : before,
    {
      gates: stretch.gates,
      pins: stretch.pins.length,
      ands: stretch.ands,
      saved: tidy(stretch.saved),
      area: stretch.cell.area,
      delay: stretch.cell.delay,
      expr: stretch.expr,
    },
    used,
  );
}

export function critText(report: CritReport): string {
  const lines = [
    `critical  ${report.reason}  endpoint ${report.endpoint || "(none)"}`,
    `  ${report.note}`,
  ];
  const stretch = report.stretch;
  if (stretch) {
    lines.push(
      `  crit0  ${stretch.ands} ands  ${stretch.pins} pins  ${stretch.gates} gates  saved ${stretch.saved}  area ${stretch.area}  delay ${stretch.delay}`,
    );
    lines.push(`  ${stretch.expr}`);
  }
  const slack = (value: number | null) => (value === null ? "n/a" : String(value));
  lines.push(`slack  ${slack(report.slackBefore)} -> ${slack(report.slackAfter)}`);
  lines.push(`delay  ${report.delayBefore} -> ${report.delayAfter}`);
  lines.push(report.used > 0 ? `used  crit0 x${report.used}` : "used  none");
  return lines.join("\n");
}
