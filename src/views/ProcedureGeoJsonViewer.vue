<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Download, Loader2, RotateCcw, Upload } from 'lucide-vue-next';
import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';
import ProcedureLayerControl, { type LayerVisibility } from '../components/procedure/ProcedureLayerControl.vue';
import ProcedureLegend from '../components/procedure/ProcedureLegend.vue';
import ProcedureMap from '../components/procedure/ProcedureMap.vue';
import { parseProcedureGeoJson, type ProcedureGeoJsonModel } from '../utils/procedureGeojsonParser';

const CACHE_KEY = 'procedure-geojson:last-data';
const CACHE_NAME_KEY = 'procedure-geojson:last-filename';
const DEFAULT_SAMPLE = '/data/WMKJ_STAR_RWY16_11DME_ARC_v3.geojson';

const route = useRoute();
const router = useRouter();
const emptyModel = parseProcedureGeoJson({ type: 'FeatureCollection', features: [] });
const model = ref<ProcedureGeoJsonModel>();
const loading = ref(false);
const error = ref('');
const fileName = ref('');
const fileInput = ref<HTMLInputElement>();
const resetCounter = ref(0);
const mapVersion = ref(0);
const taskGeoJson = ref<{ taskId: string; packageId: string }>();
const uploadStatus = ref('等待加载 GeoJSON');

const activeModel = computed(() => model.value ?? emptyModel);
const hasData = computed(() => Boolean(model.value));
const labelWarning = computed(() => {
  if (!model.value) return '';
  const hasLabelPoint = model.value.allFeatures.some((feature) => feature.properties.object_type === 'LabelPoint');
  return hasLabelPoint ? '' : '当前 GeoJSON 未包含 LabelPoint，文字标签无法完整显示。';
});

const layerVisibility = ref<LayerVisibility>({
  procedureTrack: true,
  procedureLeg: true,
  procedureFix: true,
  derivedFix: true,
  navaid: true,
  runway: true,
  dmeArc: true,
  radial: true,
  leadRadial: true,
  msaSector: true,
  directionArrows: true,
  tangentMarks: true,
  labels: true,
  reviewOnly: false,
});

const featureSummary = computed(() => {
  if (!model.value) return '未加载 GeoJSON';
  const labelCount = model.value.spatialFeatures.filter((feature) => feature.properties.object_type === 'LabelPoint').length;
  const labelText = labelCount ? ` · ${labelCount} 个文字标签` : '';
  return `${model.value.spatialFeatures.length} 个空间对象 · ${model.value.semanticFeatures.length} 个非空间对象${labelText}`;
});

onMounted(async () => {
  const taskId = String(route.query.taskId || '');
  const packageId = String(route.query.packageId || route.query.groupId || '');
  if (taskId && packageId) {
    await loadTaskGeoJson(taskId, packageId);
    return;
  }
  if (restoreCachedGeoJson()) return;
  await loadDefaultSample();
});

async function loadTaskGeoJson(taskId: string, packageId: string) {
  loading.value = true;
  error.value = '';
  taskGeoJson.value = { taskId, packageId };
  uploadStatus.value = '正在加载任务 GeoJSON';
  try {
    const response = await fetch(`/api/procedure-tasks/${encodeURIComponent(taskId)}/packages/${encodeURIComponent(packageId)}/geojson`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '任务 GeoJSON 加载失败');
    const geojson = await response.json();
    loadGeoJson(geojson, `${taskId}-${packageId}.geojson`, false);
    uploadStatus.value = '已从识别任务加载 GeoJSON';
  } catch (loadError) {
    clearModelOnly();
    error.value = loadError instanceof Error ? loadError.message : '任务 GeoJSON 加载失败';
    uploadStatus.value = '任务结果加载失败';
  } finally {
    loading.value = false;
  }
}

function backToRecognizer() {
  if (!taskGeoJson.value) return;
  router.push({
    path: '/pdf-procedure-recognizer',
    query: {
      taskId: taskGeoJson.value.taskId,
      packageId: taskGeoJson.value.packageId,
    },
  });
}

function downloadGeoJson() {
  if (taskGeoJson.value) {
    const anchor = document.createElement('a');
    anchor.href = `/api/procedure-tasks/${encodeURIComponent(taskGeoJson.value.taskId)}/packages/${encodeURIComponent(taskGeoJson.value.packageId)}/geojson/download`;
    anchor.download = '';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return;
  }
  if (!model.value?.raw) return;
  const blob = new Blob([JSON.stringify(model.value.raw, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName.value || 'procedure.geojson';
  anchor.click();
  URL.revokeObjectURL(url);
}

function restoreCachedGeoJson() {
  const cachedText = localStorage.getItem(CACHE_KEY);
  const cachedName = localStorage.getItem(CACHE_NAME_KEY);
  if (!cachedText) return false;

  try {
    loadGeoJsonText(cachedText, cachedName || 'cached.geojson', false);
    uploadStatus.value = `已从浏览器缓存恢复 ${fileName.value}`;
    return true;
  } catch (restoreError) {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_NAME_KEY);
    error.value = restoreError instanceof Error ? restoreError.message : '缓存 GeoJSON 恢复失败';
    uploadStatus.value = '缓存恢复失败';
    return false;
  }
}

async function loadDefaultSample() {
  loading.value = true;
  error.value = '';
  taskGeoJson.value = undefined;
  try {
    const response = await fetch(DEFAULT_SAMPLE);
    if (!response.ok) throw new Error('默认示例 GeoJSON 加载失败');
    loadGeoJson(await response.json(), 'WMKJ_STAR_RWY16_11DME_ARC_v3.geojson', false);
    uploadStatus.value = '已加载默认示例 GeoJSON';
  } catch (sampleError) {
    error.value = sampleError instanceof Error ? sampleError.message : '默认示例加载失败';
    uploadStatus.value = '等待上传 GeoJSON';
  } finally {
    loading.value = false;
  }
}

function openFilePicker() {
  fileInput.value?.click();
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  taskGeoJson.value = undefined;

  if (!file.name.toLowerCase().endsWith('.geojson') && !file.name.toLowerCase().endsWith('.json')) {
    error.value = '请选择 .geojson 或 .json 文件';
    input.value = '';
    return;
  }

  loading.value = true;
  error.value = '';
  uploadStatus.value = `正在读取 ${file.name}`;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = String(reader.result ?? '');
      loadGeoJsonText(text, file.name, true);
      uploadStatus.value = `已加载 ${file.name}`;
    } catch (parseError) {
      clearModelOnly();
      error.value = parseError instanceof Error ? parseError.message : 'GeoJSON 解析失败';
      uploadStatus.value = '上传失败';
    } finally {
      loading.value = false;
      input.value = '';
    }
  };
  reader.onerror = () => {
    clearModelOnly();
    error.value = '文件读取失败';
    uploadStatus.value = '上传失败';
    loading.value = false;
    input.value = '';
  };
  reader.readAsText(file, 'utf-8');
}

function loadGeoJsonText(text: string, name: string, shouldCache: boolean) {
  loadGeoJson(JSON.parse(text), name, shouldCache ? text : undefined);
}

function loadGeoJson(
  geojson: FeatureCollection<Geometry | null, GeoJsonProperties>,
  name: string,
  cacheTextOrFalse: string | false | undefined,
) {
  if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    throw new Error('文件不是有效的 GeoJSON FeatureCollection');
  }

  model.value = parseProcedureGeoJson(geojson);
  fileName.value = name;
  error.value = '';
  resetCounter.value += 1;
  mapVersion.value += 1;

  if (typeof cacheTextOrFalse === 'string') {
    localStorage.setItem(CACHE_KEY, cacheTextOrFalse);
    localStorage.setItem(CACHE_NAME_KEY, name);
  }
}

function resetView() {
  resetCounter.value += 1;
}

function clearData() {
  clearModelOnly();
  taskGeoJson.value = undefined;
  localStorage.removeItem(CACHE_KEY);
  localStorage.removeItem(CACHE_NAME_KEY);
  uploadStatus.value = '已清空，等待上传 GeoJSON';
  if (fileInput.value) fileInput.value.value = '';
}

function clearModelOnly() {
  model.value = undefined;
  fileName.value = '';
  error.value = '';
  loading.value = false;
  resetCounter.value += 1;
  mapVersion.value += 1;
}
</script>

<template>
  <main class="viewer">
    <header class="topbar">
      <div class="title">
        <h1>GeoJSON 程序图预览器</h1>
        <p>上传 GeoJSON，或从 PDF 程序识别任务加载结果，用地图校核点、线、弧和文字标签。</p>
        <p class="status-line">
          <Loader2 v-if="loading" :size="12" class="spin" aria-hidden="true" />
          <span>{{ fileName || '未加载 GeoJSON' }}</span>
          <span>{{ uploadStatus }}</span>
          <span v-if="hasData">{{ featureSummary }}</span>
        </p>
      </div>

      <div class="actions">
        <input
          ref="fileInput"
          class="file-input"
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          @change="onFileSelected"
        />
        <button type="button" class="primary" @click="openFilePicker">
          <Upload :size="16" aria-hidden="true" />
          上传 GeoJSON
        </button>
        <button v-if="taskGeoJson" type="button" @click="backToRecognizer">返回分组页</button>
        <button type="button" :disabled="!hasData" @click="downloadGeoJson">
          <Download :size="16" aria-hidden="true" />
          下载 GeoJSON
        </button>
        <button type="button" @click="resetView">
          <RotateCcw :size="16" aria-hidden="true" />
          重置视图
        </button>
        <button type="button" @click="clearData">清空</button>
      </div>
    </header>

    <section class="map-stage">
      <ProcedureMap
        :key="mapVersion"
        :model="activeModel"
        :layer-visibility="layerVisibility"
        :reset-counter="resetCounter"
      />

      <div class="floating-panel control-panel">
        <ProcedureLayerControl v-model="layerVisibility" />
      </div>

      <div class="floating-panel legend-panel">
        <ProcedureLegend />
      </div>

      <div v-if="!hasData && !loading && !error" class="empty-hint">
        <strong>地图已就绪</strong>
        <span>上传 GeoJSON 后显示程序图层；也可以从 PDF 识别流程跳转进来。</span>
      </div>

      <div v-if="labelWarning" class="toast warning">{{ labelWarning }}</div>
      <div v-if="error" class="toast error">{{ error }}</div>
    </section>
  </main>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  background: #e7edf4;
}

.viewer {
  display: grid;
  grid-template-rows: 78px minmax(0, 1fr);
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  color: #172033;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 10px 16px;
  border-bottom: 1px solid #d5dde8;
  background: #ffffff;
  z-index: 5;
}

.title {
  min-width: 0;
}

h1 {
  margin: 0;
  color: #111827;
  font-size: 19px;
  letter-spacing: 0;
}

p {
  margin: 4px 0 0;
  color: #64748b;
  font-size: 12px;
}

.status-line {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 5px;
  color: #64748b;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-line span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.file-input {
  display: none;
}

button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 34px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #ffffff;
  color: #263548;
  padding: 0 12px;
  font-size: 13px;
  cursor: pointer;
}

button.primary {
  border-color: #246bd6;
  background: #246bd6;
  color: #ffffff;
}

.map-stage {
  position: relative;
  min-height: 0;
}

.floating-panel,
.empty-hint,
.toast {
  position: absolute;
  z-index: 3;
  border: 1px solid rgba(203, 213, 225, 0.9);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 14px 34px rgba(15, 23, 42, 0.14);
}

.control-panel {
  top: 14px;
  left: 14px;
  width: 242px;
  padding: 12px;
}

.legend-panel {
  top: 14px;
  right: 14px;
  width: 288px;
  padding: 12px;
}

.empty-hint {
  top: 14px;
  right: 318px;
  display: grid;
  gap: 4px;
  max-width: 320px;
  padding: 12px;
  font-size: 12px;
}

.empty-hint strong {
  color: #172033;
  font-size: 14px;
}

.empty-hint span {
  color: #64748b;
  line-height: 1.5;
}

.toast {
  top: 14px;
  right: 318px;
  max-width: 420px;
  padding: 10px 12px;
  font-size: 13px;
}

.toast.error {
  border-color: #fecaca;
  background: #fef2f2;
  color: #b91c1c;
}

.toast.warning {
  border-color: #fed7aa;
  background: #fff7ed;
  color: #9a3412;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 860px) {
  .viewer {
    grid-template-rows: auto minmax(0, 1fr);
  }

  .topbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .actions {
    justify-content: flex-start;
  }

  .control-panel {
    width: 220px;
  }

  .legend-panel {
    width: 220px;
    max-height: 36vh;
    overflow: auto;
  }
}
</style>
