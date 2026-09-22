'use client';

import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis, ComposedChart, Area } from 'recharts';
import type { CalendarDoc } from '@/lib/ignis/types';
import { buildUnified, decompose, buildClimatology, theilSen, changePoints, fmtNum, ymLabel } from '@/lib/ignis/analytics';

type Props = { doc: CalendarDoc | null };
type Tab = 'decompose' | 'climatology' | 'trend';

export default function TimeSeriesPanel({ doc }: Props) {
  const [tab, setTab] = useState<Tab>('decompose');

  const data = useMemo(() => {
    if (!doc) return null;
    const u = buildUnified(doc);
    const rows = u.rows;
    const dec = decompose(rows);
    const clim = buildClimatology(rows);
    const ts = theilSen(rows.map((r) => r.count));
    const cps = changePoints(rows);
    const annual = new Map<number, { sum: number; n: number }>();
    for (const r of rows) {
      const y = Number(r.ym.slice(0, 4));
      const a = annual.get(y) || { sum: 0, n: 0 };
      a.sum += r.count; a.n++;
      annual.set(y, a);
    }
    const annualArr = [...annual.entries()].filter(([, a]) => a.n >= 10).map(([y, a]) => ({ y, total: a.sum }));
    const decadeStart = rows[0]?.count ? rows[0] : null;
    void decadeStart;
    return { rows, dec, clim, trendSlope: ts.slope, cps, annualArr };
  }, [doc]);

  if (!doc || !data) {
    return <div className="flex h-56 items-center justify-center rounded-xl border border-[#14273F] bg-[#0A1423]/70 text-sm text-slate-400">Time-series lab loads with the calendar…</div>;
  }

  const { dec, clim, trendSlope, cps, annualArr } = data;
  const perDecade = +(trendSlope * 120).toFixed(0);
  const medianAll = [...data.rows.map((r) => r.count)].sort((a, b) => a - b)[Math.floor(data.rows.length / 2)];
  const pctPerDecade = medianAll ? Math.round((perDecade / medianAll) * 100) : 0;

  return (
    <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-wide text-slate-100">TIME-SERIES LAB — {doc.name.toUpperCase()}</h3>
          <p className="text-[11px] text-slate-400">26-year harmonized record · deterministic, auditable statistics (no black-box)</p>
        </div>
        <div className="ml-auto flex overflow-hidden rounded-full border border-[#1E3A5F] text-[11px]">
          {(['decompose', 'climatology', 'trend'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 capitalize ${tab === t ? 'bg-[#38BDF8] text-slate-950' : 'text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      {tab === 'decompose' && (
        <>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dec.filter((d) => d.ym >= `${Number(dec[dec.length - 1].ym.slice(0, 4)) - 12}-01`)} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#13253D" strokeDasharray="3 3" />
                <XAxis dataKey="ym" tick={{ fill: '#64748B', fontSize: 9 }} minTickGap={48} />
                <YAxis tick={{ fill: '#64748B', fontSize: 10 }} width={52} tickFormatter={(v: number) => fmtNum(v)} />
                <Tooltip contentStyle={{ background: '#0B1524', border: '1px solid #1E3A5F', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#94A3B8' }} />
                <Line type="monotone" dataKey="observed" stroke="#94A3B8" dot={false} strokeWidth={1} name="observed" />
                <Line type="monotone" dataKey="trend" stroke="#38BDF8" dot={false} strokeWidth={2} name="trend (12-mo MA)" />
                <Line type="monotone" dataKey="seasonal" stroke="#F97316" dot={false} strokeWidth={1.2} strokeDasharray="4 3" name="seasonal" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-[10.5px] text-slate-500">
            Classical decomposition: grey = observed harmonized detections, blue = 12-month centered moving-average trend, orange = repeating seasonal component. Residual spikes after removing both = <span className="text-amber-400">unusual conditions</span> (e.g. drought megafire years).
          </p>
        </>
      )}

      {tab === 'climatology' && (
        <>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={clim.mean.map((m, i) => ({
                  month: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][i],
                  mean: m,
                  band: m + clim.std[i],
                  isPeak: i === clim.peakMonth,
                }))}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#13253D" strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fill: '#64748B', fontSize: 10 }} />
                <YAxis tick={{ fill: '#64748B', fontSize: 10 }} width={52} tickFormatter={(v: number) => fmtNum(v)} />
                <Tooltip contentStyle={{ background: '#0B1524', border: '1px solid #1E3A5F', borderRadius: 8, fontSize: 12 }} />
                <Area type="monotone" dataKey="band" name="mean + 1σ" stroke="none" fill="rgba(56,189,248,0.10)" />
                <Area type="monotone" dataKey="mean" stroke="#F97316" fill="rgba(249,115,22,0.18)" strokeWidth={2} name="monthly mean 2000–2023" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-[10.5px] text-slate-500">
            Monthly climatology of the harmonized record (baseline 2000–2023). Peak: <span className="text-amber-400">{['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][clim.peakMonth]}</span> · critical window (≥70% of peak): <span className="text-amber-400">{clim.peakWindow.map((i) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][i]).join('–')}</span>.
          </p>
        </>
      )}

      {tab === 'trend' && (
        <>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={annualArr.map((a) => ({ y: String(a.y), total: a.total }))} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#13253D" strokeDasharray="3 3" />
                <XAxis dataKey="y" tick={{ fill: '#64748B', fontSize: 9 }} minTickGap={24} />
                <YAxis tick={{ fill: '#64748B', fontSize: 10 }} width={52} tickFormatter={(v: number) => fmtNum(v)} />
                <Tooltip contentStyle={{ background: '#0B1524', border: '1px solid #1E3A5F', borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="total" stroke="#38BDF8" dot={{ r: 1.5 }} strokeWidth={1.6} name="annual detections (12-mo norm.)" />
                {cps.map((cp) => (
                  <ReferenceDot key={cp.year} x={String(cp.year)} y={annualArr.find((a) => a.y === cp.year)?.total ?? 0} r={5} fill="#F97316" stroke="#fff" strokeWidth={1} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1 grid gap-2 text-[10.5px] text-slate-400 sm:grid-cols-2">
            <p><span className="text-cyan-300">Robust trend (Theil-Sen):</span> {perDecade >= 0 ? '+' : ''}{fmtNum(perDecade)} detections/decade ({pctPerDecade >= 0 ? '+' : ''}{pctPerDecade}% vs typical month). Robust to outlier megayears.</p>
            <p><span className="text-cyan-300">Change points (CUSUM):</span> {cps.length ? cps.map((cp) => `${cp.year} (confidence ${(cp.score * 100).toFixed(0)}%, ${fmtNum(cp.before)}→${fmtNum(cp.after)}/yr)`).join(' · ') : 'no regime shift above threshold'}</p>
          </div>
        </>
      )}
    </div>
  );
}
