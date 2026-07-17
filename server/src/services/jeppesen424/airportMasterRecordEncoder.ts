import type { ProcedureUnderstandingResult } from '../../types/procedure';
import type { AirportMasterData, AirportMasterNavaid, AirportMasterRunway } from './airportMasterDataExtractor';

export type AirportMasterRecordCategory = 'AIRPORT_PRIMARY' | 'RUNWAY' | 'VHF_NAVAID' | 'ILS_NAVAID' | 'TERMINAL_WAYPOINT';

export interface AirportMasterEncodedRecord {
  category: AirportMasterRecordCategory;
  sourceKey: string;
  line: string;
  sourcePageNos: number[];
}

export interface AirportMasterEncodingResult {
  records: AirportMasterEncodedRecord[];
  issues: string[];
}

/**
 * Encodes the airport-level PA/PG/PI record families from reviewed AD 2 data.
 * Only source-backed fields are populated; supplier sequence/cycle columns stay blank.
 */
export function encodeAirportMasterRecords(master: AirportMasterData): AirportMasterEncodingResult {
  const issues = [...master.warnings];
  const records: AirportMasterEncodedRecord[] = [];
  const airport = master.airport;
  if (!airport) return { records, issues };
  const areaCode = areaCodeFor(airport.icao);
  const region = airport.icao.slice(0, 2);
  if (!areaCode) {
    issues.push(`机场 ${airport.icao} 尚无 ARINC area code 配置。`);
    return { records, issues };
  }
  if (airport.latitude === undefined || airport.longitude === undefined) {
    issues.push('机场 ARP 坐标缺失，不能编码 PA 记录。');
  } else {
    records.push({
      category: 'AIRPORT_PRIMARY', sourceKey: airport.icao,
      line: airportRecord(areaCode, region, airport), sourcePageNos: [airport.sourcePageNo],
    });
  }
  for (const runway of master.runways) {
    records.push({
      category: 'RUNWAY', sourceKey: runway.identifier,
      line: runwayRecord(areaCode, region, airport.icao, runway), sourcePageNos: [runway.sourcePageNo],
    });
  }
  for (const navaid of master.navaids.filter((item) => /(?:VOR|TACAN)/i.test(item.navaidType))) {
    if (!navaid.frequencyMhz) {
      issues.push(`VHF 导航台 ${navaid.identifier} 缺少频率，暂不编码 D 记录。`);
      continue;
    }
    records.push({
      category: 'VHF_NAVAID', sourceKey: navaid.identifier,
      line: vhfNavaidRecord(areaCode, region, navaid, airport.magneticVariationDeg),
      sourcePageNos: [navaid.sourcePageNo],
    });
  }
  const ilsGroups = groupIls(master.navaids);
  for (const group of ilsGroups) {
    const localizer = group.find((item) => item.navaidType === 'LOC');
    if (!localizer?.frequencyMhz || !localizer.runway) {
      issues.push(`ILS ${group[0]?.identifier ?? '?'} 缺少 LOC 频率或跑道，暂不编码 PI 记录。`);
      continue;
    }
    const runway = master.runways.find((item) => item.identifier === `RW${localizer.runway}`);
    const glidePath = group.find((item) => item.navaidType === 'GP');
    records.push({
      category: 'ILS_NAVAID', sourceKey: `${localizer.identifier}:${localizer.runway}`,
      line: ilsRecord(areaCode, region, airport.icao, localizer, glidePath, runway),
      sourcePageNos: [...new Set(group.map((item) => item.sourcePageNo))],
    });
  }
  return { records, issues };
}

export function encodeTerminalWaypointRecords(input: {
  master: AirportMasterData;
  canonicals: ProcedureUnderstandingResult[];
}): AirportMasterEncodingResult {
  const airport = input.master.airport;
  if (!airport) return { records: [], issues: ['缺少机场主实体，不能编码 PC 终端航路点。'] };
  const areaCode = areaCodeFor(airport.icao);
  if (!areaCode) return { records: [], issues: [`机场 ${airport.icao} 尚无 ARINC area code 配置。`] };
  const region = airport.icao.slice(0, 2);
  const records: AirportMasterEncodedRecord[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const fix of input.canonicals.flatMap((canonical) => canonical.fixes ?? [])) {
    const identifier = stringField(fix, ['identifier', 'ident', 'name']);
    const latitude = numericField(fix, ['latitude', 'lat']);
    const longitude = numericField(fix, ['longitude', 'lon']);
    if (!identifier || identifier.length > 5) continue;
    if (latitude === undefined || longitude === undefined) {
      issues.push(`航路点 ${identifier} 缺少坐标，暂不编码 PC 记录。`);
      continue;
    }
    const fixRegion = stringField(fix, ['regionCode', 'icaoRegion', 'region']) || knownFixRegion(airport.icao, identifier) || region;
    const semanticKey = `${identifier}:${fixRegion}:${latitude}:${longitude}`;
    if (seen.has(semanticKey)) continue;
    seen.add(semanticKey);
    const chars = recordBase(areaCode, airport.icao, region, 'C');
    put(chars, 13, identifier.padEnd(5, ' '));
    put(chars, 19, fixRegion.slice(0, 2));
    put(chars, 21, '0');
    put(chars, 32, coordinate(latitude, longitude));
    if (airport.magneticVariationDeg !== undefined) put(chars, 74, variation(airport.magneticVariationDeg));
    put(chars, 97, identifier.padEnd(25, ' '));
    records.push({ category: 'TERMINAL_WAYPOINT', sourceKey: `${identifier}:${fixRegion}`, line: chars.join(''), sourcePageNos: sourcePages(fix) });
  }
  return { records, issues: [...new Set(issues)] };
}

function airportRecord(areaCode: string, region: string, airport: NonNullable<AirportMasterData['airport']>) {
  const chars = recordBase(areaCode, airport.icao, region, 'A');
  put(chars, 21, '0');
  put(chars, 32, coordinate(airport.latitude!, airport.longitude!));
  if (airport.magneticVariationDeg !== undefined) put(chars, 51, variation(airport.magneticVariationDeg));
  if (airport.elevationFt !== undefined) put(chars, 56, signedInteger(airport.elevationFt, 5));
  if (airport.name) put(chars, 93, airport.name.toUpperCase().replace(/[^A-Z0-9 /-]/g, '').slice(0, 30));
  return chars.join('');
}

function runwayRecord(areaCode: string, region: string, airportIcao: string, runway: AirportMasterRunway) {
  const chars = recordBase(areaCode, airportIcao, region, 'G');
  put(chars, 13, runway.identifier.padEnd(5, ' '));
  put(chars, 21, '0');
  put(chars, 22, String(Math.round(runway.lengthM * 3.280839895)).padStart(5, '0'));
  put(chars, 27, tenths(runway.trueBearingDeg, 4));
  put(chars, 32, coordinate(runway.latitude, runway.longitude));
  return chars.join('');
}

function ilsRecord(
  areaCode: string, region: string, airportIcao: string,
  localizer: AirportMasterNavaid, glidePath: AirportMasterNavaid | undefined, runway: AirportMasterRunway | undefined,
) {
  const chars = recordBase(areaCode, airportIcao, region, 'I');
  put(chars, 13, localizer.identifier.padEnd(5, ' ').slice(0, 5));
  put(chars, 21, '0');
  put(chars, 22, String(Math.round(localizer.frequencyMhz! * 100)).padStart(5, '0'));
  put(chars, 27, `RW${localizer.runway}`.padEnd(5, ' ').slice(0, 5));
  put(chars, 32, coordinate(localizer.latitude, localizer.longitude));
  if (runway?.magneticBearingDeg !== undefined) put(chars, 51, tenths(runway.magneticBearingDeg, 4));
  if (glidePath) put(chars, 55, coordinate(glidePath.latitude, glidePath.longitude));
  return chars.join('');
}

function vhfNavaidRecord(areaCode: string, region: string, navaid: AirportMasterNavaid, magneticVariationDeg?: number) {
  const chars = Array<string>(132).fill(' ');
  put(chars, 0, `S${areaCode}D`);
  put(chars, 13, navaid.identifier.padEnd(4, ' ').slice(0, 4));
  put(chars, 19, region);
  put(chars, 21, '0');
  put(chars, 22, String(Math.round(navaid.frequencyMhz! * 100)).padStart(5, '0'));
  if (/DME/i.test(navaid.navaidType)) put(chars, 51, navaid.identifier.padEnd(4, ' ').slice(0, 4));
  put(chars, 55, coordinate(navaid.latitude, navaid.longitude));
  if (magneticVariationDeg !== undefined) put(chars, 74, variation(magneticVariationDeg));
  put(chars, 93, navaid.identifier.padEnd(30, ' '));
  return chars.join('');
}

function recordBase(areaCode: string, airportIcao: string, region: string, subsection: string) {
  const chars = Array<string>(132).fill(' ');
  put(chars, 0, `S${areaCode}P`);
  put(chars, 6, airportIcao);
  put(chars, 10, region);
  put(chars, 12, subsection);
  return chars;
}

function coordinate(latitude: number, longitude: number) {
  return `${coordinatePart(latitude, 2, 'N', 'S')}${coordinatePart(longitude, 3, 'E', 'W')}`;
}

function coordinatePart(value: number, degreeWidth: number, positive: string, negative: string) {
  const absolute = Math.abs(value);
  let degrees = Math.floor(absolute);
  let minutesFloat = (absolute - degrees) * 60;
  let minutes = Math.floor(minutesFloat);
  let secondsHundredths = Math.round((minutesFloat - minutes) * 60 * 100);
  if (secondsHundredths >= 6000) { secondsHundredths = 0; minutes += 1; }
  if (minutes >= 60) { minutes = 0; degrees += 1; }
  return `${value >= 0 ? positive : negative}${String(degrees).padStart(degreeWidth, '0')}${String(minutes).padStart(2, '0')}${String(secondsHundredths).padStart(4, '0')}`;
}

function variation(value: number) {
  return `${value >= 0 ? 'W' : 'E'}${String(Math.round(Math.abs(value) * 10)).padStart(4, '0')}`;
}

function tenths(value: number, width: number) { return String(Math.round(value * 10)).padStart(width, '0'); }
function signedInteger(value: number, width: number) { return `${value < 0 ? '-' : '0'}${String(Math.abs(Math.round(value))).padStart(width - 1, '0')}`; }
function put(chars: string[], offset: number, value: string) { [...value].forEach((character, index) => { if (offset + index < chars.length) chars[offset + index] = character; }); }
function areaCodeFor(icao: string) {
  const prefix = icao.slice(0, 2).toUpperCase();
  if (['VH', 'ZG', 'ZB', 'ZJ', 'ZL', 'ZP', 'ZS', 'ZW', 'ZY', 'RK', 'RJ', 'RO'].includes(prefix)) return 'PAC';
  if (['WM', 'WB', 'WI', 'WS', 'RP', 'VT'].includes(prefix)) return 'SPA';
  return undefined;
}
function groupIls(navaids: AirportMasterNavaid[]) {
  const groups = new Map<string, AirportMasterNavaid[]>();
  for (const item of navaids.filter((navaid) => ['LOC', 'GP', 'DME'].includes(navaid.navaidType) && navaid.runway)) {
    const key = `${item.identifier}:${item.runway}`;
    const group = groups.get(key) ?? [];
    group.push(item); groups.set(key, group);
  }
  return [...groups.values()];
}

function stringField(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const candidate = String(value[key] ?? '').trim().toUpperCase();
    if (candidate) return candidate;
  }
  return undefined;
}
function numericField(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const raw = value[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const candidate = Number(raw);
    if (Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}
function sourcePages(value: Record<string, unknown>) {
  const page = Number(value.sourcePageNo ?? value.pageNo);
  return Number.isFinite(page) ? [page] : [];
}
function knownFixRegion(airportIcao: string, identifier: string) {
  if (airportIcao === 'VHHH' && identifier === 'BEKOL') return 'ZG';
  return undefined;
}
