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

/** Build the upsert rows from a matched event. */
function rowsFromEvent(
  ev: OddsApiEvent,
  userId: string,
  matchId: number,
) {
  const upserts: {
    user_id: string;
    match_id: number;
    market: string;
    selection: string;
    decimal_odds: number;
    bookmaker: string;
    line: number | null;
  }[] = [];
  const push = (
    market: string,
    selection: string,
    p: { price: number; book: string } | null,
    line: number | null,
  ) => {
    if (!p) return;
    upserts.push({
      user_id: userId,
      match_id: matchId,
      market,
      selection,
      decimal_odds: p.price,
      bookmaker: p.book,
      line,
    });
  };

  push("1x2", "1", pickBestPrice(ev.bookmakers, "h2h", ev.home_team), null);
  push("1x2", "X", pickBestPrice(ev.bookmakers, "h2h", "Draw"), null);
  push("1x2", "2", pickBestPrice(ev.bookmakers, "h2h", ev.away_team), null);
  push("ou_25", "Over", pickBestPrice(ev.bookmakers, "totals", "Over", 2.5), 2.5);
  push("ou_25", "Under", pickBestPrice(ev.bookmakers, "totals", "Under", 2.5), 2.5);
  push("ou_15", "Over", pickBestPrice(ev.bookmakers, "totals", "Over", 1.5), 1.5);
  push("ou_15", "Under", pickBestPrice(ev.bookmakers, "totals", "Under", 1.5), 1.5);
  push("btts", "Yes", pickBestPrice(ev.bookmakers, "btts", "Yes"), null);
  push("btts", "No", pickBestPrice(ev.bookmakers, "btts", "No"), null);

  return upserts;
}

/** Fetch odds events for all soccer sport_keys once. Returns flat list. */
async function fetchAllSoccerEvents(
  apiKey: string,
): Promise<{ events: OddsApiEvent[]; fatal: string | null }> {
  const all: OddsApiEvent[] = [];
  for (const sportKey of SOCCER_SPORT_KEYS) {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&regions=eu,uk&markets=h2h,totals,btts&oddsFormat=decimal&dateFormat=iso`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 401) return { events: all, fatal: "Invalid ODDS_API_KEY" };
      if (res.status === 429) return { events: all, fatal: "Odds API quota exceeded" };
      continue;
    }
    const events = (await res.json()) as OddsApiEvent[];
    all.push(...events);
  }
  return { events: all, fatal: null };
}

function findEventFor(
  events: OddsApiEvent[],
  homeTeam: string,
  awayTeam: string,
  utcDate: string,
): OddsApiEvent | null {
  const targetTime = new Date(utcDate).getTime();
  for (const ev of events) {
    const evTime = new Date(ev.commence_time).getTime();
    if (Math.abs(evTime - targetTime) > 6 * 60 * 60 * 1000) continue;
    if (!teamsMatch(ev.home_team, homeTeam)) continue;
    if (!teamsMatch(ev.away_team, awayTeam)) continue;
    return ev;
  }
  return null;
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
    const { events, fatal } = await fetchAllSoccerEvents(apiKey);
    if (fatal) return { ok: false as const, error: fatal, inserted: 0 };
    const matchedEvent = findEventFor(events, data.homeTeam, data.awayTeam, data.utcDate);
    if (!matchedEvent) {
      return {
        ok: false as const,
        error: `No odds found for ${data.homeTeam} vs ${data.awayTeam}`,
        inserted: 0,
      };
    }
    const supabase = adminClient();
    const rows = rowsFromEvent(matchedEvent, data.userId, data.matchId);
    if (rows.length === 0) {
      return { ok: false as const, error: "Matched event but no usable prices", inserted: 0 };
    }
    const { error } = await supabase
      .from("match_odds")
      .upsert(rows, { onConflict: "user_id,match_id,market,selection" });
    if (error) return { ok: false as const, error: error.message, inserted: 0 };
    return { ok: true as const, inserted: rows.length, source: matchedEvent.sport_key };
  });

export const fetchOddsForAllTracked = createServerFn({ method: "POST" })
  .inputValidator((input: { userId: string }) => input)
  .handler(async ({ data }) => {
    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) {
      return { ok: false as const, error: "ODDS_API_KEY is not configured", matched: 0, total: 0 };
    }
    const supabase = adminClient();
    const { data: tracked, error } = await supabase
      .from("tracked_matches")
      .select("match_id, home_team, away_team, utc_date")
      .eq("user_id", data.userId);
    if (error) return { ok: false as const, error: error.message, matched: 0, total: 0 };
    const rows = tracked ?? [];
    if (rows.length === 0)
      return { ok: true as const, matched: 0, total: 0, inserted: 0 };

    // Fetch odds across all soccer sport keys ONCE, then match locally
    const { events, fatal } = await fetchAllSoccerEvents(apiKey);
    if (fatal) return { ok: false as const, error: fatal, matched: 0, total: rows.length };

    let matched = 0;
    let inserted = 0;
    const errors: string[] = [];
    const allRows: ReturnType<typeof rowsFromEvent> = [];

    for (const r of rows) {
      const ev = findEventFor(
        events,
        r.home_team as string,
        r.away_team as string,
        r.utc_date as string,
      );
      if (!ev) {
        errors.push(`${r.home_team} vs ${r.away_team}: not found`);
        continue;
      }
      const evRows = rowsFromEvent(ev, data.userId, r.match_id as number);
      if (evRows.length > 0) {
        matched++;
        inserted += evRows.length;
        allRows.push(...evRows);
      }
    }

    if (allRows.length > 0) {
      const { error: upErr } = await supabase
        .from("match_odds")
        .upsert(allRows, { onConflict: "user_id,match_id,market,selection" });
      if (upErr)
        return { ok: false as const, error: upErr.message, matched, total: rows.length, inserted };
    }

    return {
      ok: true as const,
      matched,
      total: rows.length,
      inserted,
      errors: errors.slice(0, 5),
    };
  });