// Computes the 8 reference-region feature vectors from the precomputed NASA calendars
// and emits src/lib/ignis/regimePrototypes.json (used by the burn-regime classifier).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/z/my-project';
const REGIONS = [
  ['amazon', 'Amazon Basin', 'Deforestation-driven fire regime: dry-season (Aug-Oct) ignition front along the agricultural frontier; large, hot, day-dominant detections.'],
  ['california', 'California / US West', 'Mediterranean + forest regime: summer-autumn wind- and drought-driven fires, high intensity, strong interannual swings.'],
  ['canada', 'Boreal Canada', 'Boreal crown-fire regime: short intense Jun-Aug window, episodic megayears (2023), high night fraction from large smoldering fronts.'],
  ['siberia', 'Eastern Siberia', 'Boreal/permafrost regime: Jul-Aug peak, huge interannual variability, deep smoldering peat fires burn day and night.'],
  ['congo', 'Congo Basin', 'Savanna-agricultural regime: very frequent, low-intensity burns tightly locked to the dry seasons; the most regular signal on Earth.'],
  ['borneo', 'Borneo & Sumatra', 'Peatland regime: rare but catastrophic El Niño megafires (2015, 2019, 2023); smoldering underground peat produces high night fraction.'],
  ['australia', 'Australia', 'Arid/shrubland regime: broad austral-summer peak (Nov-Feb), moderate intensity, fire-following-rain variability.'],
  ['mediterranean', 'Mediterranean Basin', 'European temperate regime: Jul-Aug heatwave-driven fires, high intensity per pixel, low night fraction.'],
];

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); const p = (s.length - 1) / 2; return s[Math.floor(p)] + (s[Math.ceil(p)] - s[Math.floor(p)]) * (p % 1); };

function unified(doc) {
  const modis = doc.sensors['MODIS-Terra']?.monthly || [];
  const snpp = doc.sensors['VIIRS-SNPP']?.monthly || [];
  const byYm = new Map();
  for (const r of modis) byYm.set(r.ym, { m: r });
  for (const r of snpp) { const o = byYm.get(r.ym) || {}; o.s = r; byYm.set(r.ym, o); }
  const rc = [], rf = [];
  for (const { m, s } of byYm.values()) if (m && s && m.est > 0 && s.est > 0) { rc.push(s.est / m.est); rf.push(s.frp / Math.max(1, m.frp)); }
  const ratioCount = rc.length ? median(rc) : 1;
  const ratioFrp = rf.length ? median(rf) : 1;
  const rows = [...byYm.keys()].sort().map((ym) => {
    const { m, s } = byYm.get(ym);
    if (s) return { ym, count: s.est, frp: s.frp };
    if (m) return { ym, count: Math.round(m.est * ratioCount), frp: Math.round(m.frp * ratioFrp) };
    return null;
  }).filter(Boolean);
  return rows;
}

function features(doc) {
  const rows = unified(doc);
  const modis = doc.sensors['MODIS-Terra']?.monthly || [];
  const byMonth = Array.from({ length: 12 }, () => []);
  for (const r of rows) if (r.ym < '2024-01') byMonth[Number(r.ym.slice(5, 7)) - 1].push(r.count);
  const monthMean = byMonth.map(mean);
  const peakMonth = monthMean.indexOf(Math.max(...monthMean));
  const counts = rows.map((r) => r.count);
  const seasonality = +(Math.max(...monthMean) / Math.max(1, median(counts))).toFixed(2);
  const annual = new Map();
  for (const r of rows) { const y = Number(r.ym.slice(0, 4)); annual.set(y, (annual.get(y) || 0) + r.count); }
  const av = [...annual.entries()].filter(([y]) => {
    const months = rows.filter((r) => r.ym.startsWith(String(y))).length;
    return months >= 10;
  }).map(([, v]) => v);
  const interannualCV = +(std(av) / Math.max(1, mean(av))).toFixed(3);
  const night = modis.reduce((s, m) => s + m.night, 0);
  const tot = modis.reduce((s, m) => s + m.est, 0);
  const nightFraction = +(night / Math.max(1, tot)).toFixed(3);
  const frpSum = rows.reduce((s, r) => s + r.frp, 0);
  const countSum = rows.reduce((s, r) => s + r.count, 0);
  const meanFrp = +(frpSum / Math.max(1, countSum)).toFixed(1);
  const logMedianCount = +Math.log10(Math.max(1, median(counts))).toFixed(2);
  return { peakMonth, seasonality, interannualCV, nightFraction, meanFrp, logMedianCount };
}

const out = [];
for (const [key, label, note] of REGIONS) {
  const file = path.join(ROOT, 'data', 'ignis', `calendar_${key}.json`);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  out.push({ key, label, note, features: features(doc) });
  console.log(key, JSON.stringify(features(doc)));
}
fs.writeFileSync(path.join(ROOT, 'src', 'lib', 'ignis', 'regimePrototypes.json'), JSON.stringify(out, null, 1));
console.log('wrote', out.length, 'prototypes');
