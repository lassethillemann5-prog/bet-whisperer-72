import { BUILDER_LEGS, type BuilderLegId } from "@/lib/football/predictor";
import type { BuilderLegMeta } from "@/lib/football/predictor";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

export type RiskLevel = "safe" | "balanced" | "longshot";

interface AiBuilderInput {
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  expectedGoalsHome: number;
  expectedGoalsAway: number;
  legProbabilities: Record<BuilderLegId, number>;
  riskLevel: RiskLevel;
  /** Optional restriction — if provided, AI may only choose legs whose
   *  group is in this set. Empty/undefined means "all groups allowed". */
  allowedGroups?: BuilderLegMeta["group"][];
}

export interface AiBuilderResult {
  legs: BuilderLegId[];
  rationale: string;
  error: string | null;
}

const RISK_GUIDE: Record<RiskLevel, string> = {
  safe: "Aim for a JOINT probability between 45% and 65% (fair odds ~1.5–2.2). Prefer high-individual-probability legs and double-chance/under-style picks. Use 2–3 legs.",
  balanced: "Aim for a JOINT probability between 22% and 38% (fair odds ~2.6–4.5). Mix one strong anchor with one or two value picks. Use 3–4 legs.",
  longshot: "Aim for a JOINT probability between 8% and 18% (fair odds ~5.5–12). Combine bold but plausible picks with positive correlation (e.g. Home win + Over 2.5 + BTTS Yes). Use 4–5 legs.",
};

const VALID_IDS = new Set<string>(BUILDER_LEGS.map((l) => l.id));

export async function generateAiBetBuilder(input: AiBuilderInput): Promise<AiBuilderResult> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    return { legs: [], rationale: "", error: "AI unavailable — Lovable AI key not configured." };
  }

  const allowedGroupSet =
    input.allowedGroups && input.allowedGroups.length > 0
      ? new Set(input.allowedGroups)
      : null;
  const filteredLegs = allowedGroupSet
    ? BUILDER_LEGS.filter((l) => allowedGroupSet.has(l.group))
    : BUILDER_LEGS;
  if (filteredLegs.length < 2) {
    return { legs: [], rationale: "", error: "Pick at least 2 market groups for the AI to combine." };
  }
  const legCatalog = filteredLegs.map((l) => ({
    id: l.id,
    market: l.marketLabel,
    selection: l.selectionLabel,
    group: l.group,
    modelProbability: input.legProbabilities[l.id] ?? null,
  }));

  const systemPrompt = `You are an expert football betting analyst building a same-game multi (bet builder).

You will receive: match context, expected goals, and a catalog of available legs each annotated with its individual model probability (0-100%).

Hard rules:
- Pick 2 to 5 legs total.
- NEVER pick two legs from the same "group" (e.g. you cannot pick both "1" and "X" because both are in the "result" group).
- Only use leg IDs from the provided catalog — no invented markets.
- Prefer combinations with positive correlation when chasing value (Home win pairs naturally with Over 2.5 and BTTS Yes; Away win with BTTS Yes; Draw with Under 2.5).
- Avoid contradictory picks (e.g. Over 2.5 + Under 1.5).

Respond by calling the build_bet function with your chosen legs and a 2-3 sentence rationale (plain text, no markdown).`;

  const userPrompt = `Match: ${input.homeTeam} vs ${input.awayTeam}${input.competition ? ` (${input.competition})` : ""}
Expected goals: ${input.expectedGoalsHome.toFixed(2)} - ${input.expectedGoalsAway.toFixed(2)}
Risk level: ${input.riskLevel.toUpperCase()} — ${RISK_GUIDE[input.riskLevel]}

Available legs:
${JSON.stringify(legCatalog, null, 2)}`;

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
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "build_bet",
              description: "Submit the chosen bet builder legs and rationale.",
              parameters: {
                type: "object",
                properties: {
                  legs: {
                    type: "array",
                    description: "Chosen leg IDs from the provided catalog (2-5 items).",
                    items: { type: "string", enum: filteredLegs.map((l) => l.id) },
                    minItems: 2,
                    maxItems: 5,
                  },
                  rationale: {
                    type: "string",
                    description: "2-3 sentence plain-text rationale.",
                  },
                },
                required: ["legs", "rationale"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "build_bet" } },
      }),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("AI builder gateway error", res.status, t.slice(0, 200));
      if (res.status === 429) return { legs: [], rationale: "", error: "AI rate-limited. Try again shortly." };
      if (res.status === 402) return { legs: [], rationale: "", error: "AI credits exhausted." };
      return { legs: [], rationale: "", error: "AI generator unavailable right now." };
    }

    const json = (await res.json()) as {
      choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
    };
    const argsStr = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argsStr) {
      return { legs: [], rationale: "", error: "AI returned no selection." };
    }
    const parsed = JSON.parse(argsStr) as { legs?: string[]; rationale?: string };
    const rawLegs = Array.isArray(parsed.legs) ? parsed.legs : [];

    // Validate + dedupe by group (keep first per group, drop unknowns)
    const seenGroups = new Set<string>();
    const validatedLegs: BuilderLegId[] = [];
    for (const id of rawLegs) {
      if (!VALID_IDS.has(id)) continue;
      const meta = BUILDER_LEGS.find((l) => l.id === id)!;
      if (seenGroups.has(meta.group)) continue;
      seenGroups.add(meta.group);
      validatedLegs.push(meta.id);
      if (validatedLegs.length >= 5) break;
    }

    if (validatedLegs.length < 2) {
      return { legs: [], rationale: "", error: "AI selection invalid — please retry." };
    }

    return {
      legs: validatedLegs,
      rationale: (parsed.rationale ?? "").trim(),
      error: null,
    };
  } catch (e) {
    console.error("AI bet builder failed", e);
    return { legs: [], rationale: "", error: "AI generator failed." };
  }
}
