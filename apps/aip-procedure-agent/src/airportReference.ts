import { parseCoordinate } from './coordinate';
import type { AgentTask, BusinessProcedurePackage, PackagePageRef, PageAsset } from './domain';

/**
 * 机场级参考页（跑道数据、导航台数据）识别与挂载。
 *
 * 这些页面不属于任何一条程序，却是每条程序都需要的：没有跑道入口坐标，离场的起点就锚不住
 * （WMKJ 实测 RWY16 一直 UNRESOLVED，导致 4-5 条腿画不出来、机场也显示不出来）；
 * 没有导航台数据，传统程序的预检会一直报 NAVAID_DATA_MISSING。
 * 分组阶段模型只关心"这条程序用哪几页"，不会主动把它们带上，所以这里确定性地补挂。
 *
 * 判据用 ICAO AD 2.x 小节编号：Annex 15 规定 AD 2.12 = 跑道物理特性、
 * AD 2.19 = 无线电导航与着陆设备。两份真实语料（WMKJ / OMAA）都遵循。
 * 不用标题文字匹配——那是语言相关的，编号不是。
 */

const RUNWAY_SECTION = /\bAD\s?2\.12\b/i;
const NAVAID_SECTION = /\bAD\s?2\.19\b/i;
/** 跑道页还要有实际坐标才算数：只是引用了 AD 2.12 的页面不算。 */
const MIN_RUNWAY_COORDINATES = 2;

export interface AirportReferencePages { runwayPages: PageAsset[]; navaidPages: PageAsset[] }

export function findAirportReferencePages(pages: PageAsset[]): AirportReferencePages {
  const runwayPages: PageAsset[] = [];
  const navaidPages: PageAsset[] = [];
  for (const page of pages) {
    const flat = flatten(page.nativeText);
    if (RUNWAY_SECTION.test(flat) && countCoordinates(flat) >= MIN_RUNWAY_COORDINATES) runwayPages.push(page);
    if (NAVAID_SECTION.test(flat)) navaidPages.push(page);
  }
  return { runwayPages, navaidPages };
}

/**
 * 把参考页作为共享页挂到每个程序包上。已经挂过的页不重复添加。
 * 返回实际发生的挂载数，供调用方决定是否重算派生的 sources。
 */
export function attachAirportReferencePages(pkg: BusinessProcedurePackage, reference: AirportReferencePages): number {
  const existing = new Set(pkg.packagePages.map((ref) => `${ref.documentId}:${ref.pageNumber}`));
  let attached = 0;
  for (const [pages, role] of [[reference.runwayPages, 'RUNWAY_DATA'], [reference.navaidPages, 'NAVAID_DATA']] as const) {
    for (const page of pages) {
      const key = `${page.documentId}:${page.pageNumber}`;
      if (existing.has(key)) continue;
      existing.add(key);
      pkg.packagePages.push({
        documentId: page.documentId || '',
        fileName: page.fileName || '',
        pageNumber: page.pageNumber,
        pageRole: role,
        isShared: true,
        confidence: 1,
      } satisfies PackagePageRef);
      attached += 1;
    }
  }
  return attached;
}

/**
 * 坐标要在合并空白后的整页文本上找，不能按行找：
 * nativeText 是把每个 textSpan 各占一行拼起来的，"013826N" 和 "1034013E" 常被拆到两行，
 * 逐行解析永远读不到成对的经纬度。
 */
function countCoordinates(flatText: string) {
  let count = 0;
  for (const match of flatText.matchAll(/\d{2,3}\d{2}\d{2}(?:\.\d+)?\s*[NS][\s,;/]*\d{3}\d{2}\d{2}(?:\.\d+)?\s*[EW]/g)) {
    try { const parsed = parseCoordinate(match[0]); if (Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) count += 1; } catch { /* 该片段不是坐标 */ }
  }
  return count;
}

function flatten(text?: string) { return String(text ?? '').replace(/\s+/g, ' '); }

export function referenceSummary(task: AgentTask, reference: AirportReferencePages) {
  void task;
  return {
    runwayPages: reference.runwayPages.map((page) => page.pageNumber),
    navaidPages: reference.navaidPages.map((page) => page.pageNumber),
  };
}
