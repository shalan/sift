import type { ArithMode } from "./arith.ts";
import { resolveLibrary, type LibrarySource } from "./library.ts";
import { DEFAULT_MAX_FANOUT, type MapMode } from "./map.ts";
import type { Netlist } from "./netlist.ts";
import { mapDesign, type Constraints, type DesignReport } from "./seq.ts";

/** `area` meets the period, then shrinks area. `delay` grows slack, then shrinks area. */
export type OptGoal = "area" | "delay";

export interface OptRecipe {
  mode: MapMode;
  arith: ArithMode;
  ppa?: number;
  gate: boolean;
  recover: boolean;
  maxFanout?: number;
}

/** A true field stays at the starting recipe. The search does not move it. */
export interface OptPins {
  mode: boolean;
  arith: boolean;
  ppa: boolean;
  gate: boolean;
  recover: boolean;
  maxFanout: boolean;
}

export interface OptTrial {
  index: number;
  recipe: OptRecipe;
  because: string;
  area: number;
  delay: number;
  cells: number;
  slack: number | null;
  holdSlack: number | null;
  met: boolean | null;
  kept: boolean;
}

export interface OptResult {
  goal: OptGoal;
  recipe: OptRecipe;
  netlist: Netlist;
  report: DesignReport;
  kept: number;
  trials: OptTrial[];
}

export interface OptRequest {
  netlist: Netlist;
  library: LibrarySource;
  goal: OptGoal;
  constraints: Constraints;
  pins: OptPins;
  recipe: OptRecipe;
  /** Rebuild the netlist for the other arithmetic. A JSON netlist has nothing to rebuild. */
  elaborate?: (arith: ArithMode) => Netlist;
  maxTrials?: number;
  onTrial?: (trial: OptTrial) => void;
}

const AREA_EPS = 0.05;
const SLACK_EPS = 0.001;

function cloneRecipe(recipe: OptRecipe): OptRecipe {
  return {
    mode: recipe.mode,
    arith: recipe.arith,
    gate: recipe.gate,
    recover: recipe.recover,
    ...(recipe.ppa !== undefined ? { ppa: recipe.ppa } : {}),
    ...(recipe.maxFanout !== undefined ? { maxFanout: recipe.maxFanout } : {}),
  };
}

function keyOf(recipe: OptRecipe): string {
  return [
    recipe.mode,
    recipe.arith,
    recipe.ppa ?? "-",
    recipe.gate ? "g" : "-",
    recipe.recover ? "r" : "-",
    recipe.maxFanout ?? "-",
  ].join("/");
}

function timingMode(library: LibrarySource): MapMode {
  const resolved = resolveLibrary(library);
  const tables =
    resolved.cells.some((cell) => cell.table !== undefined) ||
    resolved.flops.some((flop) => flop.qTable !== undefined);
  return tables ? "load" : "delay";
}

function applyRecipe(base: Constraints, recipe: OptRecipe): Constraints {
  const next: Constraints = { ...base };
  delete next.ppa;
  delete next.clockGate;
  delete next.recover;
  delete next.maxFanout;
  if (recipe.ppa !== undefined) next.ppa = recipe.ppa;
  if (recipe.gate) next.clockGate = true;
  if (recipe.recover) next.recover = true;
  if (recipe.maxFanout !== undefined) next.maxFanout = recipe.maxFanout;
  return next;
}

function allowed(recipe: OptRecipe, pins: OptPins, start: OptRecipe): boolean {
  if (pins.mode && recipe.mode !== start.mode) return false;
  if (pins.arith && recipe.arith !== start.arith) return false;
  if (pins.ppa && recipe.ppa !== start.ppa) return false;
  if (pins.gate && recipe.gate !== start.gate) return false;
  if (pins.recover && recipe.recover !== start.recover) return false;
  if (pins.maxFanout && recipe.maxFanout !== start.maxFanout) return false;
  return true;
}

function electricalOver(report: DesignReport): boolean {
  return report.over.some(
    (hit) =>
      (hit.maxFanout !== null && hit.fanout > hit.maxFanout) ||
      (hit.maxTran !== null && hit.slew !== null && hit.slew > hit.maxTran),
  );
}

function holdOk(next: DesignReport, prev: DesignReport): boolean {
  const left = next.timing;
  const right = prev.timing;
  if (!left || !right) return true;
  if (right.holdMet && left.holdSlack < -1e-9) return false;
  if (!right.holdMet && left.holdSlack < right.holdSlack - SLACK_EPS) return false;
  return true;
}

function better(next: DesignReport, prev: DesignReport, goal: OptGoal): boolean {
  if (next.equiv.mismatches > prev.equiv.mismatches) return false;
  if (!holdOk(next, prev)) return false;
  const nextMet = !next.timing || next.timing.slack >= -1e-9;
  const prevMet = !prev.timing || prev.timing.slack >= -1e-9;
  const nextSlack = next.timing?.slack ?? Number.POSITIVE_INFINITY;
  const prevSlack = prev.timing?.slack ?? Number.POSITIVE_INFINITY;
  if (goal === "area") {
    if (nextMet !== prevMet) return nextMet;
    if (nextMet && prevMet) {
      if (next.area < prev.area - AREA_EPS) return true;
      if (prev.area < next.area - AREA_EPS) return false;
      return nextSlack > prevSlack + SLACK_EPS;
    }
    if (nextSlack > prevSlack + SLACK_EPS) return true;
    if (prevSlack > nextSlack + SLACK_EPS) return false;
    return next.area < prev.area - AREA_EPS;
  }
  if (next.timing && prev.timing) {
    if (nextSlack > prevSlack + SLACK_EPS) return true;
    if (prevSlack > nextSlack + SLACK_EPS) return false;
  } else {
    if (next.delay < prev.delay - SLACK_EPS) return true;
    if (prev.delay < next.delay - SLACK_EPS) return false;
  }
  return next.area < prev.area - AREA_EPS;
}

interface Move {
  recipe: OptRecipe;
  because: string;
}

function candidates(
  best: OptRecipe,
  report: DesignReport,
  goal: OptGoal,
  pins: OptPins,
  start: OptRecipe,
  library: LibrarySource,
  netlist: Netlist,
  elaborate: boolean,
): Move[] {
  const late = report.timing !== null && report.timing.slack < -1e-9;
  const fast = goal === "delay" || late;
  const period = report.timing?.period ?? 10;
  const roomy = report.timing === null || report.timing.slack > Math.max(0.2, 0.15 * period);
  const flops = netlist.gates.some((gate) => gate.op === "DFF");
  const adders = (netlist.adders?.length ?? 0) > 0;
  const moves: Move[] = [];
  const push = (recipe: OptRecipe, because: string) => {
    if (keyOf(recipe) === keyOf(best)) return;
    if (!allowed(recipe, pins, start)) return;
    moves.push({ recipe, because });
  };
  if (fast && best.mode === "area") {
    push({ ...cloneRecipe(best), mode: timingMode(library) }, "cover for timing");
  }
  if (fast && best.arith === "area" && elaborate) {
    push({ ...cloneRecipe(best), arith: "delay" }, "faster arithmetic");
  }
  if (fast && adders && best.ppa !== 1) {
    push({ ...cloneRecipe(best), ppa: 1 }, "adder bias toward delay");
  }
  if (fast && flops && !best.gate) {
    push({ ...cloneRecipe(best), gate: true }, "clock-gate recirculating flops");
  }
  const tight = (best.maxFanout ?? DEFAULT_MAX_FANOUT) > 4 ? 4 : undefined;
  if (fast && electricalOver(report) && tight !== undefined) {
    push({ ...cloneRecipe(best), maxFanout: tight }, "tighter fanout");
  }
  if (goal === "area" && !late) {
    if (flops && !best.gate) {
      push({ ...cloneRecipe(best), gate: true }, "clock-gate recirculating flops");
    }
    // ppa only changes tuneAdders. With positive slack, a ripple site stays
    // ripple for every bias, so the trial would repeat the map and then drop it.
    const ripple =
      (report.timing?.slack ?? 0) > 0 &&
      (netlist.adders ?? []).every((site) => site.kind === "ripple");
    if (adders && best.ppa !== 0 && !ripple) {
      push({ ...cloneRecipe(best), ppa: 0 }, "adder bias toward area");
    }
    if (best.arith === "delay" && elaborate) {
      push({ ...cloneRecipe(best), arith: "area" }, "smaller arithmetic");
    }
    if (best.mode !== "area") {
      push({ ...cloneRecipe(best), mode: "area" }, "cover for area");
    }
    if (report.timing && report.timing.slack > 0.02 && !best.recover) {
      push({ ...cloneRecipe(best), recover: true }, "downsize cells that have slack");
    }
    if (best.mode !== "area" && (best.maxFanout ?? DEFAULT_MAX_FANOUT) < DEFAULT_MAX_FANOUT && roomy) {
      push({ ...cloneRecipe(best), maxFanout: DEFAULT_MAX_FANOUT }, "looser fanout");
    }
  }
  return moves;
}

function num(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return String(Math.round(value * 1000) / 1000);
}

export function recipeText(recipe: OptRecipe): string {
  const ppa = recipe.ppa === undefined ? "—" : num(recipe.ppa);
  const fanout = recipe.maxFanout === undefined ? "—" : num(recipe.maxFanout);
  return `mode ${recipe.mode}  arith ${recipe.arith}  ppa ${ppa}  gate ${recipe.gate ? "on" : "off"}  recover ${recipe.recover ? "on" : "off"}  fanout ${fanout}`;
}

export function trialLine(trial: OptTrial): string {
  const slack = trial.slack === null ? `delay ${num(trial.delay)}` : `slack ${num(trial.slack)}`;
  const mark = trial.kept ? "keep" : "drop";
  return `${String(trial.index).padStart(2)}  ${recipeText(trial.recipe)}  area ${num(trial.area)}  ${slack}  ${trial.cells} cells  ${mark}  ${trial.because}`;
}

export function optText(result: OptResult): string {
  const maps = result.trials.length === 1 ? "map" : "maps";
  const lines = [
    `opt ${result.goal}  ${result.trials.length} ${maps}`,
    ...result.trials.map((trial) => `  ${trialLine(trial)}`),
    `kept ${result.kept}  ${recipeText(result.recipe)}`,
  ];
  return lines.join("\n");
}

export function optimizeDesign(request: OptRequest): OptResult {
  const maxTrials = request.maxTrials ?? 8;
  if (!Number.isInteger(maxTrials) || maxTrials < 1) throw new Error("opt needs at least one map");
  const start = cloneRecipe(request.recipe);
  const nets = new Map<ArithMode, Netlist>();
  nets.set(start.arith, request.netlist);
  const netFor = (arith: ArithMode): Netlist => {
    const found = nets.get(arith);
    if (found) return found;
    if (!request.elaborate) throw new Error(`no netlist for arith ${arith}`);
    const built = request.elaborate(arith);
    nets.set(arith, built);
    return built;
  };
  const seen = new Set<string>();
  const trials: OptTrial[] = [];
  let recipe = start;
  let netlist = request.netlist;
  let report = mapDesign(
    netlist,
    request.library,
    recipe.mode,
    applyRecipe(request.constraints, recipe),
  );
  const trialOf = (because: string, kept: boolean): OptTrial => ({
    index: trials.length + 1,
    recipe: cloneRecipe(recipe),
    because,
    area: report.area,
    delay: report.delay,
    cells: report.cells.length,
    slack: report.timing?.slack ?? null,
    holdSlack: report.timing?.holdSlack ?? null,
    met: report.timing ? report.timing.met : null,
    kept,
  });
  const take = (because: string, kept: boolean) => {
    const trial = trialOf(because, kept);
    trials.push(trial);
    request.onTrial?.(trial);
  };
  seen.add(keyOf(recipe));
  take("baseline", true);
  let bestReport = report;
  let bestRecipe = recipe;
  let bestNet = netlist;
  let kept = 1;
  while (trials.length < maxTrials) {
    const move = candidates(
      bestRecipe,
      bestReport,
      request.goal,
      request.pins,
      start,
      request.library,
      bestNet,
      request.elaborate !== undefined,
    ).find((item) => !seen.has(keyOf(item.recipe)));
    if (!move) break;
    seen.add(keyOf(move.recipe));
    recipe = move.recipe;
    netlist = netFor(recipe.arith);
    report = mapDesign(
      netlist,
      request.library,
      recipe.mode,
      applyRecipe(request.constraints, recipe),
    );
    const keep = better(report, bestReport, request.goal);
    take(move.because, keep);
    if (!keep) continue;
    bestReport = report;
    bestRecipe = cloneRecipe(recipe);
    bestNet = netlist;
    kept = trials.length;
  }
  return {
    goal: request.goal,
    recipe: bestRecipe,
    netlist: bestNet,
    report: bestReport,
    kept,
    trials,
  };
}
