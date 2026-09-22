'use client';

import type { EonetRanked, HotspotsResult } from '@/lib/ignis/types';

type Props = { hotspots: HotspotsResult | null; eonet: { ranked: EonetRanked[]; model?: string } | null; loading: boolean };

export type AlertLevel = { level: 'GREEN' | 'AMBER' | 'ORANGE' | 'RED'; reason: string; color: string };

export function computeAlert(hotspots: HotspotsResult | null): AlertLevel {
  if (!hotspots) return { level: 'GREEN', reason: 'no data', color: '#22C55E' };
  const counts = Object.values(hotspots.sensors).map((s) => s.count);
  const total = counts.reduce((a, b) => a + b, 0);
  const frp = Object.values(hotspots.sensors).reduce((a, s) => a + s.points.reduce((x, p) => x + (p.frp || 0), 0), 0);
  if (total >= 150 || frp >= 2500) return { level: 'RED', reason: `${total} detections · ${Math.round(frp)} MW FRP — significant fire activity in AOI`, color: '#EF4444' };
  if (total >= 60 || frp >= 1200) return { level: 'ORANGE', reason: `${total} detections · ${Math.round(frp)} MW FRP — elevated activity`, color: '#F97316' };
  if (total >= 20) return { level: 'AMBER', reason: `${total} detections — scattered activity`, color: '#FACC15' };
  return { level: 'GREEN', reason: `${total} detections — low activity`, color: '#22C55E' };
}

export default function AlertsPanel({ hotspots, eonet, loading }: Props) {
  const alert = computeAlert(hotspots);
  return (
    <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
      <h3 className="text-sm font-semibold tracking-wide text-slate-100">EARLY WARNING & EVENT TRIAGE</h3>
      <div className="mt-2 flex items-center gap-3 rounded-lg border px-3 py-2" style={{ borderColor: alert.color + '55', background: alert.color + '10' }}>
        <span className="rounded px-2 py-0.5 text-xs font-bold text-slate-950" style={{ background: alert.color }}>{alert.level}</span>
        <span className="text-[11px] text-slate-300">{alert.reason} · rule-engine on live detections (no LLM required)</span>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold text-slate-200">OPEN WILDFIRE EVENTS (EONET v3) — RANKED FOR THIS AOI</div>
          {eonet?.model && <div className="text-[9px] text-slate-500">{eonet.model}</div>}
        </div>
        {loading && <div className="mt-2 text-[11px] text-slate-500">Fetching events + computing semantic relevance…</div>}
        <div className="mt-1 max-h-56 space-y-1 overflow-y-auto pr-1">
          {(eonet?.ranked || []).map((ev) => (
            <a key={ev.id} href={ev.link} target="_blank" rel="noreferrer"
              className="block rounded bg-[#060D1A] px-2 py-1.5 text-[11px] transition-colors hover:bg-[#0C1A2E]">
              <div className="flex items-start justify-between gap-2">
                <span className="text-slate-200">{ev.title}</span>
                <span className="shrink-0 rounded bg-cyan-950/60 px-1.5 text-[9px] text-cyan-300">rel {ev.relevance.toFixed(2)}</span>
              </div>
              <div className="text-[9px] text-slate-500">{ev.date?.slice(0, 10)}{ev.lat !== null ? ` · ${ev.lat.toFixed(1)}°, ${ev.lon!.toFixed(1)}°` : ''}{ev.semanticScore !== null ? ` · semantic ${ev.semanticScore.toFixed(2)}` : ''}</div>
            </a>
          ))}
          {!loading && (eonet?.ranked?.length || 0) === 0 && <div className="text-[11px] text-slate-500">No open wildfire events right now.</div>}
        </div>
      </div>
    </div>
  );
}
