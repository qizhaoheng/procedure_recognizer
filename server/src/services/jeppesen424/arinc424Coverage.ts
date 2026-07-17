import type { ProcedureUnderstandingResult } from '../../types/procedure';
import type { SimpleProcedureLeg } from './types';

export type Arinc424CoverageCategory =
  | 'AIRPORT_PRIMARY'
  | 'RUNWAY'
  | 'VHF_NAVAID'
  | 'ILS_NAVAID'
  | 'TERMINAL_WAYPOINT'
  | 'PROCEDURE_LEG';

export interface Arinc424CoverageItem {
  category: Arinc424CoverageCategory;
  sourceCount: number;
  exportedCount: number;
  status: 'COMPLETE' | 'NOT_EXTRACTED' | 'NOT_EXPORTED' | 'PARTIAL';
  message: string;
}

export interface Arinc424CoverageReport {
  releaseScope: 'PROCEDURE_PACKAGE';
  airportComplete: false;
  items: Arinc424CoverageItem[];
  generatedAt: string;
}

/**
 * Reports record-family coverage without pretending that one procedure package
 * is an airport-wide ARINC 424 release.
 */
export function buildArinc424Coverage(
  canonical: ProcedureUnderstandingResult,
  legs: SimpleProcedureLeg[],
  text: string,
  now = new Date().toISOString(),
): Arinc424CoverageReport {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const navaids = Array.isArray(canonical.navaids) ? canonical.navaids : [];
  const source: Record<Arinc424CoverageCategory, number> = {
    AIRPORT_PRIMARY: canonical.airportIcao ? 1 : 0,
    RUNWAY: Array.isArray(canonical.runways) ? canonical.runways.length : 0,
    VHF_NAVAID: navaids.filter((item) => /(?:VOR|TACAN)/i.test(String(item.navaidType ?? item.type ?? ''))).length,
    ILS_NAVAID: navaids.filter((item) => /(?:ILS|LOC|GP|DME)/i.test(String(item.navaidType ?? item.type ?? '')) && !/(?:VOR|TACAN)/i.test(String(item.navaidType ?? item.type ?? ''))).length,
    TERMINAL_WAYPOINT: Array.isArray(canonical.fixes) ? canonical.fixes.length : 0,
    PROCEDURE_LEG: legs.length,
  };
  const exported: Record<Arinc424CoverageCategory, number> = {
    AIRPORT_PRIMARY: count(lines, 'P', 'A'),
    RUNWAY: count(lines, 'P', 'G'),
    VHF_NAVAID: lines.filter((line) => line[4] === 'D' && /V|T/.test(line[27] ?? '')).length,
    ILS_NAVAID: lines.filter((line) => line[4] === 'D' && /I|L|G/.test(line[27] ?? '')).length,
    TERMINAL_WAYPOINT: count(lines, 'P', 'C'),
    PROCEDURE_LEG: lines.filter((line) => line[4] === 'P' && ['D', 'E', 'F'].includes(line[12] ?? '') && line[38] === '1').length,
  };
  const labels: Record<Arinc424CoverageCategory, string> = {
    AIRPORT_PRIMARY: '机场主记录', RUNWAY: '跑道记录', VHF_NAVAID: 'VHF 导航台记录', ILS_NAVAID: 'ILS/LOC/DME 记录',
    TERMINAL_WAYPOINT: '终端航路点记录', PROCEDURE_LEG: '程序航段记录',
  };
  const items = (Object.keys(source) as Arinc424CoverageCategory[]).map((category): Arinc424CoverageItem => {
    const sourceCount = source[category];
    const exportedCount = exported[category];
    const status = sourceCount === 0
      ? 'NOT_EXTRACTED'
      : exportedCount === 0
        ? 'NOT_EXPORTED'
        : exportedCount < sourceCount
          ? 'PARTIAL'
          : 'COMPLETE';
    const message = status === 'COMPLETE'
      ? `${labels[category]}已覆盖 ${exportedCount}/${sourceCount}`
      : status === 'NOT_EXTRACTED'
        ? `${labels[category]}尚未进入当前 canonical`
        : `${labels[category]}仅导出 ${exportedCount}/${sourceCount}`;
    return { category, sourceCount, exportedCount, status, message };
  });
  return { releaseScope: 'PROCEDURE_PACKAGE', airportComplete: false, items, generatedAt: now };
}

function count(lines: string[], section: string, subsection: string) {
  return lines.filter((line) => line[4] === section && line[12] === subsection).length;
}
