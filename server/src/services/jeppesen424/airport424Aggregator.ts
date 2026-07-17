import type { ProcedureUnderstandingResult } from '../../types/procedure';
import type { Arinc424CoverageCategory, Arinc424CoverageItem } from './arinc424Coverage';
import type { AirportMasterData } from './airportMasterDataExtractor';
import { encodeAirportMasterRecords, encodeTerminalWaypointRecords } from './airportMasterRecordEncoder';

export interface Airport424PackageReleaseInput {
  packageId: string;
  packageName: string;
  releaseId: string;
  runId: string;
  text: string;
  canonical: ProcedureUnderstandingResult;
}

export interface Airport424MissingPackage {
  packageId: string;
  packageName: string;
  reason: 'NO_ACTIVE_RELEASE';
}

export interface Airport424Conflict {
  recordKey: string;
  packageIds: string[];
  lines: string[];
  message: string;
}

export interface Airport424Aggregate {
  releaseScope: 'AIRPORT';
  airportIcao?: string;
  airportComplete: boolean;
  publishable: boolean;
  packageCount: number;
  activeReleaseCount: number;
  packageReleases: Array<{ packageId: string; packageName: string; releaseId: string; runId: string }>;
  missingPackages: Airport424MissingPackage[];
  conflicts: Airport424Conflict[];
  coverage: Arinc424CoverageItem[];
  text: string;
  lineCount: number;
  duplicateLineCount: number;
  masterEncodingIssues: string[];
  generatedAt: string;
}

/**
 * Builds an airport-wide view from immutable, active procedure-package releases.
 * Conflicting fixed-width records are retained and block airport publication.
 */
export function aggregateAirport424(input: {
  packages: Array<{ packageId: string; packageName: string }>;
  releases: Airport424PackageReleaseInput[];
  masterData?: AirportMasterData;
  now?: string;
}): Airport424Aggregate {
  const now = input.now ?? new Date().toISOString();
  const releaseByPackage = new Map(input.releases.map((release) => [release.packageId, release]));
  const missingPackages = input.packages
    .filter((item) => !releaseByPackage.has(item.packageId))
    .map((item) => ({ ...item, reason: 'NO_ACTIVE_RELEASE' as const }));
  const airportCodes = unique([
    normalize(input.masterData?.airport?.icao),
    ...input.releases.map((item) => normalize(item.canonical.airportIcao)),
  ].filter(Boolean));

  const recordVariants = new Map<string, Array<{ packageId: string; line: string }>>();
  let sourceLineCount = 0;
  const masterEncoding = input.masterData ? encodeAirportMasterRecords(input.masterData) : { records: [], issues: [] };
  const waypointEncoding = input.masterData ? encodeTerminalWaypointRecords({ master: input.masterData, canonicals: input.releases.map((item) => item.canonical) }) : { records: [], issues: [] };
  for (const record of [...masterEncoding.records, ...waypointEncoding.records]) {
    sourceLineCount += 1;
    recordVariants.set(arincRecordIdentity(record.line), [{ packageId: `MASTER:${record.sourceKey}`, line: record.line }]);
  }
  for (const release of input.releases) {
    for (const rawLine of release.text.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      sourceLineCount += 1;
      const line = rawLine.padEnd(132, ' ').slice(0, 132);
      const key = arincRecordIdentity(line);
      const variants = recordVariants.get(key) ?? [];
      if (!variants.some((item) => arincSemanticContent(item.line) === arincSemanticContent(line))) {
        variants.push({ packageId: release.packageId, line: `${arincSemanticContent(line)}${' '.repeat(9)}` });
      }
      recordVariants.set(key, variants);
    }
  }
  const conflicts: Airport424Conflict[] = [];
  const lines: string[] = [];
  for (const [recordKey, variants] of recordVariants) {
    lines.push(...variants.map((item) => item.line));
    if (variants.length > 1) {
      conflicts.push({
        recordKey,
        packageIds: unique(variants.map((item) => item.packageId)),
        lines: variants.map((item) => item.line),
        message: `同一 424 记录身份出现 ${variants.length} 个不同版本，必须解决后才能机场级发布。`,
      });
    }
  }
  lines.sort(compareArincLines);

  const coverage = buildAirportCoverage(input.releases, lines, input.masterData);
  const coverageComplete = coverage.every((item) => item.status === 'COMPLETE');
  const airportComplete = airportCodes.length === 1
    && input.packages.length > 0
    && missingPackages.length === 0
    && conflicts.length === 0
    && coverageComplete;
  return {
    releaseScope: 'AIRPORT',
    airportIcao: airportCodes.length === 1 ? airportCodes[0] : undefined,
    airportComplete,
    publishable: airportComplete,
    packageCount: input.packages.length,
    activeReleaseCount: input.releases.length,
    packageReleases: input.releases.map(({ packageId, packageName, releaseId, runId }) => ({ packageId, packageName, releaseId, runId })),
    missingPackages,
    conflicts,
    coverage,
    text: lines.length ? `${lines.join('\n')}\n` : '',
    lineCount: lines.length,
    duplicateLineCount: Math.max(0, sourceLineCount - lines.length),
    masterEncodingIssues: [...new Set([...masterEncoding.issues, ...waypointEncoding.issues])],
    generatedAt: now,
  };
}

function buildAirportCoverage(releases: Airport424PackageReleaseInput[], lines: string[], masterData?: AirportMasterData): Arinc424CoverageItem[] {
  const canonicals = releases.map((item) => item.canonical);
  const sourceCounts: Record<Arinc424CoverageCategory, number> = {
    AIRPORT_PRIMARY: masterData?.airport ? 1 : unique(canonicals.map((item) => normalize(item.airportIcao)).filter(Boolean)).length,
    RUNWAY: masterData?.runways.length ?? unique(canonicals.flatMap((item) => (item.runways ?? []).map((runway) => entityKey(runway, ['identifier', 'runway', 'runwayIdentifier'])))).length,
    VHF_NAVAID: masterData
      ? masterData.navaids.filter((navaid) => /(?:VOR|TACAN)/i.test(navaid.navaidType)).length
      : unique(canonicals.flatMap((item) => (item.navaids ?? [])
        .filter((navaid) => /(?:VOR|TACAN)/i.test(String(navaid.navaidType ?? navaid.type ?? '')))
        .map((navaid) => entityKey(navaid, ['identifier', 'ident', 'name'])))).length,
    ILS_NAVAID: masterData
      ? unique(masterData.navaids.filter((navaid) => ['LOC', 'GP', 'DME'].includes(navaid.navaidType) && navaid.runway).map((navaid) => `${navaid.identifier}:${navaid.runway}`)).length
      : unique(canonicals.flatMap((item) => (item.navaids ?? [])
      .filter((navaid) => /(?:ILS|LOC|GP|DME)/i.test(String(navaid.navaidType ?? navaid.type ?? '')) && !/(?:VOR|TACAN)/i.test(String(navaid.navaidType ?? navaid.type ?? '')))
      .map((navaid) => entityKey(navaid, ['identifier', 'ident', 'name'])))).length,
    TERMINAL_WAYPOINT: unique(canonicals.flatMap((item) => (item.fixes ?? []).map((fix) => entityKey(fix, ['identifier', 'ident', 'name'])))).length,
    PROCEDURE_LEG: unique(canonicals.flatMap((item) => (item.procedures ?? []).flatMap((procedure) =>
      (procedure.legs ?? []).map((leg, index) => `${normalize(procedure.procedureName)}:${index}:${entityKey(leg, ['fixIdentifier', 'fix', 'identifier'])}`),
    ))).length,
  };
  const exportedCounts: Record<Arinc424CoverageCategory, number> = {
    AIRPORT_PRIMARY: count(lines, 'P', 'A'),
    RUNWAY: count(lines, 'P', 'G'),
    VHF_NAVAID: lines.filter((line) => line[4] === 'D').length,
    ILS_NAVAID: count(lines, 'P', 'I'),
    TERMINAL_WAYPOINT: count(lines, 'P', 'C'),
    PROCEDURE_LEG: lines.filter((line) => line[4] === 'P' && ['D', 'E', 'F'].includes(line[12] ?? '') && line[38] === '1').length,
  };
  const labels: Record<Arinc424CoverageCategory, string> = {
    AIRPORT_PRIMARY: '机场主记录', RUNWAY: '跑道记录', VHF_NAVAID: 'VHF 导航台记录', ILS_NAVAID: 'ILS/LOC/DME 记录',
    TERMINAL_WAYPOINT: '终端航路点记录', PROCEDURE_LEG: '程序航段记录',
  };
  return (Object.keys(sourceCounts) as Arinc424CoverageCategory[]).map((category) => {
    const sourceCount = sourceCounts[category];
    const exportedCount = exportedCounts[category];
    const status = sourceCount === 0
      ? 'NOT_EXTRACTED' as const
      : exportedCount === 0
        ? 'NOT_EXPORTED' as const
        : exportedCount < sourceCount
          ? 'PARTIAL' as const
          : 'COMPLETE' as const;
    return {
      category,
      sourceCount,
      exportedCount,
      status,
      message: status === 'COMPLETE'
        ? `${labels[category]}已覆盖 ${exportedCount}/${sourceCount}`
        : status === 'NOT_EXTRACTED'
          ? `${labels[category]}尚未从机场 AIP 主表进入 canonical`
          : `${labels[category]}仅导出 ${exportedCount}/${sourceCount}`,
    };
  });
}

function arincRecordIdentity(line: string) {
  // The first 40 columns carry the record family, airport/procedure, route,
  // sequence/fix and continuation identity used by records emitted today.
  // Remaining semantic columns are values: differences there are conflicts.
  return (line[4] === 'P' && ['A', 'C', 'G', 'I'].includes(line[12] ?? '')) || line[4] === 'D'
    ? line.slice(0, 22)
    : line.slice(0, 40);
}

function arincSemanticContent(line: string) {
  // Columns 124-132 are supplier file/record/cycle metadata, not aeronautical
  // content. Airport aggregation deliberately does not copy supplier metadata.
  return line.slice(0, 123);
}

function compareArincLines(a: string, b: string) {
  return arincRecordIdentity(a).localeCompare(arincRecordIdentity(b)) || a.localeCompare(b);
}

function count(lines: string[], section: string, subsection: string) {
  return lines.filter((line) => line[4] === section && line[12] === subsection).length;
}

function entityKey(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const candidate = normalize(value[key]);
    if (candidate) return candidate;
  }
  const latitude = value.latitude ?? value.lat;
  const longitude = value.longitude ?? value.lon;
  return latitude !== undefined && longitude !== undefined ? `${latitude}:${longitude}` : JSON.stringify(value);
}

function normalize(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}
