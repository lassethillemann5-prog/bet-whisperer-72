import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Target, RefreshCw, TrendingUp, Activity, Brain } from "lucide-react";
import { toast } from "sonner";
import {
  getLatestBacktest,
  runBacktest,
  type BacktestResult,
} from "@/server/backtest.functions";

export const Route = createFileRoute("/accuracy")({
  component: AccuracyPage,
});

const LEAGUES: { id: number; label: string }[] = [
  { id: 39, label: "Premier League" },
  { id: 140, label: "La Liga" },
  { id: 78, label: "Bundesliga" },
  { id: 135, label: "Serie A" },
  { id: 61, label: "Ligue 1" },
];

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  icon: typeof Target;
  tone?: "good" | "warn" | "neutral";
}) {
  const toneCls =
    tone === "good"
      ? "text-primary"
      : tone === "warn"
      ? "text-destructive"
      : "text-foreground";
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </div>
        <div className={`mt-2 font-display text-3xl font-bold ${toneCls}`}>{value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}

function AccuracyPage() {
  const [run, setRun] = useState<BacktestResult | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leagueId, setLeagueId] = useState(39);
  const [days, setDays] = useState(60);

  useEffect(() => {
    getLatestBacktest()
      .then((res) => {
        setRun(res.run);
        setCreatedAt(res.createdAt);
      })
      .catch(() => undefined);
  }, []);

  const trigger = async () => {
    setBusy(true);
    try {
      const res = await runBacktest({ data: { leagueId, days, maxMatches: 25 } });
      if (res.error) toast.error(res.error);
      else toast.success(`Tested ${res.matchesTested} matches`);
      setRun(res);
      setCreatedAt(new Date().toISOString());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Backtest failed");
    } finally {
      setBusy(false);
    }
  };

  const accTone: "good" | "warn" | "neutral" = run
    ? run.accuracy >= 55
      ? "good"
      : run.accuracy >= 45
      ? "neutral"
      : "warn"
    : "neutral";
  const roiTone: "good" | "warn" | "neutral" = run
    ? run.roiPct > 0
      ? "good"
      : run.roiPct > -5
      ? "neutral"
      : "warn"
    : "neutral";

  return (
    <AppShell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Model Accuracy
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Walk-forward backtest: predictions are graded only against matches
            they couldn't see. No look-ahead bias.
          </p>
        </div>
        <Button onClick={trigger} disabled={busy} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
          {busy ? "Running…" : "Run new backtest"}
        </Button>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Backtest settings</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">League</span>
            <select
              value={leagueId}
              onChange={(e) => setLeagueId(Number(e.target.value))}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              {LEAGUES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Window</span>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              {[30, 60, 90, 120].map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </select>
          </div>
          {createdAt && (
            <span className="text-xs text-muted-foreground">
              Last run {new Date(createdAt).toLocaleString()}
            </span>
          )}
        </CardContent>
      </Card>

      {!run ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No backtest yet. Run one to measure how well the model has been
            predicting recent finished matches.
          </CardContent>
        </Card>
      ) : run.matchesTested === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {run.error ?? "No matches in window."}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <MetricCard
              label="Pick accuracy"
              value={`${run.accuracy.toFixed(1)}%`}
              hint={`Across ${run.matchesTested} matches × 3 markets`}
              icon={Target}
              tone={accTone}
            />
            <MetricCard
              label="Brier score"
              value={run.brierScore.toFixed(3)}
              hint="Lower = sharper probabilities (0 perfect, 0.25 random)"
              icon={Brain}
              tone={
                run.brierScore < 0.21
                  ? "good"
                  : run.brierScore < 0.25
                  ? "neutral"
                  : "warn"
              }
            />
            <MetricCard
              label="Log-loss"
              value={run.logLoss.toFixed(3)}
              hint="Penalises overconfident wrong calls"
              icon={Activity}
            />
            <MetricCard
              label="ROI vs fair odds"
              value={`${run.roiPct >= 0 ? "+" : ""}${run.roiPct.toFixed(1)}%`}
              hint="Flat 1u stake on every model pick"
              icon={TrendingUp}
              tone={roiTone}
            />
          </div>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Per-market breakdown
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 text-left">Market</th>
                      <th className="py-2 text-right">N</th>
                      <th className="py-2 text-right">Accuracy</th>
                      <th className="py-2 text-right">Brier</th>
                      <th className="py-2 text-right">Log-loss</th>
                      <th className="py-2 text-right">ROI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(run.marketBreakdown).map(([key, m]) => {
                      const label =
                        key === "1x2"
                          ? "Match Result"
                          : key === "ou_25"
                          ? "Over / Under 2.5"
                          : key === "btts"
                          ? "BTTS"
                          : key;
                      return (
                        <tr key={key} className="border-b border-border/30 last:border-0">
                          <td className="py-2 font-medium">{label}</td>
                          <td className="py-2 text-right">{m.n}</td>
                          <td className="py-2 text-right">{m.accuracy.toFixed(1)}%</td>
                          <td className="py-2 text-right">{m.brier.toFixed(3)}</td>
                          <td className="py-2 text-right">{m.logLoss.toFixed(3)}</td>
                          <td
                            className={`py-2 text-right font-medium ${
                              m.roi > 0 ? "text-primary" : m.roi < 0 ? "text-destructive" : ""
                            }`}
                          >
                            {m.roi >= 0 ? "+" : ""}
                            {m.roi.toFixed(1)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                Backtests rebuild each team's recent form using only matches
                that finished before kickoff, then run today's predictor
                (Poisson + Dixon-Coles + 90-day time decay). ROI assumes a flat
                1-unit stake on every model pick at fair odds (1 / probability).
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </AppShell>
  );
}