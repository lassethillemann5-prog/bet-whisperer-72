import { Link } from "@tanstack/react-router";
import type { MatchSummary } from "@/lib/football/types";
import { Star, StarOff } from "lucide-react";
import { Button } from "@/components/ui/button";

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MatchCard({
  match,
  isTracked,
  onToggleTrack,
}: {
  match: MatchSummary;
  isTracked?: boolean;
  onToggleTrack?: () => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border/60 card-elevated transition hover:border-primary/40 hover:shadow-[0_0_24px_-12px_var(--primary)]">
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-2">
        <div className="flex items-center gap-2">
          {match.competition?.emblem && (
            <img
              src={match.competition.emblem}
              alt=""
              className="h-4 w-4 object-contain"
              loading="lazy"
            />
          )}
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
            {match.competition?.name ?? "Match"}
          </span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {fmtDate(match.utcDate)}
        </span>
      </div>
      <Link
        to="/match/$matchId"
        params={{ matchId: String(match.id) }}
        className="block px-4 py-4"
      >
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <Team team={match.homeTeam} align="right" />
          <div className="flex flex-col items-center gap-1">
            <div className="rounded-lg bg-secondary px-2.5 py-1 font-mono text-xs font-semibold">
              vs
            </div>
          </div>
          <Team team={match.awayTeam} align="left" />
        </div>
      </Link>
      {onToggleTrack && (
        <div className="flex items-center justify-between border-t border-border/50 px-4 py-2">
          <span className="text-[11px] text-muted-foreground">Tap card for predictions</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleTrack();
            }}
            className="h-8 gap-1.5 text-xs"
          >
            {isTracked ? (
              <>
                <StarOff className="h-3.5 w-3.5" />
                Untrack
              </>
            ) : (
              <>
                <Star className="h-3.5 w-3.5" />
                Track
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function Team({
  team,
  align,
}: {
  team: MatchSummary["homeTeam"];
  align: "left" | "right";
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-3 ${
        align === "right" ? "flex-row-reverse text-right" : ""
      }`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary">
        {team.crest ? (
          <img src={team.crest} alt="" className="h-7 w-7 object-contain" loading="lazy" />
        ) : (
          <span className="font-display text-sm font-bold text-muted-foreground">
            {team.name.slice(0, 2)}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-sm font-semibold">
          {team.shortName ?? team.name}
        </div>
      </div>
    </div>
  );
}
