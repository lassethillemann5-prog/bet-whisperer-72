import type { MatchPredictions, MatchSummary } from "@/lib/football/types";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

export async function generateCommentary(
  match: MatchSummary,
  preds: Omit<MatchPredictions, "commentary" | "matchId" | "generatedAt">,
): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    return "AI commentary unavailable — Lovable AI key not configured.";
  }

  const summary = {
    home: match.homeTeam.name,
    away: match.awayTeam.name,
    competition: match.competition?.name,
    expectedGoals: {
      home: preds.expectedGoalsHome,
      away: preds.expectedGoalsAway,
    },
    homeForm: preds.homeForm,
    awayForm: preds.awayForm,
    markets: preds.markets.map((m) => ({
      market: m.label,
      pick: m.pick,
      probabilities: m.probabilities,
      expected: m.expected,
    })),
  };

  try {
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
              "You are a concise football analyst. Given match context and statistical predictions across multiple markets (1X2, Over/Under 1.5 & 2.5, corners, shots, shots on target), write a tight 3-4 sentence analysis. Mention recent form, the most confident pick, and one risk factor. Plain text, no markdown, no bullet points, no disclaimers.",
          },
          {
            role: "user",
            content: `Match data:\n${JSON.stringify(summary, null, 2)}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("AI gateway error", res.status, t.slice(0, 200));
      if (res.status === 429) return "AI commentary temporarily rate-limited. Please try again shortly.";
      if (res.status === 402) return "AI commentary unavailable — workspace credits exhausted.";
      return "AI commentary unavailable right now.";
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return (
      json.choices?.[0]?.message?.content?.trim() ||
      "AI commentary unavailable right now."
    );
  } catch (e) {
    console.error("AI commentary failed", e);
    return "AI commentary unavailable right now.";
  }
}
