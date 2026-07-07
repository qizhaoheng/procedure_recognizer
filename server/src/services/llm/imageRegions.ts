import type { AiImageQuality, AiImageRegion, PdfPageAsset } from '../../types/procedure';

export interface RegionCrop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  scaleBoost: number;
  label: string;
}

// Fractions of the rendered page (0-1). Heuristic layout for AIP AD chart pages:
// header strip on top, main chart body in the middle, notes near the bottom.
export const REGION_CROPS: Record<AiImageRegion, RegionCrop> = {
  full_page: { x0: 0, y0: 0, x1: 1, y1: 1, scaleBoost: 1, label: '整页' },
  header: { x0: 0, y0: 0, x1: 1, y1: 0.16, scaleBoost: 1.5, label: '页头' },
  main_chart: { x0: 0, y0: 0.08, x1: 1, y1: 0.9, scaleBoost: 1.6, label: '主图区' },
  table: { x0: 0, y0: 0, x1: 1, y1: 1, scaleBoost: 1, label: '表格' },
  notes: { x0: 0, y0: 0.76, x1: 1, y1: 1, scaleBoost: 1.5, label: '备注区' },
  msa: { x0: 0.5, y0: 0, x1: 1, y1: 0.35, scaleBoost: 1.5, label: 'MSA' },
  profile: { x0: 0, y0: 0.6, x1: 1, y1: 0.92, scaleBoost: 1.5, label: '剖面' },
  minima: { x0: 0, y0: 0.7, x1: 1, y1: 1, scaleBoost: 1.5, label: '最低标准' },
};

export const HIGH_RES_MIN_WIDTH_PX = 1600;
export const RECOMMENDED_RENDER_SCALE = 3;
const DEFAULT_PAGE_WIDTH_PT = 595;
const DEFAULT_PAGE_HEIGHT_PT = 842;

export function baseRenderScale() {
  return Number(process.env.LLM_IMAGE_RENDER_SCALE || RECOMMENDED_RENDER_SCALE);
}

export function regionRenderScale(region: AiImageRegion = 'full_page') {
  return baseRenderScale() * REGION_CROPS[region].scaleBoost;
}

export function predictImageQuality(page: Pick<PdfPageAsset, 'sourceWidthPt' | 'sourceHeightPt'>, region: AiImageRegion = 'full_page'): AiImageQuality {
  const crop = REGION_CROPS[region];
  const scale = regionRenderScale(region);
  const widthPt = page.sourceWidthPt || DEFAULT_PAGE_WIDTH_PT;
  const heightPt = page.sourceHeightPt || DEFAULT_PAGE_HEIGHT_PT;
  const expectedWidthPx = Math.round(widthPt * scale * (crop.x1 - crop.x0));
  const expectedHeightPx = Math.round(heightPt * scale * (crop.y1 - crop.y0));
  const isHighRes = expectedWidthPx >= HIGH_RES_MIN_WIDTH_PX;
  return {
    expectedWidthPx,
    expectedHeightPx,
    renderScale: scale,
    format: 'png',
    isHighRes,
    isThumbnail: false,
    warning: isHighRes ? undefined : `当前图片分辨率（约 ${expectedWidthPx}px 宽）可能不足以识别航图小字，建议 renderScale >= ${RECOMMENDED_RENDER_SCALE}。`,
  };
}
