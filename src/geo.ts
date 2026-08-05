// Multi-metro geo gate.
//
// v0 uses 3-digit ZIP prefixes (ZIP3) as an approximate metro filter. Good
// enough to prove the loop; a few ZIP3 zones straddle metro/suburb lines.
// Tighten later with a Census/HUD ZIP-to-county crosswalk if precision matters.
//
// Each metro lists the states to search (search has no county/zip param, so we
// search whole states and filter on ZIP3 after the detail fetch) and its ZIP3
// prefixes. Coverage favors principal cities + major suburbs where $15M+ orgs
// concentrate; small outer suburbs may be missed (acceptable v0 tradeoff).

export interface Metro {
  name: string;
  states: string[];
  zip3: string[];
}

export const METROS: Metro[] = [
  {
    name: 'New York',
    states: ['NY', 'NJ'],
    zip3: [
      // NYC five boroughs
      '100', '101', '102', '103', '104', '110', '111', '112', '113', '114', '116',
      // Westchester
      '105', '106', '107', '108',
      // Nassau + Suffolk
      '115', '117', '118', '119',
      // NJ: Bergen, Hudson, Essex, Union
      '070', '071', '072', '073', '074', '075', '076',
    ],
  },
  {
    name: 'Boston',
    states: ['MA'],
    zip3: ['017', '018', '019', '020', '021', '022', '023', '024', '025'],
  },
  {
    name: 'Philadelphia',
    states: ['PA', 'NJ'],
    zip3: ['190', '191', '193', '194', '080', '081'],
  },
  {
    name: 'Washington DC',
    states: ['DC', 'MD', 'VA'],
    zip3: [
      '200', '202', '203', '204', '205', // DC
      '206', '207', '208', '209',        // suburban MD (Montgomery, Prince George's)
      '220', '221', '222', '223',        // Northern VA (Arlington, Alexandria, Fairfax)
    ],
  },
  {
    name: 'Cleveland',
    states: ['OH'],
    zip3: ['440', '441'],
  },
  {
    name: 'Detroit',
    states: ['MI'],
    zip3: ['480', '481', '482', '483'],
  },
  {
    name: 'Chicago',
    states: ['IL'],
    zip3: ['600', '601', '604', '605', '606'],
  },
  {
    name: 'San Francisco',
    states: ['CA'],
    zip3: ['940', '941', '943', '944', '945', '946', '947', '948', '949', '950'],
  },
  {
    name: 'Los Angeles',
    states: ['CA'],
    zip3: [
      '900', '901', '902', '903', '904', '905', '906', '907', '908',
      '910', '911', '912', '913', '914', '915', '916', '917', '918',
    ],
  },
  { name: 'Seattle', states: ['WA'], zip3: ['980', '981', '982', '983', '984'] },
  { name: 'Minneapolis-St. Paul', states: ['MN'], zip3: ['550', '551', '553', '554', '555'] },
  { name: 'Atlanta', states: ['GA'], zip3: ['300', '301', '302', '303', '311'] },
  { name: 'Baltimore', states: ['MD'], zip3: ['210', '211', '212'] },
  { name: 'Denver', states: ['CO'], zip3: ['800', '801', '802', '803', '804'] },
  { name: 'San Diego', states: ['CA'], zip3: ['919', '920', '921'] },
  { name: 'Pittsburgh', states: ['PA'], zip3: ['150', '151', '152'] },
  { name: 'Houston', states: ['TX'], zip3: ['770', '772', '773', '774', '775'] },
  { name: 'Dallas-Fort Worth', states: ['TX'], zip3: ['750', '751', '752', '753', '760', '761'] },
  { name: 'Miami', states: ['FL'], zip3: ['330', '331', '332', '333', '334'] },
  { name: 'Portland', states: ['OR'], zip3: ['970', '971', '972'] },
];

// All states to search (deduped union across metros).
export const SEARCH_STATES: string[] = [
  ...new Set(METROS.flatMap((m) => m.states)),
];

// All in-metro ZIP3 prefixes (deduped union).
const METRO_ZIP3 = new Set<string>(METROS.flatMap((m) => m.zip3));

export function inMetro(zip: string | null | undefined): boolean {
  if (!zip) return false;
  const z3 = String(zip).replace(/[^0-9]/g, '').slice(0, 3).padStart(3, '0');
  return METRO_ZIP3.has(z3);
}

// Which metro a zip belongs to (first match), for reporting. Null if none.
export function metroOf(zip: string | null | undefined): string | null {
  if (!zip) return null;
  const z3 = String(zip).replace(/[^0-9]/g, '').slice(0, 3).padStart(3, '0');
  for (const m of METROS) if (m.zip3.includes(z3)) return m.name;
  return null;
}
