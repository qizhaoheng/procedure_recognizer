<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const props = defineProps<{
  taskId: string;
  pageNo: number;
  bbox?: [number, number, number, number];
  highlightTerms?: string[];
  sourceType?: string;
}>();

const documentCache = new Map<string, Promise<any>>();
const viewportHost = ref<HTMLElement>();
const stageElement = ref<HTMLElement>();
const canvas = ref<HTMLCanvasElement>();
const busy = ref(true);
const error = ref('');
const zoom = ref(1);
const pageWidth = ref(0);
const pageHeight = ref(0);
const locatedBbox = ref<[number, number, number, number]>();
const locatorMethod = ref('');
const dragging = ref(false);
let resizeObserver: ResizeObserver | undefined;
let renderTask: any;
let renderSerial = 0;
let zoomSerial = 0;
let resizeTimer: number | undefined;
let locatorSerial = 0;
let dragPointerId: number | undefined;
let dragStartX = 0;
let dragStartY = 0;
let dragStartScrollLeft = 0;
let dragStartScrollTop = 0;

const effectiveBbox = computed(() => props.bbox ?? locatedBbox.value);
const bboxStyle = computed(() => effectiveBbox.value ? {
  left: `${effectiveBbox.value[0] * 100}%`,
  top: `${effectiveBbox.value[1] * 100}%`,
  width: `${(effectiveBbox.value[2] - effectiveBbox.value[0]) * 100}%`,
  height: `${(effectiveBbox.value[3] - effectiveBbox.value[1]) * 100}%`,
} : undefined);
const stageStyle = computed(() => ({ width: `${pageWidth.value}px`, height: `${pageHeight.value}px` }));
const zoomLabel = computed(() => `${Math.round(zoom.value * 100)}%`);

function loadDocument(taskId: string) {
  let promise = documentCache.get(taskId);
  if (!promise) {
    promise = pdfjsLib.getDocument({ url: `/api/procedure-tasks/${encodeURIComponent(taskId)}/pdf` }).promise;
    documentCache.set(taskId, promise);
  }
  return promise;
}

function scrollToEvidence() {
  const host = viewportHost.value;
  const bbox = effectiveBbox.value;
  if (!host || !bbox || !pageWidth.value || !pageHeight.value) return;
  const centerX = ((bbox[0] + bbox[2]) / 2) * pageWidth.value;
  host.scrollLeft = Math.max(0, centerX - host.clientWidth / 2);
  host.scrollTop = Math.max(0, bbox[1] * pageHeight.value - 72);
}

async function renderPage() {
  const serial = ++renderSerial;
  renderTask?.cancel?.();
  await nextTick();
  if (!viewportHost.value || !canvas.value || viewportHost.value.clientWidth < 20) return;
  busy.value = true;
  error.value = '';
  try {
    const pdf = await loadDocument(props.taskId);
    const page = await pdf.getPage(props.pageNo);
    if (serial !== renderSerial || !viewportHost.value || !canvas.value) return;

    const baseViewport = page.getViewport({ scale: 1 });
    const fitWidth = Math.max(280, viewportHost.value.clientWidth - 2);
    const cssWidth = fitWidth * zoom.value;
    const cssScale = cssWidth / baseViewport.width;
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: cssScale * outputScale });
    const context = canvas.value.getContext('2d');
    if (!context) throw new Error('浏览器无法创建 PDF 画布。');

    pageWidth.value = Math.floor(cssWidth);
    pageHeight.value = Math.floor(baseViewport.height * cssScale);
    canvas.value.width = Math.floor(viewport.width);
    canvas.value.height = Math.floor(viewport.height);
    canvas.value.style.width = `${pageWidth.value}px`;
    canvas.value.style.height = `${pageHeight.value}px`;
    renderTask = page.render({ canvasContext: context, viewport });
    await renderTask.promise;
  } catch (value: any) {
    if (value?.name !== 'RenderingCancelledException') error.value = value instanceof Error ? value.message : 'PDF 原页渲染失败。';
  } finally {
    if (serial === renderSerial) busy.value = false;
  }
}

async function resolveEvidenceLocation() {
  const serial = ++locatorSerial;
  locatedBbox.value = undefined;
  locatorMethod.value = '';
  if (props.bbox || !props.highlightTerms?.length) {
    await nextTick();
    scrollToEvidence();
    return;
  }
  const params = new URLSearchParams();
  for (const term of props.highlightTerms.slice(0, 12)) if (term.trim()) params.append('term', term.trim());
  if (props.sourceType) params.set('sourceType', props.sourceType);
  if (!params.size) return;
  try {
    const response = await fetch(`/api/procedure-tasks/${encodeURIComponent(props.taskId)}/pages/${props.pageNo}/evidence-location?${params}`);
    if (!response.ok) return;
    const result = await response.json() as { bbox?: number[]; method?: string };
    if (serial !== locatorSerial || !Array.isArray(result.bbox) || result.bbox.length !== 4) return;
    if (result.bbox.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
      locatedBbox.value = result.bbox as [number, number, number, number];
      locatorMethod.value = result.method ?? 'OCR_WORD_LINE';
      await nextTick();
      scrollToEvidence();
    }
  } catch {
    // Missing localization keeps the full page visible and never invents a box.
  }
}

async function refreshPageAndLocation() {
  await Promise.all([renderPage(), resolveEvidenceLocation()]);
  await nextTick();
  scrollToEvidence();
}

function scheduleRender() {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => void renderPage(), 120);
}

async function setZoom(nextZoom: number, anchor?: { x: number; y: number }) {
  const serial = ++zoomSerial;
  const host = viewportHost.value;
  const stage = stageElement.value;
  const anchorX = anchor?.x ?? (host?.clientWidth ?? 0) / 2;
  const anchorY = anchor?.y ?? (host?.clientHeight ?? 0) / 2;
  const pageX = host && stage ? (host.scrollLeft + anchorX - stage.offsetLeft) / Math.max(pageWidth.value, 1) : 0.5;
  const pageY = host && stage ? (host.scrollTop + anchorY - stage.offsetTop) / Math.max(pageHeight.value, 1) : 0.5;
  zoom.value = Math.min(4, Math.max(0.5, nextZoom));
  await renderPage();
  await nextTick();
  if (serial !== zoomSerial) return;
  if (host && stageElement.value) {
    host.scrollLeft = Math.max(0, Math.min(1, pageX) * pageWidth.value + stageElement.value.offsetLeft - anchorX);
    host.scrollTop = Math.max(0, Math.min(1, pageY) * pageHeight.value + stageElement.value.offsetTop - anchorY);
  }
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  const host = viewportHost.value;
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? host.clientHeight : 1;
  const factor = Math.exp(-event.deltaY * unit * 0.0015);
  void setZoom(zoom.value * factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
}

function onPointerDown(event: PointerEvent) {
  const host = viewportHost.value;
  if (!host || event.button !== 0) return;
  dragPointerId = event.pointerId;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  dragStartScrollLeft = host.scrollLeft;
  dragStartScrollTop = host.scrollTop;
  dragging.value = true;
  host.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent) {
  const host = viewportHost.value;
  if (!host || dragPointerId !== event.pointerId) return;
  host.scrollLeft = dragStartScrollLeft - (event.clientX - dragStartX);
  host.scrollTop = dragStartScrollTop - (event.clientY - dragStartY);
}

function onPointerEnd(event: PointerEvent) {
  const host = viewportHost.value;
  if (!host || dragPointerId !== event.pointerId) return;
  if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
  dragPointerId = undefined;
  dragging.value = false;
}

onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleRender);
  if (viewportHost.value) resizeObserver.observe(viewportHost.value);
  void refreshPageAndLocation();
});

watch(() => [props.taskId, props.pageNo], () => void refreshPageAndLocation());
watch(() => props.bbox, () => void resolveEvidenceLocation(), { deep: true });
watch(() => props.highlightTerms?.join('\u0000'), () => void resolveEvidenceLocation());
watch(() => props.sourceType, () => void resolveEvidenceLocation());

onBeforeUnmount(() => {
  renderSerial += 1;
  zoomSerial += 1;
  locatorSerial += 1;
  dragging.value = false;
  renderTask?.cancel?.();
  resizeObserver?.disconnect();
  if (resizeTimer) window.clearTimeout(resizeTimer);
});
</script>

<template>
  <div class="pdf-evidence-viewer">
    <div class="pdf-evidence-toolbar">
      <button type="button" aria-label="缩小 PDF 原图" :disabled="zoom <= 0.5" @click="setZoom(zoom / 1.25)">−</button>
      <span>{{ zoomLabel }}</span>
      <button type="button" aria-label="放大 PDF 原图" :disabled="zoom >= 4" @click="setZoom(zoom * 1.25)">＋</button>
      <button type="button" aria-label="PDF 原图适配宽度" @click="setZoom(1)">适配宽度</button>
      <small class="interaction-hint">滚轮缩放 · 拖拽平移</small>
      <em :class="{ located: effectiveBbox }">{{ effectiveBbox ? (bbox ? '证据原始框' : 'OCR 行定位') : '无精确框' }}</em>
    </div>
    <div ref="viewportHost" :class="['pdf-evidence-scroll', { dragging }]" @wheel="onWheel" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerEnd" @pointercancel="onPointerEnd">
      <div ref="stageElement" class="pdf-evidence-stage" :style="stageStyle">
        <canvas ref="canvas" :aria-label="`原 PDF 第 ${pageNo} 页`"></canvas>
        <span v-if="effectiveBbox" class="pdf-evidence-bbox" :data-locator-method="locatorMethod || 'EVIDENCE_BBOX'" :style="bboxStyle"></span>
        <div v-if="busy" class="pdf-evidence-state">正在读取原 PDF 第 {{ pageNo }} 页…</div>
        <div v-if="error" class="pdf-evidence-state error">{{ error }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pdf-evidence-viewer { display: grid; grid-template-rows: auto minmax(260px, 1fr); width: 100%; min-height: 320px; background: #e2e8f0; }
.pdf-evidence-toolbar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid #cbd5e1; background: rgb(248 250 252 / 96%); }
.pdf-evidence-toolbar button { min-height: 28px; padding: 3px 9px; background: #fff; color: #334155; font-size: 11px; }
.pdf-evidence-toolbar span { min-width: 42px; color: #334155; font-weight: 700; text-align: center; }
.interaction-hint { color: #64748b; font-size: 10px; white-space: nowrap; }
.pdf-evidence-toolbar em { margin-left: auto; color: #b45309; font-size: 10px; font-style: normal; }.pdf-evidence-toolbar em.located { color: #15803d; }
.pdf-evidence-scroll { position: relative; max-height: min(560px, 50vh); overflow: auto; overscroll-behavior: contain; background: #cbd5e1; cursor: grab; touch-action: none; user-select: none; }.pdf-evidence-scroll.dragging { cursor: grabbing; }
.pdf-evidence-stage { position: relative; margin: 0 auto; background: #fff; box-shadow: 0 5px 16px rgb(15 23 42 / 18%); }
canvas { display: block; background: #fff; }
.pdf-evidence-bbox { position: absolute; z-index: 2; border: 3px solid #ef4444; background: rgb(239 68 68 / 12%); box-shadow: 0 0 0 1px #fff, 0 0 10px rgb(239 68 68 / 45%); pointer-events: none; }
.pdf-evidence-state { position: absolute; inset: 0; display: grid; place-items: center; z-index: 4; padding: 18px; background: rgb(248 250 252 / 88%); color: #64748b; text-align: center; }
.pdf-evidence-state.error { color: #b91c1c; }
</style>
