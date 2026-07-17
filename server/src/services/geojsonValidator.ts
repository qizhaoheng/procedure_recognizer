import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';
import type { ProcedureGroup } from '../types/procedure';

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
  renderableCount: number;
}

export interface GeoJsonValidationExpectations {
  airportIcao?: string;
  runway?: string;
  minimumProcedureLegCount?: number;
  requireProcedureTrack?: boolean;
}

export function validateProcedureGeoJson(geojson: unknown, group?: ProcedureGroup, expectations: GeoJsonValidationExpectations = {}): GeoJsonValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!isFeatureCollection(geojson)) {
    return { valid: false, warnings, errors: ['GeoJSON must be a FeatureCollection.'], renderableCount: 0 };
  }

  let hasLabelPoint = false;
  let renderableCount = 0;
  let procedureLegCount = 0;
  let procedureTrackCount = 0;
  let chartAirport = '';
  let chartRunway = '';
  const allowedSourcePages = group ? new Set([...(group.relatedPageNos ?? []), ...(group.supportingPages ?? [])]) : undefined;
  geojson.features.forEach((feature, index) => {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const objectType = String(props.object_type ?? '');

    if (!objectType) errors.push(`feature[${index}] is missing properties.object_type.`);
    if (objectType === 'LabelPoint') hasLabelPoint = true;
    if (objectType === 'ProcedureLeg') procedureLegCount += 1;
    if (objectType === 'ProcedureTrack' && feature.geometry) procedureTrackCount += 1;
    if (objectType === 'ProcedureChart') {
      chartAirport = String(props.airport_icao ?? '').trim().toUpperCase();
      chartRunway = String(props.runway ?? '').trim().toUpperCase().replace(/^RWY/, 'RW');
    }
    if (objectType === 'LabelPoint' && !props.label_text) errors.push(`feature[${index}] LabelPoint is missing label_text.`);
    if (objectType === 'ProcedureLeg' && (!props.procedure || !props.leg_seq || (!props.path_terminator && !props.leg_type))) {
      errors.push(`feature[${index}] ProcedureLeg is missing procedure, leg_seq, or path terminator.`);
    }
    if (objectType === 'ProcedureTrack' && !props.procedure && !props.name) {
      errors.push(`feature[${index}] ProcedureTrack is missing procedure/name.`);
    }
    if (objectType === 'ProcedureFix' && !props.ident && !props.name) {
      errors.push(`feature[${index}] ProcedureFix is missing ident/name.`);
    }
    if (typeof props.review_required !== 'boolean') errors.push(`feature[${index}] review_required must be boolean.`);
    if (!props.coordinate_quality) errors.push(`feature[${index}] is missing coordinate_quality.`);
    if (allowedSourcePages && typeof props.source_page === 'number' && !allowedSourcePages.has(props.source_page)) {
      warnings.push(`feature[${index}] source_page=${props.source_page} is outside core/supporting pages.`);
    }

    const isExplicitMissingLegGeometry = objectType === 'ProcedureLeg'
      && props.geometry_status === 'MISSING_FIX_COORDINATE'
      && props.coordinate_quality === 'missing_fix_coordinate'
      && props.review_required === true;
    if (!feature.geometry && !semanticNullGeometryTypes.has(objectType) && !isExplicitMissingLegGeometry) {
      errors.push(`feature[${index}] geometry is null but ${objectType || 'UNKNOWN'} is not an allowed semantic object.`);
    }
    if (feature.geometry && !isGeometry(feature.geometry)) {
      errors.push(`feature[${index}] geometry is invalid.`);
    } else if (feature.geometry) {
      renderableCount += 1;
    }
  });

  if (!hasLabelPoint) warnings.push('GeoJSON does not include LabelPoint features; map labels may be incomplete.');
  if (expectations.airportIcao && chartAirport !== expectations.airportIcao.trim().toUpperCase()) {
    errors.push(`GeoJSON airport ${chartAirport || 'MISSING'} does not match ${expectations.airportIcao}.`);
  }
  const expectedRunway = expectations.runway?.trim().toUpperCase().replace(/^RWY/, 'RW');
  if (expectedRunway && chartRunway !== expectedRunway) {
    errors.push(`GeoJSON runway ${chartRunway || 'MISSING'} does not match ${expectedRunway}.`);
  }
  if (expectations.minimumProcedureLegCount !== undefined && procedureLegCount < expectations.minimumProcedureLegCount) {
    errors.push(`GeoJSON has ${procedureLegCount} procedure leg geometries; expected at least ${expectations.minimumProcedureLegCount}.`);
  }
  if (expectations.requireProcedureTrack && procedureTrackCount === 0) {
    errors.push('GeoJSON contains no rendered ProcedureTrack.');
  }
  if (group && ['SID', 'STAR', 'APPROACH'].includes(group.packageType || '') && renderableCount === 0) {
    errors.push('GeoJSON contains no renderable geometry for map preview.');
  }
  if (group?.procedureCategory === 'APPROACH' && !group.supportingInfoRefs?.runwayOperationalData?.length) {
    warnings.push('APPROACH package is missing runwayOperationalData supporting info.');
  }
  if (/(ILS_LOC|ILS|LOC|DME_ARC|CONVENTIONAL|VOR|NDB)/.test(group?.navigationType || '') && !group?.supportingInfoRefs?.navaid?.length) {
    warnings.push(`${group?.navigationType} package is missing navaid supporting info.`);
  }
  return { valid: errors.length === 0, warnings, errors, renderableCount };
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
