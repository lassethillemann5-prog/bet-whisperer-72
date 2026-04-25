import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getTodayPredictions, type TodayPickRow } from "@/server/football.functions";
import { addBet, getBankroll, type BankrollSettings } from "@/lib/football/bankroll";
import { Layers, Plus, Search, Trash2, Receipt, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/accumulator")({
  head: () => ({
    meta: [
      { title: "Accumulator builder · Pitchcast" },
      {
        name: "description",
        content:
          "Combine 2–5 picks into an accumulator. See combined model probability, combined decimal odds, and save the bet to your bet log.",
      },
    ],
  }),
  component: AccumulatorPage,
});

const MIN_LEGS = 2;
const MAX_LEGS = 5;

type Selection = {
  market: "1x2" | "ou_25" | "btts";
  marketLabel: string;
  selection: string;
  selectionLabel: string;
  probability: number; // 0..1
};

type Leg = {
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  utcDate: string;
  selection: Selection;
  decimalOdds: string; // free-text, parsed at submit
};

function AccumulatorPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<TodayPickRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [legs, setLegs] = useState<Leg[]>([]);
  const [bankroll, setBankroll] = useState<BankrollSettings | null>(null);
  const [units, setUnits] = useState("1");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    Promise.all([
      getTodayPredictions({ data: { computeBudget: 8 } }),
      getBankroll(user.id),
    ])
      .then(([res, br]) => {
        if (cancelled) return;
        if (res.error) setError(res.error);
        setRows(res.rows.filter((r) => r.best));
        setBankroll(br);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [user]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.match.homeTeam.name.toLowerCase().includes(q) ||
        r.match.awayTeam.name.toLowerCase().includes(q) ||
        r.match.competition?.name?.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const selectionsForRow = (r: TodayPickRow): Selection[] => {
    const out: Selection[] = [];
    if (r.oneXTwo) {
      out.push({ market: "1x2", marketLabel: "1X2", selection: "1", selectionLabel: r.match.homeTeam.name, probability: r.oneXTwo.home / 100 });
      out.push({ market: "1x2", marketLabel: "1X2", selection: "X", selectionLabel: "Draw", probability: r.oneXTwo.draw / 100 });
      out.push({ market: "1x2", marketLabel: "1X2", selection: "2", selectionLabel: r.match.awayTeam.name, probability: r.oneXTwo.away / 100 });
    }
    if (r.ou25) {
      out.push({ market: "ou_25", marketLabel: "O/U 2.5", selection: "Over", selectionLabel: "Over 2.5", probability: r.ou25.over / 100 });
      out.push({ market: "ou_25", marketLabel: "O/U 2.5", selection: "Under", selectionLabel: "Under 2.5", probability: r.ou25.under / 100 });
    }
    if (r.btts) {
      out.push({ market: "btts", marketLabel: "BTTS", selection: "Yes", selectionLabel: "BTTS Yes", probability: r.btts.yes / 100 });
      out.push({ market: "btts", marketLabel: "BTTS", selection: "No", selectionLabel: "BTTS No", probability: r.btts.no / 100 });
    }
    return out;
  };

  const addLeg = (r: TodayPickRow, sel: Selection) => {
    if (legs.length >= MAX_LEGS) {
      toast.error(`Max ${MAX_LEGS} legs`);
      return;
    }
    if (legs.some((l) => l.matchId === r.match.id)) {
      toast.error("That match is already in the accumulator");
      return;
    }
    // Suggest fair odds (1 / probability) as starting value
    const fair = sel.probability > 0 ? (1 / sel.probability).toFixed(2) : "2.00";
    setLegs((prev) => [
      ...prev,
      {
        matchId: r.match.id,
        homeTeam: r.match.homeTeam.name,
        awayTeam: r.match.awayTeam.name,
        competition: r.match.competition?.name ?? null,
        utcDate: r.match.utcDate,
        selection: sel,
        decimalOdds: fair,
      },
    ]);
  };

  const removeLeg = (matchId: number) => {
    setLegs((prev) => prev.filter((l) => l.matchId !== matchId));
  };

  const updateLegOdds = (matchId: number, value: string) => {
    setLegs((prev) => prev.map((l) => (l.matchId === matchId ? { ...l, decimalOdds: value } : l)));
  };

  const combinedProb = useMemo(
    () => legs.reduce((acc, l) => acc * l.selection.probability, 1),
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
  const edgePct = combinedOdds.valid ? (combinedProb - impliedBookProb) * 100 : 0;

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
        .map((l) => `${l.homeTeam} v ${l.awayTeam}: ${l.selection.selectionLabel}`)
        .join(" • ");
      const notes = `Accumulator (${legs.length} legs)\n` +
        legs
          .map(
            (l) =>
              `• ${l.competition ?? "-"} | ${l.homeTeam} vs ${l.awayTeam} | ${l.selection.marketLabel} ${l.selection.selectionLabel} @ ${l.decimalOdds} (model ${(l.selection.probability * 100).toFixed(0)}%)`,
          )
          .join("\n");

      await addBet({
        userId: user.id,
        matchId: null,
        homeTeam: null,
        awayTeam: null,
        competition: `Accumulator · ${legs.length} legs`,
        utcDate: legs[0]?.utcDate ?? null,
        market: "accumulator",
        selection: selectionLabel,
        decimalOdds: +combinedOdds.value.toFixed(4),
        stake,
        units: u,
        modelProbability: combinedProb,
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
          <h1 className="font-display text-3xl font-bold leading-tight">Accumulator builder</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Combine {MIN_LEGS}–{MAX_LEGS} picks. We multiply leg model probabilities, you set bookmaker odds, then compare implied vs. modeled edge.
          </p>
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        {/* Left: candidates */}
        <section className="rounded-2xl border border-border/60 bg-secondary/20 p-4">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="font-display text-lg font-bold">Today's predictions</h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              {filtered.length} matches
            </span>
          </div>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search team or league…"
              className="pl-9"
            />
          </div>
          {busy ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-20 animate-pulse rounded-xl bg-secondary/40" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
              No fixtures with predictions today. Check back later or open Today's picks first.
            </div>
          ) : (
            <ul className="space-y-2">
              {filtered.slice(0, 30).map((r) => {
                const inAcc = legs.some((l) => l.matchId === r.match.id);
                const sels = selectionsForRow(r);
                return (
                  <li
                    key={r.match.id}
                    className={`rounded-xl border px-3 py-3 transition ${
                      inAcc ? "border-primary/60 bg-primary/5" : "border-border/60 bg-background/40"
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-display text-sm font-semibold">
                          {r.match.homeTeam.name} <span className="text-muted-foreground">vs</span> {r.match.awayTeam.name}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                          {r.match.competition?.name ?? "—"} ·{" "}
                          {new Date(r.match.utcDate).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {sels.map((s) => (
                        <button
                          key={`${s.market}-${s.selection}`}
                          onClick={() => addLeg(r, s)}
                          disabled={inAcc}
                          className="group inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/40 px-2 py-1 text-xs transition hover:border-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground">
                            {s.marketLabel}
                          </span>
                          <span className="font-semibold">{s.selectionLabel}</span>
                          <span className="font-mono tabular-nums text-primary">
                            {(s.probability * 100).toFixed(0)}%
                          </span>
                          {!inAcc && <Plus className="h-3 w-3 opacity-0 transition group-hover:opacity-100" />}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Right: slip */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-secondary/40 to-secondary/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">Bet slip</div>
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
                Tap a market chip on the left to add legs. Min {MIN_LEGS}, max {MAX_LEGS}.
              </div>
            ) : (
              <ul className="space-y-2">
                {legs.map((l) => (
                  <li key={l.matchId} className="rounded-xl bg-background/60 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-display text-sm font-semibold">
                          {l.homeTeam} vs {l.awayTeam}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          <span className="font-mono uppercase tracking-[0.15em]">{l.selection.marketLabel}</span>{" "}
                          · <b className="text-foreground">{l.selection.selectionLabel}</b>{" "}
                          · model{" "}
                          <span className="font-mono tabular-nums text-primary">
                            {(l.selection.probability * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => removeLeg(l.matchId)}
                        className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label="Remove leg"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
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
                        fair ≈ {l.selection.probability > 0 ? (1 / l.selection.probability).toFixed(2) : "—"}
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
                value={`${(combinedProb * 100).toFixed(2)}%`}
                tone="primary"
              />
              <Stat
                label="Combined odds"
                value={combinedOdds.valid && legs.length > 0 ? combinedOdds.value.toFixed(2) : "—"}
                tone="primary"
              />
              <Stat
                label="Implied book prob"
                value={combinedOdds.valid && legs.length > 0 ? `${(impliedBookProb * 100).toFixed(2)}%` : "—"}
              />
              <Stat
                label="Model edge"
                value={combinedOdds.valid && legs.length > 0 ? `${edgePct >= 0 ? "+" : ""}${edgePct.toFixed(2)}%` : "—"}
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
                    × {formatMoney(unitSize, bankroll.currency)} = <b className="text-foreground">{formatMoney(stake, bankroll.currency)}</b>
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
                <a href="/bankroll" className="text-primary hover:underline">
                  Bankroll
                </a>
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
      <div className={`mt-0.5 font-display text-lg font-bold tabular-nums ${toneClass}`}>{value}</div>
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