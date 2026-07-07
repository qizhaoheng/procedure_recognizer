import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyPage } from './pageClassifier';
import type { PdfPageAsset, ProcedureTask } from '../types/procedure';
import { getTaskDir } from '../storage/taskStore';

interface ExtractedPdfPage {
  pageNo: number;
  text: string;
  width: number;
  height: number;
}

export async function parsePdfTask(task: ProcedureTask): Promise<PdfPageAsset[]> {
  const assetsDir = path.join(getTaskDir(task.taskId), 'pages');
  await fs.mkdir(assetsDir, { recursive: true });
  const extractedPages = await extractPdfPages(task.filePath);

  const pages: PdfPageAsset[] = [];
  for (const extracted of extractedPages) {
    const page = classifyPage(extracted.pageNo, extracted.text);
    const imageFile = `page-${extracted.pageNo}.svg`;
    const thumbFile = `thumb-${extracted.pageNo}.svg`;
    await fs.writeFile(
      path.join(assetsDir, imageFile),
      renderPageSvg(extracted, page, { width: 960, height: 1320, compact: false }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(assetsDir, thumbFile),
      renderPageSvg(extracted, page, { width: 220, height: 300, compact: true }),
      'utf-8',
    );

    pages.push({
      ...page,
      imageUrl: `/uploads/procedure-tasks/${task.taskId}/pages/${imageFile}`,
      thumbnailUrl: `/uploads/procedure-tasks/${task.taskId}/pages/${thumbFile}`,
      sourceWidthPt: extracted.width,
      sourceHeightPt: extracted.height,
    });
  }

  return pages;
}

async function extractPdfPages(filePath: string): Promise<ExtractedPdfPage[]> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fs.readFile(filePath));
    const documentTask = pdfjs.getDocument({
      data,
      disableFontFace: true,
      useSystemFonts: true,
    });
    const pdf = await documentTask.promise;
    const pages: ExtractedPdfPage[] = [];

    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const text = content.items
        .map((item: unknown) => ('str' in (item as Record<string, unknown>) ? String((item as { str: string }).str) : ''))
        .filter(Boolean)
        .join('\n');
      pages.push({ pageNo, text, width: viewport.width, height: viewport.height });
    }

    await documentTask.destroy();
    return pages;
  } catch {
    return fallbackExtract(filePath);
  }
}

async function fallbackExtract(filePath: string): Promise<ExtractedPdfPage[]> {
  const buffer = await fs.readFile(filePath);
  const latinText = buffer.toString('latin1');
  const pageCount = Math.max(1, (latinText.match(/\/Type\s*\/Page\b/g) ?? []).length);
  const roughText = latinText
    .replace(/[^\x20-\x7E\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 4000);

  return Array.from({ length: pageCount }, (_, index) => ({
    pageNo: index + 1,
    text: index === 0 ? roughText : '',
    width: 595,
    height: 842,
  }));
}

function renderPageSvg(
  extracted: ExtractedPdfPage,
  page: PdfPageAsset,
  options: { width: number; height: number; compact: boolean },
) {
  const lines = (page.textLayerText || 'No extractable text on this page yet.')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, options.compact ? 5 : 20);
  const title = page.chartTitle || page.aipPageNo || `PDF Page ${page.pageNo}`;
  const scaleText = `source ${Math.round(extracted.width)} x ${Math.round(extracted.height)}`;
  const lineHeight = options.compact ? 18 : 28;
  const fontSize = options.compact ? 11 : 18;
  const startY = options.compact ? 92 : 180;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <rect x="${options.compact ? 10 : 28}" y="${options.compact ? 10 : 28}" width="${options.width - (options.compact ? 20 : 56)}" height="${options.height - (options.compact ? 20 : 56)}" fill="#fff" stroke="#cbd5e1"/>
  <text x="${options.compact ? 18 : 56}" y="${options.compact ? 34 : 76}" font-family="Arial, sans-serif" font-size="${options.compact ? 18 : 34}" font-weight="700" fill="#111827">P${page.pageNo}</text>
  <text x="${options.compact ? 18 : 56}" y="${options.compact ? 56 : 116}" font-family="Arial, sans-serif" font-size="${options.compact ? 11 : 18}" fill="#475569">${escapeXml(page.aipPageNo || page.chartRole)}</text>
  <text x="${options.compact ? 18 : 56}" y="${options.compact ? 76 : 146}" font-family="Arial, sans-serif" font-size="${options.compact ? 10 : 16}" fill="#64748b">${escapeXml([page.procedureCategory, page.navigationType, page.runway, scaleText].filter(Boolean).join(' · '))}</text>
  <text x="${options.compact ? 18 : 56}" y="${startY - lineHeight}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#1f2937">${escapeXml(title.slice(0, options.compact ? 24 : 80))}</text>
  ${lines
    .map(
      (line, index) =>
        `<text x="${options.compact ? 18 : 56}" y="${startY + index * lineHeight}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="#334155">${escapeXml(line.slice(0, options.compact ? 28 : 95))}</text>`,
    )
    .join('\n  ')}
</svg>`;
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
