'use client';

import type { Health } from '@/lib/ignis/types';

const fmtDate = (exp?: number) => (exp ? new Date(exp * 1000).toISOString().slice(0, 10) : '—');

export default function StatusRail({ health }: { health: Health | null }) {
  const items: { name: string; ok: boolean; detail: string; href: string }[] = health
    ? [
        { name: 'FIRMS API', ok: health.firms.ok, detail: health.firms.ok ? `MAP_KEY active · ${(health.firms as { transaction_count?: number }).transaction_count ?? 0}/5000 txns` : (health.firms.reason || 'unreachable'), href: 'https://firms.modaps.eosdis.nasa.gov/api/area/' },
        { name: 'api.nasa.gov', ok: health.nasa.ok, detail: health.nasa.ok ? `${health.nasa.remaining ?? '?'}/${health.nasa.limit ?? '?'} req left this hour` : (health.nasa.reason || 'unreachable'), href: 'https://api.nasa.gov' },
        { name: 'GIBS WMTS', ok: health.gibs.ok, detail: health.gibs.ok ? 'raster + vector tiles live' : 'unreachable', href: 'https://gibs.earthdata.nasa.gov' },
        { name: 'EONET', ok: health.eonet.ok, detail: health.eonet.ok ? 'v3 events live' : 'unreachable', href: 'https://eonet.gsfc.nasa.gov' },
        { name: 'Hugging Face', ok: health.hf.ok, detail: health.hf.ok ? `MiniLM + Llama-3.1 analyst${(health.hf as { user?: string }).user ? ` · ${(health.hf as { user?: string }).user}` : ''}` : (health.hf.reason || 'unreachable'), href: 'https://huggingface.co' },
        { name: 'Open-Meteo', ok: health.openmeteo.ok, detail: health.openmeteo.ok ? 'fire weather live' : (health.openmeteo.reason || 'unreachable'), href: 'https://open-meteo.com' },
        { name: 'Earthdata Login', ok: health.edl.ok !== undefined ? health.edl.ok : health.edl.configured && !health.edl.expired, detail: health.edl.configured ? `JWT ${health.edl.uid} · exp ${fmtDate(health.edl.exp)}${health.edl.daysLeft !== undefined ? ` (${health.edl.daysLeft}d)` : ''}${health.edl.ok ? ' · CMR live' : health.edl.reason ? ` · ${health.edl.reason}` : ''}` : 'not configured', href: 'https://urs.earthdata.nasa.gov' },
      ]
    : [];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
      {items.map((it) => (
        <a key={it.name} href={it.href} target="_blank" rel="noreferrer"
          className={`rounded-lg border p-2.5 transition-colors ${it.ok ? 'border-emerald-900/60 bg-emerald-950/20 hover:bg-emerald-950/35' : 'border-amber-900/60 bg-amber-950/20 hover:bg-amber-950/35'}`}>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-200">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${it.ok ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
            {it.name}
          </div>
          <div className="text-[9.5px] leading-tight text-slate-400">{it.detail}</div>
        </a>
      ))}
    </div>
  );
}
