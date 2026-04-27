import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  getAccumulatorBuilder,
  type AccumulatorLeg,
  type AccumulatorResponse,
  type CoachMarket,
} from "@/server/football.functions";
import { addBet, getBankroll, type BankrollSettings } from "@/lib/football/bankroll";
import {
  Layers,
  Loader2,
  Receipt,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/accumulator")({
  head: () => ({
    meta: [
      { title: "AI accumulator builder · Pitchcast" },
      {
        name: "description",
        content:
          "Let AI build your accumulator. Choose number of legs and minimum probability per leg, then save the parlay to your bet log.",
      },
    ],
  }),
  component: AccumulatorPage,
});

const MIN_LEGS = 2;
const MAX_LEGS = 5;

type EditableLeg = AccumulatorLeg & { decimalOdds: string };

function AccumulatorPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  // Builder controls
  const [legCount, setLegCount] = useState<number>(3);
  const [minProb, setMinProb] = useState<number>(60);
  const [market, setMarket] = useState<CoachMarket>("any");

  // Result
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<AccumulatorResponse | null>(null);
  const [legs, setLegs] = useState<EditableLeg[]>([]);

  // Bankroll + stake
  const [bankroll, setBankroll] = useState<BankrollSettings | null>(null);
  const [units, setUnits] = useState("1");
  const [saving, setSaving] = useState(false);

  // Auto-tick so kicked-off legs disappear from the slip
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    getBankroll(user.id).then(setBankroll).catch(() => {});
  }, [user]);

  // Drop legs whose match has already kicked off
  useEffect(() => {
    setLegs((prev) => prev.filter((l) => new Date(l.kickoff).getTime() > now));
  }, [now]);

  const generate = async () => {
    setBusy(true);
    try {
      const res = await getAccumulatorBuilder({
        data: { legs: legCount, minProbability: minProb, market },
      });
      setResponse(res);
      if (res.error) {
        toast.error(res.error);
        setLegs([]);
      } else if (res.legs.length === 0) {
        toast.warning(res.summary || "No accumulator could be built with these settings.");
        setLegs([]);
      } else {
        setLegs(
          res.legs.map((l) => ({
            ...l,
            decimalOdds: l.fairOdds > 0 ? l.fairOdds.toFixed(2) : "2.00",
          })),
        );
        toast.success(`AI built a ${res.legs.length}-leg accumulator`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to build accumulator");
    } finally {
      setBusy(false);
    }
  };

  const removeLeg = (matchId: number) => {
    setLegs((prev) => prev.filter((l) => l.matchId !== matchId));
  };
  const updateLegOdds = (matchId: number, value: string) => {
    setLegs((prev) => prev.map((l) => (l.matchId === matchId ? { ...l, decimalOdds: value } : l)));
  };

  const combinedModelProb = useMemo(
    () => legs.reduce((acc, l) => acc * (l.probability / 100), 1),
    [legs],
  );
  const combinedOdds = useMemo(() => {
    let p = 1;
    let valid = true;
    for (const l of legs) {
      const n = parseFloat(l.decimalOdds.replace(",", "."));
      if (!Number.isFinite(n) || n <= 1) {
        valid = false;
        break;
      }
      p *= n;
    }
    return { value: p, valid };
  }, [legs]);
  const impliedBookProb = combinedOdds.valid && combinedOdds.value > 0 ? 1 / combinedOdds.value : 0;
  const edgePct = combinedOdds.valid ? (combinedModelProb - impliedBookProb) * 100 : 0;

  const unitSize = Number(bankroll?.unit_size ?? 0);
  const stake = useMemo(() => {
    const u = parseFloat(units);
    if (!Number.isFinite(u) || u <= 0 || unitSize <= 0) return 0;
    return +(u * unitSize).toFixed(2);
  }, [units, unitSize]);

  const submit = async () => {
    if (!user) return;
    if (legs.length < MIN_LEGS) return toast.error(`Add at least ${MIN_LEGS} legs`);
    if (!combinedOdds.valid) return toast.error("All leg odds must be > 1.00");
    if (!bankroll) return toast.error("Set up your bankroll first");
    const u = parseFloat(units);
    if (!Number.isFinite(u) || u <= 0) return toast.error("Units must be > 0");

    setSaving(true);
    try {
      const selectionLabel = legs
        .map((l) => `${l.homeTeam} v ${l.awayTeam}: ${l.selectionLabel}`)
        .join(" • ");
      const notes =
        `AI accumulator (${legs.length} legs)\n` +
        legs
          .map(
            (l) =>
              `• ${l.competition ?? "-"} | ${l.homeTeam} vs ${l.awayTeam} | ${l.marketLabel} ${l.selectionLabel} @ ${l.decimalOdds} (model ${Math.round(l.probability)}%)`,
          )
          .join("\n");

      await addBet({
        userId: user.id,
        matchId: null,
        homeTeam: null,
        awayTeam: null,
        competition: `Accumulator · ${legs.length} legs`,
        utcDate: legs[0]?.kickoff ?? null,
        market: "accumulator",
        selection: selectionLabel,
        decimalOdds: +combinedOdds.value.toFixed(4),
        stake,
        units: u,
        modelProbability: combinedModelProb,
        notes,
      });
      toast.success(`Accumulator logged · ${u}u @ ${combinedOdds.value.toFixed(2)}`);
      setLegs([]);
      navigate({ to: "/bankroll" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save accumulator");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !user) return null;

  return (
    <AppShell>
      <header className="mb-6 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/20 text-primary">
          <Layers className="h-5 w-5" />
        </div>
        <div>
          <h1 className="font-display text-3xl font-bold leading-tight">AI accumulator builder</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick how many legs and the minimum model probability per leg. The AI picks the best combination from today's predictions, one leg per match.
          </p>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        {/* Left: AI controls + result */}
        <section className="space-y-4">
          <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-secondary/30 to-secondary/30 p-5">
            <div className="mb-4 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <h2 className="font-display text-lg font-bold">AI builder</h2>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Number of legs · {legCount}
                </Label>
                <Slider
                  className="mt-3"
                  min={MIN_LEGS}
                  max={MAX_LEGS}
                  step={1}
                  value={[legCount]}
                  onValueChange={(v) => setLegCount(v[0] ?? 3)}
                />
                <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
                  <span>{MIN_LEGS}</span>
                  <span>{MAX_LEGS}</span>
                </div>
              </div>

              <div>
                <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Min probability per leg · {minProb}%
                </Label>
                <Slider
                  className="mt-3"
                  min={40}
                  max={90}
                  step={1}
                  value={[minProb]}
                  onValueChange={(v) => setMinProb(v[0] ?? 60)}
                />
                <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
                  <span>40%</span>
                  <span>90%</span>
                </div>
              </div>

              <div className="sm:col-span-2">
                <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Markets to consider
                </Label>
                <Select value={market} onValueChange={(v) => setMarket(v as CoachMarket)}>
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any market (recommended)</SelectItem>
                    <SelectItem value="1x2">Match Result (1X2) only</SelectItem>
                    <SelectItem value="ou_25">Over/Under 2.5 only</SelectItem>
                    <SelectItem value="btts">BTTS only</SelectItem>
                    <SelectItem value="double_chance">Double Chance only</SelectItem>
                    <SelectItem value="dnb">Draw No Bet only</SelectItem>
                    <SelectItem value="ah">Asian Handicap only</SelectItem>
                    <SelectItem value="home_to_score">Home to Score only</SelectItem>
                    <SelectItem value="away_to_score">Away to Score only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button onClick={generate} disabled={busy} className="mt-5 w-full gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {busy ? "Building accumulator…" : "Generate accumulator"}
            </Button>
          </div>

          {/* AI summary */}
          {response && !response.error && (
            <div className="rounded-2xl border border-border/60 bg-secondary/20 p-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
                AI summary
              </div>
              <p className="mt-2 text-sm leading-relaxed text-foreground/90">
                {response.summary || "Picks ready."}
              </p>
              <div className="mt-2 font-mono text-[10px] text-muted-foreground">
                Considered {response.considered} match{response.considered === 1 ? "" : "es"} with predictions
              </div>
            </div>
          )}

          {/* Per-leg rationales */}
          {legs.length > 0 && (
            <div className="space-y-3">
              {legs.map((l, i) => (
                <LegCard
                  key={l.matchId}
                  leg={l}
                  index={i}
                  onRemove={() => removeLeg(l.matchId)}
                />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!busy && !response && (
            <div className="rounded-2xl border border-dashed border-border/60 px-4 py-12 text-center text-sm text-muted-foreground">
              Set your preferences and tap <b className="text-foreground">Generate accumulator</b> — the AI builds the best combo from today's slate.
            </div>
          )}
        </section>

        {/* Right: bet slip */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-secondary/40 to-secondary/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
                  Bet slip
                </div>
                <h2 className="font-display text-xl font-bold">
                  {legs.length} {legs.length === 1 ? "leg" : "legs"}
                </h2>
              </div>
              {legs.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setLegs([])}>
                  Clear
                </Button>
              )}
            </div>

            {legs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
                No legs yet. Generate an accumulator to fill your slip.
              </div>
            ) : (
              <ul className="space-y-2">
                {legs.map((l) => (
                  <li key={l.matchId} className="rounded-xl bg-background/60 p-3">
                    <div className="truncate font-display text-sm font-semibold">
                      {l.homeTeam} vs {l.awayTeam}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      <span className="font-mono uppercase tracking-[0.15em]">{l.marketLabel}</span>{" "}
                      · <b className="text-foreground">{l.selectionLabel}</b> · model{" "}
                      <span className="font-mono tabular-nums text-primary">
                        {Math.round(l.probability)}%
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Label className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                        Odds
                      </Label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="1.01"
                        value={l.decimalOdds}
                        onChange={(e) => updateLegOdds(l.matchId, e.target.value)}
                        className="h-8 w-24"
                      />
                      <span className="font-mono text-[10px] text-muted-foreground">
                        fair ≈ {l.fairOdds.toFixed(2)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* Combined */}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <Stat
                label="Combined model prob"
                value={legs.length > 0 ? `${(combinedModelProb * 100).toFixed(2)}%` : "—"}
                tone="primary"
              />
              <Stat
                label="Combined odds"
                value={combinedOdds.valid && legs.length > 0 ? combinedOdds.value.toFixed(2) : "—"}
                tone="primary"
              />
              <Stat
                label="Implied book prob"
                value={
                  combinedOdds.valid && legs.length > 0
                    ? `${(impliedBookProb * 100).toFixed(2)}%`
                    : "—"
                }
              />
              <Stat
                label="Model edge"
                value={
                  combinedOdds.valid && legs.length > 0
                    ? `${edgePct >= 0 ? "+" : ""}${edgePct.toFixed(2)}%`
                    : "—"
                }
                tone={edgePct > 0 ? "good" : edgePct < 0 ? "bad" : "muted"}
              />
            </div>

            {/* Stake */}
            {bankroll ? (
              <div className="mt-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Label className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                    Units
                  </Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.5"
                    min="0.1"
                    value={units}
                    onChange={(e) => setUnits(e.target.value)}
                    className="h-8 w-24"
                  />
                  <span className="font-mono text-xs text-muted-foreground">
                    × {formatMoney(unitSize, bankroll.currency)} ={" "}
                    <b className="text-foreground">{formatMoney(stake, bankroll.currency)}</b>
                  </span>
                </div>
                {combinedOdds.valid && legs.length > 0 && (
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Potential return</span>
                    <span className="font-mono">
                      {formatMoney(stake * combinedOdds.value, bankroll.currency)} ·{" "}
                      <span className="text-emerald-400">
                        +{formatMoney(stake * (combinedOdds.value - 1), bankroll.currency)}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
                Set up your bankroll to log stakes →{" "}
                <Link to="/bankroll" className="text-primary hover:underline">
                  Bankroll
                </Link>
              </div>
            )}

            <Button
              className="mt-4 w-full gap-2"
              onClick={submit}
              disabled={saving || legs.length < MIN_LEGS || !combinedOdds.valid || !bankroll}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />}
              {saving ? "Saving…" : "Save to bet log"}
            </Button>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}

function Stat({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "muted" | "primary" | "good" | "bad";
}) {
  const toneClass =
    tone === "primary"
      ? "text-primary"
      : tone === "good"
      ? "text-emerald-400"
      : tone === "bad"
      ? "text-destructive"
      : "text-foreground";
  return (
    <div className="rounded-xl bg-background/60 px-3 py-2">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className={`mt-0.5 font-display text-lg font-bold tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function LegCard({
  leg,
  index,
  onRemove,
}: {
  leg: EditableLeg;
  index: number;
  onRemove: () => void;
}) {
  const date = new Date(leg.kickoff);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = date.toLocaleDateString(undefined, { weekday: "short" });

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border/60 bg-background/40 transition card-elevated hover:border-primary/40 hover:bg-primary/[0.04] hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.15)]">
      {/* Full-card click overlay (sits below action buttons via z-index) */}
      <Link
        to="/match/$matchId"
        params={{ matchId: String(leg.matchId) }}
        className="absolute inset-0 z-10"
        aria-label={`Open ${leg.homeTeam} vs ${leg.awayTeam}`}
      />
      <div className="relative grid grid-cols-1 md:grid-cols-[40px_70px_1fr_auto_36px] items-center gap-3 px-5 py-4">
        {/* Leg number */}
        <div className="flex md:justify-center">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 font-mono text-[11px] font-bold text-primary">
            {index + 1}
          </span>
        </div>

        {/* Time */}
        <div className="flex md:flex-col md:items-start items-center justify-between gap-2">
          <span className="font-mono text-sm font-bold tabular-nums">{time}</span>
          <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground md:mt-0.5">
            {day}
          </span>
        </div>

        {/* Match + competition */}
        <div className="min-w-0">
          {leg.competition && (
            <div className="mb-0.5 truncate font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/80">
              {leg.competition}
            </div>
          )}
          <div className="truncate font-display text-sm font-semibold">
            {leg.homeTeam}
            <span className="mx-2 text-muted-foreground">vs</span>
            {leg.awayTeam}
          </div>
        </div>

        {/* Big right-aligned pick CTA */}
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-block rounded-md bg-secondary/60 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground">
            {leg.marketLabel}
          </span>
          <div className="flex flex-col items-center gap-0.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5">
            <span className="max-w-[180px] truncate font-mono text-[10px] uppercase tracking-[0.15em] text-primary">
              {leg.selectionLabel}
            </span>
            <span className="font-display text-base font-bold tabular-nums text-primary">
              {Math.round(leg.probability)}%
            </span>
          </div>
        </div>

        {/* Remove */}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className="relative z-20 hidden md:flex h-8 w-8 items-center justify-center justify-self-end rounded-md border border-border/60 bg-background/60 text-muted-foreground transition hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
          aria-label="Remove leg"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* Rationale + fair odds footer */}
      <div className="relative border-t border-border/40 bg-secondary/20 px-5 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <p className="flex-1 text-xs italic leading-relaxed text-muted-foreground">
            {leg.rationale}
          </p>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
            fair {leg.fairOdds.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Mobile remove button */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        }}
        className="relative z-20 md:hidden flex w-full items-center justify-center gap-1.5 border-t border-border/40 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        aria-label="Remove leg"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Remove leg
      </button>
    </div>
  );
}