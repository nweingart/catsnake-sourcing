// One night's stocking: pick the top metro from the coverage queue, harvest
// up to CAP new organizations from public IRS data (ProPublica Nonprofit
// Explorer), gate + score them, upsert into sourcing_pool, update the ledger.
// Focus emphasis (set from the CRM's Sourcing panel) is harvested first.
import { searchAll, getOrg } from './src/propublica';
import { causeIncluded } from './src/scoring';
import { scoreOrg } from './src/pipeline';

const URL = process.env.SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CAP = Number(process.env.CAP || 100);
const NTEE_GROUPS = [3, 4, 5, 6, 7];
const CONCURRENCY = 4;

const METROS: Record<string, { state: string; cities: string[] }[]> = {
  'New York': [
    { state: 'NY', cities: ['New York', 'Brooklyn', 'Bronx', 'Staten Island', 'Flushing', 'Jamaica', 'Astoria', 'Long Island City', 'Yonkers', 'White Plains', 'New Rochelle', 'Garden City', 'Mineola', 'Hempstead', 'Huntington', 'Melville'] },
    { state: 'NJ', cities: ['Newark', 'Jersey City', 'Hoboken', 'Montclair', 'Hackensack', 'Englewood'] },
  ],
  'Cleveland': [{ state: 'OH', cities: ['Cleveland', 'Beachwood', 'Shaker Heights', 'Independence', 'Cleveland Heights'] }],
  'Washington DC': [
    { state: 'DC', cities: ['Washington'] },
    { state: 'MD', cities: ['Bethesda', 'Silver Spring', 'Rockville', 'Chevy Chase'] },
    { state: 'VA', cities: ['Arlington', 'Alexandria', 'Fairfax', 'Falls Church', 'Reston', 'Vienna'] },
  ],
  'Boston': [{ state: 'MA', cities: ['Boston', 'Cambridge', 'Newton', 'Brookline', 'Waltham', 'Somerville', 'Quincy'] }],
  'Philadelphia': [
    { state: 'PA', cities: ['Philadelphia', 'Bala Cynwyd', 'King Of Prussia', 'Wayne', 'Conshohocken'] },
    { state: 'NJ', cities: ['Camden', 'Cherry Hill'] },
  ],
  'Chicago': [{ state: 'IL', cities: ['Chicago', 'Evanston', 'Oak Park', 'Skokie', 'Naperville'] }],
  'Detroit': [{ state: 'MI', cities: ['Detroit', 'Southfield', 'Troy', 'Royal Oak', 'Bloomfield Hills', 'Farmington Hills', 'Ann Arbor'] }],
  'Los Angeles': [{ state: 'CA', cities: ['Los Angeles', 'Santa Monica', 'Pasadena', 'Long Beach', 'Beverly Hills', 'Burbank', 'Culver City', 'Glendale'] }],
  'San Francisco': [{ state: 'CA', cities: ['San Francisco', 'Oakland', 'Berkeley', 'San Jose', 'Palo Alto', 'Menlo Park', 'San Mateo', 'Mountain View'] }],
  'Seattle': [{ state: 'WA', cities: ['Seattle', 'Bellevue', 'Tacoma', 'Redmond', 'Kirkland', 'Everett'] }],
  'Minneapolis-St. Paul': [{ state: 'MN', cities: ['Minneapolis', 'Saint Paul', 'St Paul', 'Bloomington', 'Minnetonka', 'Edina'] }],
  'Atlanta': [{ state: 'GA', cities: ['Atlanta', 'Decatur', 'Marietta', 'Alpharetta', 'Sandy Springs'] }],
  'Baltimore': [{ state: 'MD', cities: ['Baltimore', 'Towson', 'Columbia', 'Annapolis'] }],
  'Denver': [{ state: 'CO', cities: ['Denver', 'Boulder', 'Aurora', 'Lakewood', 'Littleton'] }],
  'San Diego': [{ state: 'CA', cities: ['San Diego', 'La Jolla', 'Carlsbad', 'Escondido'] }],
  'Pittsburgh': [{ state: 'PA', cities: ['Pittsburgh'] }],
  'Houston': [{ state: 'TX', cities: ['Houston', 'Sugar Land', 'The Woodlands', 'Pasadena'] }],
  'Dallas-Fort Worth': [{ state: 'TX', cities: ['Dallas', 'Fort Worth', 'Plano', 'Irving', 'Arlington'] }],
  'Miami': [{ state: 'FL', cities: ['Miami', 'Fort Lauderdale', 'Hollywood', 'West Palm Beach', 'Coral Gables'] }],
  'Portland': [{ state: 'OR', cities: ['Portland', 'Beaverton', 'Gresham', 'Hillsboro'] }],
};

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}
const pad = (e: number | string) => String(e).replace(/\D/g, '').padStart(9, '0');
const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

async function main() {
  // 1. what does the queue want tonight?
  let metro = process.env.METRO || '';
  let focus: string[] | null = null;
  let focusLabel: string | null = null;
  if (metro) {
    const rows = await apiGet(`coverage?metro=eq.${encodeURIComponent(metro)}&select=*`);
    focus = rows[0]?.focus_codes || null;
    focusLabel = rows[0]?.focus_label || null;
  } else {
    const rows = await apiGet(`coverage?status=in.(queued,stocking)&order=priority.asc,metro.asc&limit=1&select=*`);
    if (!rows.length) { console.log('Queue empty - nothing to stock.'); return; }
    metro = rows[0].metro;
    focus = rows[0].focus_codes || null;
    focusLabel = rows[0].focus_label || null;
  }
  const regions = METROS[metro];
  if (!regions) throw new Error(`unknown metro: ${metro}`);
  console.log(`Stocking ${metro} (cap ${CAP})${focus ? ' with focus ' + JSON.stringify(focus) : ''}`);
  // shift log: announce the run, then report on the way out (finally below)
  const runRes = await fetch(`${URL}/rest/v1/stock_runs`, { method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ metro, focus_label: focusLabel, cap: CAP }) });
  const runId = (await runRes.json())[0]?.id;
  const finishRun = (patch: any) =>
    api('PATCH', `stock_runs?id=eq.${runId}`, { ...patch, finished_at: new Date().toISOString() }).catch(() => {});
  try {

  // 2. what do we already hold there?
  const held = new Set<string>(
    (await apiGet(`sourcing_pool?metro=eq.${encodeURIComponent(metro)}&select=ein&limit=10000`))
      .map((r: any) => r.ein));
  console.log(`Already on hand: ${held.size}`);

  // 3. discover candidates city-by-city; focus codes first, then the rest
  type Cand = { ein: number; name: string; ntee: string };
  const cands: Cand[] = [];
  const citySets = regions.map((r) => ({ state: r.state, cities: new Set(r.cities.map((c) => c.toLowerCase())) }));
  const matchesFocus = (ntee: string) => !focus || focus.some((f) => (ntee || '').toUpperCase().startsWith(f));
  const seen = new Set<number>();
  for (const { state, cities } of citySets) {
    for (const group of NTEE_GROUPS) {
      for await (const o of searchAll(state, group)) {
        if (!o.ntee_code || !causeIncluded(o.ntee_code)) continue;
        if (!cities.has((o.city || '').toLowerCase())) continue;
        if (held.has(pad(o.ein)) || seen.has(o.ein)) continue;
        seen.add(o.ein);
        cands.push({ ein: o.ein, name: o.name, ntee: o.ntee_code });
      }
    }
  }
  // focus first, then the rest - full discovery, the cap applies to scoring
  cands.sort((a, b) => Number(matchesFocus(b.ntee)) - Number(matchesFocus(a.ntee)));
  console.log(`Cause-passing new candidates found: ${cands.length}`);

  // 4. detail + gates + score, until the cap is met
  let added = 0, checked = 0;
  const rows: any[] = [];
  let idx = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < cands.length && added < CAP) {
      const c = cands[idx++];
      checked++;
      try {
        const detail = await getOrg(c.ein);
        const scored = detail && scoreOrg(detail);
        if (!scored) continue;
        if (added >= CAP) break;
        added++;
        rows.push({ ein: pad(c.ein), name: titleCase(scored.name || c.name), city: titleCase(scored.city || ''),
          state: scored.state, metro, ntee: scored.ntee || c.ntee, revenue: scored.revenue,
          program_rev: scored.programRev, fit: scored.fit, raw: scored, enrich: null });
      } catch (e) { /* one org failing never kills the night */ }
    }
  }));
  if (rows.length) await api('POST', 'sourcing_pool?on_conflict=ein', rows);
  console.log(`Checked ${checked}, gates passed and loaded: ${rows.length}`);

  // 5. ledger + milestone alert
  const total = (await apiGet(`sourcing_pool?metro=eq.${encodeURIComponent(metro)}&select=ein&limit=10000`)).length;
  const complete = cands.length === 0;
  await api('PATCH', `coverage?metro=eq.${encodeURIComponent(metro)}`, {
    org_count: total, last_pull_at: new Date().toISOString(),
    status: complete ? 'complete' : 'stocking', updated_at: new Date().toISOString() });
  if (complete) {
    const admins = await apiGet(`profiles?role=eq.admin&active=is.true&select=id`);
    await api('POST', 'alerts', admins.map((a: any) => ({ recipient_id: a.id, kind: 'Note',
      body: `Sourcing coverage complete: ${metro} - ${total} organizations on hand for campaigns.` })));
    console.log(`${metro} marked complete; admins alerted.`);
  }
  console.log(`Done. ${metro} now holds ${total} organizations.`);
  await finishRun({ discovered: cands.length, checked, added: rows.length, pool_total: total, status: 'done' });
  } catch (e: any) {
    await finishRun({ status: 'failed', note: String(e?.message || e).slice(0, 400) });
    throw e;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
