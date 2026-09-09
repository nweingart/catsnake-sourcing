// One night's stocking: pick the top metro from the coverage queue, harvest
// up to CAP new organizations from public IRS data (ProPublica Nonprofit
// Explorer), gate + score them, upsert into sourcing_pool, update the ledger.
// Focus emphasis (set from the CRM's Sourcing panel) is harvested first.
import { searchAll, getOrg } from './src/propublica';
import { causeIncluded } from './src/scoring';
import { scoreOrg } from './src/pipeline';
import { upsertOrgAndFilings } from './src/filings';

const URL = process.env.SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// 50 a night (Ned, 2026-09-09): enough to keep territories topped up, small
// enough that the walk finishes. The Action allows 120 minutes; the run
// stops discovering and scoring at DEADLINE_MIN and lands what it has, so a
// slow night ends as a short haul instead of a killed process and a
// stock_runs row stuck at "running".
let CAP = Number(process.env.CAP || 50);
const DEADLINE_MIN = Number(process.env.DEADLINE_MIN || 95);
const T0 = Date.now();
const outOfTime = () => Date.now() - T0 > DEADLINE_MIN * 60_000;
let deadlineHit = false;
// Discovery may use at most 60% of the budget so scoring always gets a
// turn; a walk that runs long lands a short haul instead of none.
const discoveryOutOfTime = () => Date.now() - T0 > DEADLINE_MIN * 60_000 * 0.6;
function checkDeadline(where: string): boolean {
  if (!(where === 'discovery' ? discoveryOutOfTime() : outOfTime())) return false;
  if (!deadlineHit) { deadlineHit = true; console.log(`Time budget of ${DEADLINE_MIN} min reached during ${where}; landing what we have.`); }
  return true;
}
// Every listing section the mission filter can accept: 1 arts, 2 education,
// 3 environment/animals, 4 health, 5 human services, 6 international,
// 7 public benefit, 8 religion. (9 mutual-benefit and 10 unknown are
// excluded causes, so never walked.) The old 3-7 list was a May-era relic
// that silently hid arts and education from every harvest.
const NTEE_GROUPS = [1, 2, 3, 4, 5, 6, 7, 8];
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

async function api(method: string, path: string, body?: unknown, prefer?: string): Promise<any> {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      Prefer: prefer || (method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal') },
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
// PostgREST caps reads at 1,000 rows; anything that must see EVERYTHING
// (the already-held ein sets) pages through with Range headers.
async function apiGetAll(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${path}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` } });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < 1000) return out;
  }
}
const pad = (e: number | string) => String(e).replace(/\D/g, '').padStart(9, '0');
const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

async function census() {
  console.log('Census: enumerating every territory (counts only, no detail fetches).');
  for (const metroName of Object.keys(METROS)) {
    const held = new Set<string>(
      (await apiGetAll(`sourcing_pool?metro=eq.${encodeURIComponent(metroName)}&select=ein`))
        .map((r: any) => r.ein));
    const sets = METROS[metroName].map((r) => ({ state: r.state, cities: new Set(r.cities.map((c) => c.toLowerCase())) }));
    const seen = new Set<number>();
    let universe = 0;
    for (const { state, cities } of sets) {
      for (const group of NTEE_GROUPS) {
        for await (const o of searchAll(state, group)) {
          if (!o.ntee_code || !causeIncluded(o.ntee_code)) continue;
          if (!cities.has((o.city || '').toLowerCase())) continue;
          if (seen.has(o.ein)) continue;
          seen.add(o.ein);
          universe++;
        }
      }
    }
    await api('PATCH', `coverage?metro=eq.${encodeURIComponent(metroName)}`, {
      universe_est: universe, censused_at: new Date().toISOString(),
      org_count: held.size, updated_at: new Date().toISOString() });
    console.log(`${metroName}: ${held.size} on hand of ${universe} cause-passing.`);
  }
  console.log('Census complete.');
}

// NTEE letter -> ProPublica listing section (the search endpoint's ntee[id])
const SECTION_OF: Record<string, number> = { A: 1, B: 2, C: 3, D: 3, E: 4, F: 4, G: 4, H: 4, I: 5, J: 5, K: 5, L: 5, M: 5, N: 5, O: 5, P: 5, Q: 6, R: 7, S: 7, T: 7, U: 7, V: 7, W: 7, X: 8 };
type Territory = { id: string; name: string; metro: string; target_size: number; filter: { metro?: string[]; ntee_prefixes?: string[]; ntee_exclude?: string[] } };
function matchesFilter(t: Territory, ntee: string): boolean {
  const code = (ntee || '').toUpperCase();
  const pre = t.filter.ntee_prefixes || ['*'];
  const ex = t.filter.ntee_exclude || [];
  if (ex.some((x) => code.startsWith(x))) return false;
  return pre.includes('*') || pre.some((p) => code.startsWith(p));
}

async function main() {
  if (process.env.CENSUS === '1') { await census(); return; }
  const DRY = process.env.DRY === '1';
  // Reap: a run older than three hours still marked running was killed by
  // the Action timeout. Record that instead of leaving it running forever.
  const stale = new Date(Date.now() - 3 * 3600_000).toISOString();
  await api('PATCH', `stock_runs?status=eq.running&started_at=lt.${encodeURIComponent(stale)}`,
    { status: 'failed', finished_at: new Date().toISOString(), note: 'reaped: Action timeout' }).catch(() => {});

  // THE JOB (PRD §7.1, step 4): top up every territory to its target size
  // from its own saved filter. Emptiest first, so a new territory fills
  // before a full one gets a top-up. No metro walk, no focus jobs.
  const terrs: Territory[] = await apiGetAll('territories?select=id,name,metro,target_size,filter&order=created_at');
  const held = await apiGetAll('sourcing_pool?select=ein,territory_id');
  const heldAll = new Set<string>(held.map((r: any) => r.ein));
  const countBy: Record<string, number> = {};
  held.forEach((r: any) => { if (r.territory_id) countBy[r.territory_id] = (countBy[r.territory_id] || 0) + 1; });
  const need = terrs.map((t) => ({ t, have: countBy[t.id] || 0, want: Math.max(0, t.target_size - (countBy[t.id] || 0)) }))
    .filter((x) => x.want > 0 && METROS[x.t.metro])
    .sort((a, b) => (a.have / Math.max(1, a.t.target_size)) - (b.have / Math.max(1, b.t.target_size)));
  console.log(`Pool holds ${heldAll.size} orgs. ${need.length} of ${terrs.length} territories below target.`);
  if (!need.length) { console.log('Every territory is at target - nothing to stock.'); return; }
  const metroOverride = process.env.METRO || '';

  const runRes = await fetch(`${URL}/rest/v1/stock_runs`, { method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ metro: metroOverride || need[0].t.metro, focus_label: 'territory top-up', cap: CAP, note: DRY ? 'DRY RUN' : null }) });
  const runId = (await runRes.json())[0]?.id;
  const finishRun = (patch: any) => api('PATCH', `stock_runs?id=eq.${runId}`, { ...patch, finished_at: new Date().toISOString() }).catch(() => {});

  type Cand = { ein: number; name: string; ntee: string; metro: string };
  const rows: any[] = [];
  const perTerritory: Record<string, number> = {};
  let discovered = 0, checked = 0;
  const seen = new Set<number>();
  // listing pages are cached per (state, section) for the night so ten
  // territories in one metro do not re-walk the same section
  const listingCache = new Map<string, { ein: number; name: string; ntee_code: string; city: string }[]>();
  async function listing(state: string, section: number) {
    const k = state + ':' + section;
    if (listingCache.has(k)) return listingCache.get(k)!;
    const out: { ein: number; name: string; ntee_code: string; city: string }[] = [];
    for await (const o of searchAll(state, section)) { out.push(o as any); if (checkDeadline('discovery')) break; }
    listingCache.set(k, out);
    return out;
  }
  async function discover(t: Territory): Promise<Cand[]> {
    const regs = METROS[t.metro]; if (!regs) return [];
    const sections = new Set<number>();
    (t.filter.ntee_prefixes || ['*']).forEach((p) => { if (p === '*') NTEE_GROUPS.forEach((g) => sections.add(g)); else if (SECTION_OF[p[0]]) sections.add(SECTION_OF[p[0]]); });
    const out: Cand[] = [];
    for (const { state, cities } of regs.map((r) => ({ state: r.state, cities: new Set(r.cities.map((c) => c.toLowerCase())) }))) {
      for (const section of sections) {
        if (checkDeadline('discovery')) return out;
        for (const o of await listing(state, section)) {
          if (!o.ntee_code || !causeIncluded(o.ntee_code) || !matchesFilter(t, o.ntee_code)) continue;
          if (!cities.has((o.city || '').toLowerCase())) continue;
          if (heldAll.has(pad(o.ein)) || seen.has(o.ein)) continue;
          seen.add(o.ein);
          out.push({ ein: o.ein, name: o.name, ntee: o.ntee_code, metro: t.metro });
        }
      }
    }
    return out;
  }
  function shuffle<T>(arr: T[], seed: number): T[] {
    let x = seed >>> 0 || 1;
    for (let i = arr.length - 1; i > 0; i--) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; const j = (x >>> 0) % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
  async function landInto(t: Territory, cands: Cand[], want: number) {
    shuffle(cands, Date.now());
    let i = 0, landed = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < cands.length && landed < want && rows.length < CAP && !checkDeadline('scoring')) {
        const c = cands[i++];
        checked++;
        try {
          const detail = await getOrg(c.ein);
          const scored = detail && scoreOrg(detail);
          if (!scored || landed >= want || rows.length >= CAP) continue;
          landed++;
          const ein9 = pad(c.ein);
          const row = { ein: ein9, name: titleCase(scored.name || c.name), city: titleCase(scored.city || ''),
            state: scored.state, metro: c.metro, ntee: scored.ntee || c.ntee, revenue: scored.revenue,
            program_rev: scored.programRev, fit: scored.fit, raw: scored, territory_id: t.id };
          if (!DRY) {
            // the org record + filings series first, so the pool row can point at it
            const orgId = await upsertOrgAndFilings(api, apiGet, detail, ein9, row.name, row.state, row.ntee).catch((e) => { console.log('org/filings upsert failed for ' + ein9 + ': ' + (e?.message || e)); return null; });
            (row as any).org_id = orgId;
          }
          rows.push(row);
          perTerritory[t.name] = (perTerritory[t.name] || 0) + 1;
        } catch (e) { /* one org never kills the night */ }
      }
    }));
    return landed;
  }

  try {
    for (const { t, want } of need) {
      if (rows.length >= CAP || outOfTime()) break;
      if (metroOverride && t.metro !== metroOverride) continue;
      const cands = await discover(t);
      discovered += cands.length;
      const landed = await landInto(t, cands, Math.min(want, CAP - rows.length));
      console.log(`${t.name}: ${cands.length} candidates, landed ${landed} of ${want} wanted`);
    }
    if (rows.length && !DRY) await api('POST', 'sourcing_pool?on_conflict=ein', rows);
    console.log(`Night's haul: ${rows.length}/${CAP}; checked ${checked}. ${JSON.stringify(perTerritory)}`);
    // ledger: last_pull_at per metro touched, so the Sweeps view and the
    // rotation history keep reading (the metro queue itself is retired)
    for (const metro of new Set(rows.map((r) => r.metro))) {
      await api('PATCH', `coverage?metro=eq.${encodeURIComponent(metro)}`, { last_pull_at: new Date().toISOString(), updated_at: new Date().toISOString() }).catch(() => {});
    }
    const total = heldAll.size + rows.length;
    await finishRun({ discovered, checked, added: rows.length, pool_total: total, status: 'done',
      added_eins: rows.map((r) => r.ein),
      note: (DRY ? 'DRY RUN - nothing written. ' : '') + (deadlineHit ? `time budget (${DEADLINE_MIN} min) reached; partial haul. ` : '') + JSON.stringify(perTerritory) });
    console.log('Done.');
  } catch (e: any) {
    await finishRun({ status: 'failed', note: String(e?.message || e).slice(0, 400) });
    throw e;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
