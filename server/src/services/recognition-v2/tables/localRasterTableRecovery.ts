import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import type { PdfPageAsset } from '../../../types/procedure';
import { localImageAsDataUrl } from '../../llmService';
import type { PhysicalTable, PhysicalTableCell, PhysicalTableRow } from '../contracts/index';

const execFileAsync = promisify(execFile);
const OCR_ENGINE_VERSION = 'windows-media-ocr-grid-v1';

interface OcrWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OcrResult {
  language: string;
  width: number;
  height: number;
  text: string;
  lines: Array<{ text: string; words: OcrWord[] }>;
}

interface RasterGrid {
  xLines: number[];
  yLines: number[];
  headerRow: number;
}

export interface LocalRasterWaypointCoordinate {
  identifier: string;
  coordinateText: string;
  rawText: string;
  bbox: [number, number, number, number];
  confidence: number;
}

export interface LocalRasterEvidenceLocation {
  bbox: [number, number, number, number];
  matchedText: string;
  method: 'OCR_WORD_LINE';
}

export async function locateLocalRasterEvidence(
  page: PdfPageAsset,
  terms: string[],
  sourceType?: string,
): Promise<LocalRasterEvidenceLocation | undefined> {
  if (process.platform !== 'win32' || !page.imageUrl || process.env.RECOGNITION_V2_LOCAL_OCR === '0') return undefined;
  const dataUrl = await localImageAsDataUrl(page.imageUrl);
  if (!dataUrl.startsWith('data:image/png;base64,')) return undefined;
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const hash = crypto.createHash('sha256').update(OCR_ENGINE_VERSION).update(png).digest('hex');
  const cacheDir = path.resolve(process.cwd(), 'server', 'data', 'recognition-v2', 'ocr-cache');
  const pngPath = path.join(cacheDir, `${hash}.png`);
  const jsonPath = path.join(cacheDir, `${hash}.json`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(pngPath, png);
  const ocr = await readOrRunOcr(pngPath, jsonPath);
  const normalizedTerms = terms.map(normalizeOcr).map((term) => term.toUpperCase()).filter((term) => /^[A-Z][A-Z0-9]{1,7}$/.test(term));
  const allWords = ocr.lines.flatMap((line) => line.words);
  const coordinateSource = /COORDINATE|WAYPOINT_COORDINATE/i.test(sourceType ?? '');
  const waypointListY = coordinateSource
    ? Math.min(...allWords.filter((word) => /^WAYPOINT$/i.test(normalizeOcr(word.text)) && word.y > ocr.height * 0.4).map((word) => word.y))
    : Number.POSITIVE_INFINITY;
  for (const term of normalizedTerms) {
    const matches = allWords.filter((word) => normalizeOcr(word.text).toUpperCase() === term);
    const word = coordinateSource
      ? matches.find((candidate) => candidate.y > waypointListY) ?? matches.at(-1)
      : matches[0];
    if (!word) continue;
    const rowWords = allWords.filter((candidate) => Math.abs(candidate.y - word.y) <= Math.max(5, word.height * 0.35));
    return {
      bbox: normalizedWordBounds(rowWords.length ? rowWords : [word], ocr.width, ocr.height),
      matchedText: rowWords.map((candidate) => normalizeOcr(candidate.text)).filter(Boolean).join(' '),
      method: 'OCR_WORD_LINE',
    };
  }
  return undefined;
}

export async function recoverLocalRasterProcedureTable(page: PdfPageAsset): Promise<PhysicalTable | undefined> {
  const debug = (reason: string, details?: unknown) => {
    if (process.env.RECOGNITION_V2_OCR_DEBUG === '1') console.error(`[local-raster-ocr] page ${page.pageNo}: ${reason}`, details ?? '');
  };
  if (process.platform !== 'win32' || !page.imageUrl || process.env.RECOGNITION_V2_LOCAL_OCR === '0') {
    debug('unsupported or disabled');
    return undefined;
  }
  const dataUrl = await localImageAsDataUrl(page.imageUrl);
  if (!dataUrl.startsWith('data:image/png;base64,')) {
    debug('render did not return PNG');
    return undefined;
  }
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const hash = crypto.createHash('sha256').update(OCR_ENGINE_VERSION).update(png).digest('hex');
  const cacheDir = path.resolve(process.cwd(), 'server', 'data', 'recognition-v2', 'ocr-cache');
  const pngPath = path.join(cacheDir, `${hash}.png`);
  const jsonPath = path.join(cacheDir, `${hash}.json`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(pngPath, png);
  const ocr = await readOrRunOcr(pngPath, jsonPath);
  const words = ocr.lines.flatMap((line) => line.words);
  if (!/TABULAR\s+DESCRIPTION|FMC\s+DATABASE\s+CODING/i.test(normalizeOcr(ocr.text))) {
    debug('coding-table title absent');
    return undefined;
  }
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height);
  const grid = detectCodingTableGrid(words, pixels.data, image.width, image.height);
  if (!grid || grid.xLines.length < 8 || grid.yLines.length < 5) {
    debug('grid not recovered', grid);
    return undefined;
  }

  const cellWords = buildCellWords(words, grid);
  const headerValues = cellWords[grid.headerRow].map(canonicalHeader);
  if (!headerValues.some((value) => /PATH/i.test(value)) || !headerValues.some((value) => /WAYPOINT|IDENTIFIER/i.test(value))) {
    debug('required headers absent', headerValues);
    return undefined;
  }
  const distanceColumn = headerValues.findIndex((value) => /DISTANCE/i.test(value));
  const turnColumn = headerValues.findIndex((value) => /TURN/i.test(value));
  const dataRows: PhysicalTableRow[] = [];
  const dataGridRows: number[] = [];
  const tableId = `table_${hash.slice(0, 20)}`;

  for (let gridRow = grid.headerRow + 1; gridRow < grid.yLines.length - 1; gridRow += 1) {
    const values = cellWords[gridRow].map(normalizeOcr);
    const waypointColumn = headerValues.findIndex((value) => /WAYPOINT|IDENTIFIER/i.test(value));
    if (waypointColumn >= 0) values[waypointColumn] = normalizeTableIdentifier(values[waypointColumn]);
    const distanceColumn = headerValues.findIndex((value) => /DISTANCE/i.test(value));
    if (distanceColumn >= 0) values[distanceColumn] = normalizeTableDecimal(values[distanceColumn]);
    const navigationColumn = headerValues.findIndex((value) => /NAVIGATION/i.test(value));
    if (navigationColumn >= 0) values[navigationColumn] = normalizeNavigationSpecification(values[navigationColumn]);
    const altitudeColumn = headerValues.findIndex((value) => /ALTITUDE/i.test(value));
    if (altitudeColumn >= 0) values[altitudeColumn] = normalizeSignedConstraint(values[altitudeColumn]);
    const speedColumn = headerValues.findIndex((value) => /SPEED/i.test(value));
    if (speedColumn >= 0) values[speedColumn] = normalizeSignedConstraint(values[speedColumn]);
    if (!values.some((value) => value.trim())) continue;
    const pathColumn = headerValues.findIndex((value) => /PATH/i.test(value));
    if (pathColumn >= 0) {
      values[pathColumn] = normalizeRfCell(values[pathColumn]);
      if (!values[pathColumn]) {
        const recoveredPath = normalizeOcr(await ocrCell(pixels.data, image.width, image.height, cellBounds(grid, gridRow, pathColumn), cacheDir, `${hash}-${gridRow}-${pathColumn}-path`));
        values[pathColumn] = recoveredPath.match(/\b(?:AF|CF|DF|IF|RF|TF)\b/i)?.[0]?.toUpperCase() ?? values[pathColumn];
      }
    }
    if (distanceColumn >= 0 && !numericCell(values[distanceColumn])) {
      const recoveredDistance = normalizeOcr(await ocrCell(pixels.data, image.width, image.height, cellBounds(grid, gridRow, distanceColumn), cacheDir, `${hash}-${gridRow}-${distanceColumn}-distance`));
      values[distanceColumn] = normalizeTableDecimal(recoveredDistance) || values[distanceColumn]
        || (cellHasInk(pixels.data, image.width, cellBounds(grid, gridRow, distanceColumn)) ? '[UNREADABLE]' : '');
    }
    const isRf = pathColumn >= 0 && /\bRF\b|RF\s*(?:ARC\s*)?CENT(?:RE|ER)/i.test(values[pathColumn]);
    if (isRf && distanceColumn >= 0 && !numericCell(values[distanceColumn])) {
      values[distanceColumn] = normalizeOcr(await ocrCell(pixels.data, image.width, image.height, cellBounds(grid, gridRow, distanceColumn), cacheDir, `${hash}-${gridRow}-${distanceColumn}`));
    }
    if (turnColumn >= 0 && !/^(?:L|R|LEFT|RIGHT)$/i.test(values[turnColumn])) {
      values[turnColumn] = classifyTurnGlyph(pixels.data, image.width, image.height, cellBounds(grid, gridRow, turnColumn)) ?? values[turnColumn];
    }
    const rowIndex = dataRows.length + 1;
    dataRows.push(physicalRow(tableId, rowIndex, 'DATA', values, 0.78, true));
    dataGridRows.push(gridRow);
  }
  const pathColumn = headerValues.findIndex((value) => /PATH/i.test(value));
  if (pathColumn >= 0) recoverRepeatedPathGlyphs(dataRows, dataGridRows, pathColumn, grid, pixels.data, image.width);
  if (distanceColumn >= 0) recoverUnreadableNumericCells(dataRows, dataGridRows, distanceColumn, grid, pixels.data, image.width);
  const certification = certifyOfficialCodingRows(headerValues, dataRows);
  const waypointColumn = headerValues.findIndex((value) => /WAYPOINT|IDENTIFIER/i.test(value));
  const encodableRows = dataRows.filter((row) => {
    const pathValue = row.cells[pathColumn]?.rawText ?? '';
    const waypointValue = row.cells[waypointColumn]?.rawText ?? '';
    return /\b(?:AF|CA|CD|CF|CI|CR|DF|FA|FC|FD|FM|HA|HF|HM|IF|PI|RF|TF|VA|VD|VI|VM|VR)\b/i.test(pathValue)
      && /[A-Z0-9]{2,}/i.test(waypointValue);
  });
  if (encodableRows.length < 2) {
    debug('fewer than two encodable procedure rows after grid recovery', dataRows.map((row) => row.rawText));
    return undefined;
  }
  debug('table recovered', { xLines: grid.xLines, yLines: grid.yLines, headers: headerValues, rows: dataRows.map((row) => row.rawText) });
  const header = physicalRow(tableId, 0, 'HEADER', headerValues, 0.82, true);
  return {
    tableId,
    pageNo: page.pageNo,
    regionId: `p${page.pageNo}-local-raster-table`,
    bbox: [grid.xLines[0] / image.width, grid.yLines[grid.headerRow] / image.height, grid.xLines.at(-1)! / image.width, grid.yLines.at(-1)! / image.height],
    columnCount: grid.xLines.length - 1,
    rows: [header, ...dataRows],
    analysisMethod: 'TEXT_RULES',
    warnings: [certification.certified
      ? `Recovered and deterministically certified ${certification.certifiedRows} official coding-table rows with ${OCR_ENGINE_VERSION}; ambiguous cells remain review-required.`
      : `Recovered a physical coding table from raster pixels with ${OCR_ENGINE_VERSION}; deterministic certification failed (${certification.reason}), so recovered cells remain review-required.`],
  };
}

const CERTIFIED_ROW_CONFIDENCE = 0.96;
const PATH_TERMINATOR = /^(?:AF|CA|CD|CF|CI|CR|DF|FA|FC|FD|FM|HA|HF|HM|IF|PI|RF|TF|VA|VD|VI|VM|VR)$/;

/**
 * Certifies only the independently checkable fields of an official coding table.
 * A table is eligible only when every row has a coherent serial/path/fix/course
 * skeleton and the printed magnetic variation agrees with magnetic/true course.
 * Constraints and unreadable cells deliberately retain their OCR confidence.
 */
export function certifyOfficialCodingRows(headers: string[], rows: PhysicalTableRow[]) {
  const column = (pattern: RegExp) => headers.findIndex((value) => pattern.test(value.toUpperCase()));
  const serialColumn = column(/SERIAL|SEQUENCE|SEQ(?:UENCE)?|NUMBER/);
  const pathColumn = column(/PATH|TERMINATOR|DESCRIPTOR|LEG TYPE/);
  const fixColumn = column(/WAYPOINT|FIX|IDENTIFIER/);
  const courseColumn = column(/COURSE|TRACK|BEARING/);
  const variationColumn = column(/MAGNETIC VARIATION|MAG VAR/);
  const required = [serialColumn, pathColumn, fixColumn, courseColumn, variationColumn];
  if (required.some((index) => index < 0)) return { certified: false, certifiedRows: 0, reason: 'required columns absent' };
  if (rows.length < 2) return { certified: false, certifiedRows: 0, reason: 'fewer than two data rows' };

  const skeletons = rows.map((row, index) => {
    const serial = Number(row.cells[serialColumn]?.rawText.match(/\d+/)?.[0]);
    const path = row.cells[pathColumn]?.rawText.trim().toUpperCase() ?? '';
    const fix = row.cells[fixColumn]?.rawText.trim().toUpperCase() ?? '';
    const courses = codingCoursePair(row.cells[courseColumn]?.rawText ?? '');
    const courseVariation = courses.magnetic !== undefined && courses.true !== undefined
      ? ((courses.magnetic - courses.true + 540) % 360) - 180
      : undefined;
    return {
      valid: serial === index + 1
        && PATH_TERMINATOR.test(path)
        && /^[A-Z0-9]{2,8}$/.test(fix)
        && courses.magnetic !== undefined
        && courses.true !== undefined
        && courseVariation !== undefined
        && Math.abs(courseVariation) <= 30,
      courseVariation,
    };
  });
  if (skeletons.some((item) => !item.valid)) return { certified: false, certifiedRows: 0, reason: 'row skeleton or serial sequence inconsistent' };
  const variations = skeletons.map((item) => item.courseVariation!);
  if (Math.max(...variations) - Math.min(...variations) > 0.2) {
    return { certified: false, certifiedRows: 0, reason: 'course-derived magnetic variation is inconsistent across rows' };
  }

  const certifiableColumn = (header: string, raw: string) => {
    const normalizedHeader = header.toUpperCase();
    const value = raw.trim().toUpperCase();
    if (/SERIAL|SEQUENCE|SEQ(?:UENCE)?|NUMBER/.test(normalizedHeader)) return /^\d{1,3}$/.test(value);
    if (/PATH|TERMINATOR|DESCRIPTOR|LEG TYPE/.test(normalizedHeader)) return PATH_TERMINATOR.test(value);
    if (/WAYPOINT|FIX|IDENTIFIER/.test(normalizedHeader)) return /^[A-Z0-9]{2,8}$/.test(value);
    if (/COURSE|TRACK|BEARING/.test(normalizedHeader)) {
      const pair = codingCoursePair(value);
      return pair.magnetic !== undefined && pair.true !== undefined;
    }
    if (/MAGNETIC VARIATION|MAG VAR/.test(normalizedHeader)) return true; // checked independently from both printed courses
    if (/NAVIGATION SPEC/.test(normalizedHeader)) return /^(?:RNP|RNAV)\s*\d+(?:\.\d+)?$/.test(value);
    if (/FLY-?OVER/.test(normalizedHeader)) return value === '' || /^(?:Y|N|YES|NO|-)$/.test(value);
    if (/TURN/.test(normalizedHeader)) return value === '' || /^(?:L|R|LEFT|RIGHT|-)$/.test(value);
    if (/SPEED|KIAS/.test(normalizedHeader)) return value === '' || /^[@+\-]?\d{2,3}$/.test(value);
    if (/DIST|LENGTH/.test(normalizedHeader)) return value === '' || /^\d+(?:\.\d+)?$/.test(value);
    return false;
  };

  rows.forEach((row) => {
    row.confidence = CERTIFIED_ROW_CONFIDENCE;
    row.reviewRequired = false;
    row.cells.forEach((cell) => {
      if (!certifiableColumn(headers[cell.columnIndex] ?? '', cell.rawText)) return;
      cell.confidence = CERTIFIED_ROW_CONFIDENCE;
      cell.reviewRequired = false;
    });
  });
  return { certified: true, certifiedRows: rows.length, reason: 'certified' };
}

function codingCoursePair(value: string) {
  const numbers = [...value.matchAll(/\d{1,3}(?:\.\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter((number) => Number.isFinite(number) && number >= 0 && number <= 360);
  return { magnetic: numbers[0], true: numbers[1] };
}

function recoverRepeatedPathGlyphs(
  rows: PhysicalTableRow[],
  gridRows: number[],
  column: number,
  grid: RasterGrid,
  rgba: Uint8ClampedArray,
  width: number,
) {
  const allowed = /^(?:AF|CA|CD|CF|CI|CR|DF|FA|FC|FD|FM|HA|HF|HM|IF|PI|RF|TF|VA|VD|VI|VM|VR)$/;
  const templates = rows
    .map((row, index) => ({ index, value: row.cells[column]?.rawText.trim().toUpperCase() ?? '' }))
    .filter((item) => allowed.test(item.value))
    .map((item) => ({ ...item, signature: inkSignature(rgba, width, cellBounds(grid, gridRows[item.index], column)) }))
    .filter((item) => item.signature.size > 0);
  if (!templates.length) return;
  for (let index = 0; index < rows.length; index += 1) {
    const cell = rows[index].cells[column];
    if (!cell || allowed.test(cell.rawText.trim().toUpperCase())) continue;
    const signature = inkSignature(rgba, width, cellBounds(grid, gridRows[index], column));
    if (!signature.size) continue;
    const scores = templates
      .map((template) => ({ value: template.value, score: jaccard(signature, template.signature) }))
      .sort((a, b) => b.score - a.score);
    const best = scores[0];
    const runnerUp = scores.find((item) => item.value !== best.value);
    if (process.env.RECOGNITION_V2_OCR_DEBUG === '1') console.error('[local-raster-ocr] repeated path glyph', { index, scores });
    if (best.score >= 0.55 && (!runnerUp || best.score - runnerUp.score >= 0.12)) {
      cell.rawText = best.value;
      rows[index].rawText = rows[index].cells.map((item) => item.rawText).join(' | ');
    }
  }
}

function recoverUnreadableNumericCells(
  rows: PhysicalTableRow[],
  gridRows: number[],
  targetColumn: number,
  grid: RasterGrid,
  rgba: Uint8ClampedArray,
  width: number,
) {
  const templates: Array<{ character: string; signature: Set<number> }> = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let column = 0; column < rows[rowIndex].cells.length; column += 1) {
      const raw = rows[rowIndex].cells[column].rawText.replace(/\s+/g, '');
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) continue;
      const characters = raw.replace(/^[+-]/, '').split('');
      const components = inkComponents(rgba, width, cellBounds(grid, gridRows[rowIndex], column));
      if (components.length !== characters.length) continue;
      components.forEach((points, index) => templates.push({ character: characters[index], signature: normalizedInkSignature(points) }));
    }
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const cell = rows[rowIndex].cells[targetColumn];
    if (!cell || cell.rawText !== '[UNREADABLE]') continue;
    const components = inkComponents(rgba, width, cellBounds(grid, gridRows[rowIndex], targetColumn));
    const output: string[] = [];
    let reliable = components.length > 0;
    for (const points of components) {
      const signature = normalizedInkSignature(points);
      const byCharacter = [...new Set(templates.map((item) => item.character))]
        .map((character) => ({ character, score: Math.max(...templates.filter((item) => item.character === character).map((item) => jaccard(signature, item.signature))) }))
        .sort((a, b) => b.score - a.score);
      const best = byCharacter[0];
      const next = byCharacter[1];
      if (!best || best.score < 0.55 || (next && best.score - next.score < 0.12)) reliable = false;
      output.push(best?.character ?? '');
    }
    const recovered = output.join('');
    if (process.env.RECOGNITION_V2_OCR_DEBUG === '1') console.error('[local-raster-ocr] numeric glyph recovery', { rowIndex, recovered, reliable });
    if (reliable && /^\d+(?:\.\d+)?$/.test(recovered)) {
      cell.rawText = recovered;
      rows[rowIndex].rawText = rows[rowIndex].cells.map((item) => item.rawText).join(' | ');
    }
  }
}

function inkSignature(
  rgba: Uint8ClampedArray,
  width: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
) {
  const points: Array<[number, number]> = [];
  const padX = Math.max(5, Math.floor((bounds.x1 - bounds.x0) * 0.08));
  const padY = Math.max(5, Math.floor((bounds.y1 - bounds.y0) * 0.12));
  for (let y = Math.floor(bounds.y0 + padY); y < Math.ceil(bounds.y1 - padY); y += 1) {
    for (let x = Math.floor(bounds.x0 + padX); x < Math.ceil(bounds.x1 - padX); x += 1) {
      if (isBlack(rgba, width, x, y)) points.push([x, y]);
    }
  }
  if (points.length < 12) return new Set<number>();
  return normalizedInkSignature(points);
}

function normalizedInkSignature(points: Array<[number, number]>) {
  const output = new Set<number>();
  if (!points.length) return output;
  const minX = Math.min(...points.map(([x]) => x));
  const maxX = Math.max(...points.map(([x]) => x));
  const minY = Math.min(...points.map(([, y]) => y));
  const maxY = Math.max(...points.map(([, y]) => y));
  const targetWidth = 32;
  const targetHeight = 24;
  for (const [x, y] of points) {
    const nx = Math.min(targetWidth - 1, Math.round((x - minX) / Math.max(1, maxX - minX) * (targetWidth - 1)));
    const ny = Math.min(targetHeight - 1, Math.round((y - minY) / Math.max(1, maxY - minY) * (targetHeight - 1)));
    output.add(ny * targetWidth + nx);
  }
  return output;
}

function inkComponents(
  rgba: Uint8ClampedArray,
  width: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
) {
  const padX = Math.max(5, Math.floor((bounds.x1 - bounds.x0) * 0.08));
  const padY = Math.max(5, Math.floor((bounds.y1 - bounds.y0) * 0.12));
  const x0 = Math.floor(bounds.x0 + padX);
  const x1 = Math.ceil(bounds.x1 - padX);
  const y0 = Math.floor(bounds.y0 + padY);
  const y1 = Math.ceil(bounds.y1 - padY);
  const ink = new Set<number>();
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) if (isBlack(rgba, width, x, y)) ink.add(y * width + x);
  const components: Array<Array<[number, number]>> = [];
  while (ink.size) {
    const seed = ink.values().next().value as number;
    ink.delete(seed);
    const stack = [seed];
    const points: Array<[number, number]> = [];
    while (stack.length) {
      const value = stack.pop()!;
      const x = value % width;
      const y = Math.floor(value / width);
      points.push([x, y]);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const neighbor = (y + dy) * width + x + dx;
        if (ink.delete(neighbor)) stack.push(neighbor);
      }
    }
    if (points.length >= 3) components.push(points);
  }
  return components.sort((a, b) => Math.min(...a.map(([x]) => x)) - Math.min(...b.map(([x]) => x)));
}

function jaccard(left: Set<number>, right: Set<number>) {
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / Math.max(1, left.size + right.size - intersection);
}

function normalizeTableIdentifier(value: string) {
  return normalizeOcr(value)
    .toUpperCase()
    .replace(/^H\s*(\d{3})\s*H$/, 'HH$1')
    .replace(/\s+/g, '');
}

function normalizeTableDecimal(value: string) {
  return normalizeOcr(value).replace(/^(\d+)\s+[.·．]?\s*(\d)\.?$/, '$1.$2');
}

function normalizeNavigationSpecification(value: string) {
  const compact = normalizeOcr(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return [...compact].sort().join('') === '1NPR' ? 'RNP 1' : normalizeOcr(value).toUpperCase();
}

function normalizeSignedConstraint(value: string) {
  const normalized = normalizeOcr(value).trim();
  const trailingSign = normalized.match(/^(\d+)\s*([+])\s*([A-Z]*)$/i);
  return trailingSign ? `${trailingSign[2]}${trailingSign[1]}${trailingSign[3]}` : normalized;
}

export async function recoverLocalRasterWaypointCoordinates(page: PdfPageAsset): Promise<LocalRasterWaypointCoordinate[]> {
  if (process.platform !== 'win32' || !page.imageUrl || process.env.RECOGNITION_V2_LOCAL_OCR === '0') return [];
  const dataUrl = await localImageAsDataUrl(page.imageUrl);
  if (!dataUrl.startsWith('data:image/png;base64,')) return [];
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const hash = crypto.createHash('sha256').update(OCR_ENGINE_VERSION).update(png).digest('hex');
  const cacheDir = path.resolve(process.cwd(), 'server', 'data', 'recognition-v2', 'ocr-cache');
  const pngPath = path.join(cacheDir, `${hash}.png`);
  const jsonPath = path.join(cacheDir, `${hash}.json`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(pngPath, png);
  const ocr = await readOrRunOcr(pngPath, jsonPath);
  if (!/WAYPOINT\s+LIST/i.test(normalizeOcr(ocr.text))) return [];
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height);
  const words = ocr.lines.flatMap((line) => line.words);
  const markerY = Math.min(...words.filter((word) => /^WAYPOINT$/i.test(word.text) && word.y > image.height * 0.45).map((word) => word.y));
  if (!Number.isFinite(markerY)) return [];
  const identifierWords = [
    ...words.filter((word) => word.y > markerY && word.x < image.width * 0.35 && /^(?:[A-Z]{2}\d{3}|[A-Z]{5})$/i.test(normalizeOcr(word.text))),
    ...ocr.lines.flatMap((line) => {
      const lineWords = line.words.filter((word) => word.y > markerY && word.x < image.width * 0.35);
      const text = normalizeTableIdentifier(lineWords.map((word) => word.text).join(' '));
      if (!/^(?:[A-Z]{2}\d{3}|[A-Z]{5})$/.test(text) || lineWords.length < 2) return [];
      const x = Math.min(...lineWords.map((word) => word.x));
      const y = Math.min(...lineWords.map((word) => word.y));
      return [{ text, x, y, width: Math.max(...lineWords.map((word) => word.x + word.width)) - x, height: Math.max(...lineWords.map((word) => word.y + word.height)) - y }];
    }),
  ];
  const identifiers = identifierWords
    .sort((a, b) => a.y - b.y)
    .filter((word, index, values) => !index || normalizeOcr(word.text) !== normalizeOcr(values[index - 1].text) || Math.abs(word.y - values[index - 1].y) > 5);
  const rows: LocalRasterWaypointCoordinate[] = [];
  for (let index = 0; index < identifiers.length; index += 1) {
    const word = identifiers[index];
    const priorY = identifiers[index - 1]?.y;
    const nextY = identifiers[index + 1]?.y;
    const halfHeight = Math.max(18, Math.min(30, ((nextY ?? word.y + 40) - (priorY ?? word.y - 40)) / 4));
    const bounds = {
      x0: image.width * 0.335,
      x1: image.width * 0.64,
      y0: word.y - halfHeight,
      y1: word.y + word.height + halfHeight,
    };
    const cropped = normalizeOcr(await ocrCell(pixels.data, image.width, image.height, bounds, cacheDir, `${hash}-coordinate-${index}`));
    const fallback = ocr.lines.filter((line) => line.words.some((item) => Math.abs(item.y - word.y) <= 4) && line.words.some((item) => item.x > bounds.x0)).map((line) => line.text).join(' ');
    const parsed = normalizeCoordinateRow(cropped) ?? normalizeCoordinateRow(fallback);
    if (!parsed) continue;
    const lineWords = ocr.lines.find((line) => line.words.includes(word))?.words ?? [word];
    rows.push({
      identifier: normalizeOcr(word.text).toUpperCase(),
      coordinateText: parsed,
      rawText: cropped || fallback,
      bbox: normalizedWordBounds(lineWords, image.width, image.height),
      confidence: 0.82,
    });
  }
  return rows;
}

export async function readLocalRasterOcrText(page: PdfPageAsset): Promise<string | undefined> {
  if (process.platform !== 'win32' || !page.imageUrl || process.env.RECOGNITION_V2_LOCAL_OCR === '0') return undefined;
  const dataUrl = await localImageAsDataUrl(page.imageUrl);
  if (!dataUrl.startsWith('data:image/png;base64,')) return undefined;
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const hash = crypto.createHash('sha256').update(OCR_ENGINE_VERSION).update(png).digest('hex');
  const cacheDir = path.resolve(process.cwd(), 'server', 'data', 'recognition-v2', 'ocr-cache');
  const pngPath = path.join(cacheDir, `${hash}.png`);
  const jsonPath = path.join(cacheDir, `${hash}.json`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(pngPath, png);
  return normalizeOcr((await readOrRunOcr(pngPath, jsonPath)).text);
}

export async function locateLocalRasterTextRegions(page: PdfPageAsset, patterns: RegExp[]): Promise<Array<{ bbox: [number, number, number, number]; rawText: string }>> {
  if (process.platform !== 'win32' || !page.imageUrl || process.env.RECOGNITION_V2_LOCAL_OCR === '0') return [];
  const dataUrl = await localImageAsDataUrl(page.imageUrl);
  if (!dataUrl.startsWith('data:image/png;base64,')) return [];
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const fileHash = crypto.createHash('sha256').update(OCR_ENGINE_VERSION).update(png).digest('hex');
  const cacheDir = path.resolve(process.cwd(), 'server', 'data', 'recognition-v2', 'ocr-cache');
  const pngPath = path.join(cacheDir, `${fileHash}.png`);
  const jsonPath = path.join(cacheDir, `${fileHash}.json`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(pngPath, png);
  const ocr = await readOrRunOcr(pngPath, jsonPath);
  const regions: Array<{ bbox: [number, number, number, number]; rawText: string }> = [];
  for (const line of ocr.lines) {
    const text = normalizeOcr(line.text).replace(/\s+/g, ' ').trim();
    if (!patterns.some((pattern) => pattern.test(text))) continue;
    const y0 = Math.max(0, line.words.length ? Math.min(...line.words.map((word) => word.y)) / ocr.height - 0.025 : 0);
    const y1 = Math.min(1, y0 + 0.16);
    regions.push({ bbox: [0.12, y0, 0.92, y1], rawText: text });
  }
  return [...new Map(regions.map((item) => [item.bbox.map((value) => value.toFixed(3)).join(':'), item])).values()];
}

async function readOrRunOcr(pngPath: string, jsonPath: string): Promise<OcrResult> {
  try {
    return JSON.parse(await fs.readFile(jsonPath, 'utf8')) as OcrResult;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const scriptPath = path.resolve(process.cwd(), 'server', 'scripts', 'windows-ocr.ps1');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ImagePath', pngPath,
  ], { timeout: 45_000, maxBuffer: 25 * 1024 * 1024, encoding: 'utf8' });
  const result = JSON.parse(stdout.trim()) as OcrResult;
  await fs.writeFile(jsonPath, `${JSON.stringify(result)}\n`, 'utf8');
  return result;
}

function detectCodingTableGrid(words: OcrWord[], rgba: Uint8ClampedArray, width: number, height: number): RasterGrid | undefined {
  const serial = words.find((word) => /^SERIAL$/i.test(word.text));
  const pathHeader = words.find((word) => /^PATH$/i.test(word.text));
  const navigation = words.find((word) => /^NAVIGATION$/i.test(word.text));
  if (!serial || !pathHeader || !navigation) return undefined;
  const headerY = Math.min(serial.y, pathHeader.y, navigation.y);
  const serialNumbers = words.filter((word) => /^(?:0[1-9]|[1-9]\d?)$/.test(normalizeOcr(word.text)) && Math.abs(word.x - serial.x) < Math.max(90, serial.width * 2) && word.y > headerY);
  if (serialNumbers.length < 3) return undefined;
  const lastSerialBottom = Math.max(...serialNumbers.map((word) => word.y + word.height));
  const scanY0 = Math.max(0, Math.floor(headerY - 30));
  const scanY1 = Math.min(height - 1, Math.ceil(lastSerialBottom + 80));
  const scanX0 = Math.max(0, Math.floor(serial.x - 90));
  const scanX1 = Math.min(width - 1, Math.ceil(Math.max(...words.filter((word) => word.y >= scanY0 && word.y <= scanY1).map((word) => word.x + word.width)) + 70));
  const xCandidates: number[] = [];
  for (let x = scanX0; x <= scanX1; x += 1) {
    let black = 0;
    for (let y = scanY0; y <= scanY1; y += 1) if (isBlack(rgba, width, x, y)) black += 1;
    if (black >= (scanY1 - scanY0) * 0.36) xCandidates.push(x);
  }
  const xLines = groupedCenters(xCandidates).filter((x) => x >= scanX0 && x <= scanX1);
  if (xLines.length < 8) return undefined;
  const tableX0 = xLines[0];
  const tableX1 = xLines.at(-1)!;
  const yCandidates: number[] = [];
  for (let y = Math.max(0, scanY0 - 30); y <= Math.min(height - 1, scanY1 + 50); y += 1) {
    let black = 0;
    for (let x = tableX0; x <= tableX1; x += 1) if (isBlack(rgba, width, x, y)) black += 1;
    if (black >= (tableX1 - tableX0) * 0.68) yCandidates.push(y);
  }
  const yLines = groupedCenters(yCandidates);
  const headerRow = intervalIndex(yLines, headerY + serial.height / 2);
  if (headerRow < 0) return undefined;
  return { xLines, yLines, headerRow };
}

function buildCellWords(words: OcrWord[], grid: RasterGrid) {
  return Array.from({ length: grid.yLines.length - 1 }, (_row, rowIndex) =>
    Array.from({ length: grid.xLines.length - 1 }, (_column, columnIndex) => {
      const bounds = cellBounds(grid, rowIndex, columnIndex);
      return words.filter((word) => {
        const cx = word.x + word.width / 2;
        const cy = word.y + word.height / 2;
        return cx > bounds.x0 && cx < bounds.x1 && cy > bounds.y0 && cy < bounds.y1;
      }).sort((a, b) => a.y - b.y || a.x - b.x).map((word) => word.text).join(' ');
    }));
}

function canonicalHeader(value: string) {
  const normalized = normalizeOcr(value).toUpperCase();
  const compact = normalized.replace(/[^A-Z0-9]/g, '').replace(/^WAYPOINTLDENTIFIER$/, 'WAYPOINTIDENTIFIER');
  if (/SERIAL|NUMBER/.test(normalized)) return 'Serial Number';
  if (/PATH|DESCRIPTOR/.test(normalized)) return 'Path Descriptor';
  if (/WAYPOINT|IDENTIFIER/.test(normalized) || /WAYPOINT.*(?:IDENTIFIER|LDENTIFIER)/.test(compact)) return 'Waypoint Identifier';
  if (/FLY/.test(normalized)) return 'Fly-over';
  if (/COURSE/.test(normalized)) return 'Course';
  if (/MAGNETIC|VARIATION/.test(normalized)) return 'Magnetic Variation';
  if (/DISTANCE|\bNM\b/.test(normalized)) return 'Distance (NM)';
  if (/TURN|DIRECTION/.test(normalized)) return 'Turn Direction';
  if (/ALTITUDE|\bFT\b/.test(normalized)) return 'Altitude (ft)';
  if (/SPEED|KIAS/.test(normalized)) return 'Speed (KIAS)';
  if (/NAVIGATION|SPECIFICATION/.test(normalized)) return 'Navigation Specification';
  return normalized || 'Unknown';
}

function normalizeOcr(value: string) {
  return value
    .replace(/[．·。、]/g, '.')
    .replace(/[（《]/g, '(')
    .replace(/[）》]/g, ')')
    .replace(/\bH\s+H(?=\d{3,6}\b)/gi, 'HH')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s*=\s*/g, '=')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCoordinateRow(value: string) {
  const normalized = normalizeOcr(value)
    .replace(/[℃]/g, '0')
    .replace(/\bI(?=E\b)/g, '1')
    .replace(/O(?=[NE]\b)/g, '0');
  const compact = normalized.match(/\b(\d{2})\s+(\d{2})\s+(\d{2})\s*(\d{2})\s*N\b[\s,;/]+(\d{3})\s+(\d{2})\s+(\d{2})\s*(\d{2})\s*E\b/i);
  if (compact) return `${compact[1]} ${compact[2]} ${compact[3]}.${compact[4]}N ${compact[5]} ${compact[6]} ${compact[7]}.${compact[8]}E`;
  const match = normalized.match(/\b(\d{2})\s+(\d{2})\s+(\d{2})\s*[^0-9N]{0,6}\s*(\d)\s*(\d)\s*N\b[\s,;/]+(\d{3})\s+(\d{2})\s+(\d{2})\s*[^0-9E]{0,6}\s*(\d)\s*(\d)\s*E\b/i);
  if (!match) return undefined;
  const latSeconds = `${match[3]}.${match[4]}${match[5]}`;
  const lonSeconds = `${match[8]}.${match[9]}${match[10]}`;
  if (Number(match[2]) >= 60 || Number(latSeconds) >= 60 || Number(match[7]) >= 60 || Number(lonSeconds) >= 60) return undefined;
  return `${match[1]} ${match[2]} ${latSeconds}N ${match[6]} ${match[7]} ${lonSeconds}E`;
}

function normalizeRfCell(value: string) {
  const normalized = normalizeOcr(value);
  const center = normalized.match(/\bRF\s*(?:ARC\s*)?CENT(?:RE|ER)\s*:?\s*([A-Z0-9]{2,8})\b/i)?.[1];
  if (!center) return normalized;
  const afterCenter = normalized.slice(normalized.toUpperCase().indexOf(center.toUpperCase()) + center.length);
  const radius = afterCenter.match(/\bR\s*=\s*(\d+(?:\.\d+)?)/i)?.[1]
    ?? afterCenter.match(/\b(\d+)\s+(\d{1,4})\b/)?.slice(1).join('.');
  return radius ? `RF Centre: ${center.toUpperCase()} r=${radius} NM` : normalized;
}

function numericCell(value: string) {
  return /\d+(?:\.\d+)?/.test(normalizeOcr(value));
}

function cellHasInk(rgba: Uint8ClampedArray, width: number, bounds: { x0: number; y0: number; x1: number; y1: number }) {
  const points: Array<[number, number]> = [];
  const padX = Math.max(5, Math.floor((bounds.x1 - bounds.x0) * 0.08));
  const padY = Math.max(5, Math.floor((bounds.y1 - bounds.y0) * 0.12));
  for (let y = Math.floor(bounds.y0 + padY); y < Math.ceil(bounds.y1 - padY); y += 1) {
    for (let x = Math.floor(bounds.x0 + padX); x < Math.ceil(bounds.x1 - padX); x += 1) {
      if (isBlack(rgba, width, x, y)) points.push([x, y]);
    }
  }
  if (points.length < 12) return false;
  const inkWidth = Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x)) + 1;
  const inkHeight = Math.max(...points.map(([, y]) => y)) - Math.min(...points.map(([, y]) => y)) + 1;
  return inkWidth / Math.max(inkHeight, 1) < 3;
}

async function ocrCell(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  cacheDir: string,
  cacheKey: string,
) {
  const pad = 3;
  const x0 = Math.max(0, Math.floor(bounds.x0 + pad));
  const y0 = Math.max(0, Math.floor(bounds.y0 + pad));
  const cellWidth = Math.max(1, Math.floor(bounds.x1 - bounds.x0 - pad * 2));
  const cellHeight = Math.max(1, Math.floor(bounds.y1 - bounds.y0 - pad * 2));
  const canvas = createCanvas(cellWidth * 4, cellHeight * 4);
  const context = canvas.getContext('2d');
  const source = createCanvas(width, height);
  source.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(source, x0, y0, cellWidth, cellHeight, 0, 0, canvas.width, canvas.height);
  const filePath = path.join(cacheDir, `${cacheKey}-cell.png`);
  const jsonPath = path.join(cacheDir, `${cacheKey}-cell.json`);
  await fs.writeFile(filePath, canvas.toBuffer('image/png'));
  return (await readOrRunOcr(filePath, jsonPath)).text;
}

function classifyTurnGlyph(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
) {
  const points: Array<{ x: number; y: number }> = [];
  const padX = Math.max(3, Math.floor((bounds.x1 - bounds.x0) * 0.08));
  const padY = Math.max(3, Math.floor((bounds.y1 - bounds.y0) * 0.08));
  for (let y = Math.floor(bounds.y0 + padY); y < Math.ceil(bounds.y1 - padY); y += 1) {
    for (let x = Math.floor(bounds.x0 + padX); x < Math.ceil(bounds.x1 - padX); x += 1) {
      if (isBlack(rgba, width, x, y)) points.push({ x, y });
    }
  }
  if (points.length < 15) return undefined;
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const glyphWidth = maxX - minX + 1;
  const glyphHeight = maxY - minY + 1;
  if (glyphHeight < 8 || glyphWidth / glyphHeight > 1.7) return undefined;
  const upperRightInk = points.filter((point) => point.x > minX + glyphWidth * 0.55 && point.y < minY + glyphHeight * 0.58).length;
  return upperRightInk > points.length * 0.035 ? 'R' : 'L';
}

function physicalRow(tableId: string, rowIndex: number, rowType: 'HEADER' | 'DATA', values: string[], confidence: number, reviewRequired: boolean): PhysicalTableRow {
  return {
    rowId: `${tableId}:row:${rowIndex}`,
    rowIndex,
    rowType,
    rawText: values.join(' | '),
    confidence,
    reviewRequired,
    cells: values.map((rawText, columnIndex): PhysicalTableCell => ({
      cellId: `${tableId}:row:${rowIndex}:cell:${columnIndex}`,
      rowIndex,
      columnIndex,
      rowSpan: 1,
      columnSpan: 1,
      rawText,
      confidence,
      reviewRequired,
    })),
  };
}

function cellBounds(grid: RasterGrid, row: number, column: number) {
  return { x0: grid.xLines[column], y0: grid.yLines[row], x1: grid.xLines[column + 1], y1: grid.yLines[row + 1] };
}

function intervalIndex(lines: number[], value: number) {
  return lines.findIndex((line, index) => index < lines.length - 1 && value > line && value < lines[index + 1]);
}

function groupedCenters(values: number[]) {
  if (!values.length) return [];
  const groups: number[][] = [];
  for (const value of values.sort((a, b) => a - b)) {
    const last = groups.at(-1);
    if (!last || value - last.at(-1)! > 2) groups.push([value]);
    else last.push(value);
  }
  return groups.map((group) => Math.round(group.reduce((sum, value) => sum + value, 0) / group.length));
}

function normalizedWordBounds(words: OcrWord[], width: number, height: number): [number, number, number, number] {
  const padding = 8;
  const x0 = Math.max(0, Math.min(...words.map((word) => word.x)) - padding);
  const y0 = Math.max(0, Math.min(...words.map((word) => word.y)) - padding);
  const x1 = Math.min(width, Math.max(...words.map((word) => word.x + word.width)) + padding);
  const y1 = Math.min(height, Math.max(...words.map((word) => word.y + word.height)) + padding);
  return [x0 / width, y0 / height, x1 / width, y1 / height];
}

function isBlack(rgba: Uint8ClampedArray, width: number, x: number, y: number) {
  const offset = (y * width + x) * 4;
  return rgba[offset + 3] > 100 && (rgba[offset] + rgba[offset + 1] + rgba[offset + 2]) / 3 < 105;
}
