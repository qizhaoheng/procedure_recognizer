import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';

export type ProcedureFeature = Feature<Geometry | null, Record<string, unknown>>;

export interface ProcedureSummary {
  procedure: string;
  feature: ProcedureFeature;
  transitionFix?: string;
  airwayRef?: string;
  inboundRadial?: number | string;
  inboundTrackMag?: number | string;
  turnDirectionEntry?: string;
  leadRadial?: string;
  finalRadial?: string;
  finalTrackMag?: number | string;
  startAltitudeFt?: number | string;
  dme13AltitudeFt?: number | string | null;
  dme13AltitudeCandidate?: number | string | null;
  reviewRequired: boolean;
  sourceConflict?: string;
}

export interface ProcedureGeoJsonModel {
  raw: FeatureCollection<Geometry | null, GeoJsonProperties>;
  allFeatures: ProcedureFeature[];
  spatialFeatures: ProcedureFeature[];
  semanticFeatures: ProcedureFeature[];
  chartMeta?: ProcedureFeature;
  procedures: ProcedureSummary[];
  procedureTracks: ProcedureFeature[];
  legsByProcedure: Record<string, ProcedureFeature[]>;
  fixes: ProcedureFeature[];
  navaids: ProcedureFeature[];
  radials: ProcedureFeature[];
  leadRadials: ProcedureFeature[];
  msaSectors: ProcedureFeature[];
  communications?: ProcedureFeature;
  equipmentRequirement?: ProcedureFeature;
  airwayRefs?: ProcedureFeature;
  communicationFailure?: ProcedureFeature;
  airspaceConstraints?: ProcedureFeature;
  chartUnitMetadata?: ProcedureFeature;
  reviewItems: ProcedureFeature[];
}

const REVIEW_OBJECT_TYPES = new Set([
  'DerivedFix',
  'LeadRadialPoint',
  'DMEReferenceCircle',
  'ChartLabel',
  'MSASector',
  'CommonFinalSegment',
]);

export function parseProcedureGeoJson(
  geojson: FeatureCollection<Geometry | null, GeoJsonProperties>,
): ProcedureGeoJsonModel {
  const allFeatures = geojson.features.map((feature) => normalizeFeature(feature as ProcedureFeature));
  const spatialFeatures = allFeatures.filter((feature) => Boolean(feature.geometry));
  const semanticFeatures = allFeatures.filter((feature) => !feature.geometry);

  const byType = (type: string) => allFeatures.filter((feature) => feature.properties.object_type === type);
  const firstByType = (type: string) => byType(type)[0];

  const procedureTracks = byType('ProcedureTrack');
  const procedureLegs = byType('ProcedureLeg');
  const legsByProcedure = procedureLegs.reduce<Record<string, ProcedureFeature[]>>((groups, feature) => {
    const procedure = asString(feature.properties.procedure);
    if (!procedure) return groups;
    groups[procedure] ??= [];
    groups[procedure].push(feature);
    groups[procedure].sort((a, b) => asNumber(a.properties.leg_seq) - asNumber(b.properties.leg_seq));
    return groups;
  }, {});

  const procedures = procedureTracks
    .map((feature) => toProcedureSummary(feature))
    .sort((a, b) => a.procedure.localeCompare(b.procedure));

  const reviewItems = allFeatures.filter((feature) => hasReviewSignal(feature));

  return {
    raw: geojson,
    allFeatures,
    spatialFeatures,
    semanticFeatures,
    chartMeta: firstByType('ProcedureChart'),
    procedures,
    procedureTracks,
    legsByProcedure,
    fixes: allFeatures.filter((feature) =>
      ['ProcedureFix', 'DerivedFix', 'LeadRadialPoint', 'SIDAltitudePoint', 'RunwayThreshold', 'RunwayEnd'].includes(
        asString(feature.properties.object_type),
      ),
    ),
    navaids: byType('Navaid'),
    radials: byType('RadialReference'),
    leadRadials: byType('LeadRadial'),
    msaSectors: byType('MSASector'),
    communications: firstByType('CommunicationFrequencies'),
    equipmentRequirement: firstByType('EquipmentRequirement'),
    airwayRefs: firstByType('AirwayTransitionRefList'),
    communicationFailure: firstByType('CommunicationFailureProcedure'),
    airspaceConstraints: firstByType('AirspaceConstraintList'),
    chartUnitMetadata: firstByType('ChartUnitMetadata'),
    reviewItems,
  };
}

export interface LabelFeatureProperties {
  label_text: string;
  label_type: string;
  priority: number;
  source_feature_id?: string;
  object_type?: string;
  review_required?: boolean;
  text_anchor?: string;
  text_offset?: [number, number];
  force_visible?: boolean;
  /** true = 识别阶段规划的标签（LabelPoint），优先于前端启发式标签 */
  planned?: boolean;
}

export interface ArrowFeatureProperties {
  arrow_type: string;
  bearing: number;
  procedure?: string;
  leg_type?: string;
  leg_seq?: number;
  source_feature_id?: string;
  review_required?: boolean;
}

export interface TangentFeatureProperties {
  tangent_type: string;
  bearing: number;
  procedure?: string;
  radial_deg?: number;
  source_feature_id?: string;
  review_required?: boolean;
}

export function buildLabelFeatures(spatialFeatures: ProcedureFeature[]): FeatureCollection<Geometry, LabelFeatureProperties> {
  const embeddedLabels = spatialFeatures.filter(
    (feature) =>
      feature.properties.object_type === 'LabelPoint' &&
      feature.geometry?.type === 'Point' &&
      asString(feature.properties.label_text),
  );

  const labels: Feature<Geometry, LabelFeatureProperties>[] = embeddedLabels.map((feature) => ({
    type: 'Feature',
    geometry: feature.geometry as Geometry,
    properties: {
      label_text: asString(feature.properties.label_text),
      label_type: asString(feature.properties.label_type || 'LabelPoint'),
      priority: asNumber(feature.properties.priority) || 50,
      source_feature_id: asString(feature.properties.parent_feature_id || feature.properties.feature_id),
      object_type: asString(feature.properties.parent_object_type || feature.properties.object_type),
      review_required: feature.properties.review_required === true,
      text_anchor: asString(feature.properties.text_anchor || 'top'),
      text_offset: [
        Number(feature.properties.text_offset_x ?? 0),
        Number(feature.properties.text_offset_y ?? 0.8),
      ],
      force_visible: feature.properties.force_visible === true,
      planned: true,
    },
  }));
  // 已被识别阶段标签规划覆盖的要素不再叠加启发式标签，避免同一对象双重标注
  const coveredByPlan = new Set(
    labels.map((label) => label.properties.source_feature_id).filter(Boolean) as string[],
  );
  const hasChartArcLabel = spatialFeatures.some(
    (feature) => feature.properties.object_type === 'ChartLabel' && asString(feature.properties.name).includes('DME ARC'),
  );

  const pushLabel = (
    feature: ProcedureFeature,
    coordinates: number[] | undefined,
    labelText: string,
    labelType: string,
    priority: number,
    options: Partial<LabelFeatureProperties> = {},
  ) => {
    if (!coordinates || !labelText.trim()) return;
    labels.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coordinates as [number, number] },
      properties: {
        label_text: labelText,
        label_type: labelType,
        priority,
        source_feature_id: asString(feature.properties.feature_id),
        object_type: asString(feature.properties.object_type),
        review_required: feature.properties.review_required === true,
        ...options,
      },
    });
  };

  const finalCommonSeen = new Set<string>();
  let dmeArcLegLabelAdded = false;

  for (const feature of spatialFeatures) {
    const props = feature.properties;
    const objectType = asString(props.object_type);
    if (objectType === 'LabelPoint') continue;
    if (coveredByPlan.has(asString(props.feature_id))) continue;
    const point = pointForGeometry(feature.geometry);

    if (objectType === 'ProcedureFix') {
      const role = props.chart_fix_role ? ` (${props.chart_fix_role})` : '';
      const altitude = props.chart_altitude_ft ? `\n${props.chart_altitude_ft}` : '';
      const finalTrack = props.final_track_mag ? `\n${padCourse(props.final_track_mag)}°` : '';
      pushLabel(feature, point, `${props.ident || props.name}${role}${altitude}${finalTrack}`, 'ProcedureFix', 90);
    }

    if (objectType === 'ProcedureTrack') {
      pushLabel(feature, linePointAt(feature.geometry, 0.28), asString(props.procedure), 'ProcedureName', 88, {
        text_anchor: 'center',
        text_offset: [0, -0.8],
      });
    }

    if (objectType === 'DerivedFix') {
      const name = asString(props.name);
      if (name.includes('13D VJB')) {
        const altitude = props.altitude_ft || props.altitude_ft_review_candidate;
        const suffix = altitude ? `\n${altitude}${props.altitude_ft_review_candidate ? '?' : ''}` : '';
        pushLabel(feature, point, `13D VJB${suffix}`, 'DerivedFix', 60);
      } else if (name.includes('11D ARC JOIN')) {
        pushLabel(feature, point, '11D ARC JOIN', 'DerivedFix', 60);
      } else if (name.includes('RDL340 FINAL INTERCEPT')) {
        pushLabel(feature, point, 'RDL340\n160°', 'DerivedFix', 75);
      }
    }

    if (objectType === 'SIDAltitudePoint') {
      const altitude = props.altitude_ft ? `${props.altitude_ft}` : asString(props.name || props.ident);
      pushLabel(feature, point, altitude, 'SIDAltitudePoint', 84, {
        text_anchor: 'bottom',
        text_offset: [0, -0.7],
      });
    }

    if (objectType === 'LeadRadialPoint') {
      const ident = asString(props.ident).replace(' VJB', '');
      pushLabel(feature, point, `${ident}\n${props.dme_nm || 11}D`, 'LeadRadial', 85);
    }

    if (objectType === 'Navaid') {
      const frequency = [props.frequency_mhz, props.channel].filter(Boolean).join(' ');
      const morse = props.morse_display ? `\n${props.morse_display}` : '';
      pushLabel(feature, point, `${props.name || props.ident}\n${frequency}${morse}`, 'Navaid', 100);
    }

    if (objectType === 'RunwayThreshold' || objectType === 'RunwayEnd') {
      pushLabel(feature, point, asString(props.name), 'Runway', 82);
    }

    if (objectType === 'ChartLabel') {
      pushLabel(feature, point, asString(props.name), 'DMEArc', 80);
    }

    if (objectType === 'DMEReferenceCircle' && !hasChartArcLabel) {
      pushLabel(feature, linePointAt(feature.geometry, 0.84), '11 DME ARC\nVJB VOR/DME', 'DMEArc', 80);
    }

    if (objectType === 'RadialReference') {
      const ident = asString(props.ident);
      const text = ident === 'RDL340 VJB' ? 'RDL340 VJB\n160°' : ident;
      pushLabel(feature, linePointAt(feature.geometry, 0.75), text, 'Radial', ident === 'RDL340 VJB' ? 78 : 70);
    }

    if (objectType === 'LeadRadial') {
      pushLabel(feature, linePointAt(feature.geometry, 0.7), asString(props.ident), 'LeadRadial', 85);
    }

    if (objectType === 'MSASector') {
      pushLabel(feature, point, `${props.altitude_ft} FT`, 'MSA', 40);
    }

    if (objectType === 'ProcedureLeg') {
      const legType = asString(props.leg_type);
      const courseDistanceLabel = rnavCourseDistanceLabel(props);
      if (courseDistanceLabel) {
        pushLabel(feature, linePointAt(feature.geometry, 0.5), courseDistanceLabel, 'ProcedureCourse', 76, {
          text_anchor: 'center',
          text_offset: [0, 0],
        });
      }
      if (legType === 'TRACK_TO_DME_FIX') {
        pushLabel(feature, linePointAt(feature.geometry, 0.5), `${props.procedure}\n${padCourse(props.course_deg_mag)}°`, 'ProcedureCourse', 75);
      }
      if (legType === 'TURN_TO_DME_ARC') {
        pushLabel(feature, linePointAt(feature.geometry, 0.5), 'TURN TO\n11D ARC', 'DerivedFix', 62);
      }
      if (legType === 'DME_ARC' && !hasChartArcLabel && !dmeArcLegLabelAdded) {
        dmeArcLegLabelAdded = true;
        pushLabel(feature, linePointAt(feature.geometry, 0.5), '11 DME ARC\nVJB', 'DMEArc', 80);
      }
      if (legType === 'LEAD_RADIAL_EXIT_TURN') {
        pushLabel(feature, linePointAt(feature.geometry, 0.5), 'LEAD TURN\nTO RDL340', 'LeadRadial', 74);
      }
      if (legType === 'FINAL_COMMON_SEGMENT' && !finalCommonSeen.has('RDL340')) {
        finalCommonSeen.add('RDL340');
        pushLabel(feature, linePointAt(feature.geometry, 0.58), finalCommonLabel(feature), 'ProcedureCourse', 76);
      }
    }

    if (objectType === 'CommonFinalSegment' && !finalCommonSeen.has('RDL340')) {
      finalCommonSeen.add('RDL340');
      pushLabel(feature, linePointAt(feature.geometry, 0.58), finalCommonLabel(feature), 'ProcedureCourse', 76);
    }
  }

  return { type: 'FeatureCollection', features: labels };
}

export function buildArrowFeatures(spatialFeatures: ProcedureFeature[]): FeatureCollection<Geometry, ArrowFeatureProperties> {
  const arrows: Feature<Geometry, ArrowFeatureProperties>[] = [];
  let finalCommonArrowAdded = false;

  const pushArrow = (feature: ProcedureFeature, fraction: number, arrowType: string) => {
    const position = linePointWithBearing(feature.geometry, fraction);
    if (!position) return;
    arrows.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: position.coordinates as [number, number] },
      properties: {
        arrow_type: arrowType,
        bearing: position.bearing,
        procedure: asString(feature.properties.procedure),
        leg_type: asString(feature.properties.leg_type),
        leg_seq: asNumber(feature.properties.leg_seq),
        source_feature_id: asString(feature.properties.feature_id),
        review_required: feature.properties.review_required === true,
      },
    });
  };

  for (const feature of spatialFeatures) {
    if (feature.geometry?.type !== 'LineString') continue;

    if (feature.properties.object_type === 'LeadRadial') {
      pushArrow(feature, 0.92, 'LeadRadial');
      continue;
    }

    if (feature.properties.object_type !== 'ProcedureLeg') continue;

    const legType = asString(feature.properties.leg_type);
    if (legType === 'TRACK_TO_DME_FIX') {
      pushArrow(feature, 0.9, 'BeforeEntryTurn');
    }
    if (legType === 'LEAD_RADIAL_EXIT_TURN') {
      pushArrow(feature, 0.5, 'LeadTurn');
    }
    if (legType === 'FINAL_COMMON_SEGMENT' && !finalCommonArrowAdded) {
      finalCommonArrowAdded = true;
      pushArrow(feature, 0.42, 'FinalCommon');
    }
  }

  return { type: 'FeatureCollection', features: arrows };
}

export function buildTangentFeatures(spatialFeatures: ProcedureFeature[]): FeatureCollection<Geometry, TangentFeatureProperties> {
  const tangents: Feature<Geometry, TangentFeatureProperties>[] = [];

  for (const feature of spatialFeatures) {
    if (feature.properties.object_type !== 'DerivedFix' || feature.geometry?.type !== 'Point') continue;

    const name = asString(feature.properties.name);
    const radial = Number(feature.properties.radial_deg);
    if (!name.includes('13D VJB') || !Number.isFinite(radial)) continue;

    tangents.push({
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        tangent_type: 'ThirteenDRadialTangent',
        bearing: (radial + 90) % 360,
        procedure: asString(feature.properties.procedure),
        radial_deg: radial,
        source_feature_id: asString(feature.properties.feature_id),
        review_required: feature.properties.review_required === true,
      },
    });
  }

  return { type: 'FeatureCollection', features: tangents };
}

export function getFeatureBounds(features: ProcedureFeature[]): [[number, number], [number, number]] | undefined {
  const coordinates: number[][] = [];
  features.forEach((feature) => collectGeometryCoordinates(feature.geometry, coordinates));
  if (!coordinates.length) return undefined;

  const lngs = coordinates.map((coordinate) => coordinate[0]);
  const lats = coordinates.map((coordinate) => coordinate[1]);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const pad = west === east && south === north ? 0.04 : 0;
  return [
    [west - pad, south - pad],
    [east + pad, north + pad],
  ];
}

function pointForGeometry(geometry: Geometry | null): number[] | undefined {
  if (!geometry) return undefined;
  if (geometry.type === 'Point') return geometry.coordinates;
  if (geometry.type === 'LineString') return linePointAt(geometry, 0.5);

  const coordinates: number[][] = [];
  collectGeometryCoordinates(geometry, coordinates);
  if (!coordinates.length) return undefined;
  const lng = coordinates.reduce((sum, coordinate) => sum + coordinate[0], 0) / coordinates.length;
  const lat = coordinates.reduce((sum, coordinate) => sum + coordinate[1], 0) / coordinates.length;
  return [lng, lat];
}

function linePointAt(geometry: Geometry | null, fraction: number): number[] | undefined {
  if (!geometry || geometry.type !== 'LineString') return pointForGeometry(geometry);
  const coordinates = geometry.coordinates;
  if (!coordinates.length) return undefined;
  const index = Math.max(0, Math.min(coordinates.length - 1, Math.floor(coordinates.length * fraction)));
  return coordinates[index];
}

function linePointWithBearing(geometry: Geometry | null, fraction: number): { coordinates: number[]; bearing: number } | undefined {
  if (!geometry || geometry.type !== 'LineString') return undefined;
  const coordinates = geometry.coordinates;
  if (coordinates.length < 2) return undefined;

  const segmentLengths = coordinates.slice(0, -1).map((coordinate, index) => distance(coordinate, coordinates[index + 1]));
  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
  if (!totalLength) return undefined;

  const targetLength = totalLength * Math.max(0, Math.min(1, fraction));
  let traversed = 0;
  let segmentIndex = 0;
  for (; segmentIndex < segmentLengths.length; segmentIndex += 1) {
    if (traversed + segmentLengths[segmentIndex] >= targetLength) break;
    traversed += segmentLengths[segmentIndex];
  }

  const from = coordinates[Math.min(segmentIndex, coordinates.length - 2)];
  const to = coordinates[Math.min(segmentIndex + 1, coordinates.length - 1)];
  const segmentLength = segmentLengths[Math.min(segmentIndex, segmentLengths.length - 1)] || 1;
  const segmentFraction = Math.max(0, Math.min(1, (targetLength - traversed) / segmentLength));
  const interpolated = [
    from[0] + (to[0] - from[0]) * segmentFraction,
    from[1] + (to[1] - from[1]) * segmentFraction,
  ];

  return {
    coordinates: interpolated,
    bearing: bearingDegrees(from, to),
  };
}

function distance(from: number[], to: number[]): number {
  return Math.hypot(to[0] - from[0], to[1] - from[1]);
}

function bearingDegrees(from: number[], to: number[]): number {
  const deltaLng = to[0] - from[0];
  const deltaLat = to[1] - from[1];
  return (Math.atan2(deltaLng, deltaLat) * 180) / Math.PI;
}

function collectGeometryCoordinates(geometry: Geometry | null, coordinates: number[][]) {
  if (!geometry) return;
  if (geometry.type === 'Point') coordinates.push(geometry.coordinates);
  if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') coordinates.push(...geometry.coordinates);
  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') geometry.coordinates.flat().forEach((coordinate) => coordinates.push(coordinate));
  if (geometry.type === 'MultiPolygon') geometry.coordinates.flat(2).forEach((coordinate) => coordinates.push(coordinate));
  if (geometry.type === 'GeometryCollection') geometry.geometries.forEach((child) => collectGeometryCoordinates(child, coordinates));
}

function padCourse(value: unknown): string {
  const course = Number(value);
  if (!Number.isFinite(course)) return asString(value);
  return String(Math.round(course)).padStart(3, '0');
}

function rnavCourseDistanceLabel(props: Record<string, unknown>): string {
  const legType = asString(props.leg_type || props.path_terminator).toUpperCase();
  if (!['TF', 'IF'].includes(legType)) return '';
  const course = Number(props.course_deg_mag);
  const distance = Number(props.distance_nm);
  if (!Number.isFinite(course) && !Number.isFinite(distance)) return '';
  const courseText = Number.isFinite(course) ? `${padCourse(course)}°` : '';
  const distanceText = Number.isFinite(distance) && distance > 0 ? formatNm(distance) : '';
  return [courseText, distanceText].filter(Boolean).join(' ');
}

function finalCommonLabel(feature: ProcedureFeature): string {
  const props = feature.properties;
  const finalRadial = asString(props.final_radial || props.ident);
  const course = Number(props.course_deg_mag || props.final_track_mag || props.inbound_track_mag);
  const courseText = Number.isFinite(course) ? `${padCourse(course)}°` : '160°';
  return finalRadial.includes('RDL') ? `${finalRadial}\n${courseText}` : courseText;
}

function formatNm(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(1) : `${rounded}`;
}

export function hasReviewSignal(feature?: ProcedureFeature): boolean {
  if (!feature) return false;
  const properties = feature.properties ?? {};
  const objectType = asString(properties.object_type);
  const quality = asString(properties.coordinate_quality).toLowerCase();
  const hasItemConflict = Array.isArray(properties.items)
    ? properties.items.some((item) => Boolean((item as Record<string, unknown>).source_conflict))
    : false;

  return (
    properties.review_required === true ||
    Boolean(properties.source_conflict) ||
    hasItemConflict ||
    quality.includes('derived') ||
    REVIEW_OBJECT_TYPES.has(objectType)
  );
}

export function findFeatureById(model: ProcedureGeoJsonModel | undefined, featureId: string | undefined) {
  if (!model || !featureId) return undefined;
  return model.allFeatures.find((feature) => feature.properties.feature_id === featureId);
}

export function semanticTitle(feature: ProcedureFeature): string {
  const props = feature.properties;
  const type = asString(props.object_type);
  if (type === 'CommunicationFrequencies') return '通信频率';
  if (type === 'EquipmentRequirement') return '设备要求';
  if (type === 'AirwayTransitionRefList') return '航路接入关系';
  if (type === 'CommunicationFailureProcedure') return '通信失效程序';
  if (type === 'AirspaceConstraintList') return '空域约束';
  if (type === 'ChartUnitMetadata') return '图件单位与方位';
  return type || '语义对象';
}

export function featureTitle(feature?: ProcedureFeature): string {
  if (!feature) return '未选择对象';
  const props = feature.properties;
  return (
    asString(props.name) ||
    asString(props.ident) ||
    asString(props.procedure) ||
    semanticTitle(feature) ||
    asString(props.object_type) ||
    'GeoJSON Feature'
  );
}

export function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function asNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function normalizeFeature(feature: ProcedureFeature): ProcedureFeature {
  const properties = { ...(feature.properties ?? {}) };
  const objectType = asString(properties.object_type);
  properties.feature_id ||= stableFeatureId(properties);
  properties.display_label = buildDisplayLabel(properties);
  properties.review_signal = hasReviewSignal({ ...feature, properties });
  properties.derived_signal = asString(properties.coordinate_quality).toLowerCase().includes('derived');
  properties.layer_group = objectType;
  return { ...feature, properties };
}

function toProcedureSummary(feature: ProcedureFeature): ProcedureSummary {
  const props = feature.properties;
  return {
    procedure: asString(props.procedure),
    feature,
    transitionFix: asString(props.transition_fix),
    airwayRef: asString(props.airway_ref),
    inboundRadial: props.inbound_radial as number | string | undefined,
    inboundTrackMag: props.inbound_track_mag as number | string | undefined,
    turnDirectionEntry: asString(props.turn_direction_entry),
    leadRadial: asString(props.lead_radial),
    finalRadial: asString(props.final_radial),
    finalTrackMag: props.final_track_mag as number | string | undefined,
    startAltitudeFt: props.start_altitude_ft as number | string | undefined,
    dme13AltitudeFt: props.dme_13_altitude_ft as number | string | null | undefined,
    dme13AltitudeCandidate: props.dme_13_altitude_ft_review_candidate as number | string | null | undefined,
    reviewRequired: hasReviewSignal(feature),
    sourceConflict: asString(props.source_conflict || props.airway_ref_tabular_conflict),
  };
}

function stableFeatureId(properties: Record<string, unknown>): string {
  return [
    properties.object_type,
    properties.procedure,
    properties.leg_seq,
    properties.ident,
    properties.name,
  ]
    .filter(Boolean)
    .join('_')
    .replace(/\s+/g, '_');
}

function buildDisplayLabel(properties: Record<string, unknown>): string {
  const type = asString(properties.object_type);
  if (type === 'ProcedureTrack') return asString(properties.procedure);
  if (type === 'ProcedureFix') {
    const altitude = properties.chart_altitude_ft ? ` ${properties.chart_altitude_ft}` : '';
    const role = properties.chart_fix_role ? ` (${properties.chart_fix_role})` : '';
    return `${asString(properties.ident || properties.name)}${role}${altitude}`;
  }
  if (type === 'Navaid') {
    const frequency = properties.frequency_mhz ? ` ${properties.frequency_mhz}` : '';
    return `${asString(properties.name || properties.ident)}${frequency}`;
  }
  if (type === 'DMEReferenceCircle') return asString(properties.label_on_chart || properties.name);
  if (type === 'RadialReference' || type === 'LeadRadial' || type === 'LeadRadialPoint') {
    return asString(properties.ident || properties.name);
  }
  if (type === 'MSASector') return properties.altitude_ft ? `${properties.altitude_ft} FT` : 'MSA';
  if (type === 'CommonFinalSegment') return 'RDL340 VJB / inbound 160°';
  if (type === 'DerivedFix') {
    const radial = properties.radial_deg === 340 ? 'RDL340 ' : '';
    const dme = properties.dme_nm ? `${properties.dme_nm}D ` : '';
    return asString(properties.name).includes('13D') ? '13D VJB' : `${radial}${dme}${asString(properties.name)}`;
  }
  if (type === 'SIDAltitudePoint') return properties.altitude_ft ? `${properties.altitude_ft}` : asString(properties.name || properties.ident);
  if (type === 'RunwayThreshold' || type === 'RunwayEnd' || type === 'Runway') return asString(properties.name);
  if (type === 'ChartLabel') return asString(properties.name);
  if (type === 'ProcedureLeg' && properties.leg_type === 'FINAL_COMMON_SEGMENT') return '160°';
  return asString(properties.name || properties.ident || properties.procedure || type);
}
