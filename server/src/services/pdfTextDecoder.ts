export type PdfTextLayerQuality = 'USABLE' | 'DECODED' | 'SUSPECT' | 'EMPTY';

export interface PdfTextLayerAssessment {
  text: string;
  quality: PdfTextLayerQuality;
  warnings: string[];
}

/** Decode the deterministic custom-font character mapping used by some AIP PDFs. */
export function decodeEmbeddedPdfText(text: string) {
  if (!hasEmbeddedEncoding(text)) return text;
  // pdfjs extraction keeps individual text runs on separate lines. A page can
  // mix normal Unicode headers with custom-encoded chart text, so decode only
  // the runs that contain the encoding's control-character space marker.
  return text.split(/(\r?\n)/).map((line) => {
    if (!hasEmbeddedEncoding(line)) return line;
    return [...line].map((char) => {
      const code = char.charCodeAt(0);
      if (code >= 0x03 && code <= 0x3d) return String.fromCharCode(code + 0x1d);
      return char;
    }).join('');
  }).join('');
}

export function assessPdfTextLayer(rawText: string): PdfTextLayerAssessment {
  if (!rawText.trim()) return { text: '', quality: 'EMPTY', warnings: ['PDF page has no extractable text layer.'] };

  const encoded = hasEmbeddedEncoding(rawText);
  const text = decodeEmbeddedPdfText(rawText);
  const remainingControls = [...text].filter((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 && !/\s/.test(char);
  }).length;
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  const mojibakeCount = (text.match(/(?:Ã.|Â.|â€|ï¿½)/g) || []).length;
  const suspicious = remainingControls + replacementCount + mojibakeCount;

  if (suspicious > Math.max(3, text.length * 0.002)) {
    return {
      text,
      quality: 'SUSPECT',
      warnings: ['PDF text layer remains unreliable after embedded-font decoding; use the rendered page as the primary source.'],
    };
  }
  if (encoded) {
    return {
      text,
      quality: 'DECODED',
      warnings: ['PDF custom-font character codes were decoded before classification and extraction.'],
    };
  }
  return { text, quality: 'USABLE', warnings: [] };
}

function hasEmbeddedEncoding(text: string) {
  return [...text].some((char) => {
    const code = char.charCodeAt(0);
    return code === 0x03 || code === 0x0e || code === 0x10 || code === 0x11 || (code >= 0x13 && code <= 0x1c);
  });
}
