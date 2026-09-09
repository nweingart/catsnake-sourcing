// ProPublica Nonprofit Explorer API client with on-disk caching.
// Org-detail responses are cached under .cache/orgs/{ein}.json so big ingestion
// runs are resumable and re-runs are instant.

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

const API = 'https://projects.propublica.org/nonprofits/api/v2';
const CACHE = join(process.cwd(), '.cache', 'orgs');
mkdirSync(CACHE, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch with retry/backoff on rate-limits (429) and transient 5xx/network errors.
async function fetchRetry(url: string, tries = 5): Promise<Response | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
      if (r.status === 429 || r.status >= 500) { await sleep(800 * (i + 1)); continue; }
      return r; // non-retryable (e.g. 404)
    } catch {
      await sleep(800 * (i + 1));
    }
  }
  return null;
}

export interface SearchOrg {
  ein: number;
  name: string;
  ntee_code: string;
  city: string;
  state: string;
}

// Paginate every result for a state x NTEE-major-group, yielding orgs as we go.
export async function* searchAll(
  stateId: string,
  nteeGroup: number,
  q = '',
  delayMs = 150,
): AsyncGenerator<SearchOrg> {
  let page = 0;
  let numPages = 1;
  const qParam = q ? `&q=${encodeURIComponent(q)}` : '';
  do {
    const url = `${API}/search.json?state%5Bid%5D=${stateId}&ntee%5Bid%5D=${nteeGroup}${qParam}&page=${page}`;
    const res = await fetchRetry(url);
    if (!res || !res.ok) break;
    const data: any = await res.json();
    numPages = data.num_pages ?? 1;
    for (const o of data.organizations ?? []) yield o as SearchOrg;
    page++;
    await sleep(delayMs);
  } while (page < numPages);
}

// Full org detail (org profile + filings_with_data). Cached to disk.
export async function getOrg(ein: number, delayMs = 120): Promise<any | null> {
  const file = join(CACHE, `${ein}.json`);
  // The cache persists across nightly runs (actions/cache), which is what
  // keeps the walk inside its window: rejected orgs cost nothing to re-check.
  // A cached detail older than 45 days is refetched so a new filing counts.
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 45 * 86_400_000) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetchRetry(`${API}/organizations/${ein}.json`);
  await sleep(delayMs);
  if (!res || !res.ok) return null;
  const data = await res.json();
  writeFileSync(file, JSON.stringify(data));
  return data;
}
