import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  runBacktestFn,
  listBacktestRuns,
  getBacktestRun,
  deleteBacktestRun,
  getBacktestLeagues,
} from "@/server/backtest.functions";
import { FlaskConical, Loader2, Trash2, TrendingUp, Target, Activity, Calendar } from "lucide-react";
import {
  runLeagueCalibration,
  runLeagueEloRecompute,
  runLeagueSweep,
} from "@/lib/football/leagueCalibration.functions";

export const Route = createFileRoute("/backtest")({
  head: () => ({
    meta: [
      { title: "Backtest the model — Pitchcast" },
      {
        name: "description",
        content:
          "Replay finished league matches with as-of form data and measure how the prediction model would have performed.",
      },
    ],
  }),
  loader: async () => {
    const [{ runs }, { leagues }] = await Promise.all([
      listBacktestRuns(),
      getBacktestLeagues(),
    ]);
    return { runs, leagues };
  },
  component: BacktestPage,
  errorComponent: ({ error, reset }) => {
    const router = useRouter();
    return (
      <AppShell>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-sm">
          <p className="font-medium">Couldn't load backtests</p>
          <p className="mt-1 text-muted-foreground">{error.message}</p>
          <Button
            className="mt-4"
            onClick={() => {
              router.invalidate();
              reset();
            }}
          >
            Retry
          </Button>
        </div>
      </AppShell>
    );
  },
  notFoundComponent: () => (
    <AppShell>
      <p className="text-sm text-muted-foreground">Not found.</p>
    </AppShell>
  ),
});

type RunRow = Awaited<ReturnType<typeof listBacktestRuns>>["runs"][number];
type DetailRun = NonNullable<Awaited<ReturnType<typeof getBacktestRun>>["run"]>;

function BacktestPage() {
  const router = useRouter();
  const { runs, leagues } = Route.useLoaderData();
  const [selectedId, setSelectedId] = useState<string | null>(runs[0]?.id ?? null);
  const [detail, setDetail] = useState<DetailRun | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [running, setRunning] = useState(false);

  // form
  const today = new Date().toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const [name, setName] = useState("EPL last 90d");
  const [leagueId, setLeagueId] = useState<number>(leagues[0]?.id ?? 39);
  const [from, setFrom] = useState(ninetyDaysAgo);
  const [to, setTo] = useState(today);
  const [maxMatches, setMaxMatches] = useState(50);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    getBacktestRun({ data: { id: selectedId } })
      .then(({ run }) => setDetail(run as DetailRun | null))
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load run"))
      .finally(() => setLoadingDetail(false));
  }, [selectedId]);

  const onRun = async () => {
    if (running) return;
    if (new Date(from) >= new Date(to)) {
      toast.error("`From` must be before `To`");
      return;
    }
    setRunning(true);
    const tid = toast.loading("Running backtest — this can take 30-60s…");
    try {
      const res = await runBacktestFn({
        data: {
          name,
          leagueId,
          from,
          to,
          maxMatches,
          temperature: 1.289,
          homeAdvantage: 1.15,
          dcRho: 0.08,
          xgWeight: 0.7,
        },
      });
      toast.success(
        `Done · ${res.summary.matchesScored} matches scored · hit ${
          res.summary.hitrate_1x2 != null
            ? (res.summary.hitrate_1x2 * 100).toFixed(1) + "%"
            : "n/a"
        }`,
        { id: tid },
      );
      router.invalidate();
      setSelectedId(res.runId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Backtest failed", { id: tid });
    } finally {
      setRunning(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm("Delete this backtest run?")) return;
    try {
      await deleteBacktestRun({ data: { id } });
      router.invalidate();
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const [calibBusy, setCalibBusy] = useState<"" | "calib" | "elo">("");
  const onCalibrate = async () => {
    setCalibBusy("calib");
    const tid = toast.loading("Grid-searching league calibration — ~1-3 min…");
    try {
      const r = await runLeagueCalibration({
        data: { leagueId, from, to, maxMatches },
      });
      toast.success(
        `Saved · T=${Number(r.temperature).toFixed(2)} · HA=${Number(r.home_advantage).toFixed(2)} · Brier=${r.brier_1x2 != null ? Number(r.brier_1x2).toFixed(4) : "n/a"}`,
        { id: tid },
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Calibration failed", { id: tid });
    } finally {
      setCalibBusy("");
    }
  };
  const onEloRecompute = async () => {
    setCalibBusy("elo");
    const tid = toast.loading("Computing ELO from finished matches…");
    try {
      const r = await runLeagueEloRecompute({ data: { leagueId, from, to } });
      toast.success(`ELO updated · ${r.teams} teams · ${r.matches} matches`, { id: tid });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "ELO recompute failed", { id: tid });
    } finally {
      setCalibBusy("");
    }
  };

  type SweepObjective = "brier" | "logloss" | "hitrate" | "roi";
  type SweepResp = Awaited<ReturnType<typeof runLeagueSweep>>;
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepObjective, setSweepObjective] = useState<SweepObjective>("roi");
  const [sweepPersist, setSweepPersist] = useState(false);
  const [sweep, setSweep] = useState<SweepResp | null>(null);

  const onSweep = async () => {
    if (sweepBusy) return;
    setSweepBusy(true);
    const tid = toast.loading("Henter form-data + scorer ~96 konfigurationer…");
    try {
      const r = await runLeagueSweep({
        data: {
          leagueId, from, to, maxMatches,
          objective: sweepObjective,
          persist: sweepPersist,
        },
      });
      setSweep(r);
      toast.success(
        `Vinder · ROI ${(r.winner.roi_flat * 100).toFixed(1)}% · hit ${(r.winner.hitrate_1x2 * 100).toFixed(1)}% · ${r.pairs} kampe${r.persisted ? " · gemt" : ""}`,
        { id: tid },
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sweep failed", { id: tid });
    } finally {
      setSweepBusy(false);
    }
  };

  return (
    <AppShell>
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <FlaskConical className="h-5 w-5" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight">Backtest</h1>
            <p className="text-sm text-muted-foreground">
              Replay finished matches with as-of form. Stake 1u flat at fair odds on top 1X2 pick.
            </p>
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        {/* Configurator + list */}
        <div className="space-y-6">
          <section className="rounded-xl border border-border/60 bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">New run</h2>
            <div className="space-y-3">
              <div>
                <Label htmlFor="bt-name" className="text-xs">Name</Label>
                <Input
                  id="bt-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 h-9"
                />
              </div>
              <div>
                <Label className="text-xs">League</Label>
                <Select
                  value={String(leagueId)}
                  onValueChange={(v) => setLeagueId(Number(v))}
                >
                  <SelectTrigger className="mt-1 h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {leagues.map((l: { id: number; name: string; country: string }) => (
                      <SelectItem key={l.id} value={String(l.id)}>
                        {l.name} · {l.country}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="bt-from" className="text-xs">From</Label>
                  <Input
                    id="bt-from"
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className="mt-1 h-9"
                  />
                </div>
                <div>
                  <Label htmlFor="bt-to" className="text-xs">To</Label>
                  <Input
                    id="bt-to"
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    className="mt-1 h-9"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="bt-max" className="text-xs">
                  Max matches ({maxMatches}) — capped at 200
                </Label>
                <Input
                  id="bt-max"
                  type="range"
                  min={10}
                  max={200}
                  step={10}
                  value={maxMatches}
                  onChange={(e) => setMaxMatches(Number(e.target.value))}
                  className="mt-1"
                />
              </div>
              <Button onClick={onRun} disabled={running} className="w-full">
                {running ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Running…
                  </>
                ) : (
                  <>Run backtest</>
                )}
              </Button>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Each match costs ~2 API calls. A 50-match run finishes in 30-60s.
              </p>
            </div>
          </section>

          <section className="rounded-xl border border-border/60 bg-card p-4">
            <h2 className="mb-1 text-sm font-semibold">Live tuning</h2>
            <p className="mb-3 text-[11px] text-muted-foreground">
              Calibrate temperature & home-advantage for the selected league
              and recompute ELO ratings from the date range above. Both are
              picked up automatically by every prediction.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                onClick={onCalibrate}
                disabled={calibBusy !== ""}
                className="w-full"
              >
                {calibBusy === "calib" ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Tuning…</>
                ) : (
                  <>Calibrate league</>
                )}
              </Button>
              <Button
                variant="secondary"
                onClick={onEloRecompute}
                disabled={calibBusy !== ""}
                className="w-full"
              >
                {calibBusy === "elo" ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Computing…</>
                ) : (
                  <>Recompute ELO</>
                )}
              </Button>
            </div>
          </section>

          <section className="rounded-xl border border-border/60 bg-card p-4">
            <h2 className="mb-1 text-sm font-semibold">Deep sweep</h2>
            <p className="mb-3 text-[11px] text-muted-foreground">
              Henter form-data én gang (~samme API-pris som ét backtest) og
              evaluerer derefter analytisk ~96 kombinationer af T, HA, ρ og
              xG-vægt. Find den konfiguration der maksimerer dit valgte mål.
            </p>
            <div className="space-y-2">
              <div>
                <Label className="text-xs">Optimer for</Label>
                <Select
                  value={sweepObjective}
                  onValueChange={(v) => setSweepObjective(v as SweepObjective)}
                >
                  <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="roi">ROI (fair odds)</SelectItem>
                    <SelectItem value="hitrate">Hitrate 1X2</SelectItem>
                    <SelectItem value="brier">Brier (kalibrering)</SelectItem>
                    <SelectItem value="logloss">Log-loss</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={sweepPersist}
                  onChange={(e) => setSweepPersist(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Gem vinder som ligaens aktive kalibrering
              </label>
              <Button onClick={onSweep} disabled={sweepBusy} className="w-full">
                {sweepBusy ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sweeping…</>
                ) : (
                  <>Run deep sweep</>
                )}
              </Button>
            </div>
          </section>

          <section className="rounded-xl border border-border/60 bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">History</h2>
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs yet.</p>
            ) : (
              <ul className="space-y-2">
                {runs.map((r: RunRow) => (
                  <RunListItem
                    key={r.id}
                    run={r}
                    active={r.id === selectedId}
                    onSelect={() => setSelectedId(r.id)}
                    onDelete={() => onDelete(r.id)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Detail */}
        <div>
          {loadingDetail ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="space-y-6">
              {sweep && <SweepPanel sweep={sweep} />}
              {detail ? (
                <RunDetail run={detail} />
              ) : !sweep ? (
                <div className="rounded-xl border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
                  Run a backtest or select one from history to see details.
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function SweepPanel({ sweep }: { sweep: Awaited<ReturnType<typeof runLeagueSweep>> }) {
  const delta = (w: number, b: number) => {
    const d = w - b;
    const s = d >= 0 ? "+" : "";
    return `${s}${(d * 100).toFixed(2)}%`;
  };
  return (
    <section className="rounded-xl border border-border/60 bg-card">
      <header className="flex items-center justify-between border-b border-border/40 p-4">
        <div>
          <h3 className="text-sm font-semibold">
            Deep sweep · {sweep.leagueName}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            {sweep.pairs} kampe · optimeret for <strong>{sweep.objective}</strong>
            {sweep.persisted && <span className="ml-2 rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-500">gemt</span>}
          </p>
        </div>
        <div className="text-right text-[11px]">
          <div className="text-muted-foreground">Δ vs baseline</div>
          <div className="font-semibold text-emerald-500">
            ROI {delta(sweep.winner.roi_flat, sweep.baseline.roi_flat)} · hit {delta(sweep.winner.hitrate_1x2, sweep.baseline.hitrate_1x2)}
          </div>
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Rank</th>
              <th className="px-3 py-2 text-right">T</th>
              <th className="px-3 py-2 text-right">HA</th>
              <th className="px-3 py-2 text-right">ρ</th>
              <th className="px-3 py-2 text-right">xG w</th>
              <th className="px-3 py-2 text-right">Brier</th>
              <th className="px-3 py-2 text-right">Log-loss</th>
              <th className="px-3 py-2 text-right">Hit %</th>
              <th className="px-3 py-2 text-right">ROI %</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border/40 bg-muted/30">
              <td className="px-3 py-2 font-semibold">baseline</td>
              <td className="px-3 py-2 text-right tabular-nums">1.29</td>
              <td className="px-3 py-2 text-right tabular-nums">1.15</td>
              <td className="px-3 py-2 text-right tabular-nums">0.08</td>
              <td className="px-3 py-2 text-right tabular-nums">0.70</td>
              <td className="px-3 py-2 text-right tabular-nums">{sweep.baseline.brier_1x2.toFixed(3)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{sweep.baseline.logloss_1x2.toFixed(3)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{(sweep.baseline.hitrate_1x2 * 100).toFixed(1)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{(sweep.baseline.roi_flat * 100).toFixed(1)}</td>
            </tr>
            {sweep.results.map((r, i) => {
              const isWinner = i === 0;
              return (
                <tr
                  key={`${r.cfg.temperature}-${r.cfg.homeAdvantage}-${r.cfg.dcRho}-${r.cfg.xgWeight}`}
                  className={`border-t border-border/40 ${isWinner ? "bg-primary/5 font-semibold" : ""}`}
                >
                  <td className="px-3 py-2">{isWinner ? "★ 1" : i < 12 ? i + 1 : "…"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.cfg.temperature.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.cfg.homeAdvantage.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.cfg.dcRho.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.cfg.xgWeight.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.brier_1x2.toFixed(3)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.logloss_1x2.toFixed(3)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{(r.hitrate_1x2 * 100).toFixed(1)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.roi_flat > 0 ? "text-emerald-500" : "text-destructive"}`}>
                    {(r.roi_flat * 100).toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RunListItem({
  run,
  active,
  onSelect,
  onDelete,
}: {
  run: RunRow;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const statusColor =
    run.status === "completed"
      ? "text-emerald-500"
      : run.status === "failed"
      ? "text-destructive"
      : "text-amber-500";
  return (
    <li
      className={`group flex items-center justify-between gap-2 rounded-lg border p-3 transition cursor-pointer ${
        active ? "border-primary/60 bg-primary/5" : "border-border/40 hover:bg-secondary/40"
      }`}
      onClick={onSelect}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{run.name}</div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {run.competition_name} · {run.date_from} → {run.date_to}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px]">
          <span className={`font-semibold ${statusColor}`}>{run.status}</span>
          {run.status === "completed" && (
            <>
              <span className="text-muted-foreground">·</span>
              <span>{run.matches_scored}/{run.matches_total} scored</span>
              {run.hitrate_1x2 != null && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span>hit {(run.hitrate_1x2 * 100).toFixed(1)}%</span>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="rounded-md p-1.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        aria-label="Delete run"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}

function MetricCard({
  label,
  value,
  hint,
  good,
  Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  good?: boolean | null;
  Icon: typeof Activity;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div
        className={`mt-1 font-display text-2xl font-bold tabular-nums ${
          good === true ? "text-emerald-500" : good === false ? "text-destructive" : ""
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function RunDetail({ run }: { run: DetailRun }) {
  if (run.status === "failed") {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-6">
        <h3 className="font-semibold">Run failed</h3>
        <p className="mt-1 text-sm text-muted-foreground">{run.error_message ?? "Unknown error"}</p>
      </div>
    );
  }
  if (run.status === "running" || run.status === "pending") {
    return (
      <div className="rounded-xl border border-border/60 p-6 text-sm text-muted-foreground">
        Run is still in progress…
      </div>
    );
  }
  const fmtPct = (v: number | null) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
  const fmt = (v: number | null) => (v == null ? "—" : v.toFixed(4));
  const roiPct = run.roi_flat != null ? (run.roi_flat * 100).toFixed(2) + "%" : "—";

  // sort predictions by date desc, take 30 for display
  const preds = (run.results as unknown as Array<{
    matchId: number;
    date: string;
    home: string;
    away: string;
    actual: { h: number; a: number; result: "1" | "X" | "2"; total: number; btts: boolean };
    pred: { pH: number; pD: number; pA: number; pBtts: number; pOver25: number };
    scored: boolean;
  }> | null) ?? [];
  const sorted = [...preds].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-bold">{run.name}</h2>
          <p className="text-sm text-muted-foreground">
            {run.competition_name} · {run.date_from} → {run.date_to}
          </p>
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          <div>T={Number(run.temperature).toFixed(2)} · HA={Number(run.home_advantage).toFixed(2)}</div>
          <div>ρ={Number(run.dc_rho).toFixed(2)} · xG={Number(run.xg_weight).toFixed(2)}</div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard
          label="1X2 hit rate"
          value={fmtPct(run.hitrate_1x2)}
          hint={`${run.matches_scored}/${run.matches_total} scored`}
          good={run.hitrate_1x2 != null ? run.hitrate_1x2 >= 0.45 : null}
          Icon={Target}
        />
        <MetricCard
          label="ROI (flat, fair odds)"
          value={roiPct}
          hint={`${run.bets_placed ?? 0} bets`}
          good={run.roi_flat != null ? run.roi_flat > 0 : null}
          Icon={TrendingUp}
        />
        <MetricCard
          label="Brier 1X2"
          value={fmt(run.brier_1x2)}
          hint="lower = better"
          good={run.brier_1x2 != null ? run.brier_1x2 < 0.6 : null}
          Icon={Activity}
        />
        <MetricCard
          label="Log-loss 1X2"
          value={fmt(run.logloss_1x2)}
          hint="lower = better"
          good={run.logloss_1x2 != null ? run.logloss_1x2 < 1 : null}
          Icon={Activity}
        />
        <MetricCard
          label="Brier BTTS"
          value={fmt(run.brier_btts)}
          hint="lower = better"
          good={run.brier_btts != null ? run.brier_btts < 0.25 : null}
          Icon={Activity}
        />
        <MetricCard
          label="Brier O/U 2.5"
          value={fmt(run.brier_ou25)}
          hint="lower = better"
          good={run.brier_ou25 != null ? run.brier_ou25 < 0.25 : null}
          Icon={Activity}
        />
        <MetricCard
          label="Date range"
          value={`${preds.length}`}
          hint="matches in run"
          Icon={Calendar}
        />
        <MetricCard
          label="Completed"
          value={
            run.completed_at
              ? new Date(run.completed_at).toLocaleDateString()
              : "—"
          }
          Icon={Calendar}
        />
      </div>

      <section className="rounded-xl border border-border/60 bg-card">
        <header className="border-b border-border/40 p-4 text-sm font-semibold">
          Recent predictions ({sorted.length} total)
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Match</th>
                <th className="px-3 py-2 text-center">FT</th>
                <th className="px-3 py-2 text-right">P(1)</th>
                <th className="px-3 py-2 text-right">P(X)</th>
                <th className="px-3 py-2 text-right">P(2)</th>
                <th className="px-3 py-2 text-center">Pick</th>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 30).map((p) => {
                const top = Math.max(p.pred.pH, p.pred.pD, p.pred.pA);
                const pick: "1" | "X" | "2" =
                  top === p.pred.pH ? "1" : top === p.pred.pA ? "2" : "X";
                const correct = pick === p.actual.result;
                return (
                  <tr key={p.matchId} className="border-t border-border/40">
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                      {p.date}
                    </td>
                    <td className="px-3 py-2 truncate">
                      {p.home} vs {p.away}
                    </td>
                    <td className="px-3 py-2 text-center font-mono tabular-nums">
                      {p.actual.h}-{p.actual.a}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {(p.pred.pH * 100).toFixed(0)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {(p.pred.pD * 100).toFixed(0)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {(p.pred.pA * 100).toFixed(0)}
                    </td>
                    <td
                      className={`px-3 py-2 text-center font-semibold ${
                        correct ? "text-emerald-500" : "text-destructive"
                      }`}
                    >
                      {pick} {correct ? "✓" : "✗"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}