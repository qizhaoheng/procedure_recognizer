import type { AipAdStructure, ChartIndexItem, PdfPageAsset, ProcedureGroup, SupportPageRef } from '../types/procedure';
import { buildNormalizedGroupKey, normalizeChartNo } from './chartIndexParser';
import { extractAipAdStructure } from './documentStructureExtractor';
import { pageHeaderToIndexItem, parsePageHeader } from './pageHeaderParser';
import { detectSupportType, refsForPackage } from './supportingInfoExtractor';

export interface GroupingDebug {
  chartNoPageMap: Array<{ chartNo: string; pageNos: number[] }>;
  chartIndexItems: Array<ChartIndexItem & { matchedPageNo?: number; matchedPageNos?: number[] }>;
  unmatchedChartIndexItems: ChartIndexItem[];
  duplicateChartNoPages: Array<{ chartNo: string; pageNos: number[] }>;
  pageHeaderFallbackPackages: ProcedureGroup[];
  rejectedFallbackPages: Array<{ pageNo: number; aipPageNo?: string; reason: string }>;
  pages: Array<{
    pageNo: number;
    aipPageNo?: string;
    chartRole: string;
    procedureCategory: string;
    navigationType: string;
    runway?: string;
    procedureNames?: string[];
    matchedPackageId?: string;
    groupingReason?: string[];
  }>;
  packages: ProcedureGroup[];
  globalSupportPages: SupportPageRef[];
}

interface GroupingState {
  structure: AipAdStructure;
  chartNoPageMap: Map<string, PdfPageAsset[]>;
  unmatchedChartIndexItems: ChartIndexItem[];
  duplicateChartNoPages: Array<{ chartNo: string; pageNos: number[] }>;
  pageHeaderFallbackPackages: ProcedureGroup[];
  rejectedFallbackPages: Array<{ pageNo: number; aipPageNo?: string; reason: string }>;
}

export function groupProcedurePackages(pages: PdfPageAsset[]): ProcedureGroup[] {
  return groupFromStructure(extractAipAdStructure(pages)).packages;
}

export function buildGroupingDebug(pages: PdfPageAsset[]): GroupingDebug {
  const result = groupFromStructure(extractAipAdStructure(pages));
  return {
    chartNoPageMap: Array.from(result.state.chartNoPageMap.entries()).map(([chartNo, mappedPages]) => ({
      chartNo,
      pageNos: mappedPages.map((page) => page.pageNo),
    })),
    chartIndexItems: result.state.structure.chartIndexItems.map((item) => {
      const mappedPages = lookupPagesForChartNo(result.state.chartNoPageMap, item.chartNo);
      return {
        ...item,
        matchedPageNo: mappedPages[0]?.pageNo,
        matchedPageNos: mappedPages.map((page) => page.pageNo),
      };
    }),
    unmatchedChartIndexItems: result.state.unmatchedChartIndexItems,
    duplicateChartNoPages: result.state.duplicateChartNoPages,
    pageHeaderFallbackPackages: result.state.pageHeaderFallbackPackages,
    rejectedFallbackPages: result.state.rejectedFallbackPages,
    pages: result.state.structure.pages.map((page) => ({
      pageNo: page.pageNo,
      aipPageNo: page.aipPageNo,
      chartRole: page.chartRole,
      procedureCategory: page.procedureCategory,
      navigationType: page.navigationType,
      runway: page.runway,
      procedureNames: page.procedureNames,
      matchedPackageId: page.matchedPackageId,
      groupingReason: page.groupingReason,
    })),
    packages: result.packages,
    globalSupportPages: result.state.structure.globalSupportPages,
  };
}

export function buildExactChartNoPageMap(pages: PdfPageAsset[]) {
  const map = new Map<string, PdfPageAsset[]>();
  for (const page of pages) {
    if (page.chartRole === 'CHART_INDEX' || page.chartRole === 'BLANK') continue;
    const chartNo = normalizeChartNo(page.aipPageNo);
    if (!chartNo) continue;
    const mappedPages = map.get(chartNo) ?? [];
    mappedPages.push(page);
    map.set(chartNo, mappedPages);
  }
  return map;
}

function groupFromStructure(structure: AipAdStructure) {
  const state: GroupingState = {
    structure,
    chartNoPageMap: buildExactChartNoPageMap(structure.pages),
    unmatchedChartIndexItems: [],
    duplicateChartNoPages: [],
    pageHeaderFallbackPackages: [],
    rejectedFallbackPages: [],
  };
  state.duplicateChartNoPages = Array.from(state.chartNoPageMap.entries())
    .filter(([, pages]) => pages.length > 1)
    .map(([chartNo, pages]) => ({ chartNo, pageNos: pages.map((page) => page.pageNo) }));

  const packagesByKey = new Map<string, ProcedureGroup>();
  const indexItems = structure.chartIndexItems.filter((item) => isProgramPackage(item));
  for (const [key, items] of groupItemsByKey(indexItems)) {
    const primary = items.find((item) => !item.isTabular) || items[0];
    const group = createPackageFromItem(primary, key, packagesByKey.size + 1, 'AD_2_24_CHART_INDEX', 0.98);
    packagesByKey.set(key, group);

    for (const item of items) {
      const mappedPages = lookupPagesForChartNo(state.chartNoPageMap, item.chartNo);
      pushUnique(group.relatedChartNos ||= [], item.chartNo);
      if (!mappedPages.length) {
        state.unmatchedChartIndexItems.push(item);
        group.reviewRequired = true;
        group.groupingReason ||= [];
        group.groupingReason.push(`AD 2.24 item not matched to parsed page: ${item.chartNo}`);
        continue;
      }
      if (mappedPages.length > 1) {
        group.reviewRequired = true;
        group.groupingReason ||= [];
        group.groupingReason.push(`duplicate parsed pages for ${item.chartNo}: ${mappedPages.map((page) => page.pageNo).join(', ')}`);
      }
      for (const page of mappedPages) assignPageToPackage(group, page, item, 'matched by AD 2.24 chart index');
    }

    finalizePackage(group, structure.globalSupportPages);
  }

  repairFragmentedChartNoMatches(state, indexItems, packagesByKey);
  stageTwoHeaderCompletion(state, packagesByKey);
  stageThreeSequentialCompletion(state, Array.from(packagesByKey.values()));

  const packages = Array.from(packagesByKey.values())
    .map((group) => finalizePackage(group, structure.globalSupportPages))
    .filter((group) => isDisplayableProgramPackage(group))
    .sort((a, b) => (a.chartPageNo || 99999) - (b.chartPageNo || 99999));

  return { state, packages };
}

// 部分图页（如横排图）的图号被 PDF 文本层拆成碎片（"AD 2-VHHH-IAC-0" + "6" + "A"），
// 无法直接解析。利用 AD 2.24 目录中的权威图号，把未匹配页的页首文本去空格后反查（最长优先）。
function repairFragmentedChartNoMatches(
  state: GroupingState,
  indexItems: ChartIndexItem[],
  packagesByKey: Map<string, ProcedureGroup>,
) {
  const candidates = indexItems
    .map((item) => ({ item, needle: item.chartNo.replace(/\s+/g, '').toUpperCase() }))
    .sort((a, b) => b.needle.length - a.needle.length);
  if (!candidates.length) return;

  for (const page of state.structure.pages) {
    if (page.matchedPackageId) continue;
    if (['CHART_INDEX', 'BLANK', 'SUPPORT'].includes(page.chartRole)) continue;
    // 横排图页的文本顺序不定，图号碎片可能出现在任意位置，整页去空格后检索
    const compact = (page.ocrText || page.textLayerText || '').replace(/\s+/g, '').toUpperCase();
    if (!compact.includes('AD2-')) continue;
    const hit = candidates.find(({ needle }) => compact.includes(needle));
    if (!hit) continue;
    const group = packagesByKey.get(hit.item.normalizedGroupKey);
    if (!group) continue;
    assignPageToPackage(group, page, hit.item, 'matched by fragmented chart number repair');
    group.reviewRequired = true;
    state.unmatchedChartIndexItems = state.unmatchedChartIndexItems.filter((item) => item.chartNo !== hit.item.chartNo);
  }
}

function stageTwoHeaderCompletion(state: GroupingState, packagesByKey: Map<string, ProcedureGroup>) {
  for (const page of state.structure.pages) {
    if (page.matchedPackageId) {
      if (page.chartRole !== 'CHART') {
        state.rejectedFallbackPages.push({
          pageNo: page.pageNo,
          aipPageNo: page.aipPageNo,
          reason: 'matched by AD 2.24 as tabular/support page; do not create page-header package',
        });
      }
      continue;
    }
    if (shouldNeverCreatePackage(page)) {
      state.rejectedFallbackPages.push({ pageNo: page.pageNo, aipPageNo: page.aipPageNo, reason: `chartRole=${page.chartRole}; fallback disabled` });
      continue;
    }
    if (page.chartRole !== 'CHART') {
      state.rejectedFallbackPages.push({ pageNo: page.pageNo, aipPageNo: page.aipPageNo, reason: `chartRole=${page.chartRole}; fallback only handles CHART pages` });
      continue;
    }
    if (!hasExplicitProgramChartTitle(page)) {
      state.rejectedFallbackPages.push({ pageNo: page.pageNo, aipPageNo: page.aipPageNo, reason: 'missing explicit procedure chart title' });
      continue;
    }

    const item = pageHeaderToIndexItem(page);
    if (!item || !isProgramPackage(item)) continue;

    const key = buildNormalizedGroupKey(item);
    let group = packagesByKey.get(key);
    if (!group) {
      group = createPackageFromItem(item, key, packagesByKey.size + 1, 'PAGE_HEADER_RULE', 0.72);
      group.reviewRequired = true;
      packagesByKey.set(key, group);
      state.pageHeaderFallbackPackages.push(group);
    }
    assignPageToPackage(group, page, item, 'matched by page header rule');
    page.headerMatchedPackageId = group.packageId;
  }
}

function stageThreeSequentialCompletion(state: GroupingState, packages: ProcedureGroup[]) {
  const pagesByNo = new Map(state.structure.pages.map((page) => [page.pageNo, page]));
  for (const group of packages) {
    const seedPageNo = group.chartPageNo || group.chartPages[0];
    const seedPage = pagesByNo.get(seedPageNo);
    if (!seedPage) continue;

    for (let offset = 1; offset <= 3; offset += 1) {
      const page = pagesByNo.get(seedPageNo + offset);
      if (!page || page.matchedPackageId || shouldNeverCreatePackage(page)) continue;
      if (!['TABULAR_DESCRIPTION', 'WAYPOINT_COORDINATES', 'MINIMA_TABLE'].includes(page.chartRole)) continue;
      if (!isCompatibleSequentialPage(group, seedPage, page)) continue;

      const header = pageHeaderToIndexItem(page) || {
        chartName: page.chartTitle || page.aipPageNo || `P${page.pageNo}`,
        chartNo: page.aipPageNo || `P${page.pageNo}`,
        procedureCategory: page.procedureCategory,
        packageType: group.packageType || 'OTHER',
        navigationType: page.navigationType,
        runway: page.runway,
        procedureNames: page.procedureNames ?? [],
        isTabular: true,
        normalizedGroupKey: group.normalizedTitle || group.groupId,
      };
      assignPageToPackage(group, page, header, 'added by strict sequential fallback');
      group.reviewRequired = true;
    }
  }
}

function createPackageFromItem(
  item: ChartIndexItem,
  key: string,
  index: number,
  source: ProcedureGroup['source'],
  confidence: number,
): ProcedureGroup {
  const packageId = `pkg_${index}_${hashKey(key)}`;
  return {
    groupId: packageId,
    packageId,
    groupName: '',
    packageName: '',
    packageType: item.packageType,
    procedureCategory: normalizeCategory(item.procedureCategory),
    navigationType: item.navigationType,
    runway: item.runway,
    chartTitle: item.chartName,
    normalizedTitle: key,
    chartNo: item.isTabular ? undefined : item.chartNo,
    relatedChartNos: [],
    relatedPageNos: [],
    chartPages: [],
    tabularPages: [],
    coordinatePages: [],
    minimaPages: [],
    textSupplementPages: [],
    supportingPages: [],
    otherPages: [],
    procedureNames: [...item.procedureNames],
    source,
    confidence,
    reviewRequired: false,
    status: 'GROUPED',
  };
}

function assignPageToPackage(group: ProcedureGroup, page: PdfPageAsset, item: ChartIndexItem, reason: string) {
  const pageText = `${page.chartTitle || ''} ${page.ocrText || page.textLayerText || ''}`.toUpperCase();
  const isSidStarCoordinateTabular = item.isTabular && (item.tabularNo ?? 0) >= 2 && (group.packageType === 'SID' || group.packageType === 'STAR');
  const isCoordinate =
    page.chartRole === 'WAYPOINT_COORDINATES' ||
    isSidStarCoordinateTabular ||
    /WAYPOINT COORDINATES|AERONAUTICAL DATA TABULATION/.test(pageText);
  const isTabular = item.isTabular || page.isTabular || page.chartRole === 'TABULAR_DESCRIPTION' || isCoordinate || /TABULAR DESCRIPTION/.test(pageText);

  if (isTabular) pushUnique(group.tabularPages, page.pageNo);
  if (isCoordinate) pushUnique(group.coordinatePages, page.pageNo);
  else if (page.chartRole === 'CHART' && !item.isTabular) {
    // 图页角色明确时优先归图面页：图面上常印有 OCA/MINIMA、TABULAR DESCRIPTION 等字样，
    // 不能据此误判为最低标准/表格页（图面+表格合一的页会同时进 tabularPages）
    pushUnique(group.chartPages, page.pageNo);
    group.chartNo ||= item.chartNo || page.aipPageNo;
    group.chartPageNo ||= page.pageNo;
    group.chartTitle ||= item.chartName || page.chartTitle;
  } else if (page.chartRole === 'MINIMA_TABLE' || (!isTabular && /\bMINIMA\b|\bOCA\b|\bOCH\b/.test(pageText))) pushUnique(group.minimaPages, page.pageNo);
  else if (!isTabular && !item.isTabular) {
    pushUnique(group.chartPages, page.pageNo);
    group.chartNo ||= item.chartNo || page.aipPageNo;
    group.chartPageNo ||= page.pageNo;
    group.chartTitle ||= item.chartName || page.chartTitle;
  } else if (!isCoordinate) {
    pushUnique(group.textSupplementPages ??= [], page.pageNo);
  }

  pushUnique(group.relatedPageNos ??= [], page.pageNo);
  pushUnique(group.relatedChartNos ??= [], item.chartNo || page.aipPageNo || `P${page.pageNo}`);
  group.procedureNames = Array.from(new Set([...group.procedureNames, ...item.procedureNames, ...(page.procedureNames ?? [])]));
  if (!group.runway && (item.runway || page.runway)) group.runway = item.runway || page.runway;
  if (group.navigationType === 'UNKNOWN' && item.navigationType !== 'UNKNOWN') group.navigationType = item.navigationType;

  page.matchedPackageId = group.packageId;
  if (reason.includes('AD 2.24')) page.indexMatchedPackageId = group.packageId;
  page.groupingReason ||= [];
  page.groupingReason.push(reason, `chartNo=${item.chartNo || page.aipPageNo || `P${page.pageNo}`}`);
}

function finalizePackage(group: ProcedureGroup, globalSupportPages: SupportPageRef[]) {
  group.chartPages = uniqueSorted(group.chartPages);
  group.tabularPages = uniqueSorted(group.tabularPages);
  group.coordinatePages = uniqueSorted(group.coordinatePages);
  group.minimaPages = uniqueSorted(group.minimaPages);
  group.textSupplementPages = uniqueSorted(group.textSupplementPages ?? []);
  group.relatedPageNos = uniqueSorted(group.relatedPageNos ?? allCorePages(group));
  group.relatedChartNos = Array.from(new Set(group.relatedChartNos ?? []));
  group.chartPageNo ||= group.chartPages[0];
  group.chartNo ||= group.relatedChartNos.find((chartNo) => {
    const item = group.relatedChartNos?.find((candidate) => candidate === chartNo);
    return item && !/\(TABULAR/i.test(item);
  }) || group.relatedChartNos[0];
  group.packageName = buildPackageName(group);
  group.groupName = group.packageName;
  const supportContext = refsForPackage(globalSupportPages, group);
  group.supportingInfoRefs = supportContext.refs;
  group.supportingInfoDetails = supportContext.details;
  group.supportingInfoSummary = supportContext.summary;
  group.supportingPages = supportContext.pages;
  group.reviewRequired ||= !group.chartPages.length || (group.confidence ?? 0) < 0.8;
  return group;
}

// 目录图号可能不含页序后缀（AD 2-VHHH-SID-BEKOL-A），而图页图号带后缀（...-A-1），按前缀归并
function lookupPagesForChartNo(map: Map<string, PdfPageAsset[]>, chartNo: string): PdfPageAsset[] {
  const collected = [...(map.get(chartNo) ?? [])];
  const prefix = `${chartNo}-`;
  for (const [key, pages] of map) {
    if (key.startsWith(prefix) && /^\d{1,2}$/.test(key.slice(prefix.length))) collected.push(...pages);
  }
  const seen = new Set<number>();
  return collected
    .filter((page) => (seen.has(page.pageNo) ? false : (seen.add(page.pageNo), true)))
    .sort((a, b) => a.pageNo - b.pageNo);
}

function groupItemsByKey(items: ChartIndexItem[]) {
  const grouped = new Map<string, ChartIndexItem[]>();
  for (const item of items) {
    const list = grouped.get(item.normalizedGroupKey) ?? [];
    list.push(item);
    grouped.set(item.normalizedGroupKey, list);
  }
  return grouped.entries();
}

function shouldNeverCreatePackage(page: PdfPageAsset) {
  if (['BLANK', 'CHART_INDEX', 'TABULAR_DESCRIPTION', 'WAYPOINT_COORDINATES', 'MINIMA_TABLE'].includes(page.chartRole)) return true;
  if (detectSupportType(page)) return true;
  const text = `${page.chartTitle || ''} ${page.ocrText || page.textLayerText || ''}`.toUpperCase();
  if (/AERODROME HELIPORT CHART|AERODROME CHART|AIRCRAFT PARKING|GROUND MOVEMENT|PARKING\/DOCKING|OBSTACLE CHART|ATC SURVEILLANCE|HOLDING AREAS|TMA|CTR/.test(text)) return true;
  return false;
}

function hasExplicitProgramChartTitle(page: PdfPageAsset) {
  const text = `${page.chartTitle || ''} ${page.ocrText || page.textLayerText || ''}`;
  return /STANDARD\s+ARRIVAL\s+CHART|STANDARD\s+DEPARTURE\s+CHART|INSTRUMENT\s+APPROACH\s+CHART/i.test(text);
}

function isProgramPackage(item: ChartIndexItem) {
  return item.packageType === 'STAR' || item.packageType === 'SID' || item.packageType === 'APPROACH';
}

function isDisplayableProgramPackage(group: ProcedureGroup) {
  return group.packageType === 'STAR' || group.packageType === 'SID' || group.packageType === 'APPROACH';
}

function isCompatibleSequentialPage(group: ProcedureGroup, seedPage: PdfPageAsset, page: PdfPageAsset) {
  const header = parsePageHeader(page);
  if (header.procedureCategory !== 'UNKNOWN' && header.procedureCategory !== group.procedureCategory) return false;
  if (header.runway && group.runway && header.runway !== group.runway) return false;
  if (header.navigationType !== 'UNKNOWN' && group.navigationType !== 'UNKNOWN' && header.navigationType !== group.navigationType) return false;
  if (seedPage.aipPageNo && page.aipPageNo && !isSequentialChartNo(seedPage.aipPageNo, page.aipPageNo)) return false;
  return true;
}

function isSequentialChartNo(seedChartNo: string, candidateChartNo: string) {
  const seed = parseChartNoParts(seedChartNo);
  const candidate = parseChartNoParts(candidateChartNo);
  if (!seed || !candidate) return false;
  return seed.prefix === candidate.prefix && candidate.last > seed.last && candidate.last - seed.last <= 3;
}

function parseChartNoParts(chartNo: string) {
  const normalized = normalizeChartNo(chartNo);
  const match = normalized?.match(/^(AD 2-[A-Z]{4}-\d+)-(\d+)$/);
  return match ? { prefix: match[1], last: Number(match[2]) } : undefined;
}

function buildPackageName(group: ProcedureGroup) {
  const names = group.procedureNames.join(' ');
  if (group.packageType === 'APPROACH') return group.procedureNames[0] || [group.navigationType, group.runway].filter(Boolean).join(' ');
  const nav = group.navigationType === 'DME_ARC' ? '11 DME ARC' : group.navigationType;
  return [group.runway, nav, group.packageType, names].filter(Boolean).join(' ');
}

function allCorePages(group: ProcedureGroup) {
  return [
    ...group.chartPages,
    ...group.tabularPages,
    ...group.coordinatePages,
    ...group.minimaPages,
    ...(group.textSupplementPages ?? []),
  ];
}

function normalizeCategory(category: string): ProcedureGroup['procedureCategory'] {
  if (category === 'ARRIVAL' || category === 'DEPARTURE' || category === 'APPROACH') return category;
  return 'UNKNOWN';
}

function pushUnique<T>(target: T[], value: T) {
  if (!target.includes(value)) target.push(value);
}

function uniqueSorted(values: number[]) {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function hashKey(key: string) {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
