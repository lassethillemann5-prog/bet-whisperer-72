## Mål
Få Odds API'et (The Odds API) til automatisk at hente odds én gang om dagen, så du ikke skal trykke "Fetch odds" manuelt for hver kamp.

## Hvad der allerede findes
- `src/server/oddsData.server.ts` har funktionen `fetchDailyOddsSnapshot()` som henter ALLE soccer-events i ét kald (~30 credits) og cacher dem i 26 timer.
- Der findes et public endpoint: `src/routes/api/public/hooks/daily-odds-snapshot.ts` (POST/GET) som kalder den.
- Når en kamp åbnes i UI'et, læses fra cachen først → 0 ekstra credits per kamp.

→ Hele infrastrukturen er der. Det eneste der mangler er en **scheduler** der kalder endpointet automatisk.

## Plan: aktivér pg_cron til at kalde endpointet dagligt

### Trin 1 — aktivér extensions (hvis ikke allerede)
`pg_cron` og `pg_net` på databasen.

### Trin 2 — opret cron-job
Schedulerer et dagligt POST-kald kl. 07:00 UTC (≈ tidligt om morgenen, før dagens kampe) til:

```
https://bet-whisperer-72.lovable.app/api/public/hooks/daily-odds-snapshot
```

med `apikey`-header (anon key). Forventet forbrug: ~30 Odds API credits/dag = ~900/måned (inden for free tier på 500/måned hvis vi reducerer, ellers paid).

### Trin 3 — verificér
Efter første natlige kørsel kan vi tjekke `fixtures_cache` for `cache_key = 'odds-daily-snapshot'` og se `updated_at`.

## Ting jeg vil bekræfte med dig først

1. **Tidspunkt**: 07:00 UTC (08:00 dansk vintertid / 09:00 sommertid) lyder fornuftigt — eller foretrækker du fx midnat eller eftermiddag?
2. **Frekvens**: Én gang dagligt nok? (Odds bevæger sig — to gange dagligt fordobler credit-forbruget men giver friskere priser tæt på kickoff.)
3. **Credit-budget**: The Odds API free tier er 500 credits/måned. Daglig snapshot = ~900/md. Skal jeg:
   - (a) køre dagligt og du opgraderer til paid plan, eller
   - (b) køre kun hver 2. dag (~450/md, indenfor free), eller
   - (c) køre dagligt men kun for udvalgte ligaer (kræver kodeændring)?

Når du svarer på de tre, opretter jeg cron-jobbet.

## Teknisk note
SQL-jobbet bliver indsat via `supabase--insert` (ikke migration), fordi det indeholder din anon-key og kun skal køre én gang.
