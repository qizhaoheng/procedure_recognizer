export interface Arinc424ProfileInput {
  airportIcao: string;
  packageType?: string;
  navigationType?: string;
}

export interface Arinc424Profile {
  areaCode: string;
  terminalSection: 'D' | 'E' | 'F';
  runwayRouteType: string;
  fixRegionOverrides: Record<string, string>;
}

const PAC_PREFIXES = new Set(['VH', 'ZG', 'ZB', 'ZJ', 'ZL', 'ZP', 'ZS', 'ZW', 'ZY', 'RK', 'RJ', 'RO']);
const SPA_PREFIXES = new Set(['WM', 'WB', 'WI', 'WS', 'RP', 'VT']);

// This registry is navigation master data, not recognition logic. It is deliberately
// isolated so future AIRAC/master-data imports can replace the checked-in seed values.
const FIX_REGION_OVERRIDES: Record<string, Record<string, string>> = {
  VHHH: { BEKOL: 'ZG' },
};

export function resolveArinc424Profile(input: Arinc424ProfileInput): Arinc424Profile {
  const airport = input.airportIcao.trim().toUpperCase();
  const prefix = airport.slice(0, 2);
  const packageType = String(input.packageType ?? '').trim().toUpperCase();
  const navigationType = String(input.navigationType ?? '').trim().toUpperCase();
  const areaCode = PAC_PREFIXES.has(prefix) ? 'PAC' : SPA_PREFIXES.has(prefix) ? 'SPA' : '';
  if (!areaCode) throw new Error(`Cannot export production 424: no ARINC area profile is configured for ${airport}.`);
  const terminalSection = packageType === 'SID' ? 'D' : packageType === 'STAR' ? 'E' : packageType === 'APPROACH' ? 'F' : undefined;
  if (!terminalSection) throw new Error(`Cannot export production 424: package type ${packageType || '(missing)'} has no terminal subsection.`);

  // VHHH RNAV SID source records use the N runway-route qualifier. Other
  // supported profiles retain the established runway route type until their
  // AIRAC profile supplies a more specific value.
  const runwayRouteType = airport === 'VHHH' && packageType === 'SID' && ['RNAV', 'RNP', 'RNP_AR'].includes(navigationType)
    ? 'N'
    : '2';
  return { areaCode, terminalSection, runwayRouteType, fixRegionOverrides: FIX_REGION_OVERRIDES[airport] ?? {} };
}
