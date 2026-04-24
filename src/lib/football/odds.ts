import { supabase } from "@/integrations/supabase/client";
import type { MarketKey } from "./types";

export interface OddsRow {
  id: string;
  user_id: string;
  match_id: number;
  market: MarketKey;
  selection: string;
  decimal_odds: number;
  bookmaker: string | null;
  line: number | null;
  created_at: string;
  updated_at: string;
}

export async function listOddsForMatch(userId: string, matchId: number): Promise<OddsRow[]> {
  const { data, error } = await supabase
    .from("match_odds")
    .select("*")
    .eq("user_id", userId)
    .eq("match_id", matchId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as OddsRow[];
}

export async function listAllOdds(userId: string): Promise<OddsRow[]> {
  const { data, error } = await supabase
    .from("match_odds")
    .select("*")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []) as unknown as OddsRow[];
}

export async function upsertOdds(input: {
  userId: string;
  matchId: number;
  market: MarketKey;
  selection: string;
  decimalOdds: number;
  bookmaker?: string | null;
  line?: number | null;
}) {
  const { error } = await supabase.from("match_odds").upsert(
    {
      user_id: input.userId,
      match_id: input.matchId,
      market: input.market,
      selection: input.selection,
      decimal_odds: input.decimalOdds,
      bookmaker: input.bookmaker ?? null,
      line: input.line ?? null,
    },
    { onConflict: "user_id,match_id,market,selection" },
  );
  if (error) throw error;
}

export async function deleteOdds(userId: string, id: string) {
  const { error } = await supabase
    .from("match_odds")
    .delete()
    .eq("user_id", userId)
    .eq("id", id);
  if (error) throw error;
}
