export type Arinc424FieldSeverity = 'STANDARD' | 'SUPPLIER_METADATA';

export interface Arinc424FieldDifference {
  field: string;
  label: string;
  startColumn: number;
  endColumn: number;
  systemValue: string;
  referenceValue: string;
  matched: boolean;
  severity: Arinc424FieldSeverity;
}

export interface Arinc424RecordComparison {
  recordKey: string;
  status: 'MATCH' | 'DIFFERENT' | 'METADATA_ONLY' | 'MISSING_SYSTEM' | 'MISSING_REFERENCE';
  systemLine?: string;
  referenceLine?: string;
  fields: Arinc424FieldDifference[];
}

export interface Arinc424FieldCompareResult {
  systemLineCount: number;
  referenceLineCount: number;
  matchedRecordCount: number;
  differingRecordCount: number;
  missingSystemCount: number;
  missingReferenceCount: number;
  standardDifferenceCount: number;
  supplierMetadataDifferenceCount: number;
  records: Arinc424RecordComparison[];
}

interface FieldDefinition {
  field: string;
  label: string;
  start: number;
  end: number;
  severity?: Arinc424FieldSeverity;
}

const FIELDS: FieldDefinition[] = [
  { field: 'recordType', label: '记录类型', start: 0, end: 1 },
  { field: 'areaCode', label: '区域代码', start: 1, end: 4 },
  { field: 'sectionCode', label: 'Section', start: 4, end: 5 },
  { field: 'airportIcao', label: '机场 ICAO', start: 6, end: 10 },
  { field: 'icaoRegion', label: '机场区域', start: 10, end: 12 },
  { field: 'subsection', label: '程序子节', start: 12, end: 13 },
  { field: 'routeCode', label: '程序代码', start: 13, end: 19 },
  { field: 'routeType', label: '路线类型', start: 19, end: 20 },
  { field: 'transitionQualifier', label: '跑道/Transition', start: 20, end: 25 },
  { field: 'sequence', label: '航段序号', start: 26, end: 29 },
  { field: 'fixIdentifier', label: 'Fix', start: 29, end: 34 },
  { field: 'fixRegion', label: 'Fix 区域', start: 34, end: 36 },
  { field: 'fixSection', label: 'Fix Section', start: 36, end: 38 },
  { field: 'continuation', label: '续行号', start: 38, end: 39 },
  { field: 'waypointDescription', label: '航路点描述', start: 39, end: 43 },
  { field: 'turnDirection', label: '转弯方向', start: 43, end: 44 },
  { field: 'pathTerminator', label: 'Path Terminator', start: 47, end: 49 },
  { field: 'recommendedNavaid', label: '推荐导航台', start: 50, end: 56 },
  { field: 'theta', label: 'Theta', start: 62, end: 66 },
  { field: 'rho', label: 'Rho', start: 66, end: 70 },
  { field: 'course', label: '航向', start: 70, end: 74 },
  { field: 'distance', label: '距离/续行值', start: 74, end: 78 },
  { field: 'altitudeDescription', label: '高度描述符', start: 82, end: 83 },
  { field: 'altitude1', label: '高度1', start: 84, end: 89 },
  { field: 'altitude2', label: '高度2', start: 89, end: 94 },
  { field: 'transitionAltitude', label: '过渡高度', start: 94, end: 99 },
  { field: 'speedLimit', label: '速度限制', start: 99, end: 102 },
  { field: 'centerFix', label: 'Center Fix / 来源机场', start: 106, end: 116 },
  { field: 'routeQualifier', label: '路线限定符', start: 118, end: 120 },
  { field: 'fileRecordNumber', label: '供应商记录号', start: 123, end: 128, severity: 'SUPPLIER_METADATA' },
  { field: 'cycleDate', label: '供应商周期', start: 128, end: 132, severity: 'SUPPLIER_METADATA' },
];

export function compareArinc424Fields(systemText: string, referenceText: string): Arinc424FieldCompareResult {
  const systemLines = lines(systemText);
  const referenceLines = lines(referenceText);
  const system = groupByKey(systemLines);
  const reference = groupByKey(referenceLines);
  const keys = [...new Set([...system.keys(), ...reference.keys()])].sort();
  const records: Arinc424RecordComparison[] = [];
  for (const key of keys) {
    const systemRecords = system.get(key) ?? [];
    const referenceRecords = reference.get(key) ?? [];
    const count = Math.max(systemRecords.length, referenceRecords.length);
    for (let index = 0; index < count; index += 1) {
      const systemLine = systemRecords[index];
      const referenceLine = referenceRecords[index];
      const recordKey = count > 1 ? `${key}#${index + 1}` : key;
      if (!systemLine) {
        records.push({ recordKey, status: 'MISSING_SYSTEM', referenceLine, fields: compareFields('', referenceLine!) });
        continue;
      }
      if (!referenceLine) {
        records.push({ recordKey, status: 'MISSING_REFERENCE', systemLine, fields: compareFields(systemLine, '') });
        continue;
      }
      const fields = compareFields(systemLine, referenceLine);
      const standardDiff = fields.some((field) => !field.matched && field.severity === 'STANDARD');
      const metadataDiff = fields.some((field) => !field.matched && field.severity === 'SUPPLIER_METADATA');
      records.push({ recordKey, systemLine, referenceLine, fields, status: standardDiff ? 'DIFFERENT' : metadataDiff ? 'METADATA_ONLY' : 'MATCH' });
    }
  }
  return {
    systemLineCount: systemLines.length,
    referenceLineCount: referenceLines.length,
    matchedRecordCount: records.filter((record) => record.status === 'MATCH' || record.status === 'METADATA_ONLY').length,
    differingRecordCount: records.filter((record) => record.status === 'DIFFERENT').length,
    missingSystemCount: records.filter((record) => record.status === 'MISSING_SYSTEM').length,
    missingReferenceCount: records.filter((record) => record.status === 'MISSING_REFERENCE').length,
    standardDifferenceCount: records.flatMap((record) => record.fields).filter((field) => !field.matched && field.severity === 'STANDARD').length,
    supplierMetadataDifferenceCount: records.flatMap((record) => record.fields).filter((field) => !field.matched && field.severity === 'SUPPLIER_METADATA').length,
    records,
  };
}

function compareFields(systemLine: string, referenceLine: string) {
  const left = fixedWidth(systemLine);
  const right = fixedWidth(referenceLine);
  const continuationType = (left.slice(38, 40).trim() || right.slice(38, 40).trim()).toUpperCase();
  return FIELDS.map((definition): Arinc424FieldDifference => {
    const systemValue = left.slice(definition.start, definition.end);
    const referenceValue = right.slice(definition.start, definition.end);
    return {
      field: definition.field,
      label: definition.label,
      startColumn: definition.start + 1,
      endColumn: definition.end,
      systemValue,
      referenceValue,
      matched: systemValue === referenceValue,
      // Jeppesen 2P values are supplier continuation extensions. They are
      // useful for comparison, but a difference must not be presented as an
      // AIP/ARINC semantic error in the generated primary record.
      severity: definition.field === 'distance' && continuationType === '2P'
        ? 'SUPPLIER_METADATA'
        : definition.severity ?? 'STANDARD',
    };
  });
}

function lines(text: string) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map(fixedWidth);
}

function fixedWidth(line: string) {
  return line.padEnd(132, ' ').slice(0, 132);
}

function groupByKey(source: string[]) {
  const grouped = new Map<string, string[]>();
  for (const line of source) {
    // Do not include subsection, route type, area code, or fix region in the
    // pairing key: those are precisely the fields the comparison must expose.
    const key = [line.slice(13, 19), line.slice(20, 25), line.slice(26, 34), line.slice(38, 40)].join('|');
    const items = grouped.get(key) ?? [];
    items.push(line);
    grouped.set(key, items);
  }
  return grouped;
}
