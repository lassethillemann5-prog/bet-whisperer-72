import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { getValuePicks, type ValuePick } from "@/server/valuePicks.functions";
import { fetchOddsForAllTracked } from "@/server/oddsApi.functions";
import { Button } from "@/components/ui/button";
import { ArrowRight, Filter, Sparkles, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/value")({
  component: ValuePage,
});

function ValuePage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [picks, setPicks] = useState<ValuePick[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minEdge, setMinEdge] = useState(0);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    getValuePicks({ data: { userId: user.id } })
      .then((res) => {
        if (cancelled) return;
        if (res.error) setError(res.error);
        setPicks(res.picks);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [user]);

  const reload = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const res = await getValuePicks({ data: { userId: user.id } });
      if (res.error) setError(res.error);
      setPicks(res.picks);
    } finally {
      setBusy(false);
    }
  };

  const fetchAll = async () => {
    if (!user) return;
    setFetching(true);
    try {
      const res = await fetchOddsForAllTracked({ data: { userId: user.id } });
      if (!res.ok) {
        toast.error(res.error);
      } else {
        toast.success(
          `Matched ${res.matched}/${res.total} · ${res.inserted ?? 0} odds saved`,
        );
        await reload();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to fetch odds");
    } finally {
      setFetching(false);
    }
  };

  const filtered = useMemo(() => picks.filter((p) => p.edgePct >= minEdge), [picks, minEdge]);
  const valueCount = picks.filter((p) => p.edgePct > 0).length;
  const matchRows = useMemo(() => groupByMatch(filtered), [filtered]);

  if (loading || !user) return null;

  return (
    <AppShell>
      <section className="mb-6 overflow-hidden rounded-3xl border border-border/60 card-elevated">
        <div className="relative grid gap-6 p-6 md:grid-cols-[1.5fr_1fr] md:p-10">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
              <Sparkles className="h-3 w-3" /> model vs market
            </div>
            <h1 className="mt-4 font-display text-4xl font-bold leading-tight md:text-5xl text-balance">
              Value <span className="text-primary">picks</span>.
            </h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground md:text-base">
              For every odds entry on a tracked match, we compare the bookmaker's implied probability
              to our model's probability. Positive edge = the model thinks you're getting a better
              price than the true odds.
            </p>
          </div>
          <div className="flex items-end md:justify-end">
            <div className="rounded-2xl border border-border/60 bg-secondary/40 p-5 text-right">
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Positive edges
              </div>
              <div className="mt-1 font-display text-4xl font-bold text-primary">{valueCount}</div>
              <div className="mt-1 text-xs text-muted-foreground">of {picks.length} odds tracked</div>
            </div>
          </div>
        </div>
      </section>

      <div className="mb-6 flex items-center gap-2">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          min edge
        </span>
        {[-100, 0, 3, 5, 10].map((e) => (
          <Button
            key={e}
            variant={minEdge === e ? "default" : "secondary"}
            size="sm"
            onClick={() => setMinEdge(e)}
          >
            {e === -100 ? "All" : `≥ ${e}%`}
          </Button>
        ))}
        <Button
          variant="default"
          size="sm"
          onClick={fetchAll}
          disabled={fetching}
          className="ml-auto gap-1.5"
        >
          {fetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {fetching ? "Fetching…" : "Fetch odds (API)"}
        </Button>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {busy ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-xl border border-border/60 bg-secondary/40"
            />
          ))}
        </div>
      ) : matchRows.length === 0 ? (
        <EmptyValue hasAny={picks.length > 0} />
      ) : (
        <PicksTable rows={matchRows} />
      )}
    </AppShell>
  );
}

interface MatchRow {
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  utcDate: string;
  goals: ValuePick | null; // best O/U pick (over_2.5 preferred, fallback over_1.5)
  btts: ValuePick | null; // best BTTS pick
  best: ValuePick | null; // overall highest edge
}

function groupByMatch(picks: ValuePick[]): MatchRow[] {
  const byMatch = new Map<number, ValuePick[]>();
  for (const p of picks) {
    const arr = byMatch.get(p.matchId) ?? [];
    arr.push(p);
    byMatch.set(p.matchId, arr);
  }

  const rows: MatchRow[] = [];
  for (const [matchId, list] of byMatch) {
    const first = list[0];
    const goalsCandidates = list.filter((p) => p.market === "ou_25" || p.market === "ou_15");
    // prefer 2.5 line
    const goals =
      goalsCandidates.find((p) => p.market === "ou_25") ??
      goalsCandidates.find((p) => p.market === "ou_15") ??
      null;
    const btts = list.find((p) => p.market === "btts") ?? null;
    const best = [...list].sort((a, b) => b.edgePct - a.edgePct)[0] ?? null;
    rows.push({
      matchId,
      homeTeam: first.homeTeam,
      awayTeam: first.awayTeam,
      competition: first.competition,
      utcDate: first.utcDate,
      goals,
      btts,
      best,
    });
  }

  rows.sort((a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());
  return rows;
}

function PicksTable({ rows }: { rows: MatchRow[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 card-elevated">
      {/* Header */}
      <div className="hidden md:grid grid-cols-[110px_1fr_110px_110px_140px] items-center gap-3 border-b border-border/50 bg-secondary/30 px-5 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <div>Date</div>
        <div className="text-center">Match</div>
        <div className="text-center">Goals</div>
        <div className="text-center">GG</div>
        <div className="text-center">Best Tip</div>
      </div>
      <div className="divide-y divide-border/50">
        {rows.map((r) => (
          <PickRow key={r.matchId} row={r} />
        ))}
      </div>
    </div>
  );
}

function PickRow({ row }: { row: MatchRow }) {
  const date = new Date(row.utcDate);
  return (
    <Link
      to="/match/$matchId"
      params={{ matchId: String(row.matchId) }}
      className="group grid grid-cols-1 md:grid-cols-[110px_1fr_110px_110px_140px] items-center gap-3 px-5 py-4 transition hover:bg-primary/[0.04]"
    >
      {/* Date */}
      <div className="flex md:flex-col items-center md:items-start justify-between gap-2">
        <div className="font-mono text-sm font-semibold tabular-nums">
          {date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </div>
        <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
          {date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </div>
      </div>

      {/* Match */}
      <div className="flex flex-col items-center text-center">
        {row.competition && (
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/80 truncate max-w-full">
            {row.competition}
          </div>
        )}
        <div className="font-display text-sm font-semibold leading-tight">
          <span>{row.homeTeam}</span>
          <span className="mx-2 text-muted-foreground">vs</span>
          <span>{row.awayTeam}</span>
        </div>
      </div>

      {/* Goals */}
      <div className="flex justify-center">
        <PickPill pick={row.goals} fallback="—" formatLabel={formatGoalsLabel} />
      </div>

      {/* GG (BTTS) */}
      <div className="flex justify-center">
        <PickPill pick={row.btts} fallback="—" formatLabel={formatBttsLabel} />
      </div>

      {/* Best Tip */}
      <div className="flex justify-center">
        <BestTipPill pick={row.best} />
      </div>
    </Link>
  );
}

function formatGoalsLabel(p: ValuePick): string {
  // "Over" -> O2.5, "Under" -> U2.5 (line from market key)
  const line = p.market === "ou_25" ? "2.5" : p.market === "ou_15" ? "1.5" : "";
  const side = p.selection.toLowerCase().startsWith("o") ? "O" : "U";
  return `${side}${line}`;
}

function formatBttsLabel(p: ValuePick): string {
  return p.selection.toLowerCase().startsWith("y") ? "YES" : "NO";
}

function PickPill({
  pick,
  fallback,
  formatLabel,
}: {
  pick: ValuePick | null;
  fallback: string;
  formatLabel: (p: ValuePick) => string;
}) {
  if (!pick) {
    return (
      <span className="font-mono text-[11px] text-muted-foreground/60">{fallback}</span>
    );
  }
  const positive = pick.edgePct > 0;
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
        {formatLabel(pick)}
      </span>
      <span
        className={`min-w-[52px] rounded-md px-2.5 py-1 text-center font-mono text-xs font-bold tabular-nums ${
          positive
            ? "bg-primary/20 text-primary"
            : "bg-secondary text-foreground/70"
        }`}
      >
        {pick.decimalOdds.toFixed(2)}
      </span>
    </div>
  );
}

function BestTipPill({ pick }: { pick: ValuePick | null }) {
  if (!pick) {
    return <span className="font-mono text-[11px] text-muted-foreground/60">—</span>;
  }
  const positive = pick.edgePct > 0;
  // short label
  let short = pick.selection;
  if (pick.market === "ou_25" || pick.market === "ou_15") short = formatGoalsLabel(pick);
  else if (pick.market === "btts") short = `GG ${formatBttsLabel(pick)}`;
  else if (pick.market === "1x2") {
    short = pick.selection === "1" ? "Home" : pick.selection === "2" ? "Away" : "Draw";
  }
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
        {short}
      </span>
      <div className="flex items-center gap-1.5">
        <span
          className={`min-w-[52px] rounded-md px-2.5 py-1 text-center font-mono text-xs font-bold tabular-nums ${
            positive
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-foreground/70"
          }`}
        >
          {pick.decimalOdds.toFixed(2)}
        </span>
        <span
          className={`font-mono text-[10px] font-bold tabular-nums ${
            positive ? "text-primary" : "text-muted-foreground"
          }`}
        >
          {positive ? "+" : ""}
          {pick.edgePct.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

function EmptyValue({ hasAny }: { hasAny: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-border/60 px-6 py-16 text-center">
      <p className="font-display text-lg font-semibold">
        {hasAny ? "No picks meet that edge filter" : "No odds entered yet"}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {hasAny
          ? "Lower the threshold or add more odds."
          : "Open a tracked match and add bookmaker odds — value picks will appear here."}
      </p>
      {!hasAny && (
        <Link
          to="/tracked"
          className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          Go to tracked matches <ArrowRight className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}
