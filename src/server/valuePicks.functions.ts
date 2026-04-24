import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { MatchPredictions, MatchSummary } from "@/lib/football/types";

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface ValuePick {
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  utcDate: string;
  market: string;
  marketLabel: string;
  selection: string;
  bookmaker: string | null;
  decimalOdds: number;
  modelProb: number; // 0..1
  impliedProb: number; // 0..1
  edgePct: number; // (model - implied) * 100
  evPct: number; // expected value % per unit stake: (model*odds - 1) * 100
  oddsId: string;
}

export const getValuePicks = createServerFn({ method: "POST" })
  .inputValidator((input: { userId: string }) => input)
  .handler(async ({ data }) => {
    const supabase = adminClient();
    const userId = data.userId;

    // 1. Tracked matches for this user
    const { data: tracked, error: tErr } = await supabase
      .from("tracked_matches")
      .select("match_id, home_team, away_team, competition, utc_date")
      .eq("user_id", userId);
    if (tErr) throw tErr;
    const trackedRows = tracked ?? [];
    if (trackedRows.length === 0) return { picks: [] as ValuePick[], error: null as string | null };

    const matchIds = trackedRows.map((r) => r.match_id);

    // 2. Odds for those matches
    const { data: odds, error: oErr } = await supabase
      .from("match_odds")
      .select("*")
      .eq("user_id", userId)
      .in("match_id", matchIds);
    if (oErr) throw oErr;
    const oddsRows = odds ?? [];
    if (oddsRows.length === 0) return { picks: [] as ValuePick[], error: null };

    // 3. Predictions cache for those matches
    const { data: cached, error: cErr } = await supabase
      .from("predictions_cache")
      .select("match_id, payload")
      .in("match_id", matchIds);
    if (cErr) throw cErr;

    const predByMatch = new Map<number, { match: MatchSummary; predictions: MatchPredictions }>();
    for (const row of cached ?? []) {
      const payload = row.payload as unknown as { match: MatchSummary; predictions: MatchPredictions };
      if (payload?.predictions) predByMatch.set(row.match_id as number, payload);
    }

    const trackedByMatch = new Map(trackedRows.map((t) => [t.match_id as number, t]));

    const picks: ValuePick[] = [];
    for (const o of oddsRows) {
      const matchId = o.match_id as number;
      const pred = predByMatch.get(matchId);
      const t = trackedByMatch.get(matchId);
      if (!pred || !t) continue;

      const market = pred.predictions.markets.find((m) => m.market === o.market);
      if (!market) continue;
      const probPct = market.probabilities[o.selection];
      if (typeof probPct !== "number") continue;

      const modelProb = probPct / 100;
      const decimalOdds = Number(o.decimal_odds);
      if (!(decimalOdds > 1)) continue;
      const impliedProb = 1 / decimalOdds;
      const edgePct = (modelProb - impliedProb) * 100;
      const evPct = (modelProb * decimalOdds - 1) * 100;

      picks.push({
        matchId,
        homeTeam: t.home_team as string,
        awayTeam: t.away_team as string,
        competition: (t.competition as string | null) ?? null,
        utcDate: t.utc_date as string,
        market: market.market,
        marketLabel: market.label,
        selection: o.selection as string,
        bookmaker: (o.bookmaker as string | null) ?? null,
        decimalOdds,
        modelProb,
        impliedProb,
        edgePct,
        evPct,
        oddsId: o.id as string,
      });
    }

    picks.sort((a, b) => b.edgePct - a.edgePct);
    return { picks, error: null };
  });
