'use client';

import type { HotspotsResult } from '@/lib/ignis/types';
import { SENSOR_COLORS, SENSOR_INFO } from '@/lib/ignis/regions';

type Props = { hotspots: HotspotsResult | null; harmonization?: { overlapMonths: number; meanRatioSNPPtoMODIS: number | null } | null };

export default function SensorPanel({ hotspots, harmonization }: Props) {
  if (!hotspots) {
    return <div className="h-40 rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4 text-sm text-slate-400">Cross-sensor comparison loads with hotspots…</div>;
  }
  const total = Object.values(hotspots.sensors).reduce((a, s) => a + s.count, 0);
  const clusters = cluster(hotspots);

  return (
    <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
      <h3 className="text-sm font-semibold tracking-wide text-slate-100">SENSOR HARMONIZATION — {hotspots.day}</h3>
      <p className="text-[11px] text-slate-400">Same sky, five instruments: why counts differ and how IGNIS unifies them</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {Object.entries(hotspots.sensors).map(([k, s]) => (
          <div key={k} className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold" style={{ color: SENSOR_COLORS[k] || '#94A3B8' }}>
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: SENSOR_COLORS[k] || '#94A3B8' }} />{k}
            </div>
            <div className="mt-1 text-xl font-bold text-slate-100">{s.count.toLocaleString()}</div>
            <div className="text-[10px] text-slate-400">detections · mean FRP {s.meanFrp} MW · max {s.maxFrp} MW</div>
            <div className="text-[10px] text-slate-400">hi-conf {s.count ? Math.round((s.hiConf / s.count) * 100) : 0}% · night {s.nightPct}%</div>
            <div className="mt-0.5 text-[9.5px] text-slate-500">{SENSOR_INFO[k]?.res ?? ''} · {SENSOR_INFO[k]?.orbit ?? ''}</div>
            <div className="text-[9.5px] text-slate-500">{s.source === 'firms-api' ? 'FIRMS NRT API' : `GIBS MVT · ${s.dayUsed}`}{s.clamped ? ' (sensor lag)' : ''}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-slate-300">
        <p><span className="text-cyan-300">Why they differ:</span> MODIS images at 1 km (Terra ~10:30 + Aqua ~13:30 overpasses); VIIRS images at 375 m with a 3,060 km swath — it resolves fires ~450× smaller in area, so raw VIIRS counts run higher for the same fire. IGNIS normalizes this with an overlap-derived continuity coefficient so one 26-year trend line is scientifically comparable across the sensor break.</p>
        <p><span className="text-cyan-300">Continuity coefficient:</span> {harmonization?.meanRatioSNPPtoMODIS ? `SNPP/MODIS ≈ ×${harmonization.meanRatioSNPPtoMODIS} (${harmonization.overlapMonths} overlap months in this AOI) — applied when fusing records.` : 'computing from 14 years of overlap…'}</p>
        <p className="text-slate-400">Total in AOI: {total.toLocaleString()} detections · pipeline: {hotspots.note}</p>
      </div>
      {clusters.length > 0 && (
        <div className="mt-3 border-t border-[#13253D] pt-2">
          <div className="text-[11px] font-semibold text-slate-200">TOP FIRE CLUSTERS (0.25° grid)</div>
          <div className="mt-1 space-y-1">
            {clusters.map((c, i) => (
              <div key={i} className="flex items-center justify-between rounded bg-[#060D1A] px-2 py-1 text-[11px]">
                <span className="text-slate-300">{c.lat.toFixed(2)}°, {c.lon.toFixed(2)}°</span>
                <span className="text-amber-400">{c.n} detections · {Math.round(c.frp)} MW</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function cluster(hotspots: HotspotsResult) {
  const grid = new Map<string, { n: number; frp: number; lat: number; lon: number }>();
  for (const s of Object.values(hotspots.sensors)) {
    for (const p of s.points) {
      const gk = `${Math.round(p.lat * 4) / 4},${Math.round(p.lon * 4) / 4}`;
      const g = grid.get(gk) || { n: 0, frp: 0, lat: Math.round(p.lat * 4) / 4, lon: Math.round(p.lon * 4) / 4 };
      g.n++; g.frp += p.frp || 0;
      grid.set(gk, g);
    }
  }
  return Array.from(grid.values()).sort((a, b) => b.n - a.n).slice(0, 3).filter((c) => c.n >= 3);
}
