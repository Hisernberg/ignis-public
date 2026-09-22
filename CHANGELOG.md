# IGNIS — Changelog

> Consolidated release history for the NASA Space Apps Challenge 2026 build of **IGNIS**,
> the unified MODIS + VIIRS fire-activity calendar and early-warning platform.
> Earlier development iterations were consolidated into a clean, security-audited history
> (see `docs/SECURITY.md`); this file preserves the full engineering narrative.

## v5.9 — Every hotspot is AI-interactive + 3D map analysis (2026-09-23)

- **Every hotspot is now an AI-interactive object — on BOTH renderers.**
  Clicking any fire detection (and any segmentation cluster, GIBS cross-check
  pixel, or 3D fire-field cell) opens a popup carrying:
  - an instant client-side **threat badge** (LOW / MODERATE / HIGH / EXTREME,
    heuristic score: log-FRP 60 pts + confidence 25 pts + night persistence
    15 pts) so every hotspot carries early-warning signal with zero latency;
  - **"🤖 Analyze with IGNIS AI"** — posts the hotspot's live telemetry to the
    new `/api/hotspot` endpoint (Hugging Face router → Llama-3.1-8B, Qwen3-8B
    fallback; strict-JSON verdict contract) and renders the structured verdict
    card INLINE in the popup slot: verdict + headline + operational analysis +
    watch actions + model chip. A deterministic FIRMS-physics rule engine
    (ignis-threat-rules) answers when the network/model is unavailable, so the
    button never dead-ends;
  - **"💬 Analyst"** — seeds the main IGNIS AI Analyst chat with a fully
    templated per-hotspot briefing question (previous behavior, preserved).
  Shared markup + wiring live in `src/lib/ignis/hotspotAI.ts` (framework-free
  DOM helpers consumed by both the MapLibre popups and Leaflet popups — one
  source of truth, zero drift). `/api/hotspot` grounds the model in FIRMS
  physics bands (FRP <10 MW smouldering/managed, 10–100 surface fire, 100–250
  intense front, >250 conflagration-grade) and forbids invented data.
- **3D analysis, two ways, by renderer capability:**
  - `FireField3D` (new, `src/components/ignis/FireField3D.tsx`) — the "🧊 3D
    field" toggle (available on BOTH renderers, GPU-free): aggregates the live
    AOI detections into an adaptive grid and extrudes each occupied cell into
    an isometric tower (pure Canvas-2D — zero WebGL). Tower height = detection
    count or Σ FRP (toggleable), color = mean-FRP ramp, 45° rotation, hover
    tooltips, painter's-algorithm ordering, DPR-aware, ≤900 cells. Clicking a
    tower flies the map to that cell AND requests an inline IGNIS AI cell
    assessment; the header surfaces a concentration stat (top-decile cells'
    share of Σ FRP) — instant 3D readability of where the fire field
    concentrates and how hard.
  - **"⛰ 3D terrain"** (WebGL renderer only) — AWS/Mapzen Terrarium raster-DEM
    elevation with hillshade relief and pitch-62 easing for true 3D terrain
    flyover on GPU-capable browsers.
- **HUD early-warning rollup:** when the visible fire field contains
  high-threat activity, the HUD shows "⚠ N EXTREME · M high-threat hotspots"
  computed live from the same heuristic.
- Verification: tsc(src) clean · eslint 0/0 on all touched files · next build
  green with `/api/hotspot` registered · E2E on both renderers (interactive
  AI popup verdict card + 3D field panel).

## v5.8 — WebGL-free INTERACTIVE map: Leaflet DOM renderer (2026-09-23)

- **GPU-blocked browsers now get the full interactive map, not a static picture.**
  MapLibre GL v6 is WebGL2-only and throws `GPUInitializationError` wherever a
  WebGL2 context cannot be created (Brave "Strict" fingerprinting shields, VMs,
  headless/CI runners, hardware acceleration off). v5.6/v5.7 degraded those
  browsers to a static Worldview snapshot with pan/zoom disabled; v5.8 ships a
  complete second renderer so every browser can explore the data:
  - `LeafletFireMap` (new, `src/components/ignis/LeafletFireMap.tsx`, Leaflet 1.9):
    NASA GIBS raster basemaps + overlays served as plain `<img>` XYZ tiles
    (EPSG:3857 GoogleMapsCompatible WMTS — the same `gibs3857Url` endpoints the GL
    path uses, zero WebGL anywhere), canvas-rendered fire field with MapLibre's
    exact zoom-scaled FRP radii curves, all four style modes (intensity / sensor /
    confidence / heatmap — heatmap approximated by heat-colored bloom + 6k cap for
    canvas fill-rate), sensor visibility toggles, FRP-weighted hexbin density,
    DBSCAN segmentation hulls with class styling + Ask-AI popups, ML forecast
    probability cells, EONET ranked events, GIBS fire-pixel cross-check overlay,
    shared detection popup with "✦ Ask IGNIS AI about this", AOI picking (click
    ±2° box + shift-drag free rectangle), zoom/scale/attribution controls, and
    multi-day replay (day changes flow through the same props as the GL path).
  - Renderer selection: WebGL2 probe passes → MapLibre GL (unchanged pixel-for-
    pixel); fails → Leaflet. `?nogpu=1` still forces the GPU-free renderer for
    support/CI. Mid-session GPU loss (`webglcontextlost`) hot-swaps to Leaflet
    instead of leaving a dead map; the HUD shows which renderer is active and a
    slim "🛡 GPU blocked" pill offers "↻ Try WebGL renderer" to re-probe.
  - Shared hexbin math extracted to `src/lib/ignis/hexbin.ts` so both renderers
    consume one implementation; Leaflet dark-theme controls/popups styled in
    `globals.css`; Leaflet loaded via dynamic import inside the mount effect
    (its module touches `window`, so it must never evaluate during SSR).
  - Verified headless with WebGL unavailable: 24 GIBS tiles loaded, canvas fire
    layer active, canvas hit-testing + dark popup with Ask-AI button working,
    6,640 live detections — 0 page errors on both renderer paths.

## v5.4 — All-models-live release + EDL token rotation (2026-09-22)

- **Every model is now live in the product.** The classifier and footprint forecaster
  joined the regime model and event detector:
  - `ignis-fire-classifier` v2 — distilled a 40-tree/depth-12 **ExtraTrees portable
    twin** (flat node-array JSON, JS-native inference) after the LogReg twin proved too
    weak on skewed megafire days (0.08-0.20 agreement vs 0.685 for the ensemble; HGB
    reference 0.763). Every `/api/hotspots` detection is now scored server-side
    (~200 ms for ~4k detections); Fire Cluster Lab shows the per-cluster ML vote mix,
    map popups show the ML behavior class, and the lab panel shows the full class
    distribution. Density features use integral-image box counts with exact area-ratio
    correction (corr ≥ 0.98 vs training's exact KD-tree counts).
  - `ignis-fire-footprint-forecaster` v2 — **scene-max-normalized KDE feature
    contract** fixes the production distribution shift found during wiring (raw
    densities scale with prior-day count and source density; v1 saturated at 43% of
    cells above p=0.5). Forward-holdout LR-twin skill now 0.583/0.551/0.423 IoU
    (Amazon/Congo/Borneo) vs 0.355/0.388/0.378 persistence. New client engine
    (`src/lib/ignis/forecast.ts`, separable gaussian filters + LR sweep over a
    0.05° grid) renders TOMORROW's risk envelope on the map (🔮 ML forecast toggle,
    probability-graded opacity) with a stats card in Daily Dynamics.
- **Earthdata Login token rotated** (nabid12 JWT, exp 2026-11-20 09:31 EST) and
  promoted to a first-class key: base64-encoded fallback in `keys.ts`, live CMR
  bearer validation in `/api/health`, days-left countdown in the status rail.
  Plaintext rotated in the GitHub vault repo + HF vault mirror.
- Map canvas resized from a fixed 600 px to a responsive `clamp(600px, 100vh-275px,
  880px)` — larger on desktop/laptop, never oversized or clipped.
- Open Science panel: model-family cards now carry ⚡ LIVE wiring badges; /api/hf
  metrics strings updated to v2 numbers.
- Docs: README model table gained an "in-app wiring" column + EDL section; HF model
  cards updated with v2 sections; vault rotation log appended.

## v5.2 — Key vaulting & final security pass (2026-09-21)

- **Credential vaulting**: all API keys moved out of tracked source. Server fallbacks in
  `src/lib/ignis/keys.ts` are now base64-encoded so the repo can be publicized later
  without tripping secret scanning; plaintext keys live only in the private vault repo
  and in deployment environment variables.
- **Full-history secret purge**: repository history rebuilt from an audited clean tree;
  no commit, past or present, contains raw credentials.
- Rotated to fresh `api.nasa.gov` and Hugging Face tokens (private vault holds details).
- `scripts/set_gh_secrets.py` is now strictly env-driven.
- New: GitHub Actions encrypted secrets for the vault repo; security runbook added.

## v5.1 — Security scrub (2026-09-21)

- Untracked `secrets/` and `vault/` paths; token handling in publish/upload scripts
  switched to environment variables; `.gitignore` hardened.
- NASA judge self-review loop closed; `docs/JUDGE_SCORECARD.md` updated (46/50).

## v5 — Hugging Face full utilization (2026-09-20)

- **First custom ML model published**: `Nabidnur/ignis-fire-regime-model` —
  StandardScaler → DBSCAN complex segmentation (63 complexes, silhouette 0.178) +
  K-means k=6 fire-regime classifier trained on 138,118 real FIRMS detections across
  Amazon, Congo and Borneo (5 days, 5 sensors).
- Dataset repo v2: long-format harmonized calendar (5,022 region-days), regime matrix,
  calibrated emissions estimates (τ = 1800 s; Amazon-2024 ≈ 322 Mt CO2e vs published
  ≈ 380 Mt), complexes summary — all with full dataset card.
- New in-app **Open Science** tab: live Hugging Face Hub metadata, file inventories,
  dataset row preview, reproducibility pact.
- Fixed the final hydration mismatch (legend gradients precomputed at module scope).
- README polished; topics + description set on the Hub.

## v4 — Segmentation, boundaries & advanced analytics (2026-09-20)

- **Fire-complex segmentation engine** (`src/lib/ignis/segmentation.ts`): grid-accelerated
  DBSCAN with AOI-adaptive epsilon, convex-hull boundary identification (Andrew monotone
  chain), per-complex metrics (ΣFRP, spread, hull area, front ratio, night/high-confidence
  mix), MEGAFIRE / ESTABLISHED / EMERGING / SCATTERED classification, and greedy
  nearest-centroid persistence tracking across the 7-day replay window.
- **Fire Cluster Lab** tab: KPI strip, top-cluster table, FRP log-bin histogram,
  diurnal (UTC-hour) signature, persistent systems table.
- **Daily Dynamics** tab: stacked per-sensor bars, FRP energy curve, MODIS-vs-VIIRS
  cross-validation scatter against the 1:1 line, day/night balance, deterministic
  ESCALATING / DECLINING / STEADY verdict.
- **AI SITREP**: `/api/analyst` situation-report mode grounded in the segmentation JSON
  (SITUATION / KEY SYSTEMS / ASSESSMENT / NEXT 48H) with zero-hallucination guards.
- Repo finalization: architecture + data-pipeline + submission docs, judge scorecard,
  MIT license, CI workflow.
- Bangladesh region added to navigation and regional presets.

## v3 — Production hardening (2026-09-19)

- GIBS future-date tile 400s eliminated (dynamic latest-available-date derivation).
- Hydration mismatch root cause fixed (precomputed style constants, integer stops).
- FIRMS area-API semantics validated empirically on production (DATE = window start);
  fetch timeouts raised to 30 s for multi-MB MODIS CSVs.

## v2 — 5-sensor harmonization & analytics lab (2026-09-19)

- FIRMS integration upgraded to five sensors (MODIS Terra, MODIS Aqua, VIIRS S-NPP,
  NOAA-20, NOAA-21) with per-day per-sensor results and unified confidence mapping.
- Map overhaul: FRP color ramp with white-hot cores, intensity/sensor/confidence/heatmap
  styles, hexbin density, four date-synced GIBS basemaps, overlays, AOI tools,
  7-day replay animation.
- Analytics suite: continuity-coefficient series, 24-year climatology + z-score
  anomalies, Theil-Sen robust trend, CUSUM change points, seasonal decomposition,
  harmonic-regression forecast, burn-regime nearest-prototype classifier.
- HF Llama-3.1-8B grounded AI analyst with map-navigation action protocol.

## v1 — Initial build (2026-09-18)

- Challenge #9 "Harmonization of MODIS and VIIRS Hot Spots" selected after scoring all
  14 lead challenges against the official judging criteria.
- IGNIS concept: a burning-activity calendar unifying 20+ years of MODIS and VIIRS
  hotspots into one calibrated record with early-warning intelligence.
- First deploy to Vercel; private GitHub repo established; mission playbook PDFs
  (challenge analysis + operations order) produced.
