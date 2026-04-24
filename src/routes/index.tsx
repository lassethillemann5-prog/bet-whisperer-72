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
import { Calendar, ChevronLeft, ChevronRight, Search, Sparkles, Trophy } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [tracked, setTracked] = useState<TrackedRow[]>([]);
  const DAYS_WINDOW = 14;
  const [selectedDate, setSelectedDate] = useState<string>(() => isoDay(new Date()));
  const [query, setQuery] = useState("");
  const [competition, setCompetition] = useState<string>("all");
  const [visible, setVisible] = useState<number>(24);
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
    Promise.all([getFixtures({ data: { days: DAYS_WINDOW } }), listTracked(user.id)])
      .then(([res, trackedRows]) => {
        if (cancelled) return;
        if (res.error) setError(res.error);
        setMatches(res.matches);
        setTracked(trackedRows);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => !cancelled && setBusy(false));
    return () => { cancelled = true; };
  }, [user]);

  const trackedIds = useMemo(() => new Set(tracked.map((t) => t.match_id)), [tracked]);

  useEffect(() => {
    setVisible(24);
  }, [competition, query, selectedDate]);

  const dateOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of matches) {
      const k = isoDay(new Date(m.utcDate));
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const arr: { iso: string; label: string; weekday: string; count: number }[] = [];
    for (let i = 0; i < DAYS_WINDOW; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const iso = isoDay(d);
      arr.push({
        iso,
        label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        weekday:
          i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short" }),
        count: counts.get(iso) ?? 0,
      });
    }
    return arr;
  }, [matches]);

  const dayMatches = useMemo(
    () => matches.filter((m) => isoDay(new Date(m.utcDate)) === selectedDate),
    [matches, selectedDate],
  );

  const competitions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of dayMatches) {
      const name = m.competition?.name ?? "Other";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1]);
  }, [dayMatches]);

  const filtered = useMemo(() => {
    let out = dayMatches;
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
  }, [dayMatches, query, competition]);

  const PAGE_SIZE = 24;
  const shownMatches = filtered.slice(0, visible);
  const remaining = filtered.length - shownMatches.length;

  const shiftDate = (delta: number) => {
    const idx = dateOptions.findIndex((d) => d.iso === selectedDate);
    const next = Math.max(0, Math.min(dateOptions.length - 1, (idx === -1 ? 0 : idx) + delta));
    setSelectedDate(dateOptions[next].iso);
  };

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

  const selectedLabel = (() => {
    const d = new Date(selectedDate + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  })();

  return (
    <AppShell>
      <Hero count={matches.length} days={DAYS_WINDOW} />

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
          <Button variant="secondary" size="icon" onClick={() => shiftDate(-1)} aria-label="Previous day">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="rounded-md border border-border/60 bg-secondary/40 px-3 py-1.5 text-center min-w-[180px]">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground flex items-center justify-center gap-1.5">
              <Calendar className="h-3 w-3" /> {selectedLabel}
            </div>
          </div>
          <Button variant="secondary" size="icon" onClick={() => shiftDate(1)} aria-label="Next day">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mb-6 -mx-1 flex gap-2 overflow-x-auto pb-2 px-1">
        {dateOptions.map((d) => {
          const active = d.iso === selectedDate;
          return (
            <button
              key={d.iso}
              onClick={() => setSelectedDate(d.iso)}
              className={`shrink-0 rounded-xl border px-3 py-2 text-left transition ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/60 bg-secondary/40 hover:border-primary/60"
              }`}
            >
              <div
                className={`font-mono text-[10px] uppercase tracking-[0.18em] ${active ? "opacity-90" : "text-muted-foreground"}`}
              >
                {d.weekday}
              </div>
              <div className="font-display text-sm font-bold leading-tight">{d.label}</div>
              <div className={`mt-0.5 font-mono text-[10px] ${active ? "opacity-80" : "text-muted-foreground"}`}>
                {d.count} {d.count === 1 ? "match" : "matches"}
              </div>
            </button>
          );
        })}
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
            <span className="font-mono text-[10px] opacity-70">{dayMatches.length}</span>
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
        <section>
          <div className="mb-3 flex items-center gap-3">
            <h2 className="font-display text-xl font-bold">{selectedLabel}</h2>
            <div className="h-px flex-1 bg-border/60" />
            <span className="font-mono text-xs text-muted-foreground">
              {shownMatches.length}/{filtered.length}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shownMatches.map((m) => (
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
                onClick={() => setVisible((v) => v + PAGE_SIZE)}
              >
                Show {Math.min(PAGE_SIZE, remaining)} more · {remaining} left
              </Button>
            </div>
          )}
        </section>
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

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
