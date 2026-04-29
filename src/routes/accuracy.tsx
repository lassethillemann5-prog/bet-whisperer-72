import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { getModelAccuracy, type AccuracyResponse } from "@/server/football.functions";
import { Target, TrendingUp, CheckCircle2, XCircle, Trophy } from "lucide-react";

export const Route = createFileRoute("/accuracy")({
  head: () => ({
    meta: [
      { title: "Model accuracy — Pitchcast" },
      {
        name: "description",
        content:
          "How accurate are Pitchcast predictions? See historical hit-rate per market across all settled matches.",
      },
      { property: "og:title", content: "Model accuracy — Pitchcast" },
      {
        property: "og:description",
        content: "Transparent track record of our football predictions across every market.",
      },
    ],
  }),
  component: AccuracyPage,
});

function AccuracyPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<AccuracyResponse | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    setBusy(true);
    getModelAccuracy()
      .then(setData)
      .finally(() => setBusy(false));
  }, [user]);

  if (loading || !user) return null;

  return (
    <AppShell>
      <div className="mb-8">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-primary" />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
            Track record
          </span>
        </div>
        <h1 className="mt-1 font-display text-3xl font-bold tracking-tight md:text-4xl">
          Model accuracy
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Every prediction we generate is stored with the final result. Here's how the model has
          actually performed across all settled matches — no cherry-picking.
        </p>
      </div>

      {busy && <SkeletonState />}

      {!busy && data && data.totalMatches === 0 && <EmptyState />}

      {!busy && data && data.totalMatches > 0 && (
        <>
          <HeadlineStats data={data} />
          <MarketsTable data={data} />
          <RecentResults data={data} />
        </>
      )}
    </AppShell>
  );
}

function HeadlineStats({ data }: { data: AccuracyResponse }) {
  const cards = [
    {
      label: "Settled matches",
      value: data.totalMatches.toString(),
      icon: Trophy,
    },
    {
      label: "Total picks",
      value: data.totalPicks.toLocaleString(),
      icon: TrendingUp,
    },
    {
      label: "Overall hit-rate",
      value: `${data.overallHitRate.toFixed(1)}%`,
      icon: Target,
      highlight: true,
    },
  ];
  return (
    <div className="mb-10 grid gap-3 sm:grid-cols-3">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <div
            key={c.label}
            className={`rounded-2xl border p-5 card-elevated ${
              c.highlight
                ? "border-primary/40 bg-primary/[0.04]"
                : "border-border/60"
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
  );
}

function MarketsTable({ data }: { data: AccuracyResponse }) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 font-display text-xl font-bold">Hit-rate by market</h2>
      <div className="overflow-hidden rounded-2xl border border-border/60 card-elevated">
        <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-border/60 bg-secondary/40 px-5 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <span>Market</span>
          <span className="text-right">Sample</span>
          <span className="text-right">Hit-rate</span>
        </div>
        <ul className="divide-y divide-border/40">
          {data.markets.map((m) => {
            const isStrong = m.hitRate >= m.avgConfidence - 5; // model calibrated or beating its own confidence
            return (
              <li
                key={m.market}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="truncate font-display text-sm font-semibold">{m.label}</div>
                  <div className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-secondary">
                    <div
                      className={`h-full rounded-full ${
                        isStrong ? "bg-primary" : "bg-muted-foreground/50"
                      }`}
                      style={{ width: `${Math.min(100, m.hitRate)}%` }}
                    />
                  </div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                    avg. confidence {m.avgConfidence.toFixed(1)}%
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-xs tabular-nums text-foreground">
                    {m.hits}/{m.total}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={`font-display text-lg font-bold tabular-nums ${
                      isStrong ? "text-primary" : "text-foreground"
                    }`}
                  >
                    {m.hitRate.toFixed(1)}%
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
        Corners, shots, and cards markets aren't gradable from the score alone and are excluded.
      </p>
    </section>
  );
}

function RecentResults({ data }: { data: AccuracyResponse }) {
  return (
    <section>
      <h2 className="mb-4 font-display text-xl font-bold">Recent settled matches</h2>
      <div className="space-y-2">
        {data.recent.map((r) => {
          const ratio = r.pickHits / r.pickTotal;
          const tone =
            ratio >= 0.7 ? "text-primary" : ratio >= 0.4 ? "text-foreground" : "text-destructive";
          return (
            <Link
              key={r.matchId}
              to="/match/$matchId"
              params={{ matchId: String(r.matchId) }}
              className="flex items-center justify-between gap-3 rounded-xl border border-border/60 card-elevated px-4 py-3 transition hover:border-primary/40"
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
                  {ratio >= 0.5 ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5" />
                  )}
                  {r.pickHits}/{r.pickTotal}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function SkeletonState() {
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

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border/60 px-6 py-16 text-center">
      <p className="font-display text-lg font-semibold">No settled matches yet</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Once predicted matches finish, accuracy stats will appear here automatically.
      </p>
    </div>
  );
}