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
const LIVE_ODDS_TTL_MS = 1000 * 60 * 60 * 26; // 26h — refreshed daily by cron
const DAILY_SNAPSHOT_TTL_MS = 1000 * 60 * 60 * 26; // 26h
const DAILY_SNAPSHOT_KEY = "odds-daily-snapshot";

/** Bookmakers we want prices from. Using `bookmakers=` instead of `regions=`
 *  is cheaper: we pay 1 region price for up to 10 bookmakers. */
const TARGET_BOOKMAKERS = ["bet365", "betano"] as const;
const MARKETS_TO_FETCH = ["h2h", "totals"] as const;
/** Markets supported by the broad /sports/soccer/odds endpoint (used by daily snapshot).
 *  `btts` is only available on per-sport-key endpoints, so we exclude it here. */
const SNAPSHOT_MARKETS = ["h2h", "totals"] as const;

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
function selectionToOutcomeName(market: string, selection: string, match: MatchSummary): string | null {
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

// ============================================================================
// Pre-match live odds — used for value/edge detection in the UI.
// ============================================================================

export interface BookmakerPrice {
  bookmaker: string; // "bet365" | "betano"
  price: number;
}

export interface MarketOddsRow {
  market: string; // "1x2" | "ou_25" | "ou_15" | "btts"
  selection: string; // canonical: "1"|"X"|"2", "Over 2.5"|"Under 2.5", "Yes"|"No"
  prices: BookmakerPrice[];
  best: number; // best (highest) price across our bookmakers
}

export interface MatchOddsResult {
  matchId: number;
  rows: MarketOddsRow[];
  cacheHit: boolean;
  creditsUsed: number;
  fetchedAt: string;
  error?: string;
}

/** Convert The Odds API outcome name back to our internal selection token. */
function outcomeToSelection(
  marketKey: string,
  outcome: OddsApiOutcome,
  match: MatchSummary,
): { market: string; selection: string } | null {
  const name = outcome.name;
  if (marketKey === "h2h") {
    if (name === "Draw") return { market: "1x2", selection: "X" };
    if (name.toLowerCase() === match.homeTeam.name.toLowerCase()) return { market: "1x2", selection: "1" };
    if (name.toLowerCase() === match.awayTeam.name.toLowerCase()) return { market: "1x2", selection: "2" };
    return null;
  }
  if (marketKey === "totals") {
    const point = outcome.point;
    if (point == null) return null;
    const internal = Math.abs(point - 2.5) < 0.01 ? "ou_25" : Math.abs(point - 1.5) < 0.01 ? "ou_15" : null;
    if (!internal) return null;
    if (name.toLowerCase() === "over") return { market: internal, selection: `Over ${point}` };
    if (name.toLowerCase() === "under") return { market: internal, selection: `Under ${point}` };
    return null;
  }
  if (marketKey === "btts") {
    if (name.toLowerCase() === "yes") return { market: "btts", selection: "Yes" };
    if (name.toLowerCase() === "no") return { market: "btts", selection: "No" };
  }
  return null;
}

async function readLiveOddsFromCache(matchId: number): Promise<MatchOddsResult | null> {
  const sb = cacheClient();
  if (!sb) return null;
  try {
    const { data } = await sb
      .from("fixtures_cache")
      .select("payload, updated_at")
      .eq("cache_key", `live-odds:${matchId}`)
      .maybeSingle();
    if (!data?.payload || !data.updated_at) return null;
    if (Date.now() - new Date(data.updated_at).getTime() > LIVE_ODDS_TTL_MS) return null;
    return data.payload as MatchOddsResult;
  } catch {
    return null;
  }
}

async function writeLiveOddsToCache(matchId: number, payload: MatchOddsResult): Promise<void> {
  const sb = cacheClient();
  if (!sb) return;
  try {
    await sb.from("fixtures_cache").upsert({
      cache_key: `live-odds:${matchId}`,
      payload: payload as unknown,
      updated_at: new Date().toISOString(),
    });
  } catch {
    // best-effort
  }
}

// ============================================================================
// Daily snapshot — one API call returns ALL soccer events. We cache the raw
// event list for 24h+ and serve every per-match request from it (0 credits).
// ============================================================================

async function readDailySnapshot(): Promise<OddsApiEvent[] | null> {
  const sb = cacheClient();
  if (!sb) return null;
  try {
    const { data } = await sb
      .from("fixtures_cache")
      .select("payload, updated_at")
      .eq("cache_key", DAILY_SNAPSHOT_KEY)
      .maybeSingle();
    if (!data?.payload || !data.updated_at) return null;
    if (Date.now() - new Date(data.updated_at).getTime() > DAILY_SNAPSHOT_TTL_MS) return null;
    return (data.payload as { events: OddsApiEvent[] }).events ?? null;
  } catch {
    return null;
  }
}

async function writeDailySnapshot(events: OddsApiEvent[]): Promise<void> {
  const sb = cacheClient();
  if (!sb) return;
  try {
    await sb.from("fixtures_cache").upsert({
      cache_key: DAILY_SNAPSHOT_KEY,
      payload: { events } as unknown,
      updated_at: new Date().toISOString(),
    });
  } catch {
    // best-effort
  }
}

function buildResultFromEvent(matchId: number, ev: OddsApiEvent): MatchOddsResult {
  const grouped = new Map<string, MarketOddsRow>();
  for (const bk of ev.bookmakers) {
    if (!TARGET_BOOKMAKERS.includes(bk.key as (typeof TARGET_BOOKMAKERS)[number])) continue;
    for (const mkt of bk.markets) {
      for (const out of mkt.outcomes) {
        // We need a MatchSummary for outcomeToSelection's team-name disambig.
        // For 1x2 we fall back to event team names which match by construction.
        const fakeMatch = {
          id: matchId,
          homeTeam: { name: ev.home_team },
          awayTeam: { name: ev.away_team },
          utcDate: ev.commence_time,
        } as unknown as MatchSummary;
        const mapped = outcomeToSelection(mkt.key, out, fakeMatch);
        if (!mapped) continue;
        if (!(out.price > 1)) continue;
        const key = `${mapped.market}::${mapped.selection}`;
        let row = grouped.get(key);
        if (!row) {
          row = { market: mapped.market, selection: mapped.selection, prices: [], best: 0 };
          grouped.set(key, row);
        }
        row.prices.push({ bookmaker: bk.key, price: out.price });
        if (out.price > row.best) row.best = out.price;
      }
    }
  }
  return {
    matchId,
    rows: Array.from(grouped.values()),
    cacheHit: true,
    creditsUsed: 0,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Run by daily cron. Hits The Odds API once for ALL soccer events and
 * caches the result. Cost: ~30 credits per day total.
 * Also pre-warms per-match cache for any tracked fixtures it can match.
 */
export async function fetchDailyOddsSnapshot(): Promise<{
  ok: boolean;
  events: number;
  matched: number;
  creditsUsed: number;
  error?: string;
}> {
  const apiKey = getKey();
  if (!apiKey) return { ok: false, events: 0, matched: 0, creditsUsed: 0, error: "ODDS_API_KEY not configured" };
  try {
    const url =
      `${ODDS_BASE}/sports/soccer/odds?apiKey=${apiKey}` +
      `&bookmakers=${TARGET_BOOKMAKERS.join(",")}` +
      `&markets=${SNAPSHOT_MARKETS.join(",")}` +
      `&oddsFormat=decimal&dateFormat=iso`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        events: 0,
        matched: 0,
        creditsUsed: 0,
        error: `The Odds API ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const events = (await res.json()) as OddsApiEvent[];
    await writeDailySnapshot(events);
    const creditsUsed = SNAPSHOT_MARKETS.length * 1 * 10;
    return { ok: true, events: events.length, matched: 0, creditsUsed };
  } catch (e) {
    return {
      ok: false,
      events: 0,
      matched: 0,
      creditsUsed: 0,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

async function logUsage(
  userId: string,
  matchId: number,
  market: string,
  creditsUsed: number,
  cacheHit: boolean,
): Promise<void> {
  const sb = cacheClient();
  if (!sb) return;
  try {
    await sb.from("odds_api_usage").insert({
      user_id: userId,
      match_id: matchId,
      market,
      credits_used: creditsUsed,
      cache_hit: cacheHit,
    });
  } catch {
    // best-effort
  }
}

/** Fetch pre-match odds for a single match from The Odds API.
 *  Uses bookmakers=bet365,betano (cheaper than regions=eu).
 *  Cost when not cached: ~30 credits (3 markets × 1 region × 10 multiplier). */
export async function fetchMatchLiveOdds(input: {
  match: MatchSummary;
  userId: string;
  forceRefresh?: boolean;
}): Promise<MatchOddsResult> {
  const { match, userId, forceRefresh } = input;

  if (!forceRefresh) {
    const cached = await readLiveOddsFromCache(match.id);
    if (cached) {
      await logUsage(userId, match.id, "all", 0, true);
      return { ...cached, cacheHit: true, creditsUsed: 0 };
    }
    // Try the daily snapshot — 0 credits if found.
    const snapshot = await readDailySnapshot();
    if (snapshot) {
      const ev = snapshot.find((e) => eventMatches(e, match));
      if (ev) {
        const result = buildResultFromEvent(match.id, ev);
        await writeLiveOddsToCache(match.id, result);
        await logUsage(userId, match.id, "all", 0, true);
        return result;
      }
    }
  }

  const apiKey = getKey();
  if (!apiKey) {
    return {
      matchId: match.id,
      rows: [],
      cacheHit: false,
      creditsUsed: 0,
      fetchedAt: new Date().toISOString(),
      error: "ODDS_API_KEY not configured",
    };
  }

  try {
    const url =
      `${ODDS_BASE}/sports/soccer/odds?apiKey=${apiKey}` +
      `&bookmakers=${TARGET_BOOKMAKERS.join(",")}` +
      `&markets=${MARKETS_TO_FETCH.join(",")}` +
      `&oddsFormat=decimal&dateFormat=iso`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        matchId: match.id,
        rows: [],
        cacheHit: false,
        creditsUsed: 0,
        fetchedAt: new Date().toISOString(),
        error: `The Odds API ${res.status}: ${body.slice(0, 120)}`,
      };
    }
    const events = (await res.json()) as OddsApiEvent[];
    const ev = events.find((e) => eventMatches(e, match));

    // Estimate credits: markets × regions × 10 (soccer multiplier)
    const creditsUsed = MARKETS_TO_FETCH.length * 1 * 10;

    if (!ev) {
      const empty: MatchOddsResult = {
        matchId: match.id,
        rows: [],
        cacheHit: false,
        creditsUsed,
        fetchedAt: new Date().toISOString(),
        error: "No matching event found at bet365/betano",
      };
      await writeLiveOddsToCache(match.id, empty);
      await logUsage(userId, match.id, "all", creditsUsed, false);
      return empty;
    }

    // Group: market+selection → bookmaker prices
    const grouped = new Map<string, MarketOddsRow>();
    for (const bk of ev.bookmakers) {
      if (!TARGET_BOOKMAKERS.includes(bk.key as (typeof TARGET_BOOKMAKERS)[number])) continue;
      for (const mkt of bk.markets) {
        for (const out of mkt.outcomes) {
          const mapped = outcomeToSelection(mkt.key, out, match);
          if (!mapped) continue;
          if (!(out.price > 1)) continue;
          const key = `${mapped.market}::${mapped.selection}`;
          let row = grouped.get(key);
          if (!row) {
            row = { market: mapped.market, selection: mapped.selection, prices: [], best: 0 };
            grouped.set(key, row);
          }
          row.prices.push({ bookmaker: bk.key, price: out.price });
          if (out.price > row.best) row.best = out.price;
        }
      }
    }

    const result: MatchOddsResult = {
      matchId: match.id,
      rows: Array.from(grouped.values()),
      cacheHit: false,
      creditsUsed,
      fetchedAt: new Date().toISOString(),
    };
    await writeLiveOddsToCache(match.id, result);
    await logUsage(userId, match.id, "all", creditsUsed, false);
    return result;
  } catch (e) {
    return {
      matchId: match.id,
      rows: [],
      cacheHit: false,
      creditsUsed: 0,
      fetchedAt: new Date().toISOString(),
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

/** Get monthly credit usage for a user. */
export async function getOddsApiUsage(userId: string): Promise<{
  monthCredits: number;
  monthFetches: number;
  lastFetchAt: string | null;
}> {
  const sb = cacheClient();
  if (!sb) return { monthCredits: 0, monthFetches: 0, lastFetchAt: null };
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  try {
    const { data } = await sb
      .from("odds_api_usage")
      .select("credits_used, created_at")
      .eq("user_id", userId)
      .gte("created_at", start.toISOString())
      .order("created_at", { ascending: false });
    if (!data) return { monthCredits: 0, monthFetches: 0, lastFetchAt: null };
    const monthCredits = data.reduce((s, r) => s + (r.credits_used ?? 0), 0);
    return {
      monthCredits,
      monthFetches: data.length,
      lastFetchAt: data[0]?.created_at ?? null,
    };
  } catch {
    return { monthCredits: 0, monthFetches: 0, lastFetchAt: null };
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
