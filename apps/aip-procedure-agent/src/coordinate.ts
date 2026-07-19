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
  // 先在整串上扫。度分秒符号被换成空格后，"02° 03' 57.10\" N" 变成 "02  03  57.10  N"，
  // 而按 2 个以上空白切分恰好把这一组切碎（-> 'ADLOV 02' / '03' / '57.10' / 'N 103'…），
  // 结果是转写出来的坐标表一个都读不出来。DMS 正则自带半球符锚点，整串扫不会误配。
  const whole = scanDms(normalized);
  if (Number.isFinite(whole.latitude) && Number.isFinite(whole.longitude)) return whole;
  // 兜底：整串扫不出成对经纬度时，再按分隔符切开逐段试（应对同一行里挤了多组坐标的表格）。
  const parts = normalized.split(/[,;/]|\s{2,}/).map((part) => part.trim()).filter(Boolean);
  const result: { latitude?: number; longitude?: number } = { ...whole };
  for (const part of parts.length > 1 ? parts : [normalized]) {
    const scanned = scanDms(part);
    if (Number.isFinite(scanned.latitude)) result.latitude = scanned.latitude;
    if (Number.isFinite(scanned.longitude)) result.longitude = scanned.longitude;
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

// 扫描用的两条正则都**强制**要求半球符，位置分别在数字组之后与之前。
// 不能用 DMS（它的半球符两端都可选）：那样 "KJ706 01 37 03.66 N" 会先在 "706 01 37" 上
// 匹配成一个无半球符的三元组、被丢弃，同时把扫描位置推过了真正的度分秒，
// 于是带数字的航路点名（KJ706）读不出坐标，而不带数字的（ADLOV）却能读出来。
const DMS_HEMISPHERE_LAST = /(\d{1,3})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s+([NSEW])/gi;
const DMS_HEMISPHERE_FIRST = /([NSEW])\s*(\d{1,3})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)/gi;

/** 扫出一段文本里的度分秒经纬度。半球符是硬要求，因此不会误把表格里的数字当坐标。 */
function scanDms(text: string): { latitude?: number; longitude?: number } {
  for (const [pattern, hemisphereFirst] of [[DMS_HEMISPHERE_LAST, false], [DMS_HEMISPHERE_FIRST, true]] as const) {
    const out: { latitude?: number; longitude?: number } = {};
    for (const match of text.matchAll(pattern)) {
      const hemisphere = String(hemisphereFirst ? match[1] : match[4]).toUpperCase();
      const [d, m, s] = hemisphereFirst ? [match[2], match[3], match[4]] : [match[1], match[2], match[3]];
      let value: number;
      try { value = dmsToDecimal(+d, +m, +s, hemisphere); } catch { continue; }
      if (hemisphere === 'N' || hemisphere === 'S') out.latitude ??= value;
      if (hemisphere === 'E' || hemisphere === 'W') out.longitude ??= value;
    }
    if (Number.isFinite(out.latitude) && Number.isFinite(out.longitude)) return out;
  }
  return {};
}
