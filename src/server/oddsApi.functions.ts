import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

// The Odds API sport keys we look up against. Soccer competitions are
// uniquely identified by sport_key; we try a small set of common ones and
// match by team names + commence_time.
// Full list: https://api.the-odds-api.com/v4/sports?apiKey=...
const SOCCER_SPORT_KEYS = [
  "soccer_epl",
  "soccer_efl_champ",
  "soccer_england_league1",
  "soccer_england_league2",
  "soccer_spain_la_liga",
  "soccer_spain_segunda_division",
  "soccer_germany_bundesliga",
  "soccer_germany_bundesliga2",
  "soccer_italy_serie_a",
  "soccer_italy_serie_b",
  "soccer_france_ligue_one",
  "soccer_france_ligue_two",
  "soccer_netherlands_eredivisie",
  "soccer_portugal_primeira_liga",
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league",
  "soccer_uefa_european_championship",
  "soccer_fifa_world_cup",
];

interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}
interface OddsApiMarket {
  key: string;
  outcomes: OddsApiOutcome[];
}
interface OddsApiBookmaker {
  key: string;
  title: string;
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

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bfc\b|\bcf\b|\bafc\b|\bsc\b|\bac\b|\bsv\b|\bcd\b|\bif\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function teamsMatch(a: string, b: string) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // partial token overlap: at least 1 long token shared
  const ta = new Set(na.split(" ").filter((t) => t.length >= 4));
  const tb = new Set(nb.split(" ").filter((t) => t.length >= 4));
  for (const t of ta) if (tb.has(t)) return true;
  return na.includes(nb) || nb.includes(na);
}

/** Pick best (median) price for an outcome across bookmakers. */
function pickBestPrice(
  bookmakers: OddsApiBookmaker[],
  marketKey: string,
  outcomeName: string,
  point?: number,
): { price: number; book: string } | null {
  const candidates: { price: number; book: string }[] = [];
  for (const b of bookmakers) {
    const m = b.markets.find((mm) => mm.key === marketKey);
    if (!m) continue;
    const o = m.outcomes.find(
      (oc) =>
        oc.name.toLowerCase() === outcomeName.toLowerCase() &&
        (point === undefined || oc.point === point),
    );
    if (o && typeof o.price === "number" && o.price > 1)
      candidates.push({ price: o.price, book: b.title });
  }
  if (candidates.length === 0) return null;
  // best (highest) price for the punter
  candidates.sort((a, b) => b.price - a.price);
  return candidates[0];
}

export const fetchOddsForMatch = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      userId: string;
      matchId: number;
      homeTeam: string;
      awayTeam: string;
      utcDate: string;
    }) => input,
  )
  .handler(async ({ data }) => {
    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) {
      return { ok: false as const, error: "ODDS_API_KEY is not configured", inserted: 0 };
    }

    const targetTime = new Date(data.utcDate).getTime();
    const markets = "h2h,totals,btts";

    let matchedEvent: OddsApiEvent | null = null;
    let lastError: string | null = null;

    for (const sportKey of SOCCER_SPORT_KEYS) {
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&regions=eu,uk&markets=${markets}&oddsFormat=decimal&dateFormat=iso`;
      const res = await fetch(url);
      if (!res.ok) {
        // 404 = sport not in plan; 422 = invalid market for sport. Continue searching.
        if (res.status === 401) {
          return { ok: false as const, error: "Invalid ODDS_API_KEY", inserted: 0 };
        }
        if (res.status === 429) {
          return { ok: false as const, error: "Odds API quota exceeded", inserted: 0 };
        }
        lastError = `${sportKey}: ${res.status}`;
        continue;
      }
      const events = (await res.json()) as OddsApiEvent[];
      for (const ev of events) {
        const evTime = new Date(ev.commence_time).getTime();
        // within 6 hours of target kick-off and team names match
        if (Math.abs(evTime - targetTime) > 6 * 60 * 60 * 1000) continue;
        if (!teamsMatch(ev.home_team, data.homeTeam)) continue;
        if (!teamsMatch(ev.away_team, data.awayTeam)) continue;
        matchedEvent = ev;
        break;
      }
      if (matchedEvent) break;
    }

    if (!matchedEvent) {
      return {
        ok: false as const,
        error: `No odds found for ${data.homeTeam} vs ${data.awayTeam}${
          lastError ? ` (last: ${lastError})` : ""
        }`,
        inserted: 0,
      };
    }

    const supabase = adminClient();
    const upserts: {
      market: string;
      selection: string;
      decimal_odds: number;
      bookmaker: string;
      line: number | null;
    }[] = [];

    // 1X2
    const home1 = pickBestPrice(matchedEvent.bookmakers, "h2h", matchedEvent.home_team);
    const draw1 = pickBestPrice(matchedEvent.bookmakers, "h2h", "Draw");
    const away1 = pickBestPrice(matchedEvent.bookmakers, "h2h", matchedEvent.away_team);
    if (home1) upserts.push({ market: "1x2", selection: "Home", decimal_odds: home1.price, bookmaker: home1.book, line: null });
    if (draw1) upserts.push({ market: "1x2", selection: "Draw", decimal_odds: draw1.price, bookmaker: draw1.book, line: null });
    if (away1) upserts.push({ market: "1x2", selection: "Away", decimal_odds: away1.price, bookmaker: away1.book, line: null });

    // Over/Under 2.5
    const o25 = pickBestPrice(matchedEvent.bookmakers, "totals", "Over", 2.5);
    const u25 = pickBestPrice(matchedEvent.bookmakers, "totals", "Under", 2.5);
    if (o25) upserts.push({ market: "ou_25", selection: "Over 2.5", decimal_odds: o25.price, bookmaker: o25.book, line: 2.5 });
    if (u25) upserts.push({ market: "ou_25", selection: "Under 2.5", decimal_odds: u25.price, bookmaker: u25.book, line: 2.5 });

    // Over/Under 1.5
    const o15 = pickBestPrice(matchedEvent.bookmakers, "totals", "Over", 1.5);
    const u15 = pickBestPrice(matchedEvent.bookmakers, "totals", "Under", 1.5);
    if (o15) upserts.push({ market: "ou_15", selection: "Over 1.5", decimal_odds: o15.price, bookmaker: o15.book, line: 1.5 });
    if (u15) upserts.push({ market: "ou_15", selection: "Under 1.5", decimal_odds: u15.price, bookmaker: u15.book, line: 1.5 });

    // BTTS
    const bttsYes = pickBestPrice(matchedEvent.bookmakers, "btts", "Yes");
    const bttsNo = pickBestPrice(matchedEvent.bookmakers, "btts", "No");
    if (bttsYes) upserts.push({ market: "btts", selection: "Yes", decimal_odds: bttsYes.price, bookmaker: bttsYes.book, line: null });
    if (bttsNo) upserts.push({ market: "btts", selection: "No", decimal_odds: bttsNo.price, bookmaker: bttsNo.book, line: null });

    if (upserts.length === 0) {
      return { ok: false as const, error: "Matched event but no usable prices", inserted: 0 };
    }

    const rows = upserts.map((u) => ({
      user_id: data.userId,
      match_id: data.matchId,
      market: u.market,
      selection: u.selection,
      decimal_odds: u.decimal_odds,
      bookmaker: u.bookmaker,
      line: u.line,
    }));

    const { error } = await supabase
      .from("match_odds")
      .upsert(rows, { onConflict: "user_id,match_id,market,selection" });
    if (error) return { ok: false as const, error: error.message, inserted: 0 };

    return { ok: true as const, inserted: rows.length, source: matchedEvent.sport_key };
  });