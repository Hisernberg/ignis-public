'use client';

import { useMemo } from 'react';
import type { CalendarDoc } from '@/lib/ignis/types';
import { buildUnified, regimeFeatures, classifyRegime, MONTH_LABELS } from '@/lib/ignis/analytics';

type Props = { doc: CalendarDoc | null };

export default function RegimePanel({ doc }: Props) {
  const result = useMemo(() => {
    if (!doc) return null;
    const u = buildUnified(doc);
    const fv = regimeFeatures(doc, u.rows);
    if (!fv) return null;
    return { regime: classifyRegime(fv), fv };
  }, [doc]);

  if (!doc || !result) {
    return <div className="flex h-48 items-center justify-center rounded-xl border border-[#14273F] bg-[#0A1423]/70 text-sm text-slate-400">Regime classification loads with the calendar…</div>;
  }

  const { regime, fv } = result;

  return (
    <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold tracking-wide text-slate-100">BURN-REGIME CLASSIFIER — {doc.name.toUpperCase()}</h3>
        <p className="text-[11px] text-slate-400">Nearest-prototype classification against 8 NASA-derived reference regions (features from the 26-yr harmonized record)</p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
          <div className="text-[10px] uppercase tracking-widest text-orange-300/80">Matched regime</div>
          <div className="mt-0.5 text-lg font-bold text-orange-200">{regime.top.label}</div>
          <div className="mt-0.5 text-[11px] text-slate-300">{regime.top.note}</div>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#13253D]">
              <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-500" style={{ width: `${Math.round(regime.top.similarity * 100)}%` }} />
            </div>
            <span className="text-[11px] font-bold text-orange-300">{Math.round(regime.top.similarity * 100)}%</span>
          </div>
          <div className="mt-2 space-y-1 text-[10.5px] text-slate-400">
            {regime.runners.map((r) => (
              <div key={r.key} className="flex items-center justify-between rounded bg-[#060D1A] px-2 py-1">
                <span>runner-up: <span className="text-slate-200">{r.label}</span></span>
                <span>{Math.round(r.similarity * 100)}%</span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Feature vector · this AOI vs matched prototype</div>
          {regime.features.map((f) => {
            const isMonth = f.name.startsWith('Peak');
            const a = isMonth ? MONTH_LABELS[f.value] : f.value.toLocaleString();
            const b = isMonth ? MONTH_LABELS[f.matchValue] : f.matchValue.toLocaleString();
            return (
              <div key={f.name} className="flex items-center justify-between rounded bg-[#060D1A] px-2.5 py-1.5 text-[11px]">
                <span className="text-slate-400">{f.name}</span>
                <span className="font-mono text-slate-200">{a}{f.unit ? ` ${f.unit}` : ''} <span className="text-slate-500">vs {b}</span></span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-3 text-[10.5px] leading-relaxed text-slate-500">{regime.summary}</p>
    </div>
  );
}
