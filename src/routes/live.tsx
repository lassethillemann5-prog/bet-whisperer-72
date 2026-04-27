import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { useLiveScores, type LiveScoreLite } from "@/lib/football/useLiveScores";
import { LiveBadge, LiveScoreLine } from "@/components/app/LiveBadge";
import { Activity, RadioTower } from "lucide-react";

export const Route = createFileRoute("/live")({
  head: () => ({
    meta: [
      { title: "Live — Pitchcast" },
      { name: "description", content: "Matches currently in play, updated every 30 seconds." },
    ],
  }),
  component: LivePage,
});

function LivePage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const live = useLiveScores();

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  if (loading || !user) return null;

  const scores = Array.from(live.values()).sort((a, b) => {
    // In-play before breaks; otherwise by minute desc
    const ma = a.minute ?? 0;
    const mb = b.minute ?? 0;
    return mb - ma;
  });

  // Group by competition
  const groups = new Map<string, LiveScoreLite[]>();
  for (const s of scores) {
    const key = s.competition?.country
      ? `${s.competition.country} — ${s.competition.name}`
      : s.competition?.name ?? "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const groupList = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <AppShell>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive">
              Live now
            </span>
          </div>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">In-play matches</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {scores.length === 0
              ? "No matches in play right now."
              : `${scores.length} match${scores.length === 1 ? "" : "es"} currently being played. Auto-refreshing every 30s.`}
          </p>
        </div>
        <div className="hidden items-center gap-2 rounded-full border border-border/60 bg-secondary/40 px-3 py-1.5 text-xs text-muted-foreground md:flex">
          <RadioTower className="h-3.5 w-3.5" />
          Polling 30s
        </div>
      </div>

      {scores.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-8">
          {groupList.map(([label, rows]) => (
            <section key={label}>
              <div className="mb-3 flex items-center gap-2">
                {rows[0].competition?.emblem && (
                  <img src={rows[0].competition.emblem} alt="" className="h-4 w-4 object-contain" />
                )}
                <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                  {label}
                </h2>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {rows.map((s) => (
                  <LiveCard key={s.id} score={s} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </AppShell>
  );
}

function LiveCard({ score }: { score: LiveScoreLite }) {
  const home = score.homeTeam?.name ?? "Home";
  const away = score.awayTeam?.name ?? "Away";
  return (
    <Link
      to="/match/$matchId"
      params={{ matchId: String(score.id) }}
      className="group relative block overflow-hidden rounded-2xl border border-border/60 card-elevated transition hover:border-destructive/50 hover:shadow-[0_0_24px_-12px_var(--destructive)]"
    >
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-2">
        <span className="truncate font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
          {score.competition?.name ?? "Match"}
        </span>
        <LiveBadge score={score} />
      </div>
      <div className="px-4 py-4">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <TeamSide name={home} crest={score.homeTeam?.crest ?? null} align="right" />
          <LiveScoreLine score={score} />
          <TeamSide name={away} crest={score.awayTeam?.crest ?? null} align="left" />
        </div>
      </div>
    </Link>
  );
}

function TeamSide({
  name,
  crest,
  align,
}: {
  name: string;
  crest: string | null;
  align: "left" | "right";
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-3 ${
        align === "right" ? "flex-row-reverse text-right" : ""
      }`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary">
        {crest ? (
          <img src={crest} alt="" className="h-7 w-7 object-contain" loading="lazy" />
        ) : (
          <span className="font-display text-sm font-bold text-muted-foreground">
            {name.slice(0, 2)}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-sm font-semibold">{name}</div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-secondary/20 px-6 py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
        <Activity className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="font-display text-lg font-semibold">No matches in play</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        When a tracked league kicks off, scores will appear here automatically — no need to refresh.
      </p>
      <Link
        to="/"
        className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
      >
        Browse fixtures
      </Link>
    </div>
  );
}