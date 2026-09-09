// The territory partition: metro x NTEE vertical, agreed 2026-08-27. Ported
// from catsnake-prospect/scripts/apply-territories-migration.ts so the
// nightly stocker assigns a territory the moment an org lands, instead of
// leaving new rows unassigned until someone re-runs the one-time script.
// Keep the two copies identical until the PRD's saved-filter territories
// replace this mapping; sourcing_pool.territory_id is the truth either way.

export function territoryFor(metro: string, ntee: string | null): { name: string; metro: string } {
  if (metro === 'Cleveland') return { name: 'Cleveland nonprofits', metro };
  if (metro === 'Boston') return { name: 'Boston nonprofits', metro };
  const L = (ntee || '?').toUpperCase();
  const l1 = L[0], l2 = L.slice(0, 2);
  const m = metro === 'New York' ? 'NYC' : 'DC';
  if (m === 'NYC') {
    if (['A5', 'A8'].includes(l2)) return { name: 'NYC museums & heritage', metro };
    if (l1 === 'A') return { name: 'NYC arts & performance', metro };
    if (['P2', 'P1', 'P0'].includes(l2)) return { name: 'NYC human services', metro };
    if (l1 === 'P') return { name: 'NYC children, family & aging', metro };
    if (['B2', 'B9', 'B0', 'B3'].includes(l2)) return { name: 'NYC schools & education services', metro };
    if (l1 === 'B') return { name: 'NYC higher ed & education funds', metro };
    if (l2 === 'Q3') return { name: 'NYC international development', metro };
    if (l1 === 'Q') return { name: 'NYC global affairs', metro };
    if (['E', 'G', 'H'].includes(l1)) return { name: 'NYC health & medicine', metro };
    if (l1 === 'F') return { name: 'NYC mental health', metro };
    if (['C', 'D'].includes(l1)) return { name: 'NYC environment & animals', metro };
    if (['L', 'S'].includes(l1)) return { name: 'NYC housing & community', metro };
    if (l1 === 'R') return { name: 'NYC civil rights & advocacy', metro };
    if (['N', 'O'].includes(l1)) return { name: 'NYC youth & recreation', metro };
    if (['T', 'U', 'W'].includes(l1)) return { name: 'NYC philanthropy & public benefit', metro };
    if (l1 === 'X') return { name: 'NYC faith & religion', metro };
    return { name: 'NYC other', metro };
  }
  if (l2 === 'Q3') return { name: 'DC international development', metro };
  if (l1 === 'Q') return { name: 'DC global affairs', metro };
  if (['C', 'D'].includes(l1)) return { name: 'DC environment & animals', metro };
  if (l1 === 'P') return { name: 'DC human services', metro };
  if (l1 === 'R') return { name: 'DC civil rights & advocacy', metro };
  if (['E', 'G', 'H', 'F'].includes(l1)) return { name: 'DC health & medicine', metro };
  return { name: 'DC arts, housing & community', metro };
}

// Any metro the mapping does not know (Philadelphia, Chicago, ...) gets one
// territory per metro until the partition is designed for it. Same rule the
// 8/27 partition used for Cleveland and Boston.
export function territoryNameFor(metro: string, ntee: string | null): string {
  if (['New York', 'Washington DC', 'Cleveland', 'Boston'].includes(metro)) return territoryFor(metro, ntee).name;
  return `${metro} nonprofits`;
}
