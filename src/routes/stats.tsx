import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/app/AppShell";
import { getStats, type StatsResponse } from "@/server/football.functions";
import { Target, TrendingUp, BarChart3 } from "lucide-react";

export const Route = createFileRoute("/stats")({
  head: () => ({
    meta: [
      { title: "Stats — Pitchcast" },
      { name: "description", content: "Hit rate per market across recently finished matches." },
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

  return (
    <AppShell>
      <div className="space-y-8">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-primary">
            Last {data.windowDays} days
          </p>
          <h1 className="mt-2 font-display text-4xl font-bold tracking-tight md:text-5xl">
            Model performance
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Live hit rate for every market we predict, graded against actual final scores from
            recently finished matches. Updates as more games complete.
          </p>
        </div>

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
    </AppShell>
  );
}
