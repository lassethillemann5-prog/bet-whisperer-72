import { createServerFn } from "@tanstack/react-start";
import { fetchMatch, fetchTeamForm, fetchUpcomingMatches } from "./footballData.server";
import { predictMarkets } from "@/lib/football/predictor";
import { generateCommentary } from "./aiCommentary.server";
import type { MatchPredictions, MatchSummary } from "@/lib/football/types";
import { createClient } from "@supabase/supabase-js";

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h

export const getFixtures = createServerFn({ method: "GET" })
  .inputValidator((input: { days?: number; competition?: string } | undefined) => input ?? {})
  .handler(async ({ data }) => {
    try {
      const matches = await fetchUpcomingMatches(data.days ?? 7);
      const filtered = data.competition
        ? matches.filter((m) => m.competition?.code === data.competition)
        : matches;
      // Sort by kickoff
      filtered.sort(
        (a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime(),
      );
      return { matches: filtered, error: null as string | null };
    } catch (e) {
      console.error("getFixtures failed", e);
      const msg = e instanceof Error ? e.message : "Failed to load fixtures";
      return { matches: [] as MatchSummary[], error: msg };
    }
  });

export const getMatchWithPredictions = createServerFn({ method: "POST" })
  .inputValidator((input: { matchId: number }) => input)
  .handler(async ({ data }) => {
    const supabase = adminClient();
    const matchId = Number(data.matchId);

    // Try cache first
    try {
      const { data: cached } = await supabase
        .from("predictions_cache")
        .select("payload, updated_at")
        .eq("match_id", matchId)
        .maybeSingle();
      if (
        cached?.payload &&
        cached.updated_at &&
        Date.now() - new Date(cached.updated_at).getTime() < CACHE_TTL_MS
      ) {
        return cached.payload as unknown as { match: MatchSummary; predictions: MatchPredictions };
      }
    } catch (e) {
      console.warn("cache read failed", e);
    }

    // Fresh fetch
    const match = await fetchMatch(matchId);
    const [homeForm, awayForm] = await Promise.all([
      fetchTeamForm(match.homeTeam.id),
      fetchTeamForm(match.awayTeam.id),
    ]);
    const { markets, expectedGoalsHome, expectedGoalsAway } = predictMarkets(
      homeForm,
      awayForm,
    );
    const partial = {
      homeForm,
      awayForm,
      expectedGoalsHome,
      expectedGoalsAway,
      markets,
    };
    const commentary = await generateCommentary(match, partial);
    const predictions: MatchPredictions = {
      matchId,
      generatedAt: new Date().toISOString(),
      ...partial,
      commentary,
    };
    const payload = { match, predictions };

    // Cache (shared, best-effort)
    try {
      await supabase.from("predictions_cache").upsert({
        match_id: matchId,
        payload: payload as unknown,
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("cache write skipped", e);
    }

    return payload;
  });