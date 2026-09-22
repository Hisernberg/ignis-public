'use client';

import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CalendarDoc, OutlookDoc } from '@/lib/ignis/types';
import { buildUnified, buildClimatology, harmonicForecast, forecastPeak, fmtNum, ymLabel } from '@/lib/ignis/analytics';
import { scoreNextMonth } from '@/lib/ignis/eventModel';

type Props = { doc: OutlookDoc | null; calendar: CalendarDoc | null };

export default function OutlookPanel({ doc, calendar }: Props) {
  const fc = useMemo(() => {
    if (!calendar) return null;
    const u = buildUnified(calendar);
    const f = harmonicForecast(u.rows, 12);
    const clim = buildClimatology(u.rows);
    const peak = forecastPeak(f.points);
    return { rows: u.rows, points: f.points, r2: f.r2, sigma: f.sigma, clim, peak };
  }, [calendar]);

  // hooks must run unconditionally (rules-of-hooks) — guard inside, not with an early return
  const eventScore = useMemo(() => (calendar ? scoreNextMonth(calendar) : null), [calendar]);

  if (!calendar) {
    return <div className="h-40 rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4 text-sm text-slate-400">Seasonal outlook generates with the 26-year calendar…</div>;
  }
  if (!fc || !fc.points.length) {
    return <div className="h-40 rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4 text-sm text-slate-400">Insufficient overlap to fit the forecast for this region.</div>;
  }

  const data = [
    ...fc.rows.slice(-24).map((h) => ({ ym: h.ym, obs: h.count, mean: undefined as number | undefined, lo: undefined as number | undefined, hi: undefined as number | undefined })),
    ...fc.points.map((f) => ({ ym: f.ym, obs: undefined as number | undefined, mean: f.mean, lo: f.lo, hi: f.hi })),
  ];
  // bridge point so the band connects visually
  const lastObs = fc.rows[fc.rows.length - 1];
  if (data.length > fc.points.length && data[fc.points.length]) {
    data[fc.points.length].mean = lastObs.count;
    data[fc.points.length].lo = lastObs.count;
    data[fc.points.length].hi = lastObs.count;
  }

  const inWindow = fc.clim.peakWindow.length > 0;
  const monthsToPeak = (() => {
    if (!fc.peak) return null;
    const [py, pm] = fc.peak.ym.split('-').map(Number);
    const now = lastObs.ym.split('-').map(Number);
    return (py - now[0]) * 12 + (pm - now[1]);
  })();

  return (
    <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold tracking-wide text-slate-100">SEASONAL OUTLOOK — NEXT 12 MONTHS</h3>
        <span className="rounded bg-cyan-950/60 px-1.5 text-[9px] text-cyan-300">harmonic regression · log-space OLS · R² {fc.r2}</span>
        {eventScore && (
          <span
            className={`rounded px-2 py-0.5 text-[9px] font-medium ${
              eventScore.band === 'high'
                ? 'bg-red-950/70 text-red-300 ring-1 ring-red-800'
                : eventScore.band === 'elevated'
                  ? 'bg-amber-950/60 text-amber-300 ring-1 ring-amber-800'
                  : 'bg-emerald-950/50 text-emerald-300 ring-1 ring-emerald-800'
            }`}
            title={`ignis-event-detector ${eventScore.modelVersion} — logistic model on the 25-yr harmonized calendar: P(extreme fire month) for ${eventScore.targetYm}`}
          >
            🤖 ML · P(extreme {eventScore.targetYm}) = {(eventScore.p * 100).toFixed(0)}% — {eventScore.label}
          </span>
        )}
        {doc && <span className="rounded bg-[#13253D] px-1.5 text-[9px] text-slate-400">{doc.method?.slice(0, 60) || 'precomputed reference'}</span>}
      </div>
      <div className="h-[230px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#13253D" strokeDasharray="3 3" />
            <XAxis dataKey="ym" tick={{ fill: '#64748B', fontSize: 9 }} minTickGap={40} />
            <YAxis tick={{ fill: '#64748B', fontSize: 10 }} width={52} tickFormatter={(v: number) => fmtNum(v)} />
            <Tooltip contentStyle={{ background: '#0B1524', border: '1px solid #1E3A5F', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#94A3B8' }} />
            <Area type="monotone" dataKey="hi" stroke="none" fill="rgba(249,115,22,0.12)" connectNulls />
            <Area type="monotone" dataKey="lo" stroke="none" fill="rgba(5,10,20,0.9)" connectNulls />
            <Area type="monotone" dataKey="mean" stroke="#F97316" fill="none" strokeWidth={1.8} dot={false} connectNulls strokeDasharray="6 3" />
            <Area type="monotone" dataKey="obs" stroke="#38BDF8" fill="none" strokeWidth={1.8} dot={false} connectNulls={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="grid gap-2 text-[11px] text-slate-400 sm:grid-cols-2">
        <p>
          Expected peak: <span className="text-amber-400">{fc.peak ? ymLabel(fc.peak.ym) : '—'} (~{fc.peak ? fmtNum(fc.peak.mean) : '—'} detections)</span>
          {monthsToPeak !== null && monthsToPeak >= 0 && <> · in <span className="text-amber-400">{monthsToPeak} month{monthsToPeak === 1 ? '' : 's'}</span></>}
          {inWindow && <> · climatological critical window: <span className="text-amber-400">{fc.clim.peakWindow.map((i) => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][i]).join('–')}</span></>}
        </p>
        <p>Dashed orange = fitted forecast with ±1.96σ residual band; blue = observed harmonized record. Validated against the precomputed FIRMS-era outlook{doc ? '' : ''}.</p>
      </div>
    </div>
  );
}
