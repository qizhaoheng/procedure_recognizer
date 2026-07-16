import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import type { PdfPageAsset, ProcedureGroup, ProcedureTask } from '../../types/procedure';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type PageLayoutStageResult,
} from '../recognition-v2/contracts/index';
import { executeProcedureIdentity } from '../recognition-v2/identity/procedureIdentityExecutor';
import { renderDynamicRegionCrop } from '../recognition-v2/layout/dynamicRegionCrop';
import { executePageLayout } from '../recognition-v2/layout/pageLayoutExecutor';
import { analyzePageLayoutWithRules } from '../recognition-v2/layout/ruleBasedPageLayout';
import type { VisionStageClient } from '../recognition-v2/orchestration/visionStageClient';

describe('Recognition V2 Phase 2 page layout', () => {
  it('detects multiple simultaneous roles instead of forcing a single page type', () => {
    const page = fixture().page;
    page.textLayerText = [
      'STANDARD ARRIVAL CHART - INSTRUMENT',
      'RUTAS FOUR ARRIVAL',
      'TABULAR DESCRIPTION',
      'NOTES: MAX IAS 220KT',
      'MSA 25 NM',
    ].join('\n');
    const result = analyzePageLayoutWithRules(page);
    assert.ok(result.pageRoles.includes('PROCEDURE_DIAGRAM'));
    assert.ok(result.pageRoles.includes('PROCEDURE_TITLE'));
    assert.ok(result.pageRoles.includes('PROCEDURE_LEG_TABLE'));
    assert.ok(result.pageRoles.includes('PROCEDURE_NOTES'));
    assert.ok(result.pageRoles.includes('MSA'));
    assert.equal(result.analysisMethod, 'RULES_ONLY');
    assert.ok(result.regions.every((region) => region.bbox.every((value) => value >= 0 && value <= 1)));
  });

  it('merges validated model regions with rule hints and records model provenance', async () => {
    const { task, group } = fixture();
    const visionClient: VisionStageClient = async (request) => ({
      parsedJson: {
        pageNo: 1,
        pageRoles: ['PROCEDURE_TITLE', 'PROCEDURE_DIAGRAM', 'PROCEDURE_LEG_TABLE'],
        regions: [
          { type: 'PROCEDURE_TITLE', bbox: [0.02, 0.02, 0.98, 0.16], rotationDeg: 0, readingOrder: 0, confidence: 0.98 },
          { type: 'PROCEDURE_DIAGRAM', bbox: [0.03, 0.17, 0.61, 0.94], rotationDeg: 0, readingOrder: 1, confidence: 0.94 },
          { type: 'PROCEDURE_LEG_TABLE', bbox: [0.62, 0.17, 0.98, 0.94], rotationDeg: 0, readingOrder: 2, confidence: 0.92 },
        ],
        warnings: [],
      },
      execution: executionRef(request, 'layout-model-run'),
      audit: auditValue(request),
    });
    const result = await executePageLayout({
      task,
      group,
      model: 'test-vision',
      useModel: true,
      stageInputHash: 'sha256:layout',
      visionClient,
    });
    assert.equal(result.output.pages[0].analysisMethod, 'HYBRID');
    assert.equal(result.output.pages[0].modelExecution?.runId, 'layout-model-run');
    assert.ok(result.output.pages[0].regions.some((region) => region.type === 'PROCEDURE_LEG_TABLE' && region.regionId.includes('vision')));
    assert.equal(result.auditArtifacts.length, 1);
  });

  it('persists the raw model audit before rejecting an invalid structured result', async () => {
    const { task, group } = fixture();
    const audits: unknown[] = [];
    const visionClient: VisionStageClient = async (request) => ({
      parsedJson: { pageNo: 1, pageRoles: [], regions: [] },
      execution: executionRef(request, 'invalid-layout-run'),
      audit: auditValue(request),
    });
    await assert.rejects(() => executePageLayout({
      task,
      group,
      model: 'test-vision',
      useModel: true,
      stageInputHash: 'sha256:layout',
      visionClient,
      onAuditArtifact: (artifact) => audits.push(artifact),
    }), /failed contract validation/);
    assert.equal(audits.length, 1, 'failed model output must remain auditable');
  });

  it('renders a validated arbitrary region crop rather than a fixed named crop', async () => {
    const crop = await renderDynamicRegionCrop(testImageDataUrl(), [0.25, 0.25, 0.75, 0.75], 90, 2);
    assert.ok(crop.widthPx > 0);
    assert.ok(crop.heightPx > 0);
    assert.equal(crop.rotationDeg, 90);
    assert.match(crop.dataUrl, /^data:image\/png;base64,/);
    await assert.rejects(() => renderDynamicRegionCrop(testImageDataUrl(), [0.8, 0.2, 0.3, 0.9]), /positive area/);
  });
});

describe('Recognition V2 Phase 2 procedure identity', () => {
  it('keeps formal procedure names separate from prominent waypoints and transitions', async () => {
    const { task, group, page } = fixture();
    page.textLayerText = [
      'STANDARD DEPARTURE CHART - INSTRUMENT',
      'RUTAS FOUR DEPARTURE',
      'VAMOS',
      'DRAKY TRANSITION',
      'RWY 16R',
    ].join('\n');
    page.pageClassification = {
      pageNumber: 1,
      pageRole: 'PROCEDURE_DIAGRAM',
      procedureNameCandidates: [{ value: 'RUTAS FOUR DEPARTURE', source: 'TITLE_BLOCK', confidence: 0.95 }],
      confirmedProcedureName: 'RUTAS FOUR DEPARTURE',
      procedureIdCandidate: 'RUTAS4',
      runways: ['RWY16R'],
      transitionNames: ['DRAKY'],
    };
    page.procedureNames = ['VAMOS'];
    const result = await executeProcedureIdentity({
      task,
      group,
      layout: layoutFixture(),
      model: 'none',
      useModel: false,
      stageInputHash: 'sha256:identity',
    });
    const procedureNames = result.output.candidates
      .filter((candidate) => candidate.fieldName === 'procedureName')
      .map((candidate) => candidate.normalizedValue);
    assert.ok(procedureNames.includes('RUTAS FOUR DEPARTURE'));
    assert.ok(!procedureNames.includes('VAMOS'));
    assert.ok(result.output.candidates.some((candidate) => candidate.fieldName === 'transitionName' && candidate.normalizedValue === 'DRAKY'));
    assert.ok(result.output.candidates.every((candidate) => candidate.value === null || candidate.sourceEvidenceIds.length > 0));
  });

  it('adds model observations as independent evidence-backed candidates without overwriting rules', async () => {
    const { task, group } = fixture();
    const visionClient: VisionStageClient = async (request) => ({
      parsedJson: {
        observations: [{
          entityType: 'PROCEDURE',
          fieldName: 'procedureName',
          value: 'RUTAS FOUR DEPARTURE',
          pageNo: 1,
          regionId: 'p1-title',
          rawText: 'RUTAS FOUR DEPARTURE',
          visualDescription: null,
          confidence: 0.97,
        }],
        unresolvedFields: ['effectiveDate'],
        warnings: [],
      },
      execution: executionRef(request, 'identity-model-run'),
      audit: auditValue(request),
    });
    const result = await executeProcedureIdentity({
      task,
      group,
      layout: layoutFixture(),
      model: 'test-vision',
      useModel: true,
      stageInputHash: 'sha256:identity',
      visionClient,
    });
    const names = result.output.candidates.filter((candidate) => candidate.fieldName === 'procedureName');
    assert.ok(names.length >= 2, 'rule and model candidates must both remain available to fusion');
    const modelCandidate = names.find((candidate) => candidate.sourceEvidenceIds.some((id) =>
      result.output.evidence.find((evidence) => evidence.evidenceId === id)?.modelExecution?.runId === 'identity-model-run'));
    assert.ok(modelCandidate);
    assert.equal(modelCandidate.reviewRequired, true, 'a model-only identity candidate cannot approve itself');
    const modelEvidence = result.output.evidence.find((evidence) => evidence.modelExecution?.runId === 'identity-model-run');
    assert.deepEqual(modelEvidence?.bbox, [0, 0, 1, 0.25]);
    assert.equal(modelEvidence?.fileName, 'AD2.pdf');
    assert.equal(modelEvidence?.aipPageNo, 'AD 2-ZZZZ-SID-1');
    assert.ok(result.output.candidates.some((candidate) => candidate.fieldName === 'effectiveDate' && candidate.status === 'UNRESOLVED'));
    assert.equal(result.auditArtifacts.length, 1);
  });

  it('rejects model identity observations tied to a region that was never supplied', async () => {
    const { task, group } = fixture();
    const visionClient: VisionStageClient = async (request) => ({
      parsedJson: {
        observations: [{
          entityType: 'PROCEDURE',
          fieldName: 'procedureName',
          value: 'INVENTED 9A',
          pageNo: 1,
          regionId: 'not-supplied',
          rawText: 'INVENTED 9A',
          visualDescription: null,
          confidence: 0.99,
        }],
        unresolvedFields: [],
        warnings: [],
      },
      execution: executionRef(request, 'identity-model-run'),
      audit: auditValue(request),
    });
    const result = await executeProcedureIdentity({
      task,
      group,
      layout: layoutFixture(),
      model: 'test-vision',
      useModel: true,
      stageInputHash: 'sha256:identity',
      visionClient,
    });
    assert.ok(!result.output.candidates.some((candidate) => candidate.value === 'INVENTED 9A'));
    assert.ok(result.output.warnings.some((warning) => warning.includes('unprovided region')));
  });
});

function fixture(): { task: ProcedureTask; group: ProcedureGroup; page: PdfPageAsset } {
  const page: PdfPageAsset = {
    pageNo: 1,
    aipPageNo: 'AD 2-ZZZZ-SID-1',
    imageUrl: testImageDataUrl(),
    textLayerText: 'STANDARD DEPARTURE CHART - INSTRUMENT\nRUTAS FOUR DEPARTURE\nRWY 16R',
    chartRole: 'CHART',
    procedureCategory: 'DEPARTURE',
    navigationType: 'RNAV',
    runway: 'RWY16R',
    chartTitle: 'STANDARD DEPARTURE CHART - INSTRUMENT RUTAS FOUR DEPARTURE',
    procedureNames: ['RUTAS FOUR DEPARTURE'],
  };
  const group: ProcedureGroup = {
    groupId: 'package_1',
    packageId: 'package_1',
    groupName: 'RUTAS FOUR DEPARTURE',
    packageName: 'RUTAS FOUR DEPARTURE',
    packageType: 'SID',
    procedureCategory: 'DEPARTURE',
    navigationType: 'RNAV',
    runway: 'RWY16R',
    chartNo: 'AD 2-ZZZZ-SID-1',
    chartPages: [1],
    tabularPages: [],
    coordinatePages: [],
    minimaPages: [],
    otherPages: [],
    procedureNames: ['RUTAS FOUR DEPARTURE'],
    status: 'GROUPED',
  };
  const task: ProcedureTask = {
    taskId: 'task_1',
    fileName: 'AD2.pdf',
    filePath: 'AD2.pdf',
    status: 'GROUPED',
    pages: [page],
    groups: [group],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
  return { task, group, page };
}

function layoutFixture(): PageLayoutStageResult {
  return {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.pageLayoutStageResult,
    pages: [{
      contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
      schemaId: RECOGNITION_V2_SCHEMA_IDS.pageLayoutResult,
      pageNo: 1,
      pageRoles: ['PROCEDURE_TITLE', 'PROCEDURE_DIAGRAM'],
      regions: [{
        regionId: 'p1-title',
        pageNo: 1,
        type: 'PROCEDURE_TITLE',
        bbox: [0, 0, 1, 0.25],
        rotationDeg: 0,
        readingOrder: 0,
        confidence: 0.9,
        reviewRequired: false,
      }],
      missingExpectedRoles: [],
      analysisMethod: 'RULES_ONLY',
      warnings: [],
    }],
    warnings: [],
    completedAt: '2026-07-16T00:00:00.000Z',
  };
}

function executionRef(request: Parameters<VisionStageClient>[0], runId: string) {
  return {
    model: request.model,
    promptId: request.promptId,
    promptVersion: request.promptVersion,
    schemaId: request.schemaId,
    schemaVersion: request.schemaVersion,
    inputHash: request.inputHash,
    runId,
  };
}

function auditValue(request: Parameters<VisionStageClient>[0]) {
  return {
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    rawText: '{}',
    rawResponse: {},
    provider: 'test',
    model: request.model,
    schemaId: request.schemaId,
  };
}

function testImageDataUrl() {
  const canvas = createCanvas(120, 80);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 120, 80);
  context.fillStyle = '#111';
  context.fillRect(20, 20, 80, 40);
  return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
}
