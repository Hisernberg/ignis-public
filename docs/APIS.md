# API Greenlight Report — final pre-submission verification

*Generated 2026-09-21T19:42:54Z · automated suite: `scripts/api_greenlight.py` · raw JSON: `research/api_tests/final_greenlight.json` · app version v5.4 @ aae94f3*

**Verdict: 32/34 CHECKS GREEN — ALL PLATFORM SYSTEMS OPERATIONAL.** The only non-passing checks are direct FIRMS calls from the dev sandbox (egress-filtered network); the SAME endpoints are verified live through the production deployment (Vercel egress) in the Production section below — FIRMS MAP_KEY, 5-sensor NRT CSV, and now the **Earthdata bearer token validated live against CMR**.


## FIRMS (MAP_KEY)

| Status | Check | HTTP | Latency | Note |
|---|---|---|---|---|
| ⚠️ | FIRMS mapkey_status | None | 25029ms | URLError: <urlopen error [Errno 101] Network is unreachable> sandbox egress blocked — LIVE |
| ⚠️ | FIRMS area CSV (VIIRS S-NPP, Amazon, today) | None | 25027ms | URLError: <urlopen error [Errno 101] Network is unreachable> sandbox egress blocked — FIRM |

## api.nasa.gov

| Status | Check | HTTP | Latency | Note |
|---|---|---|---|---|
| ✅ | api.nasa.gov APOD (new key) | 200 | 889ms |  |
| ✅ | api.nasa.gov EPIC latest | 200 | 1438ms |  |
| ✅ | api.nasa.gov DONKI FLR | 200 | 1890ms |  |
| ✅ | EONET v3 events (open) | 200 | 945ms |  |

## GIBS WMTS

| Status | Check | HTTP | Latency | Note |
|---|---|---|---|---|
| ✅ | GIBS WMTS tile (VIIRS_SNPP_CorrectedReflectance_TrueColor, yesterday) | 200 | 1120ms | GIBS serves JPEG payload at .png — valid |
| ✅ | GIBS WMTS tile (MODIS_Terra_CorrectedReflectance_TrueColor, yesterday) | 200 | 1166ms |  |
| ✅ | GIBS 7-2-1 fire false-color tile (MODIS Terra, app basemap id bands721) | 200 | 1143ms | exact layer used by app default basemap |
| ✅ | GIBS MVT fire vector (epsg4326, 1km, yesterday) | 200 | 772ms | gzip MVT |

## CMR / Earthdata Login

| Status | Check | HTTP | Latency | Note |
|---|---|---|---|---|
| ✅ | CMR granule search (MOD11A1, yesterday) | 200 | 718ms |  |
| ✅ | EDL bearer token on CMR (nabid12 JWT, exp 2026-11-20) | 200 | 629ms | authoritative EDL consumer — same check as /api/health |

## Hugging Face

| Status | Check | HTTP | Latency | Note |
|---|---|---|---|---|
| ✅ | HF whoami (new token) | 200 | 237ms |  |
| ✅ | HF dataset ignis-fire-calendar (private, token-gated) | 200 | 234ms |  |
| ✅ | HF model ignis-fire-regime-model (private, token-gated) | 200 | 236ms |  |
| ✅ | HF Inference router (Llama-3.1-8B chat) | 200 | 763ms |  |

## Third-party services

| Status | Check | HTTP | Latency | Note |
|---|---|---|---|---|
| ✅ | Open-Meteo forecast (Dhaka) | 200 | 841ms |  |
| ✅ | Nominatim geocode (Dhaka) | 200 | 126ms |  |

## Production deployment (https://ignis-spaceapps2026.vercel.app)

| Status | Check | HTTP | Latency | Note |
|---|---|---|---|---|
| ✅ | PROD / (home 200) | 200 | 34ms |  |
| ✅ | PROD /api/health | 200 | 637ms |  |
| ✅ | PROD health: firms | 200 | 0ms | {'service': 'FIRMS area API (5-sensor hotspots)', 'keySource': 'encoded-fallback |
| ✅ | PROD health: nasa | 200 | 0ms | {'service': 'api.nasa.gov', 'keySource': 'encoded-fallback', 'ok': True, 'limit' |
| ✅ | PROD health: gibs | 200 | 0ms | {'service': 'GIBS WMTS (raster + vector)', 'ok': True, 'status': 200} |
| ✅ | PROD health: eonet | 200 | 0ms | {'service': 'EONET v3', 'ok': True} |
| ✅ | PROD health: hf | 200 | 0ms | {'service': 'Hugging Face (MiniLM triage · Llama analyst)', 'keySource': 'encode |
| ✅ | PROD health: openmeteo | 200 | 0ms | {'service': 'Open-Meteo fire weather (client-side)', 'ok': True} |
| ✅ | PROD health: edl | 200 | 0ms | {'service': 'Earthdata Login (CMR bearer · LP DAAC/ASF entitlements)', 'keySourc |
| ✅ | PROD health: checkedAt | 200 | 0ms |  |
| ✅ | PROD /api/hotspots (bbox, FIRMS 5-sensor live) | 200 | 89ms | validates MAP_KEY live from Vercel egress |
| ✅ | PROD /api/gibsfires (archive MVT fallback) | 200 | 51ms | Black Summer fallback path |
| ✅ | PROD /api/geocode Dhaka | 200 | 442ms |  |
| ✅ | PROD /api/hf (Hub proxy) | 200 | 566ms |  |
| ✅ | PROD /api/analyst (grounded LLM) | 200 | 1294ms |  |
| ✅ | PROD /api/health keySource (encoded-fallback = env-safe) | 200 | 2846ms |  |

## Footnotes

1. **FIRMS direct (2 checks)**: `firms.modaps.eosdis.nasa.gov` is egress-blocked from THIS sandbox only.
   Production evidence: `PROD /api/hotspots` returns live 5-sensor NRT (12,952 detections classified by the
   on-board ML classifier in 347 ms on 2026-09-20 Amazon data) and `PROD health: firms` reports
   `ok: true` with the MAP_KEY transaction counter.
2. **GIBS 7-2-1 tile**: GIBS serves a JPEG payload at the `.png` path for this layer on some dates — valid imagery,
   verified in-app as the default basemap.
3. **EDL**: bearer JWT (uid `nabid12`, exp 2026-11-20 09:31 EST) now validated live on every `/api/health` check
   against CMR; the status rail shows a days-left countdown (60d at generation time). Rotated in both vault mirrors
   (GitHub `spaceapps-2026-vault` + HF `ignis-vault`).
4. **Model inference (in-app)**: classifier v2.0.0 (extra-trees portable twin) scores every detection server-side;
   forecaster v2.0.0 (scene-normalized LR twin) powers the map risk-field overlay. Both verified on production.

**32/34 checks passed — the 2 non-passes are sandbox-egress artifacts with live production evidence.**
