import fs from 'node:fs/promises';
import path from 'node:path';
import { callModel } from './modelGateway';
import type { AgentTask, PageAsset, ProcedurePIR, ValidationResult } from './domain';
import { taskDir } from './storage';

// 原图配准 + GeoJSON 叠加 + 视觉反向校验。
// 控制点：识别出的 Fix 坐标 ↔ 该 Fix 名在原生文本 span 中的页面位置。
// ≥3 个非共线控制点做仿射最小二乘；残差超限则 NOT_GEOREFERENCED，禁止强行配准。

export interface GeoreferenceResult { ok: boolean; reason?: string; controlPoints: number; meanResidualPx?: number; transform?: AffineTransform }
export interface AffineTransform { a: number; b: number; c: number; d: number; e: number; f: number } // px = a*lon + b*lat + c; py = d*lon + e*lat + f
export interface OverlayVerification {
  status: 'VERIFIED' | 'NOT_GEOREFERENCED' | 'NOT_COMPARABLE' | 'FAILED';
  georeference: GeoreferenceResult;
  overlayImagePath?: string;
  deviations: Array<{ kind: string; severity: 'WARNING' | 'ERROR' | 'BLOCKER'; legId?: string | null; fixIdentifier?: string | null; note: string }>;
  overallAssessment?: string;
}

const MAX_MEAN_RESIDUAL_PX = 45;

export function georeferencePage(page: PageAsset, pir: ProcedurePIR): GeoreferenceResult {
  const scale = (page.quality.renderDpi || 200) / 72; // textSpans 为 72dpi 页面坐标，渲染图为 renderDpi
  const points: Array<{ lon: number; lat: number; px: number; py: number }> = [];
  for (const fix of pir.fixes) {
    if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) continue;
    const ident = fix.identifier.toUpperCase();
    if (ident.length < 3) continue;
    const span = page.textSpans.find((s) => s.text.trim().toUpperCase() === ident);
    if (!span) continue;
    points.push({ lon: fix.longitude!, lat: fix.latitude!, px: ((span.bbox[0] + span.bbox[2]) / 2) * scale, py: ((span.bbox[1] + span.bbox[3]) / 2) * scale });
  }
  if (points.length < 3) return { ok: false, reason: `Only ${points.length} control points (need ≥3).`, controlPoints: points.length };
  // 共线检查：控制点张成面积过小则拒绝
  const area = polygonSpread(points);
  if (area < 1e-6) return { ok: false, reason: 'Control points are collinear.', controlPoints: points.length };
  const transform = solveAffine(points);
  if (!transform) return { ok: false, reason: 'Affine solve failed.', controlPoints: points.length };
  const residuals = points.map((p) => { const [px, py] = applyAffine(transform, p.lon, p.lat); return Math.hypot(px - p.px, py - p.py); });
  const mean = residuals.reduce((s, v) => s + v, 0) / residuals.length;
  if (mean > MAX_MEAN_RESIDUAL_PX) return { ok: false, reason: `Mean residual ${mean.toFixed(1)}px exceeds ${MAX_MEAN_RESIDUAL_PX}px.`, controlPoints: points.length, meanResidualPx: mean };
  return { ok: true, controlPoints: points.length, meanResidualPx: mean, transform };
}

export function applyAffine(t: AffineTransform, lon: number, lat: number): [number, number] {
  return [t.a * lon + t.b * lat + t.c, t.d * lon + t.e * lat + t.f];
}

function solveAffine(points: Array<{ lon: number; lat: number; px: number; py: number }>): AffineTransform | undefined {
  // 最小二乘：[lon lat 1] * [a d; b e; c f] = [px py]
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = points.length;
  let sxpx = 0, sypx = 0, spx = 0, sxpy = 0, sypy = 0, spy = 0;
  for (const p of points) {
    sxx += p.lon * p.lon; sxy += p.lon * p.lat; sx += p.lon; syy += p.lat * p.lat; sy += p.lat;
    sxpx += p.lon * p.px; sypx += p.lat * p.px; spx += p.px;
    sxpy += p.lon * p.py; sypy += p.lat * p.py; spy += p.py;
  }
  const m = [ [sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n] ];
  const solve = (rhs: number[]) => gauss3(m.map((row) => [...row]), [...rhs]);
  const x1 = solve([sxpx, sypx, spx]);
  const x2 = solve([sxpy, sypy, spy]);
  if (!x1 || !x2) return undefined;
  return { a: x1[0], b: x1[1], c: x1[2], d: x2[0], e: x2[1], f: x2[2] };
}
function gauss3(m: number[][], v: number[]): number[] | undefined {
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < 1e-12) return undefined;
    [m[col], m[pivot]] = [m[pivot], m[col]]; [v[col], v[pivot]] = [v[pivot], v[col]];
    for (let row = col + 1; row < 3; row++) { const k = m[row][col] / m[col][col]; for (let c = col; c < 3; c++) m[row][c] -= k * m[col][c]; v[row] -= k * v[col]; }
  }
  const x = [0, 0, 0];
  for (let row = 2; row >= 0; row--) { let s = v[row]; for (let c = row + 1; c < 3; c++) s -= m[row][c] * x[c]; x[row] = s / m[row][row]; }
  return x;
}
function polygonSpread(points: Array<{ lon: number; lat: number }>) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of points) { minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); }
  return (maxLon - minLon) * (maxLat - minLat);
}

export async function renderOverlay(page: PageAsset, geojson: any, transform: AffineTransform, outFile: string): Promise<string> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(page.renderedImagePath);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  ctx.lineWidth = Math.max(3, image.width / 500);
  const colorByRoute: Record<string, string> = {};
  const palette = ['#ff00cc', '#ff3300', '#9900ff', '#0066ff', '#00b36b'];
  let colorIndex = 0;
  for (const feature of geojson.features || []) {
    const props = feature.properties || {};
    if (props.featureType === 'LEG' && feature.geometry) {
      const routeId = props.routeId || 'r';
      colorByRoute[routeId] ||= palette[colorIndex++ % palette.length];
      ctx.strokeStyle = colorByRoute[routeId];
      ctx.setLineDash(props.routeType === 'MISSED_APPROACH' ? [12, 8] : []);
      for (const line of linesOf(feature.geometry)) {
        ctx.beginPath();
        line.forEach(([lon, lat]: [number, number], i: number) => { const [x, y] = applyAffine(transform, lon, lat); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        ctx.stroke();
      }
    }
    if (props.featureType === 'FIX' && feature.geometry) {
      const [x, y] = applyAffine(transform, feature.geometry.coordinates[0], feature.geometry.coordinates[1]);
      ctx.fillStyle = '#ff00cc';
      ctx.beginPath(); ctx.arc(x, y, Math.max(5, image.width / 400), 0, Math.PI * 2); ctx.fill();
      ctx.font = `${Math.max(16, image.width / 90)}px sans-serif`;
      ctx.fillText(String(props.identifier || ''), x + 8, y - 8);
    }
  }
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, canvas.toBuffer('image/png'));
  return outFile;
}
function linesOf(geometry: any): [number, number][][] {
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/** 叠加 + 视觉复核；控制点不足时明确 NOT_GEOREFERENCED。 */
export async function verifyAgainstSourceChart(
  task: AgentTask,
  procedureId: string,
  pir: ProcedurePIR,
  geojson: any,
  chartPage: PageAsset,
  signal: AbortSignal,
): Promise<OverlayVerification> {
  const georeference = georeferencePage(chartPage, pir);
  if (!georeference.ok) return { status: 'NOT_GEOREFERENCED', georeference, deviations: [] };
  const overlayPath = path.join(taskDir(task.taskId), 'procedures', procedureId, `overlay-p${chartPage.pageNumber}.png`);
  await renderOverlay(chartPage, geojson, georeference.transform!, overlayPath);
  const [original, overlay] = await Promise.all([
    fs.readFile(chartPage.renderedImagePath),
    fs.readFile(overlayPath),
  ]);
  try {
    const { parsed } = await callModel(task, 'chart-overlay-verifier', {
      procedure: { name: pir.procedure.name, category: pir.procedure.category, runways: pir.procedure.runways },
      trackSummary: {
        routes: pir.routes.map((r) => ({ routeId: r.routeId, routeType: r.routeType, identifier: r.identifier, legIds: r.legIds })),
        legs: pir.legs.map((l) => ({ legId: l.legId, sequence: l.sequence, pathTerminator: l.pathTerminator, from: l.fromFixId, to: l.toFixId, turn: l.turnDirection })),
        fixes: pir.fixes.filter((f) => f.latitude != null).map((f) => f.identifier),
      },
    }, [
      { pageNo: chartPage.pageNumber, dataUrl: `data:image/png;base64,${original.toString('base64')}` },
      { pageNo: chartPage.pageNumber, dataUrl: `data:image/png;base64,${overlay.toString('base64')}` },
    ], `PLAN:VALIDATE_AGAINST_SOURCE_CHART:${procedureId.slice(0, 8)}`, signal, { procedureId, planAction: 'VALIDATE_AGAINST_SOURCE_CHART' });
    return {
      status: parsed.overallAssessment === 'NOT_COMPARABLE' ? 'NOT_COMPARABLE' : 'VERIFIED',
      georeference,
      overlayImagePath: overlayPath,
      deviations: parsed.deviations || [],
      overallAssessment: parsed.overallAssessment,
    };
  } catch (error) {
    return { status: 'FAILED', georeference, overlayImagePath: overlayPath, deviations: [], overallAssessment: error instanceof Error ? error.message : String(error) };
  }
}

export function deviationsToValidations(verification: OverlayVerification): ValidationResult[] {
  if (verification.status === 'NOT_GEOREFERENCED') {
    return [{ ruleCode: 'CHART_OVERLAY_NOT_GEOREFERENCED', severity: 'INFO', fieldPath: '', message: `Chart overlay skipped: ${verification.georeference.reason}`, evidence: [], autoRepairable: false }];
  }
  return verification.deviations.map((d) => ({
    ruleCode: `CHART_OVERLAY_${d.kind}`,
    severity: d.severity,
    fieldPath: d.legId ? `legs[legId=${d.legId}]` : d.fixIdentifier ? `fixes[identifier=${d.fixIdentifier}]` : '',
    message: d.note,
    evidence: [],
    autoRepairable: d.kind === 'MISSING_LEG' || d.kind === 'MISSING_BRANCH' || d.kind === 'WRONG_TURN',
  }));
}
