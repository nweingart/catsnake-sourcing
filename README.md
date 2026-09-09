# catsnake-sourcing

Nightly stocking runner for the Catsnake Prospect sourcing pool. Reads the
`coverage` queue (metro priorities and focus emphasis, steered from the CRM's
Sourcing panel), harvests ~100 new nonprofit organizations per night from
public IRS 990 data via the ProPublica Nonprofit Explorer API, applies the
cause/size/donation gates and fit scoring, and upserts results into the pool.

Public because the compute is free and the data is public. Credentials live
in GitHub Actions secrets (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY), never
in this repo.

Manual run: `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx stock.ts`
Optional env: METRO="New York" CAP=50 DEADLINE_MIN=95

## How a night runs (since 2026-09-09)

- **Which metro:** the `coverage` row with status `stocking` and the oldest
  `last_pull_at` (New York, Washington DC, Cleveland, Boston rotate). A
  `stock_jobs` row with status `active` still takes precedence, but the
  wizard that created those is retired; none should exist.
- **How many:** `CAP` (default 50).
- **How long:** discovery and scoring stop at `DEADLINE_MIN` (default 95)
  and the run lands whatever it has, marked done with a "partial haul" note.
  The Action's 120-minute timeout should never fire again. Any run still
  marked running after three hours is reaped to failed at the start of the
  next run.
- **Why it is fast enough:** `.cache/orgs` (ProPublica detail responses) is
  persisted between runs by actions/cache, so the tens of thousands of
  already-rejected orgs cost nothing to re-check. A cached detail older than
  45 days is refetched so a new filing counts.
- **Territories:** every org lands with a `territory_id` (`src/territory.ts`,
  the 8/27 metro x NTEE partition). Orgs already in the pool without one are
  assigned at the start of each run. A metro the partition does not know gets
  a single `<metro> nonprofits` territory, created dormant.
