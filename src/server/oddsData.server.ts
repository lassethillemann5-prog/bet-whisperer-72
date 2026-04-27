/**
 * The Odds API client (https://the-odds-api.com).
 * Fetches closing/most-recent decimal odds for a fixture so we can compute
 * Closing Line Value (CLV) on settled bets.
 *
 * CLV is the single best long-term EV indicator: a bet that consistently
 * beats the closing line is +EV regardless of short-term win/loss noise.
 */
import type { MatchSummary } from "@/lib/football/types";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ODDS_BASE = "https://api.the-odds-api.com/v4";
const CLOSING_ODDS_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30d — closing odds never change

function cacheClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function getKey(): string | null {
  return process.env.ODDS_API_KEY ?? null;
}

/**
 * Map our internal market id to The Odds API market key.
 * - "1x2"  → "h2h"     (home/draw/away)
 * - "ou_25" → "totals"  (over/under, line=2.5)
 * - "btts"  → "btts"    (yes/no)  (only on some sports)
 */
function mapMarket(internal: string): { key: string; line?: number } | null {
  switch (internal) {
    case "1x2":
      return { key: "h2h" };
    case "ou_25":
      return { key: "totals", line: 2.5 };
    case "ou_15":
      return { key: "totals", line: 1.5 };
    case "btts":
      return { key: "btts" };
    default:
      return null;
  }
}

interface OddsApiOutcome {
  name: string;
  price: number; // decimal odds
  point?: number;
}
interface OddsApiMarket {
  key: string;
  outcomes: OddsApiOutcome[];
}
interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsApiMarket[];
}
interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

/** Median across an array of numbers. Used to "average" across bookmakers. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Find the The Odds API event that matches our fixture by team names + date.
 * The Odds API doesn't share IDs with API-Sports so we fuzzy-match.
 */
function eventMatches(ev: OddsApiEvent, match: MatchSummary): boolean {
  const homeOk =
    ev.home_team.toLowerCase().includes(match.homeTeam.name.toLowerCase()) ||
    match.homeTeam.name.toLowerCase().includes(ev.home_team.toLowerCase());
  const awayOk =
    ev.away_team.toLowerCase().includes(match.awayTeam.name.toLowerCase()) ||
    match.awayTeam.name.toLowerCase().includes(ev.away_team.toLowerCase());
  if (!homeOk || !awayOk) return false;
  // Same calendar day (UTC) is enough — kickoff times can drift by minutes.
  const evDay = ev.commence_time.slice(0, 10);
  const matchDay = match.utcDate.slice(0, 10);
  return evDay === matchDay;
}

/** Map our internal selection token to The Odds API outcome name. */
function selectionToOutcomeName(
  market: string,
  selection: string,
  match: MatchSummary,
): string | null {
  const sel = selection.trim().toUpperCase();
  if (market === "1x2") {
    if (["1", "HOME", "H"].includes(sel)) return match.homeTeam.name;
    if (["X", "DRAW", "D"].includes(sel)) return "Draw";
    if (["2", "AWAY", "A"].includes(sel)) return match.awayTeam.name;
    // Already a team name?
    return selection;
  }
  if (market === "ou_25" || market === "ou_15") {
    if (sel.startsWith("OVER")) return "Over";
    if (sel.startsWith("UNDER")) return "Under";
  }
  if (market === "btts") {
    if (sel.startsWith("YES")) return "Yes";
    if (sel.startsWith("NO")) return "No";
  }
  return null;
}

/**
 * Try to read cached closing odds for this fixture. Returns null on miss.
 * Cache key is `match_id:market:selection` so different selections share
 * the per-match API call.
 */
async function readClosingFromCache(matchId: number, market: string, selection: string): Promise<number | null> {
  const sb = cacheClient();
  if (!sb) return null;
  try {
    const { data } = await sb
      .from("fixtures_cache")
      .select("payload, updated_at")
      .eq("cache_key", `closing-odds:${matchId}:${market}:${selection}`)
      .maybeSingle();
    if (!data?.payload || !data.updated_at) return null;
    if (Date.now() - new Date(data.updated_at).getTime() > CLOSING_ODDS_TTL_MS) return null;
    const v = (data.payload as { value?: number }).value;
    return typeof v === "number" && Number.isFinite(v) && v > 1 ? v : null;
  } catch {
    return null;
  }
}

async function writeClosingToCache(matchId: number, market: string, selection: string, value: number): Promise<void> {
  const sb = cacheClient();
  if (!sb) return;
  try {
    await sb.from("fixtures_cache").upsert({
      cache_key: `closing-odds:${matchId}:${market}:${selection}`,
      payload: { value } as unknown,
      updated_at: new Date().toISOString(),
    });
  } catch {
    // best-effort
  }
}

/**
 * Fetch the closing decimal odds for the given (match, market, selection).
 * Returns the median across bookmakers, or null if not available.
 *
 * Notes:
 *  - We hit /sports/soccer/scores then /sports/{sport_key}/odds for the
 *    relevant sport_key. The Odds API rate limits aggressively so we cache.
 *  - For fully finished matches, the latest odds are effectively the close.
 */
export async function fetchClosingOdds(input: {
  match: MatchSummary;
  market: string;
  selection: string;
}): Promise<number | null> {
  const { match, market, selection } = input;
  const cached = await readClosingFromCache(match.id, market, selection);
  if (cached) return cached;

  const apiKey = getKey();
  if (!apiKey) {
    console.warn("ODDS_API_KEY not configured — skipping CLV capture");
    return null;
  }
  const m = mapMarket(market);
  if (!m) return null;

  // soccer is the broad sport group; The Odds API uses keys like
  // soccer_epl, soccer_uefa_champs_league, etc. Fastest path is to query
  // the `soccer` group endpoint which returns events from all soccer comps.
  // We then narrow by team name + date.
  try {
    const url =
      `${ODDS_BASE}/sports/soccer/odds?apiKey=${apiKey}` +
      `&regions=eu,uk` +
      `&markets=${m.key}` +
      `&oddsFormat=decimal&dateFormat=iso`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`The Odds API ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const events = (await res.json()) as OddsApiEvent[];
    const ev = events.find((e) => eventMatches(e, match));
    if (!ev) return null;

    const outcomeName = selectionToOutcomeName(market, selection, match);
    if (!outcomeName) return null;

    const prices: number[] = [];
    for (const bk of ev.bookmakers) {
      const mkt = bk.markets.find((x) => x.key === m.key);
      if (!mkt) continue;
      const out = mkt.outcomes.find((o) => {
        if (o.name.toLowerCase() !== outcomeName.toLowerCase()) return false;
        if (m.line != null && o.point != null && Math.abs(o.point - m.line) > 0.01) return false;
        return true;
      });
      if (out && out.price > 1) prices.push(out.price);
    }
    const med = median(prices);
    if (med != null) await writeClosingToCache(match.id, market, selection, med);
    return med;
  } catch (e) {
    console.warn("fetchClosingOdds failed", match.id, e);
    return null;
  }
}
