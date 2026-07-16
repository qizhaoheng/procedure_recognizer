import type { PdfPageAsset } from '../../../types/procedure';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type NormalizedBbox,
  type PageLayoutResult,
  type PageRole,
} from '../contracts/index';

export function analyzePageLayoutWithRules(page: PdfPageAsset): PageLayoutResult {
  const text = `${page.textLayerText ?? ''}\n${page.ocrText ?? ''}`.toUpperCase();
  const roles = new Set<PageRole>();
  addLegacyRole(roles, page.chartRole);
  if (/STANDARD\s+(?:ARRIVAL|DEPARTURE)\s+CHART|INSTRUMENT\s+APPROACH\s+CHART/.test(text)) roles.add('PROCEDURE_TITLE');
  if (/TABULAR\s+DESCRIPTION|CODING\s+TABLE|AERONAUTICAL\s+DATA\s+TABULATION/.test(text)) roles.add('PROCEDURE_LEG_TABLE');
  if (/WAYPOINT\s+COORDINATES|LATITUDE\s+LONGITUDE/.test(text)) roles.add('WAYPOINT_COORDINATE_TABLE');
  if (/NOTES?|REMARKS?|RESTRICTIONS?/.test(text)) roles.add('PROCEDURE_NOTES');
  if (/MINIMUM\s+SECTOR\s+ALTITUDE|\bMSA\b/.test(text)) roles.add('MSA');
  if (/PROFILE\s+VIEW|OCA\/?H|DA\/?H|MDA\/?H/.test(text)) roles.add('PROFILE_VIEW');
  if (/MINIMA|OCA\/?H|DA\/?H|MDA\/?H/.test(text)) roles.add('MINIMA_TABLE');
  if (!roles.size) roles.add('UNKNOWN');

  const pageRoles = [...roles].filter((role) => role !== 'UNKNOWN' || roles.size === 1);
  const regions = pageRoles.map((role, index) => {
    const bbox = ruleBbox(role, pageRoles.length);
    const exactWholePage = pageRoles.length === 1 && isWholePageRole(role);
    return {
      regionId: `p${page.pageNo}-rule-${index + 1}`,
      pageNo: page.pageNo,
      type: role,
      bbox,
      rotationDeg: 0 as const,
      readingOrder: index,
      confidence: exactWholePage ? 0.86 : role === 'UNKNOWN' ? 0.2 : 0.62,
      reviewRequired: !exactWholePage,
    };
  });
  return {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.pageLayoutResult,
    pageNo: page.pageNo,
    pageRoles,
    regions,
    missingExpectedRoles: [],
    analysisMethod: 'RULES_ONLY',
    warnings: pageRoles.length > 1
      ? ['Region boxes are rule-based approximations and require visual confirmation.']
      : pageRoles[0] === 'UNKNOWN'
        ? ['Page role could not be determined from existing metadata or text.']
        : [],
  };
}

function addLegacyRole(roles: Set<PageRole>, chartRole: PdfPageAsset['chartRole']) {
  if (chartRole === 'CHART') roles.add('PROCEDURE_DIAGRAM');
  else if (chartRole === 'TABULAR_DESCRIPTION') roles.add('PROCEDURE_LEG_TABLE');
  else if (chartRole === 'WAYPOINT_COORDINATES') roles.add('WAYPOINT_COORDINATE_TABLE');
  else if (chartRole === 'MINIMA_TABLE') roles.add('MINIMA_TABLE');
  else if (chartRole === 'SUPPORT' || chartRole === 'CHART_INDEX') roles.add('SUPPORTING_INFORMATION');
}

function ruleBbox(role: PageRole, roleCount: number): NormalizedBbox {
  if (roleCount === 1 && isWholePageRole(role)) return [0, 0, 1, 1];
  if (role === 'PROCEDURE_TITLE') return [0, 0, 1, 0.18];
  if (role === 'PROCEDURE_DIAGRAM') return [0, 0.08, 1, 0.9];
  if (role === 'PROCEDURE_NOTES') return [0, 0.72, 1, 1];
  if (role === 'MSA') return [0.5, 0, 1, 0.35];
  if (role === 'PROFILE_VIEW') return [0, 0.58, 1, 0.92];
  if (role === 'MINIMA_TABLE') return [0, 0.68, 1, 1];
  return [0, 0, 1, 1];
}

function isWholePageRole(role: PageRole) {
  return role === 'PROCEDURE_LEG_TABLE'
    || role === 'WAYPOINT_COORDINATE_TABLE'
    || role === 'SUPPORTING_INFORMATION'
    || role === 'UNKNOWN';
}

