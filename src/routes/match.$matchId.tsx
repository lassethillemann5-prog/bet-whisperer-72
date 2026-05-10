import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { getMatchH2H, getMatchWithPredictions, type H2HResponse } from "@/server/football.functions";
import type { MatchPredictions, MatchSummary, MarketPrediction } from "@/lib/football/types";
import { listTracked, trackMatch, untrackMatch } from "@/lib/football/tracked";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ChevronDown, History, Sparkles, Star, StarOff, TrendingUp } from "lucide-react";
import { Activity } from "lucide-react";
import { toast } from "sonner";
import { LogBetDialog } from "@/components/app/LogBetDialog";
import { useLiveScores } from "@/lib/football/useLiveScores";
import { LiveProbabilityBar } from "@/components/app/LiveProbabilityBar";
import { LiveBadge } from "@/components/app/LiveBadge";
import { FetchOddsButton } from "@/components/app/FetchOddsButton";
import type { MatchOddsResult, MarketOddsRow } from "@/server/football.functions";
import { fetchMatchOdds } from "@/server/football.functions";

export const Route = createFileRoute("/match/$matchId")({
  loader: async ({ params }) => {
    // Lightweight loader: fetch just enough to populate <head> metadata.
    // Falls back gracefully if the call fails — page still renders.
    try {
      const res = await getMatchWithPredictions({
        data: { matchId: Number(params.matchId) },
      });
      return {
        seo: {
          home: res.match.homeTeam.name,
          away: res.match.awayTeam.name,
          competition: res.match.competition?.name ?? null,
          utcDate: res.match.utcDate,
          crest: res.match.homeTeam.crest ?? res.match.awayTeam.crest ?? null,
          pick: res.predictions.markets[0]?.pick ?? null,
        },
      };
    } catch {
      return { seo: null as null | {
        home: string; away: string; competition: string | null;
        utcDate: string; crest: string | null; pick: string | null;
      } };
    }
  },
  head: ({ loaderData }) => {
    const seo = loaderData?.seo;
    if (!seo) {
      return {
        meta: [
          { title: "Match prediction — Pitchcast" },
          { name: "description", content: "Statistical and AI-powered football match prediction." },
        ],
      };
    }
    const compSuffix = seo.competition ? ` — ${seo.competition}` : "";
    const dateLabel = new Date(seo.utcDate).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const title = `${seo.home} vs ${seo.away}${compSuffix} prediction · Pitchcast`;
    const description = `Statistical and AI-driven prediction for ${seo.home} vs ${seo.away}${compSuffix} on ${dateLabel}. 1X2, BTTS, Over/Under goals, corners, shots and more.`;
    const meta: Array<Record<string, string>> = [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    ];
    if (seo.crest) {
      meta.push({ property: "og:image", content: seo.crest });
      meta.push({ name: "twitter:image", content: seo.crest });
    }
    return { meta };
  },
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
  const [h2h, setH2h] = useState<H2HResponse | null>(null);
  const [h2hBusy, setH2hBusy] = useState(false);

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
    ])
      .then(([res, tracked]) => {
        if (cancelled) return;
        setData(res);
        setIsTracked(tracked.some((t: { match_id: number }) => t.match_id === Number(matchId)));
        // Lazy-fetch H2H once we know team ids
        setH2hBusy(true);
        getMatchH2H({
          data: { homeTeamId: res.match.homeTeam.id, awayTeamId: res.match.awayTeam.id },
        })
          .then((r) => !cancelled && setH2h(r))
          .catch(() => {})
          .finally(() => !cancelled && setH2hBusy(false));
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
          <LiveSection
            matchId={data.match.id}
            preds={data.predictions}
          />
          <Commentary text={data.predictions.commentary} />
          <MarketsGrid markets={data.predictions.markets} />
          <FairOddsSection match={data.match} markets={data.predictions.markets} />
          <FormSummary match={data.match} preds={data.predictions} />
          <InjuryPanel match={data.match} preds={data.predictions} />
          <HeadToHead
            data={h2h}
            busy={h2hBusy}
            homeTeam={data.match.homeTeam}
            awayTeam={data.match.awayTeam}
          />
        </>
      )}
    </AppShell>
  );
}

function confidenceLabel(r?: number): { label: string; color: string } {
  if (r == null) return { label: "Unknown", color: "text-muted-foreground bg-secondary/60" };
  if (r >= 0.75) return { label: "High confidence", color: "text-emerald-400 bg-emerald-500/10" };
  if (r >= 0.4) return { label: "Medium confidence", color: "text-amber-400 bg-amber-500/10" };
  return { label: "Low confidence", color: "text-destructive bg-destructive/10" };
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
  const conf = confidenceLabel(preds.modelReliability);
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
        <div className="flex items-center gap-2">
          <span
            title={`Model reliability: ${preds.modelReliability != null ? Math.round(preds.modelReliability * 100) : "?"}%`}
            className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] ${conf.color}`}
          >
            {conf.label}
          </span>
          <Button variant="ghost" size="sm" onClick={onToggle} className="gap-1.5">
            {isTracked ? <StarOff className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />}
            {isTracked ? "Untrack" : "Track"}
          </Button>
        </div>
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

function LiveSection({
  matchId,
  preds,
}: {
  matchId: number;
  preds: MatchPredictions;
}) {
  const live = useLiveScores();
  const score = live.get(matchId);
  if (!score) return null;
  // Don't render for not-yet-started or fully finished matches
  const status = score.status;
  const isLiveOrHt = ["1H", "HT", "2H", "ET", "BT", "P", "LIVE"].includes(status);
  if (!isLiveOrHt) return null;
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-destructive/40 bg-destructive/[0.04] p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <LiveBadge score={score} />
          <span className="font-display text-sm font-bold">In-play probabilities</span>
        </div>
        <span className="font-mono text-xs tabular-nums text-foreground">
          {score.home ?? 0}–{score.away ?? 0}
        </span>
      </div>
      <LiveProbabilityBar
        preMatchXgHome={preds.expectedGoalsHome}
        preMatchXgAway={preds.expectedGoalsAway}
        score={score}
        variant="full"
      />
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        Recomputed every 30s from pre-match xG + live score
      </p>
    </section>
  );
}

function MarketsGrid({ markets }: { markets: MarketPrediction[] }) {
  const [open, setOpen] = useState(false);
  // Best pick: highest single-selection probability across all markets.
  const best = useMemo(() => {
    let top: { market: string; label: string; selection: string; probability: number } | null = null;
    for (const m of markets) {
      for (const [sel, p] of Object.entries(m.probabilities)) {
        if (!top || p > top.probability) {
          top = { market: m.label, label: m.label, selection: sel, probability: p };
        }
      }
    }
    return top;
  }, [markets]);

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-border/60 card-elevated">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-primary/[0.04]"
        aria-expanded={open}
      >
        <TrendingUp className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg font-bold leading-tight">Markets</div>
          {best ? (
            <div className="mt-0.5 flex items-center gap-2 text-xs">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                top pick
              </span>
              <span className="truncate font-medium text-foreground/90">
                {best.label} · <span className="text-primary">{best.selection}</span>
              </span>
              <span className="ml-auto font-mono text-xs tabular-nums text-primary">
                {best.probability.toFixed(1)}%
              </span>
            </div>
          ) : (
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              {markets.length} markets
            </div>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="grid gap-3 border-t border-border/40 p-5 md:grid-cols-2">
          {markets.map((m) => (
            <MarketCard key={m.market} m={m} />
          ))}
        </div>
      )}
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

function HeadToHead({
  data,
  busy,
  homeTeam,
  awayTeam,
}: {
  data: H2HResponse | null;
  busy: boolean;
  homeTeam: MatchSummary["homeTeam"];
  awayTeam: MatchSummary["awayTeam"];
}) {
  if (busy && !data) {
    return (
      <section className="mt-6 rounded-2xl border border-border/60 card-elevated p-5">
        <div className="mb-3 flex items-center gap-2">
          <History className="h-4 w-4 text-primary" />
          <h2 className="font-display text-lg font-bold">Head-to-head & recent results</h2>
        </div>
        <div className="h-32 animate-pulse rounded-xl bg-secondary/40" />
      </section>
    );
  }
  if (!data) return null;
  const totalH2H = data.h2h.length;
  return (
    <section className="mt-6 rounded-2xl border border-border/60 card-elevated p-5">
      <div className="mb-4 flex items-center gap-2">
        <History className="h-4 w-4 text-primary" />
        <h2 className="font-display text-lg font-bold">Head-to-head & recent results</h2>
      </div>

      {/* H2H summary bar */}
      {totalH2H > 0 ? (
        <div className="mb-5">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span className="truncate font-mono uppercase tracking-[0.15em]">{homeTeam.name}</span>
            <span className="font-mono uppercase tracking-[0.15em]">Last {totalH2H} H2H</span>
            <span className="truncate text-right font-mono uppercase tracking-[0.15em]">{awayTeam.name}</span>
          </div>
          <div className="flex h-3 overflow-hidden rounded-full bg-secondary">
            <div
              className="bg-primary"
              style={{ width: `${(data.summary.homeWins / totalH2H) * 100}%` }}
              title={`${homeTeam.name} wins`}
            />
            <div
              className="bg-muted-foreground/40"
              style={{ width: `${(data.summary.draws / totalH2H) * 100}%` }}
              title="Draws"
            />
            <div
              className="bg-destructive/70"
              style={{ width: `${(data.summary.awayWins / totalH2H) * 100}%` }}
              title={`${awayTeam.name} wins`}
            />
          </div>
          <div className="mt-1 flex items-center justify-between font-mono text-[11px] tabular-nums">
            <span className="text-primary">{data.summary.homeWins}W</span>
            <span className="text-muted-foreground">{data.summary.draws}D</span>
            <span className="text-destructive">{data.summary.awayWins}W</span>
          </div>
        </div>
      ) : (
        <p className="mb-5 text-sm text-muted-foreground">No prior head-to-head meetings on record.</p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <ResultsList title="Head-to-head" matches={data.h2h} highlightTeamId={homeTeam.id} />
        <div className="space-y-4">
          <ResultsList title={`${homeTeam.name} · last 5`} matches={data.homeRecent} highlightTeamId={homeTeam.id} compact />
          <ResultsList title={`${awayTeam.name} · last 5`} matches={data.awayRecent} highlightTeamId={awayTeam.id} compact />
        </div>
      </div>
    </section>
  );
}

function ResultsList({
  title,
  matches,
  highlightTeamId,
  compact = false,
}: {
  title: string;
  matches: H2HResponse["h2h"];
  highlightTeamId: number;
  compact?: boolean;
}) {
  return (
    <div>
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </div>
      {matches.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
          No data
        </div>
      ) : (
        <ul className={`space-y-1.5 ${compact ? "text-xs" : "text-sm"}`}>
          {matches.map((m) => {
            const homeIsTarget = m.homeTeam.id === highlightTeamId;
            const targetGoals = homeIsTarget ? m.scoreHome : m.scoreAway;
            const oppGoals = homeIsTarget ? m.scoreAway : m.scoreHome;
            let result: "W" | "D" | "L" | "?" = "?";
            if (targetGoals != null && oppGoals != null) {
              if (targetGoals > oppGoals) result = "W";
              else if (targetGoals < oppGoals) result = "L";
              else result = "D";
            }
            const date = new Date(m.utcDate);
            return (
              <li
                key={m.id}
                className="flex items-center gap-2 rounded-lg bg-secondary/40 px-2.5 py-1.5"
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold ${
                    result === "W"
                      ? "bg-primary/20 text-primary"
                      : result === "D"
                      ? "bg-muted-foreground/20 text-muted-foreground"
                      : "bg-destructive/20 text-destructive"
                  }`}
                >
                  {result}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className={homeIsTarget ? "font-semibold" : ""}>{m.homeTeam.name}</span>
                  <span className="mx-1.5 font-mono tabular-nums text-muted-foreground">
                    {m.scoreHome ?? "-"}–{m.scoreAway ?? "-"}
                  </span>
                  <span className={!homeIsTarget ? "font-semibold" : ""}>{m.awayTeam.name}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FairOddsSection({
  match,
  markets,
}: {
  match: MatchSummary;
  markets: MarketPrediction[];
}) {
  const [open, setOpen] = useState(false);
  const [oddsResult, setOddsResult] = useState<MatchOddsResult | null>(null);

  function findOdds(market: string, selection: string): MarketOddsRow | null {
    if (!oddsResult) return null;
    return (
      oddsResult.rows.find(
        (r) => r.market === market && r.selection.toLowerCase() === selection.toLowerCase(),
      ) ?? null
    );
  }

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-border/60 card-elevated">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-primary/[0.04]"
        aria-expanded={open}
      >
        <TrendingUp className="h-4 w-4 text-primary" />
        <div className="flex-1">
          <div className="font-display text-lg font-bold leading-tight">Fair odds & value</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {markets.length} markets · {oddsResult ? "vs bet365 / betano" : "fetch market prices to see edge"}
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border/40 p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Take a price above fair odds to bet with positive expected value.
            </p>
            <FetchOddsButton
              matchId={match.id}
              hasOdds={!!oddsResult && oddsResult.rows.length > 0}
              onFetched={setOddsResult}
            />
          </div>
          <div className="space-y-3">
            {markets.map((m) => (
              <FairOddsMarket key={m.market} match={match} m={m} findOdds={findOdds} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function InjuryPanel({ match, preds }: { match: MatchSummary; preds: MatchPredictions }) {
  const home = preds.homeInjuries;
  const away = preds.awayInjuries;
  // Hide entirely when no data on either side (e.g. lower-tier league).
  if (!home && !away) return null;
  const teams = [
    { team: match.homeTeam, inj: home, label: "Home" },
    { team: match.awayTeam, inj: away, label: "Away" },
  ];
  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <h2 className="font-display text-lg font-bold">Injuries & availability</h2>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {teams.map(({ team, inj, label }) => {
          const out = inj?.out ?? 0;
          const attackHit = inj ? Math.round((1 - inj.attackFactor) * 100) : 0;
          return (
            <div key={team.id} className="rounded-2xl border border-border/60 card-elevated p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    {label}
                  </div>
                  <div className="font-display text-base font-semibold">{team.name}</div>
                </div>
                <div
                  className={`rounded-md px-2.5 py-1 text-right font-mono text-[10px] uppercase tracking-[0.15em] ${
                    out === 0
                      ? "bg-emerald-500/10 text-emerald-400"
                      : out >= 4
                      ? "bg-destructive/10 text-destructive"
                      : "bg-warning/10 text-warning"
                  }`}
                >
                  {out === 0 ? "Full squad" : `${out} out`}
                  {attackHit > 0 && (
                    <div className="text-[9px] opacity-80">−{attackHit}% attack</div>
                  )}
                </div>
              </div>
              {inj && inj.notable.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {inj.notable.map((name) => (
                    <li
                      key={name}
                      className="rounded-md bg-secondary/60 px-2 py-1 text-xs text-muted-foreground"
                    >
                      {name}
                    </li>
                  ))}
                </ul>
              )}
              {!inj && (
                <p className="mt-3 text-xs text-muted-foreground">No injury data available.</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FairOddsMarket({
  match,
  m,
  findOdds,
}: {
  match: MatchSummary;
  m: MarketPrediction;
  findOdds: (market: string, selection: string) => MarketOddsRow | null;
}) {
  const entries = Object.entries(m.probabilities);

  // Compute edge for each selection so we can flag the market as containing value.
  const edgesWithSelection = entries.map(([selection, probPct]) => {
    const prob01 = Math.max(0.001, Math.min(0.999, probPct / 100));
    const oddsRow = findOdds(m.market, selection);
    const bestOdds = oddsRow?.best ?? null;
    const edgePct = bestOdds != null ? (prob01 * bestOdds - 1) * 100 : null;
    return { selection, probPct, prob01, oddsRow, bestOdds, edgePct };
  });
  const bestEdge = Math.max(...edgesWithSelection.map((e) => e.edgePct ?? -Infinity));
  const hasValue = bestEdge >= 5;
  const hasSmallEdge = !hasValue && bestEdge >= 0.5;

  return (
    <div className={`rounded-xl border bg-secondary/30 p-4 ${
      hasValue
        ? "border-primary/60 ring-1 ring-primary/30"
        : hasSmallEdge
        ? "border-emerald-500/40"
        : "border-border/50"
    }`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="font-display text-sm font-semibold">{m.label}</div>
        <div className="flex items-center gap-2">
          {hasValue && (
            <span className="rounded-full bg-primary/20 px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-primary font-bold">
              ✦ Value +{bestEdge.toFixed(1)}%
            </span>
          )}
          {hasSmallEdge && !hasValue && (
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-emerald-400">
              Edge +{bestEdge.toFixed(1)}%
            </span>
          )}
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            pick · <span className="text-primary">{m.pick}</span>
          </div>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {edgesWithSelection.map(({ selection, probPct, prob01, oddsRow, bestOdds, edgePct }) => {
          const fair = 1 / prob01;
          const isPick = selection === m.pick || probPct === Math.max(...entries.map(([, v]) => v));
          const isValueLeg = edgePct != null && edgePct >= 5;
          const edgeColor =
            edgePct == null
              ? ""
              : edgePct >= 5
              ? "text-primary font-bold"
              : edgePct >= 0.5
              ? "text-emerald-400"
              : edgePct >= -0.5
              ? "text-muted-foreground"
              : "text-destructive/80";
          return (
            <div
              key={selection}
              className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 ${
                isValueLeg
                  ? "bg-primary/15 ring-1 ring-primary/50"
                  : isPick
                  ? "bg-primary/10 ring-1 ring-primary/40"
                  : "bg-background/40"
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{selection}</span>
                  {isValueLeg && (
                    <span className="shrink-0 rounded bg-primary/20 px-1 font-mono text-[8px] uppercase tracking-wider text-primary">
                      VALUE
                    </span>
                  )}
                </div>
                <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {probPct.toFixed(1)}% · fair {fair.toFixed(2)}
                </div>
                {bestOdds != null && (
                  <div className="mt-1 flex items-center gap-2 font-mono text-[10px] tabular-nums">
                    <span className="text-muted-foreground">market {bestOdds.toFixed(2)}</span>
                    <span className={edgeColor}>
                      {edgePct! >= 0 ? "+" : ""}
                      {edgePct!.toFixed(1)}% edge
                    </span>
                  </div>
                )}
                {oddsRow && oddsRow.prices.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-1 font-mono text-[9px] text-muted-foreground/70">
                    {oddsRow.prices.map((p) => (
                      <span key={p.bookmaker} className="rounded bg-background/40 px-1">
                        {p.bookmaker} {p.price.toFixed(2)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <LogBetDialog
                seed={{
                  matchId: match.id,
                  homeTeam: match.homeTeam.name,
                  awayTeam: match.awayTeam.name,
                  competition: match.competition?.name ?? null,
                  utcDate: match.utcDate,
                  market: m.market,
                  selection,
                  decimalOdds: bestOdds ?? fair,
                  modelProbability: prob01,
                }}
                trigger={
                  <Button
                    size="sm"
                    variant={isValueLeg ? "default" : isPick ? "default" : "secondary"}
                    className="shrink-0"
                  >
                    Log bet
                  </Button>
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

