import type { MatchSummary, TeamForm } from "@/lib/football/types";

// Provider: API-SPORTS Football v3 (https://www.api-football.com/documentation-v3)
// Header: x-apisports-key — Pro keys are sent the same way as free keys.
const BASE = "https://v3.football.api-sports.io";

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

/** Fetch upcoming matches (default: today through next 7 days). */
export async function fetchUpcomingMatches(daysAhead = 7): Promise<MatchSummary[]> {
  // API-SPORTS requires `season` when using from/to. Fetching by `date` works
  // without it, so we iterate one day at a time (cheap: tiny payloads, runs in
  // parallel) and concat the results.
  const today = new Date();
  const dates: string[] = [];
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const results = await Promise.all(
    dates.map(async (date) => {
      try {
        const data = await fdFetch<{ response: ApiSportsFixture[] }>(
          `/fixtures?date=${date}`,
        );
        return data.response ?? [];
      } catch (e) {
        console.error("fixtures day failed", date, e);
        return [] as ApiSportsFixture[];
      }
    }),
  );

  // Flatten + de-duplicate by fixture id (defensive)
  const seen = new Set<number>();
  const merged: ApiSportsFixture[] = [];
  for (const day of results) {
    for (const f of day) {
      if (!seen.has(f.fixture.id)) {
        seen.add(f.fixture.id);
        merged.push(f);
      }
    }
  }
  return merged.map(toMatchSummary);
}

export async function fetchMatch(id: number): Promise<MatchSummary> {
  const data = await fdFetch<{ response: ApiSportsFixture[] }>(`/fixtures?id=${id}`);
  const match = data.response?.[0];
  if (!match) throw new Error("Match not found in API-SPORTS Football");
  return toMatchSummary(match);
}

/** Fetch recent finished matches for a team and compute simple form. */
export async function fetchTeamForm(teamId: number, limit = 8): Promise<TeamForm | null> {
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
    }
    return {
      played,
      wins,
      draws,
      losses,
      goalsFor,
      goalsAgainst,
      last5: last5.slice(-5),
    };
  } catch (e) {
    console.error("fetchTeamForm failed", teamId, e);
    return null;
  }
}
