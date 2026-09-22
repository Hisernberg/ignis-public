# IGNIS — Finalized Plan (quick reference)

Full design: `docs/deliverables/02_IGNIS_finalized_master_plan.pdf` · Challenge analysis: `01_IGNIS_challenge_analysis.pdf`.

- **Challenge:** #09 Harmonization of MODIS and VIIRS Hot Spots (fallbacks: #02 Trend Detective, #06 Dancing with the SARs)
- **Build:** Next.js 16 + MapLibre + Recharts; API routes `/api/hotspots|calendar|outlook|eonet|health`; FIRMS primary + GIBS MVT fallback; HF MiniLM on-device triage; zero runtime chat-LLM deps
- **Data:** 8 regional 25-year calendars + 8 seasonal outlooks precomputed from GIBS WMTS vector archive (scripts/ignis/)
- **Deploy:** Vercel, env from secrets/.env; verify /api/health shows firms.ok true
- **Pitch (30 s):** MODIS watched Earth burn for 25 years; VIIRS split the record in two → IGNIS unites them into one harmonized calendar with a continuity coefficient, live detections, seasonal outlook and semantic early warning. "Two NASA missions, one calendar."
- **Runbook:** docs/AUTOMATION_RUNBOOK.md (chat-executable phases 0–8)

---

## STATUS UPDATE — IGNIS v2 SHIPPED & DEPLOYED (2026-09-21)

Production: https://ignis-spaceapps2026.vercel.app · Repo: Hisernberg/ignis-spaceapps2026 @ 7ff35d9

| Portion | Status |
|---|---|
| P0 Keys on production | DONE — env-first + embedded fallback; health 7/7 OK |
| P1 5-sensor live harmonization | DONE — FIRMS primary (verified firms-api on prod), GIBS MVT archive fallback |
| P2 Burning Activity Calendar | DONE — unified harmonized 26-yr heatmap + per-sensor + FRP views, unusual-month rings |
| P3 Time-series lab | DONE — climatology, z-anomalies, Theil-Sen, CUSUM, decomposition |
| P4 Prediction | DONE — harmonic-regression 12-mo outlook + Open-Meteo 7-day fire-weather early warning |
| P5 Classification | DONE — 8-region nearest-prototype burn-regime classifier |
| P6 Map experience | DONE — FRP gradient/hot-core/heatmap/hexbin, 4 GIBS basemaps date-synced, overlays, EONET markers, shift-drag AOI, 7-day replay, popups |
| P7 Interactive AI | DONE — grounded HF Llama-3.1-8B analyst + MiniLM triage + NAVIGATE actions to map |
| P8 NASA-emphasis | DONE — methodology tab, sensor arsenal, provenance, citations, snapshot/CSV export |

Known limits (surfaced honestly in UI): GIBS vector archive lag (S-NPP → 2026-07, NOAA-20 → 2025-12) affects fallback path only; FIRMS NRT is primary and live.
