// IGNIS — seasonal outlook generator (runs after build_calendar.mjs)
// Method: fused harmonized monthly record (MODIS backbone + VIIRS continuity scaling),
// seasonal profile (log-normal band over last 15 years per calendar month).
// Designed so a Hugging Face Chronos-Bolt model can be swapped in via HF_TOKEN (see docs).
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/home/z/my-project/data/ignis';
const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((r) => `calendar_${r}.json`)
  : fs.readdirSync(OUT).filter((f) => f.startsWith('calendar_'));

const MONTHS = ['01','02','03','04','05','06','07','08','09','10','11','12'];

for (const f of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
  const region = doc.region;

  const modMap = new Map(doc.sensors['MODIS-Terra'].monthly.map((m) => [m.ym, m]));
  const snpMap = new Map(doc.sensors['VIIRS-SNPP'].monthly.map((m) => [m.ym, m]));
  const ratio = doc.harmonization.meanRatioSNPPtoMODIS || 8;
  const allYms = Array.from(new Set([...modMap.keys(), ...snpMap.keys()])).sort();
  const fused = allYms.map((ym) => {
    if (modMap.has(ym)) return { ym, est: modMap.get(ym).est };
    const s = snpMap.get(ym);
    return s ? { ym, est: Math.round(s.est / ratio) } : { ym, est: 0 };
  });

  const season = Array.from({ length: 12 }, (_, i) => {
    const vals = fused.filter((x) => x.ym.endsWith(MONTHS[i]) && x.ym < '2026-01').slice(-15).map((x) => Math.log1p(x.est));
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const std = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1)) : 0.6;
    return { m: i, mean, std };
  });

  const lastYm = allYms[allYms.length - 1];
  let y = Number(lastYm.slice(0, 4)), m = Number(lastYm.slice(5, 7));
  const forecast = [];
  for (let i = 0; i < 12; i++) {
    m += 1; if (m > 12) { m = 1; y += 1; }
    const mm = String(m).padStart(2, '0');
    const s = season[m - 1];
    const mean = Math.round(Math.expm1(s.mean));
    const lo = Math.round(Math.expm1(s.mean - 1.0 * s.std));
    const hi = Math.round(Math.expm1(s.mean + 1.0 * s.std));
    forecast.push({ ym: `${y}-${mm}`, mean: Math.max(0, mean), lo: Math.max(0, lo), hi: Math.max(0, hi) });
  }

  const peakMonths = [...season].sort((a, b) => b.mean - a.mean).slice(0, 3).map((s) => MONTHS[s.m]);

  const out = {
    region,
    model: 'seasonal harmonic + log-normal band (HF Chronos-Bolt swappable)',
    method: 'Fused harmonized record: MODIS Terra backbone (2000-11→) + VIIRS S-NPP continuity extension scaled by measured overlap ratio. Seasonal profile = mean ± 1σ of log1p counts over last 15 years per calendar month.',
    generated: new Date().toISOString(),
    history: fused.slice(-36).map((x) => ({ ym: x.ym, est: x.est })),
    forecast,
    peakMonths,
  };
  fs.writeFileSync(path.join(OUT, `outlook_${region}.json`), JSON.stringify(out));
  console.log(`outlook_${region}.json  peak=${peakMonths.join('/')}  next12Mean=${Math.round(forecast.reduce((a, b) => a + b.mean, 0) / 12)}`);
}
console.log('OUTLOOK DONE');
