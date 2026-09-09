// The filings series (PRD §4.2): every org lands with its 990 history so
// Fit, diagnostics, and the FYE curve compute from stored rows. Same
// mapping as catsnake-prospect/scripts/backfill-filings.ts; the stocker
// writes it for every org it lands and refreshes stale orgs nightly.

const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

export function filingsFromDetail(detail: any) {
  return ((detail?.filings_with_data || []) as any[]).map((f) => ({
    tax_period: Number(f.tax_prd), tax_year: f.tax_prd_yr != null ? Number(f.tax_prd_yr) : null,
    form_type: f.formtype != null ? String(f.formtype) : null,
    total_revenue: num(f.totrevenue), contributions: num(f.totcntrbgfts), program_revenue: num(f.totprgmrevnue),
    total_expenses: num(f.totfuncexpns), net_assets: num(f.totnetassetend), total_assets: num(f.totassetsend),
    prof_fundraising_fees: num(f.profndraising), fundraising_event_gross: num(f.grsincfndrsng), fundraising_event_direct: num(f.lessdirfndrsng),
    officer_comp: num(f.compnsatncurrofcr), other_salaries: num(f.othrsalwages), source_url: f.pdf_url || null,
  })).filter((r) => Number.isFinite(r.tax_period));
}

export function fyeMonthFromDetail(detail: any): number | null {
  const ap = Number(detail?.organization?.accounting_period);
  if (ap >= 1 && ap <= 12) return ap;
  const tp = detail?.organization?.tax_period;
  if (typeof tp === 'string' && /^\d{4}-\d{2}/.test(tp)) return Number(tp.slice(5, 7));
  const f = (detail?.filings_with_data || [])[0];
  if (f && f.tax_prd) { const m = Number(String(f.tax_prd).slice(4, 6)); if (m >= 1 && m <= 12) return m; }
  return null;
}

// PostgREST upsert helpers used by stock.ts (service role, merge on conflict)
export async function upsertOrgAndFilings(api: (method: string, path: string, body?: unknown, prefer?: string) => Promise<any>,
  apiGet: (path: string) => Promise<any>, detail: any, ein9: string, name: string, state: string, ntee: string) {
  const fye = fyeMonthFromDetail(detail);
  // orgs: one per EIN (unique); pick up the id whether new or existing
  await api('POST', 'orgs?on_conflict=ein', [{ ein: ein9, name, state, ntee, fye_month: fye, filings_fetched_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
  const rows = await apiGet(`orgs?ein=eq.${ein9}&select=id`);
  const orgId = rows?.[0]?.id;
  if (!orgId) return null;
  const filings = filingsFromDetail(detail).map((r) => ({ org_id: orgId, ...r }));
  if (filings.length) await api('POST', 'filings?on_conflict=org_id,tax_period', filings, 'resolution=merge-duplicates,return=minimal');
  return orgId;
}
