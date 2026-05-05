import { createFileRoute } from "@tanstack/react-router";
import { fetchDailyOddsSnapshot } from "@/server/oddsData.server";

export const Route = createFileRoute("/api/public/hooks/daily-odds-snapshot")({
  server: {
    handlers: {
      POST: async () => {
        const result = await fetchDailyOddsSnapshot();
        return Response.json(result, { status: result.ok ? 200 : 500 });
      },
      GET: async () => {
        const result = await fetchDailyOddsSnapshot();
        return Response.json(result, { status: result.ok ? 200 : 500 });
      },
    },
  },
});