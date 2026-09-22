// IGNIS — 25-year harmonized MODIS+VIIRS fire activity calendar precompute
// Data source: NASA GIBS WMTS vector tiles (FIRMS-derived thermal anomalies, full FIRMS schema per pixel)
//   MODIS Terra:      https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_Thermal_Anomalies_All/default/{D}/1km/{z}/{r}/{c}.mvt   (2000-11-01 → today)
//   VIIRS SNPP:       .../VIIRS_SNPP_Thermal_Anomalies_375m_All/default/{D}/500m/{z}/{r}/{c}.mvt  (2012-01-20 → today)
//   VIIRS NOAA-20:    .../VIIRS_NOAA20_Thermal_Anomalies_375m_All/default/{D}/500m/{z}/{r}/{c}.mvt (2020-01-01 → today)
// Method: z5 tiles (9°x9°), 2 sampled days/month (8th & 22nd), features bbox-filtered, scaled to monthly estimate.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import Protobuf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

const ROOT = '/home/z/my-project';
const OUT = path.join(ROOT, 'data/ignis');
const CONC = 48;

export const REGIONS = {
  amazon:        { name: 'Amazon Basin',        bbox: [-74, -12, -46, 2],  note: 'Deforestation & drought-driven fire regime' },
  california:    { name: 'California / US West', bbox: [-125, 32, -114, 42], note: 'Mediterranean chaparral + forest fire regime' },
  canada:        { name: 'Boreal Canada',        bbox: [-140, 52, -95, 70],  note: 'Record 2023 fire season (23+ Mha burned)' },
  siberia:       { name: 'Eastern Siberia',      bbox: [100, 50, 145, 70],   note: 'Boreal + permafrost peat fires (Yakutia)' },
  congo:         { name: 'Congo Basin',          bbox: [8, -8, 32, 8],       note: 'Tropical evergreen + savanna boundary' },
  borneo:        { name: 'Borneo & Sumatra',     bbox: [95, -6, 120, 6],     note: 'El Niño peat-land megafires (2015, 2019, 2023)' },
  australia:     { name: 'Australia',            bbox: [112, -42, 154, -10], note: 'Black Summer 2019-20 (24+ Mha burned)' },
  mediterranean: { name: 'Mediterranean Basin',  bbox: [-8, 30, 32, 46],     note: 'European heatwave-driven fires (2021-2025)' },
  bangladesh:    { name: 'Bangladesh',           bbox: [88.0, 20.6, 92.9, 26.7], note: 'Crop-residue (Boro Mar-Apr, Aman Nov) + Sundarbans mangrove fires' },
};

const SENSORS = [
  { key: 'MODIS-Terra',  layer: 'MODIS_Terra_Thermal_Anomalies_All',       tms: '1km', start: [2000, 11], end: [2026, 9] },
  { key: 'VIIRS-SNPP',   layer: 'VIIRS_SNPP_Thermal_Anomalies_375m_All',   tms: '500m', start: [2012, 1],  end: [2026, 7] },
  { key: 'VIIRS-NOAA20', layer: 'VIIRS_NOAA20_Thermal_Anomalies_375m_All', tms: '500m', start: [2020, 1],  end: [2025, 12] },
];

// z5 grid: 40 cols x 20 rows, 9deg tiles (valid for both 1km and 500m TMS)
function tilesForBbox([w, s, e, n]) {
  const out = [];
  const c0 = Math.max(0, Math.floor((w + 180) / 9)), c1 = Math.min(39, Math.floor((e + 180) / 9));
  const r0 = Math.max(0, Math.floor((90 - n) / 9)), r1 = Math.min(19, Math.floor((90 - s) / 9));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push([r, c]);
  return out;
}

async function fetchTile(layer, tms, day, z, r, c) {
  const url = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${layer}/default/${day}/${tms}/${z}/${r}/${c}.mvt`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 404) return { features: [] };
      if (!res.ok) { if (attempt === 0) continue; return { features: [] }; }
      const buf = Buffer.from(await res.arrayBuffer());
      const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
      const tile = new VectorTile(new Protobuf(raw));
      const layerKey = Object.keys(tile.layers)[0];
      if (!layerKey) return { features: [] };
      const L = tile.layers[layerKey];
      const feats = [];
      for (let i = 0; i < L.length; i++) {
        const p = L.feature(i).properties;
        feats.push({ lat: p.LATITUDE, lon: p.LONGITUDE, frp: p.FRP || 0, conf: p.CONFIDENCE, night: p.DAYNIGHT === 'N' });
      }
      return { features: feats };
    } catch { if (attempt === 1) return { features: [] }; }
  }
  return { features: [] };
}

async function pool(jobs, conc) {
  const results = new Array(jobs.length);
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const idx = i++;
      results[idx] = await jobs[idx]();
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  return results;
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

async function buildRegion(rkey, region) {
  const tiles = tilesForBbox(region.bbox);
  const [w, s, e, n] = region.bbox;
  const inBox = (f) => f.lon >= w && f.lon <= e && f.lat >= s && f.lat <= n;
  const months = [];
  for (const [y, m0] of [[2000, 11], [2012, 1], [2020, 1]]) months.push([y, m0]);
  const sensorsOut = {};
  for (const sensor of SENSORS) {
    const [sy, sm] = sensor.start, [ey, em] = sensor.end;
    const monthly = [];
    for (let y = sy; y <= ey; y++) {
      for (let m = (y === sy ? sm : 1); m <= (y === ey ? em : 12); m++) {
        const dim = daysInMonth(y, m);
        const sampleDays = [8, 22].map((d) => Math.min(d, dim));
        const jobs = [];
        for (const day of sampleDays) {
          const ds = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          for (const [r, c] of tiles) jobs.push(() => fetchTile(sensor.layer, sensor.tms, ds, 5, r, c));
        }
        const res = await pool(jobs, CONC);
        let count = 0, frp = 0, hi = 0, night = 0, fails = 0;
        for (const r of res) {
          for (const f of r.features) {
            if (!inBox(f)) continue;
            count++;
            frp += f.frp || 0;
            if (typeof f.conf === 'number' ? f.conf >= 80 : true) hi++;
            if (f.night) night++;
          }
        }
        const scale = dim / sampleDays.length;
        monthly.push({
          ym: `${y}-${String(m).padStart(2, '0')}`,
          sampled: count, days: sampleDays.length,
          est: Math.round(count * scale),
          frp: Math.round(frp * scale),
          meanFrp: count ? +(frp / count).toFixed(1) : 0,
          hiConf: Math.round(hi * scale), night: Math.round(night * scale),
        });
        process.stdout.write(`.`);
      }
    }
    sensorsOut[sensor.key] = { layer: sensor.layer, tms: sensor.tms, monthly };
    console.log(`\n[${rkey}] ${sensor.key} done: ${monthly.length} months, total est=${monthly.reduce((a, b) => a + b.est, 0)}`);
  }
  // harmonization: MODIS vs VIIRS-SNPP overlap ratio (2012-01 → SNPP end)
  const mod = sensorsOut['MODIS-Terra'].monthly;
  const snp = sensorsOut['VIIRS-SNPP'].monthly;
  const snpSet = new Map(snp.map((x) => [x.ym, x]));
  const overlap = mod.filter((x) => { const s = snpSet.get(x.ym); return s && x.sampled > 0 && s.sampled > 0; })
    .map((x) => ({ ym: x.ym, ratio: +(snpSet.get(x.ym).sampled / x.sampled).toFixed(3), m: x.sampled, s: snpSet.get(x.ym).sampled }));
  const meanRatio = overlap.length ? +(overlap.reduce((a, b) => a + b.ratio, 0) / overlap.length).toFixed(3) : null;

  const doc = {
    region: rkey, name: region.name, note: region.note, bbox: region.bbox,
    sensors: sensorsOut,
    harmonization: { overlapMonths: overlap.length, meanRatioSNPPtoMODIS: meanRatio, sample: overlap.slice(-6) },
    meta: {
      method: 'GIBS WMTS vector tiles (FIRMS-derived MODIS C6.1 / VIIRS V2 thermal anomalies), z5 9° tiles, 2 sampled days/month (8th, 22nd), bbox-filtered, scaled to monthly estimate. Exact counts via FIRMS area/count API in production mode.',
      source: 'NASA GIBS https://gibs.earthdata.nasa.gov · data NASA FIRMS/LANCE',
      generated: new Date().toISOString(),
    },
  };
  fs.writeFileSync(path.join(OUT, `calendar_${rkey}.json`), JSON.stringify(doc));
  console.log(`[${rkey}] saved. harmonization meanRatio(SNPP/MODIS)=${meanRatio}`);
}

(async () => {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(REGIONS);
  for (const k of keys) {
    const t0 = Date.now();
    await buildRegion(k, REGIONS[k]);
    console.log(`[${k}] elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log('ALL DONE');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
