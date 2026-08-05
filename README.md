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
Optional env: METRO="New York" CAP=100
