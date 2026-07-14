import type { ChartIndexItem, NavigationType, PackageType, PdfPageAsset, ProcedureCategory } from '../types/procedure';
import {
  buildNormalizedGroupKey,
  detectApproachProcedureNames,
  detectNavigationTypeForPackage,
  detectPackageType,
  detectProcedureNames,
  detectProcedureCategory,
  detectRunway,
  extractLikelyAipPageNo,
  normalizeChartNo,
  normalizeNumericChartNo,
} from './chartIndexParser';

export interface PageHeaderMetadata {
  aipPageNo?: string;
  chartTitle?: string;
  airportName?: string;
  airportIcao?: string;
  procedureCategory: ProcedureCategory;
  packageType: PackageType;
  navigationType: NavigationType;
  runway?: string;
  procedureNames: string[];
  isTabular: boolean;
  tabularNo?: number;
  normalizedGroupKey?: string;
}

export function parsePageHeader(page: PdfPageAsset): PageHeaderMetadata {
  const text = page.ocrText || page.textLayerText || '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  // 传原始文本保留换行（页脚图号独立成行）；字母段图号在正文中常作为引用出现，
  // 任意位置的松散匹配会误配，只有整行匹配或页首匹配才可信
  const aipPageNo = extractLikelyAipPageNo(text) || normalizeChartNo(page.aipPageNo) || normalizeNumericChartNo(normalized);
  const airportIcao = aipPageNo?.match(/AD\s*2-([A-Z]{4})-/i)?.[1];
  const chartTitle = page.chartTitle || detectChartTitle(text);
  const source = [chartTitle, normalized.slice(0, 900)].filter(Boolean).join(' ');
  const procedureCategory = page.procedureCategory !== 'UNKNOWN' ? page.procedureCategory : detectProcedureCategory(source);
  const packageType = detectPackageType(procedureCategory);
  const navigationType = page.navigationType !== 'UNKNOWN' ? page.navigationType : detectNavigationTypeForPackage(source, packageType);
  const runway = page.runway || detectRunway(source);
  const isTabular =
    page.chartRole === 'TABULAR_DESCRIPTION' ||
    page.chartRole === 'WAYPOINT_COORDINATES' ||
    page.chartRole === 'MINIMA_TABLE' ||
    /\(TABULAR\s*\d+\)|TABULAR DESCRIPTION/i.test(source);
  const tabularNo = Number(source.match(/\(TABULAR\s*(\d+)\)/i)?.[1]) || page.tabularNo;
  // 页面级确认名（标题区/表格标题来源，见 procedurePageClassifier）优先：它是程序身份的
  // 唯一可信来源；图面文本里的紧凑代号只在没有确认名时兜底。大字航路点永远不会成为确认名，
  // 因此含 VAMOS 大字的 RUTAS FOUR 页不会再被并进 VAMOS FOUR。
  const confirmedName = page.pageClassification?.confirmedProcedureName;
  const procedureNames =
    packageType === 'APPROACH'
      ? detectApproachProcedureNames(source, navigationType, runway)
      : confirmedName
        ? [confirmedName]
        : Array.from(new Set([...(page.procedureNames ?? []), ...detectProcedureNames(source, navigationType)]));
  const normalizedGroupKey =
    procedureCategory !== 'UNKNOWN'
      ? buildNormalizedGroupKey({ procedureCategory, packageType, navigationType, runway, procedureNames, chartName: chartTitle })
      : undefined;

  return {
    aipPageNo,
    chartTitle,
    airportIcao,
    procedureCategory,
    packageType,
    navigationType,
    runway,
    procedureNames,
    isTabular,
    tabularNo,
    normalizedGroupKey,
  };
}

export function pageHeaderToIndexItem(page: PdfPageAsset): ChartIndexItem | undefined {
  const metadata = parsePageHeader(page);
  if (!metadata.aipPageNo || !metadata.normalizedGroupKey || metadata.packageType === 'OTHER') return undefined;
  return {
    chartName: metadata.chartTitle || metadata.aipPageNo,
    chartNo: metadata.aipPageNo,
    procedureCategory: metadata.procedureCategory,
    packageType: metadata.packageType,
    navigationType: metadata.navigationType,
    runway: metadata.runway,
    procedureNames: metadata.procedureNames,
    isTabular: metadata.isTabular,
    tabularNo: metadata.tabularNo,
    normalizedGroupKey: metadata.normalizedGroupKey,
  };
}

function detectChartTitle(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const index = lines.findIndex((line) => /STANDARD ARRIVAL CHART|STANDARD DEPARTURE CHART|INSTRUMENT APPROACH CHART|TABULAR DESCRIPTION/i.test(line));
  if (index >= 0) return lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 3)).join(' ').slice(0, 220);
  return lines.find((line) => /RWY|RNAV|RNP|ILS|LOC|VOR|DME ARC/i.test(line))?.slice(0, 220);
}
