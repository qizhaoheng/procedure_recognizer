import type { PdfPageAsset } from '../../types/procedure';
import { parseAipCoordinatePair } from '../recognition-v2/coordinates/coordinateParser';

export interface AirportMasterAirport {
  icao: string;
  name?: string;
  arpRaw?: string;
  latitude?: number;
  longitude?: number;
  elevationFt?: number;
  magneticVariationDeg?: number;
  sourcePageNo: number;
}

export interface AirportMasterRunway {
  identifier: string;
  trueBearingDeg: number;
  magneticBearingDeg?: number;
  lengthM: number;
  widthM: number;
  surface?: string;
  thresholdRaw: string;
  latitude: number;
  longitude: number;
  thresholdElevationFt?: number;
  sourcePageNo: number;
}

export interface AirportMasterNavaid {
  facility: string;
  runway?: string;
  identifier: string;
  navaidType: string;
  ilsCategory?: 1 | 2 | 3;
  frequencyMhz?: number;
  channel?: string;
  coordinateRaw: string;
  latitude: number;
  longitude: number;
  sourcePageNo: number;
}

export interface AirportMasterData {
  airport?: AirportMasterAirport;
  runways: AirportMasterRunway[];
  navaids: AirportMasterNavaid[];
  warnings: string[];
}

/** Deterministic extraction of airport-wide master records from ICAO AIP AD 2. */
export function extractAirportMasterData(pages: PdfPageAsset[]): AirportMasterData {
  const warnings: string[] = [];
  const airportPages = pages.filter((page) => /AD\s*2\.?1\b|AERODROME LOCATION INDICATOR AND NAME/i.test(text(page)));
  const runwayPages = pages.filter((page) => /AD\s*2\.?12\b|RUNWAY PHYSICAL CHARACTERISTICS|TRUE\s+AND\s+MAG\s+BRG[\s\S]{0,120}DIMENSIONS\s+OF\s+RWY/i.test(text(page)));
  const navaidPages = pages.filter((page) => /AD\s*2\.?19\b|RADIO NAVIGATION AND LANDING AIDS|TYPE\s+OF\s+AID[\s\S]{0,100}\bID\b[\s\S]{0,100}FREQUENCY|NAVAID\s+FREQUENCY\s+COORDINATES/i.test(text(page)));
  const airport = airportPages.map(extractAirport).find(Boolean);
  const runways = dedupe(runwayPages.flatMap(extractRunways), (item) => item.identifier);
  const navaids = dedupe(navaidPages.flatMap(extractNavaids), (item) => `${item.facility}:${item.identifier}:${item.coordinateRaw}`);
  if (!airport) warnings.push('未从 AD 2.1/2.2 提取机场主数据。');
  if (!runways.length) warnings.push('未从 AD 2.12 提取跑道物理数据。');
  if (!navaids.length) warnings.push('未从 AD 2.19 提取导航台/着陆设施数据。');
  return { airport, runways, navaids, warnings };
}

function extractAirport(page: PdfPageAsset): AirportMasterAirport | undefined {
  const value = compact(page);
  const icao = value.match(/\b([A-Z]{4})\s+AD\s*2\.?1\b/i)?.[1]?.toUpperCase();
  if (!icao) return undefined;
  const name = value.match(new RegExp(`\\b${icao}\\s*-\\s*(.+?)(?=\\s+${icao}\\s+AD\\s*2\\.?2\\b)`, 'i'))?.[1]?.trim();
  const arpMatch = value.match(/\b\d{6}(?:\.\d+)?[NS]\s+\d{7}(?:\.\d+)?[EW]\b/i)?.[0];
  const coordinate = arpMatch ? parseAipCoordinatePair(arpMatch) : undefined;
  const elevationFt = number(value.match(/Elevation\/Reference temperature\s+(\d+(?:\.\d+)?)\s*FT/i)?.[1]);
  const variation = value.match(/(?:MAG\s*VAR|MAGNETIC VARIATION)[^0-9]{0,20}(\d+(?:\.\d+)?)\s*(?:Â?°|DEG)?\s*([EW])/i);
  return {
    icao, name, arpRaw: arpMatch,
    latitude: coordinate?.latitude, longitude: coordinate?.longitude,
    elevationFt,
    magneticVariationDeg: variation ? signedVariation(Number(variation[1]), variation[2]) : undefined,
    sourcePageNo: page.pageNo,
  };
}

function extractRunways(page: PdfPageAsset): AirportMasterRunway[] {
  const value = compact(page);
  const regex = /(?:\bRWY\s+)?\b(\d{2}[LRC]?)\s+(\d{3}(?:\.\d+)?)\s*(?:Â?°|掳|DEG)?\s*T\s+(\d{3}(?:\.\d+)?)\s*(?:Â?°|掳|DEG)?\s*M\s+(\d{3,4})\s*[xX×]\s*(\d{2,3})\b([\s\S]{0,240}?)\b(\d{6}(?:\.\d+)?[NS]\s+\d{7}(?:\.\d+)?[EW])\b\s*(\d+(?:\.\d+)?)?\s*FT/gi;
  const result: AirportMasterRunway[] = [];
  for (const match of value.matchAll(regex)) {
    const coordinate = parseAipCoordinatePair(match[7]);
    if (!coordinate) continue;
    result.push({
      identifier: `RW${match[1].toUpperCase()}`,
      trueBearingDeg: Number(match[2]), magneticBearingDeg: Number(match[3]),
      lengthM: Number(match[4]), widthM: Number(match[5]),
      surface: match[6].match(/\b(ASPHALT|CONCRETE|BITUMEN|GRASS)\b/i)?.[1]?.toUpperCase(),
      thresholdRaw: match[7], latitude: coordinate.latitude, longitude: coordinate.longitude,
      thresholdElevationFt: number(match[8]), sourcePageNo: page.pageNo,
    });
  }
  return result;
}

function extractNavaids(page: PdfPageAsset): AirportMasterNavaid[] {
  const value = compact(page);
  const regex = /\b((?:DME|GP|LOC)\s*\d{2}[LRC]?|VOR\/DME|VOR|TACAN|NDB)\b(?:\s+CAT\s+([IVX]+))?\s+([A-Z0-9]{2,5})\s+(?:(CH\s*\d+[XY])|(\d{3}(?:\.\d+)?)\s*MHZ|(\d{3,4})\s*KHZ)[\s\S]{0,80}?\b(\d{6}(?:\.\d+)?[NS]\s+\d{7}(?:\.\d+)?[EW])\b/gi;
  const result: AirportMasterNavaid[] = [];
  for (const match of value.matchAll(regex)) {
    const coordinate = parseAipCoordinatePair(match[7]);
    if (!coordinate) continue;
    const facility = match[1].replace(/\s+/g, '').toUpperCase();
    result.push({
      facility,
      runway: facility.match(/(?:DME|GP|LOC)(\d{2}[LRC]?)/)?.[1],
      identifier: match[3].toUpperCase(),
      navaidType: facility.startsWith('LOC') ? 'LOC' : facility.startsWith('GP') ? 'GP' : facility.startsWith('DME') ? 'DME' : facility,
      ilsCategory: ilsCategory(match[2]),
      frequencyMhz: number(match[5]),
      channel: match[4]?.replace(/\s+/g, '').toUpperCase(),
      coordinateRaw: match[7], latitude: coordinate.latitude, longitude: coordinate.longitude,
      sourcePageNo: page.pageNo,
    });
  }
  const procedureTableRegex = /\b([A-Z0-9]{2,5})\s+(D?VOR\/DME|VOR|TACAN|DME|LOC)\s+(?:(\d{3}(?:\.\d+)?)\s*MHZ(?:\s*\(?\s*(CH\s*\d+[XY])\s*\)?)?|(CH\s*\d+[XY]))[\s\S]{0,40}?\b(\d{6}(?:\.\d+)?[NS]\s+\d{7}(?:\.\d+)?[EW])\b/gi;
  for (const match of value.matchAll(procedureTableRegex)) {
    const coordinate = parseAipCoordinatePair(match[6]);
    if (!coordinate) continue;
    const navaidType = match[2].toUpperCase();
    result.push({
      facility: navaidType,
      identifier: match[1].toUpperCase(),
      navaidType,
      frequencyMhz: number(match[3]),
      channel: (match[4] || match[5])?.replace(/\s+/g, '').toUpperCase(),
      coordinateRaw: match[6], latitude: coordinate.latitude, longitude: coordinate.longitude,
      sourcePageNo: page.pageNo,
    });
  }
  return result;
}

function text(page: PdfPageAsset) { return page.textLayerText || page.ocrText || ''; }
function compact(page: PdfPageAsset) { return text(page).replace(/\s+/g, ' ').trim(); }
function number(value?: string) { const parsed = value === undefined ? undefined : Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function signedVariation(value: number, hemisphere: string) { return /W/i.test(hemisphere) ? value : -value; }
function ilsCategory(value?: string): 1 | 2 | 3 | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  return normalized === 'I' ? 1 : normalized === 'II' ? 2 : normalized === 'III' ? 3 : undefined;
}
function dedupe<T>(values: T[], key: (value: T) => string) { return [...new Map(values.map((value) => [key(value), value])).values()]; }
