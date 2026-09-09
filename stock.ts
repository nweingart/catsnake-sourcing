// One night's stocking: pick the top metro from the coverage queue, harvest
// up to CAP new organizations from public IRS data (ProPublica Nonprofit
// Explorer), gate + score them, upsert into sourcing_pool, update the ledger.
// Focus emphasis (set from the CRM's Sourcing panel) is harvested first.
import { searchAll, getOrg } from './src/propublica';
import { causeIncluded } from './src/scoring';
import { scoreOrg } from './src/pipeline';
import { territoryNameFor } from './src/territory';

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

async function main() {
  if (process.env.CENSUS === '1') { await census(); return; }
  // 1. what does the queue want tonight?
  let metro = process.env.METRO || '';
  let focus: string[] | null = null;
  let focusLabel: string | null = null;
  let searchNote: string | null = null;
  let jobId: string | null = null;
  if (metro) {
    const rows = await apiGet(`coverage?metro=eq.${encodeURIComponent(metro)}&select=*`);
    focus = rows[0]?.focus_codes || null;
    focusLabel = rows[0]?.focus_label || null;
    searchNote = rows[0]?.search_note || null;
  } else {
    const jobs = await apiGet(`stock_jobs?status=eq.active&order=priority.asc,created_at.asc&limit=1&select=*`);
    if (jobs.length) {
      jobId = jobs[0].id;
      metro = jobs[0].metro;
      focus = jobs[0].focus_codes || null;
      focusLabel = jobs[0].focus_label || null;
      searchNote = jobs[0].note || null;
      if (jobs[0].cap) CAP = jobs[0].cap;
      console.log(`Working job: ${focusLabel || 'broad'} in ${metro} (cap ${CAP})`);
    } else {
      // Rotate through the metros being stocked, oldest pull first, so every
      // territory gets nights instead of New York (priority 1) taking all of
      // them. Queued metros with no territories wait for the PRD's saved
      // filters; they are reached only when nothing is stocking.
      let rows = await apiGet(`coverage?status=eq.stocking&order=last_pull_at.asc.nullsfirst,priority.asc&limit=1&select=*`);
      if (!rows.length) rows = await apiGet(`coverage?status=eq.queued&order=priority.asc,metro.asc&limit=1&select=*`);
      if (!rows.length) { console.log('Queue empty - nothing to stock.'); return; }
      metro = rows[0].metro;
      focus = rows[0].focus_codes || null;
      focusLabel = rows[0].focus_label || null;
      searchNote = rows[0].search_note || null;
    }
  }
  const regions = METROS[metro];
  if (!regions) throw new Error(`unknown metro: ${metro}`);
  console.log(`Stocking ${metro} (cap ${CAP})${focus ? ' with focus ' + JSON.stringify(focus) : ''}`);

  // Reap: a run older than three hours still marked running was killed by
  // the Action timeout. Record that instead of leaving it running forever.
  const stale = new Date(Date.now() - 3 * 3600_000).toISOString();
  await api('PATCH', `stock_runs?status=eq.running&started_at=lt.${encodeURIComponent(stale)}`,
    { status: 'failed', finished_at: new Date().toISOString(), note: 'reaped: Action timeout' }).catch(() => {});

  // Territories: every org lands in one the night it arrives. Unknown names
  // are created dormant so a new metro never blocks the run.
  const terrByName = new Map<string, string>();
  for (const t of await apiGetAll('territories?select=id,name')) terrByName.set(t.name, t.id);
  async function terrIdFor(metroName: string, ntee: string | null): Promise<string | null> {
    const name = territoryNameFor(metroName, ntee);
    if (terrByName.has(name)) return terrByName.get(name)!;
    const res = await fetch(`${URL}/rest/v1/territories`, { method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ name, metro: metroName, status: 'dormant' }) });
    if (!res.ok) { console.log(`territory create failed for ${name}: ${res.status}`); return null; }
    const id = (await res.json())[0]?.id || null;
    if (id) { terrByName.set(name, id); console.log(`Created territory "${name}".`); }
    return id;
  }
  // Backfill: any org already in the pool without a territory (the rows
  // stocked between the 8/27 partition and this change) gets one now.
  const orphans = await apiGetAll('sourcing_pool?territory_id=is.null&select=ein,metro,ntee');
  for (const o of orphans) {
    const tid = await terrIdFor(o.metro, o.ntee);
    if (tid) await api('PATCH', `sourcing_pool?ein=eq.${o.ein}`, { territory_id: tid }).catch(() => {});
  }
  if (orphans.length) console.log(`Assigned territories to ${orphans.length} previously unassigned orgs.`);
  // shift log: announce the run, then report on the way out (finally below)
  const runRes = await fetch(`${URL}/rest/v1/stock_runs`, { method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ metro, focus_label: focusLabel, cap: CAP, note: searchNote }) });
  const runId = (await runRes.json())[0]?.id;
  const finishRun = (patch: any) =>
    api('PATCH', `stock_runs?id=eq.${runId}`, { ...patch, finished_at: new Date().toISOString() }).catch(() => {});
  try {

  // THE CONTRACT: 100 organizations land every night. The ladder loosens
  // scope, never the quota: job focus in its cities -> whole metro ->
  // whole states -> next territories in the queue, until the cap is met.
  type Cand = { ein: number; name: string; ntee: string; metro: string };
  const rows: any[] = [];
  let discovered = 0, checked = 0;
  const seen = new Set<number>();
  const heldAll = new Set<string>(
    (await apiGetAll(`sourcing_pool?select=ein`)).map((r: any) => r.ein));
  console.log(`Pool holds ${heldAll.size} orgs total.`);

  async function discover(metroName: string, useCities: boolean): Promise<Cand[]> {
    const regs = METROS[metroName];
    if (!regs) return [];
    const out: Cand[] = [];
    const sets = regs.map((r) => ({ state: r.state, cities: new Set(r.cities.map((c) => c.toLowerCase())) }));
    for (const { state, cities } of sets) {
      for (const group of NTEE_GROUPS) {
        if (checkDeadline('discovery')) return out;
        for await (const o of searchAll(state, group)) {
          if (!o.ntee_code || !causeIncluded(o.ntee_code)) continue;
          if (useCities && !cities.has((o.city || '').toLowerCase())) continue;
          if (heldAll.has(pad(o.ein)) || seen.has(o.ein)) continue;
          seen.add(o.ein);
          out.push({ ein: o.ein, name: o.name, ntee: o.ntee_code, metro: metroName });
        }
      }
    }
    return out;
  }
  // Shuffle before scoring: discovery yields candidates in NTEE-group order
  // (arts first), so an unshuffled night lands 50 arts orgs and nothing
  // else. A seeded shuffle spreads each haul across verticals; a focus job,
  // when one exists, still floats its matches to the front.
  function shuffle<T>(arr: T[], seed: number): T[] {
    let x = seed >>> 0 || 1;
    for (let i = arr.length - 1; i > 0; i--) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      const j = (x >>> 0) % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  async function scoreInto(cands: Cand[], focusArr: string[] | null) {
    shuffle(cands, Date.now());
    if (focusArr) cands.sort((a, b) =>
      Number(focusArr.some((f) => (b.ntee || '').toUpperCase().startsWith(f)))
      - Number(focusArr.some((f) => (a.ntee || '').toUpperCase().startsWith(f))));
    let i = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < cands.length && rows.length < CAP && !checkDeadline('scoring')) {
        const c = cands[i++];
        checked++;
        try {
          const detail = await getOrg(c.ein);
          const scored = detail && scoreOrg(detail);
          if (!scored || rows.length >= CAP) continue;
          // enrich is deliberately NOT in this row: the POST below merges on
          // ein conflicts, and carrying enrich:null would wipe an already-
          // enriched org on a duplicate insert. New rows get null from the
          // column default; existing rows keep what enrichment wrote.
          const territory_id = await terrIdFor(c.metro, scored.ntee || c.ntee);
          rows.push({ ein: pad(c.ein), name: titleCase(scored.name || c.name), city: titleCase(scored.city || ''),
            state: scored.state, metro: c.metro, ntee: scored.ntee || c.ntee, revenue: scored.revenue,
            program_rev: scored.programRev, fit: scored.fit, raw: scored, territory_id });
        } catch (e) { /* one org never kills the night */ }
      }
    }));
  }

  // rung 1+2: the job's metro (focus ordering first, then everything there)
  let cands = await discover(metro, true);
  discovered += cands.length;
  const heldInMetro = (await apiGetAll(`sourcing_pool?metro=eq.${encodeURIComponent(metro)}&select=ein`)).length;
  await api('PATCH', `coverage?metro=eq.${encodeURIComponent(metro)}`, {
    universe_est: heldInMetro + cands.length, censused_at: new Date().toISOString(),
    updated_at: new Date().toISOString() }).catch(() => {});
  await scoreInto(cands, focus);
  const jobYield = rows.length;
  if (rows.length < CAP && !outOfTime()) {
    console.log(`Cities yielded ${rows.length}; widening to full states of ${metro}.`);
    const wide = await discover(metro, false);
    discovered += wide.length;
    await scoreInto(wide, focus);
  }
  // rung 3: march down the rest of the map until the quota is met
  if (rows.length < CAP) {
    const cov = await apiGet(`coverage?select=metro,priority&order=priority.asc,metro.asc`);
    const others = cov.map((c: any) => c.metro).filter((m: string) => m !== metro && METROS[m]);
    for (const m2 of others) {
      if (rows.length >= CAP || outOfTime()) break;
      console.log(`Quota at ${rows.length}; rolling into ${m2}.`);
      const extra = await discover(m2, true);
      discovered += extra.length;
      await scoreInto(extra, null);
    }
  }
  if (rows.length) await api('POST', 'sourcing_pool?on_conflict=ein', rows);
  console.log(`Night's haul: ${rows.length}/${CAP} (job territory contributed ${jobYield}); checked ${checked}.`);
  if (rows.length < CAP && !deadlineHit) {
    const admins = await apiGet(`profiles?role=eq.admin&active=is.true&select=id`);
    await api('POST', 'alerts', admins.map((a: any) => ({ recipient_id: a.id, kind: 'Note',
      body: `Sourcing shortfall: only ${rows.length} of ${CAP} organizations last night, after exhausting every territory. Needs attention.` })));
  }

  // 5. ledger + milestone alert
  const total = (await apiGetAll(`sourcing_pool?metro=eq.${encodeURIComponent(metro)}&select=ein`)).length;
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
  await finishRun({ discovered, checked, added: rows.length, pool_total: total, status: 'done',
    added_eins: rows.map((r) => r.ein),
    note: deadlineHit ? `time budget (${DEADLINE_MIN} min) reached; partial haul` : searchNote });
  if (jobId && rows.length === 0) {
    await api('PATCH', `stock_jobs?id=eq.${jobId}`, { status: 'done', updated_at: new Date().toISOString() });
    const admins = await apiGet(`profiles?role=eq.admin&active=is.true&select=id`);
    await api('POST', 'alerts', admins.map((a: any) => ({ recipient_id: a.id, kind: 'Note',
      body: `Sourcing job complete: ${focusLabel || 'broad harvest'} in ${metro} - nothing new left to gather.` })));
    console.log('Job exhausted and retired.');
  }
  } catch (e: any) {
    await finishRun({ status: 'failed', note: String(e?.message || e).slice(0, 400) });
    throw e;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
