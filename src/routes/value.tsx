import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { getValuePicks, type ValuePick } from "@/server/valuePicks.functions";
import { fetchOddsForAllTracked } from "@/server/oddsApi.functions";
import { Button } from "@/components/ui/button";
import { TrendingUp, ArrowRight, Filter, Sparkles, Download, Loader2 } from "lucide-react";
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-2xl border border-border/60 bg-secondary/40"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyValue hasAny={picks.length > 0} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <PickCard key={p.oddsId} p={p} />
          ))}
        </div>
      )}
    </AppShell>
  );
}

function PickCard({ p }: { p: ValuePick }) {
  const positive = p.edgePct > 0;
  const date = new Date(p.utcDate);
  return (
    <Link
      to="/match/$matchId"
      params={{ matchId: String(p.matchId) }}
      className="group block rounded-2xl border border-border/60 card-elevated p-5 transition hover:border-primary/60"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground truncate">
          {p.competition ?? "—"}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ·{" "}
          {date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <div className="mt-2 font-display text-base font-bold leading-tight">
        {p.homeTeam} <span className="text-muted-foreground">vs</span> {p.awayTeam}
      </div>

      <div className="mt-3 rounded-xl border border-border/60 bg-secondary/40 px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {p.marketLabel}
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2">
          <div className="font-display text-sm font-semibold">{p.selection}</div>
          <div className="font-mono text-base font-bold tabular-nums text-primary">
            {p.decimalOdds.toFixed(2)}
          </div>
        </div>
        {p.bookmaker && (
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">@ {p.bookmaker}</div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Stat label="Model" value={`${(p.modelProb * 100).toFixed(1)}%`} />
        <Stat label="Implied" value={`${(p.impliedProb * 100).toFixed(1)}%`} />
        <Stat
          label="Edge"
          value={`${positive ? "+" : ""}${p.edgePct.toFixed(1)}%`}
          highlight={positive ? "good" : "bad"}
        />
      </div>

      <div
        className={`mt-3 inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] ${
          positive
            ? "bg-primary/15 text-primary"
            : "bg-destructive/10 text-destructive"
        }`}
      >
        <TrendingUp className="h-3 w-3" /> EV {p.evPct >= 0 ? "+" : ""}
        {p.evPct.toFixed(1)}%
        <ArrowRight className="ml-1 h-3 w-3 opacity-0 transition group-hover:opacity-100" />
      </div>
    </Link>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "good" | "bad";
}) {
  return (
    <div className="rounded-lg bg-secondary/60 py-2 text-center">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div
        className={`font-display text-sm font-bold tabular-nums ${
          highlight === "good"
            ? "text-primary"
            : highlight === "bad"
            ? "text-destructive"
            : ""
        }`}
      >
        {value}
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
