'use client';

import { useMemo } from 'react';
import type { MultiHotspots } from '@/lib/ignis/types';
import { fmtNum } from '@/lib/ignis/analytics';
import { SENSOR_COLORS } from '@/lib/ignis/regions';
import type { ForecastField } from '@/lib/ignis/forecast';
import { FORECASTER_META } from '@/lib/ignis/forecast';

type Props = {
  multiDay: MultiHotspots | null;
  day: string;
  regionName: string;
  onAskAi: (q: string) => void;
  forecast?: ForecastField | null;
  forecastOn?: boolean;
  onToggleForecast?: () => void;
};

type DayAgg = {
  day: string;
  perSensor: Record<string, number>;
  perSensorFrp: Record<string, number>;
  total: number;
  frp: number;
  night: number;
  hi: number;
};

function aggregate(multi: MultiHotspots): DayAgg[] {
  return Object.entries(multi.days)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, h]) => {
      const perSensor: Record<string, number> = {};
      const perSensorFrp: Record<string, number> = {};
      let total = 0, frp = 0, night = 0, hi = 0;
      for (const [k, s] of Object.entries(h.sensors)) {
        perSensor[k] = s.count;
        perSensorFrp[k] = s.points.reduce((a, p) => a + (p.frp || 0), 0);
        total += s.count;
        frp += perSensorFrp[k];
        night += Math.round((s.nightPct / 100) * s.count);
        hi += s.hiConf;
      }
      return { day, perSensor, perSensorFrp, total, frp, night, hi };
    });
}

export default function DynamicsPanel({ multiDay, day, regionName, onAskAi, forecast, forecastOn, onToggleForecast }: Props) {
  const days = useMemo(() => (multiDay ? aggregate(multiDay) : []), [multiDay]);

  const sensorsPresent = useMemo(() => {
    const set = new Set<string>();
    for (const d of days) for (const k of Object.keys(d.perSensor)) set.add(k);
    return Object.keys(SENSOR_COLORS).filter((k) => set.has(k));
  }, [days]);

  const modisVsViirs = useMemo(() => {
    return days.map((d) => {
      const m = (d.perSensor['MODIS-Terra'] || 0) + (d.perSensor['MODIS-Aqua'] || 0);
      const v = (d.perSensor['VIIRS-SNPP'] || 0) + (d.perSensor['VIIRS-NOAA20'] || 0) + (d.perSensor['VIIRS-NOAA21'] || 0);
      return { day: d.day, m, v };
    }).filter((x) => x.m > 0 || x.v > 0);
  }, [days]);

  if (!multiDay || days.length === 0) {
    return (
      <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/60 p-6 text-center text-[12px] text-slate-500">
        Enable <b className="text-orange-300">⏮ Load 7-day window</b> in the controls row to unlock daily dynamics: stacked sensor activity, FRP energy curve, MODIS↔VIIRS cross-validation and day/night balance.
      </div>
    );
  }

  const maxTotal = Math.max(...days.map((d) => d.total), 1);
  const maxFrp = Math.max(...days.map((d) => d.frp), 1);
  const first = days[0], last = days[days.length - 1];
  const delta = first.total ? ((last.total - first.total) / first.total) * 100 : 0;
  const bigDay = days.reduce((a, b) => (b.total > a.total ? b : a), days[0]);
  const frpDay = days.reduce((a, b) => (b.frp > a.frp ? b : a), days[0]);
  const scatterMax = Math.max(...modisVsViirs.flatMap((x) => [x.m, x.v]), 10);
  const trendWord = delta > 15 ? 'ESCALATING' : delta < -15 ? 'DECLINING' : 'STEADY';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-bold tracking-wide text-slate-100">📊 DAILY DYNAMICS — {days.length}-day window over {regionName}</h3>
        <span className={`rounded-full px-2 py-0.5 text-[9.5px] font-bold ${trendWord === 'ESCALATING' ? 'bg-red-500/25 text-red-300' : trendWord === 'DECLINING' ? 'bg-emerald-500/25 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`}>{trendWord} ({delta >= 0 ? '+' : ''}{delta.toFixed(0)}% first→last day)</span>
        <button
          onClick={() => onAskAi(`Analyze the ${days.length}-day fire dynamics over ${regionName} (${first.day} → ${last.day}): total detections went ${first.total} → ${last.total} (${trendWord}), peak day ${bigDay.day} with ${bigDay.total} detections and ${fmtNum(frpDay.frp)} MW peak energy on ${frpDay.day}. MODIS vs VIIRS pairs: ${modisVsViirs.map((x) => `${x.m}/${x.v}`).join(', ')}. What is the trajectory and what should responders do next 48h?`)}
          className="ml-auto rounded-full bg-gradient-to-r from-orange-500 to-amber-400 px-3 py-1.5 text-[10px] font-bold text-slate-950 transition-transform hover:scale-105">
          ✦ AI reads these dynamics
        </button>
      </div>

      {/* ML next-day footprint forecast (ignis-fire-footprint-forecaster) */}
      <div className="rounded-lg border border-violet-900/50 bg-violet-950/10 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold text-violet-200">🔮 Next-day footprint forecast — segmentation-based ML model</span>
          <span className="rounded-full border border-violet-500/40 px-2 py-0.5 text-[9px] text-violet-300">{FORECASTER_META.name} · {forecast?.modelVersion ?? 'v1.1.0'} · LogReg portable twin</span>
          {!forecastOn && (
            <button onClick={() => onToggleForecast?.()} className="ml-auto rounded-full bg-violet-500/80 px-3 py-1 text-[10px] font-bold text-slate-950 hover:bg-violet-400">
              Run on this window (also renders on map)
            </button>
          )}
        </div>
        {!forecastOn ? (
          <p className="text-[10px] leading-relaxed text-slate-500">
            The forecaster builds a {forecast ? forecast.cellDeg : '0.05'}° probability field of TOMORROW's fire-complex footprint from the prior days' detection-density features (Gaussian KDEs at 3 bandwidths + FRP-weighted density + geometry + season), trained on 138k real FIRMS detections. Enable it to compute for this window — the predicted cells also draw on the map (🔮 ML forecast toggle).
          </p>
        ) : forecast ? (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              {[
                { l: 'Target day', v: forecast.targetDay, s: 'next day after the window' },
                { l: 'Predicted footprint', v: forecast.stats.predicted.toLocaleString() + ' cells', s: `${forecast.stats.hiConfCells.toLocaleString()} high-confidence (p≥0.85)` },
                { l: 'Max probability', v: String(forecast.stats.maxP), s: `mean ${forecast.stats.meanP}` },
                { l: 'Top-2k alignment', v: forecast.stats.topAlignedPct + '%', s: 'of highest-risk cells active today' },
                { l: 'Domain', v: forecast.domain, s: `trained on ${FORECASTER_META.trainDomains.join(', ')}` },
                { l: 'Held-out skill (train domains)', v: 'IoU 0.58/0.55/0.42', s: 'LR twin v2 vs persistence 0.36/0.39/0.38' },
              ].map((k) => (
                <div key={k.l} className="rounded border border-[#1E1B4B] bg-[#0A1423]/70 p-2">
                  <div className="text-[8.5px] uppercase tracking-widest text-slate-500">{k.l}</div>
                  <div className="font-mono text-[13px] font-bold text-violet-200">{k.v}</div>
                  <div className="text-[8.5px] leading-tight text-slate-500">{k.s}</div>
                </div>
              ))}
            </div>
            <p className="text-[9px] leading-relaxed text-slate-500">
              {forecast.domain === 'extrapolated' && '⚠ Current AOI is outside the three training domains — treat probabilities as directional only. '}
              Same-day-early density is proxied with the last full day (documented caveat from training). Full HGB reference + per-region metrics on Hugging Face.
            </p>
          </div>
        ) : (
          <p className="text-[10px] text-slate-500">Computing probability field… (or not enough prior data in this window)</p>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* stacked bars by sensor */}
        <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/60 p-3">
          <div className="mb-2 text-[11px] font-bold text-slate-200">Detections per day — stacked by sensor (harmonized)</div>
          <div className="flex h-36 items-end gap-2">
            {days.map((d) => (
              <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end" title={`${d.day}: ${d.total.toLocaleString()} detections`}>
                <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm">
                  {sensorsPresent.map((s) => {
                    const n = d.perSensor[s] || 0;
                    if (!n) return null;
                    return <div key={s} style={{ height: `${(n / maxTotal) * 132}px`, backgroundColor: SENSOR_COLORS[s] }} className="w-full opacity-90 group-hover:opacity-100" />;
                  })}
                </div>
                <div className="mt-1 text-center font-mono text-[8.5px] text-slate-500">{d.day.slice(5)}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-slate-400">
            {sensorsPresent.map((s) => (
              <span key={s} className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: SENSOR_COLORS[s] }} />{s}</span>
            ))}
          </div>
        </div>

        {/* FRP energy curve */}
        <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/60 p-3">
          <div className="mb-2 text-[11px] font-bold text-slate-200">Fire radiative energy per day (Σ FRP, MW)</div>
          <svg viewBox="0 0 320 130" className="h-36 w-full">
            {[0.25, 0.5, 0.75].map((g) => (
              <line key={g} x1={30} x2={316} y1={110 - g * 95} y2={110 - g * 95} stroke="#14273F" strokeWidth={1} />
            ))}
            <polyline
              fill="none" stroke="#FB923C" strokeWidth={2.2} strokeLinejoin="round"
              points={days.map((d, i) => `${30 + (i / Math.max(1, days.length - 1)) * 282},${110 - (d.frp / maxFrp) * 95}`).join(' ')}
            />
            {days.map((d, i) => (
              <circle key={d.day} cx={30 + (i / Math.max(1, days.length - 1)) * 282} cy={110 - (d.frp / maxFrp) * 95} r={3} fill={d.day === frpDay.day ? '#FFFFFF' : '#FB923C'} stroke="#050A14" strokeWidth={1} />
            ))}
            {days.map((d, i) => (
              <text key={d.day} x={30 + (i / Math.max(1, days.length - 1)) * 282} y={124} fontSize={8} fill="#64748B" textAnchor="middle">{d.day.slice(5)}</text>
            ))}
            <text x={4} y={18} fontSize={8} fill="#64748B">{fmtNum(maxFrp)}</text>
            <text x={4} y={112} fontSize={8} fill="#64748B">0</text>
          </svg>
          <div className="mt-1 text-[9px] text-slate-500">White marker = peak-energy day <b className="text-slate-300">{frpDay.day}</b> ({fmtNum(frpDay.frp)} MW). FRP integrates fire temperature + area — the energy proxy responders size resources with.</div>
        </div>

        {/* MODIS vs VIIRS scatter */}
        <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/60 p-3">
          <div className="mb-2 text-[11px] font-bold text-slate-200">Sensor cross-validation — MODIS (1 km) vs VIIRS (375 m) daily counts</div>
          <svg viewBox="0 0 320 150" className="h-44 w-full">
            <line x1={36} y1={132} x2={312} y2={132} stroke="#334155" strokeWidth={1} />
            <line x1={36} y1={132} x2={36} y2={10} stroke="#334155" strokeWidth={1} />
            {/* 1:1 line */}
            <line x1={36} y1={132} x2={312} y2={12} stroke="#1E3A5F" strokeWidth={1.2} strokeDasharray="4 3" />
            <text x={252} y={40} fontSize={8} fill="#475569">1:1 line</text>
            {modisVsViirs.map((x) => {
              const cx = 36 + (x.m / scatterMax) * 268;
              const cy = 132 - (x.v / scatterMax) * 118;
              return (
                <g key={x.day}>
                  <circle cx={cx} cy={cy} r={4.5} fill="#38BDF8" fillOpacity={0.85} stroke="#050A14" />
                  <text x={cx + 6} y={cy - 4} fontSize={7.5} fill="#94A3B8">{x.day.slice(5)}</text>
                </g>
              );
            })}
            <text x={168} y={146} fontSize={8.5} fill="#64748B" textAnchor="middle">MODIS Terra+Aqua detections</text>
            <text x={12} y={80} fontSize={8.5} fill="#64748B" transform="rotate(-90 12 80)" textAnchor="middle">VIIRS detections</text>
            <text x={40} y={22} fontSize={8} fill="#64748B">{scatterMax}</text>
            <text x={40} y={130} fontSize={8} fill="#64748B">0</text>
          </svg>
          <div className="mt-1 text-[9px] text-slate-500">Each dot is one day. Points far above the 1:1 line = many sub-kilometre fires only VIIRS 375 m can see (crop residue, grass); near the line = fewer, larger fires. This IS the harmonization problem of Challenge #9, visible in one chart.</div>
        </div>

        {/* day/night + verdict */}
        <div className="space-y-4">
          <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/60 p-3">
            <div className="mb-2 text-[11px] font-bold text-slate-200">Day / night balance per day</div>
            <div className="space-y-1.5">
              {days.map((d) => {
                const dayN = d.total - d.night;
                const dw = d.total ? (dayN / d.total) * 100 : 0;
                return (
                  <div key={d.day} className="flex items-center gap-2">
                    <span className="w-14 shrink-0 font-mono text-[9px] text-slate-500">{d.day.slice(5)}</span>
                    <div className="flex h-3.5 flex-1 overflow-hidden rounded-sm bg-[#0F1D31]">
                      <div style={{ width: `${dw}%`, background: 'linear-gradient(90deg,#F59E0B,#FBBF24)' }} />
                      <div style={{ width: `${100 - dw}%`, background: 'linear-gradient(90deg,#4338CA,#6366F1)' }} />
                    </div>
                    <span className="w-16 shrink-0 text-right font-mono text-[9px] text-slate-400">{d.night}/{d.total}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 text-[9px] text-slate-500">Amber = day overpass, indigo = night. A rising night share usually means smouldering peat or escaped fire lines, not new ignitions.</div>
          </div>
          <div className="rounded-lg border border-orange-500/25 bg-gradient-to-br from-orange-950/30 to-[#0A1423]/70 p-3">
            <div className="mb-1.5 text-[11px] font-bold text-orange-200">Deterministic dynamics verdict</div>
            <ul className="space-y-1 text-[10.5px] leading-relaxed text-slate-300">
              <li>• Trajectory: <b className={trendWord === 'ESCALATING' ? 'text-red-300' : trendWord === 'DECLINING' ? 'text-emerald-300' : 'text-amber-300'}>{trendWord}</b> — {first.total.toLocaleString()} → {last.total.toLocaleString()} detections ({delta >= 0 ? '+' : ''}{delta.toFixed(0)}%).</li>
              <li>• Busiest day: <b className="text-slate-100">{bigDay.day}</b> with {bigDay.total.toLocaleString()} detections; peak energy {fmtNum(frpDay.frp)} MW on <b className="text-slate-100">{frpDay.day}</b>.</li>
              <li>• Sensor ratio (VIIRS:MODIS, last day): <b className="text-slate-100">{(() => { const m = (last.perSensor['MODIS-Terra'] || 0) + (last.perSensor['MODIS-Aqua'] || 0); const v = (last.perSensor['VIIRS-SNPP'] || 0) + (last.perSensor['VIIRS-NOAA20'] || 0) + (last.perSensor['VIIRS-NOAA21'] || 0); return m ? (v / m).toFixed(1) : '—'; })()}:1</b> — the live harmonization ratio your AOI exhibits today.</li>
              <li>• High-confidence share across window: <b className="text-slate-100">{(() => { const t = days.reduce((a, d) => a + d.total, 0); const h = days.reduce((a, d) => a + d.hi, 0); return t ? Math.round((h / t) * 100) : 0; })()}%</b> (≥70% confidence or VIIRS nominal).</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
