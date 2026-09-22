import { NextResponse } from 'next/server';
import { KEYS } from '@/lib/ignis/keys';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type AnalystContext = Record<string, unknown>;

const SYSTEM_PROMPT = `You are IGNIS Analyst, the built-in AI of IGNIS — a NASA Space Apps Challenge 2026 application that harmonizes NASA's split satellite fire record (MODIS Terra/Aqua since 2000, VIIRS S-NPP/NOAA-20/NOAA-21 since 2012) into one 26-year Burning Activity Calendar for early warning.

You receive LIVE telemetry JSON about the user's current Area of Interest (AOI): per-sensor detections, FRP (fire radiative power in MW), a 26-year harmonized monthly series summary, climatology, anomaly z-scores, a seasonal forecast, a burn-regime classification, and optionally 7-day fire weather.

RULES:
1. Ground EVERY number in the JSON provided. NEVER invent statistics. If data is missing say what is missing.
2. Be concise and operational: max 130 words, use markdown short bullets when helpful.
3. Explain like a fire analyst briefing an incident commander: what is happening, why it matters, what to watch.
4. Reference NASA instruments by name when relevant (MODIS 1km on Terra/Aqua, VIIRS 375m on S-NPP/NOAA-20/NOAA-21, GIBS imagery, FIRMS).
5. ZERO-HALLUCINATION GUARD: if totalDetections is 0, perSensor is empty, or a field is missing/null, say the data is still loading or unavailable for that AOI — NEVER invent place names, cluster IDs, systems, events or numbers not present in the JSON.
6. If the user asks to navigate (switch region, go to a date, show a layer), START your reply with exactly one line:
NAVIGATE: {"region":"<regionKey>","date":"<YYYY-MM-DD>"} using only these region keys: amazon, california, canada, siberia, congo, borneo, australia, mediterranean, bangladesh. Omit fields you are not changing. If no navigation is needed, omit the line. Then give your analysis.`;

const MODELS = ['meta-llama/Llama-3.1-8B-Instruct', 'Qwen/Qwen3-8B'];

const SITREP_PROMPT = `You are IGNIS SITREP, the incident-briefing mode of IGNIS Analyst (NASA Space Apps 2026, Challenge #9: Harmonization of MODIS & VIIRS Hot Spots).

You receive LIVE telemetry JSON: per-sensor detections + FRP, DBSCAN fire-cluster segmentation with convex-hull boundary metrics (class, count, FRP, spread km, front ratio), persistent fire systems tracked across the replay window, 26-year climatology/anomaly z-scores, forecast, burn-regime, and 7-day fire weather.

Write a TIGHT operational situation report in EXACTLY this markdown structure:
**SITUATION** — one paragraph: what is burning, where (reference top clusters by ID), how intense (total FRP, biggest cluster).
**KEY SYSTEMS** — 2-3 bullets on the most significant clusters / persistent systems (ID, class, FRP, trend, front ratio if elongated >1.6).
**ASSESSMENT** — sensor harmonization insight (MODIS vs VIIRS split), whether today is anomalous vs climatology (z), trajectory (growing/decaying systems).
**NEXT 48H** — 2-3 bullets: what responders should watch, tie in fire-weather verdict if present.

RULES: ground every number in the JSON. If totalDetections is 0 or segmentation is null, state plainly that no detections are loaded yet (data loading) and skip the numeric bullets — NEVER invent cluster IDs, fire names, places or numbers. Max 170 words. No preamble, start directly with **SITUATION**.`;

function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function callHF(model: string, question: string, contextJson: string, system?: string, maxTokens = 520): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 28000);
  try {
    const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${KEYS.HF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system || SYSTEM_PROMPT },
          { role: 'user', content: `LIVE CONTEXT JSON:\n${contextJson}\n\nUSER QUESTION: ${question}` },
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const content: string | null = j.choices?.[0]?.message?.content ?? null;
    if (!content) throw new Error('empty completion');
    return stripThinking(content);
  } finally {
    clearTimeout(t);
  }
}

function templateAnswer(q: string, ctx: AnalystContext): string {
  const c = ctx as Record<string, unknown>;
  const total = (c.totalDetections as number) ?? 0;
  const region = (c.regionName as string) ?? 'the AOI';
  const day = (c.day as string) ?? '';
  const ql = q.toLowerCase();
  if (/peak|season|when|critical/.test(ql)) {
    return `**Peak window:** ${(c.peakMonths as string) || 'climatology pending'}.\n\nThe 26-year record for ${region} shows a strong seasonal cycle; activity typically ramps up weeks before the peak. Current fire weather and the live detection counts above should be watched as the window approaches.`;
  }
  if (/anomal|unusual|strange|record/.test(ql)) {
    return `**Unusual conditions check:** latest harmonized month anomaly z = ${(c.latestZ as number) ?? 'n/a'} (|z| > 2 is unusual). Compare the live detection total (${total}) against the same-month climatology to judge whether today is abnormal for ${region}.`;
  }
  if (/sensor|difference|modis|viirs|compare/.test(ql)) {
    return `**Sensor harmonization:** MODIS (1 km, Terra + Aqua) sees fewer, larger fires; VIIRS (375 m, S-NPP/NOAA-20/NOAA-21) resolves fires ~450x smaller in area, so raw VIIRS counts run higher. IGNIS fuses them with an overlap-derived continuity coefficient, producing one comparable 26-year record for ${region}.`;
  }
  if (/regime|type|classif/.test(ql)) {
    return `**Burn regime:** ${(c.regime as string) || 'classification pending'}. The classifier compares your AOI's seasonality, interannual variability, FRP and night-fraction against 8 NASA-derived reference regions.`;
  }
  if (/forecast|outlook|next/.test(ql)) {
    return `**Seasonal outlook:** ${(c.forecastNote as string) || 'harmonic-regression forecast pending'}. Combine with the 7-day fire-weather panel for operational early warning.`;
  }
  return `**Current snapshot — ${region}, ${day}:** ${total} active-fire detections in the AOI across MODIS Terra/Aqua (1 km) and VIIRS S-NPP/NOAA-20/NOAA-21 (375 m). Ask me about peaks, anomalies, trends, the forecast, or the burn regime — every number I cite comes from the live NASA FIRMS/GIBS pipeline.`;
}

function parseNavigate(answer: string): { region?: string; date?: string } | null {
  const m = answer.match(/NAVIGATE:\s*(\{[^\}]+\})/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]) as { region?: string; date?: string };
    return o;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let body: { question?: string; context?: AnalystContext; mode?: 'chat' | 'sitrep' };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const mode = body.mode === 'sitrep' ? 'sitrep' : 'chat';
  const question = (body.question || (mode === 'sitrep' ? 'Generate the situation report for this AOI now.' : '')).slice(0, 600);
  const context = body.context || {};
  if (!question) return NextResponse.json({ error: 'question required' }, { status: 400 });
  const contextJson = JSON.stringify(context).slice(0, 9000);
  const system = mode === 'sitrep' ? SITREP_PROMPT : undefined;
  const maxTokens = mode === 'sitrep' ? 700 : 520;

  for (const model of MODELS) {
    try {
      const answer = await callHF(model, question, contextJson, system, maxTokens);
      const clean = stripThinking(answer);
      if (clean.length > 0) {
        return NextResponse.json({ answer: clean.replace(/NAVIGATE:\s*\{[^\}]*\}/g, '').trim(), actions: parseNavigate(answer), model, mode });
      }
    } catch {
      continue;
    }
  }
  return NextResponse.json({
    answer: mode === 'sitrep' ? templateSitrep(context) : templateAnswer(question, context),
    model: 'ignis-rule-engine (offline fallback)', fallback: true, mode,
  });
}

// Deterministic SITREP builder — same structure the LLM is told to produce.
function templateSitrep(ctx: AnalystContext): string {
  const c = ctx as Record<string, unknown>;
  const region = (c.regionName as string) ?? 'the AOI';
  const day = (c.day as string) ?? '';
  const total = (c.totalDetections as number) ?? 0;
  const frp = (c.totalFrpMW as number) ?? 0;
  const seg = c.segmentation as Record<string, unknown> | null;
  const perSensor = (c.perSensor ?? {}) as Record<string, { count: number; meanFrp: number; hiConfPct: number }>;
  const modis = (perSensor['MODIS-Terra']?.count || 0) + (perSensor['MODIS-Aqua']?.count || 0);
  const viirs = (perSensor['VIIRS-SNPP']?.count || 0) + (perSensor['VIIRS-NOAA20']?.count || 0) + (perSensor['VIIRS-NOAA21']?.count || 0);
  const fw = c.fireWeather as { verdict?: string; peakDay?: string } | null;
  const z = c.latestZ as number | null | undefined;
  const top = (seg?.topClusters ?? []) as Array<Record<string, unknown>>;
  const persistent = (seg?.persistentSystems ?? []) as Array<Record<string, unknown>>;
  const topLine = top.length
    ? top.slice(0, 2).map((t) => `${t.id} (${t.cls}, ${t.n} det, ${t.frpSum} MW, ${t.spreadKm} km)`).join('; ')
    : 'no organized clusters — activity scattered';
  const trend = persistent.length
    ? persistent.slice(0, 2).map((p) => `${p.id}: ${p.days}d ${p.trend}`).join('; ')
    : 'no multi-day persistence in the loaded window';
  return `**SITUATION** — ${region}, ${day}: ${total} active-fire detections, Σ ${frp.toLocaleString()} MW across MODIS Terra/Aqua (1 km) + VIIRS S-NPP/NOAA-20/21 (375 m). Segmentation identifies ${seg?.clusters ?? 0} clusters (${seg?.clusteredPct ?? 0}% of detections inside boundaries); top: ${topLine}.

**KEY SYSTEMS**
- ${topLine}
- Persistence: ${trend}

**ASSESSMENT**
- Sensor split MODIS ${modis} vs VIIRS ${viirs} — ratio ${modis ? (viirs / modis).toFixed(1) : '—'}:1, the live harmonization gap (VIIRS resolves ~450× smaller fires).
- Latest month anomaly vs 26-yr climatology: z = ${z ?? 'n/a'} ${typeof z === 'number' ? (Math.abs(z) >= 2 ? '(UNUSUAL — |z|≥2)' : '(within normal range)') : ''}.
- Burn regime: ${typeof c.regime === 'object' && c.regime ? JSON.stringify(c.regime).slice(0, 80) : 'pending'}.

**NEXT 48H**
- Fire weather: ${fw?.verdict ?? 'unavailable'} (peak ${fw?.peakDay ?? 'n/a'}).
- Watch persistent systems for growth; re-check after next Terra/Aqua + S-NPP overpasses.
- Trigger: any cluster crossing 150 detections or ΣFRP 5,000 MW → escalate to MEGAFIRE monitoring.`;
}
