import type {
  PdfPageAsset,
  ProcedureGroup,
  SupportPageRef,
  SupportingInfoRefs,
  SupportingInfoSummary,
  SupportType,
} from '../types/procedure';

interface PackageSupportContext {
  refs: SupportingInfoRefs;
  details: SupportPageRef[];
  summary: SupportingInfoSummary;
  pages: number[];
}

const SUPPORT_KEY_BY_TYPE: Record<SupportType, keyof SupportingInfoRefs | undefined> = {
  AIRPORT_METADATA: 'airportMetadata',
  RUNWAY_DATA: 'runwayData',
  RUNWAY_OPERATIONAL_DATA: 'runwayOperationalData',
  AIRSPACE_COMMUNICATION: 'communication',
  NAVAID: 'navaid',
  FLIGHT_PROCEDURES: 'flightProcedures',
  CHART_INDEX: 'chartIndex',
  OPTIONAL_CONTEXT_CHARTS: undefined,
  AIRSPACE: undefined,
  OBSTACLE: undefined,
  OTHER: undefined,
};

export function extractSupportingInfo(pages: PdfPageAsset[]): SupportPageRef[] {
  const refs: SupportPageRef[] = [];
  for (const page of pages) {
    const supportType = detectSupportType(page);
    if (!supportType) continue;
    refs.push({
      pageNo: page.pageNo,
      aipPageNo: page.aipPageNo,
      supportType,
      label: labelForSupportType(supportType),
      extracted: extractSupportFields(page, supportType),
      summary: summarizePage(page),
    });
  }
  return refs;
}

export function detectSupportType(page: PdfPageAsset): SupportType | undefined {
  if (page.chartRole === 'CHART_INDEX') return 'CHART_INDEX';
  const text = supportText(page);
  if (/AD\s*2\.?24|CHARTS RELATED TO AN AERODROME/.test(text)) return 'CHART_INDEX';
  if (/AD\s*2\.?1\b|AD\s*2\.?2\b|AERODROME LOCATION INDICATOR AND NAME|AERODROME GEOGRAPHICAL AND ADMINISTRATIVE DATA/.test(text)) {
    return 'AIRPORT_METADATA';
  }
  if (/AD\s*2\.?12\b|RUNWAY PHYSICAL CHARACTERISTICS/.test(text)) return 'RUNWAY_DATA';
  if (/AD\s*2\.?13\b|AD\s*2\.?14\b|DECLARED DISTANCES|APPROACH AND RUNWAY LIGHTING/.test(text)) return 'RUNWAY_OPERATIONAL_DATA';
  if (/AD\s*2\.?17\b|AD\s*2\.?18\b|ATS AIRSPACE|ATS COMMUNICATION FACILITIES|COMMUNICATION FACILITIES/.test(text)) {
    return 'AIRSPACE_COMMUNICATION';
  }
  if (/AD\s*2\.?19\b|RADIO NAVIGATION AND LANDING AIDS|NAVIGATION AND LANDING AIDS/.test(text)) return 'NAVAID';
  if (/AD\s*2\.?22\b|FLIGHT PROCEDURES/.test(text)) return 'FLIGHT_PROCEDURES';
  if (/TMA|CTR|HOLDING AREAS|SURVEILLANCE MINIMUM ALTITUDE|MINIMUM ALTITUDE CHART/.test(text)) return 'OPTIONAL_CONTEXT_CHARTS';
  if (/OBSTACLE/.test(text)) return 'OBSTACLE';
  if (/AIRSPACE/.test(text)) return 'AIRSPACE';
  return undefined;
}

export function refsForPackage(refs: SupportPageRef[], group: ProcedureGroup): PackageSupportContext {
  const wanted = supportTypesForPackage(group);
  const details = refs.filter((ref) => wanted.has(ref.supportType));
  const refsByKey: SupportingInfoRefs = {};
  for (const detail of details) {
    const key = SUPPORT_KEY_BY_TYPE[detail.supportType];
    if (!key) continue;
    const pageNos = refsByKey[key] ?? [];
    if (!pageNos.includes(detail.pageNo)) pageNos.push(detail.pageNo);
    refsByKey[key] = pageNos.sort((a, b) => a - b);
  }

  return {
    refs: refsByKey,
    details,
    summary: buildSupportingInfoSummary(details, group, refsByKey),
    pages: Array.from(new Set(details.map((ref) => ref.pageNo))).sort((a, b) => a - b),
  };
}

export function supportTypesForPackage(group: Pick<ProcedureGroup, 'packageType' | 'procedureCategory' | 'navigationType'>) {
  const wanted = new Set<SupportType>(['AIRPORT_METADATA', 'RUNWAY_DATA', 'AIRSPACE_COMMUNICATION', 'CHART_INDEX']);
  const nav = group.navigationType || '';

  if (group.procedureCategory === 'APPROACH' || group.packageType === 'APPROACH') {
    wanted.add('RUNWAY_OPERATIONAL_DATA');
    wanted.add('NAVAID');
  }
  if (/DME_ARC|CONVENTIONAL|VOR|NDB/.test(nav)) {
    wanted.add('NAVAID');
    wanted.add('FLIGHT_PROCEDURES');
  }
  if (/ILS_LOC|ILS|LOC/.test(nav)) {
    wanted.add('NAVAID');
    wanted.add('RUNWAY_OPERATIONAL_DATA');
  }

  return wanted;
}

function buildSupportingInfoSummary(details: SupportPageRef[], group: ProcedureGroup, sourcePages: SupportingInfoRefs): SupportingInfoSummary {
  const detailsByType = (type: SupportType) => details.filter((detail) => detail.supportType === type);
  return {
    airportMetadata: mergeExtracted(detailsByType('AIRPORT_METADATA')),
    runwayData: filterRunwayRelated(detailsByType('RUNWAY_DATA'), group),
    runwayOperationalData: filterRunwayRelated(detailsByType('RUNWAY_OPERATIONAL_DATA'), group),
    communication: detailsByType('AIRSPACE_COMMUNICATION').map((detail) => detail.extracted || { pageNo: detail.pageNo }),
    navaids: filterNavaids(detailsByType('NAVAID'), group),
    flightProcedures: detailsByType('FLIGHT_PROCEDURES').map((detail) => detail.extracted || { pageNo: detail.pageNo }),
    chartIndexPages: sourcePages.chartIndex,
    sourcePages,
  };
}

function extractSupportFields(page: PdfPageAsset, supportType: SupportType) {
  const text = rawText(page);
  const compact = text.replace(/\s+/g, ' ').trim();
  if (supportType === 'AIRPORT_METADATA') {
    return {
      pageNo: page.pageNo,
      airportIcao: compact.match(/\b[A-Z]{4}\b/)?.[0],
      airportName: compact.match(/AD\s*2\.?1[^A-Z0-9]+.*?\b([A-Z]{4}\s*-\s*[^0-9]+?)(?:\s+[A-Z]{4}\s+AD\s*2\.?2|\s+WM[A-Z]{2}\s+AD\s*2\.?2)/i)?.[1]?.trim(),
      arpCoordinates: compact.match(/\b\d{6}[NS]\s+\d{7}[EW]\b/i)?.[0],
      aerodromeElevation: compact.match(/Elevation\/Reference temperature\s+([^/]+(?:FT|M))/i)?.[1]?.trim(),
      magneticVariation: compact.match(/Magnetic variation[^0-9NSWE]*(\d+[^,;.]+)/i)?.[1]?.trim(),
      trafficPermitted: compact.match(/Types of traffic permitted[^A-Z0-9]*(.{0,120})/i)?.[1]?.trim(),
      textSample: compact.slice(0, 900),
    };
  }
  if (supportType === 'RUNWAY_DATA') {
    return {
      pageNo: page.pageNo,
      runways: extractRunwayDesignators(compact),
      trueBearings: matches(compact, /\b\d{3}\.?\d*°/g),
      dimensions: matches(compact, /\b\d{3,4}\s*[xX]\s*\d{2,3}\s*M\b/g),
      surfaces: matches(compact, /\b(?:ASPHALT|CONCRETE|BITUMEN|GRASS)\b/gi),
      strengths: matches(compact, /\b(?:PCR|PCN)\s*[^ ]+(?:\s*\/\s*[^ ]+){3,4}/gi),
      coordinates: matches(compact, /\b\d{6}(?:\.\d+)?[NS]\s+\d{7}(?:\.\d+)?[EW]\b/gi),
      elevations: matches(compact, /\b\d+(?:\.\d+)?\s*(?:FT|M)\b/gi).slice(0, 20),
      textSample: compact.slice(0, 1200),
    };
  }
  if (supportType === 'RUNWAY_OPERATIONAL_DATA') {
    return {
      pageNo: page.pageNo,
      declaredDistances: matches(compact, /\b(?:16|34)\s+(?:THRESHOLD|TWY\s+[A-Z])\s+\d+\s+\d+\s+\d+\s+(?:\d+|-)/gi),
      lighting: matches(compact, /\b(?:APPROACH LIGHTING|PAPI|RUNWAY LIGHTS?|RUNWAY END LIGHTS?|THR lights?|edge lights?)[^.;]{0,100}/gi),
      textSample: compact.slice(0, 1200),
    };
  }
  if (supportType === 'AIRSPACE_COMMUNICATION') {
    return {
      pageNo: page.pageNo,
      airspace: matches(compact, /\b(?:CTR|TMA)\b[^.;]{0,180}/gi),
      transitionAltitude: compact.match(/TRANSITION ALTITUDE[^0-9]*(\d+\s*FT|\d+)/i)?.[1],
      frequencies: matches(compact, /\b(?:APP|TWR|SMC|ATIS|RADAR|GROUND)\b[^.;\n]{0,100}?\d{3}\.\d{1,3}\s*MHz?/gi),
      callsigns: matches(compact, /\b(?:JOHOR BAHRU|SENAI)[A-Z ]{0,40}\b(?:APPROACH|TOWER|GROUND|ATIS)?/gi),
      textSample: compact.slice(0, 1200),
    };
  }
  if (supportType === 'NAVAID') {
    return {
      pageNo: page.pageNo,
      navaids: matches(compact, /\b(?:ILS|LOC|GP\/DME|DME|NDB|VOR\/DME|VOR)\b[^.;]{0,160}/gi),
      idents: matches(compact, /\b[A-Z]{2,4}\b/g).filter((value) => !['AIP', 'AD', 'NIL', 'RWY'].includes(value)).slice(0, 40),
      frequencies: matches(compact, /\b\d{3}\.\d{1,3}\s*MHZ|\b\d{3,4}\s*KHZ/gi),
      channels: matches(compact, /\bCH\s*\d+[XY]\b/gi),
      coordinates: matches(compact, /\b\d{6}(?:\.\d+)?[NS]\s+\d{7}(?:\.\d+)?[EW]\b/gi),
      dmeElevations: matches(compact, /\bDME[^.;]{0,80}\b\d+(?:\.\d+)?\s*(?:FT|M)\b/gi),
      textSample: compact.slice(0, 1400),
    };
  }
  if (supportType === 'FLIGHT_PROCEDURES') {
    return {
      pageNo: page.pageNo,
      dmeArrivalProcedures: matches(compact, /DME Arrival Procedures[^.]*\./gi),
      radialTracks: matches(compact, /\bR-\d{3}\/\d{3}°|\b\d{3}°/g).slice(0, 30),
      navaids: matches(compact, /\b(?:VJB|VOR|DME|NDB)\b/g),
      minimumIfrAltitudes: matches(compact, /\b\d{4,5}\s*FT\b/gi),
      remarks: matches(compact, /(?:REMARKS|Note:)[^.;]{0,220}/gi),
      levelRestrictions: matches(compact, /\bcross[^.;]{0,120}\b\d{4,5}\s*FT[^.;]*/gi),
      textSample: compact.slice(0, 1200),
    };
  }
  return { pageNo: page.pageNo, textSample: compact.slice(0, 900) };
}

function filterRunwayRelated(refs: SupportPageRef[], group: ProcedureGroup) {
  const targetRunway = group.runway?.replace(/^RWY/i, '');
  return refs.map((ref) => ({ pageNo: ref.pageNo, targetRunway, ...(ref.extracted || {}) }));
}

function filterNavaids(refs: SupportPageRef[], group: ProcedureGroup) {
  const nav = group.navigationType || '';
  return refs.map((ref) => ({ pageNo: ref.pageNo, navigationType: nav, ...(ref.extracted || {}) }));
}

function mergeExtracted(refs: SupportPageRef[]) {
  return refs.reduce<Record<string, unknown>>((merged, ref) => ({ ...merged, pageNo: ref.pageNo, ...(ref.extracted || {}) }), {});
}

function supportText(page: PdfPageAsset) {
  return `${page.aipPageNo || ''} ${page.chartTitle || ''} ${rawText(page)}`.toUpperCase();
}

function rawText(page: PdfPageAsset) {
  return page.ocrText || page.textLayerText || '';
}

function summarizePage(page: PdfPageAsset) {
  return rawText(page).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function labelForSupportType(supportType: SupportType) {
  const labels: Record<SupportType, string> = {
    AIRPORT_METADATA: '机场基础',
    RUNWAY_DATA: '跑道数据',
    RUNWAY_OPERATIONAL_DATA: '跑道运行数据',
    AIRSPACE_COMMUNICATION: '通信频率',
    NAVAID: '导航台',
    FLIGHT_PROCEDURES: '飞行程序说明',
    CHART_INDEX: '图件目录',
    OPTIONAL_CONTEXT_CHARTS: '可选背景图',
    AIRSPACE: '空域',
    OBSTACLE: '障碍物',
    OTHER: '其他',
  };
  return labels[supportType];
}

function extractRunwayDesignators(text: string) {
  return Array.from(new Set(matches(text, /\b(?:RWY\s*)?(?:16|34)\b/g).map((value) => value.replace(/^RWY\s*/i, 'RWY'))));
}

function matches(text: string, regex: RegExp) {
  return Array.from(new Set(Array.from(text.matchAll(regex), (match) => match[0].replace(/\s+/g, ' ').trim())));
}
