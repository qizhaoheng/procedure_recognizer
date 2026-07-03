import type { Feature, FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';

const semanticNullGeometryTypes = new Set([
  'ProcedureChart',
  'CommunicationFrequencies',
  'ChartUnitMetadata',
  'NavigationSpecification',
  'AirwayTransitionRefList',
  'HoldingPatternRules',
  'EquipmentRequirement',
  'CommunicationFailureProcedure',
  'AirspaceConstraintList',
]);

export interface GeoJsonValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export function validateProcedureGeoJson(geojson: unknown): GeoJsonValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!isFeatureCollection(geojson)) {
    return { valid: false, warnings, errors: ['GeoJSON 必须是 FeatureCollection。'] };
  }

  let hasLabelPoint = false;
  geojson.features.forEach((feature, index) => {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const objectType = String(props.object_type ?? '');

    if (!objectType) errors.push(`feature[${index}] 缺少 properties.object_type。`);
    if (objectType === 'LabelPoint') hasLabelPoint = true;
    if (objectType === 'LabelPoint' && !props.label_text) errors.push(`feature[${index}] LabelPoint 缺少 label_text。`);
    if (objectType === 'ProcedureLeg' && (!props.procedure || !props.leg_seq || (!props.path_terminator && !props.leg_type))) {
      errors.push(`feature[${index}] ProcedureLeg 缺少 procedure、leg_seq、path_terminator/leg_type。`);
    }
    if (objectType === 'ProcedureTrack' && !props.procedure && !props.name) {
      errors.push(`feature[${index}] ProcedureTrack 缺少 procedure/name。`);
    }
    if (objectType === 'ProcedureFix' && !props.ident && !props.name) {
      errors.push(`feature[${index}] ProcedureFix 缺少 ident/name。`);
    }
    if (typeof props.review_required !== 'boolean') errors.push(`feature[${index}] review_required 必须是 boolean。`);
    if (!props.coordinate_quality) errors.push(`feature[${index}] 缺少 coordinate_quality。`);

    if (!feature.geometry && !semanticNullGeometryTypes.has(objectType)) {
      errors.push(`feature[${index}] geometry 为 null，但 ${objectType || 'UNKNOWN'} 不是允许的语义对象。`);
    }
    if (feature.geometry && !isGeometry(feature.geometry)) {
      errors.push(`feature[${index}] geometry 不合法。`);
    }
  });

  if (!hasLabelPoint) warnings.push('GeoJSON 未包含 LabelPoint，地图文字可能无法显示。');
  return { valid: errors.length === 0, warnings, errors };
}

export function withBbox(geojson: FeatureCollection<Geometry | null, GeoJsonProperties>) {
  for (const feature of geojson.features) {
    if (!feature.bbox && feature.geometry) {
      const coords: number[][] = [];
      collectCoordinates(feature.geometry, coords);
      if (coords.length) {
        const xs = coords.map((coord) => coord[0]);
        const ys = coords.map((coord) => coord[1]);
        feature.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      }
    }
  }
  return geojson;
}

function isFeatureCollection(value: unknown): value is FeatureCollection<Geometry | null, GeoJsonProperties> {
  return Boolean(value && typeof value === 'object' && (value as FeatureCollection).type === 'FeatureCollection' && Array.isArray((value as FeatureCollection).features));
}

function isGeometry(value: unknown): value is Geometry {
  if (!value || typeof value !== 'object') return false;
  const geometry = value as Geometry;
  return ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].includes(geometry.type);
}

function collectCoordinates(geometry: Geometry, coordinates: number[][]) {
  if (geometry.type === 'Point') coordinates.push(geometry.coordinates);
  else if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') coordinates.push(...geometry.coordinates);
  else if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') geometry.coordinates.flat().forEach((coord) => coordinates.push(coord));
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.flat(2).forEach((coord) => coordinates.push(coord));
  else geometry.geometries.forEach((child) => collectCoordinates(child, coordinates));
}
