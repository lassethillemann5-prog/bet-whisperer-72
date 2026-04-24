import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { getMatchWithPredictions } from "@/server/football.functions";
import type { MatchPredictions, MatchSummary, MarketPrediction } from "@/lib/football/types";
import { listTracked, trackMatch, untrackMatch } from "@/lib/football/tracked";
import { listOddsForMatch, upsertOdds, deleteOdds, type OddsRow } from "@/lib/football/odds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Sparkles, Star, StarOff, TrendingUp, Trash2, Plus, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchOddsForMatch } from "@/server/oddsApi.functions";

export const Route = createFileRoute("/match/$matchId")({
  component: MatchPage,
});

function MatchPage() {
  const { matchId } = Route.useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<{ match: MatchSummary; predictions: MatchPredictions } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isTracked, setIsTracked] = useState(false);
  const [odds, setOdds] = useState<OddsRow[]>([]);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    Promise.all([
      getMatchWithPredictions({ data: { matchId: Number(matchId) } }),
      listTracked(user.id),
      listOddsForMatch(user.id, Number(matchId)),
    ])
      .then(([res, tracked, oddsRows]) => {
        if (cancelled) return;
        setData(res);
        setIsTracked(tracked.some((t) => t.match_id === Number(matchId)));
        setOdds(oddsRows);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load match"))
      .finally(() => !cancelled && setBusy(false));
    return () => { cancelled = true; };
  }, [user, matchId]);

  const toggleTrack = async () => {
    if (!user || !data) return;
    try {
      if (isTracked) {
        await untrackMatch(user.id, data.match.id);
        setIsTracked(false);
        toast.success("Removed from tracked");
      } else {
        await trackMatch({
          userId: user.id,
          matchId: data.match.id,
          competition: data.match.competition?.name ?? null,
          homeTeam: data.match.homeTeam.name,
          awayTeam: data.match.awayTeam.name,
          utcDate: data.match.utcDate,
        });
        setIsTracked(true);
        toast.success("Tracking match");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  if (loading || !user) return null;

  return (
    <AppShell>
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to fixtures
      </Link>

      {busy && <div className="h-96 animate-pulse rounded-2xl border border-border/60 bg-secondary/40" />}
      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {data && (
        <>
          <MatchHeader
            match={data.match}
            preds={data.predictions}
            isTracked={isTracked}
            onToggle={toggleTrack}
          />
          <Commentary text={data.predictions.commentary} />
          <MarketsGrid markets={data.predictions.markets} />
          <OddsSection
            matchId={data.match.id}
            userId={user.id}
            markets={data.predictions.markets}
            odds={odds}
            matchMeta={{
              homeTeam: data.match.homeTeam.name,
              awayTeam: data.match.awayTeam.name,
              utcDate: data.match.utcDate,
            }}
            onChange={async () => setOdds(await listOddsForMatch(user.id, data.match.id))}
          />
          <FormSummary match={data.match} preds={data.predictions} />
        </>
      )}
    </AppShell>
  );
}

function MatchHeader({
  match,
  preds,
  isTracked,
  onToggle,
}: {
  match: MatchSummary;
  preds: MatchPredictions;
  isTracked: boolean;
  onToggle: () => void;
}) {
  const d = new Date(match.utcDate);
  return (
    <section className="overflow-hidden rounded-3xl border border-border/60 card-elevated">
      <div className="flex items-center justify-between border-b border-border/50 px-5 py-3">
        <div className="flex items-center gap-2">
          {match.competition?.emblem && (
            <img src={match.competition.emblem} alt="" className="h-5 w-5 object-contain" />
          )}
          <span className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">
            {match.competition?.name}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={onToggle} className="gap-1.5">
          {isTracked ? <StarOff className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />}
          {isTracked ? "Untrack" : "Track"}
        </Button>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 p-6 md:p-10">
        <TeamBlock team={match.homeTeam} align="right" expGoals={preds.expectedGoalsHome} />
        <div className="flex flex-col items-center gap-2">
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            {d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
          </div>
          <div className="font-display text-3xl font-bold tabular-nums text-primary">
            {d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </div>
          <div className="rounded-full bg-secondary px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            kick-off
          </div>
        </div>
        <TeamBlock team={match.awayTeam} align="left" expGoals={preds.expectedGoalsAway} />
      </div>
    </section>
  );
}

function TeamBlock({
  team,
  align,
  expGoals,
}: {
  team: MatchSummary["homeTeam"];
  align: "left" | "right";
  expGoals: number;
}) {
  return (
    <div
      className={`flex items-center gap-4 ${
        align === "right" ? "flex-row-reverse text-right" : ""
      }`}
    >
      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-secondary">
        {team.crest ? (
          <img src={team.crest} alt="" className="h-12 w-12 object-contain" />
        ) : (
          <span className="font-display text-xl font-bold text-muted-foreground">
            {team.name.slice(0, 2)}
          </span>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate font-display text-xl font-bold md:text-2xl">{team.name}</div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          xG · <span className="text-primary">{expGoals.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

function Commentary({ text }: { text: string }) {
  return (
    <section className="mt-6 rounded-2xl border border-primary/30 bg-primary/5 p-5">
      <div className="mb-2 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
        <Sparkles className="h-3 w-3" />
        AI analyst
      </div>
      <p className="text-sm leading-relaxed text-foreground/90 md:text-base">{text}</p>
    </section>
  );
}

function MarketsGrid({ markets }: { markets: MarketPrediction[] }) {
  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-primary" />
        <h2 className="font-display text-lg font-bold">Markets</h2>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {markets.map((m) => (
          <MarketCard key={m.market} m={m} />
        ))}
      </div>
    </section>
  );
}

function MarketCard({ m }: { m: MarketPrediction }) {
  const entries = Object.entries(m.probabilities);
  const max = Math.max(...entries.map(([, v]) => v));
  return (
    <div className="rounded-2xl border border-border/60 card-elevated p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-display text-base font-semibold">{m.label}</div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            pick · <span className="text-primary">{m.pick}</span>
          </div>
        </div>
        {m.expected !== undefined && (
          <div className="rounded-lg bg-secondary px-2.5 py-1 text-right">
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
              expected
            </div>
            <div className="font-display text-sm font-bold text-primary">
              {m.expected.toFixed(1)}
            </div>
          </div>
        )}
      </div>
      <div className="mt-4 space-y-2">
        {entries.map(([k, v]) => {
          const isPick = v === max;
          return (
            <div key={k}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className={isPick ? "font-semibold text-foreground" : "text-muted-foreground"}>
                  {k}
                </span>
                <span
                  className={`font-mono tabular-nums ${
                    isPick ? "text-primary" : "text-muted-foreground"
                  }`}
                >
                  {v.toFixed(1)}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className={`h-full rounded-full transition-all ${
                    isPick ? "bg-primary" : "bg-muted-foreground/40"
                  }`}
                  style={{ width: `${Math.min(100, v)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FormSummary({ match, preds }: { match: MatchSummary; preds: MatchPredictions }) {
  const teams = [
    { team: match.homeTeam, form: preds.homeForm, label: "Home" },
    { team: match.awayTeam, form: preds.awayForm, label: "Away" },
  ];
  return (
    <section className="mt-6">
      <h2 className="mb-3 font-display text-lg font-bold">Recent form</h2>
      <div className="grid gap-3 md:grid-cols-2">
        {teams.map(({ team, form, label }) => (
          <div key={team.id} className="rounded-2xl border border-border/60 card-elevated p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  {label}
                </div>
                <div className="font-display text-base font-semibold">{team.name}</div>
              </div>
              <div className="flex gap-1">
                {(form?.last5 ?? []).map((r, i) => (
                  <span
                    key={i}
                    className={`flex h-7 w-7 items-center justify-center rounded-md font-mono text-xs font-bold ${
                      r === "W"
                        ? "bg-primary/20 text-primary"
                        : r === "D"
                        ? "bg-warning/20 text-warning"
                        : "bg-destructive/20 text-destructive"
                    }`}
                  >
                    {r}
                  </span>
                ))}
                {!form?.last5?.length && (
                  <span className="text-xs text-muted-foreground">no recent data</span>
                )}
              </div>
            </div>
            {form && form.played > 0 && (
              <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                <Stat label="P" v={form.played} />
                <Stat label="W-D-L" v={`${form.wins}-${form.draws}-${form.losses}`} />
                <Stat label="GF" v={form.goalsFor} />
                <Stat label="GA" v={form.goalsAgainst} />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Stat({ label, v }: { label: string; v: number | string }) {
  return (
    <div className="rounded-lg bg-secondary/60 py-2">
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
      <div className="font-display text-sm font-bold tabular-nums">{v}</div>
    </div>
  );
}

function OddsSection({
  matchId,
  userId,
  markets,
  odds,
  onChange,
}: {
  matchId: number;
  userId: string;
  markets: MarketPrediction[];
  odds: OddsRow[];
  onChange: () => Promise<void> | void;
}) {
  const [marketKey, setMarketKey] = useState<string>(markets[0]?.market ?? "1x2");
  const selected = markets.find((m) => m.market === marketKey) ?? markets[0];
  const [selection, setSelection] = useState<string>(
    selected ? Object.keys(selected.probabilities)[0] : "",
  );
  const [oddsValue, setOddsValue] = useState<string>("");
  const [bookmaker, setBookmaker] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // Reset selection when market changes
  useEffect(() => {
    const m = markets.find((x) => x.market === marketKey);
    if (m) setSelection(Object.keys(m.probabilities)[0] ?? "");
  }, [marketKey, markets]);

  const submit = async () => {
    const num = parseFloat(oddsValue.replace(",", "."));
    if (!selected || !selection || !(num > 1)) {
      toast.error("Enter decimal odds greater than 1");
      return;
    }
    setSaving(true);
    try {
      await upsertOdds({
        userId,
        matchId,
        market: selected.market,
        selection,
        decimalOdds: num,
        bookmaker: bookmaker.trim() || null,
        line: selected.line ?? null,
      });
      setOddsValue("");
      await onChange();
      toast.success("Odds saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteOdds(userId, id);
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  return (
    <section className="mt-6 rounded-2xl border border-border/60 card-elevated p-5">
      <div className="mb-3 flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-primary" />
        <h2 className="font-display text-lg font-bold">Bookmaker odds</h2>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          paste odds → see edge
        </span>
      </div>

      <div className="grid gap-2 md:grid-cols-[1.2fr_1.4fr_0.9fr_1fr_auto]">
        <select
          value={marketKey}
          onChange={(e) => setMarketKey(e.target.value)}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          {markets.map((m) => (
            <option key={m.market} value={m.market}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={selection}
          onChange={(e) => setSelection(e.target.value)}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          {selected &&
            Object.entries(selected.probabilities).map(([k, v]) => (
              <option key={k} value={k}>
                {k} · model {v.toFixed(1)}%
              </option>
            ))}
        </select>
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="1.01"
          placeholder="Odds (e.g. 2.10)"
          value={oddsValue}
          onChange={(e) => setOddsValue(e.target.value)}
        />
        <Input
          placeholder="Bookmaker (optional)"
          value={bookmaker}
          onChange={(e) => setBookmaker(e.target.value)}
        />
        <Button onClick={submit} disabled={saving} className="gap-1.5">
          <Plus className="h-4 w-4" /> Save
        </Button>
      </div>

      {odds.length > 0 && (
        <div className="mt-5 space-y-2">
          {odds.map((o) => {
            const market = markets.find((m) => m.market === o.market);
            const modelPct = market?.probabilities[o.selection];
            const decimalOdds = Number(o.decimal_odds);
            const impliedPct = (1 / decimalOdds) * 100;
            const edge =
              typeof modelPct === "number" ? modelPct - impliedPct : null;
            const ev =
              typeof modelPct === "number"
                ? (modelPct / 100) * decimalOdds * 100 - 100
                : null;
            return (
              <div
                key={o.id}
                className="grid grid-cols-1 gap-2 rounded-xl border border-border/60 bg-secondary/30 px-4 py-3 text-sm md:grid-cols-[1.5fr_1fr_1fr_1fr_auto] md:items-center"
              >
                <div>
                  <div className="font-display font-semibold">{market?.label ?? o.market}</div>
                  <div className="text-xs text-muted-foreground">
                    {o.selection}
                    {o.bookmaker ? ` · ${o.bookmaker}` : ""}
                  </div>
                </div>
                <Stat label="Odds" v={decimalOdds.toFixed(2)} />
                <Stat
                  label="Model"
                  v={typeof modelPct === "number" ? `${modelPct.toFixed(1)}%` : "—"}
                />
                <div className="rounded-lg bg-background/60 py-2 text-center">
                  <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                    Edge / EV
                  </div>
                  <div
                    className={`font-display text-sm font-bold tabular-nums ${
                      edge !== null && edge > 0
                        ? "text-primary"
                        : edge !== null
                        ? "text-destructive"
                        : ""
                    }`}
                  >
                    {edge !== null
                      ? `${edge > 0 ? "+" : ""}${edge.toFixed(1)}%`
                      : "—"}
                    {ev !== null && (
                      <span className="ml-1 font-mono text-[10px] opacity-70">
                        ({ev > 0 ? "+" : ""}
                        {ev.toFixed(1)})
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(o.id)}
                  aria-label="Remove odds"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
