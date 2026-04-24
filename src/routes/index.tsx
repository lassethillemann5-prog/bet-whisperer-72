import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { MatchCard } from "@/components/app/MatchCard";
import { getFixtures } from "@/server/football.functions";
import type { MatchSummary } from "@/lib/football/types";
import { listTracked, trackMatch, untrackMatch, type TrackedRow } from "@/lib/football/tracked";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Calendar, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [tracked, setTracked] = useState<TrackedRow[]>([]);
  const [days, setDays] = useState(7);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    Promise.all([getFixtures({ data: { days } }), listTracked(user.id)])
      .then(([res, trackedRows]) => {
        if (cancelled) return;
        if (res.error) setError(res.error);
        setMatches(res.matches);
        setTracked(trackedRows);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => !cancelled && setBusy(false));
    return () => { cancelled = true; };
  }, [user, days]);

  const trackedIds = useMemo(() => new Set(tracked.map((t) => t.match_id)), [tracked]);

  const filtered = useMemo(() => {
    if (!query.trim()) return matches;
    const q = query.toLowerCase();
    return matches.filter(
      (m) =>
        m.homeTeam.name.toLowerCase().includes(q) ||
        m.awayTeam.name.toLowerCase().includes(q) ||
        m.competition?.name?.toLowerCase().includes(q),
    );
  }, [matches, query]);

  const groupedByDay = useMemo(() => {
    const groups = new Map<string, MatchSummary[]>();
    for (const m of filtered) {
      const k = new Date(m.utcDate).toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
      });
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(m);
    }
    return Array.from(groups.entries());
  }, [filtered]);

  const toggleTrack = async (m: MatchSummary) => {
    if (!user) return;
    try {
      if (trackedIds.has(m.id)) {
        await untrackMatch(user.id, m.id);
        setTracked((t) => t.filter((x) => x.match_id !== m.id));
        toast.success("Removed from tracked");
      } else {
        await trackMatch({
          userId: user.id,
          matchId: m.id,
          competition: m.competition?.name ?? null,
          homeTeam: m.homeTeam.name,
          awayTeam: m.awayTeam.name,
          utcDate: m.utcDate,
        });
        // refetch
        setTracked(await listTracked(user.id));
        toast.success("Tracking match");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  if (loading || !user) return null;

  return (
    <AppShell>
      <Hero count={matches.length} days={days} />

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search team or league…"
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          {[3, 7, 14].map((d) => (
            <Button
              key={d}
              variant={days === d ? "default" : "secondary"}
              size="sm"
              onClick={() => setDays(d)}
              className="gap-1.5"
            >
              <Calendar className="h-3.5 w-3.5" />
              {d}d
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {busy ? (
        <SkeletonGrid />
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-8">
          {groupedByDay.map(([day, group]) => (
            <section key={day}>
              <div className="mb-3 flex items-center gap-3">
                <h2 className="font-display text-xl font-bold">{day}</h2>
                <div className="h-px flex-1 bg-border/60" />
                <span className="font-mono text-xs text-muted-foreground">
                  {group.length} match{group.length === 1 ? "" : "es"}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.map((m) => (
                  <MatchCard
                    key={m.id}
                    match={m}
                    isTracked={trackedIds.has(m.id)}
                    onToggleTrack={() => toggleTrack(m)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </AppShell>
  );
}

function Hero({ count, days }: { count: number; days: number }) {
  return (
    <section className="mb-8 overflow-hidden rounded-3xl border border-border/60 card-elevated">
      <div className="relative grid gap-6 p-6 md:grid-cols-[1.5fr_1fr] md:p-10">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
            <Sparkles className="h-3 w-3" />
            stats + ai across 6 markets
          </div>
          <h1 className="mt-4 font-display text-4xl font-bold leading-tight md:text-5xl text-balance">
            Predict every <span className="text-primary">match</span>.
            <br />
            Track every <span className="text-primary">edge</span>.
          </h1>
          <p className="mt-3 max-w-xl text-sm text-muted-foreground md:text-base">
            1X2 · Over/Under 1.5 & 2.5 goals · Corners · Shots · Shots on target.
            Statistical Poisson model paired with AI commentary on team form.
          </p>
        </div>
        <div className="flex items-end md:justify-end">
          <div className="rounded-2xl border border-border/60 bg-secondary/40 p-5 text-right">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Loaded
            </div>
            <div className="mt-1 font-display text-4xl font-bold text-primary">{count}</div>
            <div className="mt-1 text-xs text-muted-foreground">fixtures · next {days}d</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-36 animate-pulse rounded-2xl border border-border/60 bg-secondary/40"
        />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border/60 px-6 py-16 text-center">
      <p className="font-display text-lg font-semibold">No matches found</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Try widening the date range or clearing your search.
      </p>
    </div>
  );
}
