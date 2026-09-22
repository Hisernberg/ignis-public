'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { AnalystMsg } from '@/lib/ignis/types';

type Props = {
  open: boolean;
  onClose: () => void;
  context: Record<string, unknown>;
  seedQuestion: string | null;
  onSeedConsumed: () => void;
  onNavigate: (region?: string, date?: string) => void;
};

const QUICK = [
  'What am I looking at right now?',
  'Is anything unusual happening lately?',
  'When is the next critical period?',
  'Why do MODIS and VIIRS disagree?',
  'Classify this AOI’s burn regime',
  'Take me to the Black Summer in Australia',
];

export default function AiAnalyst({ open, onClose, context, seedQuestion, onSeedConsumed, onNavigate }: Props) {
  const [msgs, setMsgs] = useState<AnalystMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = useCallback(async (q: string, mode: 'chat' | 'sitrep' = 'chat') => {
    const question = q.trim();
    if (!question || busy) return;
    setMsgs((m) => [...m, { role: 'user', content: mode === 'sitrep' ? '🚨 Generate the live situation report (SITREP)' : question }]);
    setInput('');
    setBusy(true);
    try {
      const res = await fetch('/api/analyst', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, context, mode }),
      });
      const j = (await res.json()) as { answer?: string; model?: string; fallback?: boolean; actions?: { region?: string; date?: string } };
      setMsgs((m) => [...m, { role: 'assistant', content: j.answer || 'No answer.', model: j.model, fallback: j.fallback }]);
      if (j.actions && (j.actions.region || j.actions.date)) onNavigate(j.actions.region, j.actions.date);
    } catch {
      setMsgs((m) => [...m, { role: 'assistant', content: 'The analyst service is unreachable from this network. Every other IGNIS panel still works — the analytics are computed in your browser.', model: 'offline', fallback: true }]);
    } finally {
      setBusy(false);
    }
  }, [busy, context, onNavigate]);

  useEffect(() => {
    if (open && seedQuestion) {
      send(seedQuestion);
      onSeedConsumed();
    }
  }, [open, seedQuestion, send, onSeedConsumed]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-[#1E3A5F] bg-[#060D1A] shadow-2xl">
        <header className="flex items-center gap-3 border-b border-[#13253D] px-4 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-amber-400 text-sm">✦</div>
          <div>
            <h2 className="text-sm font-bold tracking-wide text-slate-100">IGNIS AI ANALYST</h2>
            <p className="text-[9.5px] text-slate-500">Hugging Face Llama-3.1-8B-Instruct · grounded in live NASA telemetry · MiniLM triage</p>
          </div>
          <button onClick={onClose} className="ml-auto rounded px-2 py-1 text-slate-400 hover:bg-[#0C1A2E] hover:text-slate-200" aria-label="Close analyst">✕</button>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {msgs.length === 0 && (
            <div className="rounded-lg border border-[#1E3A5F] bg-[#0A1423] p-3 text-[11.5px] leading-relaxed text-slate-400">
              I am your fire analyst, wired directly into the map. I can see your AOI, the live FIRMS/GIBS hotspot counts, the DBSCAN fire-cluster segmentation with hull boundaries, persistent fire systems, the 26-year harmonized calendar, anomalies, the forecast and the regime classification.
              Every number I quote comes from that telemetry — ask me anything, generate a SITREP, or try a quick prompt below.
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={`max-w-[88%] rounded-xl px-3 py-2 text-[12px] leading-relaxed ${m.role === 'user' ? 'bg-[#38BDF8] text-slate-950' : 'border border-[#1E3A5F] bg-[#0A1423] text-slate-200'}`}>
                {m.role === 'assistant' ? (
                  <div className="prose-invert space-y-1 [&_li]:ml-3 [&_li]:list-disc [&_ol]:ml-3 [&_ol]:list-decimal [&_p]:my-1 [&_strong]:text-orange-300">
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                ) : m.content}
                {m.role === 'assistant' && m.model && (
                  <div className="mt-1.5 border-t border-[#13253D] pt-1 text-[9px] text-slate-500">{m.model}{m.fallback ? ' · deterministic rule engine' : ''}</div>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <span className="h-2 w-2 animate-ping rounded-full bg-orange-400" /> analyzing live telemetry…
            </div>
          )}
        </div>

        <div className="border-t border-[#13253D] px-4 py-3">
          <button onClick={() => send('Generate the situation report for this AOI now.', 'sitrep')} disabled={busy}
            className="mb-2 w-full rounded-lg border border-orange-500/60 bg-gradient-to-r from-orange-500/20 to-amber-500/10 px-3 py-2 text-[11.5px] font-bold text-orange-200 transition-colors hover:from-orange-500/30 disabled:opacity-40">
            🚨 GENERATE SITUATION REPORT (SITREP)
          </button>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {QUICK.map((q) => (
              <button key={q} onClick={() => send(q)} disabled={busy}
                className="rounded-full border border-[#1E3A5F] px-2.5 py-1 text-[10px] text-slate-400 transition-colors hover:border-[#38BDF8]/60 hover:text-[#7DD3FC] disabled:opacity-40">
                {q}
              </button>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about peaks, anomalies, trends, sensors…"
              className="flex-1 rounded-lg border border-[#1E3A5F] bg-[#0A1423] px-3 py-2 text-[12px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-[#38BDF8]"
            />
            <button type="submit" disabled={busy || !input.trim()}
              className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-400 px-4 py-2 text-[12px] font-bold text-slate-950 disabled:opacity-40">
              Analyze
            </button>
          </form>
        </div>
      </aside>
    </div>
  );
}
