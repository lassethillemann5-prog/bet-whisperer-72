import type { MatchSummary, TeamForm } from "@/lib/football/types";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Provider: API-SPORTS Football v3 (https://www.api-football.com/documentation-v3)
// Header: x-apisports-key — Pro keys are sent the same way as free keys.
const BASE = "https://v3.football.api-sports.io";

// Cache TTLs (kept short enough to stay fresh, long enough to slash API usage)
const FIXTURES_TTL_MS = 1000 * 60 * 30; // 30 minutes per date
const TEAM_FORM_TTL_MS = 1000 * 60 * 60 * 24; // 24h per team

function cacheClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function getKey(): string {
  // Stored under FOOTBALL_DATA_API_KEY for legacy reasons; value is the
  // API-SPORTS key from https://dashboard.api-football.com/.
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error("FOOTBALL_DATA_API_KEY is not configured");
  return key;
}

interface ApiSportsFixture {
  fixture: {
    id: number;
    date: string;
    status: { short: string; long: string };
  };
  league: { name: string; logo?: string | null; id?: number; country?: string };
  teams: {
    home: { id: number; name: string; logo?: string | null };
    away: { id: number; name: string; logo?: string | null };
  };
  goals: { home: number | null; away: number | null };
  score: {
    halftime?: { home: number | null; away: number | null };
    fulltime?: { home: number | null; away: number | null };
  };
}

function toMatchSummary(item: ApiSportsFixture): MatchSummary {
  return {
    id: item.fixture.id,
    utcDate: item.fixture.date,
    status: item.fixture.status.short,
    competition: {
      name: item.league.name,
      emblem: item.league.logo ?? null,
      code: item.league.id ? String(item.league.id) : item.league.country,
    },
    homeTeam: {
      id: item.teams.home.id,
      name: item.teams.home.name,
      shortName: item.teams.home.name,
      crest: item.teams.home.logo ?? null,
    },
    awayTeam: {
      id: item.teams.away.id,
      name: item.teams.away.name,
      shortName: item.teams.away.name,
      crest: item.teams.away.logo ?? null,
    },
    score: {
      fullTime: {
        home: item.score.fulltime?.home ?? item.goals.home,
        away: item.score.fulltime?.away ?? item.goals.away,
      },
      halfTime: item.score.halftime,
    },
  };
}

async function fdFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": getKey() },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API-SPORTS Football ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as T & { errors?: unknown };
  const errors = json.errors;
  if (errors && ((Array.isArray(errors) && errors.length > 0) || Object.keys(errors as object).length > 0)) {
    throw new Error(`API-SPORTS Football error: ${JSON.stringify(errors).slice(0, 200)}`);
  }
  return json;
}

/** Read a cached payload if it's still within TTL. Best-effort, never throws. */
async function readCache<T>(table: string, keyCol: string, keyVal: string | number, ttlMs: number): Promise<T | null> {
  const sb = cacheClient();
  if (!sb) return null;
  try {
    const { data } = await sb
      .from(table)
      .select("payload, updated_at")
      .eq(keyCol, keyVal)
      .maybeSingle();
    if (!data?.payload || !data.updated_at) return null;
    if (Date.now() - new Date(data.updated_at).getTime() > ttlMs) return null;
    return data.payload as T;
  } catch (e) {
    console.warn(`cache read failed (${table})`, e);
    return null;
  }
}

async function writeCache(table: string, row: Record<string, unknown>): Promise<void> {
  const sb = cacheClient();
  if (!sb) return;
  try {
    await sb.from(table).upsert({ ...row, updated_at: new Date().toISOString() });
  } catch (e) {
    console.warn(`cache write failed (${table})`, e);
  }
}

async function fetchFixturesForDate(date: string): Promise<MatchSummary[]> {
  const cached = await readCache<MatchSummary[]>("fixtures_cache", "cache_key", `date:${date}`, FIXTURES_TTL_MS);
  if (cached) return cached;

  try {
    const data = await fdFetch<{ response: ApiSportsFixture[] }>(`/fixtures?date=${date}`);
    const matches = (data.response ?? []).map(toMatchSummary);
    await writeCache("fixtures_cache", { cache_key: `date:${date}`, payload: matches as unknown });
    return matches;
  } catch (e) {
    console.error("fixtures day failed", date, e);
    return [];
  }
}

/** Fetch upcoming matches (default: today through next 7 days). */
export async function fetchUpcomingMatches(daysAhead = 7): Promise<MatchSummary[]> {
  // We fetch one day at a time (each call is small and cacheable per-date).
  // With the 30-min fixtures cache, a typical day uses ~daysAhead requests
  // total per cache window, regardless of how many users hit the page.
  const today = new Date();
  const dates: string[] = [];
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const results = await Promise.all(dates.map(fetchFixturesForDate));

  // Flatten + de-duplicate by fixture id (defensive)
  const seen = new Set<number>();
  const merged: MatchSummary[] = [];
  for (const day of results) {
    for (const f of day) {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        merged.push(f);
      }
    }
  }
  return merged;
}

export async function fetchMatch(id: number): Promise<MatchSummary> {
  const data = await fdFetch<{ response: ApiSportsFixture[] }>(`/fixtures?id=${id}`);
  const match = data.response?.[0];
  if (!match) throw new Error("Match not found in API-SPORTS Football");
  return toMatchSummary(match);
}

/** Fetch recent finished matches for a team (raw fixtures, most recent first). */
export async function fetchRecentMatches(teamId: number, limit = 5): Promise<MatchSummary[]> {
  try {
    const data = await fdFetch<{ response: ApiSportsFixture[] }>(
      `/fixtures?team=${teamId}&last=${limit}&status=FT`,
    );
    return (data.response ?? []).map(toMatchSummary).reverse();
  } catch (e) {
    console.error("fetchRecentMatches failed", teamId, e);
    return [];
  }
}

/** Head-to-head finished fixtures between two teams (most recent first). */
export async function fetchHeadToHead(
  homeId: number,
  awayId: number,
  limit = 5,
): Promise<MatchSummary[]> {
  try {
    const data = await fdFetch<{ response: ApiSportsFixture[] }>(
      `/fixtures/headtohead?h2h=${homeId}-${awayId}&last=${limit}&status=FT`,
    );
    return (data.response ?? []).map(toMatchSummary).reverse();
  } catch (e) {
    console.error("fetchHeadToHead failed", homeId, awayId, e);
    return [];
  }
}

/** Fetch recent finished matches for a team and compute simple form. */
export async function fetchTeamForm(teamId: number, limit = 8): Promise<TeamForm | null> {
  // Cache key ignores `limit` because callers always use the default; if a
  // caller passes a different limit, we still cache by team id and accept the
  // approximation in exchange for far fewer API hits.
  const cached = await readCache<TeamForm>("team_form_cache", "team_id", teamId, TEAM_FORM_TTL_MS);
  if (cached) return cached;

  try {
    const data = await fdFetch<{ response: ApiSportsFixture[] }>(
      `/fixtures?team=${teamId}&last=${limit}&status=FT`,
    );
    const matches = (data.response ?? []).map(toMatchSummary).slice(-limit);
    let played = 0,
      wins = 0,
      draws = 0,
      losses = 0,
      goalsFor = 0,
      goalsAgainst = 0;
    const last5: ("W" | "D" | "L")[] = [];
    // Time-decay weighting: matches lose half their weight every 90 days.
    const HALF_LIFE_DAYS = 90;
    const decayLambda = Math.LN2 / HALF_LIFE_DAYS;
    const nowMs = Date.now();
    let wAttack = 0,
      wDefense = 0,
      wSum = 0;
    for (const m of matches) {
      const isHome = m.homeTeam.id === teamId;
      const ft = m.score.fullTime;
      if (ft.home == null || ft.away == null) continue;
      played++;
      const gf = isHome ? ft.home : ft.away;
      const ga = isHome ? ft.away : ft.home;
      goalsFor += gf;
      goalsAgainst += ga;
      let r: "W" | "D" | "L";
      if (gf > ga) { wins++; r = "W"; }
      else if (gf < ga) { losses++; r = "L"; }
      else { draws++; r = "D"; }
      last5.push(r);
      const ageDays = Math.max(
        0,
        (nowMs - new Date(m.utcDate).getTime()) / (1000 * 60 * 60 * 24),
      );
      const w = Math.exp(-decayLambda * ageDays);
      wAttack += gf * w;
      wDefense += ga * w;
      wSum += w;
    }
    const form: TeamForm = {
      played,
      wins,
      draws,
      losses,
      goalsFor,
      goalsAgainst,
      last5: last5.slice(-5),
      weightedAttackPerGame: wSum > 0 ? +(wAttack / wSum).toFixed(3) : undefined,
      weightedDefensePerGame: wSum > 0 ? +(wDefense / wSum).toFixed(3) : undefined,
      effectiveSample: wSum > 0 ? +wSum.toFixed(2) : undefined,
    };
    await writeCache("team_form_cache", { team_id: teamId, payload: form as unknown });
    return form;
  } catch (e) {
    console.error("fetchTeamForm failed", teamId, e);
    return null;
  }
}
