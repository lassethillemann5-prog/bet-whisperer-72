import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { listTracked, untrackMatch, type TrackedRow } from "@/lib/football/tracked";
import { Button } from "@/components/ui/button";
import { Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/tracked")({
  head: () => ({
    meta: [
      { title: "Tracked matches — Pitchcast" },
      {
        name: "description",
        content: "Your starred football fixtures and predictions in one place.",
      },
    ],
  }),
  component: TrackedPage,
});

function TrackedPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<TrackedRow[]>([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    setBusy(true);
    listTracked(user.id)
      .then(setRows)
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed"))
      .finally(() => setBusy(false));
  }, [user]);

  const remove = async (matchId: number) => {
    if (!user) return;
    try {
      await untrackMatch(user.id, matchId);
      setRows((r) => r.filter((x) => x.match_id !== matchId));
      toast.success("Removed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  if (loading || !user) return null;

  return (
    <AppShell>
      <div className="mb-6 flex items-center gap-3">
        <Star className="h-5 w-5 text-primary" />
        <h1 className="font-display text-3xl font-bold">Your tracked matches</h1>
      </div>

      {busy ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-2xl border border-border/60 bg-secondary/40"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 px-6 py-16 text-center">
          <p className="font-display text-lg font-semibold">Nothing tracked yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Star matches on the fixtures page to follow them here.
          </p>
          <Link
            to="/"
            className="mt-4 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-glow"
          >
            Browse fixtures
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between rounded-2xl border border-border/60 card-elevated px-5 py-4"
            >
              <Link
                to="/match/$matchId"
                params={{ matchId: String(r.match_id) }}
                className="min-w-0 flex-1"
              >
                <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                  {r.competition ?? "Match"}
                </div>
                <div className="mt-0.5 truncate font-display text-base font-semibold">
                  {r.home_team} <span className="text-muted-foreground">vs</span> {r.away_team}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {new Date(r.utc_date).toLocaleString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </Link>
              <Button variant="ghost" size="sm" onClick={() => remove(r.match_id)} className="gap-1.5">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
