import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPage } from '../pageClassifier';
import { buildGroupingDebug, groupProcedurePackages } from '../procedurePackageGrouper';

// 韩国式 AIP 版式（RKSI）：
// - 图号写作 RKSI AD CHART 2 - 28（图面页）/ RKSI AD CHART 2 - 28 - 1（官方编码表页），成对出现
// - AD 2.24 目录在正文分册里，标题为 CHARTS RELATED TO THE AERODROME，图名带点线引导符，
//   图名与图号在文本层里分成两块，无法可靠配对——分组依赖图页页头标题兜底
// - 进近图名语序：程序名在 INSTRUMENT APPROACH CHART 之前（ILS Z or LOC Z RWY 15L CAT II & III）
// - 编码表页印有 AERONAUTICAL DATA TABULATION 与 424 式 Path/Terminator 表

const indexPageText = [
  'A I P Republic of Korea',
  'RKSI AD 2 - 45',
  '21 AUG 2025',
  'RKSI AD 2.24 CHARTS RELATED TO THE AERODROME',
  'Aerodrome Chart - ICAO ······································',
  'Aircraft Parking/Docking Chart - ICAO ······················',
  'Standard Departure Chart Instrument(SID) - ICAO ············',
  'Standard Departure Chart Instrument(SID) - ICAO ············',
  'Standard Arrival Chart Instrument(STAR) - ICAO ·············',
  'RKSI AD CHART 2-1 RKSI AD CHART 2-3 RKSI AD CHART 2-28 RKSI AD CHART 2-29 RKSI AD CHART 2-42',
  'OFFICE OF CIVIL AVIATION',
].join('\n');

const indexContinuationText = [
  'A I P Republic of Korea',
  'RKSI AD 2 - 46',
  '14 NOV 2024',
  'ATC Surveillance Minimum Altitude Chart - ICAO ··············',
  'Instrument Approach Chart - ICAO - RWY 15L - ILS Z or LOC Z ····',
  'Instrument Approach Chart - ICAO - RWY 15L - ILS Y or LOC Y ····',
  'Instrument Approach Chart - ICAO - RWY 15L - RNP ··············',
  'Instrument Approach Chart - ICAO - RWY 15L - VOR ··············',
  'RKSI AD CHART 2-50 RKSI AD CHART 2-51 RKSI AD CHART 2-53 RKSI AD CHART 2-55 RKSI AD CHART 2-57',
  'OFFICE OF CIVIL AVIATION',
].join('\n');

function sidChartText(chartNo: string, runway: string, designators: string[]) {
  return [
    'NM 0 5 10',
    'GENERAL INFORMATION',
    '1. RNAV 1 operation.',
    '2. GNSS or DME/DME/IRU required.',
    ...designators.map((designator) => `RNAV ${designator}`),
    `${runway} ${designators.map((designator) => `RNAV ${designator}`).join(', ')}`,
    'TRANSITION ALT 14 000 TRANSITION LVL FL 140',
    'STANDARD DEPARTURE CHART INSTRUMENT (SID) - ICAO',
    'Note : Departure under ICAO Flight Procedures.',
    'SEOUL/Incheon Intl(RKSI)',
    'OFFICE OF CIVIL AVIATION',
    'A I P Republic of Korea',
    chartNo,
    '16 OCT 2025 AIP AMDT 11/25',
  ].join('\n');
}

function sidCodingTableText(chartNo: string, runway: string, designators: string[]) {
  return [
    'Standard Instrument Departure Procedure Coding Tables',
    `SEOUL/Incheon Intl(RKSI) ${runway} ${designators.map((designator) => `RNAV ${designator}`).join(', ')}`,
    'OFFICE OF CIVIL AVIATION',
    'A I P Republic of Korea',
    chartNo,
    '16 OCT 2025 AIP AMDT 11/25',
    'AERONAUTICAL DATA TABULATION',
    'Course/Track °M(°T) Path Waypoint Fly-over Distance (NM) Altitude Speed Coordinates',
    '001 CF 002 TF - 004 005 TF',
    'Navigation specification RNAV 1',
  ].join('\n');
}

const starChartText = [
  'GUKDO 1A KARBU 1A',
  'MNM ALT FL 160 MAX SPD 230 kt IAS',
  'RWY 15L GUKDO 1A, KARBU 1A',
  'STANDARD ARRIVAL CHART INSTRUMENT (STAR) - ICAO',
  'TRANSITION ALT 14 000 TRANSITION LVL FL 140',
  'SEOUL/Incheon Intl(RKSI)',
  'A I P Republic of Korea',
  'RKSI AD CHART 2 - 42',
  '21 AUG 2025 AIP AMDT 9/25',
].join('\n');

const starCodingTableText = [
  'OFFICE OF CIVIL AVIATION',
  'A I P Republic of Korea',
  'RKSI AD CHART 2 - 42 -1',
  '21 AUG 2025 AIP AMDT 9/25',
  'SEOUL/Incheon Intl(RKSI) RWY 15L GUKDO 1A, KARBU 1A',
  'AERONAUTICAL DATA TABULATION',
  'GUKDO GUKDO 1A Coordinates 37°01\'10.9"N 127°38\'22.9"E',
  'Fix / Point KAKSO KALMA SEL GC034 POSEP',
].join('\n');

const iacChartText = [
  'RK P518 UNL GND',
  'VOR/DME 113.8 NCN INCHEON',
  'NCN LOC 111.9 ISLL',
  '(MAPt) LOC ONLY ISLL D1.0',
  'A I P Republic of Korea',
  'SEOUL/Incheon Intl(RKSI)',
  'ILS Z or LOC Z RWY 15L CAT II & III',
  'INSTRUMENT APPROACH CHART - ICAO',
  'OFFICE OF CIVIL AVIATION',
  'TRANSITION ALT 14 000 TRANSITION LVL FL 140',
  'RKSI AD CHART 2 - 51',
  '21 AUG 2025',
].join('\n');

const iacCodingTableText = [
  'ILS Z or LOC Z RWY 15L CAT II & III',
  'AERONAUTICAL DATA TABULATION',
  'OFFICE OF CIVIL AVIATION',
  'A I P Republic of Korea',
  'RKSI AD CHART 2 - 51 - 1',
  '21 AUG 2025',
  'SEOUL/Incheon Intl(RKSI)',
  'PUDIM(IF) 37°37\'54.2"N 126°18\'30.0"E',
  'ILS Z/LOC Z Approach to RWY 15L from MUNAN to PUDIM(IF)',
].join('\n');

function buildPages() {
  return [
    classifyPage(1, indexPageText),
    classifyPage(2, indexContinuationText),
    classifyPage(3, sidChartText('RKSI AD CHART 2 - 28', 'RWY 15L/R', ['BINIL 3C', 'BOPTA 3C'])),
    classifyPage(4, sidCodingTableText('RKSI AD CHART 2 - 28 - 1', 'RWY 15L/R', ['BINIL 3C', 'BOPTA 3C'])),
    classifyPage(5, sidChartText('RKSI AD CHART 2 - 29', 'RWY 15L/R', ['OSPOT 2C', 'EGOBA 2C'])),
    classifyPage(6, sidCodingTableText('RKSI AD CHART 2 - 29 - 1', 'RWY 15L/R', ['OSPOT 2C', 'EGOBA 2C'])),
    classifyPage(7, starChartText),
    classifyPage(8, starCodingTableText),
    classifyPage(9, iacChartText),
    classifyPage(10, iacCodingTableText),
  ];
}

describe('RKSI (Korea) procedure package grouping', () => {
  const packages = groupProcedurePackages(buildPages());

  it('classifies Korean chart index pages and never builds packages from them', () => {
    const debug = buildGroupingDebug(buildPages());
    for (const pageNo of [1, 2]) {
      const page = debug.pages.find((item) => item.pageNo === pageNo);
      assert.equal(page?.chartRole, 'CHART_INDEX', `page ${pageNo} should be CHART_INDEX`);
      assert.equal(page?.matchedPackageId, undefined);
    }
  });

  it('builds one package per Korean chart page via header fallback', () => {
    assert.equal(packages.length, 4);
    assert.equal(packages.filter((item) => item.packageType === 'SID').length, 2);
    assert.equal(packages.filter((item) => item.packageType === 'STAR').length, 1);
    assert.equal(packages.filter((item) => item.packageType === 'APPROACH').length, 1);
  });

  it('pairs official coding table sub-pages with their chart pages', () => {
    const sid = getPackageByChartNo('AD 2-RKSI-28');
    assert.deepEqual(sid.chartPages, [3]);
    assert.ok(sid.coordinatePages.includes(4), 'coding table should be attached as coordinates page');
    assert.ok(sid.procedureNames.includes('BINIL 3C'));
    assert.ok(sid.procedureNames.includes('BOPTA 3C'));
    assert.equal(sid.navigationType, 'RNAV');

    const sid2 = getPackageByChartNo('AD 2-RKSI-29');
    assert.deepEqual(sid2.chartPages, [5]);
    assert.ok(sid2.coordinatePages.includes(6));

    const star = getPackageByChartNo('AD 2-RKSI-42');
    assert.deepEqual(star.chartPages, [7]);
    assert.ok(star.coordinatePages.includes(8));
    assert.ok(star.procedureNames.includes('GUKDO 1A'));

    const approach = getPackageByChartNo('AD 2-RKSI-51');
    assert.deepEqual(approach.chartPages, [9]);
    assert.ok(approach.coordinatePages.includes(10));
    assert.equal(approach.navigationType, 'ILS_LOC');
  });

  it('parses Korean approach titles into procedure names', () => {
    const approach = getPackageByChartNo('AD 2-RKSI-51');
    assert.ok(
      approach.procedureNames.some((name) => name.includes('ILS Z or LOC Z')),
      `approach names should carry ILS Z or LOC Z, got ${JSON.stringify(approach.procedureNames)}`,
    );
  });

  it('never mixes coding table pages into chart pages', () => {
    const allChartPages = packages.flatMap((item) => item.chartPages);
    for (const codingPageNo of [4, 6, 8, 10]) {
      assert.ok(!allChartPages.includes(codingPageNo), `coding page ${codingPageNo} must not be a chart page`);
    }
  });

  function getPackageByChartNo(chartNo: string) {
    const found = packages.find((item) => item.chartNo === chartNo);
    assert.ok(found, `missing package ${chartNo}; got ${JSON.stringify(packages.map((item) => item.chartNo))}`);
    return found;
  }
});
