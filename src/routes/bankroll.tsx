import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  Trash2,
  Settings as SettingsIcon,
  Trophy,
  Activity,
  RefreshCw,
  LineChart as LineChartIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  LineChart,
  Line,
  ReferenceLine,
} from "recharts";
import {
  bankrollGrowthSeries,
  clvSeries,
  computeStats,
  deleteBet,
  getBankroll,
  listBets,
  settleBet,
  upsertBankroll,
  type BankrollSettings,
  type BetLogRow,
  type BetStatus,
} from "@/lib/football/bankroll";
import { autoSettleBets } from "@/server/autoSettle.functions";

export const Route = createFileRoute("/bankroll")({
  component: BankrollPage,
});

function BankrollPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [bankroll, setBankroll] = useState<BankrollSettings | null>(null);
  const [bets, setBets] = useState<BetLogRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  const reload = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const [b, l] = await Promise.all([getBankroll(user.id), listBets(user.id)]);
      setBankroll(b);
      setBets(l);
      if (!b) setShowSettings(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (user) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const stats = useMemo(
    () => computeStats(bets, bankroll?.unit_size ?? 0),
    [bets, bankroll?.unit_size],
  );

  const pendingCount = useMemo(
    () => bets.filter((b) => b.status === "pending").length,
    [bets],
  );

  const runAutoSettle = async () => {
    if (!user) return;
    setSettling(true);
    try {
      const res = await autoSettleBets({ data: { userId: user.id } });
      if (res.errors.length > 0) {
        toast.error(`Settled with issues: ${res.errors[0]}`);
      }
      const summary = `Settled ${res.settled}, voided ${res.voided}, ${res.stillPending} still pending`;
      if (res.settled === 0 && res.voided === 0) {
        toast.message("Nothing to settle yet", { description: summary });
      } else {
        toast.success(summary, {
          description:
            res.bankrollDelta !== 0
              ? `Bankroll ${res.bankrollDelta >= 0 ? "+" : ""}${res.bankrollDelta.toFixed(2)}`
              : undefined,
        });
      }
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Auto-settle failed");
    } finally {
      setSettling(false);
    }
  };

  const series = useMemo(
    () => bankrollGrowthSeries(bets, Number(bankroll?.starting_bankroll ?? 0)),
    [bets, bankroll?.starting_bankroll],
  );
  const clv = useMemo(() => clvSeries(bets, 10), [bets]);

  if (loading || !user) return null;

  return (
    <AppShell>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Wallet className="h-5 w-5 text-primary" />
          <h1 className="font-display text-3xl font-bold">Bankroll</h1>
        </div>
        <div className="flex items-center gap-2">
          {bankroll && (
            <Button
              variant="default"
              size="sm"
              onClick={runAutoSettle}
              disabled={settling || pendingCount === 0}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${settling ? "animate-spin" : ""}`} />
              {settling
                ? "Checking results…"
                : pendingCount > 0
                  ? `Auto-settle (${pendingCount})`
                  : "Auto-settle"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setShowSettings((v) => !v)}>
            <SettingsIcon className="h-4 w-4" />
            {showSettings ? "Hide settings" : "Settings"}
          </Button>
        </div>
      </div>

      {(showSettings || !bankroll) && (
        <BankrollSettingsCard
          userId={user.id}
          existing={bankroll}
          onSaved={async (b) => {
            setBankroll(b);
            setShowSettings(false);
            toast.success("Bankroll saved");
          }}
        />
      )}

      {bankroll && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatCard
              icon={<Wallet className="h-4 w-4" />}
              label="Current bankroll"
              value={`${formatCurrency(Number(bankroll.current_bankroll), bankroll.currency)}`}
              sub={`Start ${formatCurrency(Number(bankroll.starting_bankroll), bankroll.currency)}`}
              tone={
                Number(bankroll.current_bankroll) >= Number(bankroll.starting_bankroll)
                  ? "good"
                  : "bad"
              }
            />
            <StatCard
              icon={
                stats.totalProfit >= 0 ? (
                  <TrendingUp className="h-4 w-4" />
                ) : (
                  <TrendingDown className="h-4 w-4" />
                )
              }
              label="Profit"
              value={`${stats.totalProfit >= 0 ? "+" : ""}${formatCurrency(stats.totalProfit, bankroll.currency)}`}
              sub={`${stats.unitsProfit >= 0 ? "+" : ""}${stats.unitsProfit.toFixed(2)} u`}
              tone={stats.totalProfit >= 0 ? "good" : "bad"}
            />
            <StatCard
              icon={<Trophy className="h-4 w-4" />}
              label="Win rate"
              value={`${(stats.winRate * 100).toFixed(1)}%`}
              sub={`${stats.wins}W · ${stats.losses}L · ${stats.voids}V`}
              tone="neutral"
            />
            <StatCard
              icon={<Activity className="h-4 w-4" />}
              label="ROI / Yield"
              value={`${stats.yieldPct >= 0 ? "+" : ""}${stats.yieldPct.toFixed(1)}%`}
              sub={`${stats.totalBets} bets · avg @${stats.avgOdds.toFixed(2)}`}
              tone={stats.yieldPct >= 0 ? "good" : "bad"}
            />
            <StatCard
              icon={<LineChartIcon className="h-4 w-4" />}
              label="CLV"
              value={
                stats.clvSample > 0
                  ? `${stats.avgClvPct >= 0 ? "+" : ""}${stats.avgClvPct.toFixed(2)}%`
                  : "—"
              }
              sub={
                stats.clvSample > 0
                  ? `${(stats.beatCloseRate * 100).toFixed(0)}% beat close · ${stats.clvSample} sample`
                  : "Auto-captured at settle"
              }
              tone={
                stats.clvSample === 0 ? "neutral" : stats.avgClvPct >= 0 ? "good" : "bad"
              }
            />
          </div>

          {series.length > 1 && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-base">Bankroll growth</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={series}>
                    <defs>
                      <linearGradient id="bankrollFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--background))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="bankroll"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      fill="url(#bankrollFill)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-base">Bet log</CardTitle>
            </CardHeader>
            <CardContent>
              {busy ? (
                <div className="h-24 animate-pulse rounded-md bg-secondary/40" />
              ) : bets.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No bets logged yet. Use the “Log bet” button on a match or AI Coach pick to add
                  one.
                </p>
              ) : (
                <BetTable
                  bets={bets}
                  currency={bankroll.currency}
                  onSettle={async (bet, status) => {
                    try {
                      await settleBet({
                        betId: bet.id,
                        status,
                        stake: Number(bet.stake),
                        decimalOdds: Number(bet.decimal_odds),
                        userId: user.id,
                      });
                      await reload();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    }
                  }}
                  onDelete={async (bet) => {
                    try {
                      await deleteBet(bet.id, user.id);
                      await reload();
                      toast.success("Bet removed");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    }
                  }}
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </AppShell>
  );
}

function BankrollSettingsCard({
  userId,
  existing,
  onSaved,
}: {
  userId: string;
  existing: BankrollSettings | null;
  onSaved: (b: BankrollSettings) => void;
}) {
  const [starting, setStarting] = useState(String(existing?.starting_bankroll ?? 1000));
  const [current, setCurrent] = useState(String(existing?.current_bankroll ?? 1000));
  const [unit, setUnit] = useState(String(existing?.unit_size ?? 10));
  const [currency, setCurrency] = useState(existing?.currency ?? "USD");
  const [saving, setSaving] = useState(false);

  const unitPct = useMemo(() => {
    const s = Number(starting);
    const u = Number(unit);
    if (!s || !u) return 0;
    return (u / s) * 100;
  }, [starting, unit]);

  const save = async () => {
    const s = Number(starting);
    const c = Number(current);
    const u = Number(unit);
    if (!Number.isFinite(s) || s <= 0) return toast.error("Starting bankroll must be > 0");
    if (!Number.isFinite(c) || c < 0) return toast.error("Current bankroll must be >= 0");
    if (!Number.isFinite(u) || u <= 0) return toast.error("Unit size must be > 0");
    setSaving(true);
    try {
      const saved = await upsertBankroll({
        userId,
        startingBankroll: s,
        currentBankroll: c,
        unitSize: u,
        currency,
      });
      onSaved(saved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {existing ? "Bankroll settings" : "Set up your bankroll"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <Label>Starting bankroll</Label>
            <Input
              type="number"
              inputMode="decimal"
              value={starting}
              onChange={(e) => setStarting(e.target.value)}
            />
          </div>
          <div>
            <Label>Current bankroll</Label>
            <Input
              type="number"
              inputMode="decimal"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div>
            <Label>1 unit =</Label>
            <Input
              type="number"
              inputMode="decimal"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {unitPct ? `${unitPct.toFixed(2)}% of bankroll` : "—"}
            </p>
          </div>
          <div>
            <Label>Currency</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USD">USD ($)</SelectItem>
                <SelectItem value="EUR">EUR (€)</SelectItem>
                <SelectItem value="GBP">GBP (£)</SelectItem>
                <SelectItem value="DKK">DKK (kr)</SelectItem>
                <SelectItem value="SEK">SEK (kr)</SelectItem>
                <SelectItem value="NOK">NOK (kr)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="rounded-lg border border-border/60 bg-secondary/30 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">Stake tiers</strong> — recommended units per pick
          based on the model's confidence:
          <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-5">
            <span>&lt; 50%: <b className="text-foreground">Skip</b></span>
            <span>50–60%: <b className="text-foreground">0.5 u</b></span>
            <span>60–70%: <b className="text-foreground">1 u</b></span>
            <span>70–80%: <b className="text-foreground">2 u</b></span>
            <span>≥ 80%: <b className="text-foreground">3 u</b></span>
          </div>
        </div>

        <Button onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save bankroll"}
        </Button>
      </CardContent>
    </Card>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone: "good" | "bad" | "neutral";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-400"
      : tone === "bad"
        ? "text-red-400"
        : "text-foreground";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className={`mt-1 font-display text-2xl font-bold ${toneClass}`}>{value}</div>
        <div className="text-[11px] text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}

function BetTable({
  bets,
  currency,
  onSettle,
  onDelete,
}: {
  bets: BetLogRow[];
  currency: string;
  onSettle: (bet: BetLogRow, status: BetStatus) => void;
  onDelete: (bet: BetLogRow) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Match</TableHead>
            <TableHead>Pick</TableHead>
            <TableHead className="text-right">Odds</TableHead>
            <TableHead className="text-right">Stake</TableHead>
            <TableHead className="text-right">Units</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">P/L</TableHead>
            <TableHead className="w-10"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bets.map((b) => (
            <TableRow key={b.id}>
              <TableCell className="max-w-[180px]">
                <div className="truncate font-medium">
                  {b.home_team ?? "?"} <span className="text-muted-foreground">vs</span>{" "}
                  {b.away_team ?? "?"}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {b.competition ?? "—"}
                </div>
              </TableCell>
              <TableCell>
                <div className="font-mono text-xs uppercase text-muted-foreground">{b.market}</div>
                <div className="font-medium">{b.selection}</div>
              </TableCell>
              <TableCell className="text-right font-mono">
                {Number(b.decimal_odds).toFixed(2)}
              </TableCell>
              <TableCell className="text-right">
                {formatCurrency(Number(b.stake), currency)}
              </TableCell>
              <TableCell className="text-right">{Number(b.units).toFixed(2)}</TableCell>
              <TableCell>
                <StatusSelect
                  value={b.status}
                  onChange={(s) => onSettle(b, s)}
                />
              </TableCell>
              <TableCell
                className={`text-right font-mono font-semibold ${
                  Number(b.profit) > 0
                    ? "text-emerald-400"
                    : Number(b.profit) < 0
                      ? "text-red-400"
                      : "text-muted-foreground"
                }`}
              >
                {Number(b.profit) > 0 ? "+" : ""}
                {formatCurrency(Number(b.profit), currency)}
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" onClick={() => onDelete(b)}>
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StatusSelect({
  value,
  onChange,
}: {
  value: BetStatus;
  onChange: (s: BetStatus) => void;
}) {
  const tone =
    value === "won" || value === "half_won"
      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
      : value === "lost" || value === "half_lost"
        ? "bg-red-500/15 text-red-400 border-red-500/30"
        : value === "void"
          ? "bg-secondary text-muted-foreground border-border"
          : "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return (
    <Select value={value} onValueChange={(v) => onChange(v as BetStatus)}>
      <SelectTrigger className={`h-8 w-[110px] border ${tone}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="pending">Pending</SelectItem>
        <SelectItem value="won">Won</SelectItem>
        <SelectItem value="lost">Lost</SelectItem>
        <SelectItem value="half_won">Half won</SelectItem>
        <SelectItem value="half_lost">Half lost</SelectItem>
        <SelectItem value="void">Void</SelectItem>
      </SelectContent>
    </Select>
  );
}

function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

// Re-export for use in match page / log dialog
export { formatCurrency };
// Suppress unused-badge import warning by re-exporting for future use
export { Badge };