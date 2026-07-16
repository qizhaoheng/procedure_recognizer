import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import type { NormalizedBbox } from '../contracts/index';

export interface DynamicCropResult {
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  bbox: NormalizedBbox;
  rotationDeg: 0 | 90 | 180 | 270;
}

export async function renderDynamicRegionCrop(
  imageUrl: string,
  bbox: NormalizedBbox,
  rotationDeg: 0 | 90 | 180 | 270 = 0,
  scale = 2,
): Promise<DynamicCropResult> {
  assertBbox(bbox);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error(`Invalid dynamic crop scale: ${scale}`);
  const source = await loadImage(await imageSource(imageUrl));
  const sourceX = Math.floor(source.width * bbox[0]);
  const sourceY = Math.floor(source.height * bbox[1]);
  const sourceWidth = Math.max(1, Math.ceil(source.width * (bbox[2] - bbox[0])));
  const sourceHeight = Math.max(1, Math.ceil(source.height * (bbox[3] - bbox[1])));
  const cropWidth = Math.min(4096, Math.max(1, Math.round(sourceWidth * scale)));
  const cropHeight = Math.min(4096, Math.max(1, Math.round(sourceHeight * scale)));
  const cropCanvas = createCanvas(cropWidth, cropHeight);
  const cropContext = cropCanvas.getContext('2d');
  cropContext.fillStyle = '#fff';
  cropContext.fillRect(0, 0, cropWidth, cropHeight);
  cropContext.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, cropWidth, cropHeight);

  const rotated = rotationDeg === 0 ? cropCanvas : rotateCanvas(cropCanvas, rotationDeg, createCanvas);
  return {
    dataUrl: `data:image/png;base64,${rotated.toBuffer('image/png').toString('base64')}`,
    widthPx: rotated.width,
    heightPx: rotated.height,
    bbox,
    rotationDeg,
  };
}

function rotateCanvas(
  source: Canvas,
  rotationDeg: 90 | 180 | 270,
  createCanvasFn: typeof createCanvas,
) {
  const swap = rotationDeg === 90 || rotationDeg === 270;
  const target = createCanvasFn(swap ? source.height : source.width, swap ? source.width : source.height);
  const context = target.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, target.width, target.height);
  context.translate(target.width / 2, target.height / 2);
  context.rotate((rotationDeg * Math.PI) / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return target;
}

function assertBbox(bbox: NormalizedBbox) {
  if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error(`Dynamic crop bbox must contain four normalized values: ${JSON.stringify(bbox)}`);
  }
  if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
    throw new Error(`Dynamic crop bbox has no positive area: ${JSON.stringify(bbox)}`);
  }
}

async function imageSource(imageUrl: string) {
  if (imageUrl.startsWith('data:')) return imageUrl;
  if (/^https?:\/\//i.test(imageUrl)) throw new Error('Dynamic region cropping requires a local task image or data URL.');
  const relative = imageUrl.replace(/^\/uploads\//, '');
  const dataRoot = path.resolve(process.cwd(), 'server', 'data');
  const filePath = path.resolve(dataRoot, relative);
  if (filePath !== dataRoot && !filePath.startsWith(`${dataRoot}${path.sep}`)) {
    throw new Error('Dynamic crop image path escapes server/data.');
  }
  return fs.readFile(filePath);
}
