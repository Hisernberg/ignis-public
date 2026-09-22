// IGNIS fire segmentation engine — deterministic, client-safe spatial analysis.
//
// Purpose (Challenge #9 add-on): turn the harmonized MODIS+VIIRS point record into
// ORGANIZED fire objects. Raw hotspots are pixels; incident commanders think in
// PERIMETERS. This module:
//   1. clusters visible detections with a grid-accelerated DBSCAN (adaptive eps),
//   2. computes a convex-hull BOUNDARY per cluster (monotone chain) + fire metrics,
//   3. classifies clusters (MEGAFIRE / ESTABLISHED / EMERGING / SCATTERED),
//   4. tracks persistence of fire systems across the multi-day replay window,
//   5. emits GeoJSON for MapLibre overlays.
// No external deps, runs in-browser on every style/panel render (<10 ms for ~10k pts).

import type { FirePoint } from './types';

// ---------- primitives ----------

export type SegPoint = { lat: number; lon: number; frp: number; conf: number | null; night: boolean; sat?: string; sensor: string; acq?: string; beh?: string; behP?: number };

export type ClusterClass = 'MEGAFIRE' | 'ESTABLISHED' | 'EMERGING' | 'SCATTERED';

export type FireCluster = {
  id: string;
  cls: ClusterClass;
  n: number;
  frpSum: number;
  frpMean: number;
  frpMax: number;
  hiPct: number;
  nightPct: number;
  sensors: Record<string, number>;
  centroid: [number, number]; // [lon, lat]
  hull: [number, number][];   // convex hull ring (lon,lat), not closed
  bbox: [number, number, number, number]; // w,s,e,n
  radiusKm: number;   // mean distance of members to centroid
  spreadKm: number;   // max pairwise-ish extent (centroid->farthest)
  areaKm2: number;    // hull area (spherical-ish correction)
  elongation: number; // perimeter / (2*sqrt(pi*area)) — 1 = circle, higher = fire-front like
  modelCls?: string;            // ML fire-behavior class (majority of member predictions)
  modelClsPct?: number;         // share of members voting for modelCls
  modelMix?: Record<string, number>; // full class mix of members
};

export type SegmentationResult = {
  clusters: FireCluster[];
  scattered: number;         // points not assigned to any cluster
  total: number;
  clusteredPct: number;
  epsDeg: number;
  minPts: number;
  topByFrp: FireCluster[];   // sorted desc
  behaviorMix?: Record<string, number>; // ML class distribution over ALL detections
};

// ---------- geo helpers ----------

const R_EARTH = 6371;

function cosLat(lat: number): number {
  return Math.max(0.2, Math.cos((lat * Math.PI) / 180));
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

function hullAreaKm2(ring: [number, number][], lat0: number): number {
  // shoelace on equirectangular km projection
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += (x2 - x1) * cosLat(lat0) * 111.32 * (y2 + y1) * 110.57;
  }
  return Math.abs(a / 2);
}

function hullPerimeterKm(ring: [number, number][], lat0: number): number {
  let p = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    p += Math.hypot((x2 - x1) * 111.32 * cosLat(y1), (y2 - y1) * 110.57);
  }
  return p;
}

/** Andrew's monotone chain convex hull. Returns open ring (first != last). */
export function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const ring = lower.concat(upper);
  return ring.length ? ring : points.slice(0, 3);
}

// ---------- DBSCAN (grid accelerated) ----------

function dbscan(points: SegPoint[], epsDeg: number, minPts: number): number[] {
  // returns cluster id per point, -1 = noise
  const n = points.length;
  const labels = new Array<number>(n).fill(-2); // -2 unvisited, -1 noise
  const cell = new Map<string, number[]>();
  const inv = 1 / epsDeg;
  for (let i = 0; i < n; i++) {
    const k = `${Math.floor(points[i].lon * inv)},${Math.floor(points[i].lat * inv)}`;
    (cell.get(k) || cell.set(k, []).get(k)!).push(i);
  }
  const neighbors = (i: number): number[] => {
    const cx = Math.floor(points[i].lon * inv), cy = Math.floor(points[i].lat * inv);
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const b = cell.get(`${cx + dx},${cy + dy}`);
        if (!b) continue;
        for (const j of b) {
          if (j === i) continue;
          const dLon = points[j].lon - points[i].lon, dLat = points[j].lat - points[i].lat;
          if (dLon * dLon + dLat * dLat <= epsDeg * epsDeg) out.push(j);
        }
      }
    return out;
  };
  let cid = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    const nb = neighbors(i);
    if (nb.length + 1 < minPts) { labels[i] = -1; continue; }
    labels[i] = cid;
    const queue = nb.slice();
    for (let qi = 0; qi < queue.length; qi++) {
      const j = queue[qi];
      if (labels[j] === -1) labels[j] = cid;
      if (labels[j] !== -2) continue;
      labels[j] = cid;
      const nb2 = neighbors(j);
      if (nb2.length + 1 >= minPts) queue.push(...nb2);
    }
    cid++;
  }
  return labels;
}

// ---------- classification ----------

export function classifyCluster(n: number, frpSum: number): ClusterClass {
  if (n >= 150 || frpSum >= 5000) return 'MEGAFIRE';
  if (n >= 40 || frpSum >= 1200) return 'ESTABLISHED';
  if (n >= 8) return 'EMERGING';
  return 'SCATTERED';
}

export const CLASS_STYLE: Record<ClusterClass, { fill: string; stroke: string; width: number; label: string }> = {
  MEGAFIRE: { fill: 'rgba(239,68,68,0.30)', stroke: '#FCA5A5', width: 2.4, label: 'Megafire cluster' },
  ESTABLISHED: { fill: 'rgba(249,115,22,0.22)', stroke: '#FDBA74', width: 1.8, label: 'Established fire' },
  EMERGING: { fill: 'rgba(250,204,21,0.16)', stroke: '#FDE047', width: 1.4, label: 'Emerging cluster' },
  SCATTERED: { fill: 'rgba(148,163,184,0.10)', stroke: '#94A3B8', width: 1.0, label: 'Scattered activity' },
};

// ---------- main segmentation ----------

export function segmentFires(
  bbox: number[],
  sensors: Record<string, { points: FirePoint[] }>,
  opts?: { epsDeg?: number; minPts?: number },
): SegmentationResult {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1], 1);
  const epsDeg = opts?.epsDeg ?? Math.min(0.9, Math.max(0.14, +(span / 45).toFixed(2)));
  const minPts = opts?.minPts ?? 3;

  // tag each point with its sensor
  const pts: SegPoint[] = [];
  for (const [sensor, s] of Object.entries(sensors)) {
    for (const p of s.points) pts.push({ lat: p.lat, lon: p.lon, frp: p.frp || 0.5, conf: p.conf, night: p.night, sat: p.sat, sensor, acq: p.acq, beh: p.beh, behP: p.behP });
  }
  if (!pts.length) {
    return { clusters: [], scattered: 0, total: 0, clusteredPct: 0, epsDeg, minPts, topByFrp: [], behaviorMix: {} };
  }

  const labels = dbscan(pts, epsDeg, minPts);
  const groups = new Map<number, number[]>();
  let scattered = 0;
  for (let i = 0; i < pts.length; i++) {
    const l = labels[i];
    if (l < 0) { scattered++; continue; }
    (groups.get(l) || groups.set(l, []).get(l)!).push(i);
  }

  const clusters: FireCluster[] = [];
  let idCounter = 1;
  for (const members of groups.values()) {
    const m = members.map((i) => pts[i]);
    const n = m.length;
    const frpSum = m.reduce((a, p) => a + p.frp, 0);
    const lon = m.reduce((a, p) => a + p.lon, 0) / n;
    const lat = m.reduce((a, p) => a + p.lat, 0) / n;
    const hull = convexHull(m.map((p) => [p.lon, p.lat] as [number, number]));
    let radiusKm = 0, spreadKm = 0;
    for (const p of m) {
      const d = haversineKm(lat, lon, p.lat, p.lon);
      radiusKm += d;
      if (d > spreadKm) spreadKm = d;
    }
    radiusKm /= n;
    const areaKm2 = hull.length >= 3 ? hullAreaKm2(hull, lat) : Math.PI * radiusKm * radiusKm;
    const perKm = hull.length >= 3 ? hullPerimeterKm(hull, lat) : 2 * Math.PI * radiusKm;
    const elongation = areaKm2 > 1 ? perKm / (2 * Math.sqrt(Math.PI * areaKm2)) : 1;
    const sensorsMap: Record<string, number> = {};
    let hi = 0, night = 0;
    for (const p of m) {
      sensorsMap[p.sensor] = (sensorsMap[p.sensor] || 0) + 1;
      if (p.night) night++;
      if ((p.conf ?? 0) >= 70 || p.conf === null) hi++;
    }
    const bminLon = Math.min(...m.map((p) => p.lon)), bmaxLon = Math.max(...m.map((p) => p.lon));
    const bminLat = Math.min(...m.map((p) => p.lat)), bmaxLat = Math.max(...m.map((p) => p.lat));
    // ML fire-behavior majority (ignis-fire-classifier predictions carried on points)
    const mix: Record<string, number> = {};
    for (const p of m) if (p.beh) mix[p.beh] = (mix[p.beh] || 0) + 1;
    let modelCls: string | undefined;
    let modelN = 0;
    let mixTotal = 0;
    for (const [k, v] of Object.entries(mix)) {
      mixTotal += v;
      if (v > modelN) { modelN = v; modelCls = k; }
    }
    for (const k of Object.keys(mix)) mix[k] = Math.round((mix[k] / Math.max(1, mixTotal)) * 100);
    clusters.push({
      id: `F-${String(idCounter++).padStart(3, '0')}`,
      cls: classifyCluster(n, frpSum),
      n, frpSum, frpMean: frpSum / n, frpMax: Math.max(...m.map((p) => p.frp)),
      hiPct: (hi / n) * 100, nightPct: (night / n) * 100,
      sensors: sensorsMap,
      centroid: [+lon.toFixed(4), +lat.toFixed(4)],
      hull,
      bbox: [bminLon, bminLat, bmaxLon, bmaxLat],
      radiusKm: +radiusKm.toFixed(1),
      spreadKm: +spreadKm.toFixed(1),
      areaKm2: +areaKm2.toFixed(0),
      elongation: +elongation.toFixed(2),
      modelCls,
      modelClsPct: mixTotal ? Math.round((modelN / mixTotal) * 100) : undefined,
      modelMix: Object.keys(mix).length ? mix : undefined,
    });
  }
  clusters.sort((a, b) => b.frpSum - a.frpSum);
  // ML class distribution over ALL detections (clustered + scattered)
  const behaviorMix: Record<string, number> = {};
  for (const p of pts) if (p.beh) behaviorMix[p.beh] = (behaviorMix[p.beh] || 0) + 1;
  return {
    clusters,
    scattered,
    total: pts.length,
    clusteredPct: pts.length ? ((pts.length - scattered) / pts.length) * 100 : 0,
    epsDeg, minPts,
    topByFrp: clusters.slice(0, 12),
    behaviorMix,
  };
}

// ---------- persistence tracking across days ----------

export type FireTrack = {
  id: string;
  firstDay: string;
  lastDay: string;
  daysSeen: number;
  latestClass: ClusterClass;
  peakFrp: number;
  latestFrp: number;
  frpTrend: number;       // (last - first) / max(first, 1) — >0 growing, <0 shrinking
  latestCount: number;
  trail: [number, number][]; // centroid path [lon,lat]
};

/**
 * Greedy nearest-centroid tracker across a chronologically sorted list of
 * daily segmentations. A cluster joins a track if its centroid is within
 * `maxGapKm` of the track's last known centroid.
 */
export function trackPersistence(
  daily: { day: string; clusters: FireCluster[] }[],
  maxGapKm = 60,
): FireTrack[] {
  type Internal = FireTrack & { trailFrp0: number; open: boolean };
  const tracks: Internal[] = [];
  for (const { day, clusters } of daily) {
    const used = new Set<number>();
    for (const t of tracks) t.open = true;
    for (const c of clusters) {
      let best: Internal | null = null;
      let bestD = Infinity;
      for (const t of tracks) {
        if (!t.open || used.has(tracks.indexOf(t))) continue;
        const last = t.trail[t.trail.length - 1];
        const d = haversineKm(last[1], last[0], c.centroid[1], c.centroid[0]);
        if (d < bestD) { bestD = d; best = t; }
      }
      if (best && bestD <= maxGapKm) {
        used.add(tracks.indexOf(best));
        best.lastDay = day;
        best.daysSeen++;
        best.latestClass = c.cls;
        best.peakFrp = Math.max(best.peakFrp, c.frpSum);
        best.latestFrp = c.frpSum;
        best.frpTrend = (c.frpSum - best.trailFrp0) / Math.max(best.trailFrp0, 1);
        best.latestCount = c.n;
        best.trail.push(c.centroid);
        best.open = false;
      } else {
        tracks.push({
          id: `SYS-${String(tracks.length + 1).padStart(3, '0')}`,
          firstDay: day, lastDay: day, daysSeen: 1,
          latestClass: c.cls, peakFrp: c.frpSum, latestFrp: c.frpSum,
          frpTrend: 0, latestCount: c.n,
          trail: [c.centroid],
          trailFrp0: c.frpSum,
          open: true,
        });
      }
    }
  }
  return tracks
    .filter((t) => t.latestFrp > 0)
    .map(({ trailFrp0: _f, open: _o, ...rest }) => rest as FireTrack)
    .sort((a, b) => b.latestFrp - a.latestFrp);
}

// ---------- GeoJSON emission ----------

export function clustersToGeoJSON(clusters: FireCluster[]): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: clusters.map((c) => ({
      type: 'Feature',
      properties: { id: c.id, cls: c.cls, modelCls: c.modelCls ?? '', modelClsPct: c.modelClsPct ?? 0, n: c.n, frp: Math.round(c.frpSum), meanFrp: +c.frpMean.toFixed(1), spreadKm: c.spreadKm, areaKm2: c.areaKm2, elongation: c.elongation, nightPct: +c.nightPct.toFixed(0), hiPct: +c.hiPct.toFixed(0), sensors: Object.keys(c.sensors).join(',') },
      geometry: { type: 'Polygon', coordinates: [[...c.hull, c.hull[0]]] },
    })) as unknown as GeoJSONFeature[],
  };
}

// minimal GeoJSON typings (avoid @types/geojson dependency)
export type GeoJSONFeature = { type: 'Feature'; properties: Record<string, string | number>; geometry: unknown };
export type GeoJSONFeatureCollection = { type: 'FeatureCollection'; features: GeoJSONFeature[] };

// ---------- FRP histogram ----------

export const FRP_BINS: [number, number, string][] = [
  [0, 5, '<5'], [5, 10, '5–10'], [10, 25, '10–25'], [25, 60, '25–60'],
  [60, 120, '60–120'], [120, 250, '120–250'], [250, 500, '250–500'], [500, Infinity, '500+'],
];

export function frpHistogram(points: FirePoint[]): { label: string; n: number }[] {
  return FRP_BINS.map(([lo, hi, label]) => ({
    label,
    n: points.filter((p) => (p.frp || 0.5) >= lo && (p.frp || 0.5) < hi).length,
  }));
}

/** Parse FIRMS "acq_time" (HHMM or HHMMSS, UTC) into hour-of-day bucket. */
export function acqHour(acq?: string): number | null {
  if (!acq) return null;
  const m = acq.replace(':', '').match(/^(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  return h >= 0 && h <= 23 ? h : null;
}
