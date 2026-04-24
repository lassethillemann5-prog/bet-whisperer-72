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
import { Calendar, Search, Sparkles, Trophy } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [tracked, setTracked] = useState<TrackedRow[]>([]);
  const [days, setDays] = useState(3);
  const [query, setQuery] = useState("");
  const [competition, setCompetition] = useState<string>("all");
  const [visiblePerDay, setVisiblePerDay] = useState<Record<string, number>>({});
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

  const competitions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of matches) {
      const name = m.competition?.name ?? "Other";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1]);
  }, [matches]);

  const filtered = useMemo(() => {
    let out = matches;
    if (competition !== "all") {
      out = out.filter((m) => (m.competition?.name ?? "Other") === competition);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter(
        (m) =>
          m.homeTeam.name.toLowerCase().includes(q) ||
          m.awayTeam.name.toLowerCase().includes(q) ||
          m.competition?.name?.toLowerCase().includes(q),
      );
    }
    return out;
  }, [matches, query, competition]);

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

  const PAGE_SIZE = 24;
  const getVisible = (day: string) => visiblePerDay[day] ?? PAGE_SIZE;

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

      {competitions.length > 0 && (
        <div className="mb-6 -mx-1 flex gap-2 overflow-x-auto pb-2 px-1">
          <Button
            variant={competition === "all" ? "default" : "secondary"}
            size="sm"
            onClick={() => setCompetition("all")}
            className="shrink-0 gap-1.5"
          >
            <Trophy className="h-3.5 w-3.5" />
            All
            <span className="font-mono text-[10px] opacity-70">{matches.length}</span>
          </Button>
          {competitions.map(([name, count]) => (
            <Button
              key={name}
              variant={competition === name ? "default" : "secondary"}
              size="sm"
              onClick={() => setCompetition(name)}
              className="shrink-0 gap-1.5"
            >
              {name}
              <span className="font-mono text-[10px] opacity-70">{count}</span>
            </Button>
          ))}
        </div>
      )}

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
          {groupedByDay.map(([day, group]) => {
            const visible = getVisible(day);
            const shown = group.slice(0, visible);
            const remaining = group.length - shown.length;
            return (
              <section key={day}>
                <div className="mb-3 flex items-center gap-3">
                  <h2 className="font-display text-xl font-bold">{day}</h2>
                  <div className="h-px flex-1 bg-border/60" />
                  <span className="font-mono text-xs text-muted-foreground">
                    {shown.length}/{group.length}
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {shown.map((m) => (
                    <MatchCard
                      key={m.id}
                      match={m}
                      isTracked={trackedIds.has(m.id)}
                      onToggleTrack={() => toggleTrack(m)}
                    />
                  ))}
                </div>
                {remaining > 0 && (
                  <div className="mt-4 flex justify-center">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setVisiblePerDay((v) => ({
                          ...v,
                          [day]: visible + PAGE_SIZE,
                        }))
                      }
                    >
                      Show {Math.min(PAGE_SIZE, remaining)} more · {remaining} left
                    </Button>
                  </div>
                )}
              </section>
            );
          })}
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
