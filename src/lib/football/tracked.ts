import { supabase } from "@/integrations/supabase/client";

export interface TrackedRow {
  id: string;
  user_id: string;
  match_id: number;
  competition: string | null;
  home_team: string;
  away_team: string;
  utc_date: string;
  created_at: string;
}

export async function listTracked(userId: string): Promise<TrackedRow[]> {
  const { data, error } = await supabase
    .from("tracked_matches")
    .select("*")
    .eq("user_id", userId)
    .order("utc_date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as TrackedRow[];
}

export async function trackMatch(input: {
  userId: string;
  matchId: number;
  competition: string | null;
  homeTeam: string;
  awayTeam: string;
  utcDate: string;
}) {
  const { error } = await supabase.from("tracked_matches").upsert(
    {
      user_id: input.userId,
      match_id: input.matchId,
      competition: input.competition,
      home_team: input.homeTeam,
      away_team: input.awayTeam,
      utc_date: input.utcDate,
    },
    { onConflict: "user_id,match_id" },
  );
  if (error) throw error;
}

export async function untrackMatch(userId: string, matchId: number) {
  const { error } = await supabase
    .from("tracked_matches")
    .delete()
    .eq("user_id", userId)
    .eq("match_id", matchId);
  if (error) throw error;
}
