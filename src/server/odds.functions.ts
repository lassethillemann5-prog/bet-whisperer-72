import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { fetchMatch } from "./footballData.server";
import type { MatchSummary } from "@/lib/football/types";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const ODDS_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h — one paid pull per sport/day/cache key
const DEFAULT_BOOKMAKER = "bet365";
const DEFAULT_REGIONS = "eu";
const DEFAULT_MARKETS = "h2h,totals,btts";

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

function oddsApiKey(): string {
  const key = process.env.THE_ODDS_API_KEY ?? process.env.ODDS_API_KEY;
  if (!key) throw new Error("THE_ODDS_API_KEY is not configured");
  return key;
}

export interface MarketOddsRow {
  market: string;
  selection: string;
  bookmaker: string;
  bookmakerTitle: string;
  decimalOdds: number;
  odds: number;
  price: number;
  impliedProbability: number;
  impliedPct: number;
  line?: number | null;
  lastUpdate?: string | null;
  provider: "the-odds-api";
  eventId?: string;
}

export interface MatchOddsResult {
  matchId: number;
  rows: MarketOddsRow[];
  cacheHit: boolean;
  creditsUsed: number;
  sportKey?: string | null;
  bookmaker?: string;
  pulledAt?: string | null;
  error: string | null;
}

interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}

interface OddsApiMarket {
  key: string;
  last_update?: string;
  outcomes: OddsApiOutcome[];
}

interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update?: string;
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

function normalize(input?: string | null): string {
  return (input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(fc|cf|afc|sc|ac|cd|club|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenOverlapScore(a: string, b: string): number {
  const aa = new Set(normalize(a).split(" ").filter((t) => t.length > 2));
  const bb = new Set(normalize(b).split(" ").filter((t) => t.length > 2));
  if (aa.size === 0 || bb.size === 0) return 0;
  let overlap = 0;
  for (const t of aa) if (bb.has(t)) overlap++;
  return overlap / Math.max(aa.size, bb.size);
}

function teamSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.82;
  return tokenOverlapScore(a, b);
}

function sportKeyForMatch(match: MatchSummary): string | null {
  const league = normalize(match.competition?.name);
  const country = normalize(match.competition?.country);
  const haystack = `${country} ${league}`;

  // UEFA / international competitions first because country is often "World" or null.
  if (league.includes("champions league")) return "soccer_uefa_champs_league";
  if (league.includes("europa conference")) return "soccer_uefa_europa_conference_league";
  if (league.includes("europa league")) return "soccer_uefa_europa_league";
  if (league.includes("world cup")) return "soccer_fifa_world_cup";
  if (league.includes("fa cup")) return "soccer_fa_cup";

  if (haystack.includes("england premier league")) return "soccer_epl";
  if (haystack.includes("england championship") || league === "championship") return "soccer_efl_champ";
  if (haystack.includes("england league one")) return "soccer_england_league1";
  if (haystack.includes("england league two")) return "soccer_england_league2";
  if (haystack.includes("spain la liga") || haystack.includes("spain primera division")) return "soccer_spain_la_liga";
  if (haystack.includes("spain segunda")) return "soccer_spain_segunda_division";
  if (haystack.includes("italy serie a")) return "soccer_italy_serie_a";
  if (haystack.includes("germany bundesliga")) return "soccer_germany_bundesliga";
  if (haystack.includes("france ligue 1") || haystack.includes("france ligue one")) return "soccer_france_ligue_one";
  if (haystack.includes("netherlands eredivisie")) return "soccer_netherlands_eredivisie";
  if (haystack.includes("portugal primeira") || haystack.includes("portugal liga portugal")) return "soccer_portugal_primeira_liga";
  if (haystack.includes("denmark superliga")) return "soccer_denmark_superliga";
  if (haystack.includes("belgium")) return "soccer_belgium_first_div";
  if (haystack.includes("turkey")) return "soccer_turkey_super_league";
  if (haystack.includes("scotland premiership")) return "soccer_scotland_premiership";
  if (haystack.includes("usa mls") || haystack.includes("major league soccer")) return "soccer_usa_mls";
  if (haystack.includes("brazil")) return "soccer_brazil_campeonato";
  if (haystack.includes("argentina")) return "soccer_argentina_primera_division";
  if (haystack.includes("mexico")) return "soccer_mexico_ligamx";
  if (haystack.includes("norway")) return "soccer_norway_eliteserien";
  if (haystack.includes("sweden allsvenskan")) return "soccer_sweden_allsvenskan";
  if (haystack.includes("switzerland")) return "soccer_switzerland_superleague";
  if (haystack.includes("austria")) return "soccer_austria_bundesliga";
  if (haystack.includes("greece")) return "soccer_greece_super_league";
  if (haystack.includes("japan")) return "soccer_japan_j_league";
  if (haystack.includes("korea")) return "soccer_korea_kleague1";

  return null;
}

function cacheKeyFor(match: MatchSummary, sportKey: string, bookmaker: string): string {
  const date = match.utcDate.slice(0, 10);
  return `the-odds-api:${sportKey}:${date}:${bookmaker}`;
}

async function readCache<T>(
  supabase: ReturnType<typeof adminClient>,
  column: "match_id" | "cache_key",
  value: string | number,
): Promise<T | null> {
  try {
    const { data } = await supabase
      .from("odds_cache")
      .select("payload, updated_at")
      .eq(column, value)
      .maybeSingle();
    if (!data?.payload || !data.updated_at) return null;
    if (Date.now() - new Date(data.updated_at).getTime() > ODDS_CACHE_TTL_MS) return null;
    return data.payload as T;
  } catch (e) {
    console.warn("odds cache read skipped", e);
    return null;
  }
}

async function writeCache(
  supabase: ReturnType<typeof adminClient>,
  row: { match_id?: number; cache_key?: string; payload: unknown },
): Promise<void> {
  try {
    await supabase.from("odds_cache").upsert({
      ...row,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("odds cache write skipped", e);
  }
}

async function fetchSportOdds(sportKey: string, bookmaker: string): Promise<OddsApiEvent[]> {
  const params = new URLSearchParams({
    apiKey: oddsApiKey(),
    regions: process.env.THE_ODDS_API_REGIONS ?? DEFAULT_REGIONS,
    bookmakers: bookmaker,
    markets: process.env.THE_ODDS_API_MARKETS ?? DEFAULT_MARKETS,
    oddsFormat: "decimal",
    dateFormat: "iso",
  });
  const res = await fetch(`${ODDS_API_BASE}/sports/${sportKey}/odds?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`The Odds API ${res.status}: ${body.slice(0, 220)}`);
  }
  return (await res.json()) as OddsApiEvent[];
}

function findMatchingEvent(match: MatchSummary, events: OddsApiEvent[]): OddsApiEvent | null {
  const kickoffMs = new Date(match.utcDate).getTime();
  let best: { event: OddsApiEvent; score: number } | null = null;

  for (const event of events) {
    const eventMs = new Date(event.commence_time).getTime();
    const hoursDiff = Math.abs(eventMs - kickoffMs) / (1000 * 60 * 60);
    if (!Number.isFinite(hoursDiff) || hoursDiff > 36) continue;

    const homeScore = teamSimilarity(match.homeTeam.name, event.home_team);
    const awayScore = teamSimilarity(match.awayTeam.name, event.away_team);
    const timeScore = Math.max(0, 1 - hoursDiff / 36);
    const score = homeScore * 0.45 + awayScore * 0.45 + timeScore * 0.1;

    if (!best || score > best.score) best = { event, score };
  }

  return best && best.score >= 0.62 ? best.event : null;
}

function selectionForH2h(outcomeName: string, match: MatchSummary): string | null {
  const name = normalize(outcomeName);
  if (name === "draw") return "X";
  if (teamSimilarity(outcomeName, match.homeTeam.name) >= 0.62) return "1";
  if (teamSimilarity(outcomeName, match.awayTeam.name) >= 0.62) return "2";
  return null;
}

function rowFromOutcome(params: {
  market: string;
  selection: string;
  outcome: OddsApiOutcome;
  bookmaker: OddsApiBookmaker;
  apiMarket: OddsApiMarket;
  event: OddsApiEvent;
}): MarketOddsRow | null {
  const price = Number(params.outcome.price);
  if (!Number.isFinite(price) || price <= 1) return null;
  const implied = +(100 / price).toFixed(2);
  return {
    market: params.market,
    selection: params.selection,
    bookmaker: params.bookmaker.key,
    bookmakerTitle: params.bookmaker.title,
    decimalOdds: price,
    odds: price,
    price,
    impliedProbability: implied,
    impliedPct: implied,
    line: typeof params.outcome.point === "number" ? params.outcome.point : null,
    lastUpdate: params.apiMarket.last_update ?? params.bookmaker.last_update ?? null,
    provider: "the-odds-api",
    eventId: params.event.id,
  };
}

function rowsForMatch(match: MatchSummary, event: OddsApiEvent, bookmakerKey: string): MarketOddsRow[] {
  const bookmaker =
    event.bookmakers.find((b) => b.key === bookmakerKey) ??
    event.bookmakers.find((b) => b.key.toLowerCase().includes(bookmakerKey.toLowerCase()));
  if (!bookmaker) return [];

  const rows: MarketOddsRow[] = [];
  for (const market of bookmaker.markets ?? []) {
    if (market.key === "h2h") {
      for (const outcome of market.outcomes ?? []) {
        const selection = selectionForH2h(outcome.name, match);
        if (!selection) continue;
        const row = rowFromOutcome({ market: "1x2", selection, outcome, bookmaker, apiMarket: market, event });
        if (row) rows.push(row);
      }
    }

    if (market.key === "totals") {
      for (const outcome of market.outcomes ?? []) {
        if (typeof outcome.point !== "number") continue;
        const marketKey = Math.abs(outcome.point - 2.5) < 0.001 ? "ou_25" : Math.abs(outcome.point - 1.5) < 0.001 ? "ou_15" : null;
        if (!marketKey) continue;
        const selection = outcome.name === "Over" ? "Over" : outcome.name === "Under" ? "Under" : null;
        if (!selection) continue;
        const row = rowFromOutcome({ market: marketKey, selection, outcome, bookmaker, apiMarket: market, event });
        if (row) rows.push(row);
      }
    }

    if (market.key === "btts") {
      for (const outcome of market.outcomes ?? []) {
        const selection = /^yes$/i.test(outcome.name) ? "Yes" : /^no$/i.test(outcome.name) ? "No" : null;
        if (!selection) continue;
        const row = rowFromOutcome({ market: "btts", selection, outcome, bookmaker, apiMarket: market, event });
        if (row) rows.push(row);
      }
    }
  }

  rows.sort((a, b) => `${a.market}:${a.selection}`.localeCompare(`${b.market}:${b.selection}`));
  return rows;
}

export const fetchMatchOdds = createServerFn({ method: "POST" })
  .inputValidator((input: { matchId: number; userId?: string; forceRefresh?: boolean }) => input)
  .handler(async ({ data }): Promise<any> => {
    const matchId = Number(data.matchId);
    const bookmaker = process.env.THE_ODDS_API_BOOKMAKER ?? DEFAULT_BOOKMAKER;

    try {
      const supabase = adminClient();

      // Always prefer the 24h match cache. forceRefresh is intentionally ignored
      // to protect The Odds API credits; stale rows refresh automatically after 24h.
      const cached = await readCache<MatchOddsResult>(supabase, "match_id", matchId);
      if (cached) return { ...cached, cacheHit: true, creditsUsed: 0, error: null };

      const match = await fetchMatch(matchId);
      const sportKey = sportKeyForMatch(match);
      if (!sportKey) {
        return {
          matchId,
          rows: [],
          cacheHit: false,
          creditsUsed: 0,
          sportKey: null,
          bookmaker,
          pulledAt: null,
          error: `No The Odds API sport mapping for ${match.competition?.country ? `${match.competition.country} — ` : ""}${match.competition?.name ?? "this league"}.`,
        } satisfies MatchOddsResult;
      }

      const rawCacheKey = cacheKeyFor(match, sportKey, bookmaker);
      let events = await readCache<OddsApiEvent[]>(supabase, "cache_key", rawCacheKey);
      let creditsUsed = 0;

      if (!events) {
        events = await fetchSportOdds(sportKey, bookmaker);
        creditsUsed = 1;
        await writeCache(supabase, { cache_key: rawCacheKey, payload: events });
      }

      const event = findMatchingEvent(match, events);
      const rows = event ? rowsForMatch(match, event, bookmaker) : [];
      const result: MatchOddsResult = {
        matchId,
        rows,
        cacheHit: creditsUsed === 0,
        creditsUsed,
        sportKey,
        bookmaker,
        pulledAt: new Date().toISOString(),
        error: event ? null : "No matching Bet365 odds found for this fixture yet.",
      };

      await writeCache(supabase, { match_id: matchId, payload: result });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to fetch odds";
      return {
        matchId,
        rows: [],
        cacheHit: false,
        creditsUsed: 0,
        sportKey: null,
        bookmaker,
        pulledAt: null,
        error: msg,
      } satisfies MatchOddsResult;
    }
  });
