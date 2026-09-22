'use client';

import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CalendarDoc } from '@/lib/ignis/types';
import { SENSOR_COLORS } from '@/lib/ignis/regions';
import { buildUnified, buildClimatology, anomalyZ, fmtNum, ymLabel } from '@/lib/ignis/analytics';

type Props = { doc: CalendarDoc | null; loading: boolean; onPickDate: (ym: string) => void };

type View = 'harmonized' | 'per-sensor' | 'frp';

const SENSOR_LABELS: Record<string, string> = {
  'MODIS-Terra': 'MODIS Terra (1 km, 2000–now)',
  'MODIS-Aqua': 'MODIS Aqua (1 km, 2002–now)',
  'VIIRS-SNPP': 'VIIRS S-NPP (375 m, 2012–now)',
  'VIIRS-NOAA20': 'VIIRS NOAA-20 (375 m, 2018–now)',
  'VIIRS-NOAA21': 'VIIRS NOAA-21 (375 m, 2023–now)',
};

export default function CalendarPanel({ doc, loading, onPickDate }: Props) {
  const [view, setView] = useState<View>('harmonized');
  const [hover, setHover] = useState<string | null>(null);

  const { rows, clim, years, maxV } = useMemo(() => {
    if (!doc) return { rows: [], clim: null, years: [] as string[], maxV: 1 };
    const u = buildUnified(doc);
    const c = buildClimatology(u.rows);
    const ys: string[] = [];
    for (const r of u.rows) { const y = r.ym.slice(0, 4); if (!ys.includes(y)) ys.push(y); }
    ys.sort();
    const maxV = Math.max(1, ...u.rows.map((r) => r.count));
    return { rows: u.rows, clim: c, years: ys, maxV };
  }, [doc]);

  const zByYm = useMemo(() => {
    const m = new Map<string, number>();
    if (!clim) return m;
    for (const r of rows) { const z = anomalyZ(rows, clim, r.ym); if (z !== null) m.set(r.ym, z); }
    return m;
  }, [rows, clim]);

  if (loading || !doc) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-[#14273F] bg-[#0A1423]/70 text-sm text-slate-400">
        {loading ? 'Loading the 26-year harmonized fire calendar…' : 'Calendar is precomputed from GIBS vector tiles — check back shortly.'}
      </div>
    );
  }

  const cellColor = (v: number) => {
    if (v <= 0) return 'rgba(30,41,59,0.35)';
    const t = Math.min(1, Math.pow(v / maxV, 0.4));
    const r = Math.round(120 + 135 * t);
    const g = Math.round(60 * (1 - t) + 30);
    const b = Math.round(20 * (1 - t));
    return `rgba(${r},${g},${b},${0.25 + 0.75 * t})`;
  };

  const u = buildUnified(doc);
  const meta = u.meta;

  return (
    <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-wide text-slate-100">BURNING ACTIVITY CALENDAR — {doc.name.toUpperCase()}</h3>
          <p className="text-[11px] text-slate-400">One comparable record across the sensor break · click any month to load it on the map</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-full border border-[#1E3A5F] px-2.5 py-1 text-slate-300">
            continuity ×{meta.ratioCount ? meta.ratioCount.toFixed(1) : '—'} <span className="text-slate-500">over {meta.overlapMonths} overlap months</span>
          </span>
          <div className="flex overflow-hidden rounded-full border border-[#1E3A5F]">
            {(['harmonized', 'per-sensor', 'frp'] as View[]).map((v) => (
              <button key={v} onClick={() => setView(v)} className={`px-3 py-1 capitalize ${view === v ? 'bg-[#38BDF8] text-slate-950' : 'text-slate-400'}`}>{v.replace('-', ' ')}</button>
            ))}
          </div>
        </div>
      </div>

      {view === 'harmonized' && clim && (
        <div className="overflow-x-auto">
          <div className="min-w-[680px]">
            <div className="flex">
              <div className="w-11 shrink-0" />
              <div className="grid flex-1 grid-cols-12 gap-[2px]">
                {['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'].map((m, i) => (
                  <div key={i} className="text-center text-[9px] text-slate-500">{m}</div>
                ))}
              </div>
            </div>
            {years.map((y) => (
              <div key={y} className="flex items-center">
                <div className="w-11 shrink-0 text-[10px] text-slate-500">{y}</div>
                <div className="grid flex-1 grid-cols-12 gap-[2px] pb-[2px]">
                  {Array.from({ length: 12 }, (_, mi) => {
                    const ym = `${y}-${String(mi + 1).padStart(2, '0')}`;
                    const row = rows.find((r) => r.ym === ym);
                    const z = zByYm.get(ym);
                    const unusual = z !== undefined && Math.abs(z) >= 2;
                    const v = row?.count ?? 0;
                    return (
                      <button
                        key={ym}
                        onClick={() => onPickDate(ym)}
                        onMouseEnter={() => setHover(ym)}
                        title={`${ymLabel(ym)}: est ${v.toLocaleString()} detections${row ? ` · Σ FRP ${fmtNum(row.frp)} MW` : ''}${z !== undefined ? ` · z ${z > 0 ? '+' : ''}${z}` : ''}${row?.scaled ? ' · MODIS-era scaled' : ''}`}
                        className={`h-[13px] rounded-[2px] transition-transform hover:scale-125 ${unusual ? 'ring-1 ring-cyan-300' : ''}`}
                        style={{ background: cellColor(v) }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[10px] text-slate-500">
              <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm ring-1 ring-cyan-300" /> ring = unusual month (|z| ≥ 2 vs 2000–2023 climatology)</span>
              <span className="flex items-center gap-1.5">scaled months use the ×{meta.ratioCount?.toFixed(1)} continuity coefficient</span>
              {hover && <span className="text-slate-300">{hover}: {rows.find((r) => r.ym === hover)?.count.toLocaleString() ?? 0} est. detections</span>}
            </div>
          </div>
        </div>
      )}

      {view === 'per-sensor' && (
        <div className="space-y-2 overflow-x-auto">
          {Object.entries(doc.sensors).map(([s, sv]) => {
            const maxS = Math.max(1, ...sv.monthly.map((m) => m.est));
            const ys: string[] = [];
            for (const r of sv.monthly) { const y = r.ym.slice(0, 4); if (!ys.includes(y)) ys.push(y); }
            ys.sort();
            return (
              <div key={s} className="min-w-[680px]">
                <div className="mb-1 flex items-center gap-2 text-[11px]" style={{ color: SENSOR_COLORS[s] || '#94A3B8' }}>
                  <span className="font-semibold">{s}</span>
                  <span className="text-slate-500">{SENSOR_LABELS[s] ?? ''} · max {maxS.toLocaleString()} det/mo</span>
                </div>
                <div className="flex">
                  <div className="w-11 shrink-0" />
                  <div className="grid flex-1 grid-cols-12 gap-[2px]">
                    {['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'].map((m, i) => <div key={i} className="text-center text-[9px] text-slate-500">{m}</div>)}
                  </div>
                </div>
                {ys.map((y) => (
                  <div key={s + y} className="flex items-center">
                    <div className="w-11 shrink-0 text-[10px] text-slate-500">{y}</div>
                    <div className="grid flex-1 grid-cols-12 gap-[2px] pb-[2px]">
                      {Array.from({ length: 12 }, (_, mi) => {
                        const ym = `${y}-${String(mi + 1).padStart(2, '0')}`;
                        const row = sv.monthly.find((m) => m.ym === ym);
                        return (
                          <button key={ym} onClick={() => onPickDate(ym)}
                            title={`${s} ${ym}: est ${row?.est ?? 0} · FRP ${row?.frp ?? 0} MW`}
                            className="h-[10px] rounded-[2px] transition-transform hover:scale-125"
                            style={{ background: cellColor(row?.est ?? 0) }} />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
          <p className="text-[10px] text-slate-500">Raw per-sensor records (VIIRS S-NPP/NOAA-20 from GIBS archive; NOAA-21 begins 2024). The gaps are the “split record” this challenge asks us to heal.</p>
        </div>
      )}

      {view === 'frp' && (
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows.filter((r) => r.ym >= `${Number(rows[rows.length - 1].ym.slice(0, 4)) - 10}`).map((r) => ({ ym: r.ym, frp: r.frp, scaled: r.scaled }))}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              onClick={(e) => { const p = e?.activePayload?.[0]?.payload as { ym?: string } | undefined; if (p?.ym) onPickDate(p.ym); }}>
              <CartesianGrid stroke="#13253D" strokeDasharray="3 3" />
              <XAxis dataKey="ym" tick={{ fill: '#64748B', fontSize: 9 }} minTickGap={48} />
              <YAxis tick={{ fill: '#64748B', fontSize: 10 }} width={52} tickFormatter={(v: number) => fmtNum(v)} />
              <Tooltip contentStyle={{ background: '#0B1524', border: '1px solid #1E3A5F', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#94A3B8' }}
                formatter={(value: number, name: string) => [`${fmtNum(value)} MW${name === 'frp' ? '' : ''}`, name === 'frp' ? 'Σ FRP (harmonized)' : name]} />
              <Bar dataKey="frp" fill="#F97316" />
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-1 text-[10px] text-slate-500">Fire Radiative Power is physically comparable across sensors (MW is MW) — the cleanest continuity signal. Click a bar to load that month.</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-[#13253D] pt-2 text-[11px] text-slate-400">
        <span>VIIRS 375 m resolves fires ~450× smaller in area — the ×{meta.ratioCount ? meta.ratioCount.toFixed(1) : '—'} coefficient makes MODIS-era months comparable</span>
        {meta.ratioCV !== null && <span className="text-slate-500">ratio variability CV {meta.ratioCV} → ±{Math.round(meta.ratioCV * 100)}% uncertainty on scaled months</span>}
        <span className="text-slate-500">Source: {doc.meta.source}</span>
      </div>
    </div>
  );
}
