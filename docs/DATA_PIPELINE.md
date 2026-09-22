# IGNIS — Data Pipeline

> Reproducible, key-light, archive-first. The full 26-year record is rebuilt from NASA GIBS alone (no FIRMS quota needed); FIRMS NRT powers the live layer at runtime.

## 1. Precompute pipeline (scripts/ignis/)

### build_calendar.mjs → `data/ignis/calendar_<region>.json`

1. **Source**: GIBS WMTS **vector** tiles `MODIS_Terra_Thermal_Anomalies_All` (epsg4326, 1 km TMS, z5 = 9°×9° tiles). Same records FIRMS serves — MODIS C6.1 schema (LAT/LON, BRIGHTNESS, FRP, CONFIDENCE, DAYNIGHT, SATELLITE).
2. **Sampling**: 2 days sampled per month across 2000-11 → today (deterministic day-of-month picker), all z5 tiles intersecting the region bbox fetched, points bbox-filtered.
3. **Aggregation**: per month per sensor → `MonthRow { ym, sampled, days, est, frp, meanFrp, hiConf, night }`.
4. **Scaling**: monthly est scaled to full-month equivalent by `days-in-month / sampled-days` (per-sensor coverage windows respected).
5. **VIIRS era**: `VIIRS_SNPP_Thermal_Anomalies_All` (500 m, since 2012-01); NOAA-20/NOAA-21 layers where archive permits.
6. **Harmonization meta**: overlap months (2012-01+), `meanRatioSNPPtoMODIS` (median monthly ratio), ratio CV, 5-row sample.
7. Regions: amazon, california, canada, siberia, congo, borneo, australia, mediterranean, **bangladesh** (team home region).

### build_regimes.mjs → `lib/ignis/regimePrototypes.json`

Feature vectors (peakMonth, seasonality, interannual CV, nightFraction, meanFrp, logMedianCount) computed per region from its calendar → nearest-prototype classification targets for the Burn Regime panel. (z-index bug on first build produced NaN similarities — fixed by aligning feature order between builder and classifier.)

## 2. Runtime layer

| Path | Source | Notes |
|---|---|---|
| `/api/hotspots` | FIRMS area API `area/csv/MODIS_NRT/...` + VIIRS NRT variants | DATE = window **start** (dayRange counts forward — verified empirically on production); satellite column splits Terra/Aqua; 30 s timeout for multi-MB MODIS CSVs |
| `/api/hotspots` fallback | GIBS MVT (server-parsed) | Transparent; response `source: "gibs-mvt"` + note |
| `/api/gibsfires` | GIBS WMTS vector → GeoJSON | Independent cross-check layer on the map |
| LST overlays | GIBS `MODIS_Terra_Land_Surface_Temp_Day/Night` (png @ GoogleMapsCompatible_Level7) | MOD11 V6 scaling: K = raw×0.02, ε = raw×0.02+0.49, fill = 0; legend documents it |

## 3. Known coverage edges (surfaced in UI, not hidden)

- GIBS VIIRS vector archive lags NRT (S-NPP → 2026-07, NOAA-20 → 2025-12) — affects fallback path only; FIRMS NRT is primary and live in production.
- GIBS thermal-anomaly layers are **vector-only** in epsg3857 (raster requests 400 — root cause of the historical tile errors; fixed by serving parsed MVT via `/api/gibsfires`).
- Pre-2012 rows are MODIS-scaled estimates (`scaled: true`); the UI marks them and shows the continuity ratio CV.

## 4. Hugging Face artifact

All 9 calendars + 9 outlooks + the build scripts ship as a versioned HF dataset with a full dataset card: **[Nabidnur/ignis-fire-calendar](https://huggingface.co/datasets/Nabidnur/ignis-fire-calendar)**. Re-running `build_calendar.mjs` against GIBS reproduces them (dates of sampled days are deterministic).
