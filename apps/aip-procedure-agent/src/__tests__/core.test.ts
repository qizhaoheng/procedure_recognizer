import assert from 'node:assert/strict';
import test from 'node:test';
import { dmsToDecimal, geodesicForward, geodesicInverse, parseCoordinate } from '../coordinate';
import { arc, compile424Candidate, compileGeoJson, validatePir } from '../compiler';
import type { ProcedurePIR } from '../domain';

test('parses compact AIP coordinates', () => { const value = parseCoordinate('N012030.00 E1034500.00'); assert.ok(Math.abs(value.latitude! - 1.3416667) < 1e-5); assert.equal(value.longitude, 103.75); });
test('converts DMS and validates components', () => { assert.equal(dmsToDecimal(1, 30, 0, 'S'), -1.5); assert.throws(() => dmsToDecimal(1, 60, 0)); });
test('geodesic forward and inverse round trip', () => { const end = geodesicForward([103.8, 1.3], 90, 10); const inv = geodesicInverse([103.8, 1.3], end); assert.ok(Math.abs(inv.distanceNm - 10) < 0.01); assert.ok(Math.abs(inv.initialBearing - 90) < 0.1); });
test('RF arc includes endpoints and samples', () => { const points = arc([103.8, 1.3], [103.8, 1.4], [103.9, 1.3], 'R'); assert.ok(points.length >= 8); assert.ok(geodesicInverse(points[0], [103.8, 1.4]).distanceNm < 0.01); });
test('validates PIR, compiles GeoJSON, and emits incomplete 424 safely', () => { const pir = samplePir(); const validations = validatePir(pir); assert.equal(validations.length, 0); const geo = compileGeoJson(pir) as any; assert.equal(geo.type, 'FeatureCollection'); assert.ok(geo.features.some((f: any) => f.properties.featureType === 'LEG')); const candidate = compile424Candidate(pir); assert.ok(['424_CANDIDATE','424_INCOMPLETE'].includes(candidate.status)); });

test('normalizes AIP RWY runway designators for 424 output', () => {
  const pir = samplePir();
  pir.procedure.name = 'AKSEL 2B ARRIVAL';
  pir.procedure.runways = ['RWY22'];
  pir.routes[0].runway = 'RWY22';
  const candidate = compile424Candidate(pir);
  assert.equal(candidate.status, '424_CANDIDATE', JSON.stringify(candidate));
  assert.match(candidate.text, /RW22/);
});

test('compiles a combined RNAV procedure name with the route-specific designator', () => {
  const pir = samplePir();
  pir.airport.icao = 'RKSI';
  pir.procedure.name = 'RNAV BINIL 3C, RNAV BOPTA 3C';
  pir.procedure.identifier = pir.procedure.name;
  pir.procedure.runways = ['15L', '15R'];
  pir.routes[0].identifier = 'RNAV BINIL 3C RWY 15L/R';
  pir.routes[0].runway = '15L';
  const candidate = compile424Candidate(pir);
  assert.equal(candidate.status, '424_CANDIDATE', JSON.stringify(candidate));
  assert.match(candidate.text, /BINI3C/);
});

test('matches a spelled-out combined title to a numeric route designator', () => {
  const pir = samplePir();
  pir.airport.icao = 'RKSI';
  pir.procedure.name = 'RNAV EGOBA TWO CHARLIE DEPARTURE, RNAV OSPOT TWO CHARLIE DEPARTURE';
  pir.procedure.identifier = pir.procedure.name;
  pir.procedure.runways = ['15L'];
  pir.routes[0].identifier = 'RNAV OSPOT 2C';
  pir.routes[0].runway = '15L';
  const candidate = compile424Candidate(pir);
  assert.equal(candidate.status, '424_CANDIDATE', JSON.stringify(candidate));
  assert.match(candidate.text, /OSPO2C/);
});

function samplePir(): ProcedurePIR { return { schemaVersion: '1.0.0', airport: { icao: 'WSSS', name: 'Singapore' }, procedure: { category: 'SID', identifier: 'TEST1A', name: 'TEST ONE ALPHA DEPARTURE', runways: ['02L'], navigationSpecification: 'RNAV 1' }, routes: [{ routeId: 'r1', routeType: 'RUNWAY_TRANSITION', identifier: 'RW02L', runway: '02L', legIds: ['l1'], sequence: 1 }], fixes: [{ fixId: 'a', identifier: 'AAAAA', type: 'WAYPOINT', latitude: 1.3, longitude: 103.8, coordinateSourceType: 'EXPLICIT_TABLE', evidence: ['e1'], confidence: .99, status: 'CONFIRMED', allowFor424: true }, { fixId: 'b', identifier: 'BBBBB', type: 'WAYPOINT', latitude: 1.4, longitude: 103.9, coordinateSourceType: 'EXPLICIT_TABLE', evidence: ['e2'], confidence: .99, status: 'CONFIRMED', allowFor424: true }], legs: [{ legId: 'l1', sequence: 10, routeId: 'r1', pathTerminator: 'TF', fromFixId: 'a', toFixId: 'b', course: 45, courseReference: 'MAGNETIC', distanceNm: 8, openEnded: false, evidence: ['e3'], confidence: .95, fieldStatus: { pathTerminator: 'CONFIRMED' }, warnings: [] }], notes: [], sourceEvidence: [], conflicts: [], validation: { results: [] }, quality: { confidence: .95, reviewRequired: false, unresolvedFields: [] } }; }
