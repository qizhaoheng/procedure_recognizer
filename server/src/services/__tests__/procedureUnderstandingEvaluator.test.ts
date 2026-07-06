import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcedureUnderstandingResult } from '../../types/procedure';
import { evaluateProcedureUnderstanding } from '../evaluation/procedureUnderstandingEvaluator';

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe('procedure understanding evaluator', () => {
  it('scores the WMKJ RWY16 RNAV STAR golden case at 100% for a matching result', async () => {
    const golden = JSON.parse(await fs.readFile(path.resolve(testDir, '..', 'evaluation', 'golden-cases', 'wmkj-rwy16-rnav-star.expected.json'), 'utf-8'));
    const actual: ProcedureUnderstandingResult = {
      airportIcao: 'WMKJ',
      packageType: 'STAR',
      procedureCategory: 'ARRIVAL',
      navigationType: 'RNAV',
      runway: '16',
      procedures: golden.procedures.map((procedure: any) => ({
        procedureName: procedure.procedureName,
        navigationSpec: 'RNAV1',
        sourceEvidenceIds: [`${procedure.procedureName}-title`],
        confidence: 1,
        reviewRequired: false,
        legs: procedure.legs.map((leg: any) => ({
          ...leg,
          sourceEvidenceIds: [`${procedure.procedureName}-${leg.sequence}`],
          confidence: 1,
          reviewRequired: false,
        })),
      })),
      fixes: golden.waypoints.map((identifier: string) => ({
        identifier,
        sourceEvidenceIds: [`fix-${identifier}`],
        confidence: 1,
        reviewRequired: false,
      })),
      navaids: [],
      runways: [],
      communications: [],
      holdings: [],
      msa: [],
      sourceEvidence: golden.procedures.flatMap((procedure: any) => procedure.legs.map((leg: any) => ({
        id: `${procedure.procedureName}-${leg.sequence}`,
        pageNo: 52,
        evidenceType: 'tabular',
        fieldName: 'leg',
        rawText: 'mock',
        confidence: 1,
      }))),
      warnings: [],
      confidence: 1,
      reviewRequired: false,
    };

    const result = evaluateProcedureUnderstanding(actual, golden);
    assert.equal(result.totalScore, 1);
    assert.equal(result.errors.length, 0);
  });
});
