// IRS 990 e-file XML enrichment.
//
// ProPublica's API can't separate individual gifts from government grants, and
// only exposes the outsourced sliver of fundraising spend. The 990 XML has both,
// plus the org's real website. The XML only ships in big monthly ZIPs, so we:
//   1. download the per-year index CSV (maps EIN -> object id -> ZIP)
//   2. for our universe's EINs, find the latest filing
//   3. download the ZIPs that contain them (cached on disk; one-time)
//   4. extract + parse each filing's Part VIII / Part I fields
//
// Dependency-free: curl for downloads, the system `unzip` to pull one member.

import { mkdirSync, existsSync, readFileSync, writeFileSync, createReadStream, unlinkSync } from 'fs';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { join } from 'path';

const BASE = 'https://apps.irs.gov/pub/epostcard/990/xml';
const INDEX_DIR = join(process.cwd(), '.cache', 'irs-index');
const ZIP_DIR = join(process.cwd(), '.cache', 'irs-zips');
const PARSE_DIR = join(process.cwd(), '.cache', 'irs-parsed');
[INDEX_DIR, ZIP_DIR, PARSE_DIR].forEach((d) => mkdirSync(d, { recursive: true }));

export interface FilingRef {
  ein: string;
  taxPeriod: string; // YYYYMM
  returnType: string; // 990, 990EZ, 990PF...
  objectId: string;
  zip: string; // XML_BATCH_ID, e.g. 2024_TEOS_XML_03A
  year: number;
}

export interface Person {
  name: string;
  title: string;
  comp: number; // reportable comp from org + related orgs
}

export interface Filing990 {
  govGrants: number; // Part VIII line 1e
  allOtherContrib: number; // Part VIII line 1f
  fundraisingExpense: number; // Part I line 16b (Part IX col D total)
  website: string | null;
  people: Person[]; // Part VII Section A, top paid leadership
}

function curl(url: string, out: string) {
  execSync(`curl -s -o "${out}" "${url}"`, { stdio: 'ignore', maxBuffer: 1 << 30 });
}

export function ensureIndex(year: number): string {
  const f = join(INDEX_DIR, `index_${year}.csv`);
  if (!existsSync(f)) curl(`${BASE}/${year}/index_${year}.csv`, f);
  return f;
}

// Stream the (large) index, keeping only rows whose EIN is in our set. Parses
// fixed fields from the ends so taxpayer names containing commas don't shift us.
export async function findFilings(eins: Set<string>, years: number[]): Promise<Map<string, FilingRef[]>> {
  const out = new Map<string, FilingRef[]>();
  for (const year of years) {
    const path = ensureIndex(year);
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    let first = true;
    for await (const line of rl) {
      if (first) { first = false; continue; } // header
      const p = line.split(',');
      if (p.length < 10) continue;
      const ein = p[2];
      if (!eins.has(ein)) continue;
      const ref: FilingRef = {
        ein,
        taxPeriod: p[3],
        returnType: p[p.length - 4],
        objectId: p[p.length - 2],
        zip: p[p.length - 1].trim(),
        year,
      };
      (out.get(ein) ?? out.set(ein, []).get(ein)!).push(ref);
    }
  }
  return out;
}

// Full 990 filings (prefer 990 over 990EZ/PF), newest tax period first. Returned
// as a list so the caller can fall back to an older filing when the newest one's
// XML isn't actually in the published batch (IRS index/zip can be out of sync).
export function orderedFilings(refs: FilingRef[]): FilingRef[] {
  if (!refs.length) return [];
  const full = refs.filter((r) => r.returnType === '990');
  const pool = full.length ? full : refs;
  return [...pool].sort((a, b) => b.taxPeriod.localeCompare(a.taxPeriod));
}
export function pickLatest(refs: FilingRef[]): FilingRef | null {
  return orderedFilings(refs)[0] ?? null;
}

const PY = join(process.cwd(), 'scripts', 'zip_extract.py');

// Validate via Python (ZIP64-capable; macOS unzip can't read these large
// batches even when fully downloaded).
function zipValid(f: string): boolean {
  try { execSync(`python3 "${PY}" validate "${f}"`, { stdio: 'ignore' }); return true; } catch { return false; }
}

// Chunked byte-range download: single transfers over ~400MB get dropped in this
// environment, so pull in 80MB pieces and concatenate.
function downloadChunked(url: string, f: string) {
  // Resolve redirects first (some batch names differ only by case and 302), then
  // range-request the final URL — ranges don't survive a redirect cleanly.
  let real = url;
  try {
    const r = execSync(`curl -sIL -o /dev/null -w '%{url_effective}' "${url}"`).toString().trim();
    if (r) real = r;
  } catch {}
  const len = Number(execSync(`curl -sI "${real}" | grep -i '^content-length' | tail -1 | tr -dc '0-9'`).toString().trim()) || 0;
  if (existsSync(f)) unlinkSync(f);
  if (!len) { execSync(`curl -sS -L -o "${f}" "${real}"`, { stdio: 'ignore', maxBuffer: 1 << 30 }); return; }
  const chunk = 80_000_000;
  for (let start = 0; start < len; start += chunk) {
    const end = Math.min(start + chunk - 1, len - 1);
    execSync(`curl -sS -r ${start}-${end} "${real}" >> "${f}"`, { stdio: 'ignore', maxBuffer: 1 << 30 });
  }
}

export function ensureZip(ref: FilingRef): string {
  const f = join(ZIP_DIR, `${ref.zip}.zip`);
  if (existsSync(f) && zipValid(f)) return f;
  if (existsSync(f)) unlinkSync(f);
  // The download filenames use uppercase suffixes; the 2024 index lists some
  // batches lowercase (e.g. 05a), and the lowercase URL 302-redirects to a 404.
  const url = `${BASE}/${ref.year}/${ref.zip.toUpperCase()}.zip`;
  for (let i = 0; i < 3; i++) {
    try { downloadChunked(url, f); } catch {}
    if (existsSync(f) && zipValid(f)) return f;
    if (existsSync(f)) unlinkSync(f);
  }
  return f;
}

const numTag = (xml: string, tag: string) => {
  const m = xml.match(new RegExp(`<${tag}>(\\d+)</${tag}>`));
  return m ? Number(m[1]) : 0;
};
const txtTag = (xml: string, tag: string) => {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : null;
};

// Part VII Section A people, top 5 by compensation (org + related-org). Board
// members typically report $0, so sorting by comp surfaces the paid leadership.
function parsePeople(xml: string): Person[] {
  const blocks = xml.split('<Form990PartVIISectionAGrp>').slice(1);
  const seen = new Set<string>();
  const people: Person[] = [];
  for (const b of blocks) {
    const name = (b.match(/<PersonNm>([^<]*)<\/PersonNm>/) || [])[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const title = ((b.match(/<TitleTxt>([^<]*)<\/TitleTxt>/) || [])[1] || '').trim();
    const comp = Number((b.match(/<ReportableCompFromOrgAmt>(\d+)<\/ReportableCompFromOrgAmt>/) || [])[1] || 0)
      + Number((b.match(/<ReportableCompFromRltdOrgAmt>(\d+)<\/ReportableCompFromRltdOrgAmt>/) || [])[1] || 0);
    people.push({ name: name.trim(), title, comp });
  }
  return people.sort((a, b) => b.comp - a.comp).slice(0, 5);
}

export function parseFiling(ref: FilingRef): Filing990 | null {
  const cache = join(PARSE_DIR, `${ref.objectId}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  const zipPath = ensureZip(ref);
  let xml = '';
  try {
    xml = execSync(`python3 "${PY}" extract "${zipPath}" "${ref.objectId}" "${ref.zip}"`, { maxBuffer: 1 << 28 }).toString();
  } catch {}
  if (!xml || xml.length < 50) return null;
  const parsed: Filing990 = {
    govGrants: numTag(xml, 'GovernmentGrantsAmt'),
    allOtherContrib: numTag(xml, 'AllOtherContributionsAmt'),
    fundraisingExpense: numTag(xml, 'CYTotalFundraisingExpenseAmt'),
    website: txtTag(xml, 'WebsiteAddressTxt'),
    people: parsePeople(xml),
  };
  writeFileSync(cache, JSON.stringify(parsed));
  return parsed;
}
