import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import {
  getStats,
  getModelAccuracy,
  type StatsResponse,
  type AccuracyResponse,
} from "@/server/football.functions";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Target,
  TrendingUp,
  BarChart3,
  Trophy,
  CheckCircle2,
  XCircle,
} from "lucide-react";

export const Route = createFileRoute("/stats")({
  head: () => ({
    meta: [
      { title: "Model performance & accuracy — Pitchcast" },
      {
        name: "description",
        content:
          "Recent hit-rate per market plus the lifetime track record of every prediction we've made.",
      },
    ],
  }),
  loader: () => getStats({ data: { days: 7 } }),
  component: StatsPage,
  errorComponent: ({ error, reset }) => {
    const router = useRouter();
    return (
      <AppShell>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-sm">
          <p className="font-medium">Couldn't load stats</p>
          <p className="mt-1 text-muted-foreground">{error.message}</p>
          <button
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            onClick={() => {
              router.invalidate();
              reset();
            }}
          >
            Retry
          </button>
        </div>
      </AppShell>
    );
  },
  notFoundComponent: () => (
    <AppShell>
      <p className="text-sm text-muted-foreground">Stats not available.</p>
    </AppShell>
  ),
});

function rateColor(rate: number): string {
  if (rate >= 65) return "text-primary";
  if (rate >= 50) return "text-foreground";
  return "text-muted-foreground";
}

function StatCard({
  label,
  hits,
  total,
  hitRate,
  emphasis = false,
}: {
  label: string;
  hits: number;
  total: number;
  hitRate: number;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border p-5 transition ${
        emphasis
          ? "border-primary/40 bg-primary/5 glow-primary"
          : "border-border/60 bg-card/40"
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Target className="h-3.5 w-3.5 text-primary" />
        <span className="truncate">{label}</span>
      </div>
      <div className={`mt-3 font-display text-4xl font-bold ${rateColor(hitRate)}`}>
        {hitRate.toFixed(1)}%
      </div>
      <div className="mt-1 font-mono text-xs text-muted-foreground">
        {hits} / {total} {total === 1 ? "pick" : "picks"}
      </div>
    </div>
  );
}

function StatsPage() {
  const data = Route.useLoaderData() as StatsResponse;
  const [accuracy, setAccuracy] = useState<AccuracyResponse | null>(null);
  const [accuracyBusy, setAccuracyBusy] = useState(false);
  const [accuracyLoaded, setAccuracyLoaded] = useState(false);
  const [tab, setTab] = useState<"recent" | "lifetime">("recent");

  useEffect(() => {
    if (tab !== "lifetime" || accuracyLoaded || accuracyBusy) return;
    setAccuracyBusy(true);
    getModelAccuracy()
      .then((r) => {
        setAccuracy(r);
        setAccuracyLoaded(true);
      })
      .finally(() => setAccuracyBusy(false));
  }, [tab, accuracyLoaded, accuracyBusy]);

  return (
    <AppShell>
      <div className="space-y-8">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-primary">
            Track record
          </p>
          <h1 className="mt-2 font-display text-4xl font-bold tracking-tight md:text-5xl">
            Performance & accuracy
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Transparent results — see how our predictions performed recently and across every match
            we've ever called.
          </p>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "recent" | "lifetime")}>
          <TabsList className="h-10 p-1">
            <TabsTrigger value="recent" className="gap-1.5">
              <TrendingUp className="h-3.5 w-3.5" />
              Recent ({data.windowDays}d)
            </TabsTrigger>
            <TabsTrigger value="lifetime" className="gap-1.5">
              <Trophy className="h-3.5 w-3.5" />
              Lifetime
            </TabsTrigger>
          </TabsList>

          <TabsContent value="recent" className="mt-6">
            <RecentTab data={data} />
          </TabsContent>

          <TabsContent value="lifetime" className="mt-6">
            <LifetimeTab data={accuracy} busy={accuracyBusy} />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}

function RecentTab({ data }: { data: StatsResponse }) {
  return (
    <div className="space-y-8">
      {data.error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
          {data.error}
        </div>
      )}

      {data.totalMatchesGraded === 0 ? (
          <div className="rounded-2xl border border-border/60 bg-card/40 p-10 text-center">
            <BarChart3 className="mx-auto h-10 w-10 text-muted-foreground/50" />
            <p className="mt-3 font-medium">No graded matches yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              As matches finish in the next {data.windowDays} days they'll appear here with
              hit-rate scoring.
            </p>
          </div>
        ) : (
          <>
            {/* Headline best-pick card */}
            <section>
              <div className="mb-3 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />
                <h2 className="font-display text-lg font-semibold">Best pick per match</h2>
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  · model top choice
                </span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <StatCard
                  label="Overall best pick"
                  hits={data.bestPick.hits}
                  total={data.bestPick.total}
                  hitRate={data.bestPick.hitRate}
                  emphasis
                />
                {data.bestPick.byMarket.map((m) => (
                  <StatCard
                    key={m.market}
                    label={`Best when ${m.label}`}
                    hits={m.hits}
                    total={m.total}
                    hitRate={m.hitRate}
                  />
                ))}
              </div>
            </section>

            {/* Per-market */}
            <section>
              <div className="mb-3 flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-primary" />
                <h2 className="font-display text-lg font-semibold">Hit rate by market</h2>
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  · {data.totalMatchesGraded} matches graded
                </span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {data.perMarket.map((m) => (
                  <StatCard
                    key={m.market}
                    label={m.label}
                    hits={m.hits}
                    total={m.total}
                    hitRate={m.hitRate}
                  />
                ))}
              </div>
              <p className="mt-4 font-mono text-[11px] text-muted-foreground">
                Markets like cards, corners and shots aren't graded here yet — they need play-by-play
                stats. Goal-based markets are graded automatically.
              </p>
            </section>
          </>
        )}
    </div>
  );
}

function LifetimeTab({ data, busy }: { data: AccuracyResponse | null; busy: boolean }) {
  if (busy && !data) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl border border-border/60 bg-secondary/40" />
          ))}
        </div>
        <div className="h-80 animate-pulse rounded-2xl border border-border/60 bg-secondary/40" />
      </div>
    );
  }
  if (!data) return null;
  if (data.totalMatches === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/60 px-6 py-16 text-center">
        <p className="font-display text-lg font-semibold">No settled matches yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Once predicted matches finish, lifetime accuracy stats will appear here automatically.
        </p>
      </div>
    );
  }

  const headline = [
    { label: "Settled matches", value: data.totalMatches.toString(), icon: Trophy },
    { label: "Total picks", value: data.totalPicks.toLocaleString(), icon: TrendingUp },
    {
      label: "Overall hit-rate",
      value: `${data.overallHitRate.toFixed(1)}%`,
      icon: Target,
      highlight: true,
    },
  ];

  return (
    <div className="space-y-10">
      <div className="grid gap-3 sm:grid-cols-3">
        {headline.map((c) => {
          const Icon = c.icon;
          return (
            <div
              key={c.label}
              className={`rounded-2xl border p-5 ${
                c.highlight ? "border-primary/40 bg-primary/[0.04]" : "border-border/60 bg-card/40"
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${c.highlight ? "text-primary" : "text-muted-foreground"}`} />
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  {c.label}
                </span>
              </div>
              <div
                className={`mt-3 font-display text-3xl font-bold tabular-nums ${
                  c.highlight ? "text-primary" : "text-foreground"
                }`}
              >
                {c.value}
              </div>
            </div>
          );
        })}
      </div>

      <section>
        <h2 className="mb-4 font-display text-xl font-bold">Lifetime hit-rate by market</h2>
        <div className="overflow-hidden rounded-2xl border border-border/60 bg-card/40">
          <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-border/60 bg-secondary/40 px-5 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <span>Market</span>
            <span className="text-right">Sample</span>
            <span className="text-right">Hit-rate</span>
          </div>
          <ul className="divide-y divide-border/40">
            {data.markets.map((m) => {
              const isStrong = m.hitRate >= m.avgConfidence - 5;
              return (
                <li
                  key={m.market}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-5 py-4"
                >
                  <div className="min-w-0">
                    <div className="truncate font-display text-sm font-semibold">{m.label}</div>
                    <div className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-secondary">
                      <div
                        className={`h-full rounded-full ${isStrong ? "bg-primary" : "bg-muted-foreground/50"}`}
                        style={{ width: `${Math.min(100, m.hitRate)}%` }}
                      />
                    </div>
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                      avg. confidence {m.avgConfidence.toFixed(1)}%
                    </div>
                  </div>
                  <div className="text-right font-mono text-xs tabular-nums text-foreground">
                    {m.hits}/{m.total}
                  </div>
                  <div
                    className={`text-right font-display text-lg font-bold tabular-nums ${
                      isStrong ? "text-primary" : "text-foreground"
                    }`}
                  >
                    {m.hitRate.toFixed(1)}%
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section>
        <h2 className="mb-4 font-display text-xl font-bold">Recent settled matches</h2>
        <div className="space-y-2">
          {data.recent.map((r) => {
            const ratio = r.pickHits / r.pickTotal;
            const tone = ratio >= 0.7 ? "text-primary" : ratio >= 0.4 ? "text-foreground" : "text-destructive";
            return (
              <Link
                key={r.matchId}
                to="/match/$matchId"
                params={{ matchId: String(r.matchId) }}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3 transition hover:border-primary/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                    {r.competition ?? "Match"}
                  </div>
                  <div className="mt-0.5 truncate font-display text-sm font-semibold">
                    {r.home} <span className="text-muted-foreground">vs</span> {r.away}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="rounded-md bg-secondary px-2.5 py-1 font-mono text-xs tabular-nums">
                    {r.finalScore}
                  </div>
                  <div className={`flex items-center gap-1 font-mono text-xs tabular-nums ${tone}`}>
                    {ratio >= 0.5 ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                    {r.pickHits}/{r.pickTotal}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
