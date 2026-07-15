<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch, ref } from "vue";
import maplibregl, { type Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
const props = defineProps<{
  geojson?: any;
  selectedLegId?: string;
  /** 按 routeType 分层显隐；缺省全部显示 */
  visibleRouteTypes?: string[];
}>();
const emit = defineEmits<{ selectLeg: [id: string] }>();
const container = ref<HTMLDivElement>();
const mapError = ref("");
let map: Map | undefined;
let resizeObserver: ResizeObserver | undefined;
let interactionsInstalled = false;
onMounted(() => {
  if (!container.value) return;
  map = new maplibregl.Map({
    container: container.value,
    style: {
      version: 8,
      // symbol 层需要 glyphs
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {
        base: {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
        },
      },
      layers: [
        {
          id: "base",
          type: "raster",
          source: "base",
          paint: { "raster-opacity": 0.7 },
        },
      ],
    },
    center: [103.8, 1.35],
    zoom: 8,
  });
  resizeObserver = new ResizeObserver(() => {
    map?.resize();
    fit();
  });
  resizeObserver.observe(container.value);
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  let initialized = false;
  const initializeProcedureLayers = () => {
    if (!map || initialized) return;
    try {
      install();
      if (!map.getSource("procedure")) return;
      map.resize();
      update();
      mapError.value = "";
      initialized = true;
    } catch (error) {
      mapError.value = error instanceof Error ? error.message : String(error);
    }
  };
  map.on("styledata", initializeProcedureLayers);
  requestAnimationFrame(initializeProcedureLayers);
});
watch(
  () => props.geojson,
  () =>
    requestAnimationFrame(() => {
      map?.resize();
      update();
    }),
  { deep: true },
);
watch(() => props.selectedLegId, highlight);
watch(() => props.visibleRouteTypes, applyRouteVisibility, { deep: true });
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  map?.remove();
});
function legFilterBase(): any {
  return ["==", ["get", "featureType"], "LEG"];
}
function routeTypeFilter(): any {
  if (!props.visibleRouteTypes) return true;
  return [
    "in",
    ["coalesce", ["get", "routeType"], "OTHER"],
    ["literal", props.visibleRouteTypes],
  ];
}
function install() {
  if (!map) return;
  if (!map.getSource("procedure"))
    map.addSource("procedure", { type: "geojson", data: empty() });
  // —— 跑道 ——
  addLayer({
    id: "runway",
    type: "line",
    source: "procedure",
    filter: ["==", ["get", "featureType"], "RUNWAY"],
    paint: { "line-color": "#102a43", "line-width": 7, "line-opacity": 0.85 },
  });
  addLayer({
    id: "runway-ends",
    type: "circle",
    source: "procedure",
    filter: ["==", ["get", "featureType"], "RUNWAY_END"],
    paint: {
      "circle-radius": 5,
      "circle-color": [
        "match",
        ["get", "kind"],
        "DER",
        "#b91c1c",
        "#102a43",
      ],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
    },
  });
  addLayer({
    id: "runway-end-labels",
    type: "symbol",
    source: "procedure",
    filter: ["==", ["get", "featureType"], "RUNWAY_END"],
    layout: {
      "text-field": ["get", "name"],
      "text-size": 11,
      "text-offset": [0, 1.1],
      "text-anchor": "top",
    },
    paint: { "text-color": "#102a43", "text-halo-color": "#fff", "text-halo-width": 1.4 },
  });
  addLayer({
    id: "routes",
    type: "line",
    source: "procedure",
    filter: ["==", ["get", "featureType"], "ROUTE"],
    paint: { "line-color": "#52657a", "line-width": 3, "line-opacity": 0.35 },
  });
  // —— 腿段（复飞独立为虚线层） ——
  addLayer({
    id: "legs",
    type: "line",
    source: "procedure",
    filter: [
      "all",
      legFilterBase(),
      ["!=", ["get", "geometryQuality"], "DISPLAY_ONLY"],
      ["!=", ["get", "routeType"], "MISSED_APPROACH"],
      routeTypeFilter(),
    ],
    paint: {
      "line-color": [
        "match",
        ["get", "geometryQuality"],
        "EXACT",
        "#1769e0",
        "DERIVED",
        "#00a67d",
        "DISPLAY_ONLY",
        "#d97706",
        "#94a3b8",
      ],
      "line-width": 4,
    },
  });
  addLayer({
    id: "missed-legs",
    type: "line",
    source: "procedure",
    filter: [
      "all",
      legFilterBase(),
      ["==", ["get", "routeType"], "MISSED_APPROACH"],
      routeTypeFilter(),
    ],
    paint: {
      "line-color": "#7c3aed",
      "line-width": 4,
      "line-dasharray": [3, 2],
    },
  });
  addLayer({
    id: "display-legs",
    type: "line",
    source: "procedure",
    filter: [
      "all",
      legFilterBase(),
      ["==", ["get", "geometryQuality"], "DISPLAY_ONLY"],
      ["!=", ["get", "routeType"], "MISSED_APPROACH"],
      routeTypeFilter(),
    ],
    paint: {
      "line-color": "#d97706",
      "line-width": 4,
      "line-dasharray": [2, 2],
    },
  });
  addLayer({
    id: "selected-leg",
    type: "line",
    source: "procedure",
    filter: ["==", ["get", "legId"], ""],
    paint: { "line-color": "#ef4444", "line-width": 8 },
  });
  addLayer({
    id: "fixes",
    type: "circle",
    source: "procedure",
    filter: ["==", ["get", "featureType"], "FIX"],
    paint: {
      "circle-radius": 6,
      "circle-color": "#fff",
      "circle-stroke-color": "#102a43",
      "circle-stroke-width": 2,
    },
  });
  addLayer({
    id: "fix-labels",
    type: "symbol",
    source: "procedure",
    filter: ["==", ["get", "featureType"], "FIX"],
    layout: {
      "text-field": [
        "case",
        ["all", ["has", "role"], ["!=", ["coalesce", ["get", "role"], "NONE"], "NONE"]],
        ["concat", ["get", "identifier"], "\n", ["get", "role"]],
        ["get", "identifier"],
      ],
      "text-size": 11,
      "text-offset": [0.9, -0.9],
      "text-anchor": "bottom-left",
    },
    paint: { "text-color": "#0b2545", "text-halo-color": "#fff", "text-halo-width": 1.4 },
  });
  addLayer({
    id: "constraint-labels",
    type: "symbol",
    source: "procedure",
    filter: [
      "all",
      ["==", ["get", "featureType"], "LABEL"],
      ["==", ["get", "labelKind"], "CONSTRAINT"],
    ],
    layout: {
      "text-field": ["get", "text"],
      "text-size": 10,
      "text-offset": [0, 1],
      "text-anchor": "top",
    },
    paint: { "text-color": "#7a3f00", "text-halo-color": "#fff", "text-halo-width": 1.3 },
  });
  addLayer({
    id: "route-labels",
    type: "symbol",
    source: "procedure",
    filter: [
      "all",
      ["==", ["get", "featureType"], "LABEL"],
      ["==", ["get", "labelKind"], "ROUTE_NAME"],
      props.visibleRouteTypes
        ? ["in", ["coalesce", ["get", "routeType"], "OTHER"], ["literal", props.visibleRouteTypes]]
        : true,
    ],
    layout: {
      "text-field": ["get", "text"],
      "text-size": 12,
      "text-offset": [0, -1.2],
      "text-anchor": "bottom",
    },
    paint: { "text-color": "#174ea6", "text-halo-color": "#fff", "text-halo-width": 1.5 },
  });
  addLayer({
    id: "procedure-label",
    type: "symbol",
    source: "procedure",
    filter: [
      "all",
      ["==", ["get", "featureType"], "LABEL"],
      ["==", ["get", "labelKind"], "PROCEDURE_NAME"],
    ],
    layout: {
      "text-field": ["get", "text"],
      "text-size": 14,
      "text-anchor": "center",
      "text-allow-overlap": false,
    },
    paint: { "text-color": "#0b2545", "text-opacity": 0.75, "text-halo-color": "#fff", "text-halo-width": 1.6 },
  });
  if (interactionsInstalled) return;
  const selectLeg = (e: maplibregl.MapLayerMouseEvent) => {
    const id = e.features?.[0]?.properties?.legId;
    if (id) emit("selectLeg", id);
  };
  const showPointer = () => {
    if (map) map.getCanvas().style.cursor = "pointer";
  };
  const hidePointer = () => {
    if (map) map.getCanvas().style.cursor = "";
  };
  for (const layer of ["legs", "display-legs", "missed-legs"]) {
    map.on("click", layer, selectLeg);
    map.on("mouseenter", layer, showPointer);
    map.on("mouseleave", layer, hidePointer);
  }
  interactionsInstalled = true;
}
function applyRouteVisibility() {
  if (!map) return;
  const filterFor = (layerId: string): any => {
    if (layerId === "legs")
      return ["all", legFilterBase(), ["!=", ["get", "geometryQuality"], "DISPLAY_ONLY"], ["!=", ["get", "routeType"], "MISSED_APPROACH"], routeTypeFilter()];
    if (layerId === "missed-legs")
      return ["all", legFilterBase(), ["==", ["get", "routeType"], "MISSED_APPROACH"], routeTypeFilter()];
    return ["all", legFilterBase(), ["==", ["get", "geometryQuality"], "DISPLAY_ONLY"], ["!=", ["get", "routeType"], "MISSED_APPROACH"], routeTypeFilter()];
  };
  for (const id of ["legs", "missed-legs", "display-legs"]) if (map.getLayer(id)) map.setFilter(id, filterFor(id));
}
function addLayer(layer: any) {
  if (map && !map.getLayer(layer.id)) map.addLayer(layer as maplibregl.LayerSpecification);
}
function update() {
  if (!map) return;
  const source = map.getSource("procedure") as
    | maplibregl.GeoJSONSource
    | undefined;
  if (!source) return;
  source.setData(props.geojson || empty());
  highlight();
  applyRouteVisibility();
  fit();
}
function highlight() {
  if (map?.getLayer("selected-leg"))
    map.setFilter("selected-leg", [
      "==",
      ["get", "legId"],
      props.selectedLegId || "",
    ]);
}
function fit() {
  if (!map || !props.geojson?.features) return;
  const coords: number[][] = [];
  for (const f of props.geojson.features) {
    const g = f.geometry;
    if (g?.type === "Point") coords.push(g.coordinates);
    if (g?.type === "LineString") coords.push(...g.coordinates);
    if (g?.type === "MultiLineString") coords.push(...g.coordinates.flat());
  }
  if (!coords.length) return;
  const first = coords[0] as [number, number];
  const bounds = new maplibregl.LngLatBounds(first, first);
  coords.slice(1).forEach((c) => bounds.extend(c as [number, number]));
  map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 500 });
}
function empty(): any {
  return { type: "FeatureCollection", features: [] };
}
</script>
<template>
  <div
    ref="container"
    class="map"
    aria-label="飞行程序地图"
  >
    <div v-if="mapError" class="empty">地图图层加载失败：{{ mapError }}</div>
    <div
      v-else-if="!geojson?.features?.some((f: any) => f.geometry)"
      class="empty"
    >
      当前程序坐标不足，尚无可绘制航迹
    </div>
  </div>
</template>
<style scoped>
.map {
  height: 100%;
  min-height: 540px;
  position: relative;
  background: #dce7f1;
}
.empty {
  position: absolute;
  z-index: 2;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  background: #fff;
  padding: 14px 18px;
  border-radius: 8px;
  color: #52606d;
  box-shadow: 0 4px 18px #102a4322;
}
</style>
