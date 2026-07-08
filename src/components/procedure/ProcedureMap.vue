<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch, ref } from 'vue';
import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type Map } from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { LayerVisibility } from './ProcedureLayerControl.vue';
import {
  buildArrowFeatures,
  buildLabelFeatures,
  buildTangentFeatures,
  getFeatureBounds,
  type ProcedureFeature,
  type ProcedureGeoJsonModel,
} from '../../utils/procedureGeojsonParser';

const props = defineProps<{
  model: ProcedureGeoJsonModel;
  layerVisibility: LayerVisibility;
  resetCounter: number;
}>();

const container = ref<HTMLDivElement>();
let map: Map | undefined;

const sourceId = 'procedureGeoJson';
const labelSourceId = 'labelSource';
const arrowSourceId = 'arrowSource';
const tangentSourceId = 'tangentSource';

const layerMap: Record<keyof LayerVisibility, string[]> = {
  procedureTrack: ['procedure-track'],
  procedureLeg: ['procedure-leg'],
  procedureFix: ['procedure-fix'],
  derivedFix: ['derived-fix'],
  navaid: ['navaid'],
  runway: ['runway-line', 'runway-point'],
  dmeArc: ['dme-reference-circle', 'chart-label-point'],
  radial: ['radial-reference'],
  leadRadial: ['lead-radial', 'lead-radial-arrow-layer'],
  msaSector: ['msa-fill', 'msa-outline'],
  directionArrows: ['direction-arrow-layer'],
  tangentMarks: ['tangent-mark-layer'],
  labels: ['planned-label-layer', 'text-label-layer'],
  reviewOnly: [],
};

const popupLayers = [
  'navaid',
  'derived-fix',
  'procedure-fix',
  'procedure-leg',
  'direction-arrow-layer',
  'procedure-track',
  'lead-radial',
  'radial-reference',
  'dme-reference-circle',
  'runway-line',
  'runway-point',
  'msa-fill',
  'chart-label-point',
];

onMounted(() => {
  if (!container.value) return;

  map = new maplibregl.Map({
    container: container.value,
    style: {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        terrainBase: {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          maxzoom: 19,
          attribution: 'Esri, Garmin, FAO, NOAA, USGS, OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'terrain-base', type: 'raster', source: 'terrainBase', paint: { 'raster-opacity': 0.64 } }],
    },
    center: [103.67, 1.64],
    zoom: 8,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-right');
  map.on('load', () => {
    addDirectionArrowImage();
    addTangentMarkImage();
    addSourcesAndLayers();
    updateMapData();
    fitToCurrentData();
    bindPopup();
  });
});

onBeforeUnmount(() => {
  map?.remove();
  map = undefined;
});

watch(
  () => props.model,
  () => {
    updateMapData();
    fitToCurrentData();
  },
);

watch(
  () => props.layerVisibility,
  () => {
    updateLayerVisibility();
    updateReviewFilters();
  },
  { deep: true },
);

watch(
  () => props.resetCounter,
  () => fitToCurrentData(),
);

function addSourcesAndLayers() {
  if (!map) return;

  map.addSource(sourceId, emptyCollection());
  map.addSource(labelSourceId, emptyCollection());
  map.addSource(arrowSourceId, emptyCollection());
  map.addSource(tangentSourceId, emptyCollection());

  addLayer({
    id: 'msa-fill',
    type: 'fill',
    source: sourceId,
    filter: typedFilter('MSASector'),
    paint: { 'fill-color': '#78909c', 'fill-opacity': 0.08 },
  });
  addLayer({
    id: 'msa-outline',
    type: 'line',
    source: sourceId,
    filter: typedFilter('MSASector'),
    paint: { 'line-color': '#6b7280', 'line-width': 1, 'line-dasharray': [2, 2] },
  });
  addLayer({
    id: 'dme-reference-circle',
    type: 'line',
    source: sourceId,
    filter: typedFilter('DMEReferenceCircle'),
    paint: { 'line-color': '#69717e', 'line-width': 2, 'line-dasharray': [2, 2] },
  });
  addLayer({
    id: 'radial-reference',
    type: 'line',
    source: sourceId,
    filter: typedFilter('RadialReference'),
    paint: {
      'line-color': ['case', ['==', ['get', 'ident'], 'RDL340 VJB'], '#d22d37', '#566071'],
      'line-width': ['case', ['==', ['get', 'ident'], 'RDL340 VJB'], 2.8, 1.3],
      'line-opacity': ['case', ['==', ['get', 'ident'], 'RDL340 VJB'], 0.9, 0.58],
      'line-dasharray': [4, 3],
    },
  });
  addLayer({
    id: 'lead-radial',
    type: 'line',
    source: sourceId,
    filter: typedFilter('LeadRadial'),
    paint: { 'line-color': '#f97316', 'line-width': 3, 'line-opacity': 0.88, 'line-dasharray': [3, 2] },
  });
  addLayer({
    id: 'runway-line',
    type: 'line',
    source: sourceId,
    filter: typedFilter('Runway'),
    paint: { 'line-color': '#111827', 'line-width': 5 },
  });
  addLayer({
    id: 'procedure-track',
    type: 'line',
    source: sourceId,
    filter: typedFilter('ProcedureTrack'),
    paint: {
      'line-color': [
        'match',
        ['get', 'procedure'],
        'ADLOV 1G',
        '#246bd6',
        'EMTUV 1G',
        '#8b4fd1',
        'OMKOM 1G',
        '#168a54',
        'PIMOK 1G',
        '#c2410c',
        '#315b87',
      ],
      'line-width': 2.2,
      'line-opacity': 0.42,
    },
  });
  addLayer({
    id: 'procedure-leg',
    type: 'line',
    source: sourceId,
    filter: typedFilter('ProcedureLeg'),
    paint: {
      'line-color': [
        'match',
        ['get', 'leg_type'],
        'TRACK_TO_DME_FIX',
        '#246bd6',
        'TURN_TO_DME_ARC',
        '#8b4fd1',
        'DME_ARC',
        '#168a54',
        'LEAD_RADIAL_EXIT_TURN',
        '#f06c2f',
        'FINAL_COMMON_SEGMENT',
        '#d22d37',
        '#315b87',
      ],
      'line-width': 4,
      'line-opacity': 0.92,
    },
  });
  addLayer({
    id: 'direction-arrow-layer',
    type: 'symbol',
    source: arrowSourceId,
    filter: ['!=', ['get', 'arrow_type'], 'LeadRadial'],
    layout: {
      'icon-image': 'direction-arrow',
      'icon-size': [
        'match',
        ['get', 'arrow_type'],
        'InboundTo13D',
        0.72,
        'EntryTurn',
        0.66,
        'ExitTurn',
        0.66,
        'FinalCommon',
        0.7,
        'LeadTurn',
        0.34,
        0.62,
      ],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  addLayer({
    id: 'lead-radial-arrow-layer',
    type: 'symbol',
    source: arrowSourceId,
    filter: ['==', ['get', 'arrow_type'], 'LeadRadial'],
    layout: {
      'icon-image': 'direction-arrow',
      'icon-size': 0.32,
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  addLayer({
    id: 'tangent-mark-layer',
    type: 'symbol',
    source: tangentSourceId,
    layout: {
      'icon-image': 'tangent-mark',
      'icon-size': 1,
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  addLayer({
    id: 'procedure-fix',
    type: 'circle',
    source: sourceId,
    filter: typedFilter('ProcedureFix'),
    paint: {
      'circle-radius': 5.5,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#246bd6',
      'circle-stroke-width': 2,
    },
  });
  addLayer({
    id: 'derived-fix',
    type: 'circle',
    source: sourceId,
    filter: inTypeFilter(['DerivedFix', 'LeadRadialPoint']),
    paint: {
      'circle-radius': 5,
      'circle-color': '#facc15',
      'circle-stroke-color': '#92400e',
      'circle-stroke-width': 1.5,
    },
  });
  addLayer({
    id: 'navaid',
    type: 'circle',
    source: sourceId,
    filter: typedFilter('Navaid'),
    paint: {
      'circle-radius': 7,
      'circle-color': '#1e40af',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });
  addLayer({
    id: 'runway-point',
    type: 'circle',
    source: sourceId,
    filter: inTypeFilter(['RunwayThreshold', 'RunwayEnd']),
    paint: {
      'circle-radius': 4,
      'circle-color': '#111827',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  });
  addLayer({
    id: 'chart-label-point',
    type: 'circle',
    source: sourceId,
    filter: typedFilter('ChartLabel'),
    paint: {
      'circle-radius': 3,
      'circle-color': '#64748b',
      'circle-opacity': 0.5,
    },
  });
  const labelTextSize = [
    'match',
    ['get', 'label_type'],
    'Navaid',
    13,
    'NavaidLabel',
    13,
    'ProcedureFix',
    12,
    'ProcedureFixLabel',
    12,
    'ProcedureCourse',
    12,
    'ProcedureCourseLabel',
    12,
    'ProcedureName',
    12,
    'LeadRadial',
    12,
    'LeadRadialLabel',
    12,
    'LeadRadialPointLabel',
    11,
    'DMEArc',
    12,
    'ChartLabel',
    12,
    'Radial',
    11,
    'RadialLabel',
    11,
    'DerivedFix',
    11,
    'DerivedFixLabel',
    11,
    'EntryTurnLabel',
    11,
    'ExitTurnLabel',
    11,
    'RunwayPointLabel',
    11,
    11,
  ];
  const labelTextPaint = {
    'text-color': [
      'match',
      ['get', 'label_type'],
      'Navaid',
      '#1e40af',
      'NavaidLabel',
      '#1e40af',
      'ProcedureFix',
      '#1d4ed8',
      'ProcedureFixLabel',
      '#1d4ed8',
      'ProcedureCourse',
      '#b91c1c',
      'ProcedureCourseLabel',
      '#b91c1c',
      'ProcedureName',
      '#9333ea',
      'LeadRadial',
      '#c2410c',
      'LeadRadialLabel',
      '#c2410c',
      'LeadRadialPointLabel',
      '#c2410c',
      'DMEArc',
      '#166534',
      'ChartLabel',
      '#166534',
      'Radial',
      '#475569',
      'RadialLabel',
      '#475569',
      'DerivedFix',
      '#92400e',
      'DerivedFixLabel',
      '#92400e',
      'EntryTurnLabel',
      '#7e22ce',
      'ExitTurnLabel',
      '#c2410c',
      'RunwayPointLabel',
      '#111827',
      '#1f2937',
    ],
    'text-halo-color': '#ffffff',
    'text-halo-width': 1.5,
    'text-halo-blur': 0.5,
  };

  // 识别阶段规划的标签：定位/偏移由服务端按制图规则给定，位置权威；
  // 高优先级先占位，冲突的低优先级标签在低缩放级别自动让位。
  addLayer({
    id: 'planned-label-layer',
    type: 'symbol',
    source: labelSourceId,
    filter: plannedLabelFilter(true),
    layout: {
      'text-field': ['get', 'label_text'],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': labelTextSize,
      'text-anchor': ['coalesce', ['get', 'text_anchor'], 'center'],
      'text-offset': ['coalesce', ['get', 'text_offset'], ['literal', [0, 0]]],
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'symbol-sort-key': ['-', 100, ['get', 'priority']],
    },
    paint: labelTextPaint,
  });
  // 启发式兜底标签：仅覆盖没有规划标签的要素，开启碰撞检测并允许换锚位避让
  addLayer({
    id: 'text-label-layer',
    type: 'symbol',
    source: labelSourceId,
    filter: plannedLabelFilter(false),
    layout: {
      'text-field': ['get', 'label_text'],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': labelTextSize,
      'text-anchor': ['coalesce', ['get', 'text_anchor'], 'top'],
      'text-offset': ['coalesce', ['get', 'text_offset'], ['literal', [0, 0.8]]],
      'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
      'text-radial-offset': 0.6,
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'symbol-sort-key': ['-', 100, ['get', 'priority']],
    },
    paint: labelTextPaint,
  });

  updateLayerVisibility();
  updateReviewFilters();
}

function updateMapData() {
  if (!map?.getSource(sourceId)) return;

  const spatialCollection: FeatureCollection<Geometry> = {
    type: 'FeatureCollection',
    features: props.model.spatialFeatures as Feature<Geometry>[],
  };
  const labelCollection = buildLabelFeatures(props.model.spatialFeatures);
  const arrowCollection = buildArrowFeatures(props.model.spatialFeatures);
  const tangentCollection = buildTangentFeatures(props.model.spatialFeatures);
  (map.getSource(sourceId) as GeoJSONSource).setData(spatialCollection);
  (map.getSource(labelSourceId) as GeoJSONSource).setData(labelCollection);
  (map.getSource(arrowSourceId) as GeoJSONSource).setData(arrowCollection);
  (map.getSource(tangentSourceId) as GeoJSONSource).setData(tangentCollection);
  updateReviewFilters();
}

function updateLayerVisibility() {
  if (!map) return;
  Object.entries(layerMap).forEach(([key, layers]) => {
    const visibility = props.layerVisibility[key as keyof LayerVisibility] ? 'visible' : 'none';
    layers.forEach((layer) => {
      if (map?.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', visibility);
    });
  });
}

function updateReviewFilters() {
  if (!map?.getSource(sourceId)) return;
  const reviewOnly = props.layerVisibility.reviewOnly;
  const sourceLayerFilters: Record<string, unknown[]> = {
    'msa-fill': typedFilter('MSASector'),
    'msa-outline': typedFilter('MSASector'),
    'dme-reference-circle': typedFilter('DMEReferenceCircle'),
    'radial-reference': typedFilter('RadialReference'),
    'lead-radial': typedFilter('LeadRadial'),
    'runway-line': typedFilter('Runway'),
    'procedure-track': typedFilter('ProcedureTrack'),
    'procedure-leg': typedFilter('ProcedureLeg'),
    'procedure-fix': typedFilter('ProcedureFix'),
    'derived-fix': inTypeFilter(['DerivedFix', 'LeadRadialPoint']),
    navaid: typedFilter('Navaid'),
    'runway-point': inTypeFilter(['RunwayThreshold', 'RunwayEnd']),
    'chart-label-point': typedFilter('ChartLabel'),
  };

  Object.entries(sourceLayerFilters).forEach(([layer, filter]) => {
    if (!map?.getLayer(layer)) return;
    map.setFilter(layer, withReviewFilter(filter, reviewOnly) as never);
  });

  if (map.getLayer('planned-label-layer')) {
    map.setFilter(
      'planned-label-layer',
      (reviewOnly
        ? ['all', plannedLabelFilter(true), ['==', ['get', 'review_required'], true]]
        : plannedLabelFilter(true)) as never,
    );
  }
  if (map.getLayer('text-label-layer')) {
    map.setFilter(
      'text-label-layer',
      (reviewOnly
        ? ['all', plannedLabelFilter(false), ['==', ['get', 'review_required'], true]]
        : plannedLabelFilter(false)) as never,
    );
  }
  if (map.getLayer('direction-arrow-layer')) {
    map.setFilter(
      'direction-arrow-layer',
      reviewOnly
        ? (['all', ['!=', ['get', 'arrow_type'], 'LeadRadial'], ['==', ['get', 'review_required'], true]] as never)
        : (['!=', ['get', 'arrow_type'], 'LeadRadial'] as never),
    );
  }
  if (map.getLayer('lead-radial-arrow-layer')) {
    map.setFilter(
      'lead-radial-arrow-layer',
      reviewOnly
        ? (['all', ['==', ['get', 'arrow_type'], 'LeadRadial'], ['==', ['get', 'review_required'], true]] as never)
        : (['==', ['get', 'arrow_type'], 'LeadRadial'] as never),
    );
  }
  if (map.getLayer('tangent-mark-layer')) {
    map.setFilter('tangent-mark-layer', reviewOnly ? (['==', ['get', 'review_required'], true] as never) : null);
  }
}

function addDirectionArrowImage() {
  if (!map || map.hasImage('direction-arrow')) return;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return;

  context.translate(32, 32);
  context.lineJoin = 'round';
  context.lineCap = 'round';

  context.beginPath();
  context.moveTo(0, -24);
  context.lineTo(17, 13);
  context.lineTo(4, 8);
  context.lineTo(4, 25);
  context.lineTo(-4, 25);
  context.lineTo(-4, 8);
  context.lineTo(-17, 13);
  context.closePath();
  context.fillStyle = '#ffffff';
  context.strokeStyle = '#ffffff';
  context.lineWidth = 7;
  context.stroke();
  context.fill();

  context.beginPath();
  context.moveTo(0, -24);
  context.lineTo(17, 13);
  context.lineTo(4, 8);
  context.lineTo(4, 25);
  context.lineTo(-4, 25);
  context.lineTo(-4, 8);
  context.lineTo(-17, 13);
  context.closePath();
  context.fillStyle = '#111827';
  context.fill();

  map.addImage('direction-arrow', context.getImageData(0, 0, canvas.width, canvas.height));
}

function addTangentMarkImage() {
  if (!map || map.hasImage('tangent-mark')) return;
  const canvas = document.createElement('canvas');
  canvas.width = 40;
  canvas.height = 40;
  const context = canvas.getContext('2d');
  if (!context) return;

  context.fillStyle = '#111827';
  context.fillRect(18, 5, 4, 30);
  map.addImage('tangent-mark', context.getImageData(0, 0, canvas.width, canvas.height));
}

function fitToCurrentData() {
  if (!map) return;
  const bounds = getFeatureBounds(props.model.spatialFeatures);
  if (!bounds) {
    map.easeTo({ center: [103.67, 1.64], zoom: 8, duration: 450 });
    return;
  }
  map.fitBounds(bounds as LngLatBoundsLike, { padding: 80, duration: 650, maxZoom: 12 });
}

function bindPopup() {
  if (!map) return;
  map.on('click', (event) => {
    const layers = popupLayers.filter((layer) => map?.getLayer(layer));
    const features = map?.queryRenderedFeatures(event.point, { layers }) ?? [];
    const feature = features[0];
    if (!feature) return;
    new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(event.lngLat)
      .setHTML(buildPopupHtml(feature.properties as Record<string, unknown>))
      .addTo(map!);
  });

  map.on('mousemove', (event) => {
    const layers = popupLayers.filter((layer) => map?.getLayer(layer));
    const features = map?.queryRenderedFeatures(event.point, { layers }) ?? [];
    map!.getCanvas().style.cursor = features.length ? 'pointer' : '';
  });
}

function buildPopupHtml(properties: Record<string, unknown>) {
  const title = escapeHtml(String(properties.name || properties.ident || properties.procedure || properties.object_type || 'GeoJSON Feature'));
  const fields = [
    'procedure',
    'object_type',
    'leg_type',
    'leg_seq',
    'from_fix',
    'to_fix',
    'course_deg_mag',
    'radial_deg',
    'inbound_track_mag',
    'altitude_ft',
    'chart_altitude_ft',
    'arc_radius_nm',
    'lead_radial',
    'final_track_mag',
    'coordinate_quality',
    'review_required',
    'source_conflict',
  ];
  const rows = fields
    .filter((key) => properties[key] !== undefined && properties[key] !== null && properties[key] !== '')
    .map((key) => `<div class="popup-row"><span>${escapeHtml(key)}</span><strong>${escapeHtml(formatPopupValue(properties[key]))}</strong></div>`)
    .join('');
  const review = properties.review_required === true ? '<div class="popup-review">需复核</div>' : '';
  return `<div class="popup"><h3>${title}</h3>${review}${rows}</div>`;
}

function formatPopupValue(value: unknown) {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function addLayer(layer: Record<string, unknown>) {
  map?.addLayer(layer as never);
}

function emptyCollection() {
  return { type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } };
}

function typedFilter(type: string) {
  return ['==', ['get', 'object_type'], type];
}

function plannedLabelFilter(planned: boolean) {
  return planned ? ['==', ['get', 'planned'], true] : ['!=', ['get', 'planned'], true];
}

function inTypeFilter(types: string[]) {
  return ['in', ['get', 'object_type'], ['literal', types]];
}

function withReviewFilter(filter: unknown[], reviewOnly: boolean) {
  return reviewOnly ? ['all', filter, ['==', ['get', 'review_required'], true]] : filter;
}
</script>

<template>
  <div ref="container" class="map"></div>
</template>

<style scoped>
.map {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #e7edf4;
}

:global(.maplibregl-popup-content) {
  border-radius: 8px;
  padding: 0;
  box-shadow: 0 14px 34px rgba(15, 23, 42, 0.22);
}

:global(.popup) {
  display: grid;
  gap: 6px;
  min-width: 220px;
  max-width: 320px;
  padding: 12px;
  color: #172033;
  font-family: Inter, ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif;
}

:global(.popup h3) {
  margin: 0 0 4px;
  font-size: 14px;
}

:global(.popup-row) {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 8px;
  font-size: 12px;
  line-height: 1.35;
}

:global(.popup-row span) {
  color: #64748b;
}

:global(.popup-row strong) {
  color: #1f2937;
  font-weight: 600;
  overflow-wrap: anywhere;
}

:global(.popup-review) {
  width: fit-content;
  border-radius: 999px;
  background: #fff7ed;
  color: #c2410c;
  padding: 2px 8px;
  font-size: 12px;
}
</style>
