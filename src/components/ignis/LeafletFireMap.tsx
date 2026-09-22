'use client';

// IGNIS GPU-free INTERACTIVE map — Leaflet (DOM/canvas) renderer.
//
// MapLibre GL v6 is WebGL2-only; on browsers where the GPU/WebGL2 context is
// unavailable (Brave "Strict" fingerprinting shields, VMs, headless runners,
// hardware acceleration off) `new maplibregl.Map()` throws GPUInitializationError.
// MapPanel probes WebGL2 up-front and mounts THIS component as the interactive
// fallback instead of a dead static picture:
//   · NASA GIBS raster basemaps/overlays via plain <img> XYZ tile requests
//     (EPSG:3857 GoogleMapsCompatible WMTS) — zero WebGL anywhere
//   · canvas vector rendering (preferCanvas) keeps 25k+ hotspots smooth
//   · same style modes, sensor filters, hexbin, segmentation, ML forecast,
//     EONET events, GIBS fire-pixel cross-check, popups + Ask-IGNIS-AI, and
//     AOI picking (click / shift-drag) as the MapLibre view
// Leaflet is loaded through a dynamic import inside the mount effect so the
// module (which touches `window` at import time) is never evaluated during SSR.

import { useEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import type * as LeafletNS from 'leaflet';
import type { HotspotsResult, EonetRanked } from '@/lib/ignis/types';
import { SENSOR_COLORS, GIBS_BASEMAPS, GIBS_OVERLAYS, gibs3857Url } from '@/lib/ignis/regions';
import { CLASS_STYLE, type SegmentationResult } from '@/lib/ignis/segmentation';
import type { ForecastField } from '@/lib/ignis/forecast';
import { hexbin } from '@/lib/ignis/hexbin';
import { detectionPopupHTML, gibsPopupHTML, clusterPopupHTML, hexPopupHTML, wireHotspotAI, threatBadge, type ClusterCtx } from '@/lib/ignis/hotspotAI';
import type { StyleMode } from './MapPanel';

type Props = {
  bbox: number[];
  regionKey: string;
  day: string;
  displayData: HotspotsResult | null;
  visible: Record<string, boolean>;
  styleMode: StyleMode;
  basemapKey: string;
  overlays: Record<string, boolean>;
  showHex: boolean;
  showSeg: boolean;
  seg: SegmentationResult | null;
  forecast?: ForecastField | null;
  eonet: EonetRanked[];
  pickMode: boolean;
  onPick: (bbox: number[]) => void;
  onAskAi: (q: string) => void;
  flyTarget?: { lat: number; lon: number; k: number } | null;
  resizeNonce?: number; // bumped when the panel geometry changes (focus mode)
};

type FirePt = { sensor: string; frp: number; conf: number; sat: string; acq: string; night: boolean; lat: number; lon: number };

// ---- shared color ramps (mirror MapPanel so both renderers look identical) ----
// v5.12 PROPER RED family — every dot reads as fire-red at any zoom
const FRP_RAMP: [number, string][] = [
  [0, '#FCA5A5'], [10, '#F87171'], [25, '#EF4444'], [60, '#DC2626'], [120, '#B91C1C'], [250, '#7F1D1D'], [500, '#450A0A'],
];
const CONF_RAMP: [number, string][] = [[0, '#475569'], [45, '#FBBF24'], [75, '#FB923C'], [90, '#F8FAFC']];

function rampColor(ramp: [number, string][], v: number): string {
  let c = ramp[0][1];
  for (const [t, col] of ramp) if (v >= t) c = col;
  return c;
}

// zoom-interpolated radii — replicate MapLibre's size curves on the Leaflet
// canvas renderer (circleMarker radius is screen-space px). Dots stay COMPACT
// below ~z6 (the AOI view shows structure, not a merged red blob), then grow
// to the full spread radius by z8; the pre-z6 floors (glow 2.4px, core 2.1px)
// keep every dot solidly watchable when the map is NOT zoomed in.
const zt = (z: number) => Math.min(1, Math.max(0, (z - 4.5) / 3.5));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const glowR = (frp: number, z: number) => mix(2.4 + 1.3 * Math.sqrt(frp), 8 + 6 * Math.sqrt(frp), zt(z));
const coreR = (frp: number, z: number) => mix(2.1 + 0.8 * Math.sqrt(frp), 4.2 + 3.6 * Math.sqrt(frp), zt(z));
const hotR = (z: number) => mix(1.8, 5.4, zt(z));
const segCoreR = (n: number, z: number) => mix(2.2 + 0.9 * Math.sqrt(n), 5 + 2.0 * Math.sqrt(n), zt(z));
const gibsRingR = (frp: number, z: number) => mix(1.8 + 1.3 * Math.sqrt(frp), 4.5 + 3.6 * Math.sqrt(frp), zt(z));
const gibsCoreR = (z: number) => mix(1.2, 3.2, zt(z));

// heatmap-density approximation colors (by FRP of the point — the DOM renderer
// has no GPU density kernel, so hot pixels bloom in heat colors instead)
function heatColor(frp: number): string {
  if (frp < 10) return '#0891B2';
  if (frp < 40) return '#FDE047';
  if (frp < 120) return '#F97316';
  if (frp < 250) return '#DC2626';
  return '#FECACA';
}

// hexbin fill interpolation — 0 → rgba(253,224,71,.25) · .4 → rgba(249,115,22,.45) · 1 → rgba(185,28,28,.65)
function hexFill(t: number): string {
  const stops: [number, [number, number, number, number]][] = [[0, [253, 224, 71, 0.25]], [0.4, [249, 115, 22, 0.45]], [1, [185, 28, 28, 0.65]]];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; }
  const u = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * u));
  return `rgba(${c[0]},${c[1]},${c[2]},${c[3].toFixed(2)})`;
}

// forecast cell fill — #FDE047(.5) → #FB923C(.7) → #EF4444(.85) → #B91C1C(1)
function fcColor(p: number): string {
  const stops: [number, [number, number, number]][] = [[0.5, [253, 224, 71]], [0.7, [251, 146, 60]], [0.85, [239, 68, 68]], [1, [185, 28, 28]]];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) if (p >= stops[i][0] && p <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; }
  const u = b[0] === a[0] ? 0 : (p - a[0]) / (b[0] - a[0]);
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * u));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function fcOpacity(p: number): number {
  const stops: [number, number][] = [[0.5, 0.06], [0.7, 0.16], [0.85, 0.34], [1, 0.55]];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) if (p >= stops[i][0] && p <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; }
  const u = b[0] === a[0] ? 0 : (p - a[0]) / (b[0] - a[0]);
  return a[1] + (b[1] - a[1]) * u;
}

export default function LeafletFireMap({ bbox, regionKey, day, displayData, visible, styleMode, basemapKey, overlays, showHex, showSeg, seg, forecast, eonet, pickMode, onPick, onAskAi, flyTarget, resizeNonce }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletNS.Map | null>(null);
  const LRef = useRef<typeof LeafletNS | null>(null);
  const [ready, setReady] = useState(false);
  const [zoomTick, setZoomTick] = useState(0);
  const [failed, setFailed] = useState(false);

  const onPickRef = useRef(onPick);
  const pickRef = useRef(pickMode);
  const askRef = useRef(onAskAi);
  useEffect(() => { onPickRef.current = onPick; pickRef.current = pickMode; askRef.current = onAskAi; }, [onPick, pickMode, onAskAi]);

  // ---- mount (dynamic import — Leaflet touches `window`, never run during SSR) ----
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mod = (await import('leaflet')) as unknown as typeof LeafletNS & { default?: typeof LeafletNS };
        const L = mod.default ?? mod;
        if (!alive || !containerRef.current) return;
        LRef.current = L;
        const m = L.map(containerRef.current, {
          center: [-60, -5],
          zoom: 3,
          minZoom: 2,
          maxZoom: 12,
          zoomControl: false,
          attributionControl: true,
          preferCanvas: true, // canvas vector renderer — no WebGL, handles 25k+ hotspots
          boxZoom: false,     // shift+drag is reserved for AOI picking
          worldCopyJump: true,
          zoomSnap: 0.5,
        });
        m.attributionControl.setPrefix('');
        L.control.zoom({ position: 'bottomright' }).addTo(m);
        L.control.scale({ position: 'bottomleft', metric: true, imperial: false, maxWidth: 110 }).addTo(m);
        // wire the shared AI buttons inside every popup: "🤖 Analyze" fills the
        // popup's inline slot via /api/hotspot; "💬 Analyst" seeds the main chat.
        m.on('popupopen', (ev: LeafletNS.LeafletEvent) => {
          const popup = (ev as unknown as { popup?: LeafletNS.Popup }).popup;
          wireHotspotAI(popup?.getElement() ?? null, askRef.current);
        });
        mapRef.current = m;
        // demo/support handle (mirrors __ignisMap) — lets E2E drive the GPU-free renderer
        (window as unknown as { __ignisLeaflet?: LeafletNS.Map }).__ignisLeaflet = m;
        setReady(true);
      } catch (err) {
        console.warn('[ignis:leaflet] interactive DOM renderer failed to start', err);
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      try { mapRef.current?.remove(); } catch { /* already gone */ }
      mapRef.current = null;
    };
  }, []);

  // re-derive marker radii when the zoom settles (canvas circles are screen-space)
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const h = () => setZoomTick((t) => t + 1);
    map.on('zoomend', h);
    return () => { map.off('zoomend', h); };
  }, [ready]);

  // cursor reflects pick mode
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.getContainer().style.cursor = pickMode ? 'crosshair' : '';
  }, [pickMode, ready]);

  // focus-mode (fullscreen) toggles change the container geometry after mount —
  // Leaflet caches size at init, so re-measure whenever the nonce bumps
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !resizeNonce) return;
    const t = setTimeout(() => map.invalidateSize({ animate: false }), 60);
    return () => clearTimeout(t);
  }, [resizeNonce, ready]);

  // ---- GIBS raster basemap (plain <img> XYZ tiles — the live "map tile" layer) ----
  const basemapRef = useRef<LeafletNS.TileLayer | null>(null);
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    const bm = GIBS_BASEMAPS[basemapKey];
    const url = gibs3857Url(bm, day);
    if (basemapRef.current) map.removeLayer(basemapRef.current);
    basemapRef.current = L.tileLayer(url, {
      tileSize: 256,
      maxNativeZoom: bm.level, // GIBS TileMatrix level — Leaflet over-zooms beyond it
      maxZoom: 14,
      attribution: 'NASA GIBS',
      crossOrigin: true,
      updateWhenIdle: false,
    }).addTo(map);
    basemapRef.current.bringToBack();
  }, [basemapKey, day, ready]);

  // ---- GIBS raster overlays (coastlines / labels / LST day+night) ----
  const overlaysRef = useRef<Record<string, LeafletNS.TileLayer>>({});
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    for (const [key, cfg] of Object.entries(GIBS_OVERLAYS)) {
      const want = overlays[key];
      const opacity = key === 'labels' ? 0.9 : key.startsWith('lst') ? 0.6 : 0.75;
      const url = gibs3857Url(cfg, day);
      const cur = overlaysRef.current[key];
      if (want && !cur) {
        overlaysRef.current[key] = L.tileLayer(url, { tileSize: 256, maxNativeZoom: cfg.level, maxZoom: 14, opacity }).addTo(map);
      } else if (want && cur) {
        cur.setUrl(url);
        cur.setOpacity(opacity);
      } else if (!want && cur) {
        map.removeLayer(cur);
        delete overlaysRef.current[key];
      }
    }
  }, [overlays, day, ready]);

  // ---- AOI rectangle + auto-fit ----
  const aoiRef = useRef<LeafletNS.Rectangle | null>(null);
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    const [w, s, e, n] = bbox;
    const bounds = L.latLngBounds([s, w], [n, e]);
    if (aoiRef.current) aoiRef.current.setBounds(bounds);
    else {
      aoiRef.current = L.rectangle(bounds, { color: '#38BDF8', weight: 1.6, dashArray: '4 4', fillColor: '#38BDF8', fillOpacity: 0.05, interactive: false }).addTo(map);
    }
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 9, animate: true, duration: 0.9 });
  }, [bbox, ready]);

  // ---- EONET ranked events ----
  const eonetRef = useRef<LeafletNS.LayerGroup | null>(null);
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    if (eonetRef.current) { map.removeLayer(eonetRef.current); eonetRef.current = null; }
    if (!eonet.length) return;
    const g = L.layerGroup();
    for (const ev of eonet) {
      if (ev.lat === null || ev.lon === null) continue;
      L.circleMarker([ev.lat, ev.lon], { radius: 7, color: '#38BDF8', weight: 1.6, fillColor: '#38BDF8', fillOpacity: 0.12 })
        .bindPopup(
          `<div style="font:12px/1.5 ui-sans-serif"><div style="font-weight:700;color:#7DD3FC">🌐 EONET wildfire event</div><div>${ev.title}</div><div style="color:#94A3B8">${ev.date?.slice(0, 10)}</div><a href="${ev.link}" target="_blank" rel="noreferrer" style="color:#38BDF8">NASA EONET details →</a></div>`,
          { maxWidth: 260 },
        )
        .addTo(g);
    }
    g.addTo(map);
    eonetRef.current = g;
  }, [eonet, ready]);

  // ---- active fire detections (canvas circleMarkers + one shared popup) ----
  const firesRef = useRef<LeafletNS.FeatureGroup | null>(null);
  const pulsesRef = useRef<LeafletNS.LayerGroup | null>(null);
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    if (firesRef.current) { map.removeLayer(firesRef.current); firesRef.current = null; }
    if (!displayData) return;

    const pts: FirePt[] = [];
    for (const [sensor, s] of Object.entries(displayData.sensors)) {
      if (!visible[sensor]) continue;
      for (const p of s.points) {
        pts.push({
          sensor,
          frp: Math.min(600, Math.max(0.5, p.frp || 0.5)),
          conf: typeof p.conf === 'number' ? p.conf : 60,
          sat: p.sat || '', acq: p.acq || '', night: !!p.night, lat: p.lat, lon: p.lon,
        });
      }
    }
    pts.sort((a, b) => b.frp - a.frp);
    // heatmap mode paints big soft blobs — cap the draw list so canvas fill-rate stays smooth
    const draw = styleMode === 'heatmap' ? pts.slice(0, 6000) : pts;
    if (!draw.length) return;

    const zoom = map.getZoom();
    const colorFor = (pt: FirePt) =>
      styleMode === 'sensor' ? (SENSOR_COLORS[pt.sensor] || '#F97316')
        : styleMode === 'confidence' ? rampColor(CONF_RAMP, pt.conf)
          : rampColor(FRP_RAMP, pt.frp);

    const fg = L.featureGroup();

    if (styleMode === 'heatmap') {
      for (const pt of draw) {
        L.circleMarker([pt.lat, pt.lon], { radius: glowR(pt.frp, zoom) * 2.4, stroke: false, fillColor: heatColor(pt.frp), fillOpacity: 0.3 }).addTo(fg);
      }
    } else {
      for (const pt of draw) {
        const ll: [number, number] = [pt.lat, pt.lon];
        const col = colorFor(pt);
        const tag = (m: LeafletNS.CircleMarker) => {
          (m as LeafletNS.CircleMarker & { _pt?: FirePt })._pt = pt;
          return m;
        };
        tag(L.circleMarker(ll, { radius: glowR(pt.frp, zoom), stroke: false, fillColor: col, fillOpacity: 0.4 })).addTo(fg);
        // crisp core — dark rim first (contrast on bright true-color basemaps),
        // then the solid red-filled core with a white halo stroke: the red spot
        // + spread radius stays legible on every basemap without changing the
        // radius physics (∝ √FRP)
        tag(L.circleMarker(ll, { radius: coreR(pt.frp, zoom) + 0.8, stroke: false, fillColor: 'rgba(5,10,20,0.6)', fillOpacity: 0.9 })).addTo(fg);
        tag(L.circleMarker(ll, { radius: coreR(pt.frp, zoom), color: 'rgba(255,255,255,0.65)', weight: 0.7, fillColor: col, fillOpacity: 0.97 })).addTo(fg);
        if (pt.frp >= 150) tag(L.circleMarker(ll, { radius: hotR(zoom), stroke: false, fillColor: '#FFFFFF', fillOpacity: 0.95 })).addTo(fg);
      }

      // EXTREME pulse halos — the strongest detections (threat score ≥ 80) get a
      // CSS-animated expanding ring (pure compositor animation, zero WebGL, ~zero
      // CPU) so the eye is drawn to the highest-threat spots instantly
      if (pulsesRef.current) { map.removeLayer(pulsesRef.current); pulsesRef.current = null; }
      const extreme = pts.filter((p) => threatBadge(p.frp, p.conf, p.night).score >= 80).slice(0, 24);
      if (extreme.length) {
        const pg = L.layerGroup();
        for (const p of extreme) {
          L.marker([p.lat, p.lon], {
            icon: L.divIcon({ className: 'ignis-pulse-wrap', html: '<span class="ignis-pulse"></span>', iconSize: [30, 30] }),
            interactive: false, keyboard: false,
          }).addTo(pg);
        }
        pg.addTo(map);
        pulsesRef.current = pg;
      }
      // click any fire circle → shared popup (event bubbling via FeatureGroup)
      fg.on('click', (ev: LeafletNS.LeafletMouseEvent) => {
        const layer = ev.sourceTarget as LeafletNS.CircleMarker & { _pt?: FirePt };
        if (!layer?._pt) return;
        const pt = layer._pt;
        L.popup({ maxWidth: 300, closeButton: true })
          .setLatLng(layer.getLatLng())
          .setContent(
            detectionPopupHTML({ sensor: pt.sensor, sat: pt.sat, frp: pt.frp, conf: pt.conf, acq: pt.acq, night: pt.night, lat: pt.lat, lon: pt.lon }, { regionKey, day }),
          )
          .openOn(map);
      });
      fg.on('mouseover', () => { if (!pickRef.current) map.getContainer().style.cursor = 'pointer'; });
      fg.on('mouseout', () => { map.getContainer().style.cursor = pickRef.current ? 'crosshair' : ''; });
    }
    fg.addTo(map);
    firesRef.current = fg;
  }, [displayData, visible, styleMode, day, regionKey, ready, zoomTick]);

  // ---- click-priority: individual hotspots must stay clickable THROUGH
  // aggregation layers (hexbin cells / seg hulls / forecast cells). Canvas hit
  // order = draw order, so after any aggregation layer (re)renders we re-raise
  // the fire circles — clicks then hit a detection first (per-hotspot AI), and
  // fall through to the cluster/hex popup only where no detection sits.
  const bringFiresToFront = () => {
    firesRef.current?.eachLayer((l) => {
      (l as unknown as { bringToFront?: () => void }).bringToFront?.();
    });
  };

  // ---- hexbin density (same math as the GL path — shared lib) ----
  const hexRef = useRef<LeafletNS.LayerGroup | null>(null);
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    if (hexRef.current) { map.removeLayer(hexRef.current); hexRef.current = null; }
    if (!showHex || !displayData) return;
    const pts = Object.entries(displayData.sensors).flatMap(([sensor, s]) =>
      visible[sensor] ? s.points.map((p) => ({ lon: p.lon, lat: p.lat, frp: p.frp || 0 })) : [],
    );
    const { bin, maxN, features } = hexbin(pts, bbox);
    const g = L.layerGroup();
    for (const f of features) {
      L.rectangle(
        [[f.lat - bin / 2, f.lon - bin / 2], [f.lat + bin / 2, f.lon + bin / 2]],
        { color: 'rgba(251,146,60,0.35)', weight: 0.6, fillColor: hexFill(f.n / maxN), fillOpacity: 1 },
      )
        // density cells are AI-interactive too: threat badge + Analyze + Analyst
        .bindPopup(hexPopupHTML({ lat: f.lat, lon: f.lon, n: f.n, frp: f.frp, bin }, { regionKey, day }), { maxWidth: 260 })
        .addTo(g);
    }
    g.addTo(map);
    hexRef.current = g;
    bringFiresToFront();
  }, [displayData, showHex, visible, bbox, ready]);

  // ---- fire segmentation (DBSCAN hulls + class styling, shared with Fire Cluster Lab) ----
  const segRef = useRef<LeafletNS.LayerGroup | null>(null);
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    if (segRef.current) { map.removeLayer(segRef.current); segRef.current = null; }
    if (!showSeg || !seg || !seg.clusters.length) return;
    const zoom = map.getZoom();
    const g = L.layerGroup();
    for (const c of seg.clusters) {
      const st = CLASS_STYLE[c.cls];
      const ring = c.hull.map(([lon, lat]) => [lat, lon] as LeafletNS.LatLngExpression);
      const clusterCtx: ClusterCtx = {
        id: c.id, cls: c.cls, n: c.n, frpSum: c.frpSum, meanFrp: c.frpMean, spreadKm: c.spreadKm,
        areaKm2: c.areaKm2, elongation: c.elongation, nightPct: c.nightPct, sensors: Object.keys(c.sensors).join(', '),
        modelCls: c.modelCls, modelClsPct: c.modelClsPct,
      };
      L.polygon(ring, { color: st.stroke, weight: st.width, fillColor: st.fill, fillOpacity: 1 })
        .bindPopup(
          clusterPopupHTML(clusterCtx, { regionKey, day }),
          { maxWidth: 300 },
        )
        .addTo(g);
      L.circleMarker([c.centroid[1], c.centroid[0]], { radius: segCoreR(c.n, zoom), color: '#1C1917', weight: 1, fillColor: 'rgba(255,255,255,0.85)', fillOpacity: 0.9 }).addTo(g);
    }
    g.addTo(map);
    segRef.current = g;
    bringFiresToFront();
  }, [seg, showSeg, day, regionKey, ready, zoomTick]);

  // ---- ML next-day footprint forecast overlay ----
  const fcRef = useRef<LeafletNS.LayerGroup | null>(null);
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    if (fcRef.current) { map.removeLayer(fcRef.current); fcRef.current = null; }
    if (!forecast || !forecast.cells.length) return;
    const half = forecast.cellDeg / 2;
    const g = L.layerGroup();
    for (const c of forecast.cells) {
      L.rectangle(
        [[c.lat - half, c.lon - half], [c.lat + half, c.lon + half]],
        { color: 'rgba(254,215,170,0.55)', weight: 0.6, fillColor: fcColor(c.p), fillOpacity: fcOpacity(c.p), interactive: false },
      ).addTo(g);
    }
    g.addTo(map);
    fcRef.current = g;
    bringFiresToFront();
  }, [forecast, ready]);

  // ---- GIBS fire pixels (independent vector cross-check of the FIRMS pipeline) ----
  const gibsRef = useRef<LeafletNS.LayerGroup | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready) return;
    let alive = true;
    if (gibsRef.current && map) { map.removeLayer(gibsRef.current); gibsRef.current = null; }
    if (!overlays.gibsfires) return;
    const [w, s, e, n] = bbox;
    fetch(`/api/gibsfires?w=${w}&s=${s}&e=${e}&n=${n}&day=${day}`)
      .then((r) => r.json())
      .catch(() => null)
      .then((fc: { error?: boolean; features?: { geometry: { coordinates: [number, number] }; properties?: Record<string, number | string> }[] } | null) => {
        const L = LRef.current;
        const m = mapRef.current;
        if (!alive || !L || !m || !fc || fc.error || !fc.features) return;
        const zoom = m.getZoom();
        const g = L.layerGroup();
        for (const f of fc.features) {
          const [lon, lat] = f.geometry.coordinates;
          const frp = Math.max(0.5, Number(f.properties?.frp) || 0.5);
          L.circleMarker([lat, lon], { radius: gibsRingR(frp, zoom), color: '#F87171', weight: 1.1, fillColor: 'rgba(239,68,68,0.22)', fillOpacity: 1 }).addTo(g);
          L.circleMarker([lat, lon], { radius: gibsCoreR(zoom), color: '#FFFFFF', weight: 0.5, fillColor: '#FCA5A5', fillOpacity: 0.95 })
            .bindPopup(
              gibsPopupHTML({ sensor: String(f.properties?.sensor ?? 'GIBS'), frp, lat, lon }, { regionKey, day }),
              { maxWidth: 300 },
            )
            .addTo(g);
        }
        g.addTo(m);
        gibsRef.current = g;
        bringFiresToFront();
      });
    return () => { alive = false; };
  }, [overlays.gibsfires, day, bbox, ready]);

  // ---- fly-to requests from the 3D Fire Field panel (nonce-keyed) ----
  const flyKRef = useRef<number>(-1);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !flyTarget || flyTarget.k === flyKRef.current) return;
    flyKRef.current = flyTarget.k;
    map.flyTo([flyTarget.lat, flyTarget.lon], Math.max(map.getZoom(), 7), { duration: 0.8 });
  }, [flyTarget, ready]);

  // ---- AOI pick interactions: click-to-pick + shift-drag rectangle (same UX as the GL path) ----
  useEffect(() => {
    const map = mapRef.current, L = LRef.current;
    if (!ready || !map || !L) return;

    const click = (e: LeafletNS.LeafletMouseEvent) => {
      if (!pickRef.current) return;
      const { lat, lng } = e.latlng;
      onPickRef.current([+(lng - 2.25).toFixed(2), +(lat - 2).toFixed(2), +(lng + 2.25).toFixed(2), +(lat + 2).toFixed(2)]);
    };

    let start: LeafletNS.LatLng | null = null;
    let box: LeafletNS.Rectangle | null = null;
    const down = (e: LeafletNS.LeafletMouseEvent) => {
      if (!e.originalEvent.shiftKey || pickRef.current) return;
      start = e.latlng;
      map.dragging.disable();
      box = L.rectangle(L.latLngBounds(start, start), { color: '#38BDF8', weight: 1.5, dashArray: '4 4', fillColor: '#38BDF8', fillOpacity: 0.08, interactive: false }).addTo(map);
    };
    const move = (e: LeafletNS.LeafletMouseEvent) => {
      if (!start || !box) return;
      box.setBounds(L.latLngBounds(start, e.latlng));
    };
    const up = () => {
      if (!start || !box) return;
      const b = box.getBounds();
      box.remove(); box = null;
      map.dragging.enable();
      start = null;
      const w = +b.getWest().toFixed(2), s2 = +b.getSouth().toFixed(2), e2 = +b.getEast().toFixed(2), n2 = +b.getNorth().toFixed(2);
      if (Math.abs(e2 - w) > 0.5 && Math.abs(n2 - s2) > 0.5) onPickRef.current([w, s2, e2, n2]);
    };

    map.on('click', click);
    map.on('mousedown', down);
    map.on('mousemove', move);
    map.on('mouseup', up);
    return () => {
      map.off('click', click);
      map.off('mousedown', down);
      map.off('mousemove', move);
      map.off('mouseup', up);
      if (box) { try { box.remove(); } catch { /* noop */ } }
      try { map.dragging.enable(); } catch { /* noop */ }
    };
  }, [ready]);

  if (failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#050A14] px-6 text-center text-[11px] text-slate-400">
        <span className="font-bold text-amber-300">Map renderer failed to start</span>
        <span>Reload the page — every stat panel above stays live even without the map.</span>
      </div>
    );
  }

  return <div ref={containerRef} className={`h-full w-full ${pickMode ? 'cursor-crosshair' : ''}`} />;
}
