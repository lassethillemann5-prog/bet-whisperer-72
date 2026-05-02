import { createServerFn } from "@tanstack/react-start";
import {
  fetchHeadToHead,
  fetchMatch,
  fetchRecentMatches,
  fetchTeamForm,
  fetchTeamFormLite,
  fetchTeamInjuries,
  fetchUpcomingMatches,
  fetchFinishedFixtures,
} from "./footballData.server";
import { fetchLiveScores, type LiveScore } from "./footballData.server";
import { predictMarkets } from "@/lib/football/predictor";
import {
  buildScorelineMatrix,
  jointProbability,
  conflictingLegs,
  BUILDER_LEGS,
  type BuilderLegId,
} from "@/lib/football/predictor";
import { generateCommentary } from "./aiCommentary.server";
import { generateAiBetBuilder, type RiskLevel } from "./aiBetBuilder.server";
import type { MatchPredictions, MatchSummary } from "@/lib/football/types";
import { createClient } from "@supabase/supabase-js";

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h

type PredictionCachePayload = { match: MatchSummary; predictions: MatchPredictions };
type PredictionCacheEntry = { payload: PredictionCachePayload; fresh: boolean };

function hasUsableBulkPrediction(payload: PredictionCachePayload): boolean {
  const p = payload.predictions;
  if (p.homeForm == null || p.awayForm == null) return false;
  const requiredMarkets = ["cards", "double_chance", "dnb", "ah"];
  return requiredMarkets.every((k) => p.markets.some((m) => m.market === k));
}

async function computeAndCacheLitePrediction(
  supabase: ReturnType<typeof adminClient>,
  fixture: MatchSummary,
): Promise<PredictionCachePayload | null> {
  const [homeForm, awayForm] = await Promise.all([
    fetchTeamFormLite(fixture.homeTeam.id),
    fetchTeamFormLite(fixture.awayTeam.id),
  ]);
  const { markets, expectedGoalsHome, expectedGoalsAway } = predictMarkets(homeForm, awayForm);
  const predictions: MatchPredictions = {
    matchId: fixture.id,
    generatedAt: new Date().toISOString(),
    homeForm,
    awayForm,
    expectedGoalsHome,
    expectedGoalsAway,
    markets,
    commentary: "",
  };
  const payload = { match: fixture, predictions };
  try {
    await supabase.from("predictions_cache").upsert({
      match_id: fixture.id,
      payload: payload as unknown,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("bulk prediction cache write skipped", e);
  }
  return payload;
}

async function computeLiteBatch(
  supabase: ReturnType<typeof adminClient>,
  fixtures: MatchSummary[],
  cacheMap: Map<number, PredictionCacheEntry>,
): Promise<number> {
  let computedCount = 0;
  for (const fixture of fixtures) {
    try {
      const payload = await computeAndCacheLitePrediction(supabase, fixture);
      if (!payload) continue;
      cacheMap.set(fixture.id, { payload, fresh: true });
      computedCount++;
    } catch (e) {
      console.warn("bulk predict failed for", fixture.id, e);
    }
  }
  return computedCount;
}

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
        const payload = cached.payload as unknown as {
          match: MatchSummary;
          predictions: MatchPredictions;
        };
        // Bulk-compute paths (today's picks, coach panel, etc.) intentionally
        // skip the AI commentary call to save time/credits and persist
        // commentary: "". When a user opens the match detail page we want a
        // real analyst blurb — generate it now, update the cache, and return.
        // Also: older cached rows may have homeForm/awayForm = null (the
        // initial fetch came back empty). Try once more on detail-page open
        // — APIs that were rate-limited or temporarily empty often succeed
        // on retry, especially after our cache TTL window.
        let formBackfilled = false;
        if (payload.predictions.homeForm == null || payload.predictions.awayForm == null) {
          try {
            const [hf, af] = await Promise.all([
              payload.predictions.homeForm == null
                ? fetchTeamForm(payload.match.homeTeam.id)
                : Promise.resolve(payload.predictions.homeForm),
              payload.predictions.awayForm == null
                ? fetchTeamForm(payload.match.awayTeam.id)
                : Promise.resolve(payload.predictions.awayForm),
            ]);
            if (hf && payload.predictions.homeForm == null) {
              payload.predictions.homeForm = hf;
              formBackfilled = true;
            }
            if (af && payload.predictions.awayForm == null) {
              payload.predictions.awayForm = af;
              formBackfilled = true;
            }
            if (formBackfilled) {
              const { markets, expectedGoalsHome, expectedGoalsAway } = predictMarkets(
                payload.predictions.homeForm,
                payload.predictions.awayForm,
                payload.predictions.homeInjuries ?? null,
                payload.predictions.awayInjuries ?? null,
              );
              payload.predictions.markets = markets;
              payload.predictions.expectedGoalsHome = expectedGoalsHome;
              payload.predictions.expectedGoalsAway = expectedGoalsAway;
            }
          } catch (e) {
            console.warn("on-demand form backfill failed", e);
          }
        }
        // Backfill newly-added markets (e.g. home_to_score, away_to_score,
        // double_chance, dnb, ah) on older cached payloads. If form is
        // available but any expected market key is missing, recompute.
        const expectedMarketKeys = [
          "double_chance",
          "dnb",
          "ah",
          "home_to_score",
          "away_to_score",
          "cards",
        ];
        const havingForm =
          payload.predictions.homeForm != null && payload.predictions.awayForm != null;
        const missingMarkets = expectedMarketKeys.some(
          (k) => !payload.predictions.markets.some((m) => m.market === k),
        );
        let marketsBackfilled = false;
        if (havingForm && missingMarkets) {
          try {
            const { markets, expectedGoalsHome, expectedGoalsAway } = predictMarkets(
              payload.predictions.homeForm,
              payload.predictions.awayForm,
              payload.predictions.homeInjuries ?? null,
              payload.predictions.awayInjuries ?? null,
            );
            payload.predictions.markets = markets;
            payload.predictions.expectedGoalsHome = expectedGoalsHome;
            payload.predictions.expectedGoalsAway = expectedGoalsAway;
            marketsBackfilled = true;
          } catch (e) {
            console.warn("markets backfill failed", e);
          }
        }
        if (!payload.predictions.commentary?.trim()) {
          try {
            const commentary = await generateCommentary(payload.match, {
              homeForm: payload.predictions.homeForm,
              awayForm: payload.predictions.awayForm,
              expectedGoalsHome: payload.predictions.expectedGoalsHome,
              expectedGoalsAway: payload.predictions.expectedGoalsAway,
              markets: payload.predictions.markets,
            });
            payload.predictions.commentary = commentary;
            try {
              await supabase.from("predictions_cache").upsert({
                match_id: matchId,
                payload: payload as unknown,
                updated_at: new Date().toISOString(),
              });
            } catch (e) {
              console.warn("commentary cache update skipped", e);
            }
          } catch (e) {
            console.warn("on-demand commentary failed", e);
          }
        } else if (formBackfilled || marketsBackfilled) {
          // Form changed but commentary already exists — persist the new form.
          try {
            await supabase.from("predictions_cache").upsert({
              match_id: matchId,
              payload: payload as unknown,
              updated_at: new Date().toISOString(),
            });
          } catch (e) {
            console.warn("form backfill cache update skipped", e);
          }
        }
        return payload;
      }
    } catch (e) {
      console.warn("cache read failed", e);
    }

    // Fresh fetch
    const match = await fetchMatch(matchId);
    const [homeForm, awayForm, homeInjuries, awayInjuries] = await Promise.all([
      fetchTeamForm(match.homeTeam.id),
      fetchTeamForm(match.awayTeam.id),
      fetchTeamInjuries(match.homeTeam.id),
      fetchTeamInjuries(match.awayTeam.id),
    ]);
    const { markets, expectedGoalsHome, expectedGoalsAway } = predictMarkets(
      homeForm,
      awayForm,
      homeInjuries,
      awayInjuries,
    );
    const partial = {
      homeForm,
      awayForm,
      expectedGoalsHome,
      expectedGoalsAway,
      markets,
      homeInjuries,
      awayInjuries,
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

export interface TodayPickRow {
  match: MatchSummary;
  // Each market entry: selection -> probability (0-100)
  oneXTwo: { home: number; draw: number; away: number; pick: string } | null;
  ou25: { over: number; under: number; pick: string } | null;
  btts: { yes: number; no: number; pick: string } | null;
  // Extended markets — shown in a collapsed "More markets" row.
  doubleChance: { oneX: number; twelve: number; xTwo: number; pick: string } | null;
  dnb: { home: number; away: number; pick: string } | null;
  ah: { line: number; homeLabel: string; awayLabel: string; home: number; away: number; pick: string } | null;
  homeToScore: { yes: number; no: number; pick: string } | null;
  awayToScore: { yes: number; no: number; pick: string } | null;
  cards: { line: number; over: number; under: number; pick: string; expected: number } | null;
  best: { market: string; selection: string; label: string; probability: number } | null;
  cached: boolean;
  /** True when the prediction is just a league-average fallback (no real form data). */
  noData?: boolean;
}

function extractMarkets(predictions: MatchPredictions): {
  oneXTwo: TodayPickRow["oneXTwo"];
  ou25: TodayPickRow["ou25"];
  btts: TodayPickRow["btts"];
  doubleChance: TodayPickRow["doubleChance"];
  dnb: TodayPickRow["dnb"];
  ah: TodayPickRow["ah"];
  homeToScore: TodayPickRow["homeToScore"];
  awayToScore: TodayPickRow["awayToScore"];
  cards: TodayPickRow["cards"];
  best: TodayPickRow["best"];
} {
  const m1x2 = predictions.markets.find((m) => m.market === "1x2");
  const mou25 = predictions.markets.find((m) => m.market === "ou_25");
  const mbtts = predictions.markets.find((m) => m.market === "btts");
  const mdc = predictions.markets.find((m) => m.market === "double_chance");
  const mdnb = predictions.markets.find((m) => m.market === "dnb");
  const mah = predictions.markets.find((m) => m.market === "ah");
  const mhts = predictions.markets.find((m) => m.market === "home_to_score");
  const mats = predictions.markets.find((m) => m.market === "away_to_score");
  const mcards = predictions.markets.find((m) => m.market === "cards");

  const oneXTwo = m1x2
    ? {
        home: m1x2.probabilities["1"] ?? 0,
        draw: m1x2.probabilities["X"] ?? 0,
        away: m1x2.probabilities["2"] ?? 0,
        pick: m1x2.pick,
      }
    : null;
  const ou25 = mou25
    ? {
        over: mou25.probabilities["Over"] ?? 0,
        under: mou25.probabilities["Under"] ?? 0,
        pick: mou25.pick,
      }
    : null;
  const btts = mbtts
    ? {
        yes: mbtts.probabilities["Yes"] ?? 0,
        no: mbtts.probabilities["No"] ?? 0,
        pick: mbtts.pick,
      }
    : null;

  const doubleChance = mdc
    ? {
        oneX: mdc.probabilities["1X"] ?? 0,
        twelve: mdc.probabilities["12"] ?? 0,
        xTwo: mdc.probabilities["X2"] ?? 0,
        pick: mdc.pick,
      }
    : null;
  const dnb = mdnb
    ? {
        home: mdnb.probabilities["Home"] ?? 0,
        away: mdnb.probabilities["Away"] ?? 0,
        pick: mdnb.pick,
      }
    : null;
  let ah: TodayPickRow["ah"] = null;
  if (mah) {
    const entries = Object.entries(mah.probabilities);
    const homeEntry = entries.find(([k]) => k.startsWith("Home"));
    const awayEntry = entries.find(([k]) => k.startsWith("Away"));
    if (homeEntry && awayEntry) {
      ah = {
        line: typeof mah.line === "number" ? mah.line : 0,
        homeLabel: homeEntry[0],
        awayLabel: awayEntry[0],
        home: homeEntry[1] ?? 0,
        away: awayEntry[1] ?? 0,
        pick: mah.pick,
      };
    }
  }
  const homeToScore = mhts
    ? { yes: mhts.probabilities["Yes"] ?? 0, no: mhts.probabilities["No"] ?? 0, pick: mhts.pick }
    : null;
  const awayToScore = mats
    ? { yes: mats.probabilities["Yes"] ?? 0, no: mats.probabilities["No"] ?? 0, pick: mats.pick }
    : null;
  const cards = mcards
    ? {
        line: typeof mcards.line === "number" ? mcards.line : 3.5,
        over: mcards.probabilities["Over 3.5"] ?? 0,
        under: mcards.probabilities["Under 3.5"] ?? 0,
        pick: mcards.pick,
        expected: typeof mcards.expected === "number" ? mcards.expected : 0,
      }
    : null;

  // Best: highest single-selection probability across these 3 markets
  const candidates: { market: string; selection: string; label: string; probability: number }[] = [];
  if (oneXTwo) {
    candidates.push(
      { market: "1x2", selection: "1", label: "Home", probability: oneXTwo.home },
      { market: "1x2", selection: "X", label: "Draw", probability: oneXTwo.draw },
      { market: "1x2", selection: "2", label: "Away", probability: oneXTwo.away },
    );
  }
  if (ou25) {
    candidates.push(
      { market: "ou_25", selection: "Over", label: "Over 2.5", probability: ou25.over },
      { market: "ou_25", selection: "Under", label: "Under 2.5", probability: ou25.under },
    );
  }
  if (btts) {
    candidates.push(
      { market: "btts", selection: "Yes", label: "BTTS Yes", probability: btts.yes },
      { market: "btts", selection: "No", label: "BTTS No", probability: btts.no },
    );
  }
  candidates.sort((a, b) => b.probability - a.probability);
  const best = candidates[0] ?? null;

  return { oneXTwo, ou25, btts, doubleChance, dnb, ah, homeToScore, awayToScore, cards, best };
}

/**
 * Build candidate selections for the "extended" markets (Double Chance, Draw
 * No Bet, Asian Handicap) directly from MatchPredictions.markets. The AH
 * market has dynamic selection labels (line varies per match), so we read
 * straight from the market entry.
 */
function extendedCandidates(
  predictions: MatchPredictions,
  base: { matchId: number; homeTeam: string; awayTeam: string; competition: string | null; kickoff: string },
  market: CoachMarket,
): Array<{
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  kickoff: string;
  market: string;
  marketLabel: string;
  selection: string;
  selectionLabel: string;
  probability: number;
}> {
  const out: ReturnType<typeof extendedCandidates> = [];
  const findM = (m: string) => predictions.markets.find((x) => x.market === m);

  if (market === "any" || market === "double_chance") {
    const dc = findM("double_chance");
    if (dc) {
      for (const [sel, prob] of Object.entries(dc.probabilities)) {
        const label =
          sel === "1X" ? "Home or Draw (1X)"
          : sel === "12" ? "Home or Away (12)"
          : "Draw or Away (X2)";
        out.push({ ...base, market: "double_chance", marketLabel: "Double Chance", selection: sel, selectionLabel: label, probability: prob });
      }
    }
  }
  if (market === "any" || market === "dnb") {
    const dnb = findM("dnb");
    if (dnb) {
      for (const [sel, prob] of Object.entries(dnb.probabilities)) {
        const label = sel === "Home" ? `${base.homeTeam} (DNB)` : `${base.awayTeam} (DNB)`;
        out.push({ ...base, market: "dnb", marketLabel: "Draw No Bet", selection: sel, selectionLabel: label, probability: prob });
      }
    }
  }
  if (market === "any" || market === "ah") {
    const ah = findM("ah");
    if (ah) {
      for (const [sel, prob] of Object.entries(ah.probabilities)) {
        out.push({ ...base, market: "ah", marketLabel: "Asian Handicap", selection: sel, selectionLabel: sel, probability: prob });
      }
    }
  }
  if (market === "any" || market === "home_to_score") {
    const hts = findM("home_to_score");
    if (hts) {
      for (const [sel, prob] of Object.entries(hts.probabilities)) {
        out.push({ ...base, market: "home_to_score", marketLabel: "Home to Score", selection: sel, selectionLabel: `${base.homeTeam} to score: ${sel}`, probability: prob });
      }
    }
  }
  if (market === "any" || market === "away_to_score") {
    const ats = findM("away_to_score");
    if (ats) {
      for (const [sel, prob] of Object.entries(ats.probabilities)) {
        out.push({ ...base, market: "away_to_score", marketLabel: "Away to Score", selection: sel, selectionLabel: `${base.awayTeam} to score: ${sel}`, probability: prob });
      }
    }
  }
  return out;
}

/**
 * Returns predictions for every fixture happening "today" (UTC day).
 * Uses cached predictions when available; computes up to `computeBudget`
 * missing ones on-demand to avoid hammering the API.
 */
export const getTodayPredictions = createServerFn({ method: "POST" })
  .inputValidator((input: { computeBudget?: number } | undefined) => input ?? {})
  .handler(async ({ data }) => {
    try {
      const computeBudget = data.computeBudget ?? 20;
      const supabase = adminClient();

      // 1. Today's fixtures
      const all = await fetchUpcomingMatches(2); // today + tomorrow window for tz safety
      const today = new Date();
      const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const fixtures = all.filter((m) => {
        const d = new Date(m.utcDate);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return key === todayKey;
      });
      fixtures.sort((a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());

      if (fixtures.length === 0) {
        return { rows: [] as TodayPickRow[], computed: 0, missing: 0, error: null as string | null };
      }

      // 2. Read cache for all of them in one query
      const ids = fixtures.map((f) => f.id);
      const { data: cachedRows } = await supabase
        .from("predictions_cache")
        .select("match_id, payload, updated_at")
        .in("match_id", ids);

      const cacheMap = new Map<number, PredictionCacheEntry>();
      for (const row of cachedRows ?? []) {
        const fresh = row.updated_at
          ? Date.now() - new Date(row.updated_at).getTime() < CACHE_TTL_MS
          : false;
        cacheMap.set(row.match_id as number, {
          payload: row.payload as unknown as { match: MatchSummary; predictions: MatchPredictions },
          fresh,
        });
      }

      // 3. Identify fixtures missing fresh predictions OR cached with no form
      // data (previous form fetch returned null — likely a transient API
      // failure; retry now so the row can show real numbers instead of a
      // league-average fallback).
      const missing = fixtures.filter((f) => {
        const c = cacheMap.get(f.id);
        if (!c || !c.fresh) return true;
        return !hasUsableBulkPrediction(c.payload);
      });

      // 4. Compute up to computeBudget fresh predictions sequentially with
      // lightweight form. This covers all fixtures instead of spending dozens
      // of extra xG/stat calls on only the first few matches.
      const toCompute = missing.slice(0, computeBudget);
      const computedCount = await computeLiteBatch(supabase, toCompute, cacheMap);

      // 5. Build rows
      const rows: TodayPickRow[] = fixtures.map((f) => {
        const cached = cacheMap.get(f.id);
        if (!cached) {
          return {
            match: f,
            oneXTwo: null,
            ou25: null,
            btts: null,
            doubleChance: null,
            dnb: null,
            ah: null,
            homeToScore: null,
            awayToScore: null,
            cards: null,
            best: null,
            cached: false,
          };
        }
        const ext = extractMarkets(cached.payload.predictions);
        const hasForm =
          cached.payload.predictions.homeForm != null &&
          cached.payload.predictions.awayForm != null;
        if (!hasForm) {
          return {
            match: f,
            oneXTwo: null,
            ou25: null,
            btts: null,
            doubleChance: null,
            dnb: null,
            ah: null,
            homeToScore: null,
            awayToScore: null,
            cards: null,
            best: null,
            cached: true,
            noData: true,
          };
        }
        return {
          match: f,
          ...ext,
          cached: true,
        };
      });

      const stillMissing = fixtures.filter((f) => {
        const cached = cacheMap.get(f.id);
        return !cached || !hasUsableBulkPrediction(cached.payload);
      }).length;
      return { rows, computed: computedCount, missing: stillMissing, error: null };
    } catch (e) {
      console.error("getTodayPredictions failed", e);
      const msg = e instanceof Error ? e.message : "Failed to load today's predictions";
      return { rows: [] as TodayPickRow[], computed: 0, missing: 0, error: msg };
    }
  });

// ---------------------------------------------------------------------------
// AI Coach: recommend bets for a chosen market based on model probabilities
// ---------------------------------------------------------------------------

export type CoachMarket =
  | "any"
  | "1x2"
  | "ou_25"
  | "btts"
  | "double_chance"
  | "dnb"
  | "ah"
  | "home_to_score"
  | "away_to_score";

export interface CoachRecommendation {
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  kickoff: string;
  market: string;
  selection: string;
  probability: number;
  confidence: "high" | "medium" | "low";
  rationale: string;
}

export interface CoachResponse {
  recommendations: CoachRecommendation[];
  summary: string;
  considered: number;
  error: string | null;
}

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

function marketLabel(m: CoachMarket): string {
  switch (m) {
    case "1x2": return "Match Result (1X2)";
    case "ou_25": return "Over/Under 2.5 Goals";
    case "btts": return "Both Teams To Score";
    case "double_chance": return "Double Chance";
    case "dnb": return "Draw No Bet";
    case "ah": return "Asian Handicap";
    case "home_to_score": return "Home Team to Score";
    case "away_to_score": return "Away Team to Score";
    default: return "Any market";
  }
}

export const getCoachRecommendations = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { market?: CoachMarket; minProbability?: number; maxPicks?: number } | undefined) =>
      input ?? {},
  )
  .handler(async ({ data }): Promise<CoachResponse> => {
    const market: CoachMarket = data.market ?? "any";
    const minProbability = Math.max(0, Math.min(95, data.minProbability ?? 55));
    const maxPicks = Math.max(1, Math.min(10, data.maxPicks ?? 5));

    try {
      const supabase = adminClient();

      // 1. Today's fixtures (UTC day)
      const all = await fetchUpcomingMatches(2);
      const today = new Date();
      const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const nowMs = Date.now();
      const fixtures = all.filter((m) => {
        const d = new Date(m.utcDate);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        // Only today's fixtures whose kickoff is still in the future.
        return key === todayKey && d.getTime() > nowMs;
      });

      if (fixtures.length === 0) {
        return {
          recommendations: [],
          summary: "No fixtures today. Check back tomorrow for fresh picks.",
          considered: 0,
          error: null,
        };
      }

      // 2. Pull whatever cached predictions we already have (no on-demand compute)
      const ids = fixtures.map((f) => f.id);
      const { data: cachedRows } = await supabase
        .from("predictions_cache")
        .select("match_id, payload")
        .in("match_id", ids);

      const cacheMap = new Map<number, { match: MatchSummary; predictions: MatchPredictions }>();
      for (const row of cachedRows ?? []) {
        cacheMap.set(
          row.match_id as number,
          row.payload as unknown as { match: MatchSummary; predictions: MatchPredictions },
        );
      }

      // 2b. If we don't have enough cached predictions to give the AI a real
      // shortlist, lazily compute a batch right here (bounded so we don't
      // hammer the football API).
      const minCacheTarget = Math.max(maxPicks * 3, 12);
      if (cacheMap.size < minCacheTarget) {
        const computeBudget = Math.min(12, fixtures.length - cacheMap.size);
        const toCompute = fixtures.filter((f) => !cacheMap.has(f.id)).slice(0, computeBudget);
        await Promise.allSettled(
          toCompute.map(async (f) => {
            try {
              const [homeForm, awayForm] = await Promise.all([
                fetchTeamForm(f.homeTeam.id),
                fetchTeamForm(f.awayTeam.id),
              ]);
              const { markets, expectedGoalsHome, expectedGoalsAway } = predictMarkets(
                homeForm,
                awayForm,
              );
              const predictions: MatchPredictions = {
                matchId: f.id,
                generatedAt: new Date().toISOString(),
                homeForm,
                awayForm,
                expectedGoalsHome,
                expectedGoalsAway,
                markets,
                commentary: "",
              };
              const payload = { match: f, predictions };
              try {
                await supabase.from("predictions_cache").upsert({
                  match_id: f.id,
                  payload: payload as unknown,
                  updated_at: new Date().toISOString(),
                });
              } catch (e) {
                console.warn("coach cache write skipped", e);
              }
              cacheMap.set(f.id, payload);
            } catch (e) {
              console.warn("coach predict failed for", f.id, e);
            }
          }),
        );
      }

      // 3. Build candidate selections from cached fixtures
      type Candidate = {
        matchId: number;
        homeTeam: string;
        awayTeam: string;
        competition: string | null;
        kickoff: string;
        market: string;
        marketLabel: string;
        selection: string;
        selectionLabel: string;
        probability: number;
      };

      const candidates: Candidate[] = [];
      for (const f of fixtures) {
        const cached = cacheMap.get(f.id);
        if (!cached) continue;
        const { oneXTwo, ou25, btts } = extractMarkets(cached.predictions);
        const base = {
          matchId: f.id,
          homeTeam: f.homeTeam.name,
          awayTeam: f.awayTeam.name,
          competition: f.competition?.name ?? null,
          kickoff: f.utcDate,
        };
        if ((market === "any" || market === "1x2") && oneXTwo) {
          candidates.push({ ...base, market: "1x2", marketLabel: "Match Result", selection: "1", selectionLabel: `${f.homeTeam.shortName ?? f.homeTeam.name} to win`, probability: oneXTwo.home });
          candidates.push({ ...base, market: "1x2", marketLabel: "Match Result", selection: "X", selectionLabel: "Draw", probability: oneXTwo.draw });
          candidates.push({ ...base, market: "1x2", marketLabel: "Match Result", selection: "2", selectionLabel: `${f.awayTeam.shortName ?? f.awayTeam.name} to win`, probability: oneXTwo.away });
        }
        if ((market === "any" || market === "ou_25") && ou25) {
          candidates.push({ ...base, market: "ou_25", marketLabel: "Goals", selection: "Over", selectionLabel: "Over 2.5 goals", probability: ou25.over });
          candidates.push({ ...base, market: "ou_25", marketLabel: "Goals", selection: "Under", selectionLabel: "Under 2.5 goals", probability: ou25.under });
        }
        if ((market === "any" || market === "btts") && btts) {
          candidates.push({ ...base, market: "btts", marketLabel: "BTTS", selection: "Yes", selectionLabel: "Both teams to score: Yes", probability: btts.yes });
          candidates.push({ ...base, market: "btts", marketLabel: "BTTS", selection: "No", selectionLabel: "Both teams to score: No", probability: btts.no });
        }
        candidates.push(...extendedCandidates(cached.predictions, base, market));
      }

      // 4. Filter by min probability, sort, take top N (one per match wins out)
      const filtered = candidates.filter((c) => c.probability >= minProbability);
      filtered.sort((a, b) => b.probability - a.probability);
      const seenMatch = new Set<number>();
      const top: Candidate[] = [];
      for (const c of filtered) {
        if (seenMatch.has(c.matchId)) continue;
        seenMatch.add(c.matchId);
        top.push(c);
        if (top.length >= maxPicks) break;
      }

      const consideredCount = cacheMap.size;

      if (top.length === 0) {
        return {
          recommendations: [],
          summary:
            consideredCount === 0
              ? "Couldn't load predictions for today's fixtures right now. Try again in a moment."
              : `Looked at ${consideredCount} matches with predictions but none cleared the ${minProbability}% confidence floor for ${marketLabel(market)}. Lower the threshold or pick a different market.`,
          considered: consideredCount,
          error: null,
        };
      }

      // 5. Ask the AI to write a rationale per pick + a short overall summary
      const apiKey = process.env.LOVABLE_API_KEY;
      let aiSummary = "";
      const rationales = new Map<string, { rationale: string; confidence: "high" | "medium" | "low" }>();

      if (apiKey) {
        try {
          const payload = {
            market: marketLabel(market),
            minProbability,
            picks: top.map((c) => ({
              id: `${c.matchId}-${c.market}-${c.selection}`,
              match: `${c.homeTeam} vs ${c.awayTeam}`,
              competition: c.competition,
              kickoff: c.kickoff,
              marketLabel: c.marketLabel,
              selection: c.selectionLabel,
              modelProbability: Math.round(c.probability),
            })),
          };

          const res = await fetch(GATEWAY, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-3-flash-preview",
              messages: [
                {
                  role: "system",
                  content:
                    "You are a sharp football betting analyst. You receive a list of candidate bets pre-filtered by a statistical model with their model probability (0-100). For each pick write ONE concise sentence (max 25 words) explaining why the model rates it. Then write a 1-2 sentence overall summary highlighting your favourite. Never invent stats — only reason from the probability and market context. No disclaimers, no markdown.",
                },
                {
                  role: "user",
                  content: `Today's candidate bets:\n${JSON.stringify(payload, null, 2)}`,
                },
              ],
              tools: [
                {
                  type: "function",
                  function: {
                    name: "submit_recommendations",
                    description: "Return per-pick rationales and an overall summary.",
                    parameters: {
                      type: "object",
                      properties: {
                        picks: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              rationale: { type: "string" },
                              confidence: { type: "string", enum: ["high", "medium", "low"] },
                            },
                            required: ["id", "rationale", "confidence"],
                            additionalProperties: false,
                          },
                        },
                        summary: { type: "string" },
                      },
                      required: ["picks", "summary"],
                      additionalProperties: false,
                    },
                  },
                },
              ],
              tool_choice: { type: "function", function: { name: "submit_recommendations" } },
            }),
          });

          if (res.ok) {
            const json = (await res.json()) as {
              choices?: {
                message?: {
                  tool_calls?: { function?: { arguments?: string } }[];
                  content?: string;
                };
              }[];
            };
            const argStr = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
            if (argStr) {
              try {
                const parsed = JSON.parse(argStr) as {
                  picks?: { id: string; rationale: string; confidence: "high" | "medium" | "low" }[];
                  summary?: string;
                };
                aiSummary = parsed.summary ?? "";
                for (const p of parsed.picks ?? []) {
                  rationales.set(p.id, { rationale: p.rationale, confidence: p.confidence });
                }
              } catch (e) {
                console.warn("coach: failed to parse tool args", e);
              }
            }
          } else if (res.status === 429) {
            aiSummary = "AI rationales rate-limited — showing model picks only.";
          } else if (res.status === 402) {
            aiSummary = "AI rationales unavailable (workspace credits exhausted) — showing model picks only.";
          } else {
            console.error("coach AI error", res.status);
          }
        } catch (e) {
          console.error("coach AI failed", e);
        }
      }

      const recommendations: CoachRecommendation[] = top.map((c) => {
        const id = `${c.matchId}-${c.market}-${c.selection}`;
        const r = rationales.get(id);
        const fallbackConfidence: "high" | "medium" | "low" =
          c.probability >= 75 ? "high" : c.probability >= 60 ? "medium" : "low";
        return {
          matchId: c.matchId,
          homeTeam: c.homeTeam,
          awayTeam: c.awayTeam,
          competition: c.competition,
          kickoff: c.kickoff,
          market: c.marketLabel,
          selection: c.selectionLabel,
          probability: c.probability,
          confidence: r?.confidence ?? fallbackConfidence,
          rationale:
            r?.rationale ??
            `Model gives this ${Math.round(c.probability)}% — among the strongest signals on today's slate.`,
        };
      });

      if (!aiSummary) {
        const top1 = recommendations[0];
        aiSummary = top1
          ? `Top conviction: ${top1.selection} in ${top1.homeTeam} vs ${top1.awayTeam} at ${Math.round(top1.probability)}% model probability.`
          : "Model picks ready.";
      }

      return {
        recommendations,
        summary: aiSummary,
        considered: consideredCount,
        error: null,
      };
    } catch (e) {
      console.error("getCoachRecommendations failed", e);
      const msg = e instanceof Error ? e.message : "Failed to generate recommendations";
      return { recommendations: [], summary: "", considered: 0, error: msg };
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Head-to-head & recent results for the match detail page
// ─────────────────────────────────────────────────────────────────────────────

export interface H2HMatchRow {
  id: number;
  utcDate: string;
  competition: string | null;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
  scoreHome: number | null;
  scoreAway: number | null;
}

export interface H2HResponse {
  h2h: H2HMatchRow[];
  homeRecent: H2HMatchRow[];
  awayRecent: H2HMatchRow[];
  summary: { homeWins: number; awayWins: number; draws: number };
  error: string | null;
}

function toH2HRow(m: MatchSummary): H2HMatchRow {
  return {
    id: m.id,
    utcDate: m.utcDate,
    competition: m.competition?.name ?? null,
    homeTeam: { id: m.homeTeam.id, name: m.homeTeam.name },
    awayTeam: { id: m.awayTeam.id, name: m.awayTeam.name },
    scoreHome: m.score.fullTime.home,
    scoreAway: m.score.fullTime.away,
  };
}

export const getMatchH2H = createServerFn({ method: "POST" })
  .inputValidator((input: { homeTeamId: number; awayTeamId: number }) => input)
  .handler(async ({ data }): Promise<H2HResponse> => {
    try {
      const [h2hMatches, homeRecent, awayRecent] = await Promise.all([
        fetchHeadToHead(data.homeTeamId, data.awayTeamId, 5),
        fetchRecentMatches(data.homeTeamId, 5),
        fetchRecentMatches(data.awayTeamId, 5),
      ]);

      let homeWins = 0, awayWins = 0, draws = 0;
      for (const m of h2hMatches) {
        const h = m.score.fullTime.home;
        const a = m.score.fullTime.away;
        if (h == null || a == null) continue;
        const homeIsTarget = m.homeTeam.id === data.homeTeamId;
        const targetGoals = homeIsTarget ? h : a;
        const opponentGoals = homeIsTarget ? a : h;
        if (targetGoals > opponentGoals) homeWins++;
        else if (targetGoals < opponentGoals) awayWins++;
        else draws++;
      }

      return {
        h2h: h2hMatches.map(toH2HRow),
        homeRecent: homeRecent.map(toH2HRow),
        awayRecent: awayRecent.map(toH2HRow),
        summary: { homeWins, awayWins, draws },
        error: null,
      };
    } catch (e) {
      console.error("getMatchH2H failed", e);
      const msg = e instanceof Error ? e.message : "Failed to load head-to-head";
      return {
        h2h: [],
        homeRecent: [],
        awayRecent: [],
        summary: { homeWins: 0, awayWins: 0, draws: 0 },
        error: msg,
      };
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Pick of the Day — single AI-curated highlight
// ─────────────────────────────────────────────────────────────────────────────

export interface PickOfTheDayResponse {
  pick: {
    matchId: number;
    homeTeam: string;
    awayTeam: string;
    competition: string | null;
    kickoff: string;
    market: string;
    marketLabel: string;
    selection: string;
    selectionLabel: string;
    probability: number;
    expectedGoals: { home: number; away: number };
  } | null;
  considered: number;
  error: string | null;
}

export const getPickOfTheDay = createServerFn({ method: "GET" }).handler(
  async (): Promise<PickOfTheDayResponse> => {
    try {
      const supabase = adminClient();
      const all = await fetchUpcomingMatches(2);
      const today = new Date();
      const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const nowMs = Date.now();
      const fixtures = all.filter((m) => {
        const d = new Date(m.utcDate);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return key === todayKey && d.getTime() > nowMs;
      });

      if (fixtures.length === 0) {
        return { pick: null, considered: 0, error: null };
      }

      const ids = fixtures.map((f) => f.id);
      const { data: cachedRows } = await supabase
        .from("predictions_cache")
        .select("match_id, payload")
        .in("match_id", ids);

      const cacheMap = new Map<number, { match: MatchSummary; predictions: MatchPredictions }>();
      for (const row of cachedRows ?? []) {
        cacheMap.set(
          row.match_id as number,
          row.payload as unknown as { match: MatchSummary; predictions: MatchPredictions },
        );
      }

      type Cand = {
        matchId: number;
        homeTeam: string;
        awayTeam: string;
        competition: string | null;
        kickoff: string;
        market: string;
        marketLabel: string;
        selection: string;
        selectionLabel: string;
        probability: number;
        expectedGoals: { home: number; away: number };
      };

      const all_candidates: Cand[] = [];
      for (const f of fixtures) {
        const cached = cacheMap.get(f.id);
        if (!cached) continue;
        const { oneXTwo, ou25, btts } = extractMarkets(cached.predictions);
        const base = {
          matchId: f.id,
          homeTeam: f.homeTeam.name,
          awayTeam: f.awayTeam.name,
          competition: f.competition?.name ?? null,
          kickoff: f.utcDate,
          expectedGoals: {
            home: cached.predictions.expectedGoalsHome,
            away: cached.predictions.expectedGoalsAway,
          },
        };
        if (oneXTwo) {
          const map = { "1": ["Home", oneXTwo.home], X: ["Draw", oneXTwo.draw], "2": ["Away", oneXTwo.away] } as const;
          const [label, prob] = map[oneXTwo.pick as "1" | "X" | "2"] ?? ["", 0];
          all_candidates.push({ ...base, market: "1x2", marketLabel: "Match Result", selection: oneXTwo.pick, selectionLabel: label as string, probability: prob as number });
        }
        if (ou25) {
          const prob = ou25.pick === "Over" ? ou25.over : ou25.under;
          all_candidates.push({ ...base, market: "ou_25", marketLabel: "Over/Under 2.5", selection: ou25.pick, selectionLabel: `${ou25.pick} 2.5`, probability: prob });
        }
        if (btts) {
          const prob = btts.pick === "Yes" ? btts.yes : btts.no;
          all_candidates.push({ ...base, market: "btts", marketLabel: "Both Teams To Score", selection: btts.pick, selectionLabel: `BTTS ${btts.pick}`, probability: prob });
        }
      }

      // Sort by probability descending and pick the highest-confidence selection
      all_candidates.sort((a, b) => b.probability - a.probability);
      const pick = all_candidates[0] ?? null;

      return { pick, considered: cacheMap.size, error: null };
    } catch (e) {
      console.error("getPickOfTheDay failed", e);
      return {
        pick: null,
        considered: 0,
        error: e instanceof Error ? e.message : "Failed to load pick of the day",
      };
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// AI Accumulator builder — let the model pick N legs from today's slate
// ─────────────────────────────────────────────────────────────────────────────

export interface AccumulatorLeg {
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  kickoff: string;
  market: string;        // "1x2" | "ou_25" | "btts"
  marketLabel: string;
  selection: string;     // "1" | "X" | "2" | "Over" | "Under" | "Yes" | "No"
  selectionLabel: string;
  probability: number;   // 0..100
  fairOdds: number;      // 1 / (probability/100)
  rationale: string;
}

export interface AccumulatorResponse {
  legs: AccumulatorLeg[];
  combinedProbability: number; // 0..1
  combinedFairOdds: number;
  summary: string;
  considered: number;
  error: string | null;
}

export const getAccumulatorBuilder = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      legs?: number;            // 2..5
      minProbability?: number;  // per-leg floor, 0..95
      market?: CoachMarket;     // "any" | "1x2" | "ou_25" | "btts"
    } | undefined) => input ?? {},
  )
  .handler(async ({ data }): Promise<AccumulatorResponse> => {
    const targetLegs = Math.max(2, Math.min(5, data.legs ?? 3));
    const minProbability = Math.max(0, Math.min(95, data.minProbability ?? 60));
    const market: CoachMarket = data.market ?? "any";

    try {
      const supabase = adminClient();

      // Today's upcoming fixtures only
      const all = await fetchUpcomingMatches(2);
      const today = new Date();
      const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const nowMs = Date.now();
      const fixtures = all.filter((m) => {
        const d = new Date(m.utcDate);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return key === todayKey && d.getTime() > nowMs;
      });

      if (fixtures.length === 0) {
        return {
          legs: [],
          combinedProbability: 0,
          combinedFairOdds: 0,
          summary: "No upcoming fixtures left today. Try again tomorrow.",
          considered: 0,
          error: null,
        };
      }

      // Pull cached predictions; lazily compute a small batch if cache is thin.
      const ids = fixtures.map((f) => f.id);
      const { data: cachedRows } = await supabase
        .from("predictions_cache")
        .select("match_id, payload")
        .in("match_id", ids);

      const cacheMap = new Map<number, { match: MatchSummary; predictions: MatchPredictions }>();
      for (const row of cachedRows ?? []) {
        cacheMap.set(
          row.match_id as number,
          row.payload as unknown as { match: MatchSummary; predictions: MatchPredictions },
        );
      }

      const minCacheTarget = Math.max(targetLegs * 4, 12);
      if (cacheMap.size < minCacheTarget) {
        const computeBudget = Math.min(12, fixtures.length - cacheMap.size);
        const toCompute = fixtures.filter((f) => !cacheMap.has(f.id)).slice(0, computeBudget);
        await Promise.allSettled(
          toCompute.map(async (f) => {
            try {
              const [homeForm, awayForm] = await Promise.all([
                fetchTeamForm(f.homeTeam.id),
                fetchTeamForm(f.awayTeam.id),
              ]);
              const { markets, expectedGoalsHome, expectedGoalsAway } = predictMarkets(
                homeForm,
                awayForm,
              );
              const predictions: MatchPredictions = {
                matchId: f.id,
                generatedAt: new Date().toISOString(),
                homeForm,
                awayForm,
                expectedGoalsHome,
                expectedGoalsAway,
                markets,
                commentary: "",
              };
              const payload = { match: f, predictions };
              try {
                await supabase.from("predictions_cache").upsert({
                  match_id: f.id,
                  payload: payload as unknown,
                  updated_at: new Date().toISOString(),
                });
              } catch (e) {
                console.warn("acca cache write skipped", e);
              }
              cacheMap.set(f.id, payload);
            } catch (e) {
              console.warn("acca predict failed for", f.id, e);
            }
          }),
        );
      }

      // Build candidates (one selection at a time, multiple per match allowed
      // initially — we'll deduplicate per match before selection).
      type Cand = {
        matchId: number;
        homeTeam: string;
        awayTeam: string;
        competition: string | null;
        kickoff: string;
        market: string;
        marketLabel: string;
        selection: string;
        selectionLabel: string;
        probability: number;
      };

      const candidates: Cand[] = [];
      for (const f of fixtures) {
        const cached = cacheMap.get(f.id);
        if (!cached) continue;
        const { oneXTwo, ou25, btts } = extractMarkets(cached.predictions);
        const base = {
          matchId: f.id,
          homeTeam: f.homeTeam.name,
          awayTeam: f.awayTeam.name,
          competition: f.competition?.name ?? null,
          kickoff: f.utcDate,
        };
        if ((market === "any" || market === "1x2") && oneXTwo) {
          candidates.push({ ...base, market: "1x2", marketLabel: "Match Result", selection: "1", selectionLabel: `${f.homeTeam.shortName ?? f.homeTeam.name} to win`, probability: oneXTwo.home });
          candidates.push({ ...base, market: "1x2", marketLabel: "Match Result", selection: "X", selectionLabel: "Draw", probability: oneXTwo.draw });
          candidates.push({ ...base, market: "1x2", marketLabel: "Match Result", selection: "2", selectionLabel: `${f.awayTeam.shortName ?? f.awayTeam.name} to win`, probability: oneXTwo.away });
        }
        if ((market === "any" || market === "ou_25") && ou25) {
          candidates.push({ ...base, market: "ou_25", marketLabel: "Goals", selection: "Over", selectionLabel: "Over 2.5 goals", probability: ou25.over });
          candidates.push({ ...base, market: "ou_25", marketLabel: "Goals", selection: "Under", selectionLabel: "Under 2.5 goals", probability: ou25.under });
        }
        if ((market === "any" || market === "btts") && btts) {
          candidates.push({ ...base, market: "btts", marketLabel: "BTTS", selection: "Yes", selectionLabel: "Both teams to score: Yes", probability: btts.yes });
          candidates.push({ ...base, market: "btts", marketLabel: "BTTS", selection: "No", selectionLabel: "Both teams to score: No", probability: btts.no });
        }
        candidates.push(...extendedCandidates(cached.predictions, base, market));
      }

      // Filter by probability floor, keep best per (match,market) so we don't
      // double-count both sides of the same market.
      const filtered = candidates.filter((c) => c.probability >= minProbability);
      filtered.sort((a, b) => b.probability - a.probability);
      const seenMatchMarket = new Set<string>();
      const shortlist: Cand[] = [];
      for (const c of filtered) {
        const key = `${c.matchId}-${c.market}`;
        if (seenMatchMarket.has(key)) continue;
        seenMatchMarket.add(key);
        shortlist.push(c);
        if (shortlist.length >= 25) break;
      }

      const consideredCount = cacheMap.size;
      if (shortlist.length < targetLegs) {
        return {
          legs: [],
          combinedProbability: 0,
          combinedFairOdds: 0,
          summary:
            consideredCount === 0
              ? "Couldn't load predictions for today's fixtures right now. Try again in a moment."
              : `Only ${shortlist.length} candidate(s) cleared the ${minProbability}% floor across ${consideredCount} matches with predictions. Lower the threshold or fewer legs.`,
          considered: consideredCount,
          error: null,
        };
      }

      // Ask the AI to pick the best N legs (one per match) and write rationales.
      const apiKey = process.env.LOVABLE_API_KEY;
      let chosenIds: string[] = [];
      const rationales = new Map<string, string>();
      let aiSummary = "";

      if (apiKey) {
        try {
          const payload = {
            instructions: {
              targetLegs,
              minProbability,
              marketFilter: marketLabel(market),
              rule: "Pick the best legs to combine into a single accumulator. Use only one leg per match. Prefer high probability AND diversification across leagues/markets to reduce correlation.",
            },
            candidates: shortlist.map((c) => ({
              id: `${c.matchId}-${c.market}-${c.selection}`,
              match: `${c.homeTeam} vs ${c.awayTeam}`,
              competition: c.competition,
              kickoff: c.kickoff,
              marketLabel: c.marketLabel,
              selection: c.selectionLabel,
              modelProbability: Math.round(c.probability),
            })),
          };

          const res = await fetch(GATEWAY, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-3-flash-preview",
              messages: [
                {
                  role: "system",
                  content:
                    "You are a sharp football betting analyst building accumulators. Pick exactly the requested number of legs from the candidates, one leg per match, balancing probability and diversification across leagues/markets. For each chosen leg write ONE concise sentence (max 22 words) explaining why. Then write a 1-2 sentence overall accumulator summary. Never invent stats. No markdown, no disclaimers.",
                },
                {
                  role: "user",
                  content: `Build me a ${targetLegs}-leg accumulator from these candidates:\n${JSON.stringify(payload, null, 2)}`,
                },
              ],
              tools: [
                {
                  type: "function",
                  function: {
                    name: "submit_accumulator",
                    description: "Return the chosen accumulator legs and a summary.",
                    parameters: {
                      type: "object",
                      properties: {
                        legs: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              rationale: { type: "string" },
                            },
                            required: ["id", "rationale"],
                            additionalProperties: false,
                          },
                        },
                        summary: { type: "string" },
                      },
                      required: ["legs", "summary"],
                      additionalProperties: false,
                    },
                  },
                },
              ],
              tool_choice: { type: "function", function: { name: "submit_accumulator" } },
            }),
          });

          if (res.ok) {
            const json = (await res.json()) as {
              choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
            };
            const argStr = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
            if (argStr) {
              try {
                const parsed = JSON.parse(argStr) as {
                  legs?: { id: string; rationale: string }[];
                  summary?: string;
                };
                aiSummary = parsed.summary ?? "";
                for (const l of parsed.legs ?? []) {
                  rationales.set(l.id, l.rationale);
                  chosenIds.push(l.id);
                }
              } catch (e) {
                console.warn("acca: failed to parse tool args", e);
              }
            }
          } else if (res.status === 429) {
            aiSummary = "AI rate-limited — falling back to top model picks.";
          } else if (res.status === 402) {
            aiSummary = "AI credits exhausted — falling back to top model picks.";
          } else {
            console.error("acca AI error", res.status);
          }
        } catch (e) {
          console.error("acca AI failed", e);
        }
      }

      // Resolve AI-chosen ids back to candidates, enforce one-per-match,
      // and pad / fall back to top-probability picks if needed.
      const candById = new Map(shortlist.map((c) => [`${c.matchId}-${c.market}-${c.selection}`, c]));
      const seenMatch = new Set<number>();
      const finalCands: Cand[] = [];
      for (const id of chosenIds) {
        const c = candById.get(id);
        if (!c) continue;
        if (seenMatch.has(c.matchId)) continue;
        seenMatch.add(c.matchId);
        finalCands.push(c);
        if (finalCands.length >= targetLegs) break;
      }
      // Fallback / top-up
      if (finalCands.length < targetLegs) {
        for (const c of shortlist) {
          if (seenMatch.has(c.matchId)) continue;
          seenMatch.add(c.matchId);
          finalCands.push(c);
          if (finalCands.length >= targetLegs) break;
        }
      }

      const legs: AccumulatorLeg[] = finalCands.map((c) => {
        const id = `${c.matchId}-${c.market}-${c.selection}`;
        const fair = c.probability > 0 ? +(100 / c.probability).toFixed(2) : 0;
        return {
          matchId: c.matchId,
          homeTeam: c.homeTeam,
          awayTeam: c.awayTeam,
          competition: c.competition,
          kickoff: c.kickoff,
          market: c.market,
          marketLabel: c.marketLabel,
          selection: c.selection,
          selectionLabel: c.selectionLabel,
          probability: c.probability,
          fairOdds: fair,
          rationale:
            rationales.get(id) ??
            `Model gives this ${Math.round(c.probability)}% — among the strongest signals on today's slate.`,
        };
      });

      const combinedProbability = legs.reduce((acc, l) => acc * (l.probability / 100), 1);
      const combinedFairOdds = combinedProbability > 0 ? +(1 / combinedProbability).toFixed(2) : 0;

      if (!aiSummary) {
        aiSummary = legs.length
          ? `${legs.length}-leg accumulator at ${(combinedProbability * 100).toFixed(1)}% combined model probability (fair odds ${combinedFairOdds.toFixed(2)}).`
          : "Couldn't build an accumulator from today's slate.";
      }

      return {
        legs,
        combinedProbability,
        combinedFairOdds,
        summary: aiSummary,
        considered: consideredCount,
        error: null,
      };
    } catch (e) {
      console.error("getAccumulatorBuilder failed", e);
      return {
        legs: [],
        combinedProbability: 0,
        combinedFairOdds: 0,
        summary: "",
        considered: 0,
        error: e instanceof Error ? e.message : "Failed to build accumulator",
      };
    }
  });
/* ============================================================
 * Bet Builder — same-game multi (correlation-adjusted)
 * ==========================================================*/

export interface BetBuilderMatch {
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  kickoff: string;
  /** Cached individual-market predictions, used for the per-leg "model %" badge. */
  legProbabilities: Record<BuilderLegId, number>;
  /** Set of leg IDs currently impossible (e.g. no form data). */
  unavailable: BuilderLegId[];
}

export interface BetBuilderResponse {
  match: BetBuilderMatch | null;
  /**
   * Joint probability for the requested combination of legs (0..1).
   * `null` if no legs requested.
   */
  jointProbability: number | null;
  fairOdds: number | null;
  /** Leg IDs that are now disabled given the current selection (group lockout + conflicts). */
  conflicts: BuilderLegId[];
  error: string | null;
}

/**
 * Build a per-leg probability map by extracting individual-leg probabilities
 * from the cached scoreline matrix. This is the same number you'd see in
 * Today's Picks, just on every available selection.
 */
function legProbabilitiesFromMatrix(matrix: number[][]): Record<BuilderLegId, number> {
  const out: Partial<Record<BuilderLegId, number>> = {};
  for (const meta of BUILDER_LEGS) {
    out[meta.id] = +(jointProbability(matrix, [meta.id]) * 100).toFixed(1);
  }
  return out as Record<BuilderLegId, number>;
}

export const getBetBuilder = createServerFn({ method: "POST" })
  .inputValidator((input: { matchId: number; legs: BuilderLegId[] }) => input)
  .handler(async ({ data }): Promise<BetBuilderResponse> => {
    try {
      const supabase = adminClient();
      const matchId = Number(data.matchId);
      const legs = (data.legs ?? []).slice(0, 8); // hard cap

      const { data: cached } = await supabase
        .from("predictions_cache")
        .select("payload")
        .eq("match_id", matchId)
        .maybeSingle();

      if (!cached?.payload) {
        return {
          match: null,
          jointProbability: null,
          fairOdds: null,
          conflicts: [],
          error: "No predictions available for this match yet. Open the match once to generate them.",
        };
      }

      const payload = cached.payload as unknown as {
        match: MatchSummary;
        predictions: MatchPredictions;
      };

      if (!payload.predictions.homeForm || !payload.predictions.awayForm) {
        return {
          match: {
            matchId,
            homeTeam: payload.match.homeTeam.name,
            awayTeam: payload.match.awayTeam.name,
            competition: payload.match.competition?.name ?? null,
            kickoff: payload.match.utcDate,
            legProbabilities: {} as Record<BuilderLegId, number>,
            unavailable: BUILDER_LEGS.map((l) => l.id),
          },
          jointProbability: null,
          fairOdds: null,
          conflicts: [],
          error: "Not enough form data to build a bet for this match.",
        };
      }

      const { matrix } = buildScorelineMatrix(
        payload.predictions.homeForm,
        payload.predictions.awayForm,
        payload.predictions.homeInjuries ?? null,
        payload.predictions.awayInjuries ?? null,
      );

      const legProbabilities = legProbabilitiesFromMatrix(matrix);
      const conflictsSet = conflictingLegs(matrix, legs);
      const joint = legs.length > 0 ? jointProbability(matrix, legs) : null;
      const fairOdds = joint != null && joint > 1e-9 ? +(1 / joint).toFixed(2) : null;

      return {
        match: {
          matchId,
          homeTeam: payload.match.homeTeam.name,
          awayTeam: payload.match.awayTeam.name,
          competition: payload.match.competition?.name ?? null,
          kickoff: payload.match.utcDate,
          legProbabilities,
          unavailable: [],
        },
        jointProbability: joint,
        fairOdds,
        conflicts: Array.from(conflictsSet),
        error: null,
      };
    } catch (e) {
      console.error("getBetBuilder failed", e);
      return {
        match: null,
        jointProbability: null,
        fairOdds: null,
        conflicts: [],
        error: e instanceof Error ? e.message : "Failed to build bet",
      };
    }
  });

export interface AiBetBuilderResponse {
  legs: BuilderLegId[];
  rationale: string;
  jointProbability: number | null;
  fairOdds: number | null;
  conflicts: BuilderLegId[];
  legProbabilities: Record<BuilderLegId, number> | null;
  error: string | null;
}

export const getAiBetBuilder = createServerFn({ method: "POST" })
  .inputValidator((input: { matchId: number; riskLevel: RiskLevel }) => input)
  .handler(async ({ data }): Promise<AiBetBuilderResponse> => {
    try {
      const supabase = adminClient();
      const matchId = Number(data.matchId);
      const riskLevel: RiskLevel = data.riskLevel ?? "balanced";

      const { data: cached } = await supabase
        .from("predictions_cache")
        .select("payload")
        .eq("match_id", matchId)
        .maybeSingle();

      if (!cached?.payload) {
        return {
          legs: [],
          rationale: "",
          jointProbability: null,
          fairOdds: null,
          conflicts: [],
          legProbabilities: null,
          error: "No predictions for this match yet. Open the match once to generate them.",
        };
      }

      const payload = cached.payload as unknown as {
        match: MatchSummary;
        predictions: MatchPredictions;
      };

      if (!payload.predictions.homeForm || !payload.predictions.awayForm) {
        return {
          legs: [],
          rationale: "",
          jointProbability: null,
          fairOdds: null,
          conflicts: [],
          legProbabilities: null,
          error: "Not enough form data to build a bet for this match.",
        };
      }

      const { matrix } = buildScorelineMatrix(
        payload.predictions.homeForm,
        payload.predictions.awayForm,
        payload.predictions.homeInjuries ?? null,
        payload.predictions.awayInjuries ?? null,
      );
      const legProbabilities = legProbabilitiesFromMatrix(matrix);

      const ai = await generateAiBetBuilder({
        homeTeam: payload.match.homeTeam.name,
        awayTeam: payload.match.awayTeam.name,
        competition: payload.match.competition?.name ?? null,
        expectedGoalsHome: payload.predictions.expectedGoalsHome,
        expectedGoalsAway: payload.predictions.expectedGoalsAway,
        legProbabilities,
        riskLevel,
      });

      if (ai.error || ai.legs.length < 2) {
        return {
          legs: [],
          rationale: ai.rationale,
          jointProbability: null,
          fairOdds: null,
          conflicts: [],
          legProbabilities,
          error: ai.error ?? "AI returned no usable selection.",
        };
      }

      // Drop any legs that produce zero joint probability (defensive).
      const safeLegs: BuilderLegId[] = [];
      for (const leg of ai.legs) {
        const candidate = [...safeLegs, leg];
        if (jointProbability(matrix, candidate) > 1e-9) safeLegs.push(leg);
      }
      if (safeLegs.length < 2) {
        return {
          legs: [],
          rationale: ai.rationale,
          jointProbability: null,
          fairOdds: null,
          conflicts: [],
          legProbabilities,
          error: "AI selection conflicted — please retry.",
        };
      }

      const conflictsSet = conflictingLegs(matrix, safeLegs);
      const joint = jointProbability(matrix, safeLegs);
      const fairOdds = joint > 1e-9 ? +(1 / joint).toFixed(2) : null;

      return {
        legs: safeLegs,
        rationale: ai.rationale,
        jointProbability: joint,
        fairOdds,
        conflicts: Array.from(conflictsSet),
        legProbabilities,
        error: null,
      };
    } catch (e) {
      console.error("getAiBetBuilder failed", e);
      return {
        legs: [],
        rationale: "",
        jointProbability: null,
        fairOdds: null,
        conflicts: [],
        legProbabilities: null,
        error: e instanceof Error ? e.message : "AI generator failed",
      };
    }
  });

// ---------------------------------------------------------------------------
// Stats: per-market hit rate over recently finished matches
// ---------------------------------------------------------------------------

export interface MarketStat {
  market: string;
  label: string;
  hits: number;
  total: number;
  hitRate: number; // 0..100
}

export interface StatsResponse {
  windowDays: number;
  totalMatchesGraded: number;
  perMarket: MarketStat[];
  bestPick: MarketStat & { byMarket: MarketStat[] };
  error: string | null;
}

/**
 * Grade a single cached prediction against the actual final score.
 * Returns a map of marketKey -> true/false (won/lost). Markets that
 * cannot be graded from goals alone (corners, shots, …) are omitted.
 */
function gradePredictions(
  predictions: MatchPredictions,
  finalHome: number,
  finalAway: number,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const totalGoals = finalHome + finalAway;
  const result: "1" | "X" | "2" =
    finalHome > finalAway ? "1" : finalHome < finalAway ? "2" : "X";

  for (const m of predictions.markets) {
    const pick = m.pick;
    switch (m.market) {
      case "1x2": {
        // Pick labels from the predictor are "1 (Home)" / "X (Draw)" / "2 (Away)".
        const p = pick.trim();
        const pickedSide: "1" | "X" | "2" | null =
          p.startsWith("1") || /home/i.test(p) ? "1"
          : p.startsWith("X") || /draw/i.test(p) ? "X"
          : p.startsWith("2") || /away/i.test(p) ? "2"
          : null;
        if (pickedSide) out["1x2"] = pickedSide === result;
        break;
      }
      case "ou_25":
        out["ou_25"] =
          (pick.startsWith("Over") && totalGoals > 2.5) ||
          (pick.startsWith("Under") && totalGoals < 2.5);
        break;
      case "ou_15":
        out["ou_15"] =
          (pick.startsWith("Over") && totalGoals > 1.5) ||
          (pick.startsWith("Under") && totalGoals < 1.5);
        break;
      case "btts": {
        const btts = finalHome > 0 && finalAway > 0;
        out["btts"] =
          (pick === "Yes" && btts) || (pick === "No" && !btts);
        break;
      }
      case "double_chance":
        out["double_chance"] =
          (pick.includes("1X") && (result === "1" || result === "X")) ||
          (pick.includes("12") && (result === "1" || result === "2")) ||
          (pick.includes("X2") && (result === "X" || result === "2"));
        break;
      case "dnb": {
        if (result === "X") break; // push — exclude from sample
        // Pick labels: "Home (DNB)" / "Away (DNB)".
        const isHome = /home/i.test(pick);
        const isAway = /away/i.test(pick);
        if (isHome) out["dnb"] = result === "1";
        else if (isAway) out["dnb"] = result === "2";
        break;
      }
      case "home_to_score": {
        const yes = finalHome > 0;
        out["home_to_score"] =
          (pick === "Yes" && yes) || (pick === "No" && !yes);
        break;
      }
      case "away_to_score": {
        const yes = finalAway > 0;
        out["away_to_score"] =
          (pick === "Yes" && yes) || (pick === "No" && !yes);
        break;
      }
      case "ah": {
        // Asian handicap on the home team. line is the handicap applied to home.
        // pick label is e.g. "Home -0.5" or "Away +0.5".
        const line = typeof m.line === "number" ? m.line : 0;
        const adjHome = finalHome + line;
        if (adjHome === finalAway) break; // push
        const homeCovers = adjHome > finalAway;
        out["ah"] =
          (pick.startsWith("Home") && homeCovers) ||
          (pick.startsWith("Away") && !homeCovers);
        break;
      }
      // cards/corners/shots: cannot grade without play-by-play stats
      default:
        break;
    }
  }
  return out;
}

const MARKET_LABELS: Record<string, string> = {
  "1x2": "Match Result (1X2)",
  ou_25: "Over/Under 2.5 Goals",
  ou_15: "Over/Under 1.5 Goals",
  btts: "Both Teams To Score",
  double_chance: "Double Chance",
  dnb: "Draw No Bet",
  ah: "Asian Handicap",
  home_to_score: "Home to Score",
  away_to_score: "Away to Score",
};

export const getStats = createServerFn({ method: "POST" })
  .inputValidator((input: { days?: number } | undefined) => input ?? {})
  .handler(async ({ data }): Promise<StatsResponse> => {
    const windowDays = Math.max(1, Math.min(30, data.days ?? 7));
    try {
      const supabase = adminClient();
      // 1. Finished matches in window
      const finished = await fetchFinishedFixtures(windowDays);
      if (finished.length === 0) {
        return {
          windowDays,
          totalMatchesGraded: 0,
          perMarket: [],
          bestPick: { market: "best", label: "Best Pick", hits: 0, total: 0, hitRate: 0, byMarket: [] },
          error: null,
        };
      }

      // 2. Pull cached predictions for these match ids
      const ids = finished.map((f) => f.id);
      // Supabase 'in' has practical URL-length limits; chunk into 200-id batches.
      const cacheMap = new Map<number, { match: MatchSummary; predictions: MatchPredictions }>();
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const { data: rows } = await supabase
          .from("predictions_cache")
          .select("match_id, payload")
          .in("match_id", chunk);
        for (const r of rows ?? []) {
          cacheMap.set(
            r.match_id as number,
            r.payload as unknown as { match: MatchSummary; predictions: MatchPredictions },
          );
        }
      }

      // 3. Grade each
      const tally: Record<string, { hits: number; total: number }> = {};
      const bestByMarket: Record<string, { hits: number; total: number }> = {};
      let bestHits = 0;
      let bestTotal = 0;
      let graded = 0;

      for (const f of finished) {
        const cached = cacheMap.get(f.id);
        if (!cached) continue;
        if (!cached.predictions.homeForm || !cached.predictions.awayForm) continue;
        const fh = f.score.fullTime.home;
        const fa = f.score.fullTime.away;
        if (fh == null || fa == null) continue;
        graded++;

        const results = gradePredictions(cached.predictions, fh, fa);
        for (const [k, won] of Object.entries(results)) {
          if (!tally[k]) tally[k] = { hits: 0, total: 0 };
          tally[k].total++;
          if (won) tally[k].hits++;
        }

        // Best pick: highest-probability candidate among 1x2 / ou_25 / btts
        const ext = extractMarkets(cached.predictions);
        if (ext.best) {
          const bm = ext.best.market;
          const won = results[bm];
          if (typeof won === "boolean") {
            bestTotal++;
            if (won) bestHits++;
            if (!bestByMarket[bm]) bestByMarket[bm] = { hits: 0, total: 0 };
            bestByMarket[bm].total++;
            if (won) bestByMarket[bm].hits++;
          }
        }
      }

      const perMarket: MarketStat[] = Object.entries(tally)
        .map(([market, v]) => ({
          market,
          label: MARKET_LABELS[market] ?? market,
          hits: v.hits,
          total: v.total,
          hitRate: v.total > 0 ? +((v.hits / v.total) * 100).toFixed(1) : 0,
        }))
        .sort((a, b) => b.total - a.total);

      const byMarket: MarketStat[] = Object.entries(bestByMarket)
        .map(([market, v]) => ({
          market,
          label: MARKET_LABELS[market] ?? market,
          hits: v.hits,
          total: v.total,
          hitRate: v.total > 0 ? +((v.hits / v.total) * 100).toFixed(1) : 0,
        }))
        .sort((a, b) => b.total - a.total);

      return {
        windowDays,
        totalMatchesGraded: graded,
        perMarket,
        bestPick: {
          market: "best",
          label: "Best Pick (model top choice)",
          hits: bestHits,
          total: bestTotal,
          hitRate: bestTotal > 0 ? +((bestHits / bestTotal) * 100).toFixed(1) : 0,
          byMarket,
        },
        error: null,
      };
    } catch (e) {
      console.error("getStats failed", e);
      return {
        windowDays,
        totalMatchesGraded: 0,
        perMarket: [],
        bestPick: { market: "best", label: "Best Pick", hits: 0, total: 0, hitRate: 0, byMarket: [] },
        error: e instanceof Error ? e.message : "Failed to load stats",
      };
    }
  });

// ---------------------------------------------------------------------------
// Live scores: in-play fixtures currently being played
// ---------------------------------------------------------------------------

export const getLiveScores = createServerFn({ method: "GET" })
  .handler(async (): Promise<{ scores: LiveScore[]; error: string | null }> => {
    try {
      const scores = await fetchLiveScores();
      return { scores, error: null };
    } catch (e) {
      console.error("getLiveScores failed", e);
      return {
        scores: [],
        error: e instanceof Error ? e.message : "Failed to load live scores",
      };
    }
  });

// ---------------------------------------------------------------------------
// Pre-match xG lookup for live in-play probability calculations.
// Pure DB read of `predictions_cache` — costs zero football-API credits.
// ---------------------------------------------------------------------------

export const getCachedPreMatchXg = createServerFn({ method: "POST" })
  .inputValidator((input: { matchIds: number[] }) => input)
  .handler(async ({ data }) => {
    if (!data.matchIds || data.matchIds.length === 0) {
      return { xg: {} as Record<number, { home: number; away: number }>, error: null };
    }
    try {
      const supabase = adminClient();
      const ids = Array.from(new Set(data.matchIds.map((n) => Number(n)))).slice(0, 100);
      const { data: rows, error } = await supabase
        .from("predictions_cache")
        .select("match_id, payload")
        .in("match_id", ids);
      if (error) throw error;
      const out: Record<number, { home: number; away: number }> = {};
      for (const row of rows ?? []) {
        const p = (row as { payload?: { predictions?: { expectedGoalsHome?: number; expectedGoalsAway?: number } } }).payload;
        const xgH = p?.predictions?.expectedGoalsHome;
        const xgA = p?.predictions?.expectedGoalsAway;
        if (typeof xgH === "number" && typeof xgA === "number") {
          out[Number((row as { match_id: number }).match_id)] = { home: xgH, away: xgA };
        }
      }
      return { xg: out, error: null as string | null };
    } catch (e) {
      console.error("getCachedPreMatchXg failed", e);
      return { xg: {} as Record<number, { home: number; away: number }>, error: e instanceof Error ? e.message : "Failed" };
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Model accuracy: graded entirely from the predictions_cache.
// Each cached row stores both the prediction and the final match (when FT).
// We replay each prediction's "pick" against the actual final score and
// produce per-market hit-rates. Zero external API calls.
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketAccuracy {
  market: string;
  label: string;
  total: number;
  hits: number;
  hitRate: number; // 0..100
  avgConfidence: number; // 0..100
}

export interface AccuracyResponse {
  totalMatches: number;
  totalPicks: number;
  totalHits: number;
  overallHitRate: number;
  markets: MarketAccuracy[];
  recent: Array<{
    matchId: number;
    home: string;
    away: string;
    competition: string | null;
    finalScore: string;
    utcDate: string;
    pickHits: number;
    pickTotal: number;
  }>;
  calibration: Array<{
    bucket: string; // e.g. "70-80%"
    min: number; // 0..100 inclusive
    max: number; // 0..100 exclusive (last bucket inclusive)
    avgConfidence: number; // mean predicted probability inside bucket (0..100)
    hitRate: number; // actual hit-rate (0..100)
    hits: number;
    total: number;
  }>;
  error: string | null;
}

function gradePick(
  market: string,
  pick: string,
  homeGoals: number,
  awayGoals: number,
): boolean | null {
  const total = homeGoals + awayGoals;
  const homeWin = homeGoals > awayGoals;
  const draw = homeGoals === awayGoals;
  const awayWin = awayGoals > homeGoals;
  const btts = homeGoals > 0 && awayGoals > 0;

  switch (market) {
    case "1x2": {
      if (pick.startsWith("1")) return homeWin;
      if (pick.startsWith("X")) return draw;
      if (pick.startsWith("2")) return awayWin;
      return null;
    }
    case "ou_15":
      return pick.toLowerCase().startsWith("over") ? total > 1.5 : total < 1.5;
    case "ou_25":
      return pick.toLowerCase().startsWith("over") ? total > 2.5 : total < 2.5;
    case "btts":
      return pick.toLowerCase() === "yes" ? btts : !btts;
    case "home_to_score":
      return pick.toLowerCase() === "yes" ? homeGoals > 0 : homeGoals === 0;
    case "away_to_score":
      return pick.toLowerCase() === "yes" ? awayGoals > 0 : awayGoals === 0;
    case "double_chance": {
      if (pick.startsWith("1X")) return homeWin || draw;
      if (pick.startsWith("X2")) return awayWin || draw;
      if (pick.startsWith("12")) return homeWin || awayWin;
      return null;
    }
    case "dnb": {
      if (draw) return null; // push — exclude from accuracy
      if (pick.toLowerCase().includes("home")) return homeWin;
      if (pick.toLowerCase().includes("away")) return awayWin;
      return null;
    }
    // corners / shots / cards aren't gradable from the score alone.
    default:
      return null;
  }
}

const ACCURACY_MARKET_LABELS: Record<string, string> = {
  "1x2": "Match Result (1X2)",
  ou_15: "Over/Under 1.5",
  ou_25: "Over/Under 2.5",
  btts: "Both Teams To Score",
  home_to_score: "Home Team to Score",
  away_to_score: "Away Team to Score",
  double_chance: "Double Chance",
  dnb: "Draw No Bet",
};

export const getModelAccuracy = createServerFn({ method: "GET" }).handler(
  async (): Promise<AccuracyResponse> => {
    try {
      const sb = adminClient();
      const { data, error } = await sb
        .from("predictions_cache")
        .select("match_id, payload, updated_at")
        .order("updated_at", { ascending: false })
        .limit(500);
      if (error) throw error;

      const buckets = new Map<string, { hits: number; total: number; conf: number }>();
      const recent: AccuracyResponse["recent"] = [];
      // Calibration buckets in 10% steps from 0..100
      const CAL_STEP = 10;
      const calBuckets = Array.from({ length: 10 }, (_, i) => ({
        min: i * CAL_STEP,
        max: (i + 1) * CAL_STEP,
        hits: 0,
        total: 0,
        confSum: 0,
      }));
      let totalMatches = 0;
      let totalPicks = 0;
      let totalHits = 0;

      for (const row of data ?? []) {
        const payload = row.payload as {
          match?: {
            id?: number;
            status?: string;
            utcDate?: string;
            score?: { fullTime?: { home: number | null; away: number | null } };
            homeTeam?: { name?: string };
            awayTeam?: { name?: string };
            competition?: { name?: string | null };
          };
          predictions?: {
            markets?: Array<{
              market: string;
              pick: string;
              probabilities: Record<string, number>;
            }>;
          };
        };

        const match = payload?.match;
        if (!match || match.status !== "FT") continue;
        const h = match.score?.fullTime?.home;
        const a = match.score?.fullTime?.away;
        if (h == null || a == null) continue;

        totalMatches++;
        let matchHits = 0;
        let matchPicks = 0;

        for (const m of payload.predictions?.markets ?? []) {
          if (!ACCURACY_MARKET_LABELS[m.market]) continue;
          const result = gradePick(m.market, m.pick, h, a);
          if (result === null) continue; // ungradable / push
          const conf = m.probabilities?.[Object.keys(m.probabilities).find(
            (k) => m.pick.startsWith(k),
          ) ?? ""] ?? Math.max(...Object.values(m.probabilities ?? {}), 0);

          const b = buckets.get(m.market) ?? { hits: 0, total: 0, conf: 0 };
          b.total++;
          b.conf += conf;
          if (result) b.hits++;
          buckets.set(m.market, b);

          // Bucket by predicted probability (conf is 0..1 from probabilities map)
          const confPct = conf <= 1 ? conf * 100 : conf;
          const idx = Math.min(9, Math.max(0, Math.floor(confPct / CAL_STEP)));
          calBuckets[idx].total++;
          calBuckets[idx].confSum += confPct;
          if (result) calBuckets[idx].hits++;

          totalPicks++;
          matchPicks++;
          if (result) {
            totalHits++;
            matchHits++;
          }
        }

        if (recent.length < 20 && matchPicks > 0) {
          recent.push({
            matchId: match.id ?? row.match_id,
            home: match.homeTeam?.name ?? "Home",
            away: match.awayTeam?.name ?? "Away",
            competition: match.competition?.name ?? null,
            finalScore: `${h}-${a}`,
            utcDate: match.utcDate ?? "",
            pickHits: matchHits,
            pickTotal: matchPicks,
          });
        }
      }

      const markets: MarketAccuracy[] = Array.from(buckets.entries())
        .map(([market, v]) => ({
          market,
          label: ACCURACY_MARKET_LABELS[market] ?? market,
          total: v.total,
          hits: v.hits,
          hitRate: v.total > 0 ? (v.hits / v.total) * 100 : 0,
          avgConfidence: v.total > 0 ? v.conf / v.total : 0,
        }))
        .sort((a, b) => b.total - a.total);

      return {
        totalMatches,
        totalPicks,
        totalHits,
        overallHitRate: totalPicks > 0 ? (totalHits / totalPicks) * 100 : 0,
        markets,
        recent,
        calibration: calBuckets.map((b) => ({
          bucket: `${b.min}-${b.max}%`,
          min: b.min,
          max: b.max,
          avgConfidence: b.total > 0 ? b.confSum / b.total : (b.min + b.max) / 2,
          hitRate: b.total > 0 ? (b.hits / b.total) * 100 : 0,
          hits: b.hits,
          total: b.total,
        })),
        error: null,
      };
    } catch (e) {
      console.error("getModelAccuracy failed", e);
      return {
        totalMatches: 0,
        totalPicks: 0,
        totalHits: 0,
        overallHitRate: 0,
        markets: [],
        recent: [],
        calibration: [],
        error: e instanceof Error ? e.message : "Failed to compute accuracy",
      };
    }
  },
);

// ============================================================================
// The Odds API — pre-match live odds for value/edge detection.
// ============================================================================

import { fetchMatchLiveOdds, getOddsApiUsage, type MatchOddsResult } from "./oddsData.server";

export type { MatchOddsResult, BookmakerPrice, MarketOddsRow } from "./oddsData.server";

export const fetchMatchOdds = createServerFn({ method: "POST" })
  .inputValidator((input: { matchId: number; userId: string; forceRefresh?: boolean }) => input)
  .handler(async ({ data }): Promise<MatchOddsResult> => {
    const supabase = adminClient();
    // Load the match (from cache or live) to get team names for matching
    const { data: cached } = await supabase
      .from("predictions_cache")
      .select("payload")
      .eq("match_id", data.matchId)
      .maybeSingle();
    let match: MatchSummary | null =
      (cached?.payload as { match?: MatchSummary } | null)?.match ?? null;
    if (!match) {
      try {
        match = await fetchMatch(data.matchId);
      } catch {
        match = null;
      }
    }
    if (!match) {
      return {
        matchId: data.matchId,
        rows: [],
        cacheHit: false,
        creditsUsed: 0,
        fetchedAt: new Date().toISOString(),
        error: "Match not found",
      };
    }
    return await fetchMatchLiveOdds({
      match,
      userId: data.userId,
      forceRefresh: data.forceRefresh,
    });
  });

export const getOddsUsage = createServerFn({ method: "POST" })
  .inputValidator((input: { userId: string }) => input)
  .handler(async ({ data }) => {
    return await getOddsApiUsage(data.userId);
  });
