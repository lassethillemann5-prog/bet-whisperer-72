import { computeLiveProbabilities } from "@/lib/football/livePredictor";
import type { LiveScoreLite } from "@/lib/football/useLiveScores";

interface Props {
  preMatchXgHome: number;
  preMatchXgAway: number;
  score: LiveScoreLite;
  variant?: "compact" | "full";
}

/**
 * Renders an in-play probability strip (Home / Draw / Away) plus, in `full`
 * variant, BTTS and Over 2.5 readouts. Computed entirely on the client from
 * pre-match xG + the polled live score — no extra API calls.
 */
export function LiveProbabilityBar({
  preMatchXgHome,
  preMatchXgAway,
  score,
  variant = "compact",
}: Props) {
  const probs = computeLiveProbabilities(
    preMatchXgHome,
    preMatchXgAway,
    score.home ?? 0,
    score.away ?? 0,
    score.status,
    score.minute,
  );

  return (
    <div className={variant === "full" ? "space-y-3" : "space-y-1.5"}>
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <span>Live win prob</span>
        {probs.settled ? (
          <span className="text-foreground/70">Final</span>
        ) : (
          <span>Updating</span>
        )}
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${probs.home}%` }}
          title={`Home ${probs.home}%`}
        />
        <div
          className="h-full bg-muted-foreground/60 transition-all"
          style={{ width: `${probs.draw}%` }}
          title={`Draw ${probs.draw}%`}
        />
        <div
          className="h-full bg-destructive transition-all"
          style={{ width: `${probs.away}%` }}
          title={`Away ${probs.away}%`}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] tabular-nums">
        <span className="font-semibold text-primary">{probs.home}%</span>
        <span className="text-muted-foreground">{probs.draw}%</span>
        <span className="font-semibold text-destructive">{probs.away}%</span>
      </div>

      {variant === "full" && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Stat label="Over 2.5" value={probs.over25} />
          <Stat label="BTTS" value={probs.btts} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className="font-display text-base font-bold tabular-nums text-foreground">
        {value}%
      </div>
    </div>
  );
}
