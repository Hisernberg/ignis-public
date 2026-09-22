'use client';

// IGNIS 3D TERRAIN SCENE — a true WebGL 3D map built with Three.js (MIT) on
// free & open data only:
//   · NASA GIBS WMTS raster tiles (public domain)  → satellite imagery drape
//   · AWS/Mapzen Terrarium DEM (AWS Open Data)     → real elevation relief
//   · FIRMS NRT active-fire detections             → precision fire columns
//                                                    + additive glow field
// This is the WebGL-class "3D map version": drag = orbit, scroll = zoom,
// right-drag = pan, hover = live telemetry, click a fire column = the full AI
// event card (threat badge + auto-streaming verdict + Analyst deep-dive).
// Browsers with blocked GPUs keep the GPU-free FireField3D isometric view —
// MapPanel only mounts this scene when WebGL is available.

import { useEffect, useRef, useState } from 'react';
import type { HotspotsResult } from '@/lib/ignis/types';
import { detectionPopupHTML, wireHotspotAI, threatBadge } from '@/lib/ignis/hotspotAI';
import { GIBS_BASEMAPS, gibs3857Url } from '@/lib/ignis/regions';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type * as THREE_NS from 'three';

type Props = {
  bbox: number[];
  day: string;
  regionKey: string;
  displayData: HotspotsResult | null;
  visible: Record<string, boolean>;
  onAskAi: (q: string) => void;
  onFlyTo: (lat: number, lon: number) => void;
  onClose: () => void;
};

type FirePt = { sensor: string; frp: number; conf: number; sat: string; acq: string; night: boolean; lat: number; lon: number };

// same PROPER RED family as the 2D renderers — intensity = red depth
const FRP_RAMP: [number, string][] = [
  [0, '#FCA5A5'], [10, '#F87171'], [25, '#EF4444'], [60, '#DC2626'], [120, '#B91C1C'], [250, '#7F1D1D'], [500, '#450A0A'],
];

function rampColor(ramp: [number, string][], v: number): string {
  let c = ramp[0][1];
  for (const [t, col] of ramp) if (v >= t) c = col;
  return c;
}

// ---- Web-Mercator helpers (GIBS + Terrarium tiles are EPSG:3857) ----
const D2R = Math.PI / 180;
const mercN = (lat: number) => (1 - Math.log(Math.tan(lat * D2R) + 1 / Math.cos(lat * D2R)) / Math.PI) / 2;
const lon2tileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2tileY = (lat: number, z: number) => mercN(lat) * 2 ** z;

// free GIBS drape choices (no keys, public domain). "truecolor" composites
// multiple sensors with 'lighten' blending — MODIS Terra daily composites have
// orbit-swath gaps (black bands where the satellite did not image today);
// VIIRS S-NPP imaged those strips, so max-blending yields a gapless drape.
const IMAGERY: Record<string, { label: string; layers: string[] }> = {
  truecolor: { label: '🛰 True Color · gapless', layers: ['truecolor_modis_terra', 'truecolor_viirs_snpp'] },
  viirs: { label: '🛰 VIIRS sharp', layers: ['truecolor_viirs_snpp'] },
  bands721: { label: '🔥 7-2-1 fires', layers: ['bands721'] },
};

const FONT = 'font:11px/1.5 ui-sans-serif,system-ui';

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });
}

// one retry beat — transient GIBS 404/timeouts must not leave holes in the drape
function loadTile(url: string, tries = 3): Promise<HTMLImageElement | null> {
  return loadImage(url).then((img) =>
    img ? img : tries > 0 ? new Promise<HTMLImageElement | null>((r) => setTimeout(() => r(loadTile(url, tries - 1)), 500)) : Promise.resolve(null),
  );
}

// concurrency-limited loader — GIBS throttles bursts (24 parallel image
// requests get some tiles dropped); a small worker pool keeps every tile live
async function loadPool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const k = next++;
      out[k] = await jobs[k]();
    }
  });
  await Promise.all(workers);
  return out;
}

export default function TerrainScene3D({ bbox, day, regionKey, displayData, visible, onAskAi, onFlyTo, onClose }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [imageryKey, setImageryKey] = useState<'truecolor' | 'viirs' | 'bands721'>('truecolor');
  const [load, setLoad] = useState<{ done: number; total: number } | null>({ done: 0, total: 1 });
  const [err, setErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ n: number; frpSum: number; exagg: number; z: number } | null>(null);

  const visibleKey = Object.values(visible).map((v) => (v ? 1 : 0)).join('');

  // stable callback refs — inline closures from the parent must NOT retrigger
  // the (expensive) scene build on every MapPanel re-render
  const onAskRef = useRef(onAskAi);
  const onFlyRef = useRef(onFlyTo);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onAskRef.current = onAskAi; onFlyRef.current = onFlyTo; onCloseRef.current = onClose; });

  // Escape closes the scene — same contract as focus mode (stable listener;
  // the close action itself reads the ref so this never re-subscribes)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, []);

  // ---- the whole Three.js scene, rebuilt when the data / drape changes ----
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let cleanup: () => void = () => { /* noop */ };
    setLoad({ done: 0, total: 1 });
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps

    (async () => {
      // WebGL capability gate (belt & braces — MapPanel already probed)
      try {
        const probe = document.createElement('canvas');
        if (!probe.getContext('webgl2') && !probe.getContext('webgl')) {
          setErr('webgl');
          setLoad(null);
          return;
        }
      } catch { setErr('webgl'); setLoad(null); return; }

      let THREE: typeof THREE_NS;
      type OCtor = new (camera: THREE_NS.Camera, dom: HTMLElement) => OrbitControls;
      let OrbitControlsCtor: OCtor;
      try {
        THREE = await import('three');
        const oc = await import('three/examples/jsm/controls/OrbitControls.js');
        OrbitControlsCtor = oc.OrbitControls as unknown as OCtor;
      } catch {
        setErr('load');
        setLoad(null);
        return;
      }
      if (disposed || !mount) return;

      try {
        const [w, s, e, n] = bbox;
        const cLat = (n + s) / 2, cLon = (e + w) / 2;
        const kmLat = 110.574;
        const kmLon = 111.32 * Math.cos(cLat * D2R);
        const spanLon = Math.max(0.25, e - w), spanLat = Math.max(0.25, n - s);
        const widthKm = spanLon * kmLon;
        const depthKm = spanLat * kmLat;
        const maxDim = Math.max(widthKm, depthKm);
        const X = (lon: number) => (lon - cLon) * kmLon;
        const Z = (lat: number) => -(lat - cLat) * kmLat;

        // tile zoom: ~3 tiles across the AOI, clamped to free-friendly ranges
        const z = Math.max(4, Math.min(8, Math.round(Math.log2(1080 / Math.max(spanLon, spanLat)))));
        const x0 = Math.floor(lon2tileX(w, z)), x1 = Math.floor(lon2tileX(e, z));
        const y0 = Math.floor(lat2tileY(n, z)), y1 = Math.floor(lat2tileY(s, z));
        const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
        const tileTotal = cols * rows * (IMAGERY[imageryKey].layers.length + 1); // imagery layers + DEM

        // renderer
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(mount.clientWidth || 800, mount.clientHeight || 520);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.domElement.style.display = 'block';
        renderer.domElement.style.touchAction = 'none';
        mount.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#04070F');
        scene.fog = new THREE.Fog('#04070F', maxDim * 1.7, maxDim * 4.2);

        const camera = new THREE.PerspectiveCamera(52, (mount.clientWidth || 800) / (mount.clientHeight || 520), 0.1, maxDim * 10);
        camera.position.set(0, maxDim * 0.78, maxDim * 0.98);

        const controls = new OrbitControlsCtor(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.maxPolarAngle = (87 * Math.PI) / 180;
        controls.minDistance = maxDim * 0.05;
        controls.maxDistance = maxDim * 2.6;

        // lights
        scene.add(new THREE.HemisphereLight(0xcfe5ff, 0x140b06, 1.05));
        const sun = new THREE.DirectionalLight(0xfff1de, 1.7);
        sun.position.set(maxDim * 0.45, maxDim * 1.1, maxDim * 0.35);
        scene.add(sun);

        // subtle starfield dome — deep-space backdrop
        {
          const N = 420;
          const pos = new Float32Array(N * 3);
          for (let i = 0; i < N; i++) {
            const az = Math.random() * Math.PI * 2;
            const el = Math.random() * Math.PI * 0.48;
            const r = maxDim * 3.4;
            pos[i * 3] = Math.cos(az) * Math.cos(el) * r;
            pos[i * 3 + 1] = Math.sin(el) * r;
            pos[i * 3 + 2] = Math.sin(az) * Math.cos(el) * r;
          }
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fb6d1, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.65 })));
        }

        // load imagery + DEM tiles with bounded concurrency (pool per host)
        let done = 0;
        const bump = () => { done += 1; if (!disposed) setLoad({ done, total: tileTotal }); };
        const layers = IMAGERY[imageryKey].layers;
        const layerJobs: (() => Promise<HTMLImageElement | null>)[][] = layers.map(() => []);
        const demJobs: (() => Promise<HTMLImageElement | null>)[] = [];
        for (let ty = y0; ty <= y1; ty++) {
          for (let tx = x0; tx <= x1; tx++) {
            for (let li = 0; li < layers.length; li++) {
              const bm2 = GIBS_BASEMAPS[layers[li]];
              const imgUrl = gibs3857Url(bm2, day).replace('{z}', String(z)).replace('{y}', String(ty)).replace('{x}', String(tx));
              layerJobs[li].push(() => loadTile(imgUrl).then((i) => { bump(); return i; }));
            }
            const demUrl = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`;
            demJobs.push(() => loadTile(demUrl).then((i) => { bump(); return i; }));
          }
        }
        const [layerImgs, dems] = await Promise.all([Promise.all(layerJobs.map((j) => loadPool(j, 4))), loadPool(demJobs, 6)]);
        if (disposed) return;

        // mosaic canvases covering the tile range
        const TS = 256;
        // imagery mosaic — first sensor paints normally, extra sensors blend in
        // with 'lighten' so orbit-swath gaps in one sensor are filled by another
        const imgMosaic = document.createElement('canvas');
        imgMosaic.width = cols * TS; imgMosaic.height = rows * TS;
        const ictx = imgMosaic.getContext('2d')!;
        ictx.fillStyle = '#0A1526'; ictx.fillRect(0, 0, imgMosaic.width, imgMosaic.height);
        let imgOk = 0;
        for (let ty = y0; ty <= y1; ty++) {
          for (let tx = x0; tx <= x1; tx++) {
            const idx = (ty - y0) * cols + (tx - x0);
            let any = false;
            for (let li = 0; li < layerImgs.length; li++) {
              const im = layerImgs[li][idx];
              if (!im) continue;
              ictx.globalCompositeOperation = li === 0 ? 'source-over' : 'lighten';
              ictx.drawImage(im, (tx - x0) * TS, (ty - y0) * TS);
              any = true;
            }
            if (any) imgOk += 1;
          }
        }
        ictx.globalCompositeOperation = 'source-over';
        if (!imgOk) { setErr('tiles'); setLoad(null); return; }

        // crop exactly to the AOI in mercator pixel space
        const globe = 2 ** z * TS;
        const sx = lon2tileX(w, z) * TS - x0 * TS;
        const sy = lat2tileY(n, z) * TS - y0 * TS;
        const sw = Math.max(2, Math.round(((e - w) / 360) * globe));
        const sh = Math.max(2, Math.round((mercN(s) - mercN(n)) * globe));
        const crop = document.createElement('canvas');
        crop.width = sw; crop.height = sh;
        crop.getContext('2d')!.drawImage(imgMosaic, sx, sy, sw, sh, 0, 0, sw, sh);

        // DEM pixel store for bilinear elevation sampling
        let demCtx: CanvasRenderingContext2D | null = null;
        {
          const demMosaic = document.createElement('canvas');
          demMosaic.width = cols * TS; demMosaic.height = rows * TS;
          const dctx = demMosaic.getContext('2d', { willReadFrequently: true })!;
          dems.forEach((im, k) => { if (im) dctx.drawImage(im, (k % cols) * TS, Math.floor(k / cols) * TS); });
          try {
            demCtx = dctx;
            demCtx.getImageData(0, 0, 1, 1); // taint probe — CORS must allow pixel reads
          } catch { demCtx = null; }
        }
        const demPx = demCtx ? demCtx.getImageData(0, 0, cols * TS, rows * TS).data : null;
        const heightM = (lat: number, lon: number): number => {
          if (!demPx) return 0;
          const px = lon2tileX(lon, z) * TS - x0 * TS;
          const py = lat2tileY(lat, z) * TS - y0 * TS;
          const cx = Math.min(cols * TS - 2, Math.max(0, px));
          const cy = Math.min(rows * TS - 2, Math.max(0, py));
          const ix = Math.floor(cx), iy = Math.floor(cy);
          const at = (xx: number, yy: number) => {
            const o = (yy * cols * TS + xx) * 4;
            return demPx[o] * 256 + demPx[o + 1] + demPx[o + 2] / 256 - 32768;
          };
          const fx = cx - ix, fy = cy - iy;
          const h00 = at(ix, iy), h10 = at(ix + 1, iy), h01 = at(ix, iy + 1), h11 = at(ix + 1, iy + 1);
          // Terrarium includes bathymetry (ocean floor < 0) — sea-floor pixels
          // would plunge the plane tens of km down and render as black voids.
          // Fire analysis only needs land relief: clamp to sea level.
          return Math.max(0, h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy);
        };

        // ---- terrain mesh (129×129 grid, mercator-exact UVs) ----
        const G = 128;
        const geo = new THREE.PlaneGeometry(widthKm, depthKm, G, G);
        geo.rotateX(-Math.PI / 2);
        const posAttr = geo.attributes.position as THREE_NS.BufferAttribute;
        const uvAttr = geo.attributes.uv as THREE_NS.BufferAttribute;
        const mercNn = mercN(n), mercS = mercN(s);
        const heights = new Float32Array((G + 1) * (G + 1));
        let hMin = Infinity, hMax = -Infinity;
        for (let r = 0; r <= G; r++) {
          const lat = n - (r / G) * spanLat;
          for (let c = 0; c <= G; c++) {
            const lon = w + (c / G) * spanLon;
            const h = heightM(lat, lon);
            heights[r * (G + 1) + c] = h;
            if (h < hMin) hMin = h;
            if (h > hMax) hMax = h;
          }
        }
        const reliefKm = Math.max(0.4, (hMax - hMin) / 1000);
        // honest-but-visible relief: ~2% of the scene, capped at ×80 exaggeration
        const exagg = Math.min(80, Math.max(1, (0.02 * maxDim) / reliefKm));
        for (let r = 0; r <= G; r++) {
          const lat = n - (r / G) * spanLat;
          const v = 1 - (mercN(lat) - mercNn) / Math.max(1e-9, mercS - mercNn);
          for (let c = 0; c <= G; c++) {
            const i = r * (G + 1) + c;
            posAttr.setY(i, (heights[i] / 1000) * exagg);
            uvAttr.setXY(i, c / G, v);
          }
        }
        geo.computeVertexNormals();
        const tex = new THREE.CanvasTexture(crop);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0 }));
        scene.add(terrain);
        const yTop = (hMax / 1000) * exagg + maxDim * 0.004;

        // graticule + AOI border — thin "map information" frame above the drape
        {
          const step = [0.25, 0.5, 1, 2, 5, 10, 20].find((st) => spanLon / st <= 7) ?? 20;
          const verts: number[] = [];
          for (let lon = Math.ceil(w / step) * step; lon <= e; lon += step) {
            verts.push(X(lon), yTop, Z(s), X(lon), yTop, Z(n));
          }
          for (let lat = Math.ceil(s / step) * step; lat <= n; lat += step) {
            verts.push(X(w), yTop, Z(lat), X(e), yTop, Z(lat));
          }
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
          scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.16 })));
          const b: number[] = [X(w), yTop, Z(s), X(e), yTop, Z(s), X(e), yTop, Z(n), X(w), yTop, Z(n), X(w), yTop, Z(s)];
          const gb = new THREE.BufferGeometry();
          gb.setAttribute('position', new THREE.Float32BufferAttribute(b, 3));
          scene.add(new THREE.Line(gb, new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.55 })));
        }

        // ---- fires ----
        const pts: FirePt[] = [];
        let frpSum = 0;
        if (displayData) {
          for (const [sensor, sh2] of Object.entries(displayData.sensors)) {
            if (!visible[sensor]) continue;
            for (const p of sh2.points) {
              pts.push({ sensor, frp: Math.min(600, Math.max(0.5, p.frp || 0.5)), conf: typeof p.conf === 'number' ? p.conf : 60, sat: p.sat || '', acq: p.acq || '', night: !!p.night, lat: p.lat, lon: p.lon });
              frpSum += p.frp || 0;
            }
          }
        }
        pts.sort((a, b) => b.frp - a.frp);
        setMeta({ n: pts.length, frpSum, exagg, z });
        setLoad(null);

        const baseYAt = (lat: number, lon: number) => (heightM(lat, lon) / 1000) * exagg;
        const colRadius = maxDim * 0.0032;

        // precision fire columns — tapered spikes, one per strongest detection
        let columns: THREE_NS.InstancedMesh | null = null;
        const colPts: FirePt[] = [];
        if (pts.length) {
          const count = Math.min(pts.length, 1400);
          const cg = new THREE.CylinderGeometry(0.02, 0.16, 1, 6);
          cg.translate(0, 0.5, 0);
          columns = new THREE.InstancedMesh(cg, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.96 }), count);
          const m4 = new THREE.Matrix4();
          const col3 = new THREE.Color();
          for (let i = 0; i < count; i++) {
            const p = pts[i];
            const hK = Math.min(maxDim * 0.07, (0.006 + 0.055 * Math.sqrt(Math.min(p.frp, 500) / 500)) * maxDim);
            m4.makeScale(colRadius, hK, colRadius);
            m4.setPosition(X(p.lon), baseYAt(p.lat, p.lon), Z(p.lat));
            columns.setMatrixAt(i, m4);
            columns.setColorAt(i, col3.set(rampColor(FRP_RAMP, p.frp)));
            colPts.push(p);
          }
          columns.instanceMatrix.needsUpdate = true;
          if (columns.instanceColor) columns.instanceColor.needsUpdate = true;
          scene.add(columns);
        }

        // glow field — every detection as an additive bloom (single draw call)
        let glowPts: THREE_NS.Points | null = null;
        const glowUniforms: { uScale: { value: number } } | null = pts.length ? { uScale: { value: 1 } } : null;
        if (pts.length) {
          const N = Math.min(pts.length, 20000);
          const posArr = new Float32Array(N * 3);
          const colArr = new Float32Array(N * 3);
          const sizeArr = new Float32Array(N);
          const col3 = new THREE.Color();
          for (let i = 0; i < N; i++) {
            const p = pts[i];
            posArr[i * 3] = X(p.lon);
            posArr[i * 3 + 1] = baseYAt(p.lat, p.lon) + maxDim * 0.0015;
            posArr[i * 3 + 2] = Z(p.lat);
            const c = new THREE.Color(rampColor(FRP_RAMP, p.frp));
            colArr[i * 3] = c.r; colArr[i * 3 + 1] = c.g; colArr[i * 3 + 2] = c.b;
            sizeArr[i] = (2.2 + 11 * Math.sqrt(Math.min(p.frp, 500) / 500)) * maxDim * 0.006;
          }
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
          g.setAttribute('aColor', new THREE.BufferAttribute(colArr, 3));
          g.setAttribute('aSize', new THREE.BufferAttribute(sizeArr, 1));
          const dot = document.createElement('canvas');
          dot.width = dot.height = 64;
          const dctx = dot.getContext('2d')!;
          const grad = dctx.createRadialGradient(32, 32, 0, 32, 32, 32);
          grad.addColorStop(0, 'rgba(255,255,255,0.95)');
          grad.addColorStop(0.25, 'rgba(255,220,180,0.55)');
          grad.addColorStop(1, 'rgba(255,120,60,0)');
          dctx.fillStyle = grad;
          dctx.fillRect(0, 0, 64, 64);
          const dotTex = new THREE.CanvasTexture(dot);
          const mat = new THREE.ShaderMaterial({
            uniforms: { uScale: glowUniforms!.uScale, uTex: { value: dotTex } },
            vertexShader: `attribute float aSize; attribute vec3 aColor; varying vec3 vC; uniform float uScale;
              void main(){ vC=aColor; vec4 mv=modelViewMatrix*vec4(position,1.0);
              gl_PointSize=aSize*(uScale/-mv.z); gl_Position=projectionMatrix*mv; }`,
            fragmentShader: `uniform sampler2D uTex; varying vec3 vC;
              void main(){ vec4 t=texture2D(uTex,gl_PointCoord); gl_FragColor=vec4(vC,1.0)*t; }`,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          });
          glowPts = new THREE.Points(g, mat);
          scene.add(glowPts);
        }

        // EXTREME pulse rings — breathing halos over the worst columns
        const ringSprites: THREE_NS.Sprite[] = [];
        if (pts.length) {
          const ring = document.createElement('canvas');
          ring.width = ring.height = 64;
          const rctx = ring.getContext('2d')!;
          rctx.strokeStyle = 'rgba(248,113,113,0.95)';
          rctx.lineWidth = 4;
          rctx.beginPath();
          rctx.arc(32, 32, 26, 0, Math.PI * 2);
          rctx.stroke();
          const ringTex = new THREE.CanvasTexture(ring);
          for (const p of pts) {
            if (ringSprites.length >= 24) break;
            if (threatBadge(p.frp, p.conf, p.night).score < 80) continue;
            const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, color: 0xf87171, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
            sp.position.set(X(p.lon), baseYAt(p.lat, p.lon) + maxDim * 0.006, Z(p.lat));
            sp.userData.phase = Math.random();
            ringSprites.push(sp);
            scene.add(sp);
          }
        }

        // ---- hover tooltip + click = AI event card ----
        const ray = new THREE.Raycaster();
        if (glowPts) ray.params.Points = { threshold: maxDim * 0.004 };
        const ndc = new THREE.Vector2();
        let hoverPt: FirePt | null = null;
        const pick = (cx: number, cy: number): FirePt | null => {
          const r = renderer.domElement.getBoundingClientRect();
          ndc.x = ((cx - r.left) / r.width) * 2 - 1;
          ndc.y = -((cy - r.top) / r.height) * 2 + 1;
          ray.setFromCamera(ndc, camera);
          if (columns) {
            const hit = ray.intersectObject(columns, false)[0];
            if (hit && hit.instanceId !== undefined && colPts[hit.instanceId]) return colPts[hit.instanceId];
          }
          if (glowPts) {
            const hit = ray.intersectObject(glowPts, false)[0];
            if (hit && hit.index !== undefined && pts[hit.index]) return pts[hit.index];
          }
          return null;
        };
        const showTip = (p: FirePt | null, cx: number, cy: number) => {
          const tip = tipRef.current;
          if (!tip) return;
          if (!p) { tip.style.display = 'none'; hoverPt = null; return; }
          hoverPt = p;
          const t = threatBadge(p.frp, p.conf, p.night);
          tip.innerHTML = `<span style="background:${t.bg};color:${t.fg};border-radius:4px;padding:0 5px;font-weight:800;font-size:9px">${t.label}</span> <b style="color:#FCA5A5">${p.frp.toFixed(1)} MW</b> · ${p.sensor}${p.night ? ' · 🌙' : ''}`;
          tip.style.display = 'block';
          const r = mount.getBoundingClientRect();
          tip.style.left = `${Math.min(r.width - 180, cx - r.left + 12)}px`;
          tip.style.top = `${Math.max(4, cy - r.top - 30)}px`;
        };
        let downXY: { x: number; y: number } | null = null;
        const onMove = (ev: PointerEvent) => showTip(pick(ev.clientX, ev.clientY), ev.clientX, ev.clientY);
        const onDown = (ev: PointerEvent) => { downXY = { x: ev.clientX, y: ev.clientY }; };
        const onUp = (ev: PointerEvent) => {
          if (!downXY) return;
          const moved = Math.hypot(ev.clientX - downXY.x, ev.clientY - downXY.y);
          downXY = null;
          if (moved > 6) return; // orbit drag, not a pick
          const p = pick(ev.clientX, ev.clientY);
          if (!p || !cardRef.current) return;
          const card = cardRef.current;
          card.style.display = 'block';
          card.innerHTML = `<div style="position:relative;border:1px solid #1E3A5F;border-radius:10px;background:rgba(4,9,18,0.95);padding:10px;box-shadow:0 14px 44px rgba(0,0,0,0.55)">
            <button data-x style="position:absolute;top:4px;right:8px;background:none;border:0;color:#64748B;font-size:12px;cursor:pointer">✕</button>
            ${detectionPopupHTML({ sensor: p.sensor, sat: p.sat || undefined, frp: p.frp, conf: p.conf, acq: p.acq || undefined, night: p.night, lat: p.lat, lon: p.lon }, { regionKey, day })}
            <button data-fly style="margin-top:7px;width:100%;background:#132A44;color:#7DD3FC;border:1px solid #1E3A5F;border-radius:6px;padding:5px 8px;font-weight:700;cursor:pointer;font-size:11px">⤢ Center the 2D map here</button>
          </div>`;
          wireHotspotAI(card, (q) => onAskRef.current(q));
          card.querySelector<HTMLButtonElement>('[data-x]')!.onclick = () => { card.style.display = 'none'; };
          card.querySelector<HTMLButtonElement>('[data-fly]')!.onclick = () => {
            onFlyRef.current(p.lat, p.lon);
            onCloseRef.current();
          };
        };
        renderer.domElement.addEventListener('pointermove', onMove);
        renderer.domElement.addEventListener('pointerdown', onDown);
        renderer.domElement.addEventListener('pointerup', onUp);

        // debug handle — E2E can verify the drape integrity + toggle layers in-place
        (window as unknown as { __ignisT3D?: Record<string, unknown> }).__ignisT3D = { cropCanvas: crop, mosaicCanvas: imgMosaic, z, x0, y0, cols, rows, sw, sh, sx, sy, loadedTiles: imgOk, tileTotal: cols * rows, scene, terrain, exagg, hMin, hMax, widthKm, depthKm };

        // ---- render loop (with a one-shot perf guard) ----
        let raf = 0;
        let slowFrames = 0;
        let degraded = false;
        const clock = new THREE.Clock();
        const loop = () => {
          raf = requestAnimationFrame(loop);
          const dt = Math.min(0.05, clock.getDelta());
          const t0 = performance.now();
          controls.update();
          const t = clock.elapsedTime;
          for (let i = 0; i < ringSprites.length; i++) {
            const sp = ringSprites[i];
            const pgs = (t * 0.55 + (sp.userData.phase as number)) % 1;
            const base = colRadius * 7;
            sp.scale.setScalar(base * (0.6 + 2.4 * pgs));
            (sp.material as THREE_NS.SpriteMaterial).opacity = 0.85 * (1 - pgs);
          }
          renderer.render(scene, camera);
          if (!degraded) {
            if (performance.now() - t0 > 45) slowFrames += 1; else slowFrames = 0;
            if (slowFrames >= 3) { renderer.setPixelRatio(1); degraded = true; }
          }
          void dt;
        };
        const uScaleSync = () => {
          if (glowUniforms) glowUniforms.uScale.value = (renderer.domElement.height * 0.5) / Math.tan((camera.fov * Math.PI) / 360);
        };
        uScaleSync();
        const ro = new ResizeObserver(() => {
          const wpx = mount.clientWidth || 800, hpx = mount.clientHeight || 520;
          renderer.setSize(wpx, hpx);
          camera.aspect = wpx / hpx;
          camera.updateProjectionMatrix();
          uScaleSync();
        });
        ro.observe(mount);
        loop();

        cleanup = () => {
          cancelAnimationFrame(raf);
          ro.disconnect();
          renderer.domElement.removeEventListener('pointermove', onMove);
          renderer.domElement.removeEventListener('pointerdown', onDown);
          renderer.domElement.removeEventListener('pointerup', onUp);
          controls.dispose();
          scene.traverse((o) => {
            const any = o as unknown as { geometry?: THREE_NS.BufferGeometry; material?: THREE_NS.Material | THREE_NS.Material[]; dispose?: () => void; isInstancedMesh?: boolean };
            any.geometry?.dispose();
            const m = any.material;
            if (Array.isArray(m)) m.forEach((x) => x.dispose());
            else m?.dispose();
            if (any.isInstancedMesh && typeof any.dispose === 'function') any.dispose();
          });
          tex.dispose();
          renderer.dispose();
          if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
        };
      } catch (e2) {
        console.warn('[ignis:terrain3d] scene failed', e2);
        setErr('scene');
        setLoad(null);
      }
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [bbox, day, regionKey, imageryKey, displayData, visibleKey]);

  return (
    <div className="absolute inset-0 z-30 overflow-hidden rounded-xl border border-[#14273F] bg-[#04070F]">
      <style>{`
        .t3d-pop .ignis-ai-slot button { }
        .t3d-select { appearance:none; background:#050A14; border:1px solid #1E3A5F; border-radius:6px; color:#CBD5E1; padding:3px 8px; font-size:10.5px; outline:none; }
      `}</style>
      <div ref={mountRef} className="h-full w-full" />

      {/* hover tooltip */}
      <div ref={tipRef} style={{ display: 'none', position: 'absolute', pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 5, background: 'rgba(4,9,18,0.92)', border: '1px solid #1E3A5F', borderRadius: 6, padding: '3px 7px', fontSize: 10.5, color: '#CBD5E1' }} />

      {/* clicked-fire AI event card */}
      <div ref={cardRef} className="t3d-pop" style={{ display: 'none', position: 'absolute', left: 12, bottom: 12, width: 300, zIndex: 6 }} />

      {/* top HUD */}
      <div className="pointer-events-none absolute left-3 top-3 z-[7] flex max-w-[calc(100%-24px)] flex-wrap items-center gap-2 rounded-lg border border-[#14273F] bg-[#050A14]/90 px-3 py-2 text-[11px] text-slate-300 backdrop-blur">
        <span className="font-bold text-orange-200">⛰ IGNIS 3D Terrain</span>
        <span className="text-slate-500">Three.js · WebGL</span>
        <span className="text-slate-500">|</span>
        <span className="font-mono text-orange-300">{meta ? meta.n.toLocaleString() : '…'}</span>
        <span className="text-slate-500">detections · Σ</span>
        <span className="font-mono text-orange-300">{meta ? Math.round(meta.frpSum).toLocaleString() : '…'}</span>
        <span className="text-slate-500">MW</span>
        {meta && <span className="text-slate-500">· GIBS z{meta.z} · relief ×{meta.exagg >= 10 ? Math.round(meta.exagg) : meta.exagg.toFixed(1)}</span>}
        <select
          value={imageryKey}
          onChange={(ev) => setImageryKey(ev.target.value as 'truecolor' | 'viirs' | 'bands721')}
          className="t3d-select pointer-events-auto"
          title="NASA GIBS satellite drape (free, public domain)">
          {Object.entries(IMAGERY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <button onClick={onClose} className="pointer-events-auto rounded border border-[#1E3A5F] bg-[#0C1A2E]/80 px-2 py-0.5 font-bold text-slate-300 hover:text-slate-100">✕</button>
      </div>

      {/* bottom hint */}
      <div className="pointer-events-none absolute bottom-3 left-1/2 z-[7] -translate-x-1/2 whitespace-nowrap rounded border border-[#14273F] bg-[#050A14]/80 px-2.5 py-1 text-[9.5px] text-slate-400 backdrop-blur">
        drag = orbit · scroll = zoom · right-drag = pan · hover = telemetry · <b className="text-orange-300">click a fire column = full AI event card</b>
      </div>

      {/* loading / error states */}
      {load && (
        <div className="absolute inset-0 z-[8] flex flex-col items-center justify-center gap-2 bg-[#04070F]/85 text-[11px] text-slate-300">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-orange-400 border-t-transparent" />
          <b className="text-orange-200">Building the 3D terrain…</b>
          <span className="text-slate-500">NASA GIBS imagery + AWS Terrarium elevation · tile {load.done}/{load.total}</span>
        </div>
      )}
      {err && !load && (
        <div className="absolute inset-0 z-[8] flex flex-col items-center justify-center gap-2 bg-[#04070F]/90 px-8 text-center text-[11px] text-slate-300">
          <b className="text-amber-300">3D terrain unavailable ({err === 'webgl' ? 'no WebGL context' : err === 'tiles' ? 'imagery tiles unreachable' : err === 'load' ? 'Three.js failed to load' : 'scene error'})</b>
          <span className="text-slate-500">The 🧊 GPU-free Fire Field delivers the same fire-field analysis without WebGL.</span>
          <button onClick={onClose} className="rounded border border-[#1E3A5F] bg-[#0C1A2E] px-3 py-1 font-bold text-slate-200">Close</button>
        </div>
      )}
      {!load && !err && (!displayData || !meta || meta.n === 0) && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-[7] -translate-x-1/2 rounded border border-[#14273F] bg-[#050A14]/85 px-3 py-1.5 text-[10.5px] text-slate-400">
          no fire detections in the current AOI / sensor filter — terrain + imagery only
        </div>
      )}
    </div>
  );
}
