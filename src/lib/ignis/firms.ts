// Server-side harmonized data layer
// Primary:  NASA FIRMS area API (MAP_KEY) — real NRT detections, dayRange up to 10
// Fallback: NASA GIBS WMTS vector tiles (FIRMS-derived thermal anomalies, archive to 2000)
import zlib from 'node:zlib';
import Protobuf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { KEYS } from './keys';

export type FirePoint = {
  lat: number; lon: number; frp: number; conf: number | null; confRaw?: string;
  night: boolean; sat?: string; date?: string; acq?: string; beh?: string; behP?: number;
};
export type SensorHotspots = {
  points: FirePoint[]; count: number; meanFrp: number; maxFrp: number;
  hiConf: number; nightPct: number; source: string; dayUsed: string; clamped?: boolean;
};
export type HotspotsResult = { source: 'firms-api' | 'gibs-mvt' | 'mixed'; day: string; sensors: Record<string, SensorHotspots>; note?: string };
export type MultiHotspots = { source: 'firms-api' | 'gibs-mvt' | 'mixed'; days: Record<string, HotspotsResult>; note?: string };

export const SENSORS = ['MODIS-Terra', 'MODIS-Aqua', 'VIIRS-SNPP', 'VIIRS-NOAA20', 'VIIRS-NOAA21'] as const;
export type SensorKey = (typeof SENSORS)[number];

const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov';
const FIRMS_SOURCE: Partial<Record<SensorKey, string>> = {
  'MODIS-Terra': 'MODIS_NRT', // satellite column 'T'
  'MODIS-Aqua': 'MODIS_NRT', // satellite column 'A'
  'VIIRS-SNPP': 'VIIRS_SNPP_NRT',
  'VIIRS-NOAA20': 'VIIRS_NOAA20_NRT',
  'VIIRS-NOAA21': 'VIIRS_NOAA21_NRT',
};

export const GIBS_LATEST: Record<SensorKey, string> = {
  'MODIS-Terra': '2026-09-20',
  'MODIS-Aqua': '2026-09-19',
  'VIIRS-SNPP': '2026-07-16',
  'VIIRS-NOAA20': '2025-12-23',
  'VIIRS-NOAA21': '2026-09-19',
};

const GIBS_LAYER: Record<SensorKey, { layer: string; tms: string }> = {
  'MODIS-Terra': { layer: 'MODIS_Terra_Thermal_Anomalies_All', tms: '1km' },
  'MODIS-Aqua': { layer: 'MODIS_Aqua_Thermal_Anomalies_All', tms: '1km' },
  'VIIRS-SNPP': { layer: 'VIIRS_SNPP_Thermal_Anomalies_375m_All', tms: '500m' },
  'VIIRS-NOAA20': { layer: 'VIIRS_NOAA20_Thermal_Anomalies_375m_All', tms: '500m' },
  'VIIRS-NOAA21': { layer: 'VIIRS_NOAA21_Thermal_Anomalies_375m_All', tms: '500m' },
};

// ---------- confidence harmonization: MODIS 0-100 numeric; VIIRS l/n/h -> 30/60/90 ----------
export function harmonizeConf(raw: string | number | null | undefined): { num: number | null; raw?: string } {
  if (raw === null || raw === undefined || raw === '') return { num: null };
  const s = String(raw).trim().toLowerCase();
  if (s === 'l') return { num: 30, raw: 'l' };
  if (s === 'n') return { num: 60, raw: 'n' };
  if (s === 'h') return { num: 90, raw: 'h' };
  const n = Number(s);
  return Number.isFinite(n) ? { num: Math.round(n) } : { num: null, raw: s };
}

function fmtAcq(hhmm: string | undefined): string | undefined {
  if (!hhmm) return undefined;
  const t = hhmm.trim().padStart(4, '0');
  return `${t.slice(0, 2)}:${t.slice(2)} UTC`;
}

// ---------- FIRMS CSV ----------
function parseFirmsCsv(csv: string): FirePoint[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = (n: string) => head.indexOf(n);
  const iLat = idx('latitude'), iLon = idx('longitude'), iFr = idx('frp'), iConf = idx('confidence');
  const iDn = idx('daynight'), iSat = idx('satellite'), iDate = idx('acq_date'), iAcq = idx('acq_time');
  const out: FirePoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < head.length) continue;
    const { num } = harmonizeConf(iConf >= 0 ? c[iConf] : null);
    out.push({
      lat: Number(c[iLat]), lon: Number(c[iLon]),
      frp: Number(c[iFr]) || 0,
      conf: num, confRaw: iConf >= 0 ? c[iConf] : undefined,
      night: iDn >= 0 ? c[iDn] === 'N' : false,
      sat: iSat >= 0 ? c[iSat] : undefined,
      date: iDate >= 0 ? c[iDate] : undefined,
      acq: fmtAcq(iAcq >= 0 ? c[iAcq] : undefined),
    });
  }
  return out;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

type FirmsFetch = { ok: boolean; rows: FirePoint[]; reason?: string };

async function firmsFetch(source: string, bbox: number[], dayRange: number, endDate: string | undefined): Promise<FirmsFetch> {
  const key = KEYS.FIRMS_MAP_KEY;
  if (!key) return { ok: false, rows: [], reason: 'no key' };
  const [w, s, e, n] = bbox;
  const url = `${FIRMS_BASE}/api/area/csv/${key}/${source}/${w},${s},${e},${n}/${dayRange}${endDate ? `/${endDate}` : ''}`;
  try {
    const res = await fetchWithTimeout(url, 30000);
    if (!res.ok) return { ok: false, rows: [], reason: `HTTP ${res.status}` };
    const text = await res.text();
    if (/invalid|error|unauthorized/i.test(text.slice(0, 80))) return { ok: false, rows: [], reason: text.slice(0, 60) };
    return { ok: true, rows: parseFirmsCsv(text) };
  } catch (err) {
    return { ok: false, rows: [], reason: `unreachable (${(err as Error).name})` };
  }
}

// ---------- GIBS MVT fallback ----------
function tilesForBbox([w, s, e, n]: number[], cols: number, rows: number, tileDeg: number) {
  const out: [number, number][] = [];
  const c0 = Math.max(0, Math.floor((w + 180) / tileDeg)), c1 = Math.min(cols - 1, Math.floor((e + 180) / tileDeg));
  const r0 = Math.max(0, Math.floor((90 - n) / tileDeg)), r1 = Math.min(rows - 1, Math.floor((90 - s) / tileDeg));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push([r, c]);
  return out;
}

async function gibsTilePoints(sensor: SensorKey, day: string, z: number, r: number, c: number): Promise<FirePoint[]> {
  const cfg = GIBS_LAYER[sensor];
  const url = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${cfg.layer}/default/${day}/${cfg.tms}/${z}/${r}/${c}.mvt`;
  try {
    const res = await fetchWithTimeout(url, 12000);
    if (!res.ok) return [];
    const buf = Buffer.from(await res.arrayBuffer());
    const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
    const tile = new VectorTile(new Protobuf(raw));
    const key = Object.keys(tile.layers)[0];
    if (!key) return [];
    const L = tile.layers[key];
    const pts: FirePoint[] = [];
    for (let i = 0; i < L.length; i++) {
      const p = L.feature(i).properties as Record<string, string | number>;
      const { num } = harmonizeConf(p.CONFIDENCE ?? null);
      pts.push({
        lat: Number(p.LATITUDE), lon: Number(p.LONGITUDE),
        frp: Number(p.FRP) || 0, conf: num, confRaw: p.CONFIDENCE !== undefined ? String(p.CONFIDENCE) : undefined,
        night: String(p.DAYNIGHT) === 'N', sat: p.SATELLITE !== undefined ? String(p.SATELLITE) : undefined, date: day,
      });
    }
    return pts;
  } catch {
    return [];
  }
}

async function gibsSensor(sensor: SensorKey, bbox: number[], day: string): Promise<SensorHotspots> {
  let dayUsed = day;
  let clamped = false;
  if (day > GIBS_LATEST[sensor]) { dayUsed = GIBS_LATEST[sensor]; clamped = true; }
  const z = 5; // 9-degree tiles (40x20 grid)
  const tiles = tilesForBbox(bbox, 40, 20, 9);
  let points = (await Promise.all(tiles.map(([r, c]) => gibsTilePoints(sensor, dayUsed, z, r, c)))).flat();
  if (points.length === 0 && !clamped) {
    const d2 = new Date(new Date(dayUsed + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
    const t2 = (await Promise.all(tiles.map(([r, c]) => gibsTilePoints(sensor, d2, z, r, c)))).flat();
    if (t2.length > 0) { points = t2; dayUsed = d2; }
  }
  const [w, s, e, n] = bbox;
  points = points.filter((p) => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n);
  return summarize(points, 'gibs-mvt', dayUsed, clamped);
}

function summarize(points: FirePoint[], source: string, dayUsed: string, clamped?: boolean): SensorHotspots {
  const frps = points.map((p) => p.frp);
  const meanFrp = points.length ? +(frps.reduce((a, b) => a + b, 0) / points.length).toFixed(1) : 0;
  const maxFrp = points.length ? +Math.max(...frps).toFixed(1) : 0;
  const hiConf = points.filter((p) => (p.conf ?? 0) >= 80).length;
  const night = points.filter((p) => p.night).length;
  return {
    points: points.slice(0, 4000), count: points.length, meanFrp, maxFrp, hiConf,
    nightPct: points.length ? +((night / points.length) * 100).toFixed(1) : 0,
    source, dayUsed, clamped,
  };
}

// ---------- public: multi-day harmonized fetch ----------
const cache = new Map<string, { at: number; data: MultiHotspots }>();
const TTL = 10 * 60 * 1000;

function isOld(day: string): boolean {
  return new Date(day + 'T00:00:00Z').getTime() < Date.now() - 95 * 86400000;
}

function contiguChunks(days: string[]): string[][] {
  const sorted = [...days].sort();
  const chunks: string[][] = [];
  let cur: string[] = [];
  for (const d of sorted) {
    if (!cur.length) { cur = [d]; continue; }
    const prev = new Date(cur[cur.length - 1] + 'T00:00:00Z').getTime();
    const now = new Date(d + 'T00:00:00Z').getTime();
    if ((now - prev) / 86400000 === 1 && cur.length < 10) cur.push(d);
    else { chunks.push(cur); cur = [d]; }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export async function getHotspotsRange(bbox: number[], days: string[]): Promise<MultiHotspots> {
  const uniq = [...new Set(days)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!uniq.length) uniq.push(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  const key = `${bbox.join(',')}|${uniq.join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  const result: Record<string, HotspotsResult> = {};
  uniq.forEach((d) => { result[d] = { source: 'gibs-mvt', day: d, sensors: {} }; });
  let usedFirms = false;
  let usedGibs = false;
  const firmsRows: Partial<Record<SensorKey, Map<string, FirePoint[]>>> = {};

  if (KEYS.FIRMS_MAP_KEY) {
    // Group sources: MODIS_NRT once (split T/A), VIIRS each
    const sources = [...new Set(Object.values(FIRMS_SOURCE))] as string[];
    const chunks = contiguChunks(uniq);
    const jobs: Array<{ sensorSource: string; rows: FirePoint[]; ok: boolean }> = [];
    await Promise.all(sources.map(async (src) => {
      for (const ch of chunks) {
        // FIRMS area API semantics: DATE = first day of the window, DAY_RANGE counts forward
        const startDate = ch[0];
        const r = await firmsFetch(src, bbox, ch.length, startDate);
        jobs.push({ sensorSource: src, rows: r.ok ? r.rows : [], ok: r.ok });
      }
    }));
    const bySrc: Record<string, FirePoint[]> = {};
    let anyOk = false;
    for (const j of jobs) { if (j.ok) { anyOk = true; bySrc[j.sensorSource] = (bySrc[j.sensorSource] || []).concat(j.rows); } }
    if (anyOk) {
      usedFirms = true;
      for (const sensor of SENSORS) {
        const src = FIRMS_SOURCE[sensor] || '';
        const all = (bySrc[src] || []).filter((p) => {
          const s = (p.sat || '').toUpperCase();
          if (sensor === 'MODIS-Terra') return s.startsWith('T');
          if (sensor === 'MODIS-Aqua') return s.startsWith('A');
          return true; // per-source VIIRS feeds
        });
        firmsRows[sensor] = new Map();
        for (const p of all) {
          const d = p.date || uniq[uniq.length - 1];
          const arr = firmsRows[sensor]!.get(d) || [];
          arr.push(p);
          firmsRows[sensor]!.set(d, arr);
        }
      }
    }
  }

  // Assemble per day; GIBS fallback where FIRMS failed or (empty + old date, archive may be unsupported)
  for (const day of uniq) {
    const sensors: Record<string, SensorHotspots> = {};
    const perSensorSource: string[] = [];
    for (const sensor of SENSORS) {
      const firmsPts = usedFirms ? firmsRows[sensor]?.get(day) : undefined;
      const old = isOld(day);
      if (firmsPts && (firmsPts.length > 0 || !old)) {
        sensors[sensor] = summarize(firmsPts, 'firms-api', day);
        perSensorSource.push('firms-api');
      } else {
        const g = await gibsSensor(sensor, bbox, day);
        sensors[sensor] = g;
        perSensorSource.push('gibs-mvt');
        usedGibs = true;
      }
    }
    const allFirms = perSensorSource.every((s) => s === 'firms-api');
    const anyFirms = perSensorSource.some((s) => s === 'firms-api');
    result[day] = {
      source: allFirms ? 'firms-api' : anyFirms ? 'mixed' : 'gibs-mvt',
      day,
      sensors,
      note: allFirms
        ? 'NASA FIRMS area API — near-real-time active fire detections (MODIS Terra+Aqua C6.1, VIIRS S-NPP/NOAA-20/NOAA-21 V2)'
        : 'NASA GIBS WMTS vector tiles (FIRMS-derived thermal anomalies) — fallback path',
    };
  }

  const source: MultiHotspots['source'] = usedFirms && !usedGibs ? 'firms-api' : usedFirms ? 'mixed' : 'gibs-mvt';
  const data: MultiHotspots = {
    source,
    days: result,
    note: source === 'firms-api'
      ? 'NASA FIRMS area API — near-real-time active fire detections (MODIS Terra+Aqua C6.1, VIIRS S-NPP/NOAA-20/NOAA-21 V2)'
      : source === 'mixed'
        ? 'FIRMS where reachable + GIBS MVT fallback'
        : 'NASA GIBS WMTS vector tiles (FIRMS-derived thermal anomalies). FIRMS API unreachable from this host — production deployments use FIRMS NRT directly.',
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

export async function getHotspots(bbox: number[], day: string): Promise<HotspotsResult> {
  const multi = await getHotspotsRange(bbox, [day]);
  return multi.days[day];
}

// ---------- public: GIBS fire-pixel GeoJSON (independent cross-check layer) ----------
// Parses GIBS WMTS vector tiles (FIRMS-derived thermal anomalies, epsg4326 '1km'/'500m' TMS,
// z5 9-degree grid — verified live) server-side and returns plain GeoJSON so the browser
// never touches the MVT/projection mismatch. This is the CORRECTED replacement for the
// previous client raster overlay that requested MODIS_Terra_Thermal_Anomalies_All .png
// from epsg3857 — a format/level combination GIBS does not serve (hence the HTTP 400s).
export type GibsFireFc = {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: { sensor: SensorKey; frp: number; conf: number | null; night: boolean; sat: string; day: string };
    geometry: { type: 'Point'; coordinates: [number, number] };
  }>;
  note: string;
};

export async function getGibsFiresGeoJSON(bbox: number[], day: string): Promise<GibsFireFc> {
  const results = await Promise.all(SENSORS.map((sensor) => gibsSensor(sensor, bbox, day)));
  const features: GibsFireFc['features'] = [];
  outer: for (let si = 0; si < SENSORS.length; si++) {
    for (const p of results[si].points) {
      if (features.length >= 6000) break outer;
      features.push({
        type: 'Feature',
        properties: {
          sensor: SENSORS[si], frp: p.frp, conf: p.conf, night: p.night, sat: p.sat ?? '', day,
        },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      });
    }
  }
  return {
    type: 'FeatureCollection',
    features,
    note: 'NASA GIBS WMTS vector tiles (FIRMS-derived thermal anomalies) — independent GIBS-side render used to cross-check the FIRMS NRT pipeline',
  };
}
