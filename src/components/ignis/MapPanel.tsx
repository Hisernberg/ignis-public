'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { HotspotsResult, MultiHotspots, EonetRanked } from '@/lib/ignis/types';
import { SENSOR_COLORS, GIBS_BASEMAPS, GIBS_OVERLAYS, gibs3857Url, LST_RAMP } from '@/lib/ignis/regions';
import { hexbin } from '@/lib/ignis/hexbin';
import LeafletFireMap from './LeafletFireMap';
import FireField3D from './FireField3D';
import TerrainScene3D from './TerrainScene3D';
import { detectionPopupHTML, clusterPopupHTML, gibsPopupHTML, hexPopupHTML, wireHotspotAI, threatBadge, type ClusterCtx } from '@/lib/ignis/hotspotAI';
import { clustersToGeoJSON, CLASS_STYLE, type SegmentationResult, type ClusterClass } from '@/lib/ignis/segmentation';
import type { ForecastField } from '@/lib/ignis/forecast';
import { FORECASTER_META } from '@/lib/ignis/forecast';

export type StyleMode = 'intensity' | 'sensor' | 'confidence' | 'heatmap';

type Props = {
  bbox: number[];
  regionKey: string;
  day: string;
  hotspots: HotspotsResult | null;
  multiDay: MultiHotspots | null;
  pickMode: boolean;
  onPick: (bbox: number[]) => void;
  eonet: EonetRanked[];
  onAskAi: (q: string) => void;
  seg: SegmentationResult | null;
  forecast?: ForecastField | null;
  forecastLoading?: boolean;
  onToggleForecast?: () => void;
};

// v5.12 fire-dot ramp — the PROPER RED family: every detection reads as a red
// fire dot at any zoom (pale red → deep crimson with FRP), instead of the old
// yellow→red ramp where small burns washed out pale-yellow and vanished against
// bright basemaps. Intensity still encodes: red depth + size (∝ √FRP) + glow.
const FRP_RAMP: [number, string][] = [
  [0, '#FCA5A5'], [10, '#F87171'], [25, '#EF4444'], [60, '#DC2626'], [120, '#B91C1C'], [250, '#7F1D1D'], [500, '#450A0A'],
];
const CONF_RAMP: [number, string][] = [[0, '#475569'], [45, '#FBBF24'], [75, '#FB923C'], [90, '#F8FAFC']];

const FRP_EXPR = ['interpolate', ['linear'], ['max', ['get', 'frp'], 0.5], ...FRP_RAMP.flat()] as unknown as maplibregl.ExpressionSpecification;
// Legend gradients precomputed at module scope with INTEGER percentage stops —
// identical on server and client (CSSOM re-serialization of long decimals breaks hydration).
const FRP_GRADIENT = `linear-gradient(90deg,${FRP_RAMP.map(([v, c]) => `${c} ${Math.round((Math.log10(1 + v) / Math.log10(501)) * 100)}%`).join(',')})`;
const CONF_GRADIENT = `linear-gradient(90deg,${CONF_RAMP.map(([v, c]) => `${c} ${Math.round((v / 90) * 100)}%`).join(',')})`;

// WebGL2 capability probe — MapLibre GL v6 is WebGL2-only and throws
// GPUInitializationError synchronously from `new maplibregl.Map()` when the
// browser/GPU cannot create a context (Brave strict fingerprinting shields,
// headless/CI runners, VMs without GPU drivers, hardware acceleration off).
// We probe up front so the panel can mount the GPU-free Leaflet renderer
// (LeafletFireMap — plain <img> GIBS tiles, canvas vectors, zero WebGL)
// instead of crashing the whole page. Escape hatch: append ?nogpu=1 to the
// URL to force the GPU-free renderer (support / CI / screenshot testing).
function webgl2Supported(): boolean {
  try {
    if (typeof window === 'undefined') return true; // SSR — probed again in the client effect
    if (new URLSearchParams(window.location.search).has('nogpu')) return false;
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

const SENSOR_EXPR = ['match', ['get', 'sensor'], ...Object.entries(SENSOR_COLORS).flat(), '#F97316'] as unknown as maplibregl.ExpressionSpecification;
const CONF_EXPR = ['interpolate', ['linear'], ['max', ['get', 'conf'], 0], ...CONF_RAMP.flat()] as unknown as maplibregl.ExpressionSpecification;

function colorExpr(mode: StyleMode): maplibregl.ExpressionSpecification {
  if (mode === 'sensor') return SENSOR_EXPR;
  if (mode === 'confidence') return CONF_EXPR;
  return FRP_EXPR;
}

export default function MapPanel({ bbox, regionKey, day, hotspots, multiDay, pickMode, onPick, eonet, onAskAi, seg, forecast, forecastLoading, onToggleForecast }: Props) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [basemapKey, setBasemapKey] = useState('bands721');
  const [styleMode, setStyleMode] = useState<StyleMode>('intensity');
  const [overlays, setOverlays] = useState<Record<string, boolean>>({ coastlines: true, labels: false, lst_day: false, lst_night: false, gibsfires: false });
  const [showHex, setShowHex] = useState(false);
  const [showSeg, setShowSeg] = useState(true);
  const [visible, setVisible] = useState<Record<string, boolean>>({ 'MODIS-Terra': true, 'MODIS-Aqua': true, 'VIIRS-SNPP': true, 'VIIRS-NOAA20': true, 'VIIRS-NOAA21': true });
  const [animDay, setAnimDay] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(900);
  const [hudDay, setHudDay] = useState(day);
  const [gpuBlocked, setGpuBlocked] = useState(false);
  const [initNonce, setInitNonce] = useState(0);
  const [show3D, setShow3D] = useState(false);
  const [showTerrainScene, setShowTerrainScene] = useState(false);
  const [terrain3D, setTerrain3D] = useState(false);
  const [show3DTowers, setShow3DTowers] = useState(false);
  const [flyTarget, setFlyTarget] = useState<{ lat: number; lon: number; k: number } | null>(null);
  // v5.11 visibility overhaul — the map itself is the hero: every overlay
  // collapses to a compact chip by default and expands on demand, and the
  // panel can go fullscreen (⛶ focus) without touching the page grid
  const [hudOpen, setHudOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [focus, setFocus] = useState(false);
  const [showHint, setShowHint] = useState(true);
  const [bannerOff, setBannerOff] = useState(false);
  const [resizeNonce, setResizeNonce] = useState(0);

  // bottom hint auto-fades — one glance is enough, then the map is clean
  useEffect(() => {
    const t = setTimeout(() => setShowHint(false), 7000);
    return () => clearTimeout(t);
  }, []);

  // focus (fullscreen) mode: lock page scroll, re-measure the renderer on
  // every geometry change, Esc exits
  useEffect(() => {
    if (!focus) return;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocus(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [focus]);

  // renderer re-measure after focus toggles resize the container
  useEffect(() => {
    if (!resizeNonce) return;
    const map = mapRef.current;
    const t = setTimeout(() => { try { map?.resize(); } catch { /* noop */ } }, 60);
    return () => clearTimeout(t);
  }, [resizeNonce]);

  const onPickRef = useRef(onPick);
  const pickRef = useRef(pickMode);
  const askRef = useRef(onAskAi);
  useEffect(() => { onPickRef.current = onPick; pickRef.current = pickMode; askRef.current = onAskAi; }, [onPick, pickMode, onAskAi]);

  const dayKeys = useMemo(() => (multiDay ? Object.keys(multiDay.days).sort() : []), [multiDay]);
  const displayDay = animDay ?? day;
  const displayData = useMemo(
    () => (multiDay && multiDay.days[displayDay]) || hotspots,
    [multiDay, displayDay, hotspots],
  );

  // ---- map init (with WebGL2 probe + graceful GPU failure) ----
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    // MapLibre v6 requires WebGL2 — probe BEFORE constructing so browsers with
    // a blocked/disabled GPU (Brave strict shields, VMs, headless runners)
    // mount the GPU-free Leaflet renderer instead of a thrown
    // GPUInitializationError crashing the whole page.
    if (!webgl2Supported()) {
      const t = setTimeout(() => setGpuBlocked(true), 0); // deferred — no sync setState in effect body
      return () => clearTimeout(t);
    }
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: {
          version: 8,
          sources: {
            basemap: { type: 'raster', tiles: [gibs3857Url(GIBS_BASEMAPS[basemapKey], day)], tileSize: 256, maxzoom: GIBS_BASEMAPS[basemapKey].level, attribution: 'NASA GIBS' },
          },
          layers: [
            { id: 'bg', type: 'background', paint: { 'background-color': '#050A14' } },
            { id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-opacity': 1 } },
          ],
        },
        center: [-60, -5],
        zoom: 3,
        attributionControl: false,
        doubleClickZoom: true,
      });
    } catch (err) {
      // GPUInitializationError & friends — degrade to the Leaflet view, never crash.
      console.warn('[ignis:map] WebGL2 context creation failed — switching to Leaflet DOM renderer', err);
      const t = setTimeout(() => setGpuBlocked(true), 0); // deferred — no sync setState in effect body
      return () => clearTimeout(t);
    }
    mapRef.current = map;
    // Quietly absorb GIBS tile hiccups (404 on empty vector tiles, transient 5xx) so the
    // browser console never spams AJAXError — layers already handle their own fallbacks.
    // GPU/WebGL failures are the exception: they escalate to the static fallback.
    map.on('error', (e) => {
      const msg = e && e.error ? String((e.error as Error).message || e.error) : 'unknown';
      if (/GPUInitializationError|webgl|graphics context|\bGPU\b/i.test(msg)) {
        setGpuBlocked(true);
        return;
      }
      if (/AJAXError|Failed to fetch|tile|404|400|aborted/i.test(msg)) return;
      console.warn('[ignis:map]', msg);
    });
    // Native canvas event — fires when the driver/GPU drops the context mid-session.
    map.getCanvas().addEventListener('webglcontextlost', () => setGpuBlocked(true), { once: true });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.on('load', () => {
      setReady(true);
      (window as unknown as { __ignisMap?: maplibregl.Map }).__ignisMap = map; // debug/demo handle
    });
    return () => { map.remove(); mapRef.current = null; };
  }, [initNonce]);

  // When the GPU dies mid-session (context lost / init error), tear down the
  // broken GL map so the Leaflet renderer takes over cleanly. `Try WebGL`
  // re-creates the GL map from scratch by bumping initNonce.
  useEffect(() => {
    if (!gpuBlocked || !mapRef.current) return;
    try { mapRef.current.remove(); } catch { /* already gone */ }
    mapRef.current = null;
    const t = setTimeout(() => setReady(false), 0); // deferred — no sync setState in effect body
    return () => clearTimeout(t);
  }, [gpuBlocked]);

  const retryInteractive = useCallback(() => {
    setGpuBlocked(false);
    setInitNonce((n) => n + 1);
  }, []);

  // ---- fly-to requests from the 3D Fire Field panel (GL renderer) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !flyTarget) return;
    map.flyTo({ center: [flyTarget.lat, flyTarget.lon], zoom: Math.max(map.getZoom(), 7), duration: 0.85 });
  }, [flyTarget, ready]);

  const flyToCell = useCallback((lat: number, lon: number) => {
    setFlyTarget({ lat, lon, k: Date.now() });
  }, []);

  // ---- 3D terrain (GL renderer only): AWS Terrarium DEM + hillshade + pitch ----
  // Gives WebGL-capable browsers true elevation relief under the fire layers;
  // GPU-blocked browsers get the equivalent depth cue from the GPU-free
  // FireField3D isometric canvas instead.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || gpuBlocked) return;
    if (!terrain3D) {
      try { map.setTerrain(null); } catch { /* older core */ }
      if (map.getLayer('hs')) map.removeLayer('hs');
      if (map.getSource('dem')) map.removeSource('dem');
      if (map.getPitch() > 5) map.easeTo({ pitch: 0, duration: 700 });
      return;
    }
    try {
      if (!map.getSource('dem')) {
        map.addSource('dem', {
          type: 'raster-dem',
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 13,
          attribution: 'Elevation: AWS/Mapzen Terrain Tiles',
        });
      }
      const before = map.getLayer('aoi-fill') ? 'aoi-fill' : undefined;
      if (!map.getLayer('hs')) {
        map.addLayer({
          id: 'hs', type: 'hillshade', source: 'dem',
          paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#0B1220', 'hillshade-highlight-color': '#E2E8F0' },
        }, before);
      }
      map.setTerrain({ source: 'dem', exaggeration: 1.3 });
      map.easeTo({ pitch: 62, duration: 1100 });
    } catch (err) {
      console.warn('[ignis:map] 3D terrain unavailable on this GPU', err);
    }
  }, [terrain3D, ready, gpuBlocked]);

  // ---- basemap + overlay sources ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const bm = GIBS_BASEMAPS[basemapKey];
    const url = gibs3857Url(bm, displayDay);
    const src = map.getSource('basemap') as maplibregl.RasterTileSource | undefined;
    if (src) {
      // maxzoom must match the layer's TileMatrix level so MapLibre over-zooms instead of 404ing
      if ((src as unknown as { maxzoom?: number }).maxzoom === bm.level) {
        try { (src as unknown as { setTiles: (t: string[]) => void }).setTiles([url]); } catch { /* older API */ }
      } else {
        if (map.getLayer('basemap')) map.removeLayer('basemap');
        map.removeSource('basemap');
        map.addSource('basemap', { type: 'raster', tiles: [url], tileSize: 256, maxzoom: bm.level, attribution: 'NASA GIBS' });
        map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-opacity': 1 } });
        if (map.getLayer('aoi-fill')) map.moveLayer('basemap', 'aoi-fill');
      }
    }
  }, [basemapKey, displayDay, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const [key, cfg] of Object.entries(GIBS_OVERLAYS)) {
      const on = overlays[key];
      const srcId = `ov-${key}`, layerId = `ov-${key}`;
      if (on && !map.getSource(srcId)) {
        map.addSource(srcId, { type: 'raster', tiles: [gibs3857Url(cfg, displayDay)], tileSize: 256, maxzoom: cfg.level });
        map.addLayer({ id: layerId, type: 'raster', source: srcId, paint: { 'raster-opacity': key === 'labels' ? 0.9 : key.startsWith('lst') ? 0.6 : 0.75 } });
      } else if (on && map.getLayer(layerId)) {
        const s = map.getSource(srcId) as maplibregl.RasterTileSource;
        try { (s as unknown as { setTiles: (t: string[]) => void }).setTiles([gibs3857Url(cfg, displayDay)]); } catch { /* noop */ }
      } else if (!on && map.getLayer(layerId)) {
        map.removeLayer(layerId);
        map.removeSource(srcId);
      }
    }
  }, [overlays, displayDay, ready]);

  // ---- GIBS fire pixels (vector cross-check) ----
  // GIBS serves thermal anomalies ONLY as Mapbox vector tiles (epsg4326 1km/500m TMS),
  // so the server parses them to GeoJSON (/api/gibsfires) — the old client-side raster
  // overlay (.png @ epsg3857) is a format GIBS does not provide and always returned 400.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!overlays.gibsfires) {
      for (const l of ['gibsfires-core', 'gibsfires-ring']) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource('gibsfires')) map.removeSource('gibsfires');
      return;
    }
    let alive = true;
    (async () => {
      const [w, s, e, n] = bbox;
      const fc = await fetch(`/api/gibsfires?w=${w}&s=${s}&e=${e}&n=${n}&day=${displayDay}`)
        .then((r) => r.json()).catch(() => null);
      if (!alive || !map || !fc || fc.error) return;
      if (!map.getSource('gibsfires')) {
        map.addSource('gibsfires', { type: 'geojson', data: fc });
        const ring: maplibregl.CircleLayerSpecification = {
          id: 'gibsfires-ring', type: 'circle', source: 'gibsfires',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['+', 1.8, ['*', 1.3, ['sqrt', ['max', ['get', 'frp'], 0.5]]]], 8, ['+', 4.5, ['*', 3.6, ['sqrt', ['max', ['get', 'frp'], 0.5]]]]],
            'circle-color': 'rgba(239,68,68,0.22)',
            'circle-stroke-color': '#F87171', 'circle-stroke-width': 1.1,
          },
        };
        const core: maplibregl.CircleLayerSpecification = {
          id: 'gibsfires-core', type: 'circle', source: 'gibsfires',
          paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 1.2, 8, 3.2], 'circle-color': '#FCA5A5', 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 0.5 },
        };
        try { map.addLayer(ring, 'fires-glow'); map.addLayer(core, 'fires-glow'); }
        catch { map.addLayer(ring); map.addLayer(core); }
        map.on('click', 'gibsfires-core', (ev) => {
          const f = ev.features?.[0];
          if (!f) return;
          const p = f.properties as Record<string, string | number>;
          const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
          const popup = new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(ev.lngLat).setHTML(
            gibsPopupHTML({ sensor: String(p.sensor ?? 'GIBS'), frp: Number(p.frp), lat: coords[0], lon: coords[1] }, { regionKey, day: displayDay }),
          ).addTo(map);
          wireHotspotAI(popup.getElement(), askRef.current);
        });
      } else {
        (map.getSource('gibsfires') as maplibregl.GeoJSONSource).setData(fc);
      }
    })();
    return () => { alive = false; };
  }, [overlays.gibsfires, displayDay, bbox, ready]);

  // ---- AOI box ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const aoi = {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const, properties: {},
        geometry: { type: 'Polygon' as const, coordinates: [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]] },
      }],
    };
    if (map.getSource('aoi')) (map.getSource('aoi') as maplibregl.GeoJSONSource).setData(aoi);
    else {
      map.addSource('aoi', { type: 'geojson', data: aoi });
      map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#38BDF8', 'fill-opacity': 0.05 } });
      map.addLayer({ id: 'aoi-line', type: 'fill', source: 'aoi', paint: { 'fill-color': '#38BDF8', 'fill-opacity': 0.0 } });
      map.addLayer({ id: 'aoi-stroke', type: 'line', source: 'aoi', paint: { 'line-color': '#38BDF8', 'line-width': 1.6, 'line-dasharray': [2, 2] } });
    }
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 900, maxZoom: 9 });
  }, [bbox, ready]);

  // ---- EONET events ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const fc = {
      type: 'FeatureCollection' as const,
      features: eonet.filter((e) => e.lat !== null).map((e) => ({
        type: 'Feature' as const,
        properties: { title: e.title, link: e.link, date: e.date, rel: e.relevance },
        geometry: { type: 'Point' as const, coordinates: [e.lon!, e.lat!] },
      })),
    };
    if (map.getSource('eonet')) (map.getSource('eonet') as maplibregl.GeoJSONSource).setData(fc);
    else {
      map.addSource('eonet', { type: 'geojson', data: fc });
      map.addLayer({
        id: 'eonet-ring', type: 'circle', source: 'eonet',
        paint: { 'circle-radius': 7, 'circle-color': 'rgba(56,189,248,0.12)', 'circle-stroke-color': '#38BDF8', 'circle-stroke-width': 1.6 },
      });
    }
  }, [eonet, ready]);

  // ---- fire points ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!displayData) return;
    const feats: Array<{ type: 'Feature'; properties: Record<string, string | number>; geometry: { type: 'Point'; coordinates: [number, number] } }> = [];
    for (const [sensor, s] of Object.entries(displayData.sensors)) {
      if (!visible[sensor]) continue;
      for (const p of s.points) {
        feats.push({
          type: 'Feature' as const,
          properties: {
            sensor, frp: Math.min(600, Math.max(0.5, p.frp || 0.5)),
            conf: typeof p.conf === 'number' ? p.conf : 60,
            night: p.night ? 'N' : 'D', sat: p.sat || '', acq: p.acq || '',
          },
          geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        });
      }
    }
    const fc = { type: 'FeatureCollection' as const, features: feats };
    if (map.getSource('fires')) (map.getSource('fires') as maplibregl.GeoJSONSource).setData(fc);
    else {
      map.addSource('fires', { type: 'geojson', data: fc });
      map.addLayer({
        id: 'fires-heat', type: 'heatmap', source: 'fires', layout: { visibility: 'none' },
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'frp'], 0.5, 0.25, 300, 1.4],
          'heatmap-intensity': 0.7,
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 1, 12, 8, 38],
          'heatmap-opacity': 0.85,
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(5,10,20,0)', 0.2, '#1D4ED8', 0.4, '#0891B2', 0.55, '#FDE047', 0.75, '#F97316', 0.9, '#DC2626', 1, '#FECACA'],
        },
      });
      map.addLayer({
        id: 'fires-glow', type: 'circle', source: 'fires',
        paint: { 'circle-color': colorExpr('intensity'), 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4.5, ['+', 2.4, ['*', 1.3, ['sqrt', ['get', 'frp']]]], 8, ['+', 8, ['*', 6, ['sqrt', ['get', 'frp']]]]], 'circle-blur': 1.1, 'circle-opacity': 0.4 },
      });
      map.addLayer({
        id: 'fires-core', type: 'circle', source: 'fires',
        // compact until ~z6 (no red blob at AOI zoom), then grow to full spread;
        // the 2.1px+ floor keeps EVERY dot visible at world view
        paint: { 'circle-color': FRP_EXPR, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4.5, ['+', 2.1, ['*', 0.8, ['sqrt', ['get', 'frp']]]], 8, ['+', 4.2, ['*', 3.6, ['sqrt', ['get', 'frp']]]]], 'circle-stroke-width': 0.7, 'circle-stroke-color': 'rgba(255,255,255,0.6)' },
      });
      map.addLayer({
        id: 'fires-hot', type: 'circle', source: 'fires', filter: ['>=', ['get', 'frp'], 150],
        paint: { 'circle-color': '#FFFFFF', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4.5, 1.8, 8, 5.4], 'circle-opacity': 0.95 },
      });
      // popups
      map.on('click', 'fires-core', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return;
        const p = f.properties as Record<string, string | number>;
        const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
        const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px' }).setLngLat(e.lngLat).setHTML(
          detectionPopupHTML({ sensor: String(p.sensor), sat: p.sat ? String(p.sat) : undefined, frp: Number(p.frp), conf: Number(p.conf), acq: p.acq ? String(p.acq) : undefined, night: p.night === 'N', lat: coords[0], lon: coords[1] }, { regionKey, day: displayDay }),
        ).addTo(map);
        wireHotspotAI(popup.getElement(), askRef.current);
      });
      map.on('mouseenter', 'fires-core', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'fires-core', () => { map.getCanvas().style.cursor = pickRef.current ? 'crosshair' : ''; });
    }
    // style mode updates
    const colorForMode = colorExpr(styleMode);
    map.setPaintProperty('fires-glow', 'circle-color', colorExpr('intensity'));
    map.setPaintProperty('fires-core', 'circle-color', colorForMode);
    map.setLayoutProperty('fires-heat', 'visibility', styleMode === 'heatmap' ? 'visible' : 'none');
    map.setLayoutProperty('fires-glow', 'visibility', styleMode === 'heatmap' ? 'none' : 'visible');
    map.setLayoutProperty('fires-core', 'visibility', styleMode === 'heatmap' ? 'none' : 'visible');
    map.setLayoutProperty('fires-hot', 'visibility', styleMode === 'heatmap' ? 'none' : 'visible');
    const visList = Object.keys(visible).filter((k) => visible[k]);
    const filter = ['in', ['get', 'sensor'], ['literal', visList]] as unknown as maplibregl.FilterSpecification;
    ['fires-heat', 'fires-glow', 'fires-core', 'fires-hot'].forEach((l) => map.setFilter(l, filter));
  }, [displayData, ready, styleMode, visible, displayDay, regionKey]);

  // ---- EXTREME pulse halos (GL renderer) ----
  // The strongest detections (threat score ≥ 80) get a CSS-animated expanding
  // ring via maplibregl.Marker DOM elements — compositor animation, no GPU
  // work in the GL pipeline, so the eye lands on the worst fires instantly.
  const pulsesRef = useRef<maplibregl.Marker[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || gpuBlocked) return;
    for (const m of pulsesRef.current) m.remove();
    pulsesRef.current = [];
    if (!displayData) return;
    const extreme: Array<{ lat: number; lon: number }> = [];
    for (const [k, s] of Object.entries(displayData.sensors)) {
      if (!visible[k]) continue;
      for (const p of s.points) {
        if (threatBadge(p.frp || 0, typeof p.conf === 'number' ? p.conf : 60, p.night).score >= 80) extreme.push({ lat: p.lat, lon: p.lon });
      }
    }
    for (const e of extreme.slice(0, 24)) {
      const el = document.createElement('div');
      el.className = 'ignis-pulse-wrap';
      el.style.pointerEvents = 'none';
      el.innerHTML = '<span class="ignis-pulse"></span>';
      try {
        pulsesRef.current.push(new maplibregl.Marker({ element: el }).setLngLat([e.lon, e.lat]).addTo(map));
      } catch { /* map tearing down */ }
    }
    return () => {
      for (const m of pulsesRef.current) m.remove();
      pulsesRef.current = [];
    };
  }, [displayData, visible, ready, gpuBlocked, displayDay]);

  // ---- 3D fire towers on the map (GL renderer — maplibre fill-extrusion) ----
  // The WebGL sibling of the GPU-free FireField3D panel: the same hexbin
  // aggregation extruded ON the map itself — height = detections, color = mean
  // FRP. Free MapLibre capability, no extra keys, real 3D analysis over real
  // terrain; click a tower for the threat badge + inline AI verdict.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || gpuBlocked) return;
    if (!show3DTowers || !displayData) {
      for (const l of ['hex3d-fill', 'hex3d-line']) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource('hex3d')) map.removeSource('hex3d');
      return;
    }
    const pts = Object.entries(displayData.sensors).flatMap(([sensor, s]) => (visible[sensor] ? s.points : []));
    const { bin, maxN, features } = hexbin(pts, bbox);
    if (!features.length) return;
    const fc = {
      type: 'FeatureCollection' as const,
      features: features.map((g) => ({
        type: 'Feature' as const,
        properties: { n: g.n, frp: Math.round(g.frp), mf: Math.round(g.frp / Math.max(1, g.n)), t: g.n / Math.max(1, maxN) },
        geometry: { type: 'Polygon' as const, coordinates: [[[g.lon - bin / 2, g.lat - bin / 2], [g.lon + bin / 2, g.lat - bin / 2], [g.lon + bin / 2, g.lat + bin / 2], [g.lon - bin / 2, g.lat + bin / 2], [g.lon - bin / 2, g.lat - bin / 2]]] },
      })),
    };
    if (map.getSource('hex3d')) (map.getSource('hex3d') as maplibregl.GeoJSONSource).setData(fc);
    else {
      map.addSource('hex3d', { type: 'geojson', data: fc });
      map.addLayer({
        id: 'hex3d-fill', type: 'fill-extrusion', source: 'hex3d',
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'mf'], 0, '#FDE68A', 25, '#FB923C', 120, '#EF4444', 300, '#7F1D1D'],
          'fill-extrusion-height': ['interpolate', ['linear'], ['get', 't'], 0, 400, 1, 5200],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.62,
          'fill-extrusion-vertical-gradient': true,
        },
      });
      map.addLayer({ id: 'hex3d-line', type: 'line', source: 'hex3d', paint: { 'line-color': 'rgba(254,215,170,0.35)', 'line-width': 0.6 } });
      map.on('click', 'hex3d-fill', (e) => {
        if (map.getLayer('fires-core') && map.queryRenderedFeatures(e.point, { layers: ['fires-core'] }).length) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, number>;
        const popup = new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(
          hexPopupHTML({ lat: e.lngLat.lat, lon: e.lngLat.lng, n: p.n, frp: p.frp, bin }, { regionKey, day: displayDay }),
        ).addTo(map);
        wireHotspotAI(popup.getElement(), askRef.current);
      });
    }
  }, [show3DTowers, displayData, visible, bbox, ready, gpuBlocked, displayDay, regionKey]);

  // ---- hexbin ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!displayData) return;
    const pts = Object.entries(displayData.sensors).flatMap(([sensor, s]) => (visible[sensor] ? s.points : []));
    const { bin, maxN, features } = hexbin(pts, bbox);
    const fc = {
      type: 'FeatureCollection' as const,
      features: features.map((g) => ({
        type: 'Feature' as const,
        properties: { n: g.n, frp: Math.round(g.frp), t: g.n / maxN },
        geometry: { type: 'Polygon' as const, coordinates: [[[g.lon - bin / 2, g.lat - bin / 2], [g.lon + bin / 2, g.lat - bin / 2], [g.lon + bin / 2, g.lat + bin / 2], [g.lon - bin / 2, g.lat + bin / 2], [g.lon - bin / 2, g.lat - bin / 2]]] },
      })),
    };
    if (map.getSource('hex')) (map.getSource('hex') as maplibregl.GeoJSONSource).setData(fc);
    else {
      map.addSource('hex', { type: 'geojson', data: fc });
      map.addLayer({
        id: 'hex-fill', type: 'fill', source: 'hex', layout: { visibility: 'none' },
        paint: { 'fill-color': ['interpolate', ['linear'], ['get', 't'], 0, 'rgba(253,224,71,0.25)', 0.4, 'rgba(249,115,22,0.45)', 1, 'rgba(185,28,28,0.65)'] },
      });
      map.addLayer({
        id: 'hex-line', type: 'line', source: 'hex', layout: { visibility: 'none' },
        paint: { 'line-color': 'rgba(251,146,60,0.35)', 'line-width': 0.6 },
      });
      map.on('click', 'hex-fill', (e) => {
        // click-priority: if an individual fire detection sits under the pointer,
        // the per-hotspot popup (fires-core handler) owns this click — skip.
        if (map.getLayer('fires-core') && map.queryRenderedFeatures(e.point, { layers: ['fires-core'] }).length) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, number>;
        const popup = new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(
          hexPopupHTML({ lat: e.lngLat.lat, lon: e.lngLat.lng, n: p.n, frp: p.frp, bin }, { regionKey, day: displayDay }),
        ).addTo(map);
        wireHotspotAI(popup.getElement(), askRef.current);
      });
    }
    map.setLayoutProperty('hex-fill', 'visibility', showHex ? 'visible' : 'none');
    map.setLayoutProperty('hex-line', 'visibility', showHex ? 'visible' : 'none');
  }, [displayData, showHex, bbox, ready, visible]);

  // ---- fire segmentation + boundary identification ----
  // Deterministic in-browser DBSCAN -> convex-hull perimeters, computed once in page.tsx
  // and shared with the Fire Cluster Lab panel. Renders ORGANIZED fire objects
  // (megafire / established / emerging / scattered) with class-styled boundaries so the
  // map reads like an incident map instead of a point cloud.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!showSeg || !seg || !seg.clusters.length) {
      for (const l of ['seg-fill', 'seg-line', 'seg-core']) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource('seg')) map.removeSource('seg');
      return;
    }
    const fc = clustersToGeoJSON(seg.clusters) as unknown as maplibregl.GeoJSONSourceSpecification['data'];
    if (map.getSource('seg')) (map.getSource('seg') as maplibregl.GeoJSONSource).setData(fc);
    else {
      map.addSource('seg', { type: 'geojson', data: fc });
      map.addLayer({
        id: 'seg-fill', type: 'fill', source: 'seg',
        paint: { 'fill-color': ['match', ['get', 'cls'], ...Object.entries(CLASS_STYLE).flatMap(([k, v]) => [k, v.fill]), 'rgba(148,163,184,0.08)'] as unknown as maplibregl.ExpressionSpecification, 'fill-opacity': 1 },
      });
      map.addLayer({
        id: 'seg-line', type: 'line', source: 'seg',
        paint: {
          'line-color': ['match', ['get', 'cls'], ...Object.entries(CLASS_STYLE).flatMap(([k, v]) => [k, v.stroke]), '#94A3B8'] as unknown as maplibregl.ExpressionSpecification,
          'line-width': ['match', ['get', 'cls'], ...Object.entries(CLASS_STYLE).flatMap(([k, v]) => [k, v.width]), 1] as unknown as maplibregl.ExpressionSpecification,
        },
      });
      map.addLayer({
        id: 'seg-core', type: 'circle', source: 'seg',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['+', 2.2, ['*', 0.9, ['sqrt', ['get', 'n']]]], 8, ['+', 5, ['*', 2.0, ['sqrt', ['get', 'n']]]]],
          'circle-color': 'rgba(255,255,255,0.85)', 'circle-stroke-color': '#1C1917', 'circle-stroke-width': 1,
          'circle-opacity': 0.9,
        },
      });
      map.on('click', 'seg-fill', (ev) => {
        // click-priority: a click that lands on an individual fire detection
        // inside the hull belongs to the per-hotspot AI popup (fires-core
        // handler) — the cluster popup stays reachable on hull areas / centroid
        // where no single detection sits.
        if (map.getLayer('fires-core') && map.queryRenderedFeatures(ev.point, { layers: ['fires-core'] }).length) return;
        const f = ev.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, string | number>;
        const popup = new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(ev.lngLat).setHTML(
          clusterPopupHTML({
            id: p.id, cls: String(p.cls), n: Number(p.n), frpSum: Number(p.frp), meanFrp: Number(p.meanFrp),
            spreadKm: Number(p.spreadKm), areaKm2: Number(p.areaKm2), elongation: Number(p.elongation),
            nightPct: Number(p.nightPct), sensors: String(p.sensors),
            modelCls: p.modelCls !== undefined ? String(p.modelCls) : undefined,
            modelClsPct: p.modelClsPct !== undefined ? Number(p.modelClsPct) : undefined,
          } as ClusterCtx, { regionKey, day: displayDay }),
        ).addTo(map);
        wireHotspotAI(popup.getElement(), askRef.current);
      });
      map.on('mouseenter', 'seg-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'seg-fill', () => { map.getCanvas().style.cursor = pickRef.current ? 'crosshair' : ''; });
    }
  }, [seg, showSeg, ready]);

  // ---------- ML next-day footprint forecast overlay (ignis-fire-footprint-forecaster) ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!forecast || !forecast.cells.length) {
      for (const l of ['fc-line', 'fc-fill']) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource('ignis-forecast')) map.removeSource('ignis-forecast');
      return;
    }
    const half = forecast.cellDeg / 2;
    const fc = {
      type: 'FeatureCollection' as const,
      features: forecast.cells.map((c) => ({
        type: 'Feature' as const,
        properties: { p: c.p },
        geometry: { type: 'Polygon' as const, coordinates: [[[c.lon - half, c.lat - half], [c.lon + half, c.lat - half], [c.lon + half, c.lat + half], [c.lon - half, c.lat + half], [c.lon - half, c.lat - half]]] },
      })),
    };
    if (map.getSource('ignis-forecast')) (map.getSource('ignis-forecast') as maplibregl.GeoJSONSource).setData(fc as unknown as GeoJSON.FeatureCollection);
    else {
      map.addSource('ignis-forecast', { type: 'geojson', data: fc as unknown as maplibregl.GeoJSONSourceSpecification['data'] });
      // insert UNDER the segmentation hulls so real boundaries stay readable
      const before = map.getLayer('seg-fill') ? 'seg-fill' : map.getLayer('fires-glow') ? 'fires-glow' : undefined;
      map.addLayer({
        id: 'fc-fill', type: 'fill', source: 'ignis-forecast',
        paint: {
          'fill-color': ['interpolate', ['linear'], ['get', 'p'], 0.5, '#FDE047', 0.7, '#FB923C', 0.85, '#EF4444', 1, '#B91C1C'] as unknown as maplibregl.ExpressionSpecification,
          'fill-opacity': ['interpolate', ['linear'], ['get', 'p'], 0.5, 0.06, 0.7, 0.16, 0.85, 0.34, 1, 0.55] as unknown as maplibregl.ExpressionSpecification,
        },
      }, before);
      map.addLayer({
        id: 'fc-line', type: 'line', source: 'ignis-forecast',
        paint: { 'line-color': 'rgba(254,215,170,0.55)', 'line-width': 0.6 },
      }, before);
    }
  }, [forecast, ready]);

  // ---- AOI interactions: click-pick + shift-drag ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let start: maplibregl.LngLat | null = null;
    let box: HTMLDivElement | null = null;

    const down = (e: maplibregl.MapMouseEvent) => {
      if (!e.originalEvent.shiftKey || pickRef.current) return;
      start = e.lngLat;
      map.dragPan.disable();
      box = document.createElement('div');
      box.style.cssText = 'position:absolute;border:1.5px dashed #38BDF8;background:rgba(56,189,248,0.08);pointer-events:none;z-index:20';
      map.getContainer().appendChild(box);
    };
    const move = (e: maplibregl.MapMouseEvent) => {
      if (!start || !box) return;
      const minX = Math.min(start.lng, e.lngLat.lng), maxX = Math.max(start.lng, e.lngLat.lng);
      const minY = Math.min(start.lat, e.lngLat.lat), maxY = Math.max(start.lat, e.lngLat.lat);
      const p1 = map.project([minX, maxY]), p2 = map.project([maxX, minY]);
      box.style.left = `${p1.x}px`; box.style.top = `${p1.y}px`;
      box.style.width = `${p2.x - p1.x}px`; box.style.height = `${p2.y - p1.y}px`;
      (box as unknown as { _bbox: number[] })._bbox = [minX, minY, maxX, maxY];
    };
    const up = () => {
      if (!start || !box) return;
      const b = (box as unknown as { _bbox?: number[] })._bbox;
      box.remove(); box = null;
      map.dragPan.enable();
      start = null;
      if (b && Math.abs(b[2] - b[0]) > 0.5 && Math.abs(b[3] - b[1]) > 0.5) onPickRef.current(b.map((v) => +v.toFixed(2)));
    };
    map.on('mousedown', down);
    map.on('mousemove', move);
    map.on('mouseup', up);

    const click = (e: maplibregl.MapMouseEvent) => {
      if (!pickRef.current) return;
      const { lng, lat } = e.lngLat;
      onPickRef.current([+(lng - 2.25).toFixed(2), +(lat - 2).toFixed(2), +(lng + 2.25).toFixed(2), +(lat + 2).toFixed(2)]);
    };
    map.on('click', click);

    map.on('click', 'eonet-ring', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string>;
      new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(
        `<div style="font:12px/1.5 ui-sans-serif"><div style="font-weight:700;color:#7DD3FC">🌐 EONET wildfire event</div><div>${p.title}</div><div style="color:#94A3B8">${p.date?.slice(0, 10)}</div><a href="${p.link}" target="_blank" rel="noreferrer" style="color:#38BDF8">NASA EONET details →</a></div>`,
      ).addTo(map);
    });

    return () => { map.off('mousedown', down); map.off('mousemove', move); map.off('mouseup', up); map.off('click', click); };
  }, [ready]);

  // ---- animation playback ----
  useEffect(() => {
    if (!playing || !dayKeys.length) return;
    const idx = animDay ? dayKeys.indexOf(animDay) : -1;
    const t = setTimeout(() => {
      const next = dayKeys[(idx + 1) % dayKeys.length];
      setAnimDay(next);
      setHudDay(next);
    }, speed);
    return () => clearTimeout(t);
  }, [playing, animDay, dayKeys, speed]);

  // reset animation when the selected day changes (React "adjust state during render" pattern)
  const [prevDay, setPrevDay] = useState(day);
  if (prevDay !== day) {
    setPrevDay(day);
    setHudDay(day);
    setAnimDay(null);
    setPlaying(false);
  }

  const stats = useMemo(() => {
    if (!displayData) return null;
    let count = 0, frpSum = 0, hi = 0, night = 0, maxFrp = 0;
    for (const [k, s] of Object.entries(displayData.sensors)) {
      if (!visible[k]) continue;
      count += s.count; frpSum += s.points.reduce((a, p) => a + (p.frp || 0), 0);
      hi += s.hiConf; night += Math.round((s.nightPct / 100) * s.count);
      maxFrp = Math.max(maxFrp, s.maxFrp);
    }
    return { count, meanFrp: count ? frpSum / count : 0, hiPct: count ? (hi / count) * 100 : 0, nightPct: count ? (night / count) * 100 : 0, maxFrp };
  }, [displayData, visible]);

  const perSensor = useMemo(() => {
    const m: Record<string, number> = {};
    if (displayData) for (const [k, s] of Object.entries(displayData.sensors)) m[k] = s.count;
    return m;
  }, [displayData]);

  // per-hotspot early-warning rollup (client heuristic — zero network)
  const threat = useMemo(() => {
    if (!displayData) return { hi: 0, ext: 0 };
    let hi = 0, ext = 0;
    for (const [k, s] of Object.entries(displayData.sensors)) {
      if (!visible[k]) continue;
      for (const p of s.points) {
        const sc = threatBadge(p.frp || 0, typeof p.conf === 'number' ? p.conf : 60, p.night).score;
        if (sc >= 80) ext += 1;
        else if (sc >= 62) hi += 1;
      }
    }
    return { hi, ext };
  }, [displayData, visible]);

  const playIdx = animDay ? Math.max(0, dayKeys.indexOf(animDay)) : 0;

  const bm = GIBS_BASEMAPS[basemapKey];

  return (
    <div className={`overflow-hidden ${focus ? 'fixed inset-0 z-[70] rounded-none border-0 bg-[#050A14]' : 'relative h-full w-full rounded-xl border border-[#14273F]'}`}>
      {/* shared pulse-halo CSS — EXTREME hotspots breathe on both renderers */}
      <style>{`
        .ignis-pulse-wrap { position: relative; display: block; width: 30px; height: 30px; margin: -15px 0 0 -15px; }
        .ignis-pulse { display: block; width: 100%; height: 100%; border-radius: 9999px; border: 2px solid rgba(248,113,113,0.85); background: rgba(239,68,68,0.12); box-shadow: 0 0 14px rgba(239,68,68,0.65), inset 0 0 8px rgba(239,68,68,0.35); animation: ignis-pulse 1.9s ease-out infinite; }
        @keyframes ignis-pulse { 0% { transform: scale(0.32); opacity: 1; } 72% { transform: scale(1.12); opacity: 0; } 100% { transform: scale(1.12); opacity: 0; } }
      `}</style>
      {gpuBlocked ? (
        <LeafletFireMap
          bbox={bbox}
          regionKey={regionKey}
          day={displayDay}
          displayData={displayData}
          visible={visible}
          styleMode={styleMode}
          basemapKey={basemapKey}
          overlays={overlays}
          showHex={showHex}
          showSeg={showSeg}
          seg={seg}
          forecast={forecast}
          eonet={eonet}
          pickMode={pickMode}
          onPick={onPick}
          onAskAi={onAskAi}
          flyTarget={flyTarget}
          resizeNonce={resizeNonce}
        />
      ) : (
        <div ref={containerRef} className={`h-full w-full ${pickMode ? 'cursor-crosshair' : ''}`} />
      )}

      {/* Top-left HUD — compact by default (map visibility first); click to expand the full telemetry */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[300px] flex-col gap-1.5 rounded-lg border border-[#14273F] bg-[#050A14]/88 text-[11px] leading-4 text-slate-300 backdrop-blur">
        <button onClick={() => setHudOpen((o) => !o)}
          aria-expanded={hudOpen}
          className="pointer-events-auto flex items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-[#0C1A2E]/60"
          title={hudOpen ? 'Collapse detection telemetry' : 'Expand detection telemetry'}>
          <span className="font-mono text-[15px] font-bold leading-none text-orange-300">{stats ? stats.count.toLocaleString() : '—'}</span>
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${displayData?.source === 'firms-api' ? 'bg-emerald-900/70 text-emerald-300' : displayData?.source === 'mixed' ? 'bg-amber-900/70 text-amber-300' : 'bg-sky-900/70 text-sky-300'}`}>
            {displayData?.source === 'firms-api' ? 'FIRMS LIVE' : displayData?.source === 'mixed' ? 'FIRMS+GIBS' : 'GIBS MVT'}
          </span>
          {threat.ext + threat.hi > 0 && (
            <span className="rounded bg-rose-950/70 px-1.5 py-0.5 text-[9px] font-bold text-rose-300">⚠ {threat.ext + threat.hi}</span>
          )}
          <span className="ml-auto pl-1 text-[9px] text-slate-500">{hudOpen ? '▴' : `▾ ${hudDay}`}</span>
        </button>
        {hudOpen && (
          <div className="flex flex-col gap-1.5 px-3 pb-2.5">
            <div className="text-[10px] text-slate-400"><b className="text-slate-200">{hudDay}</b> · active fire detections{stats ? ` · max FRP ${stats.maxFrp.toFixed(0)} MW` : ''}</div>
            {stats && (
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-slate-400">
                <span>mean FRP <b className="text-slate-200">{stats.meanFrp.toFixed(1)} MW</b></span>
                <span>max FRP <b className="text-slate-200">{stats.maxFrp.toFixed(0)} MW</b></span>
                <span>hi-conf <b className="text-slate-200">{stats.hiPct.toFixed(0)}%</b></span>
                <span>night <b className="text-slate-200">{stats.nightPct.toFixed(0)}%</b></span>
              </div>
            )}
            {threat.ext + threat.hi > 0 && (
              <div className="rounded bg-rose-950/60 px-1.5 py-0.5 text-[9.5px] font-semibold text-rose-200">
                ⚠ live threat rollup: {threat.ext} EXTREME · {threat.hi} high-threat hotspot{threat.hi === 1 ? '' : 's'}
              </div>
            )}
            <div className="flex flex-wrap gap-1 pt-0.5">
              {Object.keys(SENSOR_COLORS).map((k) => (
                <button key={k} onClick={() => setVisible((v) => ({ ...v, [k]: !v[k] }))}
                  title={`${k}: ${perSensor[k]?.toLocaleString() ?? 0} detections`}
                  className={`pointer-events-auto flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] transition-opacity ${visible[k] ? 'border-[#1E3A5F]' : 'border-[#1E3A5F] opacity-35'}`}>
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SENSOR_COLORS[k] }} />{k.replace('VIIRS-', 'V-')}{perSensor[k] ? <b className="font-mono text-[8.5px] text-slate-400">{perSensor[k] > 999 ? `${(perSensor[k] / 1000).toFixed(1)}k` : perSensor[k]}</b> : null}
                </button>
              ))}
            </div>
            <div className="text-[9px] text-slate-500">renderer: {gpuBlocked ? 'Leaflet DOM · GPU-free' : 'MapLibre GL · WebGL2'}</div>
          </div>
        )}
      </div>

      {/* Right controls — shared by both renderers (MapLibre GL / Leaflet DOM) */}
      <div className="absolute right-3 top-16 z-10 flex flex-col items-end gap-1.5 text-[10.5px]">
        <select value={basemapKey} onChange={(e) => setBasemapKey(e.target.value)}
          className="rounded border border-[#1E3A5F] bg-[#050A14]/90 px-2 py-1.5 text-[10.5px] text-slate-200 backdrop-blur outline-none">
          {Object.entries(GIBS_BASEMAPS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <div className="flex overflow-hidden rounded border border-[#1E3A5F] bg-[#050A14]/90 backdrop-blur">
          {(['intensity', 'sensor', 'confidence', 'heatmap'] as StyleMode[]).map((m) => (
            <button key={m} onClick={() => setStyleMode(m)} className={`px-2 py-1.5 capitalize ${styleMode === m ? 'bg-[#38BDF8] text-slate-950 font-bold' : 'text-slate-400 hover:text-slate-200'}`}>{m}</button>
          ))}
        </div>
        {/* primary actions stay one tap away; everything else lives in the Layers popover */}
        <div className="flex items-center gap-1">
          <button onClick={() => setLayersOpen((o) => !o)}
            title="Overlays: GIBS imagery, fire pixels, hexbin, segmentation, ML forecast, 3D towers"
            className={`rounded border px-2 py-1.5 font-semibold backdrop-blur transition-colors ${layersOpen ? 'border-[#38BDF8] bg-[#38BDF8]/20 text-[#7DD3FC]' : 'border-[#1E3A5F] bg-[#050A14]/90 text-slate-300 hover:text-slate-100'}`}>
            🗺 Layers {layersOpen ? '▴' : '▾'}
          </button>
          <button onClick={() => setShow3D((s) => !s)}
            title="3D Fire Field — isometric extruded fire towers (GPU-free canvas, works everywhere); click a tower to fly + AI-assess"
            className={`rounded border px-2 py-1.5 backdrop-blur transition-colors ${show3D ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200' : 'border-[#1E3A5F] bg-[#050A14]/90 text-slate-300 hover:text-slate-100'}`}>
            🧊 3D
          </button>
          {!gpuBlocked && (
            <button onClick={() => setShowTerrainScene((t) => !t)}
              title="3D Terrain Scene — Three.js: real DEM elevation + NASA satellite drape + precision fire columns (WebGL renderer)"
              className={`rounded border px-2 py-1.5 font-semibold backdrop-blur transition-colors ${showTerrainScene ? 'border-orange-400 bg-orange-500/20 text-orange-200' : 'border-[#1E3A5F] bg-[#050A14]/90 text-slate-300 hover:text-slate-100'}`}>
              🌍 3D
            </button>
          )}
          {!gpuBlocked && (
            <button onClick={() => setTerrain3D((t) => !t)}
              title="3D terrain — AWS Terrarium DEM elevation + hillshade relief (WebGL renderer only)"
              className={`rounded border px-2 py-1.5 backdrop-blur transition-colors ${terrain3D ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200' : 'border-[#1E3A5F] bg-[#050A14]/90 text-slate-300 hover:text-slate-100'}`}>
              ⛰
            </button>
          )}
          <button onClick={() => { setFocus((f) => !f); setResizeNonce((n) => n + 1); }}
            title={focus ? 'Exit fullscreen map (Esc)' : 'Fullscreen map — maximize the view (Esc exits)'}
            className="rounded border border-[#1E3A5F] bg-[#050A14]/90 px-2 py-1.5 text-slate-300 backdrop-blur transition-colors hover:text-slate-100">
            {focus ? '⤡' : '⛶'}
          </button>
        </div>
        {layersOpen && (
          <div className="w-52 rounded-lg border border-[#1E3A5F] bg-[#050A14]/95 p-2 shadow-2xl backdrop-blur">
            <div className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">GIBS imagery</div>
            <div className="flex flex-wrap gap-1">
              {Object.entries(GIBS_OVERLAYS).map(([k, v]) => (
                <button key={k} onClick={() => setOverlays((o) => ({ ...o, [k]: !o[k] }))}
                  title={v.note}
                  className={`rounded border px-1.5 py-1 transition-colors ${overlays[k] ? 'border-[#38BDF8] bg-[#38BDF8]/20 text-[#7DD3FC]' : 'border-[#1E3A5F] text-slate-400'}`}>
                  {v.label.split('(')[0].trim()}
                </button>
              ))}
              <button onClick={() => setOverlays((o) => ({ ...o, gibsfires: !o.gibsfires }))}
                title="GIBS WMTS vector fire pixels — independent cross-check of the FIRMS NRT pipeline"
                className={`rounded border px-1.5 py-1 transition-colors ${overlays.gibsfires ? 'border-[#F87171] bg-[#EF4444]/20 text-[#FCA5A5]' : 'border-[#1E3A5F] text-slate-400'}`}>
                GIBS fire pixels
              </button>
            </div>
            <div className="mb-1 mt-2 text-[9px] font-bold uppercase tracking-widest text-slate-500">Analysis layers</div>
            <div className="flex flex-wrap gap-1">
              <button onClick={() => setShowHex((h) => !h)}
                className={`rounded border px-1.5 py-1 transition-colors ${showHex ? 'border-[#38BDF8] bg-[#38BDF8]/20 text-[#7DD3FC]' : 'border-[#1E3A5F] text-slate-400'}`}>
                Hexbin density
              </button>
              <button onClick={() => setShowSeg((s) => !s)}
                title="DBSCAN segmentation + convex-hull fire boundaries — organized fire objects from raw hotspots"
                className={`rounded border px-1.5 py-1 transition-colors ${showSeg ? 'border-orange-400 bg-orange-500/20 text-orange-200' : 'border-[#1E3A5F] text-slate-400'}`}>
                🔲 Segmentation
              </button>
              <button onClick={() => onToggleForecast?.()}
                title="ignis-fire-footprint-forecaster — predicted next-day fire-complex footprint (0.05° probability field)"
                className={`rounded border px-1.5 py-1 transition-colors ${(forecast || forecastLoading) ? 'border-violet-400 bg-violet-500/20 text-violet-200' : 'border-[#1E3A5F] text-slate-400'}`}>
                {forecastLoading ? '🔮 computing…' : '🔮 ML forecast'}
              </button>
              {!gpuBlocked && (
                <button onClick={() => setShow3DTowers((s) => !s)}
                  title="3D fire towers extruded on the map — height = detections, color = mean FRP (WebGL renderer)"
                  className={`rounded border px-1.5 py-1 transition-colors ${show3DTowers ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200' : 'border-[#1E3A5F] text-slate-400'}`}>
                  🏙 3D towers on map
                </button>
              )}
            </div>
          </div>
        )}
        {dayKeys.length > 1 && (
          <div className="pointer-events-none w-44 rounded border border-[#14273F] bg-[#050A14]/85 px-2 py-1.5 backdrop-blur">
            <button onClick={() => setPlaying((p) => !p)}
              className={`pointer-events-auto mb-1 w-full rounded border px-2.5 py-1.5 font-bold ${playing ? 'border-orange-400 bg-orange-500/20 text-orange-300' : 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#7DD3FC]'}`}>
              {playing ? '❚❚ Pause replay' : `▶ Replay ${dayKeys.length} days`}
            </button>
            <div className="h-1 w-full overflow-hidden rounded bg-[#0F1D31]">
              <div className="h-1 rounded bg-orange-400 transition-all" style={{ width: `${((playIdx + 1) / dayKeys.length) * 100}%` }} />
            </div>
            <div className="mt-0.5 flex items-center justify-between text-[9px] text-slate-500">
              <span>{playIdx + 1}/{dayKeys.length} · {animDay ?? day}</span>
              <button onClick={() => setSpeed((sp) => (sp === 1600 ? 900 : sp === 900 ? 450 : 1600))}
                className="pointer-events-auto rounded px-1 text-[#7DD3FC] hover:bg-[#0F1D31]" title="replay speed">
                {(speed / 1000).toFixed(speed % 1000 !== 0 ? 1 : 0)}s/day
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Legend — collapsed to a one-tap chip by default (map visibility first) */}
      {legendOpen ? (
      <div className={`pointer-events-none absolute left-3 z-10 rounded-lg border border-[#14273F] bg-[#050A14]/88 px-3 py-2 text-[10px] text-slate-300 backdrop-blur ${gpuBlocked ? 'bottom-24' : 'bottom-10'}`}>
        {styleMode === 'heatmap' ? (
          <>
            <div className="mb-1 font-semibold text-slate-200">Detection density (FRP-weighted)</div>
            <div className="h-2 w-40 rounded" style={{ backgroundImage: 'linear-gradient(90deg,#1D4ED8,#0891B2,#FDE047,#F97316,#DC2626,#FECACA)' }} />
            <div className="mt-0.5 flex w-40 justify-between text-[9px] text-slate-500"><span>sparse</span><span>dense</span></div>
          </>
        ) : styleMode === 'sensor' ? (
          <>
            <div className="mb-1 font-semibold text-slate-200">Sensor · size = FRP</div>
            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
              {Object.entries(SENSOR_COLORS).map(([k, c]) => (
                <span key={k} className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c }} />{k}</span>
              ))}
            </div>
          </>
        ) : styleMode === 'confidence' ? (
          <>
            <div className="mb-1 font-semibold text-slate-200">Detection confidence</div>
            <div className="h-2 w-40 rounded" style={{ backgroundImage: CONF_GRADIENT }} />
            <div className="mt-0.5 flex w-40 justify-between text-[9px] text-slate-500"><span>0 (VIIRS low ≈30)</span><span>90+</span></div>
          </>
        ) : (
          <>
            <div className="mb-1 font-semibold text-slate-200">Fire radiative power (MW)</div>
            <div className="h-2 w-40 rounded" style={{ backgroundImage: FRP_GRADIENT }} />
            <div className="mt-0.5 flex w-40 justify-between text-[9px] text-slate-500"><span>0</span><span>25</span><span>120</span><span>500+</span></div>
            <div className="mt-1 text-[9px] text-slate-500">white core = FRP ≥ 150 MW · radius ∝ √FRP</div>
          </>
        )}
        {(overlays.lst_day || overlays.lst_night) && (
          <>
            <div className="mb-1 mt-2 font-semibold text-slate-200">Land surface temperature (MOD11, °C)</div>
            <div className="h-2 w-40 rounded" style={{ backgroundImage: `linear-gradient(90deg,${LST_RAMP.map(([, c]) => c).join(',')})` }} />
            <div className="mt-0.5 flex w-40 justify-between text-[9px] text-slate-500"><span>-25°</span><span>0°</span><span>25°</span><span>50°+</span></div>
            <div className="mt-1 text-[9px] text-slate-500">LP DAAC MOD11: K = raw × 0.02 · ε = raw × 0.02 + 0.49 · fill = 0</div>
          </>
        )}
        {overlays.gibsfires && (
          <div className="mt-1 flex items-center gap-1 text-[9px] text-slate-500">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: '#FCA5A5' }} />
            GIBS fire pixels = independent cross-check of FIRMS
          </div>
        )}
        {showSeg && seg && seg.clusters.length > 0 && (
          <>
            <div className="mb-1 mt-2 font-semibold text-slate-200">Fire segmentation · {seg.clusters.length} clusters</div>
            {(['MEGAFIRE', 'ESTABLISHED', 'EMERGING', 'SCATTERED'] as ClusterClass[]).map((c) => {
              const n = seg.clusters.filter((x) => x.cls === c).length;
              if (!n) return null;
              return (
                <div key={c} className="mt-0.5 flex items-center gap-1.5 text-[9px] text-slate-500">
                  <span className="inline-block h-2 w-2.5 rounded-sm" style={{ border: `1.5px solid ${CLASS_STYLE[c].stroke}`, background: CLASS_STYLE[c].fill }} />
                  {CLASS_STYLE[c].label} × {n}
                </div>
              );
            })}
            <div className="mt-1 text-[9px] text-slate-500">DBSCAN ε={seg.epsDeg}° · minPts {seg.minPts} · {seg.clusteredPct.toFixed(0)}% of points clustered · white dot = cluster core</div>
          </>
        )}
        {forecast && (
          <>
            <div className="mb-1 mt-2 font-semibold text-violet-200">🔮 Next-day risk field (ML) · {forecast.targetDay}</div>
            <div className="h-2 w-40 rounded" style={{ backgroundImage: 'linear-gradient(90deg,#FDE047,#FB923C,#EF4444,#B91C1C)' }} />
            <div className="mt-0.5 flex w-40 justify-between text-[9px] text-slate-500"><span>P=0.5</span><span>0.7</span><span>0.85</span><span>1.0</span></div>
            <div className="mt-1 text-[9px] leading-relaxed text-slate-500">
              relative probability envelope · {forecast.stats.predicted.toLocaleString()} cells (p≥0.5) · {forecast.stats.hiConfCells.toLocaleString()} high-confidence (p≥0.85) ·
              top-2k alignment {forecast.stats.topAlignedPct}% · {FORECASTER_META.name} {forecast.modelVersion} · {forecast.domain}
            </div>
          </>
        )}
        <div className="mt-1 text-[9px] text-slate-500">basemap: {bm.label}{bm.daily ? ` · ${displayDay}` : ''}</div>
      </div>
      ) : (
        <button onClick={() => setLegendOpen(true)} title="Show map legend"
          className={`pointer-events-auto absolute left-3 z-10 flex items-center gap-1.5 rounded-lg border border-[#14273F] bg-[#050A14]/88 px-2.5 py-1.5 text-[10px] font-semibold text-slate-300 backdrop-blur transition-colors hover:text-slate-100 ${gpuBlocked ? 'bottom-24' : 'bottom-10'}`}>
          <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundImage: FRP_GRADIENT }} />
          ⓘ Legend
        </button>
      )}

      {show3D && (
        <div className="absolute inset-x-3 bottom-3 z-20 flex justify-center">
          <div className={`w-full ${focus ? 'max-w-4xl' : 'max-w-2xl'}`}>
            <FireField3D
              bbox={bbox}
              day={displayDay}
              regionKey={regionKey}
              displayData={displayData}
              visible={visible}
              onFlyTo={flyToCell}
              onAskAi={onAskAi}
              onClose={() => setShow3D(false)}
            />
          </div>
        </div>
      )}
      {showTerrainScene && !gpuBlocked && (
        <TerrainScene3D
          bbox={bbox}
          day={displayDay}
          regionKey={regionKey}
          displayData={displayData}
          visible={visible}
          onAskAi={onAskAi}
          onFlyTo={flyToCell}
          onClose={() => setShowTerrainScene(false)}
        />
      )}
      {pickMode && (
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-cyan-500/40 bg-cyan-950/80 px-3 py-1.5 text-[11px] text-cyan-200 backdrop-blur">
          AOI pick mode — click anywhere to define a ±2° box (or hold Shift and drag to draw any rectangle)
        </div>
      )}
      {showHint && !pickMode && !focus && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded border border-[#14273F] bg-[#050A14]/70 px-2 py-1 text-[9.5px] text-slate-500 backdrop-blur">
          Shift + drag = custom AOI · click any fire for threat + AI
        </div>
      )}
      {gpuBlocked && !bannerOff && (
        <div className="absolute bottom-12 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg border border-amber-500/40 bg-[#1A1206]/92 px-2.5 py-1.5 text-[10px] text-amber-200 backdrop-blur">
          <span className="font-bold">🛡 GPU-free Leaflet renderer</span>
          <span className="hidden text-amber-100/70 sm:inline">full interactivity, no WebGL</span>
          <button
            onClick={retryInteractive}
            className="rounded border border-amber-400/60 bg-amber-500/15 px-1.5 py-0.5 font-bold text-amber-100 transition-colors hover:bg-amber-500/25"
          >
            ↻ WebGL
          </button>
          <button onClick={() => setBannerOff(true)} title="Dismiss" className="px-0.5 text-amber-200/60 hover:text-amber-100">✕</button>
        </div>
      )}
    </div>
  );
}
