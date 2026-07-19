const DMS = /([NS])?\s*(\d{1,3})\D+(\d{1,2})\D+(\d{1,2}(?:\.\d+)?)\s*([NSEW])?/i;
const COMPACT = /^([NS])(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)(?:\s+|\/)?([EW])(\d{3})(\d{2})(\d{2}(?:\.\d+)?)$/i;
// 半球符在后的紧凑式（WMKJ/AIP MALAYSIA 用这种："ARP coordinates and site at AD 013826N 1034013E"）。
// 不加首尾锚定：这类坐标常嵌在整句话里。
const COMPACT_TRAILING = /(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)\s*([NS])[\s,;/]*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)\s*([EW])/i;

export function dmsToDecimal(degrees: number, minutes: number, seconds: number, hemisphere?: string) {
  if (minutes >= 60 || seconds >= 60) throw new Error('Invalid DMS minutes or seconds.');
  const value = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  return ['S', 'W'].includes(String(hemisphere).toUpperCase()) ? -value : value;
}

export function parseCoordinate(text: string): { latitude?: number; longitude?: number } {
  const normalized = text.trim().toUpperCase().replace(/[°′'″"]/g, ' ');
  const compact = normalized.match(COMPACT);
  if (compact) return {
    latitude: dmsToDecimal(+compact[2], +compact[3], +compact[4], compact[1]),
    longitude: dmsToDecimal(+compact[6], +compact[7], +compact[8], compact[5]),
  };
  const trailing = normalized.match(COMPACT_TRAILING);
  if (trailing) return {
    latitude: dmsToDecimal(+trailing[1], +trailing[2], +trailing[3], trailing[4]),
    longitude: dmsToDecimal(+trailing[5], +trailing[6], +trailing[7], trailing[8]),
  };
  const parts = normalized.split(/[,;/]|\s{2,}/).map((part) => part.trim()).filter(Boolean);
  const result: { latitude?: number; longitude?: number } = {};
  for (const part of parts.length > 1 ? parts : [normalized]) {
    for (const match of part.matchAll(new RegExp(DMS.source, 'ig'))) {
      const hemi = (match[1] || match[5] || '').toUpperCase();
      const value = dmsToDecimal(+match[2], +match[3], +match[4], hemi);
      if (hemi === 'N' || hemi === 'S') result.latitude = value;
      if (hemi === 'E' || hemi === 'W') result.longitude = value;
    }
  }
  return result;
}

const R = 3440.065;
export function geodesicInverse(a: [number, number], b: [number, number]) {
  const [lon1, lat1, lon2, lat2] = [...a, ...b].map((v) => v * Math.PI / 180);
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const central = Math.acos(Math.max(-1, Math.min(1, Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLon))));
  return { distanceNm: central * R, initialBearing: bearing };
}
export function geodesicForward(start: [number, number], bearingDeg: number, distanceNm: number): [number, number] {
  const [lon1, lat1] = start.map((v) => v * Math.PI / 180); const brg = bearingDeg * Math.PI / 180; const d = distanceNm / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
  const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [((lon2 * 180 / Math.PI + 540) % 360) - 180, lat2 * 180 / Math.PI];
}
