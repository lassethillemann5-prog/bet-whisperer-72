import { createServerFn } from "@tanstack/react-start";
import {
  fetchHeadToHead,
  fetchMatch,
  fetchRecentMatches,
  fetchTeamForm,
  fetchUpcomingMatches,
} from "./footballData.server";
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

export interface TodayPickRow {
  match: MatchSummary;
  // Each market entry: selection -> probability (0-100)
  oneXTwo: { home: number; draw: number; away: number; pick: string } | null;
  ou25: { over: number; under: number; pick: string } | null;
  btts: { yes: number; no: number; pick: string } | null;
  best: { market: string; selection: string; label: string; probability: number } | null;
  cached: boolean;
}

function extractMarkets(predictions: MatchPredictions): {
  oneXTwo: TodayPickRow["oneXTwo"];
  ou25: TodayPickRow["ou25"];
  btts: TodayPickRow["btts"];
  best: TodayPickRow["best"];
} {
  const m1x2 = predictions.markets.find((m) => m.market === "1x2");
  const mou25 = predictions.markets.find((m) => m.market === "ou_25");
  const mbtts = predictions.markets.find((m) => m.market === "btts");

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

  return { oneXTwo, ou25, btts, best };
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
      const computeBudget = data.computeBudget ?? 6;
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

      const cacheMap = new Map<number, { payload: { match: MatchSummary; predictions: MatchPredictions }; fresh: boolean }>();
      for (const row of cachedRows ?? []) {
        const fresh = row.updated_at
          ? Date.now() - new Date(row.updated_at).getTime() < CACHE_TTL_MS
          : false;
        cacheMap.set(row.match_id as number, {
          payload: row.payload as unknown as { match: MatchSummary; predictions: MatchPredictions },
          fresh,
        });
      }

      // 3. Identify fixtures missing fresh predictions
      const missing = fixtures.filter((f) => {
        const c = cacheMap.get(f.id);
        return !c || !c.fresh;
      });

      // 4. Compute up to computeBudget fresh predictions in parallel
      const toCompute = missing.slice(0, computeBudget);
      const computed = await Promise.allSettled(
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
            // Best-effort cache write
            try {
              await supabase.from("predictions_cache").upsert({
                match_id: f.id,
                payload: payload as unknown,
                updated_at: new Date().toISOString(),
              });
            } catch (e) {
              console.warn("today cache write skipped", e);
            }
            cacheMap.set(f.id, { payload, fresh: true });
            return f.id;
          } catch (e) {
            console.warn("today predict failed for", f.id, e);
            return null;
          }
        }),
      );
      const computedCount = computed.filter((r) => r.status === "fulfilled" && r.value).length;

      // 5. Build rows
      const rows: TodayPickRow[] = fixtures.map((f) => {
        const cached = cacheMap.get(f.id);
        if (!cached) {
          return {
            match: f,
            oneXTwo: null,
            ou25: null,
            btts: null,
            best: null,
            cached: false,
          };
        }
        const ext = extractMarkets(cached.payload.predictions);
        return {
          match: f,
          ...ext,
          cached: true,
        };
      });

      const stillMissing = rows.filter((r) => !r.cached).length;
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

export type CoachMarket = "any" | "1x2" | "ou_25" | "btts";

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