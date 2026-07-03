import type { PdfPageAsset, ProcedureGroup } from '../types/procedure';

export function groupProcedures(pages: PdfPageAsset[]): ProcedureGroup[] {
  const sortedPages = [...pages].sort((a, b) => a.pageNo - b.pageNo);
  const groups: ProcedureGroup[] = [];
  let current: ProcedureGroup | undefined;

  for (const page of sortedPages) {
    if (page.chartRole === 'CHART' || !current || shouldStartNewGroup(current, page)) {
      current = createGroup(page, groups.length + 1);
      groups.push(current);
      addPageToGroup(current, page);
      continue;
    }

    addPageToGroup(current, page);
    mergeGroupMetadata(current, page);
  }

  return groups.map((group) => ({
    ...group,
    groupName: buildGroupName(group),
    reviewRequired: group.reviewRequired || !group.chartPages.length,
  }));
}

export function regroupPages(pages: PdfPageAsset[]) {
  return groupProcedures(pages);
}

function createGroup(page: PdfPageAsset, index: number): ProcedureGroup {
  const category = normalizeCategory(page.procedureCategory);
  return {
    groupId: `group_${index}_${page.pageNo}`,
    groupName: '',
    procedureCategory: category,
    navigationType: page.navigationType,
    runway: page.runway,
    chartPages: [],
    tabularPages: [],
    coordinatePages: [],
    minimaPages: [],
    otherPages: [],
    procedureNames: [...(page.procedureNames ?? [])],
    status: 'GROUPED',
    reviewRequired: page.reviewRequired,
  };
}

function shouldStartNewGroup(current: ProcedureGroup, page: PdfPageAsset) {
  if (page.chartRole === 'CHART') return true;
  const lastPage = Math.max(...allGroupPages(current));
  if (Number.isFinite(lastPage) && page.pageNo - lastPage > 2) return true;
  if (page.procedureCategory !== 'UNKNOWN' && current.procedureCategory !== 'UNKNOWN' && page.procedureCategory !== current.procedureCategory) {
    return true;
  }
  if (page.runway && current.runway && page.runway !== current.runway) return true;
  return false;
}

function addPageToGroup(group: ProcedureGroup, page: PdfPageAsset) {
  if (page.chartRole === 'CHART') group.chartPages.push(page.pageNo);
  else if (page.chartRole === 'TABULAR_DESCRIPTION') group.tabularPages.push(page.pageNo);
  else if (page.chartRole === 'WAYPOINT_COORDINATES') group.coordinatePages.push(page.pageNo);
  else if (page.chartRole === 'MINIMA_TABLE') group.minimaPages.push(page.pageNo);
  else group.otherPages.push(page.pageNo);
}

function mergeGroupMetadata(group: ProcedureGroup, page: PdfPageAsset) {
  if (group.procedureCategory === 'UNKNOWN') group.procedureCategory = normalizeCategory(page.procedureCategory);
  if (group.navigationType === 'UNKNOWN') group.navigationType = page.navigationType;
  if (!group.runway && page.runway) group.runway = page.runway;
  group.procedureNames = Array.from(new Set([...group.procedureNames, ...(page.procedureNames ?? [])]));
  group.reviewRequired ||= page.reviewRequired;
}

function buildGroupName(group: ProcedureGroup) {
  const name = group.procedureNames.slice(0, 3).join(', ');
  const parts = [group.procedureCategory, group.navigationType, group.runway, name].filter(Boolean);
  const suffix = allGroupPages(group).sort((a, b) => a - b).join(', ');
  return `${parts.join(' / ') || '未识别程序'} · P${suffix}`;
}

function allGroupPages(group: ProcedureGroup) {
  return [...group.chartPages, ...group.tabularPages, ...group.coordinatePages, ...group.minimaPages, ...group.otherPages];
}

function normalizeCategory(category: PdfPageAsset['procedureCategory']): ProcedureGroup['procedureCategory'] {
  if (category === 'ARRIVAL' || category === 'DEPARTURE' || category === 'APPROACH') return category;
  return 'UNKNOWN';
}
