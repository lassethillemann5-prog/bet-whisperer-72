import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { fetchMatchOdds, type MatchOddsResult } from "@/server/football.functions";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export function FetchOddsButton({
  matchId,
  hasOdds,
  onFetched,
}: {
  matchId: number;
  hasOdds: boolean;
  onFetched: (result: MatchOddsResult) => void;
}) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);

  async function handle() {
    if (!user) {
      toast.error("Sign in to fetch odds");
      return;
    }
    setBusy(true);
    try {
      const result = await fetchMatchOdds({
        data: { matchId, userId: user.id },
      });
      if (result.error) {
        toast.error(result.error);
      } else if (result.rows.length === 0) {
        toast.warning("No bet365 odds available for this match yet");
      } else {
        toast.success(
          result.cacheHit
            ? `Loaded today's cached bet365 odds (${result.rows.length} markets)`
            : `Fetched bet365 odds (${result.rows.length} markets) · ${result.creditsUsed} credits used`,
        );
      }
      onFetched(result);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      size="sm"
      variant={hasOdds ? "secondary" : "default"}
      onClick={handle}
      disabled={busy}
      className="gap-1.5"
      title="Uses cached bet365 odds for 24 hours to save Odds API credits"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : hasOdds ? (
        <RefreshCw className="h-3.5 w-3.5" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      {busy ? "Fetching…" : hasOdds ? "Reload daily odds" : "Fetch bet365 odds"}
    </Button>
  );
}
