// Recompute harmonization block from saved calendar JSONs (no refetch)
import fs from 'node:fs';
import path from 'node:path';
const OUT = '/home/z/my-project/data/ignis';
const files = process.argv.slice(2).length ? process.argv.slice(2).map((r) => `calendar_${r}.json`) : fs.readdirSync(OUT).filter((f) => f.startsWith('calendar_'));
for (const f of files) {
  const p = path.join(OUT, f);
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const mod = doc.sensors['MODIS-Terra'].monthly;
  const snp = doc.sensors['VIIRS-SNPP'].monthly;
  const snpSet = new Map(snp.map((x) => [x.ym, x]));
  const overlap = mod.filter((x) => { const s = snpSet.get(x.ym); return s && x.sampled > 0 && s.sampled > 0; })
    .map((x) => ({ ym: x.ym, ratio: +(snpSet.get(x.ym).sampled / x.sampled).toFixed(3), m: x.sampled, s: snpSet.get(x.ym).sampled }));
  const meanRatio = overlap.length ? +(overlap.reduce((a, b) => a + b.ratio, 0) / overlap.length).toFixed(3) : null;
  doc.harmonization = { overlapMonths: overlap.length, meanRatioSNPPtoMODIS: meanRatio, sample: overlap.slice(-6) };
  fs.writeFileSync(p, JSON.stringify(doc));
  console.log(f, '→ ratio', meanRatio, `(${overlap.length} months)`);
}
