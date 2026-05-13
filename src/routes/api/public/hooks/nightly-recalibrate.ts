import { createFileRoute } from "@tanstack/react-router";
import { nightlyRecalibrateAll } from "@/server/leagueCalibration.server";

/**
 * Public cron endpoint. Called nightly by pg_cron via net.http_post. No auth
 * needed beyond the /api/public/* prefix; the work it does (DB upserts on
 * server-only tables) is gated by RLS already.
 */
export const Route = createFileRoute("/api/public/hooks/nightly-recalibrate")({
  server: {
    handlers: {
      POST: async () => {
        const result = await nightlyRecalibrateAll();
        return Response.json(result, { status: result.failed > 0 && result.ran === 0 ? 500 : 200 });
      },
      GET: async () => {
        const result = await nightlyRecalibrateAll();
        return Response.json(result, { status: result.failed > 0 && result.ran === 0 ? 500 : 200 });
      },
    },
  },
});