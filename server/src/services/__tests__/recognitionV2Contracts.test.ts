import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type ExtractionStageResult,
  type FusionStageResult,
  type PageLayoutResult,
  type RecognitionV2RunManifest,
  type ValidationStageResult,
} from '../recognition-v2/contracts/index';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.resolve(testDir, '..', 'recognition-v2', 'contracts', 'schemas');
const schemaFiles = [
  'common.schema.json',
  'run-manifest.schema.json',
  'page-layout-result.schema.json',
  'page-layout-stage-result.schema.json',
  'extraction-stage-result.schema.json',
  'procedure-table-stage-result.schema.json',
  'fusion-stage-result.schema.json',
  'validation-stage-result.schema.json',
  'model-page-layout.schema.json',
  'model-procedure-identity.schema.json',
  'model-table-physical.schema.json',
  'model-waypoint-navaid.schema.json',
] as const;

const version = <TSchemaId extends string>(schemaId: TSchemaId) => ({
  contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
  schemaId,
} as const);

describe('recognition V2 contracts', () => {
  it('compiles every versioned JSON Schema and accepts representative stage results', async () => {
    const validators = await loadValidators();

    const manifest: RecognitionV2RunManifest = {
      ...version(RECOGNITION_V2_SCHEMA_IDS.runManifest),
      runId: 'v2_run_1',
      taskId: 'task_1',
      packageId: 'package_1',
      status: 'CREATED',
      sourcePackageHash: 'sha256:package',
      stages: [{ stage: 'PAGE_LAYOUT', status: 'PENDING', attempt: 0 }],
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    const layout: PageLayoutResult = {
      ...version(RECOGNITION_V2_SCHEMA_IDS.pageLayoutResult),
      pageNo: 12,
      pageRoles: ['PROCEDURE_TITLE', 'PROCEDURE_LEG_TABLE'],
      regions: [{
        regionId: 'p12-r1',
        pageNo: 12,
        type: 'PROCEDURE_LEG_TABLE',
        bbox: [0.04, 0.12, 0.96, 0.48],
        rotationDeg: 0,
        readingOrder: 1,
        confidence: 0.96,
        reviewRequired: false,
      }],
      missingExpectedRoles: [],
      analysisMethod: 'RULES_ONLY',
      warnings: [],
    };
    const extraction = observedExtraction();
    const fusion: FusionStageResult = {
      ...version(RECOGNITION_V2_SCHEMA_IDS.fusionStageResult),
      entities: [{
        entityType: 'LEG',
        entityKey: 'PROC:LEG:10',
        fields: { courseDegMag: 145 },
        fieldEvidence: {
          courseDegMag: {
            selectedCandidateId: 'candidate-course-145',
            sourceEvidenceIds: ['evidence-course-145'],
            status: 'OBSERVED',
            confidence: 0.96,
          },
        },
      }],
      conflicts: [],
      unresolvedItems: [],
      selectedCandidateIds: ['candidate-course-145'],
      completedAt: '2026-07-16T00:00:03.000Z',
    };
    const validation: ValidationStageResult = {
      ...version(RECOGNITION_V2_SCHEMA_IDS.validationStageResult),
      issues: [],
      releaseDecision: 'READY',
      blockingIssueCount: 0,
      reviewIssueCount: 0,
      ruleVersions: { 'evidence-gate': '1.0.0' },
      completedAt: '2026-07-16T00:00:04.000Z',
    };

    assertValid(validators.manifest, manifest);
    assertValid(validators.layout, layout);
    assertValid(validators.extraction, extraction);
    assertValid(validators.fusion, fusion);
    assertValid(validators.validation, validation);
  });

  it('rejects an observed field candidate without source evidence', async () => {
    const { extraction } = await loadValidators();
    const result = observedExtraction();
    result.candidates[0].sourceEvidenceIds = [];
    assert.equal(extraction(result), false);
    assert.match(JSON.stringify(extraction.errors), /minItems/);
  });

  it('rejects a derived candidate without an auditable rule chain', async () => {
    const { extraction } = await loadValidators();
    const result = observedExtraction();
    result.candidates[0] = {
      ...result.candidates[0],
      status: 'DERIVED',
      sourceEvidenceIds: [],
    };
    assert.equal(extraction(result), false);
    assert.match(JSON.stringify(extraction.errors), /derivation/);
  });

  it('requires unresolved candidates to enter review', async () => {
    const { extraction } = await loadValidators();
    const result = observedExtraction();
    result.candidates[0] = {
      ...result.candidates[0],
      value: null,
      status: 'UNRESOLVED',
      sourceEvidenceIds: [],
      reviewRequired: false,
    };
    assert.equal(extraction(result), false);
    assert.match(JSON.stringify(extraction.errors), /reviewRequired/);
  });

  it('rejects evidence that contains neither raw text nor a visual observation', async () => {
    const { extraction } = await loadValidators();
    const result = observedExtraction();
    delete result.evidence[0].rawText;
    assert.equal(extraction(result), false);
    assert.match(JSON.stringify(extraction.errors), /anyOf/);
  });

  it('rejects incompatible contract versions and out-of-page bounding boxes', async () => {
    const { layout } = await loadValidators();
    const result = {
      ...version(RECOGNITION_V2_SCHEMA_IDS.pageLayoutResult),
      contractVersion: '1.0.0',
      pageNo: 1,
      pageRoles: ['PROCEDURE_DIAGRAM'],
      regions: [{
        regionId: 'p1-r1',
        pageNo: 1,
        type: 'PROCEDURE_DIAGRAM',
        bbox: [0, 0, 1.2, 1],
        rotationDeg: 0,
        readingOrder: 0,
        confidence: 1,
        reviewRequired: false,
      }],
      missingExpectedRoles: [],
      analysisMethod: 'RULES_ONLY',
      warnings: [],
    };
    assert.equal(layout(result), false);
    assert.match(JSON.stringify(layout.errors), /const|maximum/);
  });
});

function observedExtraction(): ExtractionStageResult {
  return {
    ...version(RECOGNITION_V2_SCHEMA_IDS.extractionStageResult),
    taskType: 'PROCEDURE_TABLE',
    pageNos: [12],
    regionIds: ['p12-r1'],
    evidence: [{
      evidenceId: 'evidence-course-145',
      fileName: 'AD2-STAR.pdf',
      pageNo: 12,
      regionId: 'p12-r1',
      bbox: [0.42, 0.31, 0.48, 0.34],
      sourceType: 'PROCEDURE_LEG_TABLE',
      rawText: '145°',
      extractionTask: 'PROCEDURE_TABLE',
      confidence: 0.98,
      status: 'OBSERVED',
    }],
    candidates: [{
      candidateId: 'candidate-course-145',
      entityType: 'LEG',
      entityKey: 'PROC:LEG:10',
      fieldName: 'courseDegMag',
      value: 145,
      normalizedValue: 145,
      unit: 'DEG_MAG',
      status: 'OBSERVED',
      sourceEvidenceIds: ['evidence-course-145'],
      confidence: 0.96,
      reviewRequired: false,
    }],
    warnings: [],
    completedAt: '2026-07-16T00:00:02.000Z',
  };
}

async function loadValidators() {
  const schemas = await Promise.all(schemaFiles.map(async (fileName) => ({
    fileName,
    schema: JSON.parse(await fs.readFile(path.join(schemaDir, fileName), 'utf8')),
  })));
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  for (const item of schemas) ajv.addSchema(item.schema);
  const validator = (schemaId: string) => {
    const found = ajv.getSchema(schemaId);
    assert.ok(found, `Schema ${schemaId} was not compiled`);
    return found;
  };
  return {
    manifest: validator('recognition-v2-run-manifest.schema.json'),
    layout: validator('recognition-v2-page-layout-result.schema.json'),
    extraction: validator('recognition-v2-extraction-stage-result.schema.json'),
    fusion: validator('recognition-v2-fusion-stage-result.schema.json'),
    validation: validator('recognition-v2-validation-stage-result.schema.json'),
  };
}

function assertValid(validate: ValidateFunction, value: unknown) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}
