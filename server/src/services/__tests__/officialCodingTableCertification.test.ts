import assert from 'node:assert/strict';
import test from 'node:test';
import type { PhysicalTableRow } from '../recognition-v2/contracts/index';
import { certifyOfficialCodingRows } from '../recognition-v2/tables/localRasterTableRecovery';

const headers = [
  'Serial Number', 'Path Descriptor', 'Waypoint Identifier', 'Course',
  'Magnetic Variation', 'Distance (NM)', 'Turn Direction', 'Speed (KIAS)',
  'Navigation Specification', 'Altitude (ft)',
];

function row(index: number, values: string[]): PhysicalTableRow {
  return {
    rowId: `row-${index}`,
    rowIndex: index,
    rowType: 'DATA',
    rawText: values.join(' | '),
    confidence: 0.78,
    reviewRequired: true,
    cells: values.map((rawText, columnIndex) => ({
      cellId: `row-${index}-cell-${columnIndex}`,
      rowIndex: index,
      columnIndex,
      rowSpan: 1,
      columnSpan: 1,
      rawText,
      confidence: 0.78,
      reviewRequired: true,
    })),
  };
}

test('certifies coherent official coding rows but leaves unreadable cells for review', () => {
  const rows = [
    row(1, ['01', 'CF', 'HH301', '074 071', '3.0+', '', '', '', 'RNP 1', '']),
    row(2, ['02', 'TF', 'PORPA', '074 071', '3.0+', '[UNREADABLE]', '', '+205', 'RNP 1', '']),
  ];

  const result = certifyOfficialCodingRows(headers, rows);

  assert.equal(result.certified, true);
  assert.equal(rows[0].reviewRequired, false);
  assert.equal(rows[0].cells[1].confidence, 0.96);
  assert.equal(rows[1].cells[7].reviewRequired, false, 'valid speed is certified');
  assert.equal(rows[1].cells[5].reviewRequired, true, 'unreadable distance is not certified');
  assert.equal(rows[1].cells[5].confidence, 0.78);
  assert.equal(rows[1].cells[9].reviewRequired, true, 'constraints are outside strict certification');
});

test('rejects a table when course-derived variation is inconsistent', () => {
  const rows = [
    row(1, ['01', 'CF', 'HH301', '074 071', '3.0+', '', '', '', 'RNP 1', '']),
    row(2, ['02', 'TF', 'PORPA', '080 071', '3.0+', '2.0', '', '', 'RNP 1', '']),
  ];

  const result = certifyOfficialCodingRows(headers, rows);

  assert.equal(result.certified, false);
  assert.match(result.reason, /variation is inconsistent/);
  assert.equal(rows[0].reviewRequired, true);
  assert.equal(rows[0].cells[1].confidence, 0.78);
});

test('rejects malformed row sequence instead of promoting OCR output', () => {
  const rows = [
    row(1, ['01', 'CF', 'HH301', '074 071', '3.0+', '', '', '', 'RNP 1', '']),
    row(2, ['07', 'TF', 'PORPA', '074 071', '3.0+', '2.0', '', '', 'RNP 1', '']),
  ];

  const result = certifyOfficialCodingRows(headers, rows);

  assert.equal(result.certified, false);
  assert.match(result.reason, /sequence inconsistent/);
});
