import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import type { PdfPageAsset, ProcedureGroup, ProcedureTask } from '../../types/procedure';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type PageLayoutStageResult,
  type PageRegion,
} from '../recognition-v2/contracts/index';
import { extractAipCoordinatePairs, parseAipCoordinatePair } from '../recognition-v2/coordinates/coordinateParser';
import { executeWaypointNavaid } from '../recognition-v2/coordinates/waypointNavaidExecutor';
import { executeProcedureTable } from '../recognition-v2/tables/procedureTableExecutor';
import type { VisionStageClient } from '../recognition-v2/orchestration/visionStageClient';

describe('Recognition V2 Phase 3 deterministic coordinate parser', () => {
  it('parses common AIP coordinate dialects without a model', () => {
    const compact = parseAipCoordinatePair('ALPHA 012345.6N 1031234.5E');
    const dms = parseAipCoordinatePair(`ALPHA 01°23'45.6"N 103°12'34.5"E`);
    const dm = parseAipCoordinatePair(`ALPHA 01°23.500'N 103°12.250'E`);
    const decimal = parseAipCoordinatePair('ALPHA 1.395N 103.209E');
    const compactNoSeparator = parseAipCoordinatePair('ALPHA 012345.6N1031234.5E');
    assert.equal(compact?.format, 'COMPACT_DMS');
    assert.equal(dms?.format, 'SYMBOL_DMS');
    assert.equal(dm?.format, 'DEGREES_MINUTES');
    assert.equal(decimal?.format, 'DECIMAL_DEGREES');
    assert.equal(compactNoSeparator?.format, 'COMPACT_DMS');
    assert.ok(Math.abs((compact?.latitude ?? 0) - 1.396) < 0.001);
    assert.ok(Math.abs((dms?.longitude ?? 0) - 103.209583333) < 1e-8);
  });

  it('rejects impossible minutes, seconds, latitude and longitude', () => {
    assert.equal(parseAipCoordinatePair('019945N 1031234E'), undefined);
    assert.equal(parseAipCoordinatePair('912345N 1031234E'), undefined);
    assert.equal(parseAipCoordinatePair('012345N 1811234E'), undefined);
    assert.equal(extractAipCoordinatePairs('no coordinate here').length, 0);
  });
});

describe('Recognition V2 Phase 3 procedure table', () => {
  it('separates physical rows from deterministic field candidates and leaves absent path terminators unresolved', async () => {
    const { task, group, tablePage } = fixture();
    tablePage.textLayerText = [
      'SEQ  PATH TERM  WAYPOINT  COURSE  DISTANCE  ALTITUDE',
      '10  TF  ALPHA  145°  12.5 NM  AT OR ABOVE 3000 FT',
      '20  CLIMB  -  160°  -  5000 FT',
    ].join('\n');
    const result = await executeProcedureTable({
      task,
      group,
      layout: layout([tableRegion()]),
      model: 'none',
      useModel: false,
      stageInputHash: 'sha256:table',
    });
    assert.equal(result.output.tables.length, 1);
    assert.equal(result.output.tables[0].analysisMethod, 'TEXT_RULES');
    assert.ok(result.output.tables[0].rows.some((row) => row.rowType === 'HEADER'));
    assert.ok(result.output.extraction.candidates.some((item) => item.fieldName === 'pathTerminator' && item.normalizedValue === 'TF'));
    assert.ok(result.output.extraction.candidates.some((item) => item.fieldName === 'courseDegMag' && item.normalizedValue === 145));
    assert.ok(result.output.extraction.candidates.some((item) => item.fieldName === 'distanceNm' && item.normalizedValue === 12.5));
    assert.ok(result.output.extraction.candidates.some((item) => item.fieldName === 'pathTerminator' && item.status === 'UNRESOLVED'));
    assert.ok(!result.output.extraction.candidates.some((item) => item.fieldName === 'pathTerminator' && item.normalizedValue === 'CA'));
  });

  it('uses the model only for physical cell restoration and preserves its audit', async () => {
    const { task, group } = fixture();
    const visionClient: VisionStageClient = async (request) => ({
      parsedJson: {
        pageNo: 1,
        regionId: 'p1-table',
        columnCount: 3,
        rows: [
          { rowIndex: 0, rowType: 'HEADER', rawText: 'SEQ PATH TERM FIX', confidence: 0.98, cells: [
            { columnIndex: 0, rowSpan: 1, columnSpan: 1, rawText: 'SEQ', confidence: 0.98 },
            { columnIndex: 1, rowSpan: 1, columnSpan: 1, rawText: 'PATH TERM', confidence: 0.98 },
            { columnIndex: 2, rowSpan: 1, columnSpan: 1, rawText: 'FIX', confidence: 0.98 },
          ] },
          { rowIndex: 1, rowType: 'DATA', rawText: '10 IF ALPHA', confidence: 0.95, cells: [
            { columnIndex: 0, rowSpan: 1, columnSpan: 1, rawText: '10', confidence: 0.95 },
            { columnIndex: 1, rowSpan: 1, columnSpan: 1, rawText: 'IF', confidence: 0.95 },
            { columnIndex: 2, rowSpan: 1, columnSpan: 1, rawText: 'ALPHA', bbox: [0.5, 0.2, 0.9, 0.3], confidence: 0.95 },
          ] },
        ],
        warnings: [],
      },
      execution: executionRef(request, 'table-model-run'),
      audit: auditValue(request),
    });
    const result = await executeProcedureTable({
      task,
      group,
      layout: layout([{ ...tableRegion(), bbox: [0.1, 0.2, 0.9, 0.8] }]),
      model: 'test-vision',
      useModel: true,
      stageInputHash: 'sha256:table',
      visionClient,
    });
    assert.equal(result.output.tables[0].analysisMethod, 'VISION_MODEL');
    assert.equal(result.output.tables[0].rows[1].cells[2].rawText, 'ALPHA');
    assert.deepEqual(result.output.tables[0].rows[1].cells[2].bbox, [0.5, 0.32, 0.82, 0.38]);
    assert.equal(result.auditArtifacts.length, 1);
    const toFix = result.output.extraction.candidates.find((item) => item.fieldName === 'toFix' && item.normalizedValue === 'ALPHA');
    assert.equal(toFix?.reviewRequired, true, 'model-only semantic candidates must require review');
    const toFixEvidence = result.output.extraction.evidence.find((item) => toFix?.sourceEvidenceIds.includes(item.evidenceId));
    assert.deepEqual(toFixEvidence?.bbox, [0.5, 0.32, 0.82, 0.38]);
  });

  it('preserves magnetic and true course, magnetic variation, and turn as separate 424 fields', async () => {
    const { task, group } = fixture();
    const headers = ['SEQ', 'PATH TERM', 'FIX', 'COURSE', 'MAGNETIC VARIATION', 'TURN DIRECTION'];
    const values = ['10', 'CF', 'HH311', '( ) 183 180', '3 0 +', 'R'];
    const visionClient: VisionStageClient = async (request) => ({
      parsedJson: {
        pageNo: 1, regionId: 'p1-table', columnCount: headers.length,
        rows: [
          { rowIndex: 0, rowType: 'HEADER', rawText: headers.join(' | '), confidence: 0.99, cells: headers.map((rawText, columnIndex) => ({ columnIndex, rowSpan: 1, columnSpan: 1, rawText, confidence: 0.99 })) },
          { rowIndex: 1, rowType: 'DATA', rawText: values.join(' | '), confidence: 0.98, cells: values.map((rawText, columnIndex) => ({ columnIndex, rowSpan: 1, columnSpan: 1, rawText, confidence: 0.98 })) },
        ], warnings: [],
      },
      execution: executionRef(request, 'course-pair-model-run'), audit: auditValue(request),
    });
    const result = await executeProcedureTable({ task, group, layout: layout([tableRegion()]), model: 'test-vision', useModel: true, stageInputHash: 'sha256:course-pair', visionClient });
    const fields = new Map(result.output.extraction.candidates.map((candidate) => [candidate.fieldName, candidate.normalizedValue]));
    assert.equal(fields.get('courseDegMag'), 183);
    assert.equal(fields.get('courseDegTrue'), 180);
    assert.equal(fields.get('magneticVariationDeg'), 3);
    assert.equal(fields.get('turnDirection'), 'R');
  });

  it('rejects an invalid model table and completes with deterministic recovery', async () => {
    const { task, group, tablePage } = fixture();
    tablePage.textLayerText = [
      'SEQ  PATH TERM  WAYPOINT  COURSE  DISTANCE  ALTITUDE',
      '10  TF  ALPHA  145°  12.5 NM  AT OR ABOVE 3000 FT',
      '20  TF  BRAVO  160°  8.0 NM  5000 FT',
    ].join('\n');
    const visionClient: VisionStageClient = async (request) => ({
      parsedJson: {
        pageNo: 1,
        regionId: 'p1-table',
        rows: [{ rowType: 'header', cells: [{ rawText: 'PAGE HEADER', bbox: [0, 0, 120, 40] }] }],
      },
      execution: executionRef(request, 'invalid-table-model-run'),
      audit: auditValue(request),
    });
    const result = await executeProcedureTable({ task, group, layout: layout([tableRegion()]), model: 'test-vision', useModel: true, stageInputHash: 'sha256:table', visionClient });
    assert.equal(result.output.tables[0].analysisMethod, 'TEXT_RULES');
    assert.ok(result.output.extraction.candidates.some((item) => item.fieldName === 'toFix' && item.normalizedValue === 'ALPHA'));
    assert.ok(result.output.warnings.some((warning) => warning.includes('model result was rejected') || warning.includes('restoration was rejected')));
    assert.equal(result.auditArtifacts.length, 1, 'invalid model response remains auditable');
  });
});

describe('Recognition V2 Phase 3 waypoint and navaid extraction', () => {
  it('keeps printed coordinates observed and decimal coordinates deterministically derived', async () => {
    const { task, group, coordinatePage } = fixture();
    coordinatePage.textLayerText = [
      'WAYPOINT COORDINATES',
      `ALPHA 01°23'45.6"N 103°12'34.5"E`,
      'BRAVO 012346.0N 1031235.0E',
      'RUTAS 012347.0N 1031236.0E',
    ].join('\n');
    const result = await executeWaypointNavaid({
      task,
      group,
      layout: layout([coordinateRegion()]),
      model: 'none',
      useModel: false,
      stageInputHash: 'sha256:coordinate',
    });
    const latitude = result.output.candidates.find((item) => item.entityKey === 'FIX:ALPHA' && item.fieldName === 'latitude');
    assert.equal(latitude?.status, 'DERIVED');
    assert.equal(latitude?.derivation?.ruleId, 'AIP_COORDINATE_TO_DECIMAL');
    assert.ok(latitude?.sourceEvidenceIds.length);
    assert.ok(result.output.candidates.some((item) => item.entityKey === 'FIX:BRAVO' && item.fieldName === 'rawCoordinate'));
    assert.ok(!result.output.candidates.some((item) => item.value === 'RUTAS'), 'procedure name must not become a fix');
  });

  it('extracts visible navaid metadata while leaving a missing coordinate unresolved', async () => {
    const { task, group, navaidPage } = fixture();
    navaidPage.textLayerText = [
      'RADIO NAVIGATION AND LANDING AIDS',
      'VOR/DME VJB 113.50 MHz CH 82X 012345N 1031234E',
      'NDB NDBX 355 KHZ',
    ].join('\n');
    const result = await executeWaypointNavaid({
      task,
      group,
      layout: layout([navaidRegion()]),
      model: 'none',
      useModel: false,
      stageInputHash: 'sha256:navaid',
    });
    assert.ok(result.output.candidates.some((item) => item.entityKey === 'NAVAID:VJB' && item.fieldName === 'frequency'));
    assert.ok(result.output.candidates.some((item) => item.entityKey === 'NAVAID:NDBX' && item.fieldName === 'latitude' && item.status === 'UNRESOLVED'));
  });

  it('keeps vertically listed navaid rows separate and combines LOC plus DME for one identifier', async () => {
    const { task, group, navaidPage } = fixture();
    navaidPage.textLayerText = [
      'Navaid', 'Frequency', 'Coordinates',
      'SMT DVOR/DME', '114.8 MHZ', '(CH 95X)', '222015.43N 1135855.46E',
      'IZSR DME', 'CH 46X', '221747.78N 1135409.48E',
      'ITFR LOC', '108.75 MHZ',
      'ITFR DME', 'CH 24Y', '221955.16N 1135438.56E',
    ].join('\n');
    const result = await executeWaypointNavaid({
      task, group, layout: layout([navaidRegion()]), model: 'none', useModel: false, stageInputHash: 'sha256:navaid-table',
    });
    const value = (entity: string, field: string) => result.output.candidates.find((item) => item.entityKey === entity && item.fieldName === field)?.normalizedValue;
    assert.equal(value('NAVAID:SMT', 'navaidType'), 'DVOR/DME');
    assert.equal(value('NAVAID:IZSR', 'navaidType'), 'DME');
    assert.equal(value('NAVAID:IZSR', 'frequency'), undefined);
    assert.equal(value('NAVAID:ITFR', 'navaidType'), 'LOC/DME');
    assert.equal(value('NAVAID:ITFR', 'frequency'), '108.75 MHZ');
    assert.equal(value('NAVAID:ITFR', 'channel'), 'CH24Y');
  });

  it('never accepts model-provided decimal coordinates without deterministic parsing of printed coordinate text', async () => {
    const { task, group } = fixture();
    const visionClient: VisionStageClient = async (request) => ({
      parsedJson: {
        observations: [{
          entityType: 'FIX',
          identifier: 'ALPHA',
          coordinateText: 'NOT A PRINTED COORDINATE',
          navaidType: null,
          frequency: null,
          channel: null,
          pageNo: 2,
          regionId: 'p2-coordinate',
          rawText: 'ALPHA NOT A PRINTED COORDINATE',
          visualDescription: null,
          confidence: 0.99,
        }],
        warnings: [],
      },
      execution: executionRef(request, 'coordinate-model-run'),
      audit: auditValue(request),
    });
    const result = await executeWaypointNavaid({
      task,
      group,
      layout: layout([coordinateRegion()]),
      model: 'test-vision',
      useModel: true,
      stageInputHash: 'sha256:coordinate',
      visionClient,
    });
    assert.ok(result.output.candidates.some((item) => item.entityKey === 'FIX:ALPHA' && item.fieldName === 'latitude' && item.status === 'UNRESOLVED'));
    assert.ok(!result.output.candidates.some((item) => item.entityKey === 'FIX:ALPHA' && item.fieldName === 'latitude' && typeof item.value === 'number'));
    assert.ok(result.output.candidates.filter((item) => item.entityKey === 'FIX:ALPHA').every((item) => item.reviewRequired));
    assert.ok(result.output.warnings.some((warning) => warning.includes('could not be deterministically parsed')));
    assert.equal(result.auditArtifacts.length, 1);
  });

  it('treats an all-null singleton model response as no observation and preserves deterministic coordinates', async () => {
    const { task, group, coordinatePage } = fixture();
    coordinatePage.textLayerText = 'ALPHA 012345N 1031234E';
    const visionClient: VisionStageClient = async (request) => ({
      parsedJson: {
        pageNo: 2,
        regionId: 'p2-coordinate',
        identifier: null,
        entityType: null,
        coordinateText: null,
        frequency: null,
        channel: null,
        navaidType: null,
        rawText: null,
        visualDescription: null,
      },
      execution: executionRef(request, 'empty-coordinate-model-run'),
      audit: auditValue(request),
    });
    const result = await executeWaypointNavaid({
      task,
      group,
      layout: layout([coordinateRegion()]),
      model: 'test-vision',
      useModel: true,
      stageInputHash: 'sha256:coordinate',
      visionClient,
    });
    assert.ok(result.output.candidates.some((item) => item.entityKey === 'FIX:ALPHA' && item.fieldName === 'latitude' && item.status === 'DERIVED'));
    assert.ok(result.output.warnings.some((warning) => warning.includes('empty observation set')));
    assert.equal(result.auditArtifacts.length, 1);
  });
});

function fixture(): { task: ProcedureTask; group: ProcedureGroup; tablePage: PdfPageAsset; coordinatePage: PdfPageAsset; navaidPage: PdfPageAsset } {
  const tablePage: PdfPageAsset = page(1, 'TABULAR_DESCRIPTION');
  const coordinatePage: PdfPageAsset = page(2, 'WAYPOINT_COORDINATES');
  const navaidPage: PdfPageAsset = page(3, 'SUPPORT');
  const group: ProcedureGroup = {
    groupId: 'package_1',
    packageId: 'package_1',
    groupName: 'RUTAS FOUR DEPARTURE',
    packageName: 'RUTAS FOUR DEPARTURE',
    packageType: 'SID',
    procedureCategory: 'DEPARTURE',
    navigationType: 'RNAV',
    chartPages: [],
    tabularPages: [1],
    coordinatePages: [2],
    minimaPages: [],
    supportingPages: [3],
    otherPages: [],
    procedureNames: ['RUTAS'],
    supportingInfoRefs: { navaid: [3] },
    status: 'GROUPED',
  };
  const task: ProcedureTask = {
    taskId: 'task_1',
    fileName: 'AD2.pdf',
    filePath: 'AD2.pdf',
    status: 'GROUPED',
    pages: [tablePage, coordinatePage, navaidPage],
    groups: [group],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
  return { task, group, tablePage, coordinatePage, navaidPage };
}

function page(pageNo: number, chartRole: PdfPageAsset['chartRole']): PdfPageAsset {
  return {
    pageNo,
    aipPageNo: `AD 2-TEST-${pageNo}`,
    imageUrl: testImageDataUrl(),
    textLayerText: '',
    chartRole,
    procedureCategory: 'DEPARTURE',
    navigationType: 'RNAV',
  };
}

function layout(regions: PageRegion[]): PageLayoutStageResult {
  const byPage = new Map<number, PageRegion[]>();
  for (const region of regions) byPage.set(region.pageNo, [...(byPage.get(region.pageNo) ?? []), region]);
  return {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.pageLayoutStageResult,
    pages: [...byPage.entries()].map(([pageNo, pageRegions]) => ({
      contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
      schemaId: RECOGNITION_V2_SCHEMA_IDS.pageLayoutResult,
      pageNo,
      pageRoles: [...new Set(pageRegions.map((region) => region.type))],
      regions: pageRegions,
      missingExpectedRoles: [],
      analysisMethod: 'RULES_ONLY',
      warnings: [],
    })),
    warnings: [],
    completedAt: '2026-07-16T00:00:00.000Z',
  };
}

function tableRegion(): PageRegion {
  return region(1, 'p1-table', 'PROCEDURE_LEG_TABLE');
}

function coordinateRegion(): PageRegion {
  return region(2, 'p2-coordinate', 'WAYPOINT_COORDINATE_TABLE');
}

function navaidRegion(): PageRegion {
  return region(3, 'p3-navaid', 'SUPPORTING_INFORMATION');
}

function region(pageNo: number, regionId: string, type: PageRegion['type']): PageRegion {
  return { regionId, pageNo, type, bbox: [0, 0, 1, 1], rotationDeg: 0, readingOrder: 0, confidence: 0.9, reviewRequired: false };
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
  const canvas = createCanvas(120, 120);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 120, 120);
  context.fillStyle = '#000';
  context.fillText('AIP', 10, 20);
  return canvas.toDataURL('image/png');
}
