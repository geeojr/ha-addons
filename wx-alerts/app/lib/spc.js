'use strict';
/*
 * SPC convective outlook: the categorical risk at a point.
 *
 * The Storm Prediction Center publishes each day's categorical outlook as GeoJSON
 * (one feature per risk area: TSTM, MRGL, SLGT, ENH, MDT, HIGH). This module parses that
 * file and answers "what is the risk level at lat/lon" with a plain number so automations
 * can compare on it:
 *
 *   0 none   1 general thunderstorms   2 marginal   3 slight   4 enhanced   5 moderate   6 high
 *
 * Risk areas can be nested (a slight polygon inside a marginal one), so the level at a point
 * is the highest area that contains it.
 */

const LEVELS = [
  { level: 0, code: 'NONE', label: 'None' },
  { level: 1, code: 'TSTM', label: 'General Thunderstorms' },
  { level: 2, code: 'MRGL', label: 'Marginal Risk' },
  { level: 3, code: 'SLGT', label: 'Slight Risk' },
  { level: 4, code: 'ENH', label: 'Enhanced Risk' },
  { level: 5, code: 'MDT', label: 'Moderate Risk' },
  { level: 6, code: 'HIGH', label: 'High Risk' },
];
const BY_CODE = Object.fromEntries(LEVELS.map((l) => [l.code, l]));
const url = (day = 1) => `https://www.spc.noaa.gov/products/outlook/day${day}otlk_cat.nolyr.geojson`;

/** Ray casting: is [lon, lat] inside one linear ring? */
function inRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Polygon coordinates = [outer, hole, hole...]. */
const inPolygon = (rings, lon, lat) => rings.length > 0 && inRing(rings[0], lon, lat) && !rings.slice(1).some((h) => inRing(h, lon, lat));
function inGeometry(geom, lon, lat) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return inPolygon(geom.coordinates, lon, lat);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((p) => inPolygon(p, lon, lat));
  if (geom.type === 'GeometryCollection') return (geom.geometries || []).some((g) => inGeometry(g, lon, lat));
  return false;
}

/** SPC timestamps are "YYYYMMDDHHMM" UTC (the *_ISO fields exist too but not on every product). */
function spcTime(p, key) {
  const iso = p[key + '_ISO']; if (iso) return new Date(iso).toISOString();
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)$/.exec(String(p[key] || ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])).toISOString() : null;
}

/** Parse the SPC GeoJSON into { issued, valid, expire, forecaster, areas:[{level, code, label, geometry}] }. */
function parse(geojson, day = 1) {
  const feats = (geojson && geojson.features) || [];
  const areas = [];
  for (const f of feats) {
    const p = f.properties || {};
    const def = BY_CODE[String(p.LABEL || '').toUpperCase()];
    if (!def || !f.geometry) continue; // unknown label (should not happen) - ignore rather than guess
    areas.push({ ...def, geometry: f.geometry });
  }
  const p0 = (feats[0] || {}).properties || {};
  return { day, issued: spcTime(p0, 'ISSUE'), valid: spcTime(p0, 'VALID'), expire: spcTime(p0, 'EXPIRE'), forecaster: p0.FORECASTER || null, areas, fetched_at: new Date().toISOString() };
}

/** Highest risk area containing the point. Always returns a level (0 when outside every area). */
function levelAt(outlook, lat, lon) {
  let best = LEVELS[0];
  for (const a of (outlook && outlook.areas) || []) if (a.level > best.level && inGeometry(a.geometry, lon, lat)) best = a;
  return { level: best.level, code: best.code, label: best.label };
}

module.exports = { LEVELS, url, parse, levelAt, inGeometry };
