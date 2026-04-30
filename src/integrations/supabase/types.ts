export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      backtest_runs: {
        Row: {
          bets_placed: number | null
          brier_1x2: number | null
          brier_btts: number | null
          brier_ou25: number | null
          competition_id: string | null
          competition_name: string | null
          completed_at: string | null
          created_at: string
          date_from: string
          date_to: string
          dc_rho: number
          error_message: string | null
          hitrate_1x2: number | null
          home_advantage: number
          id: string
          logloss_1x2: number | null
          matches_scored: number
          matches_total: number
          name: string
          results: Json | null
          roi_flat: number | null
          status: string
          temperature: number
          updated_at: string
          user_id: string
          xg_weight: number
        }
        Insert: {
          bets_placed?: number | null
          brier_1x2?: number | null
          brier_btts?: number | null
          brier_ou25?: number | null
          competition_id?: string | null
          competition_name?: string | null
          completed_at?: string | null
          created_at?: string
          date_from: string
          date_to: string
          dc_rho?: number
          error_message?: string | null
          hitrate_1x2?: number | null
          home_advantage?: number
          id?: string
          logloss_1x2?: number | null
          matches_scored?: number
          matches_total?: number
          name?: string
          results?: Json | null
          roi_flat?: number | null
          status?: string
          temperature?: number
          updated_at?: string
          user_id: string
          xg_weight?: number
        }
        Update: {
          bets_placed?: number | null
          brier_1x2?: number | null
          brier_btts?: number | null
          brier_ou25?: number | null
          competition_id?: string | null
          competition_name?: string | null
          completed_at?: string | null
          created_at?: string
          date_from?: string
          date_to?: string
          dc_rho?: number
          error_message?: string | null
          hitrate_1x2?: number | null
          home_advantage?: number
          id?: string
          logloss_1x2?: number | null
          matches_scored?: number
          matches_total?: number
          name?: string
          results?: Json | null
          roi_flat?: number | null
          status?: string
          temperature?: number
          updated_at?: string
          user_id?: string
          xg_weight?: number
        }
        Relationships: []
      }
      bankroll_settings: {
        Row: {
          created_at: string
          currency: string
          current_bankroll: number
          id: string
          starting_bankroll: number
          unit_size: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          currency?: string
          current_bankroll?: number
          id?: string
          starting_bankroll?: number
          unit_size?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          currency?: string
          current_bankroll?: number
          id?: string
          starting_bankroll?: number
          unit_size?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      bet_log: {
        Row: {
          away_team: string | null
          closing_odds: number | null
          closing_odds_captured_at: string | null
          clv_pct: number | null
          competition: string | null
          created_at: string
          decimal_odds: number
          home_team: string | null
          id: string
          market: string
          match_id: number | null
          model_probability: number | null
          notes: string | null
          profit: number
          selection: string
          stake: number
          status: string
          units: number
          updated_at: string
          user_id: string
          utc_date: string | null
        }
        Insert: {
          away_team?: string | null
          closing_odds?: number | null
          closing_odds_captured_at?: string | null
          clv_pct?: number | null
          competition?: string | null
          created_at?: string
          decimal_odds: number
          home_team?: string | null
          id?: string
          market: string
          match_id?: number | null
          model_probability?: number | null
          notes?: string | null
          profit?: number
          selection: string
          stake: number
          status?: string
          units: number
          updated_at?: string
          user_id: string
          utc_date?: string | null
        }
        Update: {
          away_team?: string | null
          closing_odds?: number | null
          closing_odds_captured_at?: string | null
          clv_pct?: number | null
          competition?: string | null
          created_at?: string
          decimal_odds?: number
          home_team?: string | null
          id?: string
          market?: string
          match_id?: number | null
          model_probability?: number | null
          notes?: string | null
          profit?: number
          selection?: string
          stake?: number
          status?: string
          units?: number
          updated_at?: string
          user_id?: string
          utc_date?: string | null
        }
        Relationships: []
      }
      fixtures_cache: {
        Row: {
          cache_key: string
          created_at: string
          payload: Json
          updated_at: string
        }
        Insert: {
          cache_key: string
          created_at?: string
          payload: Json
          updated_at?: string
        }
        Update: {
          cache_key?: string
          created_at?: string
          payload?: Json
          updated_at?: string
        }
        Relationships: []
      }
      odds_api_usage: {
        Row: {
          cache_hit: boolean
          created_at: string
          credits_used: number
          id: string
          market: string
          match_id: number | null
          user_id: string
        }
        Insert: {
          cache_hit?: boolean
          created_at?: string
          credits_used?: number
          id?: string
          market: string
          match_id?: number | null
          user_id: string
        }
        Update: {
          cache_hit?: boolean
          created_at?: string
          credits_used?: number
          id?: string
          market?: string
          match_id?: number | null
          user_id?: string
        }
        Relationships: []
      }
      predictions_cache: {
        Row: {
          created_at: string
          match_id: number
          payload: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          match_id: number
          payload: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          match_id?: number
          payload?: Json
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      team_form_cache: {
        Row: {
          created_at: string
          payload: Json
          team_id: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          payload: Json
          team_id: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          payload?: Json
          team_id?: number
          updated_at?: string
        }
        Relationships: []
      }
      team_injuries_cache: {
        Row: {
          created_at: string
          payload: Json
          team_id: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          payload: Json
          team_id: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          payload?: Json
          team_id?: number
          updated_at?: string
        }
        Relationships: []
      }
      tracked_matches: {
        Row: {
          away_team: string
          competition: string | null
          created_at: string
          home_team: string
          id: string
          match_id: number
          user_id: string
          utc_date: string
        }
        Insert: {
          away_team: string
          competition?: string | null
          created_at?: string
          home_team: string
          id?: string
          match_id: number
          user_id: string
          utc_date: string
        }
        Update: {
          away_team?: string
          competition?: string | null
          created_at?: string
          home_team?: string
          id?: string
          match_id?: number
          user_id?: string
          utc_date?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
