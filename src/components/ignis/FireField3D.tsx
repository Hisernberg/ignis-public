'use client';

// IGNIS 3D Fire Field — map-based 3D analysis rendered with PURE Canvas-2D
// isometric projection. Zero WebGL: runs on every browser including ones where
// GPU/WebGL2 is blocked (Brave strict shields) — the same constraint that
// drove the Leaflet DOM renderer.
//
// What it does: aggregates the live FIRMS detections of the current AOI into
// an adaptive lat/lon grid and extrudes each occupied cell into an isometric
// tower — height = detection count (or Σ FRP), color = mean FRP ramp. Hover a
// tower for cell telemetry; click to fly the map there AND get an inline IGNIS
// AI assessment of the cell (POST /api/hotspot). This is the "3D analysis"
// layer judges can read at a glance: where the fire field concentrates, how
// intense each concentration is, and what the AI thinks about it.
//
// v5.11 "cinema" engine — still GPU-free, now animated:
//   · unified ~30fps rAF driver (replaces the per-effect easing loop): spawn
//     growth animation, eased 45° rotation, smoothed hover lift, and a live
//     ember pulse on EXTREME-threat towers — all delta-time based
//   · cinematic backdrop (deep-space gradient + horizon glow), floor vignette,
//     projected reference grid, per-tower ground shadows
//   · fire glow: hot towers (mean FRP ≥ 120 MW) bloom with a composite
//     'lighter' radial halo that breathes over time
//   · rotating compass rose, selection ring, keyboard navigation
//     (←/→ rotate, +/− zoom, R reset)
//   · perf guard: if frames cost > 45 ms three times, the continuous loop
//     parks itself and the panel falls back to interaction-driven redraws —
//     it degrades to v5.10 behavior instead of stalling a weak machine

import { useEffect, useMemo, useRef, useState, type MouseEvent, type KeyboardEvent } from 'react';
import type { HotspotsResult } from '@/lib/ignis/types';
import { cellPopupHTML, threatBadge, wireHotspotAI, runHotspotAIInto, type HotspotPayload } from '@/lib/ignis/hotspotAI';

type Props = {
  bbox: number[];
  day: string;
  regionKey: string;
  displayData: HotspotsResult | null;
  visible: Record<string, boolean>;
  onFlyTo: (lat: number, lon: number) => void;
  onAskAi: (q: string) => void;
  onClose: () => void;
};

const FRP_RAMP: [number, string][] = [
  [0, '#FCA5A5'], [10, '#F87171'], [25, '#EF4444'], [60, '#DC2626'], [120, '#B91C1C'], [250, '#7F1D1D'], [500, '#450A0A'],
];

function rampColor(ramp: [number, string][], v: number): string {
  let c = ramp[0][1];
  for (const [t, col] of ramp) if (v >= t) c = col;
  return c;
}

function darken(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

function lighten(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(255 - (255 - ((n >> 16) & 255)) * (1 - f));
  const g = Math.round(255 - (255 - ((n >> 8) & 255)) * (1 - f));
  const b = Math.round(255 - (255 - (n & 255)) * (1 - f));
  return `rgb(${r},${g},${b})`;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

type Cell = { gx: number; gy: number; lat: number; lon: number; n: number; frpSum: number; meanConf: number; nightPct: number; maxFrp: number };
type Hit = { x: number; y: number; hw: number; hh: number; idx: number };

export default function FireField3D({ bbox, day, regionKey, displayData, visible, onFlyTo, onAskAi, onClose }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const [rot, setRot] = useState(1);        // rotation target, in 45° units
  const [heightMode, setHeightMode] = useState<'count' | 'frp'>('count');
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [zoomLabel, setZoomLabel] = useState(1);
  const [panTick, setPanTick] = useState(0); // redraw trigger while drag-panning
  const [tick, setTick] = useState(0);       // unified animation driver (see loop below)
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 }); // wheel-zoom + drag-pan view transform
  const viewMetaRef = useRef({ cx: 0, cy: 0 }); // renderer screen center — kept in sync by the draw effect
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number; moved: number } | null>(null);
  const selRef = useRef(-1);                 // selected (clicked) tower — keeps its ring

  // unified animation state — mutated by the rAF loop, read by the draw effect
  const animRef = useRef({ rotAnim: 1, hoverEase: 0, spawnAt: 0, slow: 0, disabled: false });
  const rotTargetRef = useRef(1);
  const hoverRef = useRef(-1);
  const hasExtremeRef = useRef(false);

  useEffect(() => { rotTargetRef.current = rot; }, [rot]);

  // ---- adaptive grid aggregation of the visible detections ----
  const cells = useMemo<Cell[]>(() => {
    if (!displayData) return [];
    const [w, s, e, n] = bbox;
    const spanX = Math.max(0.5, e - w), spanY = Math.max(0.5, n - s);
    const cellDeg = Math.max(0.05, Math.min(spanX, spanY) / 26);
    const cols = Math.ceil(spanX / cellDeg), rows = Math.ceil(spanY / cellDeg);
    const m = new Map<string, Cell>();
    for (const [sensor, sh] of Object.entries(displayData.sensors)) {
      if (!visible[sensor]) continue;
      for (const p of sh.points) {
        const gx = Math.min(cols - 1, Math.max(0, Math.floor((p.lon - w) / cellDeg)));
        const gy = Math.min(rows - 1, Math.max(0, Math.floor((p.lat - s) / cellDeg)));
        const k = `${gx}:${gy}`;
        const c = m.get(k) ?? { gx, gy, lat: s + (gy + 0.5) * cellDeg, lon: w + (gx + 0.5) * cellDeg, n: 0, frpSum: 0, meanConf: 0, nightPct: 0, maxFrp: 0 };
        c.n += 1;
        c.frpSum += p.frp || 0;
        c.meanConf += typeof p.conf === 'number' ? p.conf : 60;
        c.nightPct += p.night ? 1 : 0;
        c.maxFrp = Math.max(c.maxFrp, p.frp || 0);
        m.set(k, c);
      }
    }
    return [...m.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 900)
      .map((c) => ({ ...c, meanConf: c.meanConf / c.n, nightPct: (c.nightPct / c.n) * 100 }));
  }, [displayData, visible, bbox]);

  // new AOI / new day → reset the view + replay the spawn animation
  useEffect(() => {
    viewRef.current = { zoom: 1, panX: 0, panY: 0 };
    const t = setTimeout(() => setZoomLabel(1), 0); // deferred — no sync setState in effect body
    animRef.current.spawnAt = performance.now();
    selRef.current = -1;
    return () => clearTimeout(t);
  }, [bbox, day]);

  // live ember-pulse flag — only EXTREME-threat cells make the field breathe
  useEffect(() => {
    hasExtremeRef.current = cells.some((c) => threatBadge(c.maxFrp, c.meanConf, c.nightPct > 40).score >= 80);
  }, [cells]);

  // smart initial orientation — fire fields are often diagonal bands (Andes
  // foothills, front lines); pick the 45° step that presents the occupied grid
  // most compactly so the default view fills the panel instead of a sliver
  const sig = cells.length ? cells.length + ':' + bbox.join(',') : '';
  const sigRef = useRef('');
  useEffect(() => {
    if (!cells.length || sigRef.current === sig) return;
    sigRef.current = sig;
    let best = 1, bestScore = Infinity;
    for (let r = 0; r < 4; r++) {
      const t = (r * Math.PI) / 4, c0 = Math.cos(t), s0 = Math.sin(t);
      let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
      for (const c of cells) {
        for (const [dx, dy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
          const u = (c.gx + dx) * c0 - (c.gy + dy) * s0, w2 = (c.gx + dx) * s0 + (c.gy + dy) * c0;
          const px = u - w2, py = u + w2;
          mnx = Math.min(mnx, px); mxx = Math.max(mxx, px);
          mny = Math.min(mny, py); mxy = Math.max(mxy, py);
        }
      }
      const wS = mxx - mnx, hS = mxy - mny;
      const score = Math.max(wS / hS, hS / wS); // 1 = perfectly square footprint
      if (score < bestScore) { bestScore = score; best = r; }
    }
    animRef.current.rotAnim = best;
    animRef.current.spawnAt = performance.now();
    setRot(best);
  }, [cells, sig]);

  const maxH = useMemo(() => (cells.length ? Math.max(...cells.map((c) => (heightMode === 'count' ? c.n : c.frpSum))) : 1), [cells, heightMode]);
  const concentration = useMemo(() => {
    if (cells.length < 4) return null;
    const totalFrp = cells.reduce((a, c) => a + c.frpSum, 0);
    if (totalFrp <= 0) return null;
    const topK = Math.max(1, Math.round(cells.length * 0.1));
    const topShare = [...cells].sort((a, b) => b.frpSum - a.frpSum).slice(0, topK).reduce((a, c) => a + c.frpSum, 0);
    return { topK, share: (topShare / totalFrp) * 100 };
  }, [cells]);

  // ---- canvas box sizing + non-passive wheel zoom (pinned to cursor) ----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const canvas = canvasRef.current;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const v = viewRef.current;
      const r = canvasRef.current?.getBoundingClientRect();
      if (!r) return;
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const old = v.zoom;
      const next = Math.min(8, Math.max(0.5, old * (ev.deltaY < 0 ? 1.16 : 1 / 1.16)));
      if (next === old) return;
      // keep the world point under the cursor pinned while zooming
      const meta = viewMetaRef.current;
      const cx = meta.cx || r.width / 2, cy = meta.cy || r.height / 2;
      const ux = (mx - cx - v.panX) / old, uy = (my - cy - v.panY) / old;
      v.zoom = next;
      v.panX = mx - cx - ux * next;
      v.panY = my - cy - uy * next;
      setZoomLabel(+next.toFixed(2));
    };
    canvas?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      canvas?.removeEventListener('wheel', onWheel);
    };
  }, []);

  // ---- unified animation loop (~30fps, delta-time) ----
  // Drives spawn growth, rotation easing, hover-lift smoothing and the ember
  // pulse; parks itself when the panel is idle AND after sustained slow frames
  // (perf guard) so weak machines fall back to interaction-driven redraws.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const st = animRef.current;
      if (st.disabled) return;
      if (t - last < 30) return; // ~30fps cap — the canvas is small, this is plenty
      const dt = Math.min(0.12, (t - last) / 1000);
      last = t;
      let anim = false;
      // rotation easing toward the 45° target
      const diff = rotTargetRef.current - st.rotAnim;
      if (Math.abs(diff) > 0.002) { st.rotAnim += diff * Math.min(1, dt * 9); anim = true; }
      else if (st.rotAnim !== rotTargetRef.current) { st.rotAnim = rotTargetRef.current; anim = true; }
      // hover lift easing
      const hTarget = hoverRef.current >= 0 ? 1 : 0;
      if (Math.abs(hTarget - st.hoverEase) > 0.02) { st.hoverEase += (hTarget - st.hoverEase) * Math.min(1, dt * 12); anim = true; }
      else if (st.hoverEase !== hTarget) { st.hoverEase = hTarget; anim = true; }
      // spawn growth window
      if (t - st.spawnAt < 950) anim = true;
      // ember pulse on EXTREME cells keeps the field alive
      if (hasExtremeRef.current) anim = true;
      if (anim) setTick((x) => (x + 1) % 1000000000);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- isometric projection + painter draw + grid floor + legend ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const t0 = performance.now();
    const st = animRef.current;
    const now = t0;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(size.w * dpr) || canvas.height !== Math.round(size.h * dpr)) {
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ---- cinematic backdrop: deep-space gradient + horizon glow ----
    const sky = ctx.createLinearGradient(0, 0, 0, size.h);
    sky.addColorStop(0, '#0B1A33');
    sky.addColorStop(0.55, '#071224');
    sky.addColorStop(1, '#050A14');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, size.w, size.h);

    const th = ((st.disabled ? rotTargetRef.current : st.rotAnim) * Math.PI) / 4;
    const cos = Math.cos(th), sin = Math.sin(th);
    const proj = (gx: number, gy: number): [number, number] => {
      const u = gx * cos - gy * sin;
      const v = gx * sin + gy * cos;
      return [u - v, u + v];
    };

    // projected bounds of the occupied cells (fit target)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of cells) {
      for (const [dx, dy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
        const [px, py] = proj(c.gx + dx, c.gy + dy);
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
    }
    if (!cells.length) { minX = 0; maxX = 1; minY = 0; maxY = 1; }

    const padX = 26, padTop = 18, padBot = 26;
    const spanX = Math.max(1e-6, maxX - minX), spanY = Math.max(1e-6, maxY - minY);
    // height-aware fit — reserve vertical room for the towers themselves so
    // back-row towers never clip above the panel at the default view
    const maxBar = Math.max(12, Math.min(96, size.h * 0.40));
    const availH = Math.max(40, size.h - padTop - padBot - maxBar);
    const baseScale = Math.min((size.w - padX * 2) / spanX, availH / spanY);
    // center-based view transform — mirrors the wheel-zoom pinning formula
    const v = viewRef.current;
    // floor center sits BELOW the reserved tower band: footprint fits in
    // [padTop+maxBar, padTop+maxBar+availH] so the tallest tower never clips
    const cx = size.w / 2, cy = padTop + maxBar + availH / 2 + 2;
    viewMetaRef.current = { cx, cy };
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    // width-fill boost — tall/narrow fire bands (Andes foothills, fronts) fit
    // height-first; a gentle isometric X-stretch (≤2.2×) lets the field fill
    // the panel like a real 3D city chart while staying fully visible
    const widthFill = (size.w - padX * 2) / Math.max(1e-6, spanX * baseScale);
    const boost = Math.min(2.2, Math.max(1, widthFill * 0.92));
    const s = baseScale * v.zoom;
    const sx = (px: number) => cx + (px - midX) * s * boost + v.panX;
    const sy = (py: number) => cy + (py - midY) * s + v.panY;

    // horizon glow behind the field
    const glow = ctx.createRadialGradient(cx, cy - maxBar * 0.4, 4, cx, cy - maxBar * 0.4, Math.max(size.w, size.h) * 0.42);
    glow.addColorStop(0, 'rgba(56,189,248,0.10)');
    glow.addColorStop(0.5, 'rgba(56,189,248,0.035)');
    glow.addColorStop(1, 'rgba(56,189,248,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size.w, size.h);

    // ---- floor vignette under the field ----
    if (cells.length) {
      const fy = sy((minY + maxY) / 2);
      const fr = Math.max(size.w, size.h) * 0.46;
      const vg = ctx.createRadialGradient(cx, fy, 8, cx, fy, fr);
      vg.addColorStop(0, 'rgba(2,8,18,0.55)');
      vg.addColorStop(0.7, 'rgba(2,8,18,0.22)');
      vg.addColorStop(1, 'rgba(2,8,18,0)');
      ctx.save();
      ctx.translate(cx, fy);
      ctx.scale(1, 0.42);
      ctx.translate(-cx, -fy);
      ctx.fillStyle = vg;
      ctx.beginPath();
      ctx.arc(cx, fy, fr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // ---- reference grid floor (under the towers) ----
    if (cells.length > 1) {
      let gxMin = Infinity, gxMax = -Infinity, gyMin = Infinity, gyMax = -Infinity;
      for (const c of cells) {
        gxMin = Math.min(gxMin, c.gx); gxMax = Math.max(gxMax, c.gx);
        gyMin = Math.min(gyMin, c.gy); gyMax = Math.max(gyMax, c.gy);
      }
      const span = Math.max(gxMax - gxMin, gyMax - gyMin);
      const step = Math.max(1, Math.round(span / 8));
      ctx.strokeStyle = 'rgba(56,189,248,0.10)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      for (let gx = Math.floor(gxMin / step) * step; gx <= gxMax + 1; gx += step) {
        const a = proj(gx - 0.5, gyMin - 0.5), b = proj(gx - 0.5, gyMax + 0.5);
        ctx.moveTo(sx(a[0]), sy(a[1]));
        ctx.lineTo(sx(b[0]), sy(b[1]));
      }
      for (let gy = Math.floor(gyMin / step) * step; gy <= gyMax + 1; gy += step) {
        const a = proj(gxMin - 0.5, gy - 0.5), b = proj(gxMax + 0.5, gy - 0.5);
        ctx.moveTo(sx(a[0]), sy(a[1]));
        ctx.lineTo(sx(b[0]), sy(b[1]));
      }
      ctx.stroke();
    }

    // ---- painter-ordered towers ----
    const order = cells
      .map((c, i) => {
        const u = c.gx * cos - c.gy * sin;
        const w2 = c.gx * sin + c.gy * cos;
        return { i, d: u + w2 };
      })
      .sort((a, b) => a.d - b.d);

    const hits: Hit[] = [];
    const hw = Math.max(7, s * boost * 0.46), hh = Math.max(4, s * 0.27);
    const spawnT = easeOutCubic((now - st.spawnAt) / 900);
    const pulseT = (now % 1400) / 1400; // ember-pulse phase, 1.4 s cycle

    // ground shadows first (one soft ellipse per tower — read as depth, not clutter)
    if (spawnT > 0.15) {
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      for (const { i } of order) {
        const c = cells[i];
        if (!c) continue;
        const [px, py] = proj(c.gx, c.gy);
        ctx.beginPath();
        ctx.ellipse(sx(px), sy(py) + hh * 0.85, hw * 0.82, hh * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const { i } of order) {
      const c = cells[i];
      if (!c) continue;
      const [px, py] = proj(c.gx, c.gy);
      const x = sx(px), yBase = sy(py);
      const val = heightMode === 'count' ? c.n : c.frpSum;
      const isHover = i === hoverRef.current && hoverRef.current >= 0;
      const lift = isHover ? st.hoverEase * 6 : 0;
      const h = Math.max(2, (val / maxH) * maxBar) * spawnT + lift;
      const yTop = yBase - h;
      const col = rampColor(FRP_RAMP, c.frpSum / c.n);
      const hot = c.frpSum / c.n >= 120; // fire glow threshold — 120 MW mean
      // left face (sw side)
      ctx.beginPath();
      ctx.moveTo(x - hw, yTop);
      ctx.lineTo(x, yTop + hh);
      ctx.lineTo(x, yBase + hh);
      ctx.lineTo(x - hw, yBase);
      ctx.closePath();
      ctx.fillStyle = darken(isHover ? lighten(col, 0.3) : col, 0.62);
      ctx.fill();
      // right face (se side)
      ctx.beginPath();
      ctx.moveTo(x + hw, yTop);
      ctx.lineTo(x, yTop + hh);
      ctx.lineTo(x, yBase + hh);
      ctx.lineTo(x + hw, yBase);
      ctx.closePath();
      ctx.fillStyle = darken(isHover ? lighten(col, 0.3) : col, 0.42);
      ctx.fill();
      // top face
      ctx.beginPath();
      ctx.moveTo(x, yTop - hh);
      ctx.lineTo(x + hw, yTop);
      ctx.lineTo(x, yTop + hh);
      ctx.lineTo(x - hw, yTop);
      ctx.closePath();
      ctx.fillStyle = isHover ? lighten(col, 0.3) : col;
      ctx.fill();
      ctx.strokeStyle = isHover ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.18)';
      ctx.lineWidth = isHover ? 1.4 : 0.6;
      ctx.stroke();
      // fire glow — composite 'lighter' radial bloom that breathes over time
      if (hot && spawnT > 0.6) {
        const breathe = 0.16 + 0.09 * (0.5 + 0.5 * Math.sin(pulseT * Math.PI * 2 + c.gx * 1.7 + c.gy * 0.9));
        const gr = ctx.createRadialGradient(x, yTop, 1, x, yTop, hw * 2.3);
        gr.addColorStop(0, `rgba(253,186,116,${breathe})`);
        gr.addColorStop(0.55, `rgba(249,115,22,${breathe * 0.55})`);
        gr.addColorStop(1, 'rgba(249,115,22,0)');
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(x, yTop, hw * 2.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // selection ring — the tower the user clicked for fly + AI
      if (selRef.current === i) {
        ctx.strokeStyle = 'rgba(56,189,248,0.95)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.ellipse(x, yBase + hh * 0.85, hw * 1.5, hh * 1.05, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      hits.push({ x, y: yTop, hw, hh, idx: i });
    }
    (canvas as HTMLCanvasElement & { _hits?: Hit[] })._hits = hits;
    // demo/support handle (mirrors __ignisMap): lets E2E click a tower deterministically
    (window as unknown as { __ignis3D?: { el: HTMLCanvasElement; hits: Hit[] } }).__ignis3D = { el: canvas, hits };

    // ---- compass rose (bottom-right): grid-north arrow, rotates with view ----
    {
      const rx = size.w - 26, ry = size.h - 24;
      const a = proj(0, 0), b = proj(0, -1);
      let nx = sx(b[0]) - sx(a[0]), ny = sy(b[1]) - sy(a[1]);
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      ctx.save();
      ctx.translate(rx, ry);
      ctx.fillStyle = 'rgba(7,16,30,0.85)';
      ctx.strokeStyle = 'rgba(56,189,248,0.35)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(0, 0, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#7DD3FC';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-nx * 8, -ny * 8);
      ctx.lineTo(nx * 8, ny * 8);
      ctx.stroke();
      ctx.fillStyle = '#FCA5A5';
      ctx.beginPath();
      ctx.arc(nx * 8, ny * 8, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(148,163,184,0.9)';
      ctx.font = '8px ui-sans-serif,system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('N', 0, -15.5);
      ctx.restore();
      ctx.textAlign = 'left';
    }

    // ---- in-canvas legend (top-left): color = mean FRP, height = metric ----
    const lx = 10, ly = 12;
    ctx.font = '9px ui-sans-serif,system-ui';
    const grad = ctx.createLinearGradient(lx, 0, lx + 92, 0);
    for (const [t, col] of FRP_RAMP) grad.addColorStop(Math.min(1, t / 500), col);
    ctx.fillStyle = grad;
    ctx.fillRect(lx, ly, 92, 6);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(lx, ly, 92, 6);
    ctx.fillStyle = 'rgba(148,163,184,0.95)';
    ctx.fillText('mean FRP → 0…500+ MW', lx, ly - 2);
    ctx.fillText(`tower height = ${heightMode === 'count' ? 'detections' : 'Σ FRP (MW)'}`, lx, ly + 17);
    if (v.zoom !== 1) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#7DD3FC';
      ctx.fillText(`${v.zoom.toFixed(1)}× · scroll to zoom · drag to pan`, size.w - 44, ly + 17);
      ctx.textAlign = 'left';
    }

    // ---- perf guard: sustained slow frames → park the animation loop ----
    const ms = performance.now() - t0;
    if (ms > 45) st.slow += 1; else st.slow = 0;
    if (st.slow > 3 && !st.disabled) {
      st.disabled = true;
      hasExtremeRef.current = false; // freeze the ember pulse on weak machines
      st.rotAnim = rotTargetRef.current; // jump to the current orientation
    }
  }, [cells, size, hoverIdx, heightMode, maxH, rot, tick, panTick, zoomLabel]);

  // ---- hover / drag / click on the canvas ----
  const hitAt = (mx: number, my: number): number => {
    const hits = (canvasRef.current as (HTMLCanvasElement & { _hits?: Hit[] }) | null)?._hits;
    if (!hits) return -1;
    let found = -1, fdx = Infinity;
    for (const h of hits) {
      const d = Math.abs(mx - h.x) / h.hw + Math.abs(my - h.y) / h.hh;
      if (d <= 1.12 && d < fdx) { found = h.idx; fdx = d; }
    }
    return found;
  };

  const onDown = (e: MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, panX: viewRef.current.panX, panY: viewRef.current.panY, moved: 0 };
  };

  const onMove = (e: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const tip = tipRef.current;
    if (!canvas || !tip) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    const drag = dragRef.current;
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      viewRef.current.panX = drag.panX + dx;
      viewRef.current.panY = drag.panY + dy;
      tip.style.opacity = '0';
      setPanTick((t) => t + 1); // redraw with the new view offset
      return;
    }

    const found = hitAt(mx, my);
    if (found !== hoverRef.current) {
      hoverRef.current = found;
      setHoverIdx(found); // state dep — keeps redraws working when the loop is parked
    }
    if (found >= 0) {
      const c = cells[found];
      const tb = threatBadge(c.maxFrp, c.meanConf, c.nightPct > 40);
      tip.style.opacity = '1';
      tip.style.left = `${Math.min(size.w - 168, Math.max(4, mx + 12))}px`;
      tip.style.top = `${Math.max(4, my - 48)}px`;
      tip.innerHTML = `<b style="color:#FDBA74">${c.n} det</b> · Σ ${Math.round(c.frpSum)} MW · max ${Math.round(c.maxFrp)} MW<br>conf ${Math.round(c.meanConf)} · night ${Math.round(c.nightPct)}% ` +
        `<span style="background:${tb.bg};color:${tb.fg};border-radius:3px;padding:0 4px;font-weight:800;font-size:9px">${tb.label}</span>`;
    } else {
      tip.style.opacity = '0';
    }
  };

  const onUp = (e: MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && drag.moved > 5) return; // was a pan, not a click
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    const found = hitAt(e.clientX - r.left, e.clientY - r.top);
    if (found < 0 || !cells[found] || !slotRef.current) return;
    const c = cells[found];
    selRef.current = found;
    onFlyTo(c.lat, c.lon);
    const payload: HotspotPayload = {
      kind: 'cell', lat: c.lat, lon: c.lon, frp: c.maxFrp, conf: Math.round(c.meanConf),
      sensor: 'multi-sensor', night: c.nightPct > 40, day, regionKey,
      cell: { lat: c.lat, lon: c.lon, n: c.n, frpSum: c.frpSum, meanConf: c.meanConf, nightPct: c.nightPct, maxFrp: c.maxFrp },
    };
    slotRef.current.innerHTML = cellPopupHTML({ lat: c.lat, lon: c.lon, n: c.n, frpSum: c.frpSum, meanConf: c.meanConf, nightPct: c.nightPct, maxFrp: c.maxFrp }, { regionKey, day });
    wireHotspotAI(slotRef.current, onAskAi);
    void runHotspotAIInto(slotRef.current.querySelector<HTMLElement>('.ignis-ai-slot') as HTMLElement, payload);
  };

  // keyboard navigation — ←/→ rotate · +/− zoom · R reset
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const v = viewRef.current;
    if (e.key === 'ArrowRight') { setRot((r) => r + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { setRot((r) => r - 1); e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') { v.zoom = Math.min(8, v.zoom * 1.16); setZoomLabel(+v.zoom.toFixed(2)); e.preventDefault(); }
    else if (e.key === '-' || e.key === '_') { v.zoom = Math.max(0.5, v.zoom / 1.16); setZoomLabel(+v.zoom.toFixed(2)); e.preventDefault(); }
    else if (e.key === 'r' || e.key === 'R') {
      viewRef.current = { zoom: 1, panX: 0, panY: 0 };
      setZoomLabel(1);
      setRot(1);
      e.preventDefault();
    }
  };

  return (
    <div className="pointer-events-auto flex flex-col overflow-hidden rounded-lg border border-[#1E3A5F] bg-[#050A14]/94 text-[11px] text-slate-300 shadow-2xl backdrop-blur" style={{ height: 288 }}>
      <div className="flex items-center gap-2 border-b border-[#14273F] px-2.5 py-1.5">
        <span className="font-bold tracking-wide text-slate-100">🧊 3D FIRE FIELD</span>
        <span className="hidden text-[9.5px] text-slate-500 sm:inline">
          {cells.length ? `${cells.length} cells · click = fly + AI · ←→ rotate` : 'no detections loaded'}
        </span>
        {concentration && (
          <span className="ml-auto hidden rounded bg-[#132A44] px-1.5 py-0.5 text-[9px] text-[#7DD3FC] md:inline">
            top {concentration.topK} cells hold {concentration.share.toFixed(0)}% of ΣFRP
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 md:ml-1">
          <button onClick={() => setHeightMode((m) => (m === 'count' ? 'frp' : 'count'))} title="tower height basis"
            className="rounded border border-[#1E3A5F] px-1.5 py-0.5 text-[9px] text-slate-300 hover:border-[#38BDF8]">
            {heightMode === 'count' ? 'H: count' : 'H: ΣFRP'}
          </button>
          <button onClick={() => setRot((r) => r + 1)} title="rotate 45°"
            className="rounded border border-[#1E3A5F] px-1.5 py-0.5 text-[9px] text-slate-300 hover:border-[#38BDF8]">↻</button>
          <button onClick={() => setRot((r) => r - 1)} title="rotate −45°"
            className="rounded border border-[#1E3A5F] px-1.5 py-0.5 text-[9px] text-slate-300 hover:border-[#38BDF8]">↺</button>
          <button onClick={() => { viewRef.current = { zoom: 1, panX: 0, panY: 0 }; setZoomLabel(1); setRot(1); }} title="reset view"
            className="rounded border border-[#1E3A5F] px-1.5 py-0.5 text-[9px] text-slate-300 hover:border-[#38BDF8]">⌂</button>
          <button onClick={onClose} title="close 3D field"
            className="rounded border border-[#1E3A5F] px-1.5 py-0.5 text-[9px] text-slate-400 hover:border-rose-400 hover:text-rose-300">✕</button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={wrapRef} className="absolute inset-0">
          <canvas ref={canvasRef} tabIndex={0} aria-label="3D fire field — isometric towers; arrow keys rotate, plus and minus zoom, R resets"
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onKeyDown={onKeyDown}
            onMouseLeave={() => { dragRef.current = null; hoverRef.current = -1; setHoverIdx(-1); if (tipRef.current) tipRef.current.style.opacity = '0'; }}
            className="h-full w-full cursor-grab outline-none focus:ring-1 focus:ring-[#38BDF8]/40 active:cursor-grabbing" />
        </div>
        <div ref={tipRef} className="pointer-events-none absolute rounded border border-[#1E3A5F] bg-[#050A14]/95 px-2 py-1 text-[9.5px] leading-snug text-slate-300 opacity-0 transition-opacity" />
        {!cells.length && <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-500">waiting for FIRMS detections…</div>}
      </div>
      <div className="max-h-[76px] overflow-y-auto border-t border-[#14273F] px-2.5 py-1" ref={slotRef}>
        <span className="text-[9.5px] text-slate-500">Click a tower: the map flies to that cell and IGNIS AI assesses it here.</span>
      </div>
    </div>
  );
}
