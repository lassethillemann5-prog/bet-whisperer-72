import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import {
  addBet,
  getBankroll,
  tierLabel,
  unitsForProbability,
  type BankrollSettings,
} from "@/lib/football/bankroll";
import { Wallet, Receipt } from "lucide-react";
import { toast } from "sonner";

export interface LogBetSeed {
  matchId?: number | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
  competition?: string | null;
  utcDate?: string | null;
  market: string;
  selection: string;
  decimalOdds?: number | null;
  modelProbability?: number | null; // 0..1
}

export function LogBetDialog({
  seed,
  trigger,
}: {
  seed: LogBetSeed;
  trigger?: React.ReactNode;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [bankroll, setBankroll] = useState<BankrollSettings | null>(null);
  const [units, setUnits] = useState<string>(() =>
    String(unitsForProbability(seed.modelProbability ?? 0) || 1),
  );
  const [odds, setOdds] = useState<string>(
    seed.decimalOdds && seed.decimalOdds > 1 ? seed.decimalOdds.toFixed(2) : "2.00",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !user) return;
    void getBankroll(user.id).then(setBankroll);
  }, [open, user]);

  const unitSize = Number(bankroll?.unit_size ?? 0);
  const stake = useMemo(() => {
    const u = Number(units);
    if (!Number.isFinite(u) || u <= 0 || unitSize <= 0) return 0;
    return +(u * unitSize).toFixed(2);
  }, [units, unitSize]);

  const tier = seed.modelProbability ? tierLabel(seed.modelProbability) : null;
  const recommended = seed.modelProbability ? unitsForProbability(seed.modelProbability) : 0;

  const submit = async () => {
    if (!user) return toast.error("Sign in to log bets");
    if (!bankroll) return;
    const u = Number(units);
    const o = Number(odds);
    if (!Number.isFinite(u) || u <= 0) return toast.error("Units must be > 0");
    if (!Number.isFinite(o) || o <= 1) return toast.error("Odds must be > 1.00");
    setBusy(true);
    try {
      await addBet({
        userId: user.id,
        matchId: seed.matchId ?? null,
        homeTeam: seed.homeTeam ?? null,
        awayTeam: seed.awayTeam ?? null,
        competition: seed.competition ?? null,
        utcDate: seed.utcDate ?? null,
        market: seed.market,
        selection: seed.selection,
        decimalOdds: o,
        stake,
        units: u,
        modelProbability: seed.modelProbability ?? null,
      });
      toast.success(`Bet logged · ${u}u @ ${o.toFixed(2)}`);
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to log bet");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="secondary" className="gap-1.5">
            <Receipt className="h-3.5 w-3.5" />
            Log bet
          </Button>
        )}
      </DialogTrigger>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Log bet</DialogTitle>
          <DialogDescription>
            {seed.homeTeam ?? "?"} vs {seed.awayTeam ?? "?"} —{" "}
            <span className="font-mono uppercase">{seed.market}</span>:{" "}
            <b className="text-foreground">{seed.selection}</b>
          </DialogDescription>
        </DialogHeader>

        {!bankroll ? (
          <div className="rounded-lg border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
            <Wallet className="mb-2 h-4 w-4" />
            Set up your bankroll first.{" "}
            <Link to="/bankroll" className="text-primary hover:underline" onClick={() => setOpen(false)}>
              Open bankroll →
            </Link>
          </div>
        ) : (
          <>
            {tier && (
              <div className="rounded-lg border border-border/60 bg-secondary/40 p-3 text-xs">
                Model confidence:{" "}
                <b className="text-foreground">{(seed.modelProbability! * 100).toFixed(0)}%</b> ·
                tier <b className="text-foreground">{tier.label}</b> · recommended{" "}
                <b className="text-foreground">{recommended} u</b>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Units</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.5"
                  value={units}
                  onChange={(e) => setUnits(e.target.value)}
                />
              </div>
              <div>
                <Label>Decimal odds</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={odds}
                  onChange={(e) => setOdds(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-secondary/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Stake</span>
              <span className="font-display text-lg font-bold">
                {formatMoney(stake, bankroll.currency)}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Potential return</span>
              <span className="font-mono">
                {formatMoney(stake * Number(odds || 0), bankroll.currency)} ·{" "}
                <span className="text-emerald-400">
                  +{formatMoney(stake * (Number(odds || 0) - 1), bankroll.currency)}
                </span>
              </span>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !bankroll}>
            {busy ? "Saving…" : "Log bet"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatMoney(value: number, currency: string): string {
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