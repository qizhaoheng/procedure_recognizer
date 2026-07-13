import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPage } from '../pageClassifier';
import { buildGroupingDebug, groupProcedurePackages } from '../procedurePackageGrouper';

// 新加坡式 AIP 版式（WSSS）：
// - 图号写作 AD-2-WSSS-SID-1（AD 与 2 之间连字符），印在图页页脚（文本层中独立成行）
// - 每张图带小数子页号的翻页描述表（AD-2-WSSS-SID-1.1）
// - AD 2.24 目录为“图名一行、图号一行”交替，图名以程序号收尾（可短于 5 字母，如 VMR 6A）
// - 图面上印有 REFER TO BACK PAGE FOR FORMAL AND TABULAR DESCRIPTIONS 字样，不能据此误判为表格页

const indexHeadText = [
  'AIP Singapore',
  '© 2026 Civil Aviation Authority Singapore',
  'AIP AMDT 03/2026',
  'WSSS AD 2.24 CHARTS RELATED TO AN AERODROME',
  'AERODROME CHART',
  'AD-2-WSSS-ADC-1',
  'AERODROME OBSTACLE CHART - ICAO TYPE A RWY 02L/20R',
  'AD-2-WSSS-AOC-1',
].join('\n');

const indexContinuationText = [
  'AIP Singapore',
  '© 2026 Civil Aviation Authority Singapore',
  'AIP AMDT 03/2026',
  'RNAV (GNSS) SID - RWY 02C - ANITO 7A',
  'AD-2-WSSS-SID-1',
  'RNAV (GNSS) SID - RWY 02C - VMR 6A',
  'AD-2-WSSS-SID-2',
  'RNAV (GNSS) STAR - RWY 02L/02C/02R - ARAMA 1A',
  'AD-2-WSSS-STAR-1',
  'INSTRUMENT APPROACH CHART - ICAO - ICW ILS/DME - RWY 02L',
  'AD-2-WSSS-IAC-1',
  'PRECISION APPROACH TERRAIN CHART RWY 02L',
  'AD-2-WSSS-PATC-1',
  'PRECISION APPROACH TERRAIN CHART RWY 02C',
  'AD-2-WSSS-PATC-2',
  'PRECISION APPROACH TERRAIN CHART RWY 20R',
  'AD-2-WSSS-PATC-3',
  'PRECISION APPROACH TERRAIN CHART RWY 20C',
  'AD-2-WSSS-PATC-4',
].join('\n');

function sidChartText(designator: string, chartNo: string) {
  return [
    'TEKONG',
    'DVOR/DME 116.5',
    'STANDARD DEPARTURE CHART',
    'RNAV (GNSS) -',
    'INSTRUMENT (SID)',
    'SINGAPORE/Singapore Changi',
    'RWY 02C',
    `${designator.split(/\s/)[0]} DEPARTURES`,
    designator,
    'NOT TO SCALE',
    'NOTE:',
    'REFER TO BACK PAGE FOR',
    '- FORMAL AND TABULAR DESCRIPTIONS',
    '- RADIO COM FAILURE PROCEDURES',
    'AIP Singapore',
    '© 2024 Civil Aviation Authority Singapore',
    chartNo,
    '26 DEC 2024',
    'AIP AMDT 07/2024',
  ].join('\n');
}

function sidFlipText(designator: string, chartNo: string) {
  return [
    `${chartNo}.1`,
    '26 DEC 2024',
    'AIP Singapore',
    `${designator} (SID) RNAV GNSS RWY 02C - DESCRIPTIONS`,
    'Formal & Abbreviated Descriptions',
    'Tabular Descriptions',
    'Radio Communications Failure Procedure',
    'AIP AMDT 07/2024',
  ].join('\n');
}

const starChartText = [
  'STANDARD ARRIVAL CHART',
  'RNAV (GNSS) -',
  'INSTRUMENT (STAR)',
  'SINGAPORE/Singapore Changi',
  'RWY 02L/02C/02R',
  'ARAMA ARRIVALS',
  'ARAMA 1A',
  'NOTE:',
  'REFER TO BACK PAGE FOR',
  '- FORMAL AND TABULAR DESCRIPTIONS',
  'AIP Singapore',
  '© 2024 Civil Aviation Authority Singapore',
  'AD-2-WSSS-STAR-1',
  '31 OCT 2024',
].join('\n');

const starFlipText = [
  'AD-2-WSSS-STAR-1.1',
  '31 OCT 2024',
  'AIP Singapore',
  'ARAMA 1A (STAR) RNAV GNSS RWY 02L/02C/02R - DESCRIPTIONS',
  'Formal & Abbreviated Descriptions',
  'Tabular Descriptions',
].join('\n');

const iacChartText = [
  'INSTRUMENT',
  'APPROACH',
  'CHART - ICAO',
  'ICW ILS/DME',
  'RWY 02L',
  'SINGAPORE/',
  'SINGAPORE CHANGI',
  'MISSED APPROACH',
  'OCA (OCH)',
  'Category of Aircraft',
  'AIP Singapore',
  '© 2024 Civil Aviation Authority Singapore',
  'AD-2-WSSS-IAC-1',
  '26 DEC 2024',
].join('\n');

function buildPages() {
  return [
    classifyPage(1, indexHeadText),
    classifyPage(2, indexContinuationText),
    classifyPage(3, sidChartText('ANITO 7A', 'AD-2-WSSS-SID-1')),
    classifyPage(4, sidFlipText('ANITO 7A', 'AD-2-WSSS-SID-1')),
    classifyPage(5, sidChartText('VMR 6A', 'AD-2-WSSS-SID-2')),
    classifyPage(6, sidFlipText('VMR 6A', 'AD-2-WSSS-SID-2')),
    classifyPage(7, starChartText),
    classifyPage(8, starFlipText),
    classifyPage(9, iacChartText),
  ];
}

describe('WSSS (Singapore) procedure package grouping', () => {
  const packages = groupProcedurePackages(buildPages());

  it('builds one package per lettered chart number', () => {
    assert.equal(packages.length, 4);
    assert.equal(packages.filter((item) => item.packageType === 'SID').length, 2);
    assert.equal(packages.filter((item) => item.packageType === 'STAR').length, 1);
    assert.equal(packages.filter((item) => item.packageType === 'APPROACH').length, 1);
  });

  it('parses hyphenated footer chart numbers and attaches decimal flip pages as tabular', () => {
    const sid1 = getPackage('AD 2-WSSS-SID-1');
    assert.deepEqual(sid1.chartPages, [3]);
    assert.ok(sid1.tabularPages.includes(4), 'flip page should be tabular');
    assert.equal(sid1.runway, 'RWY02C');
    assert.equal(sid1.navigationType, 'RNAV');
    assert.ok(sid1.procedureNames.includes('ANITO 7A'));
    assert.equal(sid1.reviewRequired, false);

    const allChartPages = packages.flatMap((item) => item.chartPages);
    for (const flipPageNo of [4, 6, 8]) {
      assert.ok(!allChartPages.includes(flipPageNo), `flip page ${flipPageNo} must not be a chart page`);
    }
  });

  it('detects short VOR-named designators from index chart names', () => {
    const sid2 = getPackage('AD 2-WSSS-SID-2');
    assert.ok(sid2.procedureNames.includes('VMR 6A'));
  });

  it('groups STAR and approach charts with correct metadata', () => {
    const star = getPackage('AD 2-WSSS-STAR-1');
    assert.deepEqual(star.chartPages, [7]);
    assert.ok(star.tabularPages.includes(8));
    assert.equal(star.runway, 'RWY02L/02C/02R');

    const approach = getPackage('AD 2-WSSS-IAC-1');
    assert.deepEqual(approach.chartPages, [9]);
    assert.equal(approach.navigationType, 'ILS');
  });

  it('does not flag decimal sub-pages as duplicate chart numbers', () => {
    const debug = buildGroupingDebug(buildPages());
    assert.equal(debug.unmatchedChartIndexItems.length, 0);
    assert.equal(debug.duplicateChartNoPages.length, 0);
    assert.deepEqual(debug.chartNoPageMap.find((item) => item.chartNo === 'AD 2-WSSS-SID-1')?.pageNos, [3]);
    assert.deepEqual(debug.chartNoPageMap.find((item) => item.chartNo === 'AD 2-WSSS-SID-1.1')?.pageNos, [4]);
  });

  function getPackage(chartNo: string) {
    const found = packages.find((item) => item.chartNo === chartNo);
    assert.ok(found, `missing package ${chartNo}`);
    return found;
  }
});
