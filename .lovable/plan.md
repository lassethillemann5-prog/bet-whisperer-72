## What's happening right now

Your app **already contains** the full tracking + predictions pipeline:

- **Fixtures** (`src/server/football.functions.ts` → `getFixtures`) fetches upcoming matches for the next 3/7/14 days.
- **Tracking** (`src/lib/football/tracked.ts` + `tracked_matches` table with RLS) lets a signed-in user star a match and see it on `/tracked`.
- **Predictions** (`src/lib/football/predictor.ts`) runs a Poisson model over recent team form and produces probabilities for **1X2, Over/Under 1.5, Over/Under 2.5, corners, shots, and shots on target**, plus expected goals.
- **AI commentary** (`src/server/aiCommentary.server.ts`) layers a short Gemini-generated analyst note on top, and results are cached for 6h in `predictions_cache`.

But the home page is still showing the error **"Football-Data 400: Your API token is invalid"**. That string no longer exists anywhere in the source — `src/server/footballData.server.ts` was switched to **API-SPORTS v3** (`https://v3.football.api-sports.io`, `x-apisports-key` header) in the previous turn. So the preview is running a **stale build** from before the provider switch.

## Plan

1. **Force a rebuild** by touching `src/server/footballData.server.ts` (a no-op edit such as a comment update) so the preview redeploys with the API-SPORTS adapter.
2. **Invoke `getFixtures` server-side** with `stack_modern--invoke-server-function` and confirm the response contains real matches (not the old Football-Data error).
3. **Pick one returned `matchId`** and invoke `getMatchWithPredictions` to confirm:
   - `match` payload populated
   - `predictions.markets` contains all 6 markets (`1x2`, `ou_15`, `ou_25`, `corners`, `shots`, `shots_on_target`)
   - `predictions.commentary` is generated (Lovable AI key is configured)
   - The result lands in `predictions_cache` (verify with `supabase--read_query`)
4. **Spot-check tracking** by reading `tracked_matches` after I star one from the UI flow (RLS is already in place).
5. If API-SPORTS returns a non-2xx, surface the exact error to you (e.g. wrong plan, missing subscription) so you know whether to adjust the key vs. the endpoint.

## What I will NOT change

- No schema changes — `tracked_matches` and `predictions_cache` are correct.
- No UI changes — fixtures grid, match detail page, and `/tracked` already exist.
- I won't ask for a new API key; the current `FOOTBALL_DATA_API_KEY` secret is your API-SPORTS Pro key and the adapter already sends it via `x-apisports-key`.

After approval I'll run the rebuild + the two server-function probes and report back with concrete numbers (fixture count, sample match, market probabilities).