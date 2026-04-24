import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

// We dynamically discover all in-season soccer sport keys from the API
// so we don't miss leagues. Cached briefly per request batch.
async function listActiveSoccerSports(apiKey: string): Promise<string[]> {
  const url = `https://api.the-odds-api.com/v4/sports?apiKey=${apiKey}&all=false`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const sports = (await res.json()) as { key: string; group: string; active: boolean }[];
  return sports.filter((s) => s.group === "Soccer" && s.active).map((s) => s.key);
}

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
    .replace(
      /\b(fc|cf|afc|sc|ac|sv|cd|if|bk|bif|aif|sk|fk|nk|hc|cfc|ssc|fsv|tsv|vfb|vfl|tsg|rb|rsc|psv|psg|os|cska|spvgg|gks|ks|os|asd)\b/g,
      "",
    )
    .replace(/\b(united|utd|city|town|rovers|wanderers|athletic|atletico|real|club|de|del|la|el|los|las|the|and)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function teamsMatch(a: string, b: string) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // substring containment (after stripping noise)
  if (na.includes(nb) || nb.includes(na)) return true;
  // token overlap: at least one shared token of length >= 3
  const ta = new Set(na.split(" ").filter((t) => t.length >= 3));
  const tb = new Set(nb.split(" ").filter((t) => t.length >= 3));
  for (const t of ta) if (tb.has(t)) return true;
  return false;
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
): Promise<{ events: OddsApiEvent[]; fatal: string | null; sportsTried: number; sportsOk: number }> {
  const sportKeys = await listActiveSoccerSports(apiKey);
  if (sportKeys.length === 0) {
    return { events: [], fatal: "No active soccer sports returned by Odds API", sportsTried: 0, sportsOk: 0 };
  }
  const all: OddsApiEvent[] = [];
  let ok = 0;
  for (const sportKey of sportKeys) {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&regions=eu,uk&markets=h2h,totals,btts&oddsFormat=decimal&dateFormat=iso`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 401) return { events: all, fatal: "Invalid ODDS_API_KEY", sportsTried: sportKeys.length, sportsOk: ok };
      if (res.status === 429) return { events: all, fatal: "Odds API quota exceeded", sportsTried: sportKeys.length, sportsOk: ok };
      console.warn(`[odds] ${sportKey} returned ${res.status}`);
      continue;
    }
    const events = (await res.json()) as OddsApiEvent[];
    ok++;
    all.push(...events);
  }
  console.log(`[odds] fetched ${all.length} events across ${ok}/${sportKeys.length} soccer sports`);
  return { events: all, fatal: null, sportsTried: sportKeys.length, sportsOk: ok };
}

function findEventFor(
  events: OddsApiEvent[],
  homeTeam: string,
  awayTeam: string,
  utcDate: string,
): { event: OddsApiEvent | null; closeTime: number; nameMatchOnly: number } {
  const targetTime = new Date(utcDate).getTime();
  let closeTime = 0;
  let nameMatchOnly = 0;
  let best: OddsApiEvent | null = null;
  for (const ev of events) {
    const evTime = new Date(ev.commence_time).getTime();
    const timeOk = Math.abs(evTime - targetTime) <= 12 * 60 * 60 * 1000;
    if (timeOk) closeTime++;
    const homeOk = teamsMatch(ev.home_team, homeTeam);
    const awayOk = teamsMatch(ev.away_team, awayTeam);
    if (homeOk && awayOk) {
      if (!timeOk) {
        nameMatchOnly++;
        continue;
      }
      best = ev;
      break;
    }
  }
  return { event: best, closeTime, nameMatchOnly };
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
    const { events, fatal, sportsOk, sportsTried } = await fetchAllSoccerEvents(apiKey);
    if (fatal) return { ok: false as const, error: fatal, inserted: 0 };
    const found = findEventFor(events, data.homeTeam, data.awayTeam, data.utcDate);
    if (!found.event) {
      console.log(
        `[odds] no match for "${data.homeTeam}" vs "${data.awayTeam}" — events=${events.length}, sports=${sportsOk}/${sportsTried}, closeTime=${found.closeTime}, nameOnly=${found.nameMatchOnly}`,
      );
      return {
        ok: false as const,
        error:
          found.nameMatchOnly > 0
            ? `Found ${data.homeTeam} vs ${data.awayTeam} but kickoff time differs — match may not be in the odds window`
            : `No odds for ${data.homeTeam} vs ${data.awayTeam} (searched ${events.length} events across ${sportsOk}/${sportsTried} leagues — league may not be on your Odds API plan)`,
        inserted: 0,
      };
    }
    const matchedEvent = found.event;
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
      const found = findEventFor(
        events,
        r.home_team as string,
        r.away_team as string,
        r.utc_date as string,
      );
      const ev = found.event;
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