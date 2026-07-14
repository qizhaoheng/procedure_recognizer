import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessPdfTextLayer, decodeEmbeddedPdfText } from '../pdfTextDecoder';

function encodeCustomFont(value: string) {
  return [...value].map((char) => {
    const code = char.charCodeAt(0);
    return code >= 0x20 && code <= 0x5a ? String.fromCharCode(code - 0x1d) : char;
  }).join('');
}

describe('embedded AIP PDF font decoding', () => {
  it('recovers prose, numbers and punctuation before page classification', () => {
    const encoded = encodeCustomFont('TIARA TWO A DEPARTURE RWY34L - 5000FT.');
    assert.equal(decodeEmbeddedPdfText(encoded), 'TIARA TWO A DEPARTURE RWY34L - 5000FT.');
  });

  it('reports decoded text separately from genuinely suspect text', () => {
    const decoded = assessPdfTextLayer(encodeCustomFont('STANDARD DEPARTURE CHART-INSTRUMENT'));
    assert.equal(decoded.quality, 'DECODED');
    assert.equal(decoded.text, 'STANDARD DEPARTURE CHART-INSTRUMENT');

    const suspect = assessPdfTextLayer(`NORMAL TEXT${String.fromCharCode(1, 2, 4, 5, 6)}`);
    assert.equal(suspect.quality, 'SUSPECT');
  });
});
