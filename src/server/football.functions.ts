import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { fetchMatch, fetchTeamForm, fetchUpcomingMatches } from "./footballData.server";
import { predictMarkets } from "@/lib/football/predictor";
import { generateCommentary } from "./aiCommentary.server";
import type { MatchPredictions, MatchSummary } from "@/lib/football/types";

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
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { matchId: number }) => input)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
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
        return cached.payload as { match: MatchSummary; predictions: MatchPredictions };
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

    // Cache (best effort — needs service role for writes; ignore failure)
    try {
      await supabase
        .from("predictions_cache")
        .upsert({ match_id: matchId, payload, updated_at: new Date().toISOString() });
    } catch (e) {
      console.warn("cache write skipped", e);
    }

    return payload;
  });

export const trackMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      matchId: number;
      competition: string | null;
      homeTeam: string;
      awayTeam: string;
      utcDate: string;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("tracked_matches").upsert(
      {
        user_id: userId,
        match_id: data.matchId,
        competition: data.competition,
        home_team: data.homeTeam,
        away_team: data.awayTeam,
        utc_date: data.utcDate,
      },
      { onConflict: "user_id,match_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const untrackMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { matchId: number }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("tracked_matches")
      .delete()
      .eq("user_id", userId)
      .eq("match_id", data.matchId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getTrackedMatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("tracked_matches")
      .select("*")
      .eq("user_id", userId)
      .order("utc_date", { ascending: true });
    if (error) throw new Error(error.message);
    return { tracked: data ?? [] };
  });
