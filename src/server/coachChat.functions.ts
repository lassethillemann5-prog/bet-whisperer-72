import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchUpcomingMatches } from "./footballData.server";
import type { MatchPredictions, MatchSummary } from "@/lib/football/types";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MAX_HISTORY = 20;

function adminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface CoachChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CoachChatResponse {
  reply: string;
  error: string | null;
}

interface CompactPick {
  matchId: number;
  competition: string | null;
  kickoff: string;
  home: string;
  away: string;
  best: { market: string; selection: string; probability: number } | null;
  ou25: { over: number; under: number } | null;
  btts: { yes: number; no: number } | null;
  oneXTwo: { home: number; draw: number; away: number } | null;
}

function summarisePredictions(
  match: MatchSummary,
  preds: MatchPredictions,
): CompactPick {
  const m1x2 = preds.markets.find((m) => m.market === "1x2");
  const mou = preds.markets.find((m) => m.market === "ou_25");
  const mb = preds.markets.find((m) => m.market === "btts");

  const candidates: { market: string; selection: string; probability: number }[] = [];
  if (m1x2) {
    candidates.push(
      { market: "1x2", selection: "Home", probability: (m1x2.probabilities["1"] ?? 0) },
      { market: "1x2", selection: "Draw", probability: (m1x2.probabilities["X"] ?? 0) },
      { market: "1x2", selection: "Away", probability: (m1x2.probabilities["2"] ?? 0) },
    );
  }
  if (mou) {
    candidates.push(
      { market: "ou_25", selection: "Over 2.5", probability: mou.probabilities["Over"] ?? 0 },
      { market: "ou_25", selection: "Under 2.5", probability: mou.probabilities["Under"] ?? 0 },
    );
  }
  if (mb) {
    candidates.push(
      { market: "btts", selection: "BTTS Yes", probability: mb.probabilities["Yes"] ?? 0 },
      { market: "btts", selection: "BTTS No", probability: mb.probabilities["No"] ?? 0 },
    );
  }
  candidates.sort((a, b) => b.probability - a.probability);
  const best = candidates[0] ?? null;

  return {
    matchId: match.id,
    competition: match.competition?.name ?? null,
    kickoff: match.utcDate,
    home: match.homeTeam.name,
    away: match.awayTeam.name,
    best: best
      ? {
          market: best.market,
          selection: best.selection,
          probability: Math.round(best.probability),
        }
      : null,
    ou25: mou
      ? {
          over: Math.round(mou.probabilities["Over"] ?? 0),
          under: Math.round(mou.probabilities["Under"] ?? 0),
        }
      : null,
    btts: mb
      ? {
          yes: Math.round(mb.probabilities["Yes"] ?? 0),
          no: Math.round(mb.probabilities["No"] ?? 0),
        }
      : null,
    oneXTwo: m1x2
      ? {
          home: Math.round(m1x2.probabilities["1"] ?? 0),
          draw: Math.round(m1x2.probabilities["X"] ?? 0),
          away: Math.round(m1x2.probabilities["2"] ?? 0),
        }
      : null,
  };
}

/**
 * Build a compact JSON context bundle the model can read in a single turn:
 *  - bankroll status
 *  - user's tracked matches (next 7 days)
 *  - cached predictions for today's & tomorrow's fixtures
 *  - pending bets in the log
 */
async function buildContext(userId: string) {
  const supabase = adminClient();

  // Bankroll
  const { data: bankroll } = await supabase
    .from("bankroll_settings")
    .select("starting_bankroll, current_bankroll, unit_size, currency")
    .eq("user_id", userId)
    .maybeSingle();

  // Tracked matches (next 14 days)
  const { data: tracked } = await supabase
    .from("tracked_matches")
    .select("match_id, home_team, away_team, competition, utc_date")
    .eq("user_id", userId)
    .gte("utc_date", new Date().toISOString())
    .order("utc_date", { ascending: true })
    .limit(30);

  // Pending bets
  const { data: pending } = await supabase
    .from("bet_log")
    .select("home_team, away_team, market, selection, decimal_odds, stake, units, model_probability, utc_date")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("utc_date", { ascending: true })
    .limit(20);

  // Today's & tomorrow's fixtures with cached predictions
  const all = await fetchUpcomingMatches(2).catch(() => [] as MatchSummary[]);
  const now = Date.now();
  const upcoming = all
    .filter((m) => new Date(m.utcDate).getTime() > now)
    .filter((m) => {
      const dt = new Date(m.utcDate).getTime();
      return dt - now < 1000 * 60 * 60 * 36; // next 36h
    });
  const ids = upcoming.map((m) => m.id);

  let picks: CompactPick[] = [];
  if (ids.length > 0) {
    const { data: cached } = await supabase
      .from("predictions_cache")
      .select("match_id, payload")
      .in("match_id", ids);
    const byId = new Map<number, { match: MatchSummary; predictions: MatchPredictions }>();
    for (const row of cached ?? []) {
      const payload = row.payload as { match: MatchSummary; predictions: MatchPredictions } | null;
      if (payload?.match && payload?.predictions) {
        byId.set(row.match_id as number, payload);
      }
    }
    picks = upcoming
      .map((m) => {
        const cached = byId.get(m.id);
        if (!cached) return null;
        return summarisePredictions(cached.match, cached.predictions);
      })
      .filter((x): x is CompactPick => x != null)
      // top 25 by best probability so the prompt stays small
      .sort((a, b) => (b.best?.probability ?? 0) - (a.best?.probability ?? 0))
      .slice(0, 25);
  }

  return {
    nowISO: new Date().toISOString(),
    bankroll: bankroll
      ? {
          currency: bankroll.currency,
          starting: Number(bankroll.starting_bankroll),
          current: Number(bankroll.current_bankroll),
          unitSize: Number(bankroll.unit_size),
        }
      : null,
    tracked: (tracked ?? []).map((t) => ({
      matchId: t.match_id,
      home: t.home_team,
      away: t.away_team,
      competition: t.competition,
      kickoff: t.utc_date,
    })),
    pendingBets: (pending ?? []).map((b) => ({
      match: `${b.home_team} vs ${b.away_team}`,
      market: b.market,
      selection: b.selection,
      odds: Number(b.decimal_odds),
      stake: Number(b.stake),
      units: Number(b.units),
      modelProbability: b.model_probability != null ? Number(b.model_probability) : null,
      kickoff: b.utc_date,
    })),
    upcomingPicks: picks,
  };
}

const SYSTEM_PROMPT = `You are "Coach", a friendly, knowledgeable AI football betting assistant.

Your style: balanced. You suggest a mix of safer and value picks, default to ~50%+ model
confidence, and you are honest about uncertainty. Never pretend a bet is guaranteed.

You have access to:
- The user's bankroll, unit size, and currency
- The matches they are tracking
- Pending bets in their log
- Model probabilities (0-100%) for upcoming matches across 1X2, Over/Under 2.5 and BTTS

Rules:
- Always answer in the same language the user wrote in.
- Use the supplied JSON CONTEXT as your single source of truth for picks and stats.
  If a match is not in the context, say so instead of inventing data.
- When recommending bets, mention model probability and a one-line reason.
- For stake guidance, use confidence tiers on a 0-3 unit scale: <50% skip, 50-60% 0.5u,
  60-70% 1u, 70-80% 2u, 80%+ 3u. Reference unit size only if bankroll is set.
- Be concise: usually 3-6 sentences, or a short bulleted list when listing picks.
- Plain text or simple Markdown (bold, lists). No tables, no disclaimers footers.
- If asked about something outside football betting, politely steer back.`;

export const askCoachChat = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { userId: string; messages: CoachChatMessage[] }) => input,
  )
  .handler(async ({ data }): Promise<CoachChatResponse> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) {
      return { reply: "", error: "Lovable AI key is not configured." };
    }
    if (!data.messages || data.messages.length === 0) {
      return { reply: "", error: "No message provided." };
    }

    let context: Awaited<ReturnType<typeof buildContext>> | null = null;
    try {
      context = await buildContext(data.userId);
    } catch (e) {
      console.warn("coach chat context build failed", e);
    }

    const trimmedHistory = data.messages
      .filter((m) => m.content?.trim().length > 0)
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: `CONTEXT (JSON):\n${JSON.stringify(context, null, 2)}`,
      },
      ...trimmedHistory,
    ];

    try {
      const res = await fetch(GATEWAY, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages,
        }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.error("coach chat AI error", res.status, t.slice(0, 200));
        if (res.status === 429) {
          return { reply: "", error: "Rate limit reached. Please wait a moment and try again." };
        }
        if (res.status === 402) {
          return { reply: "", error: "AI credits exhausted. Add funds in Settings → Workspace → Usage." };
        }
        return { reply: "", error: "AI service is unavailable right now." };
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const reply = json.choices?.[0]?.message?.content?.trim() ?? "";
      if (!reply) return { reply: "", error: "AI returned an empty response." };
      return { reply, error: null };
    } catch (e) {
      console.error("coach chat failed", e);
      return { reply: "", error: "AI service is currently unavailable." };
    }
  });