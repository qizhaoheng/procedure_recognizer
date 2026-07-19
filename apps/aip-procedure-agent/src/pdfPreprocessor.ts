import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { pathToFileURL } from 'node:url';
import type { PageAsset } from './domain';
import { parseCoordinate } from './coordinate';

export class PdfDocumentTools {
  private pages: PageAsset[] = [];
  constructor(private filePath: string, private outputDir: string) {}
  async preprocess(onPage?: (page: PageAsset) => Promise<void> | void) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); const data = new Uint8Array(await fs.readFile(this.filePath));
    const loadingTask = pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: true, cMapUrl: directoryUrl('node_modules/pdfjs-dist/cmaps'), cMapPacked: true, standardFontDataUrl: directoryUrl('node_modules/pdfjs-dist/standard_fonts') });
    const doc = await loadingTask.promise;
    await fs.mkdir(this.outputDir, { recursive: true });
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber); const viewport = page.getViewport({ scale: 1 }); const content = await page.getTextContent();
      const spans = content.items.flatMap((item: any) => { if (!item.str) return []; const tx = pdfjs.Util.transform(viewport.transform, item.transform); const x = tx[4]; const y = tx[5]; return [{ text: String(item.str), bbox: [x, y - Math.abs(tx[3]), x + (item.width || 0), y] as [number, number, number, number] }]; });
      const nativeText = spans.map((s) => s.text).join('\n'); const operatorList = await page.getOperatorList();
      // 完整算子数是"图 vs 表"的关键判据，必须在截断前记录：截断后所有航图页都并列 5000，信号被抹平。
      const vectorPathCount = operatorList.fnArray.length;
      const vectorPaths = operatorList.fnArray.slice(0, 5000).map((fn: number, i: number) => ({ operator: String(fn), args: Array.isArray(operatorList.argsArray[i]) ? operatorList.argsArray[i].flat(2).filter((v: unknown) => typeof v === 'number').slice(0, 40) : undefined }));
      const renderedImagePath = await this.renderPdfPage(page, pageNumber, 200, `page-${pageNumber}.png`); const thumbnailPath = await this.renderPdfPage(page, pageNumber, 55, `thumb-${pageNumber}.png`);
      const coverage = Math.min(1, nativeText.replace(/\s/g, '').length / Math.max(1, viewport.width * viewport.height / 250));
      const asset: PageAsset = { pageNumber, width: Math.round(viewport.width), height: Math.round(viewport.height), rotation: page.rotate || 0, renderedImagePath, thumbnailPath, nativeText, textSpans: spans, vectorPaths, vectorPathCount, embeddedImages: [], detectedTables: [], detectedLanguages: detectLanguages(nativeText), quality: { isScanned: nativeText.trim().length < 20, nativeTextCoverage: coverage, renderDpi: 200, garbledTextRatio: garbledTextRatio(nativeText) }, summary: summarize(nativeText), title: nativeText.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 5)?.slice(0, 160) };
      this.pages.push(asset); await onPage?.(asset); page.cleanup();
    }
    await loadingTask.destroy(); return this.pages;
  }
  listPages() { return this.pages.map(({ nativeText, textSpans, vectorPaths, ...page }) => ({ ...page, textLength: nativeText.length, spanCount: textSpans.length, vectorPathCount: page.vectorPathCount ?? vectorPaths.length })); }
  getPageSummary(page: number) { return this.requirePage(page).summary; }
  extractText(page: number, bbox?: [number, number, number, number]) { const item = this.requirePage(page); if (!bbox) return item.nativeText; return item.textSpans.filter((span) => intersects(span.bbox, bbox)).map((span) => span.text).join('\n'); }
  searchDocument(keyword: string) { const needle = keyword.toLocaleLowerCase(); return this.pages.flatMap((page) => page.nativeText.toLocaleLowerCase().includes(needle) ? [{ pageNumber: page.pageNumber, snippets: snippets(page.nativeText, keyword) }] : []); }
  extractVectorPaths(page: number) { return this.requirePage(page).vectorPaths; }
  parseCoordinate(text: string) { return parseCoordinate(text); }
  async cropPage(page: number, bbox: [number, number, number, number], scale = 2) { const source = this.requirePage(page); const { loadImage } = await import('@napi-rs/canvas'); const image = await loadImage(source.renderedImagePath); const [x1, y1, x2, y2] = bbox; const canvas = createCanvas(Math.max(1, Math.round((x2 - x1) * scale)), Math.max(1, Math.round((y2 - y1) * scale))); canvas.getContext('2d').drawImage(image, x1, y1, x2 - x1, y2 - y1, 0, 0, canvas.width, canvas.height); const out = path.join(this.outputDir, `crop-${page}-${Date.now()}.png`); await fs.writeFile(out, canvas.toBuffer('image/png')); return out; }
  private requirePage(page: number) { const found = this.pages[page - 1]; if (!found) throw new Error(`Page ${page} does not exist.`); return found; }
  private async renderPdfPage(page: any, pageNumber: number, dpi: number, name: string) { const scale = dpi / 72; const viewport = page.getViewport({ scale }); const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)); await page.render({ canvasContext: canvas.getContext('2d') as any, viewport }).promise; const file = path.join(this.outputDir, name); await fs.writeFile(file, canvas.toBuffer('image/png')); return file; }
}
/**
 * 非字母数字字符的占比，用来识别"有文本但不可用"。
 *
 * WMKJ 的 PDF 字体没有 ToUnicode 映射，pdfjs 抽出的是原始字形码
 * （"&,9,/$9,$7,21" 实为 "CIVIL AVIATION"），页面看着文本丰富，实际全是垃圾。
 * 先折叠连续重复字符：目录页的点线导引（"........"）会把占比抬到 0.49，
 * 但那是同一字符重复，文本本身可读；乱码则是杂乱符号，折叠后占比不降。
 *
 * 两份真实语料实测：正常页 0.04–0.15，乱码页 0.59–0.64，中间有很宽的空档。
 */
export function garbledTextRatio(text: string) {
  const collapsed = (text || '').replace(/\s+/g, '').replace(/(.)\1{2,}/g, '$1');
  if (!collapsed.length) return 0;
  const alphanumeric = (collapsed.match(/[A-Za-z0-9]/g) || []).length;
  return (collapsed.length - alphanumeric) / collapsed.length;
}
function summarize(text: string) { return text.replace(/\s+/g, ' ').trim().slice(0, 1800); }
function detectLanguages(text: string) { const out: string[] = []; if (/[A-Za-z]{4}/.test(text)) out.push('en'); if (/[一-鿿]/.test(text)) out.push('zh'); if (/[぀-ヿ]/.test(text)) out.push('ja'); if (/[가-힯]/.test(text)) out.push('ko'); return out.length ? out : ['und']; }
function intersects(a: number[], b: number[]) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
function snippets(text: string, keyword: string) { const lower = text.toLowerCase(); const needle = keyword.toLowerCase(); const out: string[] = []; let from = 0; while (out.length < 8) { const i = lower.indexOf(needle, from); if (i < 0) break; out.push(text.slice(Math.max(0, i - 100), i + needle.length + 180).replace(/\s+/g, ' ')); from = i + needle.length; } return out; }
function directoryUrl(relative: string) { return pathToFileURL(`${path.resolve(process.cwd(), relative)}${path.sep}`).href; }
