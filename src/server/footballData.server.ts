import type { MatchSummary, TeamForm } from "@/lib/football/types";

const BASE = "https://api.football-data.org/v4";

function getKey(): string {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error("FOOTBALL_DATA_API_KEY is not configured");
  return key;
}

async function fdFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "X-Auth-Token": getKey() },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Football-Data ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch upcoming + recent matches (default: today through next 7 days). */
export async function fetchUpcomingMatches(daysAhead = 7): Promise<MatchSummary[]> {
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() + daysAhead);
  const dateFrom = today.toISOString().slice(0, 10);
  const dateTo = end.toISOString().slice(0, 10);

  const data = await fdFetch<{ matches: MatchSummary[] }>(
    `/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
  );
  return data.matches ?? [];
}

export async function fetchMatch(id: number): Promise<MatchSummary> {
  const data = await fdFetch<{ match?: MatchSummary } | MatchSummary>(
    `/matches/${id}`,
  );
  // v4 returns an envelope { match } in some places; tolerate both
  const m = (data as { match?: MatchSummary }).match ?? (data as MatchSummary);
  return m;
}

/** Fetch recent finished matches for a team and compute simple form. */
export async function fetchTeamForm(teamId: number, limit = 8): Promise<TeamForm | null> {
  try {
    const data = await fdFetch<{ matches: MatchSummary[] }>(
      `/teams/${teamId}/matches?status=FINISHED&limit=${limit}`,
    );
    const matches = (data.matches ?? []).slice(-limit);
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
