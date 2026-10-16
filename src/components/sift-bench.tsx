import { useEffect, useMemo, useState } from "react";
import { shrink, type ShrinkReport } from "@/synth/aig";
import { insertClockGates } from "@/synth/clkgate";
import { EXAMPLES, VERILOG, formatNetlist } from "@/synth/examples";
import { SAMPLE_LIBERTY, parseLiberty } from "@/synth/liberty";
import { sky130Hd } from "@/synth/sky130hd";
import { resolveLibrary, type LibrarySource } from "@/synth/library";
import type { MapMode } from "@/synth/map";
import {
  comboCloud,
  DEFAULT_MAX_FANOUT,
  DEFAULT_PERIOD,
  mapDesign,
  type Constraints,
  type DesignReport,
} from "@/synth/seq";
import { loadDesign, looksLikeVerilog } from "@/synth/verilog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const INITIAL = EXAMPLES.find((example) => example.id === "and4") ?? EXAMPLES[0];

const UART = VERILOG.find((example) => example.id === "uart.v");

export function SiftBench() {
  const [text, setText] = useState(UART?.source ?? formatNetlist(INITIAL.netlist));
  const [selected, setSelected] = useState(UART?.id ?? INITIAL.id);
  const [lib, setLib] = useState<"std" | "min" | "sky130" | "file">("sky130");
  const [libText, setLibText] = useState(SAMPLE_LIBERTY);
  const [mode, setMode] = useState<MapMode>("load");
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [inputSlew, setInputSlew] = useState("");
  const [outputLoad, setOutputLoad] = useState("");
  const [inputDelay, setInputDelay] = useState("0");
  const [outputDelay, setOutputDelay] = useState("0");
  const [maxFanout, setMaxFanout] = useState(String(DEFAULT_MAX_FANOUT));
  const [clockSlew, setClockSlew] = useState("");
  const [wireLoad, setWireLoad] = useState("");
  const [capPerFanout, setCapPerFanout] = useState("");
  const [ports, setPorts] = useState("");
  const [recover, setRecover] = useState(false);
  const [clockGate, setClockGate] = useState(false);
  const [live, setLive] = useState(false);

  useEffect(() => {
    setLive(true);
  }, []);

  const verilog = looksLikeVerilog(text);

  const result = useMemo(() => {
    if (!live) return { ok: true as const, pending: true as const };
    try {
      const source: LibrarySource =
        lib === "file" ? parseLiberty(libText) : lib === "sky130" ? sky130Hd() : lib;
      const arith = mode === "load" ? "delay" : mode;
      let netlist = loadDesign(text, arith);
      if (clockGate) {
        netlist = insertClockGates(netlist, resolveLibrary(source), mode) ?? {
          ...netlist,
          clockGates: [],
        };
      }
      const cloud = comboCloud(
        netlist,
        (netlist.clockGates ?? []).map((gate) => gate.en),
      );
      const report = cloud && cloud.gates.length > 0 ? shrink(cloud, mode) : null;
      const constraints: Constraints = {
        period,
        inputDelay: numberOr(inputDelay, 0),
        outputDelay: numberOr(outputDelay, 0),
        maxFanout: Math.max(1, numberOr(maxFanout, DEFAULT_MAX_FANOUT)),
        wireLoad: wireLoad.trim(),
        ports: parsePorts(ports),
      };
      const slew = optionalNumber(inputSlew);
      const load = optionalNumber(outputLoad);
      const clock = optionalNumber(clockSlew);
      const perFanout = optionalNumber(capPerFanout);
      if (slew !== undefined) constraints.inputTransition = slew;
      if (load !== undefined) constraints.outputLoad = load;
      if (clock !== undefined) constraints.clockTransition = clock;
      if (perFanout !== undefined) constraints.capPerFanout = perFanout;
      if (recover) constraints.recover = true;
      if (clockGate) constraints.clockGate = true;
      return {
        ok: true as const,
        pending: false as const,
        netlist,
        report,
        mapped: mapDesign(netlist, source, mode, constraints),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bad design";
      return { ok: false as const, message };
    }
  }, [
    live,
    text,
    lib,
    libText,
    mode,
    period,
    inputSlew,
    outputLoad,
    inputDelay,
    outputDelay,
    maxFanout,
    clockSlew,
    wireLoad,
    capPerFanout,
    ports,
    recover,
    clockGate,
  ]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <img src="/logo.svg" alt="" width={44} height={44} className="size-11 rounded-lg" />
              <div>
                <p className="font-mono text-xs tracking-widest text-accent">SIFT</p>
                <h1 className="text-2xl font-medium">Synthesize and map</h1>
              </div>
            </div>
            <a
              href="https://github.com/shalan/sift"
              className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink"
            >
              Source
            </a>
          </div>
          <p className="max-w-2xl text-muted">
            Verilog <span className="font-mono">assign</span> and{" "}
            <span className="font-mono">posedge</span> flops lower to gates. A constant{" "}
            <span className="font-mono">for</span> unrolls.{" "}
            <span className="font-mono">a[i +: 8]</span> is a moving slice.{" "}
            <span className="font-mono">generate</span> unrolls instances.{" "}
            <span className="font-mono">!</span>, <span className="font-mono">&&</span>,{" "}
            <span className="font-mono">||</span>, and a reduction such as{" "}
            <span className="font-mono">&a</span> are one bit. The std library has drive{" "}
            <span className="font-mono">_1</span>, <span className="font-mono">_2</span>, and{" "}
            <span className="font-mono">_4</span>, plus buffers. Area stays at{" "}
            <span className="font-mono">_1</span>. A <span className="font-mono">.lib</span> file is
            a standard-cell Liberty library: the mapper reads area, the pin function, pin
            capacitance, and the NLDM delay table. Delay and load keep a net inside the driving
            cell's max capacitance and max fanout, by upsizing or buffering. Fanout is the sum of
            the load sizes divided by the driver size. A pin that omits max fanout uses the max
            fanout field, which defaults to four, including when the library gives neither limit.
            Max transition is the pin attribute, or the last characterized slew when the attribute
            was left out. Capacitance per fanout adds that load on every sink. When it is set, it
            replaces a wire-load model. Sky130 HD has no wire-load model, so leave the field empty
            for pin capacitance only. For Sky130 the number is in pF. A gate is timed at the slew
            coming out of the gate that drives it. A pin with several arcs, including a conditional{" "}
            <span className="font-mono">when</span>, uses the slowest arc that can be true. Rise and
            fall are separate paths. Sky130 HD is that library at tt 1.8 V, reduced to the cells
            used here.
          </p>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap gap-2">
          {(["area", "delay", "load"] as const).map((name) => (
            <Button
              key={name}
              variant={mode === name ? "solid" : "ghost"}
              onClick={() => setMode(name)}
            >
              {name === "area" ? "area mode" : name === "delay" ? "delay mode" : "load mode"}
            </Button>
          ))}
          <Button variant={recover ? "solid" : "ghost"} onClick={() => setRecover((on) => !on)}>
            recover area
          </Button>
          <Button variant={clockGate ? "solid" : "ghost"} onClick={() => setClockGate((on) => !on)}>
            clock gate
          </Button>
          {(["std", "min", "sky130", "file"] as const).map((name) => (
            <Button
              key={name}
              variant={lib === name ? "solid" : "ghost"}
              onClick={() => setLib(name)}
            >
              {name === "std"
                ? "std library"
                : name === "min"
                  ? "min library"
                  : name === "sky130"
                    ? "sky130 HD"
                    : ".lib file"}
            </Button>
          ))}
          <NumberField
            label="period"
            value={String(period)}
            placeholder="10"
            onChange={(value) => setPeriod(numberOr(value, period))}
          />
          <NumberField
            label="input slew"
            value={inputSlew}
            placeholder="lib"
            onChange={setInputSlew}
          />
          <NumberField
            label="output load"
            value={outputLoad}
            placeholder="inv"
            onChange={setOutputLoad}
          />
          <NumberField
            label="input delay"
            value={inputDelay}
            placeholder="0"
            onChange={setInputDelay}
          />
          <NumberField
            label="output delay"
            value={outputDelay}
            placeholder="0"
            onChange={setOutputDelay}
          />
          <NumberField
            label="max fanout"
            value={maxFanout}
            placeholder={String(DEFAULT_MAX_FANOUT)}
            onChange={setMaxFanout}
          />
          <NumberField
            label="clock slew"
            value={clockSlew}
            placeholder="lib"
            onChange={setClockSlew}
          />
          <NumberField
            label="cap / fanout"
            value={capPerFanout}
            placeholder="0"
            onChange={setCapPerFanout}
          />
          <label className="flex items-center gap-2 font-mono text-sm text-muted">
            wire load
            <input
              value={wireLoad}
              placeholder="library"
              aria-label="wire load"
              onChange={(event) => setWireLoad(event.target.value)}
              className="w-28 rounded-lg border border-border bg-surface px-2 py-1 text-foreground"
            />
          </label>
          <label className="flex w-full min-w-0 items-center gap-2 font-mono text-sm text-muted">
            ports
            <input
              value={ports}
              placeholder="y load=0.01"
              aria-label="port constraints"
              onChange={(event) => setPorts(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-foreground"
            />
          </label>
        </div>
        {lib === "file" ? (
          <section className="flex min-w-0 flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-medium">Liberty</h2>
              <p className="font-mono text-xs text-muted">area function capacitance delay ff</p>
            </div>
            <label className="sr-only" htmlFor="liberty">
              Liberty library
            </label>
            <textarea
              id="liberty"
              value={libText}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setLibText(event.target.value)}
              className="min-h-40 w-full resize-y rounded-lg border border-border bg-surface p-4 font-mono text-sm leading-relaxed text-foreground"
            />
            <p className="text-sm text-muted">
              Paste a standard-cell Liberty file, NLDM or the same tables with intrinsic delays.
              Delay is the table looked up at the real pin capacitance. Bus pins and statetable
              cells are skipped.
            </p>
          </section>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <Button
              key={example.id}
              variant={selected === example.id ? "solid" : "ghost"}
              onClick={() => {
                setSelected(example.id);
                setText(formatNetlist(example.netlist));
              }}
            >
              {example.id}
            </Button>
          ))}
          {VERILOG.map((example) => (
            <Button
              key={example.id}
              variant={selected === example.id ? "solid" : "ghost"}
              onClick={() => {
                setSelected(example.id);
                setText(example.source);
              }}
            >
              {example.id}
            </Button>
          ))}
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-medium">{verilog ? "Verilog" : "Netlist"}</h2>
              <p className="font-mono text-xs text-muted">
                {verilog ? "assign  always" : "INV AND OR XOR MUX DFF"}
              </p>
            </div>
            <label className="sr-only" htmlFor="netlist">
              {verilog ? "Verilog source" : "Netlist JSON"}
            </label>
            <textarea
              id="netlist"
              value={text}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => {
                setSelected("");
                setText(event.target.value);
              }}
              className="min-h-48 w-full resize-y rounded-lg border border-border bg-surface p-4 font-mono text-sm leading-relaxed text-foreground"
            />
            <p className="text-sm text-muted">
              {verilog
                ? "Up to 32 bits. Area uses a ripple adder, an array multiplier, and a restoring divider. Delay uses a Brent-Kung adder, a Wallace tree, and an array divider. >>> sign-fills a signed value. A reg array is flops, and a bare if on a reg warns."
                : "MUX sel a b means sel ? a : b. DFF d is a register; q updates from d on clk. Constants 0 and 1 are nets."}
            </p>
            {result.ok && !result.pending && verilog ? (
              <Elaborated gates={result.netlist.gates} />
            ) : null}
          </section>

          <section className="flex min-w-0 flex-col gap-4">
            {!result.ok ? (
              <Fault message={result.message} />
            ) : result.pending ? (
              <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
                Mapping the netlist.
              </p>
            ) : (
              <>
                <LatchWarning warnings={result.netlist.warnings ?? []} />
                <Report
                  report={result.report}
                  mapped={result.mapped}
                  blurb={blurbFor(selected)}
                  notes={result.netlist.notes ?? []}
                />
                <Verilog mapped={result.mapped} />
                {result.report ? <AigView report={result.report} /> : null}
                <Truth mapped={result.mapped} />
              </>
            )}
          </section>
        </div>

        <p className="text-sm text-muted">
          A DFF updates on clk. An ADFF clears while rst is high, without waiting for the clock. A
          LATCH is transparent while its enable is high.
        </p>
      </main>
    </div>
  );
}

function blurbFor(id: string): string | undefined {
  return (
    EXAMPLES.find((example) => example.id === id)?.blurb ??
    VERILOG.find((example) => example.id === id)?.blurb
  );
}

function Elaborated({ gates }: { gates: { id: string; op: string; ins: string[] }[] }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-lg font-medium">Elaborated gates</h2>
      <p className="mt-1 text-sm text-muted">
        The Verilog, lowered. Mapping starts from this netlist.
      </p>
      <pre className="mt-4 overflow-x-auto font-mono text-sm leading-relaxed text-foreground">
        {gates.map((gate) => `${gate.id} = ${gate.op} ${gate.ins.join(", ")}`).join("\n")}
      </pre>
    </section>
  );
}

function LatchWarning({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div role="status" className="rounded-lg border border-accent bg-surface p-4">
      <h2 className="text-lg font-medium text-accent">Latch inferred</h2>
      <ul className="mt-2 flex flex-col gap-1 font-mono text-sm text-foreground">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

function Fault({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-lg border border-fault bg-surface p-4 text-fault">
      <h2 className="text-lg font-medium text-foreground">This design does not load</h2>
      <p className="mt-2 font-mono text-sm">{message}</p>
    </div>
  );
}

function Report({
  report,
  mapped,
  blurb,
  notes,
}: {
  report: ShrinkReport | null;
  mapped: DesignReport;
  blurb?: string;
  notes: string[];
}) {
  const matched = mapped.equiv.mismatches === 0;
  const shrinkNotes = report ? notesFor(report) : [];
  return (
    <div className="flex flex-col gap-4">
      <div
        role="status"
        className={cn(
          "rounded-lg border bg-surface p-4",
          matched ? "border-accent" : "border-fault",
        )}
      >
        <p className={cn("font-medium", matched ? "text-accent" : "text-fault")}>
          {matched
            ? `Outputs match · area ${mapped.area} · delay ${mapped.delay}`
            : `${mapped.equiv.mismatches} vectors differ`}
        </p>
        <p className="mt-1 text-sm text-muted">
          {mapped.mode} mode, {mapped.library} library,{" "}
          {mapped.equiv.exhaustive ? "exhaustive" : "sampled"}, {mapped.equiv.vectors} vectors
          {blurb ? `. ${blurb}` : ""}
        </p>
        {notes.length > 0 ? (
          <p className="mt-2 font-mono text-sm text-foreground">{notes.join(" · ")}</p>
        ) : null}
        {mapped.timing ? (
          <p
            className={cn(
              "mt-2 font-mono text-sm",
              mapped.timing.constrained && mapped.timing.met
                ? "text-accent"
                : mapped.timing.constrained
                  ? "text-fault"
                  : "text-muted",
            )}
          >
            {mapped.timing.constrained
              ? `${mapped.timing.met ? "meets" : "misses"} · slack ${mapped.timing.slack} · ${mapped.timing.edge} · period ${mapped.timing.period}${mapped.timing.inputDelay > 0 ? ` · input delay ${mapped.timing.inputDelay}` : ""}${mapped.timing.setup > 0 ? ` − setup ${mapped.timing.setup}` : ""}${mapped.timing.outputDelay > 0 ? ` − output delay ${mapped.timing.outputDelay}` : ""} − arrival ${mapped.timing.arrival} at ${mapped.timing.endpoint} · clock ideal${mapped.timing.setupUncertainty > 0 ? ` · uncertainty ${mapped.timing.setupUncertainty}` : ""}${mapped.timing.setupCycles === 0.5 ? " · half-cycle" : mapped.timing.setupCycles > 1 ? ` · cycles ${mapped.timing.setupCycles}` : ""}`
              : "no constrained path · clock ideal"}
          </p>
        ) : null}
        {mapped.timing ? (
          <p
            className={cn(
              "mt-2 font-mono text-sm",
              mapped.timing.holdConstrained && !mapped.timing.holdMet ? "text-fault" : "text-muted",
            )}
          >
            {mapped.timing.holdConstrained
              ? `${mapped.timing.holdMet ? "hold met" : "hold missed"} · slack ${mapped.timing.holdSlack} · hold ${mapped.timing.hold} at ${mapped.timing.holdEndpoint}${mapped.timing.holdUncertainty > 0 ? ` · uncertainty ${mapped.timing.holdUncertainty}` : ""}${mapped.timing.holdCycles > 0 ? ` · cycles ${mapped.timing.holdCycles}` : ""}`
              : "no hold path"}
            {mapped.timing.wireLoad !== "none" ? ` · wire ${mapped.timing.wireLoad}` : ""}
          </p>
        ) : null}
        {mapped.recovery ? (
          <p className="mt-2 font-mono text-sm text-muted">
            recovered {mapped.recovery.before} to {mapped.recovery.after} · slack{" "}
            {mapped.recovery.slackBefore} to {mapped.recovery.slackAfter} · {mapped.recovery.steps}{" "}
            {mapped.recovery.steps === 1 ? "swap" : "swaps"}
          </p>
        ) : null}
        {mapped.clockGates ? (
          <p className="mt-2 font-mono text-sm text-muted">
            {mapped.clockGates.length === 0
              ? "clock gate · none"
              : mapped.clockGates
                  .map(
                    (gate) =>
                      `clock gate ${gate.id} · ${gate.level === 1 ? "high" : "low"} ${gate.en} · ${gate.flops.join(" ")}`,
                  )
                  .join(" · ")}
          </p>
        ) : null}
        {mapped.limited ? (
          <p
            className={cn(
              "mt-2 font-mono text-sm",
              mapped.over.length > 0 ? "text-fault" : "text-muted",
            )}
          >
            {mapped.over.length > 0
              ? `${mapped.over.length} nets over max capacitance, max fanout, or max transition`
              : "every net is within max capacitance, max fanout, and max transition"}
          </p>
        ) : null}
      </div>
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-6">
        <Stat label="Area" value={String(mapped.area)} />
        <Stat label="Delay" value={String(mapped.delay)} />
        <Stat label="Cells" value={String(mapped.cells.length)} />
        <Stat label="Strash" value={String(report?.strashHits ?? 0)} />
        <Stat label="Folds" value={String(report?.folds ?? 0)} />
        <Stat label="State" value={String(mapped.registers)} />
      </dl>
      <p className="overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground">
        {mapped.cells.join(" · ") || "no cells"}
      </p>
      {mapped.risePath.length > 0 || mapped.fallPath.length > 0 ? <Timing mapped={mapped} /> : null}
      {shrinkNotes.length > 0 ? (
        <ul className="flex flex-col gap-2 text-sm text-muted">
          {shrinkNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Timing({ mapped }: { mapped: DesignReport }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-lg font-medium">Timing</h2>
      <p className="mt-1 text-sm text-muted">
        {mapped.library}
        {mapped.library.startsWith("sky130")
          ? " · nanoseconds, from the NLDM tables"
          : " · library time unit"}
        .
        {mapped.timing
          ? ` ${mapped.timing.edge} to ${mapped.timing.endpoint}.`
          : " Critical endpoint."}
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <PathTable title="Rise" path={mapped.risePath} />
        <PathTable title="Fall" path={mapped.fallPath} />
      </div>
    </section>
  );
}

function PathTable({ title, path }: { title: string; path: DesignReport["path"] }) {
  return (
    <div className="overflow-x-auto">
      <h3 className="font-mono text-xs tracking-widest text-muted">{title}</h3>
      <table className="mt-2 w-full border-collapse font-mono text-sm tabular-nums">
        <thead>
          <tr className="text-left text-muted">
            <th className="px-2 py-2 font-medium">Stage</th>
            <th className="px-2 py-2 font-medium">Incr</th>
            <th className="px-2 py-2 font-medium">Arrival</th>
            <th className="px-2 py-2 font-medium">Slew</th>
          </tr>
        </thead>
        <tbody>
          {path.map((step, index) => (
            <tr key={`${step.label}-${index}`} className="border-t border-border">
              <td className="px-2 py-1">{step.label.replace(/^sky130_fd_sc_hd__/, "")}</td>
              <td className="px-2 py-1">{step.incr.toFixed(3)}</td>
              <td className="px-2 py-1">{step.at.toFixed(3)}</td>
              <td className="px-2 py-1">{step.slew.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NumberField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 font-mono text-sm text-muted">
      {label}
      <input
        type="number"
        min={0}
        step="any"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        className="w-20 rounded-lg border border-border bg-surface px-2 py-1 text-foreground"
      />
    </label>
  );
}

function parsePorts(
  text: string,
): Record<string, { slew?: number; load?: number; delay?: number }> {
  const ports: Record<string, { slew?: number; load?: number; delay?: number }> = {};
  for (const part of text.split(/[;\n]+/)) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    const name = bits[0];
    if (!name) continue;
    const spec: { slew?: number; load?: number; delay?: number } = {};
    for (const bit of bits.slice(1)) {
      const [key, raw] = bit.split("=");
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) continue;
      if (key === "slew") spec.slew = value;
      if (key === "load") spec.load = value;
      if (key === "delay") spec.delay = value;
    }
    ports[name] = spec;
  }
  return ports;
}

function optionalNumber(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function numberOr(text: string, fallback: number): number {
  return optionalNumber(text) ?? fallback;
}

function notesFor(report: ShrinkReport): string[] {
  const notes: string[] = [];
  if (report.strashHits > 0) {
    notes.push(
      `${report.strashHits} repeated ${report.strashHits === 1 ? "cone" : "cones"} reused an existing AND.`,
    );
  }
  if (report.folds > 0) {
    notes.push(
      `${report.folds} trivial AND ${report.folds === 1 ? "identity was" : "identities were"} folded.`,
    );
  }
  if (report.opt.rewrite > 0) {
    notes.push(
      `Rewrite removed ${report.opt.rewrite} AND ${report.opt.rewrite === 1 ? "node" : "nodes"}.`,
    );
  }
  if (report.opt.balance > 0) {
    notes.push(
      `Balanced ${report.opt.balance} AND ${report.opt.balance === 1 ? "tree" : "trees"}.`,
    );
  }
  if (report.opt.sweep > 0) {
    notes.push(
      `Functional sweep removed ${report.opt.sweep} AND ${report.opt.sweep === 1 ? "node" : "nodes"}.`,
    );
  }
  if (report.opt.refactor > 0) {
    notes.push(
      `Refactor removed ${report.opt.refactor} AND ${report.opt.refactor === 1 ? "node" : "nodes"}.`,
    );
  }
  if (report.constOutputs.length > 0) {
    notes.push(
      report.constOutputs.map((item) => `${item.name} is constant ${item.value}`).join(", ") + ".",
    );
  }
  if (report.deadGates.length > 0) {
    notes.push(`Swept ${report.deadGates.join(", ")}. Nothing readable reaches them.`);
  }
  return notes;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-2 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-mono text-lg tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function AigView({ report }: { report: ShrinkReport }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-lg font-medium">AND-inverter graph</h2>
      <p className="mt-1 text-sm text-muted">~ is an inverted edge. There is no inverter gate.</p>
      <pre className="mt-4 overflow-x-auto font-mono text-sm leading-relaxed text-foreground">
        {renderAig(report)}
      </pre>
    </section>
  );
}

function renderAig(report: ShrinkReport): string {
  const lines = [`inputs ${report.aig.inputs.join(" ") || "—"}`];
  for (const node of report.aig.nodes) lines.push(`${node.id} = ${node.expr}`);
  if (report.aig.nodes.length === 0) lines.push("no AND nodes");
  for (const output of report.aig.outputs) lines.push(`${output.name} = ${output.expr}`);
  return lines.join("\n");
}

function Verilog({ mapped }: { mapped: DesignReport }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-lg font-medium">Mapped netlist</h2>
      <p className="mt-1 text-sm text-muted">
        Structural Verilog. Area is the sum of the cells, each counted once.
      </p>
      <pre className="mt-4 overflow-x-auto font-mono text-sm leading-relaxed text-foreground">
        {mapped.verilog}
      </pre>
    </section>
  );
}

function Cycles({ mapped }: { mapped: DesignReport }) {
  const outputs = mapped.cycles[0]?.outputs.map((output) => output.name) ?? [];
  const inputs = mapped.cycles[0]?.inputs.map((input) => input.name) ?? [];
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-lg font-medium">Clock</h2>
      <p className="mt-1 text-sm text-muted">
        Registers start at 0. rst is high for the first two clocks and again on clock 6. Synchronous
        reset clears on the next row. Asynchronous reset clears in that same row.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse font-mono text-sm tabular-nums">
          <thead>
            <tr className="text-left text-muted">
              <th className="px-2 py-2 font-medium">clk</th>
              {inputs.map((name) => (
                <th key={name} className="px-2 py-2 font-medium">
                  {name}
                </th>
              ))}
              {outputs.map((name) => (
                <th key={name} className="px-2 py-2 font-medium">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mapped.cycles.map((row) => (
              <tr key={row.cycle} className={cn(!row.match && "text-fault")}>
                <td className="px-2 py-1">{row.cycle}</td>
                {row.inputs.map((input) => (
                  <td key={input.name} className="px-2 py-1">
                    {input.value}
                  </td>
                ))}
                {row.outputs.map((output) => (
                  <td key={output.name} className="px-2 py-1">
                    {row.match ? output.net : `${output.net}/${output.mapped}`}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Truth({ mapped }: { mapped: DesignReport }) {
  if (mapped.cycles.length > 0) return <Cycles mapped={mapped} />;
  const outputs = mapped.equiv.rows[0]?.outputs.map((output) => output.name) ?? [];
  const inputs = mapped.equiv.rows[0]?.inputs.map((input) => input.name) ?? [];
  const hidden = mapped.equiv.vectors - mapped.equiv.rows.length;
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-lg font-medium">Simulation</h2>
      <p className="mt-1 text-sm text-muted">Original netlist against the mapped cells.</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse font-mono text-sm tabular-nums">
          <thead>
            <tr className="text-left text-muted">
              {inputs.map((name) => (
                <th key={name} className="px-2 py-2 font-medium">
                  {name}
                </th>
              ))}
              {outputs.map((name) => (
                <th key={name} className="px-2 py-2 font-medium">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mapped.equiv.rows.map((row, index) => (
              <tr key={index} className={cn(!row.match && "text-fault")}>
                {row.inputs.map((input) => (
                  <td key={input.name} className="px-2 py-1">
                    {input.value}
                  </td>
                ))}
                {row.outputs.map((output) => (
                  <td key={output.name} className="px-2 py-1">
                    {row.match ? output.net : `${output.net}/${output.mapped}`}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 ? (
        <p className="mt-3 text-sm text-muted">{hidden} more vectors not listed.</p>
      ) : null}
    </section>
  );
}
