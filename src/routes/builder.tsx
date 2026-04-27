import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getBetBuilder,
  getAiBetBuilder,
  getFixtures,
  type BetBuilderResponse,
} from "@/server/football.functions";
import { BUILDER_LEGS, type BuilderLegId, type BuilderLegMeta } from "@/lib/football/predictor";
import type { MatchSummary } from "@/lib/football/types";
import { addBet, getBankroll, type BankrollSettings } from "@/lib/football/bankroll";
import {
  Hammer,
  Loader2,
  Receipt,
  Search,
  Sparkles,
  Trash2,
  X,
  Calendar,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/builder")({
  head: () => ({
    meta: [
      { title: "Bet Builder · Pitchcast" },
      {
        name: "description",
        content:
          "Build same-game multis with correlation-adjusted probability. Pick a match, combine markets, see your true model edge before placing the bet.",
      },
    ],
  }),
  component: BuilderPage,
});

const LEG_GROUPS: Array<{ key: BuilderLegMeta["group"]; title: string }> = [
  { key: "result", title: "Match Result" },
  { key: "double_chance", title: "Double Chance" },
  { key: "dnb", title: "Draw No Bet" },
  { key: "ou_15", title: "Goals · 1.5" },
  { key: "ou_25", title: "Goals · 2.5" },
  { key: "btts", title: "Both Teams To Score" },
  { key: "home_scores", title: "Home to Score" },
  { key: "away_scores", title: "Away to Score" },
];

function BuilderPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  // Match picker
  const [fixtures, setFixtures] = useState<MatchSummary[]>([]);
  const [fixturesBusy, setFixturesBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [matchId, setMatchId] = useState<number | null>(null);

  // Builder state
  const [legs, setLegs] = useState<BuilderLegId[]>([]);
  const [data, setData] = useState<BetBuilderResponse | null>(null);
  const [busy, setBusy] = useState(false);

  // Bankroll + odds + save
  const [bankroll, setBankroll] = useState<BankrollSettings | null>(null);
  const [decimalOdds, setDecimalOdds] = useState("3.00");
  const [units, setUnits] = useState("1");
  const [saving, setSaving] = useState(false);

  // AI generator
  const [aiRisk, setAiRisk] = useState<"safe" | "balanced" | "longshot">("balanced");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiRationale, setAiRationale] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    setFixturesBusy(true);
    getFixtures({ data: { days: 3 } })
      .then((res) => {
        const now = Date.now();
        const upcoming = res.matches.filter(
          (m) => new Date(m.utcDate).getTime() > now,
        );
        setFixtures(upcoming);
      })
      .catch(() => {})
      .finally(() => setFixturesBusy(false));
    getBankroll(user.id).then(setBankroll).catch(() => {});
  }, [user]);

  // Refetch builder data when match or legs change
  useEffect(() => {
    if (matchId == null) {
      setData(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    getBetBuilder({ data: { matchId, legs } })
      .then((res) => {
        if (cancelled) return;
        setData(res);
        if (res.error) toast.error(res.error);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(e instanceof Error ? e.message : "Failed to load match");
      })
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [matchId, legs]);

  // Filtered fixture list
  const filteredFixtures = useMemo(() => {
    if (!query.trim()) return fixtures.slice(0, 60);
    const q = query.toLowerCase();
    return fixtures
      .filter(
        (m) =>
          m.homeTeam.name.toLowerCase().includes(q) ||
          m.awayTeam.name.toLowerCase().includes(q) ||
          m.competition?.name?.toLowerCase().includes(q),
      )
      .slice(0, 60);
  }, [fixtures, query]);

  const selectedMatch = useMemo(
    () => fixtures.find((m) => m.id === matchId) ?? null,
    [fixtures, matchId],
  );

  const conflictSet = useMemo(
    () => new Set(data?.conflicts ?? []),
    [data?.conflicts],
  );

  const toggleLeg = (id: BuilderLegId) => {
    if (legs.includes(id)) {
      setLegs((prev) => prev.filter((l) => l !== id));
      return;
    }
    if (conflictSet.has(id)) {
      toast.warning("That selection conflicts with the current legs.");
      return;
    }
    setLegs((prev) => [...prev, id]);
  };

  const removeLeg = (id: BuilderLegId) => {
    setLegs((prev) => prev.filter((l) => l !== id));
    setAiRationale(null);
  };

  const clearAll = () => {
    setLegs([]);
    setAiRationale(null);
  };
  const reset = () => {
    setLegs([]);
    setMatchId(null);
    setData(null);
    setAiRationale(null);
  };

  const generateWithAi = async () => {
    if (!selectedMatch) return toast.error("Pick a match first");
    setAiBusy(true);
    setAiRationale(null);
    try {
      const res = await getAiBetBuilder({
        data: { matchId: selectedMatch.id, riskLevel: aiRisk },
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setLegs(res.legs);
      setAiRationale(res.rationale || null);
      toast.success(`AI built a ${res.legs.length}-leg multi`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "AI generator failed");
    } finally {
      setAiBusy(false);
    }
  };

  const joint = data?.jointProbability ?? null;
  const fairOdds = data?.fairOdds ?? null;
  const oddsNum = parseFloat(decimalOdds.replace(",", "."));
  const oddsValid = Number.isFinite(oddsNum) && oddsNum > 1;
  const impliedBookProb = oddsValid ? 1 / oddsNum : 0;
  const edgePct = oddsValid && joint != null ? (joint - impliedBookProb) * 100 : 0;

  const unitSize = Number(bankroll?.unit_size ?? 0);
  const stake = useMemo(() => {
    const u = parseFloat(units);
    if (!Number.isFinite(u) || u <= 0 || unitSize <= 0) return 0;
    return +(u * unitSize).toFixed(2);
  }, [units, unitSize]);

  const submit = async () => {
    if (!user) return;
    if (!selectedMatch) return toast.error("Pick a match first");
    if (legs.length < 2) return toast.error("Add at least 2 legs to build a multi");
    if (!oddsValid) return toast.error("Decimal odds must be > 1.00");
    if (!bankroll) return toast.error("Set up your bankroll first");
    const u = parseFloat(units);
    if (!Number.isFinite(u) || u <= 0) return toast.error("Units must be > 0");

    setSaving(true);
    try {
      const selectionLabel = legs
        .map((id) => {
          const meta = BUILDER_LEGS.find((l) => l.id === id)!;
          return `${meta.marketLabel}: ${meta.selectionLabel}`;
        })
        .join(" + ");

      const notes =
        `Bet Builder (${legs.length} legs, same-game multi)\n` +
        legs
          .map((id) => {
            const meta = BUILDER_LEGS.find((l) => l.id === id)!;
            const p = data?.match?.legProbabilities[id];
            return `• ${meta.marketLabel} — ${meta.selectionLabel}${p != null ? ` (model ${Math.round(p)}%)` : ""}`;
          })
          .join("\n") +
        (joint != null ? `\nJoint model probability: ${(joint * 100).toFixed(2)}%` : "");

      await addBet({
        userId: user.id,
        matchId: selectedMatch.id,
        homeTeam: selectedMatch.homeTeam.name,
        awayTeam: selectedMatch.awayTeam.name,
        competition: selectedMatch.competition?.name ?? null,
        utcDate: selectedMatch.utcDate,
        market: "bet_builder",
        selection: selectionLabel,
        decimalOdds: +oddsNum.toFixed(4),
        stake,
        units: u,
        modelProbability: joint ?? null,
        notes,
      });
      toast.success(`Bet builder logged · ${u}u @ ${oddsNum.toFixed(2)}`);
      reset();
      navigate({ to: "/bankroll" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save bet");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !user) return null;

  return (
    <AppShell>
      <header className="mb-6 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/20 text-primary">
          <Hammer className="h-5 w-5" />
        </div>
        <div>
          <h1 className="font-display text-3xl font-bold leading-tight">Bet Builder</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Same-game multi with correlation-aware probability. Pick a match, combine markets — we compute the true joint probability from the scoreline grid, not naïve multiplication.
          </p>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        {/* Left: match picker + leg picker */}
        <section className="space-y-4">
          {selectedMatch ? (
            <SelectedMatchCard
              match={selectedMatch}
              onChange={() => {
                setMatchId(null);
                setLegs([]);
                setData(null);
              }}
            />
          ) : (
            <MatchPicker
              fixtures={filteredFixtures}
              busy={fixturesBusy}
              query={query}
              onQuery={setQuery}
              onSelect={(id) => {
                setMatchId(id);
                setLegs([]);
              }}
            />
          )}

          {selectedMatch && (
            <AiBuilderPanel
              risk={aiRisk}
              onRiskChange={setAiRisk}
              busy={aiBusy}
              rationale={aiRationale}
              onGenerate={generateWithAi}
            />
          )}

          {selectedMatch && (
            <LegPicker
              data={data}
              busy={busy}
              legs={legs}
              onToggle={toggleLeg}
            />
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
                <Button variant="ghost" size="sm" onClick={clearAll}>
                  Clear
                </Button>
              )}
            </div>

            {!selectedMatch ? (
              <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
                Pick a match to start building.
              </div>
            ) : legs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
                Toggle markets on the left to add legs.
              </div>
            ) : (
              <ul className="space-y-2">
                {legs.map((id) => {
                  const meta = BUILDER_LEGS.find((l) => l.id === id)!;
                  const p = data?.match?.legProbabilities[id];
                  return (
                    <li key={id} className="rounded-xl bg-background/60 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                            {meta.marketLabel}
                          </div>
                          <div className="truncate font-display text-sm font-semibold">
                            {meta.selectionLabel}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {p != null && (
                            <span className="font-mono text-xs tabular-nums text-primary">
                              {Math.round(p)}%
                            </span>
                          )}
                          <button
                            onClick={() => removeLeg(id)}
                            className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label="Remove leg"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Joint stats */}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <Stat
                label="Joint model prob"
                value={joint != null ? `${(joint * 100).toFixed(2)}%` : "—"}
                tone="primary"
              />
              <Stat
                label="Fair odds"
                value={fairOdds != null ? fairOdds.toFixed(2) : "—"}
              />
              <Stat
                label="Implied book prob"
                value={oddsValid && legs.length > 0 ? `${(impliedBookProb * 100).toFixed(2)}%` : "—"}
              />
              <Stat
                label="Model edge"
                value={
                  oddsValid && legs.length > 0 && joint != null
                    ? `${edgePct >= 0 ? "+" : ""}${edgePct.toFixed(2)}%`
                    : "—"
                }
                tone={edgePct > 0 ? "good" : edgePct < 0 ? "bad" : "muted"}
              />
            </div>

            {/* Stake row */}
            {bankroll ? (
              <div className="mt-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Label className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                    Odds
                  </Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="1.01"
                    value={decimalOdds}
                    onChange={(e) => setDecimalOdds(e.target.value)}
                    className="h-8 w-24"
                  />
                  <Label className="ml-2 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                    Units
                  </Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.5"
                    min="0.1"
                    value={units}
                    onChange={(e) => setUnits(e.target.value)}
                    className="h-8 w-20"
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Stake</span>
                  <span className="font-mono">
                    {formatMoney(stake, bankroll.currency)}
                    {oddsValid && legs.length > 0 && (
                      <>
                        {" · returns "}
                        <span className="text-foreground">
                          {formatMoney(stake * oddsNum, bankroll.currency)}
                        </span>{" "}
                        <span className="text-emerald-400">
                          (+{formatMoney(stake * (oddsNum - 1), bankroll.currency)})
                        </span>
                      </>
                    )}
                  </span>
                </div>
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
              disabled={saving || legs.length < 2 || !oddsValid || !bankroll}
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

function MatchPicker({
  fixtures,
  busy,
  query,
  onQuery,
  onSelect,
}: {
  fixtures: MatchSummary[];
  busy: boolean;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background/40 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <h2 className="font-display text-lg font-bold">Pick a match</h2>
      </div>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search team or league…"
          className="pl-9"
        />
      </div>
      {busy ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading fixtures…
        </div>
      ) : fixtures.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
          No matches found.
        </div>
      ) : (
        <ul className="max-h-[460px] space-y-1.5 overflow-y-auto pr-1">
          {fixtures.map((m) => (
            <li key={m.id}>
              <button
                onClick={() => onSelect(m.id)}
                className="group flex w-full items-center gap-3 rounded-xl border border-border/40 bg-secondary/30 px-3 py-2.5 text-left transition hover:border-primary/40 hover:bg-primary/10"
              >
                <div className="flex w-14 shrink-0 flex-col items-center justify-center text-center">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {new Date(m.utcDate).toLocaleDateString(undefined, { weekday: "short" })}
                  </span>
                  <span className="font-mono text-xs font-bold tabular-nums">
                    {new Date(m.utcDate).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  {m.competition?.name && (
                    <div className="truncate font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                      {m.competition.name}
                    </div>
                  )}
                  <div className="truncate font-display text-sm font-semibold">
                    {m.homeTeam.shortName ?? m.homeTeam.name}
                    <span className="mx-2 text-muted-foreground">vs</span>
                    {m.awayTeam.shortName ?? m.awayTeam.name}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SelectedMatchCard({
  match,
  onChange,
}: {
  match: MatchSummary;
  onChange: () => void;
}) {
  const date = new Date(match.utcDate);
  return (
    <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-secondary/40 to-secondary/40 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
            Building bet for
          </div>
          <h2 className="mt-0.5 truncate font-display text-2xl font-bold">
            {match.homeTeam.name} <span className="text-muted-foreground">vs</span> {match.awayTeam.name}
          </h2>
          <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {match.competition?.name ?? "—"} ·{" "}
            {date.toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onChange} className="gap-1.5">
          <X className="h-3.5 w-3.5" />
          Change
        </Button>
      </div>
    </div>
  );
}

function LegPicker({
  data,
  busy,
  legs,
  onToggle,
}: {
  data: BetBuilderResponse | null;
  busy: boolean;
  legs: BuilderLegId[];
  onToggle: (id: BuilderLegId) => void;
}) {
  const conflictSet = useMemo(
    () => new Set(data?.conflicts ?? []),
    [data?.conflicts],
  );
  const probabilities = data?.match?.legProbabilities ?? ({} as Record<BuilderLegId, number>);
  const noData =
    data?.match != null && (data.match.unavailable?.length ?? 0) === BUILDER_LEGS.length;

  return (
    <div className="rounded-2xl border border-border/60 bg-background/40 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">Markets</h2>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {noData ? (
        <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
          Not enough form data to build a bet for this match.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {LEG_GROUPS.map((g) => {
            const items = BUILDER_LEGS.filter((l) => l.group === g.key);
            return (
              <div key={g.key} className="rounded-xl border border-border/40 bg-secondary/20 p-3">
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                  {g.title}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((l) => {
                    const isSelected = legs.includes(l.id);
                    const isConflict = conflictSet.has(l.id);
                    const prob = probabilities[l.id];
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => onToggle(l.id)}
                        disabled={isConflict && !isSelected}
                        className={`group flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition ${
                          isSelected
                            ? "border-primary/60 bg-primary/20 text-primary"
                            : isConflict
                            ? "cursor-not-allowed border-border/30 bg-background/30 text-muted-foreground/40"
                            : "border-border/50 bg-background/40 text-foreground/80 hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
                        }`}
                      >
                        <span className="font-medium">{l.selectionLabel}</span>
                        {prob != null && (
                          <span className="font-mono text-[10px] tabular-nums opacity-80">
                            {Math.round(prob)}%
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {legs.length > 0 && data?.jointProbability != null && (
        <p className="mt-3 text-xs italic text-muted-foreground">
          Joint probability is computed from the same Dixon-Coles Poisson grid that powers the per-match predictions, so correlated markets (e.g. Home win + Over 2.5) are priced together — not naïvely multiplied.
        </p>
      )}
    </div>
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

function AiBuilderPanel({
  risk,
  onRiskChange,
  busy,
  rationale,
  onGenerate,
}: {
  risk: "safe" | "balanced" | "longshot";
  onRiskChange: (r: "safe" | "balanced" | "longshot") => void;
  busy: boolean;
  rationale: string | null;
  onGenerate: () => void;
}) {
  const RISKS: Array<{
    id: "safe" | "balanced" | "longshot";
    label: string;
    sub: string;
  }> = [
    { id: "safe", label: "Safe", sub: "~1.5–2.2" },
    { id: "balanced", label: "Balanced", sub: "~2.6–4.5" },
    { id: "longshot", label: "Longshot", sub: "~5.5–12" },
  ];
  return (
    <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-secondary/30 to-background/40 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Wand2 className="h-4 w-4 text-primary" />
        <h2 className="font-display text-lg font-bold">AI Bet Builder</h2>
        <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
          gemini · same-game multi
        </span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Let the model pick a correlated, non-conflicting set of legs from the cached match probabilities. You can still tweak the result.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border border-border/50 bg-background/40 p-1">
          {RISKS.map((r) => {
            const active = risk === r.id;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => onRiskChange(r.id)}
                className={`rounded-lg px-3 py-1.5 text-xs transition ${
                  active
                    ? "bg-primary/20 text-primary"
                    : "text-foreground/70 hover:text-foreground"
                }`}
              >
                <span className="font-semibold">{r.label}</span>
                <span className="ml-1.5 font-mono text-[10px] opacity-70">{r.sub}</span>
              </button>
            );
          })}
        </div>
        <Button
          size="sm"
          className="ml-auto gap-2"
          onClick={onGenerate}
          disabled={busy}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {busy ? "Generating…" : "Generate"}
        </Button>
      </div>
      {rationale && (
        <div className="mt-3 rounded-xl border border-primary/20 bg-background/60 p-3">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
            AI rationale
          </div>
          <p className="text-sm leading-relaxed text-foreground/90">{rationale}</p>
        </div>
      )}
    </div>
  );
}
