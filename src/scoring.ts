// Pure scoring functions for the Catsnake v0 prospecting model.
// See docs/v0-scoring-spec.md. All inputs come from ProPublica filing fields.

export interface Filing {
  tax_prd_yr: number;
  totrevenue: number;
  totcntrbgfts: number;
  totprgmrevnue: number;
  totfuncexpns: number;
  totnetassetend: number;
  profndraising: number;
  grsincfndrsng: number;
}

export const DONATION_FLOOR = 0.40;
export const SIZE_MIN = 10_000_000;   // raised from $5M, 2026-08-07 (team)
// No upper bound (2026-08-07, Ned): the old $750M ceiling excluded marquee
// donation-dependent orgs (the Met, Frick). The floor and donation gates
// carry the filtering.

// Donation dependence is also a gate, so among survivors it saturates near 10
// and does little ranking work. Weight shifted onto fundraising appetite (which
// genuinely varies in the data) to decompress the scores.
export const WEIGHTS = { dependence: 0.30, appetite: 0.50, reserve: 0.20 };

// --- Gates -----------------------------------------------------------------

// E health codes that are program/government funded, not Catsnake-shaped.
const E_EXCLUDE = ['E20', 'E21', 'E22', 'E30', 'E31', 'E32', 'E90', 'E92'];
// 2026-08-05 (Ned): the universe is everything EXCEPT food/agriculture,
// disaster relief, hospitals/clinics (E_EXCLUDE), unclassified, and the
// long tail (crime/legal, employment, social science, mutual benefit).
const EXCLUDE_LETTERS = new Set(['K', 'M', 'Z', 'I', 'J', 'V', 'Y']);

// Museums and historical orgs keep their special scoring treatment, but as
// of 2026-08-05 (Ned) ALL of A - performing arts, theaters, cultural
// centers, the lot - is in the targeted universe.
export function isMuseum(ntee: string | null | undefined): boolean {
  if (!ntee) return false;
  return ntee.startsWith('A5') || ntee.startsWith('A8');
}

export function causeIncluded(ntee: string | null | undefined): boolean {
  if (!ntee) return false;
  const letter = ntee[0];
  if (letter === 'E') return !E_EXCLUDE.some((p) => ntee.startsWith(p));
  return !EXCLUDE_LETTERS.has(letter);
}

export function sizeGate(revenue: number): boolean {
  return revenue >= SIZE_MIN;
}

export function donationRatio(f: Filing): number {
  if (!f.totrevenue) return 0;
  return f.totcntrbgfts / f.totrevenue;
}

// Museums earn much of their revenue from admissions/endowment but still run
// real development operations, so they get a lower donation floor.
export function donationFloorPass(f: Filing, ntee?: string | null): boolean {
  const floor = isMuseum(ntee) ? 0.20 : DONATION_FLOOR;
  return donationRatio(f) >= floor;
}

// --- Scores (0-10) ---------------------------------------------------------

export function donationScore(ratio: number): number {
  if (ratio >= 0.80) return 10;
  if (ratio >= 0.65) return 9;
  if (ratio >= 0.50) return 7;
  return 5; // 0.40-0.50 (below 0.40 is gated out)
}

export interface AppetiteResult {
  score: number;
  cagr: number | null;
  lowConfidence: boolean;
  outsourcesFundraising: boolean;
}

// 3-yr CAGR of contributions across available filings. Booster +1 if the org
// pays professional fundraisers. Neutral 5 + low-confidence if <2 years.
export function appetiteScore(filings: Filing[]): AppetiteResult {
  const latest = filings[0];
  const outsourcesFundraising = (latest?.profndraising ?? 0) > 0;

  const usable = filings
    .filter((f) => f.totcntrbgfts > 0)
    .sort((a, b) => a.tax_prd_yr - b.tax_prd_yr)
    .slice(-4); // up to 4 years -> up to 3-year span

  if (usable.length < 2) {
    return { score: 5, cagr: null, lowConfidence: true, outsourcesFundraising };
  }

  const start = usable[0];
  const end = usable[usable.length - 1];
  const years = end.tax_prd_yr - start.tax_prd_yr || 1;
  const cagr = Math.pow(end.totcntrbgfts / start.totcntrbgfts, 1 / years) - 1;

  let base: number;
  if (cagr >= 0.15) base = 10;
  else if (cagr >= 0.05) base = 8;
  else if (cagr >= 0) base = 5;
  else base = 2;

  const score = Math.min(10, base + (outsourcesFundraising ? 1 : 0));
  return { score, cagr, lowConfidence: false, outsourcesFundraising };
}

export interface ReserveResult {
  score: number;
  months: number | null;
}

export function reserveScore(netAssets: number, expenses: number): ReserveResult {
  if (!expenses) return { score: 5, months: null };
  const months = (netAssets / expenses) * 12;
  let score: number;
  if (months < 3) score = 2;
  else if (months < 6) score = 6;
  else if (months < 18) score = 10;
  else if (months < 36) score = 8;
  else score = 5;
  return { score, months };
}

export function composite(dep: number, appetite: number, reserve: number): number {
  const c =
    WEIGHTS.dependence * dep +
    WEIGHTS.appetite * appetite +
    WEIGHTS.reserve * reserve;
  return Math.round(c * 10) / 10;
}

// Zero fundraising machinery: no professional fundraising AND no fundraising
// events. A strong tell that "contributions" are passive government/foundation
// money rather than a cultivated individual donor base. Single-source proxy for
// the government-grant split that otherwise needs the 990 XML. Soft signal, not
// a hard gate: catches pure pass-throughs (Governors Island, C40) but a govt org
// that runs events slips through, and a rare in-house-only fundraiser is a false
// positive.
export function noFundraisingMachinery(latest: Filing): boolean {
  return (latest.profndraising ?? 0) === 0 && (latest.grsincfndrsng ?? 0) === 0;
}

// Sustained deficit: revenue < expenses for 2+ consecutive recent years.
export function sustainedDeficit(filings: Filing[]): boolean {
  const recent = [...filings]
    .sort((a, b) => b.tax_prd_yr - a.tax_prd_yr)
    .slice(0, 2);
  return recent.length === 2 && recent.every((f) => f.totrevenue < f.totfuncexpns);
}
