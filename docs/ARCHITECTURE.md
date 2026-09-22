# IGNIS — Architecture

> Design principle: **API-first, AI-optional.** Every analytical capability works without any LLM; AI layers enrich but never gate.

## 1. Topology

```
Browser (client components)
 ├── MapPanel (MapLibre GL)  ← GIBS raster tiles (direct) + GeoJSON overlays (via /api)
 ├── SegmentationPanel/DynamicsPanel ← deterministic TS (in-browser compute)
 └── AiAnalyst drawer        ← POST /api/analyst (Llama-3.1-8B grounded, rule-engine fallback)

Vercel (serverless, region iad1)
 ├── /api/hotspots    → FIRMS area API (primary, MAP_KEY) → GIBS WMTS vector parser (fallback)
 ├── /api/gibsfires   → GIBS WMTS vector tiles → GeoJSON (15-min cache)
 ├── /api/calendar    → data/ignis/calendar_*.json (precomputed)
 ├── /api/outlook     → data/ignis/outlook_*.json (precomputed)
 ├── /api/eonet       → EONET v3 + MiniLM ranking (transformers.js ONNX, cached)
 ├── /api/analyst     → HF router chat completions (Llama-3.1-8B, Qwen3-8B fallback) + rule engine
 └── /api/health      → live probes of all 7 upstream systems
```

## 2. Deterministic core (zero-LLM path)

| Module | Responsibility |
|---|---|
| `lib/ignis/segmentation.ts` | Grid-accelerated DBSCAN, convex hulls (monotone chain), cluster metrics (ΣFRP, spread, hull area, front ratio), class thresholds, persistence tracker (greedy nearest-centroid ≤ 60 km/day) |
| `lib/ignis/analytics.ts` | Unified series construction, climatology + z-scores, Theil-Sen slope, CUSUM change points, harmonic (Fourier) regression forecast with ridge + residual bands, regime nearest-prototype classifier |
| `lib/ignis/firms.ts` | FIRMS area API client (5 sensors, dayRange semantics: DATE = window start), satellite-column split, confidence harmonization (l/n/h → 30/60/90), GIBS MVT fallback parser |
| `lib/ignis/fireweather.ts` | Open-Meteo 7-day composite danger score (tmax, RH, wind, precip) |

All of these run **in the browser** where they operate on client state (segmentation, analytics on calendars) or **serverless** where they proxy NASA endpoints. None of them require AI.

## 3. AI layer (enrich-only)

1. **SITREP mode** (`POST /api/analyst {mode:"sitrep"}`): system prompt fixes a 4-section operational structure (SITUATION / KEY SYSTEMS / ASSESSMENT / NEXT 48H). Context = live telemetry JSON incl. segmentation summary and persistent systems. **Zero-hallucination guard** in both prompts: if `totalDetections === 0` or `segmentation === null`, the model must say data is loading and skip numeric bullets.
2. **Chat mode**: same grounding, NAVIGATE action protocol → drives map region/date.
3. **Deterministic fallback**: `templateSitrep()` / `templateAnswer()` produce the *same structures* from the same JSON with zero network. The UI labels which engine answered (`model: "ignis-rule-engine (offline fallback)"`).
4. **MiniLM on-device**: `all-MiniLM-L6-v2` (Xenova ONNX q8) embeds EONET event titles vs region profiles; cosine ranking. Runs server-side in the same Node runtime; no external inference call.

## 4. Resilience chain

```
FIRMS API reachable? ──yes──► FIRMS NRT (5 sensors, freshest)
        │no (sandbox/firewall/rate-limit)
        ▼
GIBS WMTS vector tiles (epsg4326 TMS) ── server parses MVT ──► same FIRMS-derived records
        │older than coverage?
        ▼
GIBS archive (to 2000-11) with per-sensor coverage dates surfaced in UI (GIBS_LATEST)
```

Every response carries `source` and `note`; the map HUD and KPI strip display them, so judges can always tell which pipeline produced what they see.

## 5. Deployment

- GitHub `main` → Vercel auto-deploy (production: `ignis-spaceapps2026.vercel.app`).
- Env vars: `FIRMS_MAP_KEY`, `NASA_API_KEY`, `HF_TOKEN` (set in Vercel project; `lib/ignis/keys.ts` env-first with embedded fallback for the private repo).
- HF cache dir forced to `/tmp` on Vercel (read-only FS except `/tmp`).
- All API routes `force-dynamic`; calendar/outlook JSON served from the repo (immutable precompute).
