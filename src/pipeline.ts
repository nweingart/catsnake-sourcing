// Turns a raw ProPublica org-detail response into a scored prospect, applying
// every gate. Returns null if the org fails any gate. Shared by ingest + PoC.

import {
  Filing,
  causeIncluded,
  sizeGate,
  donationFloorPass,
  donationRatio,
  donationScore,
  appetiteScore,
  reserveScore,
  composite,
  sustainedDeficit,
  noFundraisingMachinery,
} from './scoring';
import { inMetro, metroOf } from './geo';

const num = (v: any) => (typeof v === 'number' ? v : Number(v) || 0);

const NO_FUNDRAISING_PENALTY = 0.6;

export interface ScoredOrg {
  ein: number;
  name: string;
  ntee: string;
  city: string;
  state: string;
  metro: string;
  revenue: number;
  programRev: number;
  ratio: number;
  depScore: number;
  appScore: number;
  resScore: number;
  rawFit: number;
  fit: number;
  cagr: number | null;
  months: number | null;
  outsources: boolean;
  profnd: number;
  noFundraising: boolean;
  deficit: boolean;
  lowConfidence: boolean;
}

export function toFilings(detail: any): Filing[] {
  const filings: Filing[] = (detail.filings_with_data ?? []).map((f: any) => ({
    tax_prd_yr: num(f.tax_prd_yr),
    totrevenue: num(f.totrevenue),
    totcntrbgfts: num(f.totcntrbgfts),
    totprgmrevnue: num(f.totprgmrevnue),
    totfuncexpns: num(f.totfuncexpns),
    totnetassetend: num(f.totnetassetend),
    profndraising: num(f.profndraising),
    grsincfndrsng: num(f.grsincfndrsng),
  }));
  filings.sort((a, b) => b.tax_prd_yr - a.tax_prd_yr);
  return filings;
}

export function scoreOrg(detail: any): ScoredOrg | null {
  const org = detail.organization ?? {};
  if (!causeIncluded(org.ntee_code)) return null;

  const filings = toFilings(detail);
  if (filings.length === 0) return null;
  const latest = filings[0];

  if (!sizeGate(latest.totrevenue)) return null;
  if (!donationFloorPass(latest, org.ntee_code)) return null;
  if (!inMetro(org.zipcode)) return null;

  const ratio = donationRatio(latest);
  const dep = donationScore(ratio);
  const app = appetiteScore(filings);
  const res = reserveScore(latest.totnetassetend, latest.totfuncexpns);
  const rawFit = composite(dep, app.score, res.score);
  const noFundraising = noFundraisingMachinery(latest);
  const fit = noFundraising
    ? Math.round(rawFit * NO_FUNDRAISING_PENALTY * 10) / 10
    : rawFit;

  return {
    ein: num(org.ein),
    name: org.name,
    ntee: org.ntee_code,
    city: org.city,
    state: org.state,
    metro: metroOf(org.zipcode) ?? 'Unknown',
    revenue: latest.totrevenue,
    programRev: latest.totprgmrevnue,
    ratio,
    depScore: dep,
    appScore: app.score,
    resScore: res.score,
    rawFit,
    fit,
    cagr: app.cagr,
    months: res.months,
    outsources: app.outsourcesFundraising,
    profnd: latest.profndraising,
    noFundraising,
    deficit: sustainedDeficit(filings),
    lowConfidence: app.lowConfidence,
  };
}
