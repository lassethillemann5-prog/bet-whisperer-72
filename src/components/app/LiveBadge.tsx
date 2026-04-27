import type { LiveScoreLite } from "@/lib/football/useLiveScores";

function minuteLabel(s: LiveScoreLite): string {
  switch (s.status) {
    case "HT":
      return "HT";
    case "BT":
      return "BREAK";
    case "P":
      return "PEN";
    case "ET":
      return s.minute ? `${s.minute}' ET` : "ET";
    case "SUSP":
      return "SUSP";
    case "INT":
      return "INT";
    default:
      return s.minute ? `${s.minute}'` : "LIVE";
  }
}

export function LiveBadge({ score }: { score: LiveScoreLite }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/15 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-destructive">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-destructive" />
      </span>
      {minuteLabel(score)}
    </span>
  );
}

export function LiveScoreLine({ score }: { score: LiveScoreLite }) {
  if (score.home == null || score.away == null) return null;
  return (
    <span className="font-mono text-sm font-bold tabular-nums text-foreground">
      {score.home}–{score.away}
    </span>
  );
}
