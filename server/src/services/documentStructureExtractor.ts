import type { AipAdStructure, AipSection, PdfPageAsset } from '../types/procedure';
import { countLetteredChartNos, extractLikelyAipPageNo, normalizeChartNo, parseChartIndexFromPages } from './chartIndexParser';
import { parsePageHeader } from './pageHeaderParser';
import { detectSupportType, extractSupportingInfo } from './supportingInfoExtractor';

export function extractAipAdStructure(pages: PdfPageAsset[]): AipAdStructure {
  const chartIndexPages = pages.filter((page) => {
    const text = page.ocrText || page.textLayerText || '';
    // 注意不能用正文里“见 AD 2.24”之类的提及来判定目录页，否则正文引用的图号会被当成目录项
    return page.chartRole === 'CHART_INDEX' || /CHARTS RELATED TO (?:AN|THE) AERODROME/i.test(text) || looksLikeChartIndexContinuation(text);
  });
  const chartIndexItems = parseChartIndexFromPages(chartIndexPages);

  const structuredPages = pages.map((page) => {
    const header = parsePageHeader(page);
    const text = page.ocrText || page.textLayerText || '';
    if (looksLikeChartIndexContinuation(text)) page.chartRole = 'CHART_INDEX';
    page.aipPageNo = extractLikelyAipPageNo(text) || normalizeChartNo(page.aipPageNo) || header.aipPageNo;
    page.chartTitle ||= header.chartTitle;
    page.packageType ||= header.packageType;
    page.isTabular = header.isTabular;
    page.tabularNo = header.tabularNo;
    page.groupingReason = [];
    page.indexMatchedPackageId = undefined;
    page.headerMatchedPackageId = undefined;
    page.matchedPackageId = undefined;
    return page;
  });

  return {
    airportIcao: structuredPages.map((page) => page.aipPageNo?.match(/AD\s*2-([A-Z]{4})-/i)?.[1]).find(Boolean),
    sections: inferSections(structuredPages),
    chartIndexItems,
    globalSupportPages: extractSupportingInfo(structuredPages),
    pages: structuredPages,
  };
}

function looksLikeChartIndexContinuation(text: string) {
  const upper = text.toUpperCase();
  const programItemCount = (upper.match(/STANDARD\s+DEPARTURE\s+CHART|STANDARD\s+ARRIVAL\s+CHART|INSTRUMENT\s+APPROACH\s+CHART/g) || []).length;
  if (programItemCount >= 4 && /CHART\s+NAME\s+PAGE|AD\s*2\.?24|CHARTS RELATED TO (?:AN|THE) AERODROME/i.test(text)) return true;
  // 韩国式目录续页：图名 + 点线引导符（····）成排出现，图号列在页面另一栏
  const dottedLeaderCount = (text.match(/·{4,}|\.{6,}/g) || []).length;
  if (programItemCount >= 4 && dottedLeaderCount >= 4) return true;
  // 香港式目录续页：整页都是“图名 + 字母段图号”条目（正文引用图号一般不超过几个）
  return countLetteredChartNos(text) >= 8;
}

function inferSections(pages: PdfPageAsset[]): AipSection[] {
  const sections: AipSection[] = [];
  for (const page of pages) {
    const text = `${page.aipPageNo || ''} ${page.chartTitle || ''} ${page.ocrText || page.textLayerText || ''}`;
    const sectionNo = text.match(/AD\s*2\.?\s*(\d{1,2})/i)?.[0]?.replace(/\s+/g, ' ');
    const supportType = detectSupportType(page);
    const role = supportType === 'RUNWAY_DATA'
      ? 'RUNWAY_DATA'
      : supportType === 'AIRSPACE_COMMUNICATION'
        ? 'COMMUNICATION'
        : supportType === 'NAVAID'
          ? 'NAVAID'
          : supportType === 'FLIGHT_PROCEDURES'
            ? 'FLIGHT_PROCEDURES'
            : supportType === 'CHART_INDEX'
              ? 'CHART_INDEX'
              : page.chartRole === 'CHART'
                ? 'CHART_PAGE'
                : 'OTHER';
    if (!sectionNo && role === 'OTHER') continue;
    sections.push({
      sectionNo: sectionNo || page.aipPageNo || `PAGE-${page.pageNo}`,
      title: page.chartTitle || supportType || page.chartRole,
      startPageNo: page.pageNo,
      role,
    });
  }
  return sections;
}
