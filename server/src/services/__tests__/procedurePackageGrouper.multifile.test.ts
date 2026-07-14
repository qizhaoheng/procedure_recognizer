import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPage } from '../pageClassifier';
import { groupProcedurePackages } from '../procedurePackageGrouper';

function sourcePage(pageNo: number, sourceFileName: string, text: string) {
  return { ...classifyPage(pageNo, text), sourceFileName };
}

describe('split AD 2.24 source document grouping', () => {
  const firstSource = 'File_AD-2.24.12-ABCD-en.pdf';
  const secondSource = 'File_AD-2.24.13-ABCD-en.pdf';
  const pages = [
    sourcePage(1, firstSource, [
      'ABCD AD2.24-SID-11',
      'STANDARD DEPARTURE CHART-INSTRUMENT',
      'RNAV SID ABCD/EXAMPLE INTL',
      'VAMOS FOUR DEPARTURE RWY16R/16L',
    ].join('\n')),
    sourcePage(2, firstSource, [
      'ABCD AD2.24-SID-12',
      'STANDARD DEPARTURE CHART-INSTRUMENT',
      'VAMOS FOUR DEPARTURE',
      'RWY16R: Climb on HDG 158 at or above 500FT, direct to T6R11.',
    ].join('\n')),
    sourcePage(3, firstSource, [
      'ABCD AD2.24-SID-13',
      'STANDARD DEPARTURE CHART-INSTRUMENT',
      'Path Descriptor Serial Number Course Turn Direction Altitude Speed',
      'VA DF TF TF',
    ].join('\n')),
    sourcePage(4, firstSource, [
      'ABCD AD2.24-SID-14',
      'STANDARD DEPARTURE CHART-INSTRUMENT',
      'Waypoint Coordinates',
      'VAMOS 351215.5N / 1394543.6E',
    ].join('\n')),
    sourcePage(5, secondSource, [
      'ABCD AD2.24-SID-17',
      'STANDARD DEPARTURE CHART-INSTRUMENT',
      'RNAV SID ABCD/EXAMPLE INTL',
      'TIARA TWO A DEPARTURE RWY16R/16L',
    ].join('\n')),
  ];

  const packages = groupProcedurePackages(pages);

  it('keeps all pages from one authored procedure document together', () => {
    const vamos = packages.find((item) => item.relatedChartNos?.includes('AD 2-ABCD-SID-11'));
    assert.ok(vamos);
    assert.deepEqual(vamos.relatedPageNos, [1, 2, 3, 4]);
    assert.deepEqual(vamos.chartPages, [1, 2, 3]);
    assert.deepEqual(vamos.coordinatePages, [4]);
    assert.ok(vamos.relatedChartNos?.includes('AD 2-ABCD-SID-14'));
  });

  it('does not merge different source documents merely because both are SIDs', () => {
    assert.equal(packages.length, 2);
    const tiara = packages.find((item) => item.relatedChartNos?.includes('AD 2-ABCD-SID-17'));
    assert.ok(tiara);
    assert.deepEqual(tiara.relatedPageNos, [5]);
  });
});
