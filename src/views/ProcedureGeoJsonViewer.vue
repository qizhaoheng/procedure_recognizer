<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Loader2, RotateCcw, Upload } from 'lucide-vue-next';
import ProcedureLayerControl, { type LayerVisibility } from '../components/procedure/ProcedureLayerControl.vue';
import ProcedureLegend from '../components/procedure/ProcedureLegend.vue';
import ProcedureMap from '../components/procedure/ProcedureMap.vue';
import { getFeatureBounds, parseProcedureGeoJson, type ProcedureGeoJsonModel } from '../utils/procedureGeojsonParser';

const CACHE_KEY = 'procedure-geojson:last-data';
const CACHE_NAME_KEY = 'procedure-geojson:last-filename';

const emptyModel = parseProcedureGeoJson({ type: 'FeatureCollection', features: [] });
const model = ref<ProcedureGeoJsonModel>();
const loading = ref(false);
const error = ref('');
const fileName = ref('');
const fileInput = ref<HTMLInputElement>();
const resetCounter = ref(0);
const mapVersion = ref(0);
const uploadStatus = ref('等待上传 GeoJSON');

const activeModel = computed(() => model.value ?? emptyModel);
const hasData = computed(() => Boolean(model.value));

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
  labels: true,
  reviewOnly: false,
});

const featureSummary = computed(() => {
  if (!model.value) return '未加载 GeoJSON';
  const labelCount = model.value.spatialFeatures.filter((feature) => feature.properties.object_type === 'LabelPoint').length;
  const labelText = labelCount ? ` · ${labelCount} 个文字标签` : '';
  return `${model.value.spatialFeatures.length} 个空间对象 · ${model.value.semanticFeatures.length} 个非空间对象${labelText}`;
});

const boundsSummary = computed(() => {
  if (!model.value) return '无数据';
  const bounds = getFeatureBounds(model.value.spatialFeatures);
  if (!bounds) return '无空间几何';
  const [[west, south], [east, north]] = bounds;
  return `bbox ${west.toFixed(4)}, ${south.toFixed(4)} -> ${east.toFixed(4)}, ${north.toFixed(4)}`;
});

onMounted(() => {
  restoreCachedGeoJson();
});

function restoreCachedGeoJson() {
  const cachedText = localStorage.getItem(CACHE_KEY);
  const cachedName = localStorage.getItem(CACHE_NAME_KEY);
  if (!cachedText) return;

  try {
    loadGeoJsonText(cachedText, cachedName || 'cached.geojson', false);
    uploadStatus.value = `已从浏览器缓存恢复 ${fileName.value}`;
  } catch (restoreError) {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_NAME_KEY);
    error.value = restoreError instanceof Error ? restoreError.message : '缓存 GeoJSON 恢复失败';
    uploadStatus.value = '缓存恢复失败';
  }
}

function openFilePicker() {
  fileInput.value?.click();
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

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
  const geojson = JSON.parse(text);
  if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    throw new Error('文件不是有效的 GeoJSON FeatureCollection');
  }

  const parsed = parseProcedureGeoJson(geojson);
  if (!parsed.spatialFeatures.length) {
    throw new Error('GeoJSON 中没有可上图的空间 geometry');
  }

  model.value = parsed;
  fileName.value = name;
  error.value = '';
  resetCounter.value += 1;
  mapVersion.value += 1;

  if (shouldCache) {
    localStorage.setItem(CACHE_KEY, text);
    localStorage.setItem(CACHE_NAME_KEY, name);
  }
}

function resetView() {
  resetCounter.value += 1;
}

function clearData() {
  clearModelOnly();
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
        <p>上传 GeoJSON -> 看地图还原效果 -> 开关图层 -> 点击要素确认属性</p>
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

      <div class="file-chip" :class="{ empty: !hasData }">
        <strong>{{ fileName || '未加载 GeoJSON' }}</strong>
        <span v-if="loading" class="inline-status">
          <Loader2 :size="14" class="spin" aria-hidden="true" />
          {{ uploadStatus }}
        </span>
        <span v-else>{{ uploadStatus }}</span>
        <span>{{ featureSummary }}</span>
        <span>{{ boundsSummary }}</span>
        <small>刷新页面会自动恢复上一次上传的 GeoJSON；清空会删除缓存。</small>
      </div>

      <div v-if="!hasData && !loading && !error" class="empty-hint">
        <strong>地图已就绪</strong>
        <span>上传 GeoJSON 后显示程序图层；刷新会恢复上次上传的数据。</span>
      </div>

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
  grid-template-rows: 64px minmax(0, 1fr);
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
.file-chip,
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
  left: 14px;
  bottom: 14px;
  width: 288px;
  padding: 12px;
}

.file-chip {
  right: 14px;
  bottom: 14px;
  display: grid;
  gap: 3px;
  max-width: min(460px, calc(100vw - 340px));
  padding: 10px 12px;
  font-size: 12px;
}

.file-chip.empty {
  color: #64748b;
}

.file-chip strong {
  color: #172033;
  overflow-wrap: anywhere;
}

.file-chip span {
  color: #475569;
}

.file-chip small {
  color: #64748b;
}

.inline-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.empty-hint {
  top: 14px;
  right: 14px;
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
  right: 14px;
  max-width: 420px;
  padding: 10px 12px;
  font-size: 13px;
}

.toast.error {
  border-color: #fecaca;
  background: #fef2f2;
  color: #b91c1c;
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

  .file-chip {
    left: 14px;
    right: 14px;
    max-width: none;
  }
}
</style>
