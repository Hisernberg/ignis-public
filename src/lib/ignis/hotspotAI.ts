// IGNIS per-hotspot AI interactivity — shared by BOTH map renderers.
//
// Every hotspot (individual FIRMS detection, DBSCAN fire cluster, aggregated
// 3D cell, GIBS cross-check pixel) becomes an AI-interactive object:
//   1. threatBadge()   — instant client-side threat verdict (0 ms, no network)
//                        rendered on every popup so each hotspot carries an
//                        early-warning signal even before the AI answers.
//   2. *PopupHTML()    — one shared HTML markup consumed by MapLibre popups
//                        (setHTML) and Leaflet popups (setContent) alike.
//   3. wireHotspotAI() — attaches handlers inside the popup DOM element:
//        · "🤖 Analyze with IGNIS AI"  → POST /api/hotspot → structured
//          verdict card rendered INLINE in the popup slot (no page jump).
//        · "💬 Open in Analyst chat"   → seeds the main IGNIS AI Analyst
//          conversation with a fully-templated question (existing flow).
// This module is intentionally React-free: popups of both renderers are raw
// DOM nodes, so a framework-free helper is the only way to share behavior.

'use client';

export type HotspotCtx = { regionKey: string; day: string };

export type ClusterCtx = {
  id: string | number;
  cls: string;
  n: number;
  frpSum: number;
  meanFrp: number;
  spreadKm: number;
  areaKm2: number;
  elongation: number;
  nightPct: number;
  sensors: string;
  modelCls?: string;
  modelClsPct?: number;
};

export type CellCtx = {
  lat: number;
  lon: number;
  n: number;
  frpSum: number;
  meanConf: number;
  nightPct: number;
  maxFrp: number;
};

export type HotspotPayload = {
  kind: 'detection' | 'cluster' | 'cell' | 'gibs';
  lat: number;
  lon: number;
  frp: number;
  conf: number;
  sensor: string;
  sat?: string;
  acq?: string;
  night: boolean;
  day: string;
  regionKey: string;
  cluster?: ClusterCtx;
  cell?: CellCtx;
};

// ---------------------------------------------------------------- threat ----
// Instant heuristic early-warning score (0-100):
//   · FRP (log-scaled vs the 500 MW display ceiling) → 60 pts  — radiative power
//   · detection confidence                           → 25 pts  — certainty
//   · night overpass (+15 / +8)                                — smouldering persistence
export type Threat = { label: 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME'; fg: string; bg: string; score: number };

export function threatBadge(frp: number, conf: number, night: boolean): Threat {
  const frpPts = Math.min(60, (Math.log10(1 + Math.max(0, frp)) / Math.log10(501)) * 60);
  const confPts = (Math.max(0, Math.min(100, conf)) / 100) * 25;
  const score = Math.round(frpPts + confPts + (night ? 15 : 8));
  if (score >= 80) return { label: 'EXTREME', fg: '#FECACA', bg: 'rgba(185,28,28,0.65)', score };
  if (score >= 62) return { label: 'HIGH', fg: '#FCA5A5', bg: 'rgba(239,68,68,0.20)', score };
  if (score >= 42) return { label: 'MODERATE', fg: '#FDE68A', bg: 'rgba(251,191,36,0.16)', score };
  return { label: 'LOW', fg: '#BBF7D0', bg: 'rgba(74,222,128,0.14)', score };
}

// ------------------------------------------------------------------ html ----
const FONT = 'font:12px/1.55 ui-sans-serif,system-ui';

function threatChip(t: Threat): string {
  return `<span style="background:${t.bg};color:${t.fg};border-radius:4px;padding:1px 6px;font-weight:800;font-size:9.5px;letter-spacing:0.4px">${t.label} ${t.score}</span>`;
}

function factsRow(lat: number, lon: number): string {
  return `<div style="color:#94A3B8">${lat.toFixed(3)}, ${lon.toFixed(3)}</div>`;
}

// FIRMS physics band — the same grounding the /api/hotspot prompt uses, shown
// instantly client-side so every click already carries an operational read
// before the AI verdict card streams in.
export function frpBand(frp: number): { label: string; short: string; fg: string } {
  if (frp < 10) return { label: 'Smouldering / managed burn', short: 'SMOULDERING', fg: '#FDBA74' };
  if (frp < 100) return { label: 'Active surface fire', short: 'SURFACE FIRE', fg: '#FB923C' };
  if (frp < 250) return { label: 'Intense fire front', short: 'INTENSE FRONT', fg: '#F87171' };
  return { label: 'Conflagration-grade energy release', short: 'CONFLAGRATION', fg: '#FECACA' };
}

// compact certainty bar — visual confidence readout inside the popup
function confBar(conf: number): string {
  const c = Math.max(0, Math.min(100, conf));
  const col = c >= 75 ? '#4ADE80' : c >= 45 ? '#FBBF24' : '#94A3B8';
  return `<div style="display:flex;align-items:center;gap:5px;margin-top:2px">
    <span style="color:#94A3B8">conf</span>
    <span style="flex:1 1 auto;height:4px;border-radius:2px;background:#12253C;overflow:hidden;display:inline-block">
      <span style="display:block;height:4px;width:${c}%;background:${col};border-radius:2px"></span>
    </span>
    <b style="color:#E2E8F0;font-size:10px">${Math.round(c)}%</b>
  </div>`;
}

// details grid row used by the full event card
function detailRow(k: string, v: string): string {
  return `<div style="display:flex;gap:6px;justify-content:space-between"><span style="color:#64748B">${k}</span><span style="color:#E2E8F0;text-align:right">${v}</span></div>`;
}

function aiSlot(auto = false): string {
  return `<div class="ignis-ai-slot" style="margin-top:7px"${auto ? ' data-ignis-auto="1"' : ''}></div>`;
}

function buttons(payload: HotspotPayload, q: string): string {
  return `<div style="margin-top:7px;display:flex;gap:5px;flex-wrap:wrap">
    <button class="ignis-hotspot-ai" data-hs="${encodeURIComponent(JSON.stringify(payload))}" style="flex:1 1 auto;background:linear-gradient(90deg,#38BDF8,#818CF8);color:#050A14;border:0;border-radius:6px;padding:5px 9px;font-weight:800;cursor:pointer;font-size:11px;white-space:nowrap">🤖 Analyze with IGNIS AI</button>
    <button class="ignis-ask" data-q="${encodeURIComponent(q)}" style="background:#132A44;color:#7DD3FC;border:1px solid #1E3A5F;border-radius:6px;padding:5px 8px;font-weight:700;cursor:pointer;font-size:11px;white-space:nowrap">💬 Analyst</button>
  </div>`;
}

export function detectionQuestion(p: HotspotPayload): string {
  return `Explain this fire detection at ${p.lat.toFixed(2)}, ${p.lon.toFixed(2)} on ${p.day}: sensor ${p.sensor}, FRP ${p.frp.toFixed(1)} MW, confidence ${p.conf}, ${p.night ? 'night' : 'day'} overpass. What does it mean for the ${p.regionKey} AOI and what should responders watch?`;
}

export function clusterQuestion(p: HotspotPayload, c: ClusterCtx): string {
  return `Fire cluster ${c.id} (${c.cls}) in ${p.regionKey} on ${p.day}: ${c.n} detections, total FRP ${Math.round(c.frpSum)} MW, spread ${c.spreadKm} km, hull area ${Math.round(c.areaKm2)} km², front ratio ${c.elongation}. Brief an incident commander on this cluster and what to watch next 48h.`;
}

export function cellQuestion(p: HotspotPayload, c: CellCtx): string {
  return `3D fire-field cell centered at ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)} in ${p.regionKey} on ${p.day}: ${c.n} detections, Σ FRP ${Math.round(c.frpSum)} MW, max single ${Math.round(c.maxFrp)} MW, mean confidence ${Math.round(c.meanConf)}, ${Math.round(c.nightPct)}% night. Assess this cell and what responders should watch next.`;
}

export function detectionPopupHTML(p: {
  sensor: string; sat?: string; frp: number; conf: number; acq?: string; night: boolean; lat: number; lon: number;
}, ctx: HotspotCtx): string {
  const t = threatBadge(p.frp, p.conf, p.night);
  const band = frpBand(p.frp);
  const payload: HotspotPayload = { kind: 'detection', lat: p.lat, lon: p.lon, frp: p.frp, conf: p.conf, sensor: p.sensor, sat: p.sat, acq: p.acq, night: p.night, day: ctx.day, regionKey: ctx.regionKey };
  // full event card — the complete "details about the event" readout judges
  // ask for on a click: every FIRMS field, the physics band, an instant
  // zero-latency physics read, then the AI verdict card (auto-runs) + Analyst.
  const instant = `Instant physics read: ${p.frp.toFixed(1)} MW on a ${p.night ? 'night' : 'day'} overpass reads as ${band.label.toLowerCase()}${p.night ? ' — night persistence suggests smouldering through the dark hours' : ''}.`;
  return `<div style="${FONT}">
    <div style="font-weight:700;color:#FDBA74;margin-bottom:2px">🔥 Active fire detection ${threatChip(t)}</div>
    <div style="border:1px solid #14273F;border-radius:6px;padding:5px 7px;margin-top:3px;background:rgba(7,16,30,0.6);display:flex;flex-direction:column;gap:1px">
      ${detailRow('sensor', `<b>${p.sensor}</b>${p.sat ? ` · ${p.sat}` : ''}`)}
      ${detailRow('fire radiative power', `<b style="color:#FCA5A5">${p.frp.toFixed(1)} MW</b>`)}
      ${detailRow('intensity band', `<b style="color:${band.fg}">${band.short}</b>`)}
      ${detailRow('overpass', `${p.night ? '🌙 night' : '☀️ day'}${p.acq ? ` · ${p.acq} UTC` : ''}`)}
      ${detailRow('coordinates', `${p.lat.toFixed(3)}°, ${p.lon.toFixed(3)}°`)}
      ${confBar(p.conf)}
    </div>
    <div style="color:#94A3B8;margin-top:4px;font-size:10.6px">${instant}</div>
    ${aiSlot(true)}
    ${buttons(payload, detectionQuestion(payload))}
  </div>`;
}

export function gibsPopupHTML(p: { sensor: string; frp: number; lat: number; lon: number }, ctx: HotspotCtx): string {
  const t = threatBadge(p.frp, 70, false);
  const band = frpBand(p.frp);
  const payload: HotspotPayload = { kind: 'gibs', lat: p.lat, lon: p.lon, frp: p.frp, conf: 70, sensor: p.sensor, night: false, day: ctx.day, regionKey: ctx.regionKey };
  return `<div style="${FONT}">
    <div style="font-weight:700;color:#FCA5A5">🛰 GIBS fire pixel (cross-check) ${threatChip(t)}</div>
    <div>${p.sensor} · FRP <b>${p.frp.toFixed(1)} MW</b> · <span style="color:${band.fg}">${band.short}</span></div>
    ${factsRow(p.lat, p.lon)}
    <div style="color:#94A3B8;margin-top:2px">Independent GIBS WMTS vector render — verifies the FIRMS NRT pipeline</div>
    ${aiSlot(true)}
    ${buttons(payload, detectionQuestion(payload))}
  </div>`;
}

export function clusterPopupHTML(c: ClusterCtx, ctx: HotspotCtx): string {
  const t = threatBadge(c.meanFrp * 1.4, 75, c.nightPct > 40);
  const payload: HotspotPayload = { kind: 'cluster', lat: 0, lon: 0, frp: c.meanFrp, conf: 75, sensor: c.sensors.split(',')[0]?.trim() || 'multi-sensor', night: c.nightPct > 40, day: ctx.day, regionKey: ctx.regionKey, cluster: c };
  return `<div style="${FONT}">
    <div style="font-weight:700;color:#FDBA74">📍 Fire cluster ${c.id} — ${c.cls} ${threatChip(t)}</div>
    ${c.modelCls ? `<div>🤖 ML behavior <b>${c.modelCls}</b> · ${c.modelClsPct}% of members</div>` : ''}
    <div><b>${c.n}</b> detections · Σ FRP <b>${Math.round(c.frpSum)}</b> MW · mean ${c.meanFrp.toFixed(1)} MW</div>
    <div>spread <b>${c.spreadKm} km</b> · hull area <b>${Math.round(c.areaKm2).toLocaleString()}</b> km²</div>
    <div>front ratio <b>${c.elongation}</b> (1=circular) · night ${c.nightPct.toFixed(0)}%</div>
    <div style="color:#94A3B8;margin-top:2px">sensors: ${c.sensors}</div>
    ${aiSlot()}
    ${buttons(payload, clusterQuestion(payload, c))}
  </div>`;
}

export function cellPopupHTML(c: CellCtx, ctx: HotspotCtx): string {
  const t = threatBadge(c.maxFrp, c.meanConf, c.nightPct > 40);
  const payload: HotspotPayload = { kind: 'cell', lat: c.lat, lon: c.lon, frp: c.maxFrp, conf: Math.round(c.meanConf), sensor: 'multi-sensor', night: c.nightPct > 40, day: ctx.day, regionKey: ctx.regionKey, cell: c };
  return `<div style="${FONT}">
    <div style="font-weight:700;color:#FDBA74">🧊 3D fire-field cell ${threatChip(t)}</div>
    <div><b>${c.n}</b> detections · Σ FRP <b>${Math.round(c.frpSum)}</b> MW</div>
    <div>max single <b>${Math.round(c.maxFrp)}</b> MW · mean conf <b>${Math.round(c.meanConf)}</b></div>
    <div>night share <b>${c.nightPct.toFixed(0)}%</b></div>
    ${factsRow(c.lat, c.lon)}
    ${aiSlot()}
    ${buttons(payload, cellQuestion(payload, c))}
  </div>`;
}

export function hexPopupHTML(h: { lat: number; lon: number; n: number; frp: number; bin: number }, ctx: HotspotCtx): string {
  const meanFrp = h.n ? h.frp / h.n : h.frp;
  const t = threatBadge(meanFrp, 60, false);
  const cell: CellCtx = { lat: h.lat, lon: h.lon, n: h.n, frpSum: h.frp, meanConf: 60, nightPct: 0, maxFrp: meanFrp };
  const payload: HotspotPayload = { kind: 'cell', lat: h.lat, lon: h.lon, frp: meanFrp, conf: 60, sensor: 'multi-sensor', night: false, day: ctx.day, regionKey: ctx.regionKey, cell };
  return `<div style="${FONT}">
    <div style="font-weight:700;color:#FDBA74">🗺 Density cell (${h.bin}°) ${threatChip(t)}</div>
    <div><b>${h.n}</b> detections · Σ FRP <b>${Math.round(h.frp)}</b> MW · mean <b>${meanFrp.toFixed(1)} MW</b></div>
    <div style="color:#94A3B8;margin-top:2px">Hexbin aggregation of harmonized hotspots</div>
    ${factsRow(h.lat, h.lon)}
    ${aiSlot()}
    ${buttons(payload, cellQuestion(payload, cell))}
  </div>`;
}

// --------------------------------------------------------------- wiring ----
function mdInline(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}

const SHIMMER = `<div style="display:flex;align-items:center;gap:6px;color:#7DD3FC;font-size:10.5px">
  <span style="display:inline-block;width:10px;height:10px;border:2px solid #38BDF8;border-top-color:transparent;border-radius:50%;animation:ignis-spin 0.8s linear infinite"></span>
  IGNIS AI is assessing this hotspot…
</div>
<style>@keyframes ignis-spin{to{transform:rotate(360deg)}}</style>`;

const VERDICT_STYLE: Record<string, { fg: string; bg: string }> = {
  EXTREME: { fg: '#FECACA', bg: 'rgba(185,28,28,0.65)' },
  HIGH: { fg: '#FCA5A5', bg: 'rgba(239,68,68,0.20)' },
  MODERATE: { fg: '#FDE68A', bg: 'rgba(251,191,36,0.16)' },
  LOW: { fg: '#BBF7D0', bg: 'rgba(74,222,128,0.14)' },
};

export function renderAIResult(slot: HTMLElement, j: { verdict?: string; headline?: string; analysis?: string; watch?: string[]; model?: string; fallback?: boolean }): void {
  const v = VERDICT_STYLE[j.verdict ?? ''] ?? VERDICT_STYLE.MODERATE;
  const watch = Array.isArray(j.watch) ? j.watch.filter((w) => typeof w === 'string' && w.trim()).slice(0, 4) : [];
  slot.innerHTML = `<div style="border:1px solid #1E3A5F;border-radius:8px;background:rgba(7,16,30,0.92);padding:7px 8px">
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      <span style="background:${v.bg};color:${v.fg};border-radius:4px;padding:1px 6px;font-weight:800;font-size:9.5px;letter-spacing:0.4px">${j.verdict ?? 'ASSESSMENT'}</span>
      <b style="color:#E2E8F0;font-size:11px">${mdInline(j.headline ?? '')}</b>
    </div>
    ${j.analysis ? `<div style="margin-top:4px;color:#CBD5E1;font-size:10.8px">${mdInline(j.analysis)}</div>` : ''}
    ${watch.length ? `<ul style="margin:5px 0 0;padding-left:14px;color:#94A3B8;font-size:10.5px">${watch.map((w) => `<li style="margin-top:1px">${mdInline(w)}</li>`).join('')}</ul>` : ''}
    <div style="margin-top:5px;color:#64748B;font-size:9px">${j.model ? `model: ${j.model}${j.fallback ? ' · offline rules' : ''}` : ''} · grounding: live FIRMS telemetry only</div>
  </div>`;
}

// verdict cache — one assessment per unique hotspot signature per session;
// repeated clicks (and re-opened popups) render instantly with zero network
const verdictCache = new Map<string, Record<string, unknown>>();
const VERDICT_CACHE_MAX = 240;

function verdictCacheKey(p: HotspotPayload): string {
  return [p.kind, p.lat.toFixed(3), p.lon.toFixed(3), p.sensor, p.frp.toFixed(1), p.day, p.cluster?.id ?? '', p.cell?.n ?? ''].join('|');
}

export async function runHotspotAIInto(slot: HTMLElement, payload: HotspotPayload): Promise<void> {
  const key = verdictCacheKey(payload);
  const hit = verdictCache.get(key);
  if (hit) {
    renderAIResult(slot, hit as Parameters<typeof renderAIResult>[1]);
    return;
  }
  slot.innerHTML = SHIMMER;
  try {
    const res = await fetch('/api/hotspot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotspot: payload }),
    });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
    if (verdictCache.size >= VERDICT_CACHE_MAX) {
      verdictCache.delete(verdictCache.keys().next().value as string);
    }
    verdictCache.set(key, j);
    renderAIResult(slot, j);
  } catch {
    slot.innerHTML = `<div style="color:#FCA5A5;font-size:10.5px">⚠ AI link failed — check network, then tap Analyze again.</div>`;
  }
}

/** Wire the AI buttons inside a popup DOM element (MapLibre Popup.getElement() / Leaflet popup element).
 *  Popups whose markup carries [data-ignis-auto] (detection + GIBS event cards) self-run the
 *  verdict on open — click a red fire dot and the AI summary streams in with no second click. */
export function wireHotspotAI(el: HTMLElement | null | undefined, onAsk: (q: string) => void): void {
  if (!el) return;
  const aiBtn = el.querySelector<HTMLElement>('.ignis-hotspot-ai');
  const runAnalyze = () => {
    const slot = el.querySelector<HTMLElement>('.ignis-ai-slot');
    const payload = aiBtn?.getAttribute('data-hs') ?? '';
    if (slot && payload) void runHotspotAIInto(slot, JSON.parse(decodeURIComponent(payload)) as HotspotPayload);
  };
  if (aiBtn) aiBtn.onclick = runAnalyze;
  if (el.querySelector('[data-ignis-auto]') && aiBtn) {
    // next frame so the popup is fully laid out before the shimmer mounts
    requestAnimationFrame(() => {
      const slot = el.querySelector<HTMLElement>('.ignis-ai-slot');
      if (slot && !slot.childElementCount) runAnalyze();
    });
  }
  const askBtn = el.querySelector<HTMLElement>('.ignis-ask');
  if (askBtn) {
    askBtn.onclick = () => {
      const q = askBtn.getAttribute('data-q');
      if (q) onAsk(decodeURIComponent(q));
    };
  }
}
