'use client';

import { useEffect, useState } from 'react';

type RepoMeta = {
  id: string;
  private: boolean;
  likes: number;
  downloads: number;
  lastModified: string | null;
  files: string[];
} | null;

type FamilyModel = {
  id: string;
  task: string;
  metric: string;
  private: boolean | null;
  lastModified: string | null;
  files: string[];
  metrics: Record<string, unknown> | null;
  url: string;
};

type StackItem = { name: string; role: string; via: string };

type HfPayload = {
  ok: boolean;
  visibility: string;
  modelFamily: FamilyModel[];
  dataset: RepoMeta;
  urls: { dataset: string; viewer: string };
  preview: { columns: string[] | null; rows: Record<string, unknown>[] | null };
  stack: StackItem[];
};

function Stat({ label, value, tone = 'text-slate-100' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/70 px-3 py-2">
      <div className="text-[9.5px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-[13px] font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

export default function OpenSciencePanel() {
  const [data, setData] = useState<HfPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/hf')
      .then((r) => r.json())
      .then((d: HfPayload) => { if (alive) setData(d); })
      .catch(() => { if (alive) setErr('Hugging Face Hub unreachable'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center text-[11px] text-slate-500">
        Loading IGNIS model family from the Hugging Face Hub…
      </div>
    );
  }
  if (err || !data) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-2 text-[11px] text-slate-500">
        <span>{err ?? 'No open-science payload'}</span>
        <a className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-cyan-300 hover:bg-cyan-500/20"
          href="https://huggingface.co/datasets/Nabidnur/ignis-fire-calendar" target="_blank" rel="noreferrer">
          Open dataset on Hugging Face ↗
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-slate-300">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-semibold text-slate-100">IGNIS Model Family on the Hugging Face Hub</div>
          <div className="text-[10.5px] text-slate-500">
            Four custom models + a 26-year harmonized dataset, all trained on real NASA FIRMS data. Live Hub status, fetched now.
            <span className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-amber-300">{data.visibility}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <a className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-[10.5px] text-cyan-300 hover:bg-cyan-500/20"
            href={data.urls.dataset} target="_blank" rel="noreferrer">🤗 Dataset: ignis-fire-calendar ↗</a>
        </div>
      </div>

      {/* Model family */}
      <div className="grid gap-2 sm:grid-cols-2">
        {data.modelFamily.map((m) => {
          const live = [
            ['ignis-fire-regime-model', '⚡ LIVE · Burn Regime panel (on-device prototypes)'],
            ['ignis-fire-classifier', '⚡ LIVE · every detection scored + cluster ML votes'],
            ['ignis-event-detector', '⚡ LIVE · Seasonal Outlook P(extreme) badge'],
            ['ignis-fire-footprint-forecaster', '⚡ LIVE · map 🔮 next-day footprint overlay'],
          ].find(([id]) => m.id.endsWith(id))?.[1];
          return (
          <a key={m.id} href={m.url} target="_blank" rel="noreferrer"
            className="group rounded-lg border border-[#14273F] bg-[#0A1423]/70 p-3 transition-colors hover:border-cyan-600/50">
            <div className="flex items-center justify-between">
              <div className="text-[11.5px] font-semibold text-slate-100 group-hover:text-cyan-200">🤗 {m.id.split('/')[1]}</div>
              <span className={`rounded px-1.5 py-0.5 text-[9px] ${m.private ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                {m.private === null ? 'unreachable' : m.private ? 'private' : 'public'}
              </span>
            </div>
            <div className="mt-1 text-[10px] text-cyan-300/90">{m.task}</div>
            <div className="text-[10px] text-slate-400">{m.metric}</div>
            {live && <div className="mt-1 inline-block rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold text-violet-300">{live}</div>}
            <div className="mt-2 flex flex-wrap gap-1">
              {(m.files ?? []).slice(0, 5).map((f) => (
                <span key={f} className="rounded bg-[#13253D] px-1.5 py-0.5 font-mono text-[9px] text-slate-400">{f.split('/').slice(-1)[0]}</span>
              ))}
              {(m.files?.length ?? 0) > 5 && (
                <span className="rounded bg-[#13253D] px-1.5 py-0.5 text-[9px] text-slate-500">+{(m.files?.length ?? 0) - 5} more</span>
              )}
            </div>
          </a>
          );
        })}
      </div>

      {/* AI stack */}
      <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/70 p-3">
        <div className="mb-1.5 text-[11.5px] font-semibold text-slate-100">How IGNIS uses Hugging Face — 7 ways</div>
        <div className="grid gap-1.5 md:grid-cols-2">
          {data.stack.map((s) => (
            <div key={s.name} className="rounded-md border border-[#14273F] bg-[#0D1B2E]/60 px-2.5 py-2">
              <div className="font-mono text-[10.5px] text-cyan-300">{s.name}</div>
              <div className="text-[10px] text-slate-300">{s.role}</div>
              <div className="text-[9px] text-slate-500">{s.via}</div>
            </div>
          ))}
        </div>
        <div className="mt-1.5 text-[9.5px] text-slate-500">
          Architecture rule: no runtime chat-LLM dependency — the analyst is opt-in, grounded in live JSON telemetry with
          zero-hallucination guards; the event detector scores client-side from portable weights; every AI feature degrades
          to deterministic logic when the Hub is unavailable.
        </div>
      </div>

      {/* Live dataset preview */}
      <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/70 p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[11.5px] font-semibold text-slate-100">Live dataset preview — datasets-server</div>
          <a className="text-[10px] text-cyan-400 hover:text-cyan-300" href={data.urls.viewer} target="_blank" rel="noreferrer">Open full viewer ↗</a>
        </div>
        {data.preview?.rows ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[9.5px]">
              <thead>
                <tr className="border-b border-[#14273F] text-slate-500">
                  {data.preview.columns?.map((c) => <th key={c} className="px-1.5 py-1 font-medium">{c}</th>)}
                </tr>
              </thead>
              <tbody className="font-mono text-slate-300">
                {data.preview.rows.slice(0, 5).map((r, i) => (
                  <tr key={i} className="border-b border-[#0F1E33]">
                    {data.preview.columns?.map((c) => (
                      <td key={c} className="max-w-[130px] truncate px-1.5 py-1">{String(r[c] ?? '—').slice(0, 22)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-[10px] text-slate-500">
            Row-level preview is warming up on the Hub (datasets-server converts files automatically) —
            the full files are already downloadable from the dataset card.
          </div>
        )}
      </div>

      {/* Reproducibility */}
      <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/70 p-3 text-[10px] leading-relaxed text-slate-400">
        <span className="text-slate-200">Reproducibility pact:</span> every model card ships the exact training script,
        the FIRMS snapshot it trained on, hyper-parameters and validation metrics (including honest baselines and known
        limitations); the dataset card ships schema, harmonization rules (VIIRS l/n/h → 20/50/90, MODIS 0–100 preserved),
        provenance and citation. Anyone can rebuild every number IGNIS shows — the same open science standard as
        NASA+IBM&apos;s Prithvi releases.
      </div>
    </div>
  );
}
