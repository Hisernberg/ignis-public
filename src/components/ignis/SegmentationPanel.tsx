'use client';

import { useMemo } from 'react';
import type { HotspotsResult, MultiHotspots, CalendarDoc } from '@/lib/ignis/types';
import { CLASS_STYLE, frpHistogram, acqHour, type SegmentationResult, type ClusterClass, type FireCluster, type FireTrack } from '@/lib/ignis/segmentation';
import { fmtNum } from '@/lib/ignis/analytics';
import { SENSOR_COLORS } from '@/lib/ignis/regions';

type Props = {
  hotspots: HotspotsResult | null;
  multiDay: MultiHotspots | null;
  seg: SegmentationResult | null;
  tracks: FireTrack[];
  regionName: string;
  day: string;
  calendar: CalendarDoc | null;
  onAskAi: (q: string) => void;
};

const CLS_ORDER: ClusterClass[] = ['MEGAFIRE', 'ESTABLISHED', 'EMERGING', 'SCATTERED'];

function Bar({ label, n, max, color }: { label: string; n: number; max: number; color: string }) {
  const w = max > 0 ? (n / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 shrink-0 text-right text-[9.5px] text-slate-500">{label}</div>
      <div className="h-3 flex-1 overflow-hidden rounded-sm bg-[#0F1D31]">
        <div className="h-3 rounded-sm transition-all" style={{ width: `${Math.max(n > 0 ? 2 : 0, w)}%`, backgroundColor: color }} />
      </div>
      <div className="w-10 shrink-0 text-right font-mono text-[9.5px] text-slate-400">{n}</div>
    </div>
  );
}

export default function SegmentationPanel({ hotspots, multiDay, seg, tracks, regionName, day, calendar, onAskAi }: Props) {
  const allPoints = useMemo(() => {
    if (!hotspots) return [];
    return Object.values(hotspots.sensors).flatMap((s) => s.points);
  }, [hotspots]);

  const hist = useMemo(() => frpHistogram(allPoints), [allPoints]);

  const diurnal = useMemo(() => {
    const hours = new Array(24).fill(0) as number[];
    let withTime = 0;
    for (const p of allPoints) {
      const h = acqHour(p.acq);
      if (h !== null) { hours[h]++; withTime++; }
    }
    return { hours, withTime };
  }, [allPoints]);

  const nightDay = useMemo(() => {
    let night = 0;
    for (const p of allPoints) if (p.night) night++;
    return { night, day: allPoints.length - night };
  }, [allPoints]);

  const classCounts = useMemo(() => {
    const m = new Map<ClusterClass, number>();
    for (const c of seg?.clusters ?? []) m.set(c.cls, (m.get(c.cls) || 0) + 1);
    return m;
  }, [seg]);

  if (!hotspots || !seg) {
    return (
      <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/60 p-6 text-center text-[12px] text-slate-500">
        Load a detection window (pick a date or enable the 7-day window) — the segmentation engine will organize raw hotspots into boundary-identified fire clusters.
      </div>
    );
  }

  const maxHist = Math.max(...hist.map((h) => h.n), 1);
  const maxHour = Math.max(...diurnal.hours, 1);
  const top = seg.topByFrp.slice(0, 8);
  const persistent = tracks.filter((t) => t.daysSeen >= 2).slice(0, 8);
  const totalFrpClustered = seg.clusters.reduce((a, c) => a + c.frpSum, 0);
  const totalFrpAll = allPoints.reduce((a, p) => a + (p.frp || 0), 0);
  const frpInsidePct = totalFrpAll > 0 ? Math.round((totalFrpClustered / totalFrpAll) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* header + KPIs */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-bold tracking-wide text-slate-100">🧪 FIRE CLUSTER LAB — segmentation &amp; boundary identification</h3>
        <span className="rounded-full border border-orange-500/50 bg-orange-500/10 px-2 py-0.5 text-[9.5px] text-orange-300">DBSCAN ε={seg.epsDeg}° · minPts {seg.minPts}</span>
        <button
          onClick={() => onAskAi(`Explain the fire segmentation of ${regionName} on ${day}: ${seg.clusters.length} clusters identified (${CLS_ORDER.map((c) => `${classCounts.get(c) || 0} ${c.toLowerCase()}`).join(', ')}), ${seg.clusteredPct.toFixed(0)}% of detections clustered, top cluster ${top[0]?.id ?? 'n/a'} with ${top[0] ? `${Math.round(top[0].frpSum)} MW across ${top[0].n} detections` : 'n/a'}. What does this spatial organization tell responders?`)}
          className="ml-auto rounded-full bg-gradient-to-r from-orange-500 to-amber-400 px-3 py-1.5 text-[10px] font-bold text-slate-950 hover:scale-105 transition-transform">
          ✦ AI reads this segmentation
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
        {[
          { l: 'Fire clusters identified', v: String(seg.clusters.length), s: `${seg.scattered} scattered points outside clusters` },
          { l: 'Megafire clusters', v: String(classCounts.get('MEGAFIRE') || 0), s: '≥150 detections or ΣFRP ≥5,000 MW' },
          { l: 'Clustered activity', v: `${seg.clusteredPct.toFixed(0)}%`, s: 'share of detections inside a boundary' },
          { l: 'Largest cluster', v: top[0] ? fmtNum(top[0].frpSum) + ' MW' : '—', s: top[0] ? `${top[0].id} · ${top[0].n} detections · ${top[0].spreadKm} km spread` : 'no clusters' },
          { l: 'Persistent systems', v: String(persistent.length), s: `alive ≥2 days in the loaded window` },
          { l: 'FRP inside boundaries', v: `${frpInsidePct}%`, s: 'of total observed FRP' },
        ].map((k) => (
          <div key={k.l} className="rounded-lg border border-[#14273F] bg-[#0A1423]/70 p-2.5">
            <div className="text-[9px] uppercase tracking-widest text-slate-500">{k.l}</div>
            <div className="font-mono text-[17px] font-bold text-orange-200">{k.v}</div>
            <div className="text-[9px] leading-tight text-slate-500">{k.s}</div>
          </div>
        ))}
      </div>

      {/* ML behavior mix (ignis-fire-classifier, live inference) */}
      {seg.behaviorMix && Object.keys(seg.behaviorMix).length > 0 && (
        <div className="rounded-lg border border-violet-900/50 bg-violet-950/10 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold text-violet-200">🤖 ML fire-behavior classification — live per-detection inference</span>
            <span className="rounded-full border border-violet-500/40 px-2 py-0.5 text-[9px] text-violet-300">ignis-fire-classifier · v2.0.0 · extra-trees portable twin</span>
            <span className="text-[9px] text-slate-500">every detection scored server-side; full HGB reference model on Hugging Face</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5">
            {(['MEGAFIRE', 'ESTABLISHED', 'EMERGING', 'SCATTERED', 'ISOLATED'] as const).map((k) => {
              const n = seg.behaviorMix?.[k] ?? 0;
              const tot = Object.values(seg.behaviorMix ?? {}).reduce((a, b) => a + b, 0) || 1;
              const pct = Math.round((n / tot) * 100);
              return (
                <div key={k}>
                  <div className="flex items-baseline justify-between text-[9.5px]">
                    <span className="text-slate-400">{k}</span>
                    <span className="font-mono text-violet-200">{pct}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded bg-[#0F1D31]">
                    <div className="h-1.5 rounded bg-violet-400/80" style={{ width: `${Math.max(pct, n > 0 ? 2 : 0)}%` }} />
                  </div>
                  <div className="mt-0.5 text-right font-mono text-[8.5px] text-slate-500">{n.toLocaleString()} det.</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {/* cluster table */}
        <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/60 p-3">
          <div className="mb-2 text-[11px] font-bold text-slate-200">Identified fire clusters — top by radiative power</div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[10px]">
              <thead className="text-slate-500">
                <tr className="border-b border-[#14273F]">
                  <th className="py-1 pr-2">ID</th><th className="pr-2">Class</th><th className="pr-2">🤖 ML</th><th className="pr-2 text-right">Det.</th>
                  <th className="pr-2 text-right">ΣFRP MW</th><th className="pr-2 text-right">Spread km</th><th className="pr-2 text-right">Area km²</th>
                  <th className="pr-2 text-right">Front¹</th><th className="pr-2 text-right">Night</th><th>Sensors</th>
                </tr>
              </thead>
              <tbody>
                {top.map((c: FireCluster) => (
                  <tr key={c.id} className="border-b border-[#0F1D31] hover:bg-[#0F1D31]/60">
                    <td className="py-1 pr-2 font-mono text-slate-300">{c.id}</td>
                    <td className="pr-2"><span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ color: CLASS_STYLE[c.cls].stroke, background: CLASS_STYLE[c.cls].fill }}>{c.cls}</span></td>
                    <td className="pr-2" title={`member vote mix: ${Object.entries(c.modelMix ?? {}).map(([k, v]) => `${k} ${v}%`).join(' · ')}`}>{c.modelCls ? <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold text-violet-300">{c.modelCls}</span> : <span className="text-slate-600">—</span>}</td>
                    <td className="pr-2 text-right font-mono text-slate-200">{c.n}</td>
                    <td className="pr-2 text-right font-mono text-orange-300">{fmtNum(c.frpSum)}</td>
                    <td className="pr-2 text-right font-mono text-slate-400">{c.spreadKm}</td>
                    <td className="pr-2 text-right font-mono text-slate-400">{fmtNum(c.areaKm2)}</td>
                    <td className="pr-2 text-right font-mono text-slate-400" title="perimeter ÷ circle perimeter — >1.6 = elongated fire front">{c.elongation}</td>
                    <td className="pr-2 text-right font-mono text-slate-400">{c.nightPct.toFixed(0)}%</td>
                    <td className="text-[8.5px] leading-3 text-slate-500">{Object.keys(c.sensors).map((s) => s.replace('MODIS-', 'T').replace('VIIRS-', 'V')).join(' ')}</td>
                  </tr>
                ))}
                {!top.length && <tr><td colSpan={10} className="py-3 text-center text-slate-500">No clusters at this density — activity is scattered.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="mt-1.5 text-[9px] text-slate-500">¹ front ratio = perimeter ÷ circle of equal area (1 = circular blob, &gt;1.6 = elongated advancing front). Boundaries are convex hulls drawn on the map (toggle 🔲 Segmentation).</div>
        </div>

        {/* FRP histogram + day/night */}
        <div className="space-y-4">
          <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/60 p-3">
            <div className="mb-2 text-[11px] font-bold text-slate-200">FRP distribution — {allPoints.length.toLocaleString()} detections</div>
            <div className="space-y-1">
              {hist.map((h, i) => (
                <Bar key={h.label} label={h.label} n={h.n} max={maxHist} color={['#FDE68A', '#FDBA74', '#FB923C', '#F87171', '#EF4444', '#B91C1C', '#7F1D1D', '#450A0A'][i]} />
              ))}
            </div>
            <div className="mt-1.5 text-[9px] text-slate-500">Log-spaced radiative-power bins (MW). A fat left tail + thin right tail is normal; a bulge in ≥120 MW bins signals intense crowning/peat fire activity.</div>
          </div>
          <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/60 p-3">
            <div className="mb-2 text-[11px] font-bold text-slate-200">Diurnal signature (UTC overpass hours)</div>
            {diurnal.withTime > 0 ? (
              <>
                <div className="flex h-16 items-end gap-[2px]">
                  {diurnal.hours.map((n, h) => (
                    <div key={h} className="group relative flex-1" title={`${String(h).padStart(2, '0')}:00 UTC — ${n} detections`}>
                      <div className="w-full rounded-t-sm" style={{ height: `${Math.max(n > 0 ? 3 : 0, (n / maxHour) * 60)}px`, background: h >= 9 && h <= 17 ? '#F59E0B' : '#6366F1' }} />
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[9px] text-slate-500"><span>00</span><span>06</span><span>12</span><span>18</span><span>23 UTC</span></div>
                <div className="mt-1 flex gap-3 text-[9px] text-slate-500"><span><span className="mr-1 inline-block h-1.5 w-3 rounded" style={{ background: '#F59E0B' }} />daylight hours</span><span><span className="mr-1 inline-block h-1.5 w-3 rounded" style={{ background: '#6366F1' }} />night hours</span></div>
              </>
            ) : (
              <div className="space-y-1">
                <Bar label="Day" n={nightDay.day} max={Math.max(nightDay.day, nightDay.night, 1)} color="#F59E0B" />
                <Bar label="Night" n={nightDay.night} max={Math.max(nightDay.day, nightDay.night, 1)} color="#6366F1" />
              </div>
            )}
            <div className="mt-1.5 text-[9px] text-slate-500">Built from acquisition timestamps. Peaks at ~10:30/13:30 UTC windows reveal Terra/Aqua orbit sampling; sustained night fire = deep smouldering.</div>
          </div>
        </div>
      </div>

      {/* persistence */}
      {persistent.length > 0 && (
        <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/60 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-bold text-slate-200">Persistent fire systems — tracked across the replay window</span>
            <span className="rounded-full border border-cyan-500/40 px-2 py-0.5 text-[9px] text-cyan-300">nearest-centroid matching ≤60 km/day</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[10px]">
              <thead className="text-slate-500">
                <tr className="border-b border-[#14273F]">
                  <th className="py-1 pr-2">System</th><th className="pr-2">First seen</th><th className="pr-2 text-right">Days</th>
                  <th className="pr-2 text-right">Peak FRP</th><th className="pr-2 text-right">Latest FRP</th><th className="pr-2 text-right">Trend</th><th className="pr-2">Latest class</th><th>Centroid path</th>
                </tr>
              </thead>
              <tbody>
                {persistent.map((t) => (
                  <tr key={t.id} className="border-b border-[#0F1D31]">
                    <td className="py-1 pr-2 font-mono text-slate-300">{t.id}</td>
                    <td className="pr-2 text-slate-400">{t.firstDay}</td>
                    <td className="pr-2 text-right font-mono text-slate-200">{t.daysSeen}</td>
                    <td className="pr-2 text-right font-mono text-orange-300">{fmtNum(t.peakFrp)}</td>
                    <td className="pr-2 text-right font-mono text-slate-300">{fmtNum(t.latestFrp)}</td>
                    <td className="pr-2 text-right font-mono" style={{ color: t.frpTrend > 0.25 ? '#F87171' : t.frpTrend < -0.25 ? '#4ADE80' : '#FDE68A' }}>
                      {t.frpTrend > 0.25 ? '↗ growing' : t.frpTrend < -0.25 ? '↘ decaying' : '→ steady'}
                    </td>
                    <td className="pr-2"><span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ color: CLASS_STYLE[t.latestClass].stroke, background: CLASS_STYLE[t.latestClass].fill }}>{t.latestClass}</span></td>
                    <td className="text-[9px] text-slate-500">{t.trail.length} fixes · {t.trail[0][1].toFixed(1)},{t.trail[0][0].toFixed(1)} → {t.trail[t.trail.length - 1][1].toFixed(1)},{t.trail[t.trail.length - 1][0].toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-1.5 text-[9px] text-slate-500">Systems re-identified day-over-day reveal the fires that persist through suppression windows — the ones that re-ignite or smoulder in peat.</div>
        </div>
      )}

      {/* how it works */}
      <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/40 p-3 text-[10px] leading-relaxed text-slate-500">
        <span className="text-slate-300">Method:</span> every visible detection (respecting your sensor toggles) is clustered with a grid-accelerated <b className="text-slate-300">DBSCAN</b> (density-based spatial clustering, ε adaptive to AOI size, minPts = 3 — the standard density-clustering algorithm used in burned-area and fire-cluster literature). Each cluster receives a <b className="text-slate-300">convex-hull boundary</b> (Andrew monotone chain), then radiative-power, spread, area, elongation and sensor-mix metrics. Across the 7-day replay window, clusters are linked into <b className="text-slate-300">persistent fire systems</b> by greedy nearest-centroid tracking. In parallel, <b className="text-violet-300">ignis-fire-classifier</b> (our own Hugging Face model, weakly supervised by this same DBSCAN engine, held-out agreement 0.69 vs 0.76 for the HGB reference) scores every detection into a fire-behavior class in real time — cluster rows show the member vote. All deterministic where it matters, all in-browser or in-route, no black box. Calendar context: peak {calendar ? 'from the 26-year harmonized record' : 'pending'}. · Region: <b className="text-slate-300">{regionName}</b> · day <b className="text-slate-300">{day}</b>.
      </div>
    </div>
  );
}
