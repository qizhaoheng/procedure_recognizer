import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProcedureGroup, ProcedureUnderstandingResult } from '../../types/procedure';
import type { SimpleProcedureLeg } from '../jeppesen424/types';
import { buildProcedureRenderPlan } from '../rendering/procedureRenderPlan';

const group = {
  groupId: 'render-plan',
  groupName: 'RWY16 RNAV SID AROSO 1J ADLOV 1J',
  packageName: 'RWY16 RNAV SID AROSO 1J ADLOV 1J',
  packageType: 'SID',
  procedureCategory: 'DEPARTURE',
  navigationType: 'RNAV',
  runway: 'RWY16',
  procedureNames: ['AROSO 1J', 'ADLOV 1J'],
  chartPages: [1],
  tabularPages: [],
  coordinatePages: [],
  minimaPages: [],
  otherPages: [],
  status: 'AI_COMPLETED',
} as unknown as ProcedureGroup;

const understanding: ProcedureUnderstandingResult = {
  airportIcao: 'WMKJ',
  packageType: 'SID',
  procedureCategory: 'DEPARTURE',
  navigationType: 'RNAV',
  runway: 'RWY16',
  procedures: [
    { procedureName: 'AROSO 1J', runway: 'RWY16', legs: [{ sequence: 10, pathTerminator: 'CA', distanceNm: 0 }] },
    { procedureName: 'ADLOV 1J', runway: 'RWY16', legs: [{ sequence: 10, pathTerminator: 'CA', distanceNm: 0 }] },
  ],
};

describe('procedure render plan', () => {
  it('uses matching 424 legs without mutating the AI recognition result', () => {
    const canonical = [
      leg('AROSO 1J', '010', '', 'CA', { courseDegMag: 160, distanceNm: 2, altitudeRaw: '+01000', altitudeValue: 1000, altitudeSign: '+', altitudeUpperFt: 11000 }),
      leg('AROSO 1J', '020', 'AROSO', 'CF', { courseDegMag: 332, thetaDegMag: 332, rhoNm: 32.6, distanceNm: 22, recommendedNavaid: 'VJB' }),
      leg('ADLOV 1J', '010', '', 'CA', { courseDegMag: 160, distanceNm: 2 }),
      leg('ADLOV 1J', '020', 'ADLOV', 'TF', { distanceNm: 23.8 }),
    ];

    const plan = buildProcedureRenderPlan(understanding, group, canonical, 'AUTO');
    assert.equal(plan.source, 'JEPPESEN_424');
    assert.equal(plan.canonicalProcedureCount, 2);
    assert.equal(plan.canonicalLegCount, 4);
    assert.deepEqual(plan.procedures.map((procedure) => procedure.legs?.length), [2, 2]);
    const arossoFinal = plan.procedures[0].legs?.[1] as Record<string, unknown>;
    assert.equal(arossoFinal.renderSource, 'JEPPESEN_424');
    assert.equal(arossoFinal.thetaDegMag, 332);
    assert.equal(arossoFinal.rhoNm, 32.6);
    assert.equal((understanding.procedures?.[0].legs?.[0] as Record<string, unknown>).distanceNm, 0);
  });

  it('supports abbreviated 424 procedure identities and hybrid fallback', () => {
    const canonical = [leg('AROS 1J', '010', '', 'CA', { courseDegMag: 160, distanceNm: 2 })];
    const plan = buildProcedureRenderPlan(understanding, group, canonical, 'AUTO');
    assert.equal(plan.source, 'HYBRID');
    assert.equal(plan.canonicalProcedureCount, 1);
    assert.equal(plan.procedures[0].procedureName, 'AROSO 1J');
    assert.equal((plan.procedures[0].legs?.[0] as Record<string, unknown>).renderSource, 'JEPPESEN_424');
    assert.equal((plan.procedures[1].legs?.[0] as Record<string, unknown>).renderSource, undefined);
  });

  it('keeps an explicit AI render mode independent from stored 424 data', () => {
    const plan = buildProcedureRenderPlan(
      understanding,
      group,
      [leg('AROSO 1J', '010', '', 'CA', { distanceNm: 2 })],
      'AI',
    );
    assert.equal(plan.source, 'AI');
    assert.equal(plan.canonicalLegCount, 0);
    assert.equal((plan.procedures[0].legs?.[0] as Record<string, unknown>).distanceNm, 0);
  });

  it('applies the same identity and leg conversion to STAR packages', () => {
    const starGroup = {
      ...group,
      groupName: 'RWY16 RNAV STAR EMTUV 1E',
      packageName: 'RWY16 RNAV STAR EMTUV 1E',
      packageType: 'STAR',
      procedureCategory: 'ARRIVAL',
      procedureNames: ['EMTUV 1E'],
    } as unknown as ProcedureGroup;
    const starUnderstanding: ProcedureUnderstandingResult = {
      ...understanding,
      packageType: 'STAR',
      procedureCategory: 'ARRIVAL',
      procedures: [{ procedureName: 'EMTUV 1E', runway: 'RWY16', legs: [{ sequence: 10, pathTerminator: 'IF' }] }],
    };
    const plan = buildProcedureRenderPlan(starUnderstanding, starGroup, [
      leg('EMTUV 1E', '010', 'EMTUV', 'IF', { altitudeRaw: '-06000', altitudeValue: 6000, altitudeSign: '-', altitudeUpperFt: 13000, recommendedNavaid: 'VJB' }),
      leg('EMTUV 1E', '020', 'UDOSU', 'TF', { distanceNm: 13.4, altitudeRaw: '+03500', altitudeValue: 3500, altitudeSign: '+' }),
    ], 'AUTO');
    assert.equal(plan.source, 'JEPPESEN_424');
    assert.deepEqual(plan.procedures[0].legs?.map((item) => [item.sequence, item.pathTerminator, item.fixIdentifier]), [
      [10, 'IF', 'EMTUV'],
      [20, 'TF', 'UDOSU'],
    ]);
  });
});

function leg(
  procedureName: string,
  sequence: string,
  fix: string,
  pathTerminator: string,
  fields: Partial<SimpleProcedureLeg>,
): SimpleProcedureLeg {
  return {
    procedureName,
    runway: 'RW16',
    routeKey: procedureName.replace(/\s+/g, ''),
    sequence,
    fix,
    pathTerminator,
    source: 'JEPPESEN_424',
    ...fields,
  };
}
