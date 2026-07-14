import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractLikelyAipPageNo,
  normalizeChartNo,
  normalizeJapaneseChartNo,
  normalizeKoreanChartNo,
  parseApproachProcedureName,
} from '../chartIndexParser';

describe('Korean chart number dialect (RKSI)', () => {
  it('normalizes chart page footers', () => {
    assert.equal(normalizeKoreanChartNo('RKSI AD CHART 2 - 28'), 'AD 2-RKSI-28');
    assert.equal(normalizeKoreanChartNo('RKSI AD CHART 2-51'), 'AD 2-RKSI-51');
  });

  it('normalizes coding table sub-page footers', () => {
    assert.equal(normalizeKoreanChartNo('RKSI AD CHART 2 - 28 - 1'), 'AD 2-RKSI-28-1');
    assert.equal(normalizeKoreanChartNo('RKSI AD CHART 2 - 51 -1'), 'AD 2-RKSI-51-1');
  });

  it('tolerates trailing date fragments after the footer', () => {
    assert.equal(normalizeKoreanChartNo('RKSI AD CHART 2 - 28 30 APR 2026'), 'AD 2-RKSI-28');
  });

  it('ignores lowercase body references like "See AD chart 2-74"', () => {
    assert.equal(normalizeKoreanChartNo('See AD chart 2-74 Arrival period'), undefined);
  });

  it('is idempotent under normalizeChartNo for both forms', () => {
    assert.equal(normalizeChartNo('AD 2-RKSI-28'), 'AD 2-RKSI-28');
    assert.equal(normalizeChartNo('AD 2-RKSI-28-1'), 'AD 2-RKSI-28-1');
  });

  it('extracts the footer from full-page text', () => {
    const pageText = [
      'GENERAL INFORMATION',
      'RWY 15L/R RNAV BINIL 3C, RNAV BOPTA 3C',
      'STANDARD DEPARTURE CHART INSTRUMENT (SID) - ICAO',
      'OFFICE OF CIVIL AVIATION',
      'A I P Republic of Korea',
      'RKSI AD CHART 2 - 28',
      '16 OCT 2025 AIP AMDT 11/25',
    ].join('\n');
    assert.equal(extractLikelyAipPageNo(pageText), 'AD 2-RKSI-28');
  });
});

describe('Japanese chart number dialect (RJTT)', () => {
  it('normalizes AD 2.24 section footers into lettered form', () => {
    assert.equal(normalizeJapaneseChartNo('RJTT AD2.24-SID-27'), 'AD 2-RJTT-SID-27');
    assert.equal(normalizeJapaneseChartNo('RJTT AD2.24-STAR-56'), 'AD 2-RJTT-STAR-56');
    assert.equal(normalizeJapaneseChartNo('RJTT AD2.24-IAC-19'), 'AD 2-RJTT-IAC-19');
    assert.equal(normalizeJapaneseChartNo('RJTT AD2.24-OTHER-9'), 'AD 2-RJTT-OTHER-9');
  });

  it('is idempotent under normalizeChartNo (lettered canonical form)', () => {
    assert.equal(normalizeChartNo('AD 2-RJTT-SID-27'), 'AD 2-RJTT-SID-27');
  });

  it('extracts the footer from full-page text', () => {
    const pageText = [
      'Civil Aviation Bureau,Japan',
      'AIP Japan',
      'STANDARD DEPARTURE CHART-INSTRUMENT',
      'RNAV SID',
      'RJTT/TOKYO INTL',
      'RJTT AD2.24-SID-28',
    ].join('\n');
    assert.equal(extractLikelyAipPageNo(pageText), 'AD 2-RJTT-SID-28');
  });
});

describe('Korean approach chart title order', () => {
  it('parses procedure name that appears before the chart phrase', () => {
    const title = 'SEOUL/Incheon Intl(RKSI) ILS Z or LOC Z RWY 15L CAT II & III INSTRUMENT APPROACH CHART - ICAO';
    assert.equal(parseApproachProcedureName(title), 'ILS Z or LOC Z CAT II & III RWY15L');
  });

  it('parses single-nav Korean titles', () => {
    assert.equal(
      parseApproachProcedureName('SEOUL/Incheon Intl(RKSI) RNP RWY 15L INSTRUMENT APPROACH CHART - ICAO'),
      'RNP RWY15L',
    );
    assert.equal(
      parseApproachProcedureName('SEOUL/Incheon Intl(RKSI) VOR RWY 15L INSTRUMENT APPROACH CHART - ICAO'),
      'VOR RWY15L',
    );
  });

  it('keeps Hong Kong style titles working (name after chart phrase)', () => {
    assert.equal(
      parseApproachProcedureName('Instrument Approach Chart - ICAO - ILS - RWY 07R'),
      'ILS RWY07R',
    );
  });
});
