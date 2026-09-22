'use client';

import type { FireWeather } from '@/lib/ignis/fireweather';

type Props = { fw: FireWeather | null; loading: boolean; error: string | null; name: string };

export default function FireWeatherPanel({ fw, loading, error, name }: Props) {
  const maxScore = 100;

  return (
    <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-wide text-slate-100">7-DAY FIRE-WEATHER EARLY WARNING</h3>
        <span className="rounded bg-[#13253D] px-1.5 py-0.5 text-[9px] text-slate-400">Open-Meteo · client-side</span>
      </div>
      <p className="text-[10.5px] text-slate-500">{name} — transparent composite of Tmax, RH deficit, wind &amp; 3-day rain</p>

      {loading && <div className="mt-3 h-24 animate-pulse rounded bg-[#0C1A2E]" />}
      {error && !loading && (
        <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-amber-300">
          Fire weather unavailable from this network ({error}). This panel calls Open-Meteo directly from your browser — it works on standard connections and on the production deployment.
        </div>
      )}
      {fw && !loading && (
        <>
          <div className="mt-3 flex items-center gap-2 rounded-lg border px-3 py-2" style={{ borderColor: fw.verdict.color + '55', background: fw.verdict.color + '10' }}>
            <span className="rounded px-2 py-0.5 text-xs font-bold text-slate-950" style={{ background: fw.verdict.color }}>{fw.verdict.label}</span>
            <span className="text-[11px] text-slate-300">peak danger {fw.peak.date} (score {fw.peak.score}) — {fw.verdict.advice}</span>
          </div>
          <div className="mt-3 flex items-end gap-1.5">
            {fw.days.map((d) => (
              <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[9px] text-slate-500">{d.score}</span>
                <div className="flex h-20 w-full items-end overflow-hidden rounded bg-[#0C1A2E]">
                  <div className="w-full rounded transition-all" style={{ height: `${(d.score / maxScore) * 100}%`, background: d.score >= 62 ? '#DC2626' : d.score >= 45 ? '#F59E0B' : d.score >= 28 ? '#FACC15' : '#22C55E', opacity: 0.85 }} />
                </div>
                <span className="text-[9px] text-slate-500">{d.date.slice(5)} · {d.tmax}°C</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-slate-500">Blend climatology (when fires usually happen) with this live weather layer (whether they can spread today) for operational early warning.</p>
        </>
      )}
    </div>
  );
}
