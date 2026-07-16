import crypto from 'node:crypto';
import type { PdfPageAsset, ProcedureGroup, ProcedureTask } from '../../../types/procedure';

/**
 * Hash only recognition inputs. V1/V2 outputs, UI state and task timestamps are
 * intentionally excluded so that re-running recognition does not change its own input hash.
 */
export function buildSourcePackageHash(task: ProcedureTask, group: ProcedureGroup) {
  const pageNos = packagePageNos(group);
  const pageByNo = new Map(task.pages.map((page) => [page.pageNo, page]));
  const hash = crypto.createHash('sha256');
  update(hash, {
    taskId: task.taskId,
    fileName: task.fileName,
    sourceFiles: task.sourceFiles ?? [],
    package: {
      groupId: group.groupId,
      packageId: group.packageId,
      packageName: group.packageName,
      packageType: group.packageType,
      procedureCategory: group.procedureCategory,
      navigationType: group.navigationType,
      runway: group.runway,
      chartTitle: group.chartTitle,
      chartNo: group.chartNo,
      relatedChartNos: group.relatedChartNos ?? [],
      procedureNames: group.procedureNames,
      pageNos,
    },
  });
  for (const pageNo of pageNos) updatePage(hash, pageByNo.get(pageNo), pageNo);
  return `sha256:${hash.digest('hex')}`;
}

export function packagePageNos(group: ProcedureGroup) {
  return [...new Set([
    ...(group.chartPages ?? []),
    ...(group.tabularPages ?? []),
    ...(group.coordinatePages ?? []),
    ...(group.minimaPages ?? []),
    ...(group.textSupplementPages ?? []),
    ...(group.supportingPages ?? []),
    ...(group.otherPages ?? []),
  ])].sort((a, b) => a - b);
}

function updatePage(hash: crypto.Hash, page: PdfPageAsset | undefined, pageNo: number) {
  if (!page) {
    update(hash, { pageNo, missing: true });
    return;
  }
  update(hash, {
    pageNo: page.pageNo,
    aipPageNo: page.aipPageNo,
    sourceFileName: page.sourceFileName,
    chartRole: page.chartRole,
    procedureCategory: page.procedureCategory,
    navigationType: page.navigationType,
    runway: page.runway,
    chartTitle: page.chartTitle,
    procedureNames: page.procedureNames ?? [],
    imageUrl: page.imageUrl,
    sourceWidthPt: page.sourceWidthPt,
    sourceHeightPt: page.sourceHeightPt,
    textLayerQuality: page.textLayerQuality,
  });
  hash.update('\u0000text-layer\u0000');
  hash.update(page.textLayerText ?? '');
  hash.update('\u0000ocr\u0000');
  hash.update(page.ocrText ?? '');
}

function update(hash: crypto.Hash, value: unknown) {
  hash.update(JSON.stringify(value));
  hash.update('\u0000');
}

