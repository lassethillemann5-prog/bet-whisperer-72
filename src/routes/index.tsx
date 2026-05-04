import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { MatchCard } from "@/components/app/MatchCard";
import {
  getCoachRecommendations,
  getFixtures,
  getPickOfTheDay,
  getTodayPredictions,
  type CoachMarket,
  type CoachRecommendation,
  type PickOfTheDayResponse,
  type TodayPickRow,
} from "@/server/football.functions";
import { askCoachChat, type CoachChatMessage } from "@/server/coachChat.functions";
import type { MatchSummary } from "@/lib/football/types";
import { listTracked, trackMatch, untrackMatch, type TrackedRow } from "@/lib/football/tracked";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Link } from "@tanstack/react-router";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Flame,
  RefreshCw,
  Search,
  Sparkles,
  Trophy,
  Bot,
  Crown,
  Clock,
  Send,
  MessageSquare,
  ListChecks,
  User as UserIcon,
  ArrowUpDown,
} from "lucide-react";
import { toast } from "sonner";
import { LogBetDialog } from "@/components/app/LogBetDialog";
import { tierLabel, unitsForProbability } from "@/lib/football/bankroll";
import { useLiveScores, useLiveScore as useLive, LiveScoresContext } from "@/lib/football/useLiveScores";
import { LiveBadge, LiveScoreLine } from "@/components/app/LiveBadge";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pitchcast — AI football match predictions, fixtures & live odds" },
      {
        name: "description",
        content:
          "Browse upcoming football fixtures with AI-powered predictions for 1X2, BTTS, Over/Under goals, corners, shots and same-game multis. Updated daily.",
      },
      { property: "og:title", content: "Pitchcast — AI football match predictions" },
      {
        property: "og:description",
        content:
          "Daily fixtures with statistical + AI predictions across 1X2, BTTS, O/U goals, corners and shots markets.",
      },
    ],
  }),
  component: IndexPage,
});

// Popularity ranking for competitions. Higher = more popular.
// Matched against competition name (case-insensitive substring match).
const COMPETITION_TIERS: Array<{ patterns: string[]; rank: number }> = [
  { patterns: ["uefa champions league", "champions league"], rank: 100 },
  { patterns: ["uefa europa league", "europa league"], rank: 90 },
  { patterns: ["uefa europa conference", "conference league"], rank: 80 },
  { patterns: ["premier league", "england - premier"], rank: 95 },
  { patterns: ["la liga", "laliga", "primera division", "spain - la liga"], rank: 92 },
  { patterns: ["serie a", "italy - serie a"], rank: 90 },
  { patterns: ["bundesliga"], rank: 88 },
  { patterns: ["ligue 1"], rank: 85 },
  { patterns: ["world cup", "fifa world cup"], rank: 100 },
  { patterns: ["euro championship", "uefa euro", "european championship"], rank: 95 },
  { patterns: ["copa america", "copa américa"], rank: 88 },
  { patterns: ["copa libertadores"], rank: 78 },
  { patterns: ["uefa nations league", "nations league"], rank: 78 },
  { patterns: ["fa cup"], rank: 70 },
  { patterns: ["copa del rey"], rank: 68 },
  { patterns: ["coppa italia"], rank: 65 },
  { patterns: ["dfb pokal", "dfb-pokal"], rank: 65 },
  { patterns: ["championship"], rank: 60 },
  { patterns: ["eredivisie"], rank: 58 },
  { patterns: ["primeira liga", "liga portugal"], rank: 58 },
  { patterns: ["mls", "major league soccer"], rank: 55 },
  { patterns: ["brasileirao", "brasileirão", "serie a brazil", "brazil - serie a"], rank: 60 },
];

function competitionPopularity(name?: string | null): number {
  if (!name) return 0;
  const n = name.toLowerCase();
  for (const tier of COMPETITION_TIERS) {
    if (tier.patterns.some((p) => n.includes(p))) return tier.rank;
  }
  return 10;
}

// True if the competition is in the curated "featured" set (any tier match).
function isFeaturedCompetition(name?: string | null): boolean {
  return competitionPopularity(name) > 10;
}

// Comparator: featured leagues first, then everything alphabetical by
// country, then league name. Used for popularity sort mode.
function compareCompetitions(
  a: { name?: string | null; country?: string | null } | null | undefined,
  b: { name?: string | null; country?: string | null } | null | undefined,
): number {
  const fa = isFeaturedCompetition(a?.name);
  const fb = isFeaturedCompetition(b?.name);
  if (fa !== fb) return fa ? -1 : 1;
  const ca = (a?.country ?? "").toLowerCase();
  const cb = (b?.country ?? "").toLowerCase();
  if (ca !== cb) return ca.localeCompare(cb);
  const na = (a?.name ?? "").toLowerCase();
  const nb = (b?.name ?? "").toLowerCase();
  return na.localeCompare(nb);
}

/**
 * Stable identifier for a competition that disambiguates leagues sharing the
 * same name across countries (e.g. "Premier League" exists in England, Russia,
 * Egypt, Ukraine, …). Uses country + name so each is filtered/grouped on its
 * own. Falls back gracefully when country is missing.
 */
function competitionKey(c?: { name?: string | null; country?: string | null } | null): string {
  const name = c?.name?.trim() || "Other";
  const country = c?.country?.trim();
  return country ? `${country} — ${name}` : name;
}

function competitionLabel(c?: { name?: string | null; country?: string | null } | null): string {
  return competitionKey(c);
}

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
  const [sortBy, setSortBy] = useState<"popularity" | "time">("popularity");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"fixtures" | "picks" | "coach">("fixtures");
  const [todayRows, setTodayRows] = useState<TodayPickRow[]>([]);
  const [todayBusy, setTodayBusy] = useState(false);
  const [todayMissing, setTodayMissing] = useState(0);
  const [todayComputed, setTodayComputed] = useState(0);
  const [todayLoaded, setTodayLoaded] = useState(false);
  const [pickOfDay, setPickOfDay] = useState<PickOfTheDayResponse["pick"]>(null);
  const [pickOfDayBusy, setPickOfDayBusy] = useState(false);
  // Live in-play scores — polled every 30s, shared across the whole page.
  const liveScores = useLiveScores();

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

  // Load Pick of the Day independently — uses cached predictions only, fast.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setPickOfDayBusy(true);
    getPickOfTheDay()
      .then((res) => !cancelled && setPickOfDay(res.pick))
      .catch(() => {})
      .finally(() => !cancelled && setPickOfDayBusy(false));
    return () => { cancelled = true; };
  }, [user]);

  const loadTodayPredictions = async () => {
    setTodayBusy(true);
    try {
      // First call: pull cached + compute up to N. Then keep calling in the
      // background until no fixtures remain pending (each call computes the
      // next batch). This makes the picks fill in quickly without waiting
      // on a single huge server call.
      let res = await getTodayPredictions({ data: { computeBudget: 8 } });
      setTodayRows(res.rows);
      setTodayMissing(res.missing);
      setTodayComputed(res.computed);
      setTodayLoaded(true);
      if (res.error) toast.error(res.error);

      let safety = 30; // cap total follow-up rounds
      while (res.missing > 0 && safety-- > 0) {
        res = await getTodayPredictions({ data: { computeBudget: 8 } });
        setTodayRows(res.rows);
        setTodayMissing(res.missing);
        setTodayComputed((c) => c + res.computed);
        if (res.computed === 0 && res.missing > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load today's picks");
    } finally {
      setTodayBusy(false);
    }
  };

  // Lazy-load today's picks only when the user actually opens the "Today's
  // picks" tab. Auto-loading on sign-in burned through the football API
  // credit budget by precomputing predictions for every fixture of the day,
  // even when the user never looked at them.
  useEffect(() => {
    if (user && tab === "picks" && !todayLoaded && !todayBusy) {
      void loadTodayPredictions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, tab, todayLoaded]);

  const trackedIds = useMemo(() => new Set(tracked.map((t) => t.match_id)), [tracked]);

  // Sort today's rows by best-pick probability descending (rows without
  // predictions sink to the bottom).
  const sortedTodayRows = useMemo(() => {
    const withProb = todayRows.filter((r) => r.best);
    const without = todayRows.filter((r) => !r.best);
    withProb.sort((a, b) => (b.best?.probability ?? 0) - (a.best?.probability ?? 0));
    return [...withProb, ...without];
  }, [todayRows]);

  useEffect(() => {
    setVisible(24);
  }, [competition, query, selectedDate, sortBy]);

  const dateOptions = useMemo(() => {
    const counts = new Map<string, number>();
    const now = Date.now();
    for (const m of matches) {
      if (new Date(m.utcDate).getTime() <= now) continue;
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

  const dayMatches = useMemo(() => {
    const now = Date.now();
    return matches.filter((m) => {
      if (isoDay(new Date(m.utcDate)) !== selectedDate) return false;
      // Hide matches whose kickoff has already passed (any day).
      if (new Date(m.utcDate).getTime() <= now) return false;
      return true;
    });
  }, [matches, selectedDate]);

  const competitions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of dayMatches) {
      const key = competitionKey(m.competition);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1]);
  }, [dayMatches]);

  const filtered = useMemo(() => {
    let out = dayMatches;
    if (competition !== "all") {
      out = out.filter((m) => competitionKey(m.competition) === competition);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter(
        (m) =>
          m.homeTeam.name.toLowerCase().includes(q) ||
          m.awayTeam.name.toLowerCase().includes(q) ||
          m.competition?.name?.toLowerCase().includes(q) ||
          m.competition?.country?.toLowerCase().includes(q),
      );
    }
    return out;
  }, [dayMatches, query, competition]);

  // Sort the full filtered list according to the active sort mode, then paginate.
  const sortedFiltered = useMemo(() => {
    const arr = [...filtered];
    if (sortBy === "time") {
      arr.sort((a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());
    } else {
      // Featured leagues first, then alphabetical by country, then kickoff.
      arr.sort((a, b) => {
        const c = compareCompetitions(a.competition, b.competition);
        if (c !== 0) return c;
        return new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime();
      });
    }
    return arr;
  }, [filtered, sortBy]);

  const PAGE_SIZE = 24;
  const shownMatches = sortedFiltered.slice(0, visible);
  const remaining = sortedFiltered.length - shownMatches.length;

  // Group shown matches by competition name. Group order depends on sort mode:
  // - popularity: by tier rank (top leagues first)
  // - time: by earliest kickoff in the group
  const groupedShown = useMemo(() => {
    const groups = new Map<string, MatchSummary[]>();
    for (const m of shownMatches) {
      const key = competitionKey(m.competition);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());
    }
    return Array.from(groups.entries()).sort((a, b) => {
      if (sortBy === "time") {
        const ea = Math.min(...a[1].map((m) => new Date(m.utcDate).getTime()));
        const eb = Math.min(...b[1].map((m) => new Date(m.utcDate).getTime()));
        return ea - eb;
      }
      // Featured leagues first, then alphabetical by country + league name.
      return compareCompetitions(a[1][0]?.competition, b[1][0]?.competition);
    });
  }, [shownMatches, sortBy]);

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
      <LiveScoresContext.Provider value={liveScores}>
      <Hero count={matches.length} days={DAYS_WINDOW} />
      <PickOfTheDayBanner pick={pickOfDay} busy={pickOfDayBusy} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as "fixtures" | "picks" | "coach")} className="mb-6">
        <TabsList className="h-10 p-1">
          <TabsTrigger value="fixtures" className="gap-1.5">
            <Calendar className="h-3.5 w-3.5" />
            All fixtures
          </TabsTrigger>
          <TabsTrigger value="picks" className="gap-1.5">
            <Flame className="h-3.5 w-3.5" />
            Today's picks
            {todayRows.length > 0 && (
              <span className="ml-1 rounded-md bg-primary/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-primary">
                {todayRows.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="coach" className="gap-1.5">
            <Bot className="h-3.5 w-3.5" />
            AI Coach
          </TabsTrigger>
        </TabsList>

        <TabsContent value="picks" className="mt-6">
          <TodaysPicksPanel
            rows={sortedTodayRows}
            busy={todayBusy}
            missing={todayMissing}
            computed={todayComputed}
            onRefresh={loadTodayPredictions}
          />
        </TabsContent>

        <TabsContent value="coach" className="mt-6">
          <CoachPanel />
        </TabsContent>

        <TabsContent value="fixtures" className="mt-6">
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
          <div className="flex items-center gap-1 rounded-md border border-border/60 bg-secondary/40 p-1">
            <ArrowUpDown className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
            <button
              type="button"
              onClick={() => setSortBy("popularity")}
              className={`rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition ${
                sortBy === "popularity"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Popularity
            </button>
            <button
              type="button"
              onClick={() => setSortBy("time")}
              className={`rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition ${
                sortBy === "time"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Time
            </button>
          </div>
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
          {competitions.map(([key, count]) => {
            const [country, league] = key.includes(" — ")
              ? key.split(" — ")
              : ["", key];
            const active = competition === key;
            return (
              <Button
                key={key}
                variant={active ? "default" : "secondary"}
                size="sm"
                onClick={() => setCompetition(key)}
                className="shrink-0 h-auto py-1.5 gap-2"
              >
                <div className="flex flex-col items-start leading-tight text-left">
                  {country && (
                    <span
                      className={`font-mono text-[9px] uppercase tracking-[0.15em] ${
                        active ? "opacity-80" : "text-muted-foreground"
                      }`}
                    >
                      {country}
                    </span>
                  )}
                  <span className="text-xs font-semibold">{league}</span>
                </div>
                <span className="font-mono text-[10px] opacity-70">{count}</span>
              </Button>
            );
          })}
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
          <Accordion
            type="multiple"
            defaultValue={groupedShown.map(([name]) => name)}
            className="space-y-2"
          >
            {groupedShown.map(([name, group]) => (
              <AccordionItem
                key={name}
                value={name}
                className="rounded-2xl border border-border/60 bg-secondary/30 px-4"
              >
                <AccordionTrigger className="hover:no-underline py-3">
                  <div className="flex items-center gap-3">
                    <Trophy className="h-4 w-4 text-primary" />
                    <span className="font-display text-sm font-bold">{name}</span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      {group.length} {group.length === 1 ? "match" : "matches"}
                    </span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="pb-4 pt-1">
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
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
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
        </TabsContent>
      </Tabs>
      </LiveScoresContext.Provider>
    </AppShell>
  );
}

function PickOfTheDayBanner({
  pick,
  busy,
}: {
  pick: PickOfTheDayResponse["pick"];
  busy: boolean;
}) {
  if (busy && !pick) {
    return (
      <div className="mb-6 h-24 animate-pulse rounded-2xl border border-border/60 bg-secondary/40" />
    );
  }
  if (!pick) return null;
  const kickoff = new Date(pick.kickoff);
  const conf =
    pick.probability >= 70 ? "high" : pick.probability >= 60 ? "medium" : "lean";
  return (
    <Link
      to="/match/$matchId"
      params={{ matchId: String(pick.matchId) }}
      className="group mb-8 block overflow-hidden rounded-2xl border border-primary/40 bg-gradient-to-r from-primary/15 via-primary/5 to-secondary/30 transition hover:border-primary"
    >
      <div className="grid items-center gap-4 p-5 sm:grid-cols-[auto_1fr_auto] sm:p-6">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/20 text-primary">
          <Crown className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
            <span>Pick of the day</span>
            {pick.competition && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-primary/90">
                {pick.competition}
              </span>
            )}
            <span className="rounded-full bg-secondary/60 px-2 py-0.5 text-muted-foreground">
              {conf} confidence
            </span>
          </div>
          <div className="mt-1 truncate font-display text-lg font-bold sm:text-xl">
            {pick.homeTeam} vs {pick.awayTeam}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {kickoff.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="font-mono">
              {pick.marketLabel} · <span className="text-foreground">{pick.selectionLabel}</span>
            </span>
            <span className="font-mono tabular-nums">
              xG {pick.expectedGoals.home.toFixed(1)}–{pick.expectedGoals.away.toFixed(1)}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Model
          </div>
          <div className="font-display text-3xl font-bold tabular-nums text-primary">
            {pick.probability.toFixed(0)}%
          </div>
        </div>
      </div>
    </Link>
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

function TodaysPicksPanel({
  rows,
  busy,
  missing,
  computed,
  onRefresh,
}: {
  rows: TodayPickRow[];
  busy: boolean;
  missing: number;
  computed: number;
  onRefresh: () => void;
}) {
  const [pickQuery, setPickQuery] = useState("");
  const [pickComp, setPickComp] = useState<string>("all");
  // Multi-select set of allowed markets (matched against r.best.market).
  // Defaults to ALL markets selected — same effect as the old "all" value.
  const ALL_PICK_MARKETS = ["1x2", "ou_25", "btts"] as const;
  type PickMarket = (typeof ALL_PICK_MARKETS)[number];
  const [pickMarkets, setPickMarkets] = useState<Set<PickMarket>>(
    () => new Set(ALL_PICK_MARKETS),
  );
  const [minConf, setMinConf] = useState<number>(0);
  const [now, setNow] = useState(() => Date.now());

  // Tick every 30s so matches that have kicked off disappear automatically.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const upcomingRows = useMemo(
    () => rows.filter((r) => new Date(r.match.utcDate).getTime() > now),
    [rows, now],
  );

  const competitions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of upcomingRows) {
      const key = competitionKey(r.match.competition);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [upcomingRows]);

  const filtered = useMemo(() => {
    let out = upcomingRows;
    if (pickComp !== "all") {
      out = out.filter((r) => competitionKey(r.match.competition) === pickComp);
    }
    if (pickMarkets.size > 0 && pickMarkets.size < ALL_PICK_MARKETS.length) {
      out = out.filter((r) =>
        r.best ? pickMarkets.has(r.best.market as PickMarket) : false,
      );
    } else if (pickMarkets.size === 0) {
      out = [];
    }
    if (minConf > 0) {
      out = out.filter((r) => (r.best?.probability ?? 0) >= minConf);
    }
    if (pickQuery.trim()) {
      const q = pickQuery.toLowerCase();
      out = out.filter(
        (r) =>
          r.match.homeTeam.name.toLowerCase().includes(q) ||
          r.match.awayTeam.name.toLowerCase().includes(q) ||
          r.match.competition?.name?.toLowerCase().includes(q) ||
          r.match.competition?.country?.toLowerCase().includes(q),
      );
    }
    return out;
  }, [upcomingRows, pickComp, pickMarkets, minConf, pickQuery]);

  const confSteps: { label: string; value: number }[] = [
    { label: "Any", value: 0 },
    { label: "≥ 50%", value: 50 },
    { label: "≥ 60%", value: 60 },
    { label: "≥ 70%", value: 70 },
    { label: "≥ 80%", value: 80 },
  ];

  const pickMarketChips: { label: string; value: PickMarket }[] = [
    { label: "1X2", value: "1x2" },
    { label: "O/U 2.5", value: "ou_25" },
    { label: "BTTS", value: "btts" },
  ];
  const togglePickMarket = (m: PickMarket) => {
    setPickMarkets((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  };
  const allPickMarketsOn = pickMarkets.size === ALL_PICK_MARKETS.length;

  const activeFilters =
    (pickComp !== "all" ? 1 : 0) +
    (allPickMarketsOn ? 0 : 1) +
    (minConf > 0 ? 1 : 0) +
    (pickQuery.trim() ? 1 : 0);

  if (busy && upcomingRows.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-2xl border border-border/60 bg-secondary/40"
          />
        ))}
      </div>
    );
  }
  if (upcomingRows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/60 px-6 py-16 text-center">
        <p className="font-display text-lg font-semibold">No upcoming fixtures today</p>
        <p className="mt-1 text-sm text-muted-foreground">
          All of today's matches have already kicked off. Browse upcoming days on the Fixtures tab.
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-xl font-bold">Today's model probabilities</h2>
        <div className="h-px flex-1 bg-border/60" />
        <span className="font-mono text-xs text-muted-foreground">
          {filtered.length}/{upcomingRows.length}{" "}
          {upcomingRows.length === 1 ? "match" : "matches"}
          {computed > 0 && ` · ${computed} freshly computed`}
        </span>
        {missing > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            disabled={busy}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
            Compute {Math.min(missing, 8)} more
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="mb-4 space-y-3 rounded-2xl border border-border/60 bg-secondary/30 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={pickQuery}
              onChange={(e) => setPickQuery(e.target.value)}
              placeholder="Search team or league…"
              className="pl-9"
            />
          </div>
          {activeFilters > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPickQuery("");
                setPickComp("all");
                setPickMarkets(new Set(ALL_PICK_MARKETS));
                setMinConf(0);
              }}
            >
              Clear ({activeFilters})
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Market
            </span>
            <div className="-mx-1 flex flex-1 gap-1.5 overflow-x-auto px-1">
              <Button
                variant={allPickMarketsOn ? "default" : "secondary"}
                size="sm"
                onClick={() => setPickMarkets(new Set(ALL_PICK_MARKETS))}
                className="shrink-0"
              >
                All
              </Button>
              {pickMarketChips.map((m) => {
                const active = pickMarkets.has(m.value);
                return (
                  <Button
                    key={m.value}
                    variant={active ? "default" : "secondary"}
                    size="sm"
                    onClick={() => togglePickMarket(m.value)}
                    className="shrink-0"
                  >
                    {m.label}
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Conf.
            </span>
            <div className="-mx-1 flex flex-1 gap-1.5 overflow-x-auto px-1">
              {confSteps.map((c) => (
                <Button
                  key={c.value}
                  variant={minConf === c.value ? "default" : "secondary"}
                  size="sm"
                  onClick={() => setMinConf(c.value)}
                  className="shrink-0"
                >
                  {c.label}
                </Button>
              ))}
            </div>
          </div>

          {competitions.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                League
              </span>
              <div className="-mx-1 flex flex-1 gap-1.5 overflow-x-auto px-1">
                <Button
                  variant={pickComp === "all" ? "default" : "secondary"}
                  size="sm"
                  onClick={() => setPickComp("all")}
                  className="shrink-0 gap-1.5"
                >
                  <Trophy className="h-3.5 w-3.5" />
                  All
                  <span className="font-mono text-[10px] opacity-70">{upcomingRows.length}</span>
                </Button>
                {competitions.map(([name, count]) => (
                  <Button
                    key={name}
                    variant={pickComp === name ? "default" : "secondary"}
                    size="sm"
                    onClick={() => setPickComp(name)}
                    className="shrink-0 gap-1.5"
                  >
                    {name}
                    <span className="font-mono text-[10px] opacity-70">{count}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 px-6 py-12 text-center">
          <p className="font-display text-base font-semibold">No matches match your filters</p>
          <p className="mt-1 text-sm text-muted-foreground">Try clearing some filters above.</p>
        </div>
      ) : (
        <PicksTable rows={filtered} />
      )}
    </div>
  );
}

function PicksTable({ rows }: { rows: TodayPickRow[] }) {
  return (
    <div className="space-y-2.5">
      {/* Desktop header (above the cards) */}
      <div className="hidden md:grid grid-cols-[70px_1.6fr_1.3fr_1fr_1fr_1.1fr_36px] items-center gap-3 px-5 pb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
        <div>Time</div>
        <div>Match</div>
        <div className="text-center">1 · X · 2</div>
        <div className="text-center">O/U 2.5</div>
        <div className="text-center">BTTS</div>
        <div className="text-center">Best pick</div>
        <div />
      </div>
      {rows.map((row) => (
        <PickTableRow key={row.match.id} row={row} />
      ))}
    </div>
  );
}

function PickTableRow({ row }: { row: TodayPickRow }) {
  const date = new Date(row.match.utcDate);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const [expanded, setExpanded] = useState(false);
  const hasExtras =
    !!(row.doubleChance || row.dnb || row.ah || row.homeToScore || row.awayToScore || row.cards);
  const noData = row.noData === true;
  const live = useLive(row.match.id);

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border transition card-elevated ${
        noData
          ? "border-border/40 bg-background/40 opacity-70"
          : "border-border/60 hover:border-primary/40 hover:bg-primary/[0.04] hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.15)]"
      }`}
    >
      {/* Full-card click overlay (sits below the chevron via z-index) */}
      <Link
        to="/match/$matchId"
        params={{ matchId: String(row.match.id) }}
        className="absolute inset-0 z-10"
        aria-label={`Open ${row.match.homeTeam.name} vs ${row.match.awayTeam.name}`}
      />
      <div className="relative grid grid-cols-1 md:grid-cols-[70px_1.6fr_1.3fr_1fr_1fr_1.1fr_36px] items-center gap-3 px-5 py-4">
        {/* Time */}
      <div className="flex md:flex-col md:items-start items-center justify-between gap-2">
        {live ? (
          <>
            <LiveBadge score={live} />
            <LiveScoreLine score={live} />
          </>
        ) : (
          <>
            <span className="font-mono text-sm font-bold tabular-nums">{time}</span>
            <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground md:mt-0.5">
              today
            </span>
          </>
        )}
      </div>

      {/* Match */}
      <div className="min-w-0">
        {row.match.competition?.name && (
          <div className="mb-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/80 truncate">
            {row.match.competition.name}
          </div>
        )}
        <div className="truncate font-display text-sm font-semibold">
          {row.match.homeTeam.shortName ?? row.match.homeTeam.name}
          <span className="mx-2 text-muted-foreground">vs</span>
          {row.match.awayTeam.shortName ?? row.match.awayTeam.name}
        </div>
      </div>

      {/* 1X2 */}
      <div>
        {noData ? (
          <NoDataCell />
        ) : row.oneXTwo ? (
          <div className="grid grid-cols-3 gap-1">
            <ProbCell label="1" value={row.oneXTwo.home} highlight={isMax(row.oneXTwo.home, [row.oneXTwo.home, row.oneXTwo.draw, row.oneXTwo.away])} />
            <ProbCell label="X" value={row.oneXTwo.draw} highlight={isMax(row.oneXTwo.draw, [row.oneXTwo.home, row.oneXTwo.draw, row.oneXTwo.away])} />
            <ProbCell label="2" value={row.oneXTwo.away} highlight={isMax(row.oneXTwo.away, [row.oneXTwo.home, row.oneXTwo.draw, row.oneXTwo.away])} />
          </div>
        ) : (
          <PendingCell />
        )}
      </div>

      {/* O/U 2.5 */}
      <div>
        {noData ? (
          <NoDataCell />
        ) : row.ou25 ? (
          <div className="grid grid-cols-2 gap-1">
            <ProbCell label="O" value={row.ou25.over} highlight={row.ou25.over >= row.ou25.under} />
            <ProbCell label="U" value={row.ou25.under} highlight={row.ou25.under > row.ou25.over} />
          </div>
        ) : (
          <PendingCell />
        )}
      </div>

      {/* BTTS */}
      <div>
        {noData ? (
          <NoDataCell />
        ) : row.btts ? (
          <div className="grid grid-cols-2 gap-1">
            <ProbCell label="Y" value={row.btts.yes} highlight={row.btts.yes >= row.btts.no} />
            <ProbCell label="N" value={row.btts.no} highlight={row.btts.no > row.btts.yes} />
          </div>
        ) : (
          <PendingCell />
        )}
      </div>

      {/* Best pick */}
      <div className="flex justify-center">
        {noData ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground/60">
            no form data
          </span>
        ) : row.best ? (
          <div className="flex flex-col items-center gap-0.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-primary">
              {row.best.label}
            </span>
            <span className="font-display text-base font-bold tabular-nums text-primary">
              {row.best.probability.toFixed(0)}%
            </span>
          </div>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground/60">pending…</span>
        )}
      </div>

        {/* Expand toggle */}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          disabled={!hasExtras || noData}
          aria-label={expanded ? "Hide more markets" : "Show more markets"}
          aria-expanded={expanded}
          className="relative z-20 hidden md:flex h-8 w-8 items-center justify-center justify-self-end rounded-md border border-border/60 bg-background/60 text-muted-foreground transition hover:border-primary/40 hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {/* Mobile: show a compact "More" toggle below the row */}
      {hasExtras && !noData && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="relative z-20 md:hidden flex w-full items-center justify-center gap-1.5 border-t border-border/40 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground hover:bg-primary/5 hover:text-primary"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Hide more markets" : "More markets"}
        </button>
      )}

      {expanded && hasExtras && <ExtraMarketsPanel row={row} />}
    </div>
  );
}

function ExtraMarketsPanel({ row }: { row: TodayPickRow }) {
  return (
    <div className="border-t border-border/40 bg-secondary/20 px-4 py-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {row.doubleChance && (
          <ExtraMarketCard
            title="Double Chance"
            pick={row.doubleChance.pick}
            entries={[
              ["1X", row.doubleChance.oneX],
              ["12", row.doubleChance.twelve],
              ["X2", row.doubleChance.xTwo],
            ]}
          />
        )}
        {row.dnb && (
          <ExtraMarketCard
            title="Draw No Bet"
            pick={row.dnb.pick}
            entries={[
              ["Home", row.dnb.home],
              ["Away", row.dnb.away],
            ]}
          />
        )}
        {row.ah && (
          <ExtraMarketCard
            title={`Asian Handicap`}
            pick={row.ah.pick}
            entries={[
              [row.ah.homeLabel, row.ah.home],
              [row.ah.awayLabel, row.ah.away],
            ]}
          />
        )}
        {row.homeToScore && (
          <ExtraMarketCard
            title="Home to Score"
            pick={row.homeToScore.pick}
            entries={[
              ["Yes", row.homeToScore.yes],
              ["No", row.homeToScore.no],
            ]}
          />
        )}
        {row.awayToScore && (
          <ExtraMarketCard
            title="Away to Score"
            pick={row.awayToScore.pick}
            entries={[
              ["Yes", row.awayToScore.yes],
              ["No", row.awayToScore.no],
            ]}
          />
        )}
        {row.cards && (
          <ExtraMarketCard
            title={`Cards O/U ${row.cards.line}`}
            pick={row.cards.pick}
            entries={[
              [`Over ${row.cards.line}`, row.cards.over],
              [`Under ${row.cards.line}`, row.cards.under],
            ]}
          />
        )}
      </div>
    </div>
  );
}

function ExtraMarketCard({
  title,
  pick,
  entries,
}: {
  title: string;
  pick: string;
  entries: [string, number][];
}) {
  const max = Math.max(...entries.map(([, v]) => v));
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground">
          {title}
        </span>
      </div>
      <div className="mb-1.5 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-primary">
        {pick}
      </div>
      <div className="space-y-1">
        {entries.map(([k, v]) => {
          const hi = v === max && v > 0;
          return (
            <div
              key={k}
              className={`flex items-center justify-between rounded px-1.5 py-0.5 text-[11px] ${
                hi ? "bg-primary/10 text-primary" : "text-foreground/70"
              }`}
            >
              <span className="truncate font-mono uppercase tracking-wider">{k}</span>
              <span className="font-mono font-bold tabular-nums">{v.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProbCell({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center rounded-md px-1 py-1 ${
        highlight ? "bg-primary/15 text-primary" : "bg-secondary/50 text-foreground/70"
      }`}
    >
      <span className="font-mono text-[9px] uppercase tracking-wider opacity-80">{label}</span>
      <span className="font-mono text-xs font-bold tabular-nums">{value.toFixed(0)}%</span>
    </div>
  );
}

function isMax(v: number, all: number[]): boolean {
  return v >= Math.max(...all) && v > 0;
}

function PendingCell() {
  return (
    <div className="flex items-center justify-center rounded-md bg-secondary/40 px-2 py-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        pending
      </span>
    </div>
  );
}

function NoDataCell() {
  return (
    <div className="flex items-center justify-center rounded-md border border-dashed border-border/40 bg-background/30 px-2 py-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/40">
        —
      </span>
    </div>
  );
}

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function CoachPanel() {
  const [mode, setMode] = useState<"chat" | "picks">("chat");

  return (
    <div className="space-y-6">
      <div className="inline-flex rounded-xl border border-border/60 bg-secondary/40 p-1">
        <button
          onClick={() => setMode("chat")}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
            mode === "chat"
              ? "bg-primary text-primary-foreground shadow"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          Chat
        </button>
        <button
          onClick={() => setMode("picks")}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
            mode === "picks"
              ? "bg-primary text-primary-foreground shadow"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <ListChecks className="h-3.5 w-3.5" />
          Quick picks
        </button>
      </div>
      {mode === "chat" ? <CoachChatPanel /> : <CoachPicksPanel />}
    </div>
  );
}

function CoachChatPanel() {
  const { user } = useAuth();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<CoachChatMessage[]>([]);

  const suggestions = [
    "Give me 3 balanced bets for tonight",
    "Anything safe in my tracked matches?",
    "What's my best value pick today?",
    "How is my bankroll doing?",
  ];

  const send = async (text: string) => {
    if (!user || !text.trim() || busy) return;
    const next: CoachChatMessage[] = [...messages, { role: "user", content: text.trim() }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await askCoachChat({ data: { userId: user.id, messages: next } });
      if (res.error) {
        toast.error(res.error);
        setMessages(next);
      } else {
        setMessages([...next, { role: "assistant", content: res.reply }]);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Coach chat failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/15 via-secondary/40 to-secondary/40 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/20 text-primary">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
              Lovable AI · Coach chat
            </div>
            <h2 className="mt-1 font-display text-2xl font-bold leading-tight">
              Talk to your AI betting coach
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Ask anything about today's matches, your tracked games, pending bets or
              bankroll. Coach is balanced — a mix of safer and value picks.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border/60 bg-card/60">
        <div className="max-h-[480px] min-h-[260px] space-y-3 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="space-y-3 py-6 text-center">
              <Bot className="mx-auto h-8 w-8 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">
                Ask the coach for picks, bankroll advice or match insight.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <Button
                    key={s}
                    variant="secondary"
                    size="sm"
                    onClick={() => send(s)}
                    disabled={busy}
                    className="text-xs"
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => <ChatBubble key={i} message={m} />)
          )}
          {busy && (
            <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Coach is thinking…
            </div>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-end gap-2 border-t border-border/60 p-3"
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Ask the coach… (Shift+Enter for newline)"
            rows={1}
            className="min-h-[44px] resize-none"
            disabled={busy}
          />
          <Button type="submit" disabled={busy || !input.trim()} size="icon" className="h-11 w-11 shrink-0">
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>

      {messages.length > 0 && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMessages([])}
            disabled={busy}
            className="text-xs text-muted-foreground"
          >
            Clear chat
          </Button>
        </div>
      )}
    </div>
  );
}

function ChatBubble({ message }: { message: CoachChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Bot className="h-4 w-4" />
        </div>
      )}
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "rounded-tr-sm bg-primary text-primary-foreground"
            : "rounded-tl-sm bg-secondary/70 text-foreground"
        }`}
      >
        {message.content}
      </div>
      {isUser && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
          <UserIcon className="h-3.5 w-3.5" />
        </div>
      )}
    </div>
  );
}

function CoachPicksPanel() {
  // Multi-select set of markets the AI is allowed to pick from. Default =
  // every concrete market on. Empty = nothing → user must pick at least one.
  const ALL_COACH_MARKETS: CoachMarket[] = [
    "1x2","ou_25","btts","double_chance","dnb","ah","home_to_score","away_to_score",
  ];
  const [coachMarkets, setCoachMarkets] = useState<Set<CoachMarket>>(
    () => new Set(ALL_COACH_MARKETS),
  );
  const [minProb, setMinProb] = useState<number>(60);
  const [maxPicks, setMaxPicks] = useState<number>(5);
  const [busy, setBusy] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [recs, setRecs] = useState<CoachRecommendation[]>([]);
  const [summary, setSummary] = useState("");
  const [considered, setConsidered] = useState(0);

  const markets: { label: string; value: CoachMarket; hint: string }[] = [
    { label: "Match Result (1X2)", value: "1x2", hint: "Home / Draw / Away" },
    { label: "Over/Under 2.5", value: "ou_25", hint: "Total goals" },
    { label: "Both Teams To Score", value: "btts", hint: "BTTS Yes / No" },
    { label: "Double Chance", value: "double_chance", hint: "1X / 12 / X2" },
    { label: "Draw No Bet", value: "dnb", hint: "Home or Away (push on draw)" },
    { label: "Asian Handicap", value: "ah", hint: "Half-line, no push" },
    { label: "Home Team to Score", value: "home_to_score", hint: "Home Over 0.5 goals" },
    { label: "Away Team to Score", value: "away_to_score", hint: "Away Over 0.5 goals" },
  ];

  const probSteps = [50, 55, 60, 65, 70, 75, 80];
  const pickCounts = [3, 5, 7, 10];

  const allCoachMarketsOn = coachMarkets.size === ALL_COACH_MARKETS.length;
  const toggleCoachMarket = (m: CoachMarket) => {
    setCoachMarkets((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  };

  const ask = async () => {
    if (coachMarkets.size === 0) {
      toast.error("Pick at least one market");
      return;
    }
    setBusy(true);
    try {
      const res = await getCoachRecommendations({
        data: {
          markets: Array.from(coachMarkets),
          minProbability: minProb,
          maxPicks,
        },
      });
      setRecs(res.recommendations);
      setSummary(res.summary);
      setConsidered(res.considered);
      setHasRun(true);
      if (res.error) toast.error(res.error);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Coach request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/15 via-secondary/40 to-secondary/40 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/20 text-primary">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
              Lovable AI · Betting Coach
            </div>
            <h2 className="mt-1 font-display text-2xl font-bold leading-tight">
              Ask the AI for today's best bets
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a market and a confidence floor. The AI ranks candidates from the
              statistical model and writes a one-line rationale per pick.
            </p>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="space-y-4 rounded-2xl border border-border/60 bg-secondary/30 p-4">
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Markets · {coachMarkets.size}/{ALL_COACH_MARKETS.length}
            </div>
            <div className="flex gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCoachMarkets(new Set(ALL_COACH_MARKETS))}
                disabled={allCoachMarketsOn}
                className="h-7 px-2 text-[11px]"
              >
                Select all
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCoachMarkets(new Set())}
                disabled={coachMarkets.size === 0}
                className="h-7 px-2 text-[11px]"
              >
                Clear
              </Button>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {markets.map((m) => {
              const active = coachMarkets.has(m.value);
              return (
                <button
                  key={m.value}
                  onClick={() => toggleCoachMarket(m.value)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition ${
                    active
                      ? "border-primary bg-primary/15"
                      : "border-border/60 bg-background/40 hover:border-primary/60"
                  }`}
                >
                  <div className={`flex items-center gap-2 font-display text-sm font-bold ${active ? "text-primary" : ""}`}>
                    <span
                      className={`grid h-4 w-4 place-content-center rounded border ${
                        active ? "border-primary bg-primary text-primary-foreground" : "border-border"
                      }`}
                    >
                      {active ? "✓" : ""}
                    </span>
                    {m.label}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{m.hint}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Min confidence · {minProb}%
            </div>
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1">
              {probSteps.map((p) => (
                <Button
                  key={p}
                  variant={minProb === p ? "default" : "secondary"}
                  size="sm"
                  onClick={() => setMinProb(p)}
                  className="shrink-0"
                >
                  {p}%
                </Button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Max picks
            </div>
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1">
              {pickCounts.map((n) => (
                <Button
                  key={n}
                  variant={maxPicks === n ? "default" : "secondary"}
                  size="sm"
                  onClick={() => setMaxPicks(n)}
                  className="shrink-0"
                >
                  {n}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <Button onClick={ask} disabled={busy} className="w-full gap-2 sm:w-auto">
          {busy ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {busy ? "Coach is thinking…" : hasRun ? "Re-run with these settings" : "Get AI recommendations"}
        </Button>
      </div>

      {/* Results */}
      {!hasRun && !busy && (
        <div className="rounded-2xl border border-dashed border-border/60 px-6 py-12 text-center">
          <Bot className="mx-auto h-8 w-8 text-muted-foreground/60" />
          <p className="mt-2 font-display text-base font-semibold">No recommendations yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure your filters above and hit “Get AI recommendations”.
          </p>
        </div>
      )}

      {busy && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-border/60 bg-secondary/40"
            />
          ))}
        </div>
      )}

      {hasRun && !busy && (
        <>
          {summary && (
            <div className="rounded-2xl border border-primary/30 bg-primary/[0.06] p-4">
              <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p className="text-sm leading-relaxed">{summary}</p>
              </div>
              {considered > 0 && (
                <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Considered {considered} matches with cached predictions
                </p>
              )}
            </div>
          )}

          {recs.length === 0 ? null : (
            <div className="space-y-2">
              {recs.map((r, idx) => (
                <CoachPickCard key={`${r.matchId}-${idx}`} rec={r} rank={idx + 1} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CoachPickCard({ rec, rank }: { rec: CoachRecommendation; rank: number }) {
  const date = new Date(rec.kickoff);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const confColor =
    rec.confidence === "high"
      ? "border-primary/40 bg-primary/15 text-primary"
      : rec.confidence === "medium"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
        : "border-border/60 bg-secondary/50 text-muted-foreground";
  const prob01 = rec.probability / 100;
  const recUnits = unitsForProbability(prob01);
  const tier = tierLabel(prob01);

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 p-4 transition hover:border-primary/60">
      <Link
        to="/match/$matchId"
        params={{ matchId: String(rec.matchId) }}
        className="block"
      >
        <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 font-display text-sm font-bold text-primary">
          #{rank}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {rec.competition && (
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                {rec.competition}
              </span>
            )}
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
              · {time}
            </span>
          </div>
          <div className="mt-0.5 truncate font-display text-sm font-semibold">
            {rec.homeTeam} <span className="text-muted-foreground">vs</span> {rec.awayTeam}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-primary/30 bg-primary/10 px-2 py-1 font-display text-xs font-bold text-primary">
              {rec.selection}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {rec.market}
            </span>
            <span
              className={`rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${confColor}`}
            >
              {rec.confidence} confidence
            </span>
            <span className="rounded-md border border-border/60 bg-secondary/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-foreground">
              Stake · {recUnits === 0 ? tier.label : `${recUnits} u`}
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-foreground/90">{rec.rationale}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            Model
          </div>
          <div className="font-display text-2xl font-bold tabular-nums text-primary">
            {rec.probability.toFixed(0)}%
          </div>
        </div>
        </div>
      </Link>
      {recUnits > 0 && (
        <div className="mt-3 flex justify-end" onClick={(e) => e.stopPropagation()}>
          <LogBetDialog
            seed={{
              matchId: rec.matchId,
              homeTeam: rec.homeTeam,
              awayTeam: rec.awayTeam,
              competition: rec.competition,
              utcDate: rec.kickoff,
              market: rec.market,
              selection: rec.selection,
              modelProbability: prob01,
            }}
          />
        </div>
      )}
    </div>
  );
}
