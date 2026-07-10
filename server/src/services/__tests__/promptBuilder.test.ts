import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PdfPageAsset, ProcedureGroup } from '../../types/procedure';
import { buildAiInputPackage } from '../aiInputPackageBuilder';
import { buildPrompt } from '../prompt/promptBuilder';
import { routePromptTemplate } from '../prompt/promptRouter';

describe('prompt builder', () => {
  it('routes RNAV STAR packages to the versioned RNAV STAR prompt', async () => {
    const group: ProcedureGroup = {
      groupId: 'pkg-rnav-star',
      packageId: 'pkg-rnav-star',
      groupName: 'RWY16 RNAV STAR EMTUV 1E OMKOM 1E PIMOK 1E ADLOV 1E',
      packageName: 'RWY16 RNAV STAR EMTUV 1E OMKOM 1E PIMOK 1E ADLOV 1E',
      packageType: 'STAR',
      procedureCategory: 'ARRIVAL',
      navigationType: 'RNAV',
      runway: '16',
      chartNo: 'AD 2-WMKJ-7-1',
      chartPages: [51],
      tabularPages: [52],
      coordinatePages: [53],
      minimaPages: [],
      otherPages: [],
      procedureNames: ['EMTUV 1E', 'OMKOM 1E', 'PIMOK 1E', 'ADLOV 1E'],
      status: 'GROUPED',
    };
    const pages = [page(51, 'CHART'), page(52, 'TABULAR_DESCRIPTION'), page(53, 'WAYPOINT_COORDINATES')];
    const aiInputPackage = buildAiInputPackage(group, pages, 'gpt-5.5');
    const builtPrompt = await buildPrompt({
      taskId: 'task-test',
      packageId: group.packageId!,
      procedurePackage: group,
      aiInputPackage,
    });

    assert.equal(routePromptTemplate(group).id, 'rnav_star_v1');
    assert.equal(builtPrompt.promptTemplateId, 'rnav_star_v1');
    assert.equal(builtPrompt.outputSchemaName, 'procedure-understanding.schema.json');
    assert.match(builtPrompt.userPrompt, /RNAV STAR recognition/);
    assert.match(builtPrompt.userPrompt, /"pageNo": 51/);
    assert.deepEqual(builtPrompt.inputImages.map((inputPage) => inputPage.pageNo), [51, 52, 53]);
  });

  it('routes RADAR SID packages to the conventional SID prompt', async () => {
    const group: ProcedureGroup = {
      groupId: 'pkg-radar-sid',
      packageId: 'pkg-radar-sid',
      groupName: 'RWY16/34 RADAR SID TWO DEPARTURE',
      packageName: 'RWY16/34 RADAR SID TWO DEPARTURE',
      packageType: 'SID',
      procedureCategory: 'DEPARTURE',
      navigationType: 'RADAR',
      runway: 'RWY16/34',
      chartNo: 'AD 2-WMKJ-6-1',
      chartPages: [31],
      tabularPages: [],
      coordinatePages: [],
      minimaPages: [],
      otherPages: [],
      procedureNames: ['JOHOR RADAR TWO DEPARTURE'],
      status: 'GROUPED',
    };
    const pages = [page(31, 'CHART')];
    const aiInputPackage = buildAiInputPackage(group, pages, 'gpt-5.5');
    const builtPrompt = await buildPrompt({
      taskId: 'task-test',
      packageId: group.packageId!,
      procedurePackage: group,
      aiInputPackage,
    });

    assert.equal(routePromptTemplate(group).id, 'conventional_sid_v1');
    assert.equal(builtPrompt.promptTemplateId, 'conventional_sid_v1');
    assert.match(builtPrompt.userPrompt, /Conventional \/ RADAR SID recognition/);
    assert.match(builtPrompt.userPrompt, /turn to assigned heading/);
  });
});

function page(pageNo: number, chartRole: PdfPageAsset['chartRole']): PdfPageAsset {
  return {
    pageNo,
    aipPageNo: `AD 2-WMKJ-${pageNo}`,
    imageUrl: `/uploads/task-test/page-${pageNo}.png`,
    thumbnailUrl: `/uploads/task-test/page-${pageNo}.thumb.png`,
    textLayerText: `Mock page ${pageNo}`,
    chartRole,
    procedureCategory: 'UNKNOWN',
    navigationType: 'UNKNOWN',
    confidence: 0.95,
    reviewRequired: false,
  };
}
