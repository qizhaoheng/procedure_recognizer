import type {
  AiImageRegion,
  AiInputPackage,
  AiInputPage,
  AiInputPageRole,
  PdfPageAsset,
  ProcedureGroup,
  SendMode,
  SendPolicy,
  SupportPageRef,
  SupportType,
  SupportingInfoRef,
} from '../types/procedure';
import { predictImageQuality } from './llm/imageRegions';
import { routePromptTemplate } from './prompt/promptRouter';
import { extractSupportingInfo } from './supportingInfoExtractor';

const SUPPORT_ORDER: SupportType[] = [
  'AIRPORT_METADATA',
  'RUNWAY_DATA',
  'RUNWAY_OPERATIONAL_DATA',
  'AIRSPACE_COMMUNICATION',
  'NAVAID',
  'FLIGHT_PROCEDURES',
  'CHART_INDEX',
  'OPTIONAL_CONTEXT_CHARTS',
  'AIRSPACE',
  'OBSTACLE',
  'OTHER',
];

const SUPPORT_LABELS: Record<SupportType, string> = {
  AIRPORT_METADATA: '机场基础',
  RUNWAY_DATA: '跑道数据',
  RUNWAY_OPERATIONAL_DATA: '跑道运行 / 灯光',
  AIRSPACE_COMMUNICATION: '空域 / 通信',
  NAVAID: '导航台',
  FLIGHT_PROCEDURES: '飞行程序说明',
  CHART_INDEX: '图件目录',
  OPTIONAL_CONTEXT_CHARTS: '可选背景图',
  AIRSPACE: '空域背景',
  OBSTACLE: '障碍物',
  OTHER: '其他辅助信息',
};

const SUPPORT_SECTIONS: Partial<Record<SupportType, string>> = {
  AIRPORT_METADATA: 'AD 2.1 / AD 2.2 / AD 2.3',
  RUNWAY_DATA: 'AD 2.12 RUNWAY PHYSICAL CHARACTERISTICS',
  RUNWAY_OPERATIONAL_DATA: 'AD 2.13 / AD 2.14',
  AIRSPACE_COMMUNICATION: 'AD 2.17 / AD 2.18',
  NAVAID: 'AD 2.19 RADIO NAVIGATION AND LANDING AIDS',
  FLIGHT_PROCEDURES: 'AD 2.22 FLIGHT PROCEDURES',
  CHART_INDEX: 'AD 2.24 CHARTS RELATED TO AN AERODROME',
};

export function buildAiInputPackage(
  group: ProcedureGroup,
  pages: PdfPageAsset[],
  model = process.env.LLM_MODEL || 'mock-procedure-recognizer',
  promptPreview?: string,
): AiInputPackage {
  const corePages = buildCorePages(group, pages);
  const supportingInfo = buildSupportingInfo(group, pages);
  const includedSummaries = supportingInfo.filter((item) => isSummaryIncluded(item));
  const promptTemplate = routePromptTemplate(group);
  const supportImagePages = supportingInfo
    .filter((item) => item.sendMode === 'IMAGE_ONLY' || item.sendMode === 'SUMMARY_AND_IMAGE')
    .flatMap((item) => pagesForNos(pages, item.pageNos).map((page) => supportImagePage(item, page)));
  const includedImages = [...corePages, ...supportImagePages];

  return {
    packageId: group.packageId || group.groupId,
    packageName: group.packageName || group.groupName,
    model,
    promptTemplate: promptTemplate.id,
    promptTemplateName: promptTemplate.name,
    promptVersion: promptTemplate.version,
    outputSchemaName: promptTemplate.outputSchemaName,
    outputSchemaVersion: promptTemplate.outputSchemaVersion,
    corePages,
    supportingInfo,
    supportSummary: buildSupportSummary(group, includedSummaries),
    includedImages,
    includedSummaries,
    excludedSupport: supportingInfo.filter((item) => !isSent(item)),
    ocrTextLayerIncluded: pages.some((page) => Boolean(page.textLayerText || page.ocrText)),
    promptPreview,
  };
}

export function selectPromptTemplate(group: ProcedureGroup) {
  return routePromptTemplate(group).id;
}

function buildCorePages(group: ProcedureGroup, pages: PdfPageAsset[]): AiInputPage[] {
  const ordered = [
    ...coreItems(group.chartPages, 'CHART', '识别程序图形、航迹、转弯、holding、MSA 和标签空间关系。', 'IMAGE_ONLY', pages),
    ...coreItems(group.tabularPages, 'TABULAR', '识别航段表、航迹、距离、高度、速度限制和 RNAV/RNP 规范。', 'SUMMARY_AND_IMAGE', pages),
    ...coreItems(group.coordinatePages, 'COORDINATES', '识别 waypoint 坐标，支撑 ARINC 424 Fix / Waypoint 生成。', 'SUMMARY_AND_IMAGE', pages),
    ...coreItems(group.minimaPages, 'MINIMA', '识别最低标准、OCA/H、DA/MDA 和复飞相关约束。', 'SUMMARY_AND_IMAGE', pages),
  ];
  const byKey = new Map<string, AiInputPage>();
  for (const item of ordered) byKey.set(`${item.pageNo}:${item.region || 'full_page'}`, item);
  const deduped = Array.from(byKey.values()).sort((a, b) => a.pageNo - b.pageNo);
  return [...deduped, ...chartRegionCrops(group, pages)];
}

function coreItems(
  pageNos: number[] | undefined,
  role: AiInputPageRole,
  reason: string,
  sendMode: Extract<SendMode, 'IMAGE_ONLY' | 'SUMMARY_AND_IMAGE'>,
  pages: PdfPageAsset[],
  region: AiImageRegion = 'full_page',
): AiInputPage[] {
  return pagesForNos(pages, pageNos ?? []).map((page) => ({
    pageNo: page.pageNo,
    aipPageNo: page.aipPageNo,
    role,
    region,
    imageUrl: page.imageUrl,
    thumbnailUrl: page.thumbnailUrl,
    sendMode,
    reason,
    confidence: page.confidence ?? 0.8,
    reviewRequired: Boolean(page.reviewRequired),
    imageQuality: predictImageQuality(page, region),
  }));
}

// 复杂传统程序图（DME ARC 等）除整页外，再裁剪主图区和页头单独发送，帮助模型识别小字标签。
function chartRegionCrops(group: ProcedureGroup, pages: PdfPageAsset[]): AiInputPage[] {
  const nav = String(group.navigationType || '').toUpperCase();
  if (!/DME_ARC|CONVENTIONAL|VOR|NDB|ILS|LOC/.test(nav)) return [];

  const cropReasons: Array<{ region: AiImageRegion; reason: string }> = [
    { region: 'main_chart', reason: '主图区高倍裁剪：识别 DME ARC、radial、lead radial、航迹与标签绑定等小字要素。' },
    { region: 'header', reason: '页头裁剪：识别图名、程序名、跑道和图件编号。' },
  ];

  return pagesForNos(pages, group.chartPages ?? []).flatMap((page) =>
    cropReasons.map(({ region, reason }) => ({
      pageNo: page.pageNo,
      aipPageNo: page.aipPageNo,
      role: 'CHART' as AiInputPageRole,
      region,
      imageUrl: page.imageUrl,
      thumbnailUrl: page.thumbnailUrl,
      sendMode: 'IMAGE_ONLY' as const,
      reason,
      confidence: page.confidence ?? 0.8,
      reviewRequired: Boolean(page.reviewRequired),
      imageQuality: predictImageQuality(page, region),
    })),
  );
}

function buildSupportingInfo(group: ProcedureGroup, pages: PdfPageAsset[]): SupportingInfoRef[] {
  const allDetails = extractSupportingInfo(pages).filter((detail) => detail.supportType !== 'OTHER');
  const grouped = new Map<string, SupportPageRef[]>();

  for (const detail of allDetails) {
    const key = detail.supportType === 'OPTIONAL_CONTEXT_CHARTS'
      ? `${detail.supportType}:${detail.pageNo}`
      : detail.supportType;
    const list = grouped.get(key) ?? [];
    list.push(detail);
    grouped.set(key, list);
  }

  return Array.from(grouped.values())
    .map((details) => buildSupportRef(group, details))
    .sort((a, b) => {
      const typeDiff = SUPPORT_ORDER.indexOf(a.supportType) - SUPPORT_ORDER.indexOf(b.supportType);
      return typeDiff || a.pageNos[0] - b.pageNos[0];
    });
}

function buildSupportRef(group: ProcedureGroup, details: SupportPageRef[]): SupportingInfoRef {
  const supportType = details[0].supportType;
  const pageNos = Array.from(new Set(details.map((detail) => detail.pageNo))).sort((a, b) => a - b);
  const id = supportType === 'OPTIONAL_CONTEXT_CHARTS' ? `${supportType}:${pageNos.join('-')}` : supportType;
  const defaults = defaultPolicy(group, supportType);
  const override = group.aiInputOverrides?.[id] ?? group.aiInputOverrides?.[supportType];
  const title = supportType === 'OPTIONAL_CONTEXT_CHARTS'
    ? details[0].aipPageNo || details[0].label || SUPPORT_LABELS[supportType]
    : SUPPORT_LABELS[supportType];

  return {
    id,
    supportType,
    pageNos,
    aipPageNos: Array.from(new Set(details.map((detail) => detail.aipPageNo).filter(Boolean) as string[])),
    title,
    aipSection: SUPPORT_SECTIONS[supportType],
    sendPolicy: override?.sendPolicy ?? defaults.sendPolicy,
    sendMode: override?.sendMode ?? defaults.sendMode,
    reason: reasonForSupport(group, supportType),
    summary: summarizeDetails(details, group),
    confidence: confidenceForSupport(supportType),
    reviewRequired: details.some((detail) => !detail.extracted || Object.keys(detail.extracted).length <= 1),
    manualOverride: Boolean(override),
  };
}

function defaultPolicy(group: ProcedureGroup, supportType: SupportType): { sendPolicy: SendPolicy; sendMode: SendMode } {
  const nav = group.navigationType || '';
  const isApproach = group.procedureCategory === 'APPROACH' || group.packageType === 'APPROACH';
  const needsConventionalNavaid = /DME_ARC|CONVENTIONAL|VOR|NDB|ILS_LOC|ILS|LOC/.test(nav);

  if (supportType === 'AIRPORT_METADATA' || supportType === 'RUNWAY_DATA' || supportType === 'AIRSPACE_COMMUNICATION' || supportType === 'CHART_INDEX') {
    return { sendPolicy: 'REQUIRED', sendMode: 'SUMMARY_ONLY' };
  }
  if (supportType === 'RUNWAY_OPERATIONAL_DATA') {
    return isApproach || /ILS_LOC|ILS|LOC/.test(nav)
      ? { sendPolicy: 'REQUIRED', sendMode: 'SUMMARY_ONLY' }
      : { sendPolicy: 'OPTIONAL', sendMode: 'NOT_SENT' };
  }
  if (supportType === 'NAVAID') {
    return isApproach || needsConventionalNavaid
      ? { sendPolicy: 'REQUIRED', sendMode: 'SUMMARY_ONLY' }
      : { sendPolicy: 'OPTIONAL', sendMode: 'NOT_SENT' };
  }
  if (supportType === 'FLIGHT_PROCEDURES') {
    return /DME_ARC|CONVENTIONAL/.test(nav)
      ? { sendPolicy: 'REQUIRED', sendMode: 'SUMMARY_ONLY' }
      : { sendPolicy: 'EXCLUDED', sendMode: 'NOT_SENT' };
  }
  if (supportType === 'OPTIONAL_CONTEXT_CHARTS' || supportType === 'AIRSPACE' || supportType === 'OBSTACLE') {
    return { sendPolicy: 'OPTIONAL', sendMode: 'NOT_SENT' };
  }
  return { sendPolicy: 'EXCLUDED', sendMode: 'NOT_SENT' };
}

function reasonForSupport(group: ProcedureGroup, supportType: SupportType) {
  const runway = group.runway || '当前跑道';
  const nav = group.navigationType || '当前导航类型';
  const reasons: Record<SupportType, string> = {
    AIRPORT_METADATA: '补充机场 ICAO、机场名称、ARP、机场标高、磁差等公共上下文。',
    RUNWAY_DATA: `校验 ${runway} 是否存在，并补充 THR 坐标、跑道方向、标高等 ARINC 424 校验信息。`,
    RUNWAY_OPERATIONAL_DATA: '补充 declared distance、进近灯光、PAPI 和跑道灯光。STAR/SID 通常可选，进近程序更重要。',
    AIRSPACE_COMMUNICATION: '补充 APP/TWR/SMC/ATIS 频率，校验图面频率，并补充 Transition Altitude。',
    NAVAID: `${nav} 程序可能需要导航台、DME、ILS/LOC 或 MSA 参考点；RNAV STAR 默认作为可选上下文。`,
    FLIGHT_PROCEDURES: '补充 AD 2.22 程序说明。若当前程序不是该说明覆盖的传统程序，则默认排除。',
    CHART_INDEX: '说明当前 ProcedurePackage 的来源，确认核心图面、表格和坐标页组成。',
    OPTIONAL_CONTEXT_CHARTS: '可辅助理解外围空域、holding、TMA/CTR 或最低高度背景，但不是当前程序包的必要输入。',
    AIRSPACE: '可作为空域背景辅助理解，默认不进入 AI 输入。',
    OBSTACLE: '可作为障碍物背景辅助理解，默认不进入 AI 输入。',
    OTHER: '未归类辅助信息，默认不进入 AI 输入。',
  };
  return reasons[supportType];
}

function summarizeDetails(details: SupportPageRef[], group: ProcedureGroup) {
  const sourcePages = Array.from(new Set(details.map((detail) => detail.pageNo))).sort((a, b) => a - b);
  const items = details.map((detail) => ({
    pageNo: detail.pageNo,
    aipPageNo: detail.aipPageNo,
    ...(detail.extracted || {}),
    textSample: detail.extracted?.textSample || detail.summary,
  }));

  if (details[0].supportType === 'CHART_INDEX') {
    return {
      sourcePages,
      matchedItems: (group.relatedChartNos ?? []).map((chartNo) => ({
        chartNo,
        role: chartRoleLabel(chartNo),
      })),
    };
  }

  return details.length === 1 ? { sourcePages, ...items[0] } : { sourcePages, items };
}

function buildSupportSummary(group: ProcedureGroup, includedSummaries: SupportingInfoRef[]) {
  const summary: Record<string, unknown> = {};
  for (const item of includedSummaries) {
    const key = summaryKey(item.supportType);
    if (!key) continue;
    if (summary[key]) {
      const current = summary[key];
      summary[key] = Array.isArray(current) ? [...current, item.summary] : [current, item.summary];
    } else {
      summary[key] = item.supportType === 'NAVAID'
        ? { optionalForCurrentPackage: item.sendPolicy === 'OPTIONAL', ...item.summary }
        : item.summary;
    }
  }

  summary.inputPolicy = {
    includedSummaryTypes: includedSummaries.map((item) => item.supportType),
    excludedSupport: group.manualOverride ? 'manual override applied' : 'default policy',
  };
  return summary;
}

function summaryKey(supportType: SupportType) {
  const keys: Partial<Record<SupportType, string>> = {
    AIRPORT_METADATA: 'airportMetadata',
    RUNWAY_DATA: 'runwayData',
    RUNWAY_OPERATIONAL_DATA: 'runwayOperationalData',
    AIRSPACE_COMMUNICATION: 'communication',
    NAVAID: 'navaids',
    FLIGHT_PROCEDURES: 'flightProcedures',
    CHART_INDEX: 'chartIndex',
    OPTIONAL_CONTEXT_CHARTS: 'optionalContextCharts',
    AIRSPACE: 'airspace',
    OBSTACLE: 'obstacles',
  };
  return keys[supportType];
}

function isSent(item: SupportingInfoRef) {
  return item.sendPolicy !== 'EXCLUDED' && item.sendMode !== 'NOT_SENT';
}

function isSummaryIncluded(item: SupportingInfoRef) {
  return isSent(item) && (item.sendMode === 'SUMMARY_ONLY' || item.sendMode === 'SUMMARY_AND_IMAGE');
}

function supportImagePage(item: SupportingInfoRef, page: PdfPageAsset): AiInputPage {
  return {
    pageNo: page.pageNo,
    aipPageNo: page.aipPageNo,
    role: 'CHART',
    region: 'full_page',
    imageUrl: page.imageUrl,
    thumbnailUrl: page.thumbnailUrl,
    sendMode: item.sendMode === 'IMAGE_ONLY' ? 'IMAGE_ONLY' : 'SUMMARY_AND_IMAGE',
    reason: item.reason,
    confidence: item.confidence,
    reviewRequired: item.reviewRequired,
    imageQuality: predictImageQuality(page, 'full_page'),
  };
}

function pagesForNos(pages: PdfPageAsset[], pageNos: number[]) {
  const wanted = new Set(pageNos);
  return pages.filter((page) => wanted.has(page.pageNo)).sort((a, b) => a.pageNo - b.pageNo);
}

function chartRoleLabel(chartNo: string) {
  if (/\bTABULAR\b/i.test(chartNo) || /-2\b/.test(chartNo)) return 'TABULAR';
  if (/COORD|WAYPOINT|-3\b/i.test(chartNo)) return 'COORDINATES';
  return 'CHART';
}

function confidenceForSupport(supportType: SupportType) {
  if (supportType === 'OPTIONAL_CONTEXT_CHARTS' || supportType === 'AIRSPACE' || supportType === 'OBSTACLE') return 0.66;
  if (supportType === 'FLIGHT_PROCEDURES') return 0.72;
  return 0.82;
}
