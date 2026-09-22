# IGNIS — Submission Package & Checklist

## 1. Submission artifacts

| Artifact | Where | Status |
|---|---|---|
| Working application | https://ignis-spaceapps2026.vercel.app | ✅ production |
| Public repo | github.com/Hisernberg/ignis-spaceapps2026 (make public at submission if required) | ✅ |
| Hugging Face artifact (calendars + scripts + dataset card) | huggingface.co/datasets/Nabidnur/ignis-fire-calendar | ✅ |
| Demo video (≤ 3 min) | follow the script below | ⬜ record |
| Project page description | paste "What it is / Why / How" section below | ✅ drafted |
| Team info | Team IGNIS · Bangladesh 🇧🇩 | ✅ |

## 2. One-paragraph pitch (paste into project page)

> IGNIS turns NASA's split fire record — MODIS 1 km since 2000, VIIRS 375 m since 2012 — into one harmonized 26-year Burning Activity Calendar, then makes it operational: an early-warning map where hotspots are segmented into boundary-identified fire clusters (DBSCAN + convex hulls), tracked day-over-day as persistent systems, cross-validated MODIS↔VIIRS in one chart, and briefed by a grounded AI analyst that writes incident-style SITREPs with a zero-hallucination guard and a deterministic offline fallback. Built by Team IGNIS from Bangladesh, where crop-residue fire smoke drives Dhaka's winter air-quality crisis — the challenge, applied at home.

## 3. Demo video script (3:00)

| Time | Shot | Narration beat |
|---|---|---|
| 0:00–0:20 | 7-2-1 false-color map, Amazon, replay running | "NASA sees Earth's fires with two instruments, two scales, two eras. Ask MODIS and VIIRS about the same landscape and you get two different answers." |
| 0:20–0:45 | KPI strip + sensor chips | "IGNIS fuses all five sensors — Terra, Aqua, S-NPP, NOAA-20, NOAA-21 — into one harmonized calendar, 26 years, with an honest continuity coefficient and uncertainty." |
| 0:45–1:20 | Fire Cluster Lab: hulls on map, cluster table, front ratio | "Raw points become fire objects: DBSCAN segmentation draws boundary hulls, classifies megafire vs emerging clusters, measures spread and fire-front elongation." |
| 1:20–1:50 | Persistence table + Daily Dynamics + cross-validation scatter | "Persistent systems are tracked across the replay window with FRP trends. The MODIS-VIIRS scatter shows the exact harmonization gap this challenge asks about." |
| 1:50–2:20 | SITREP generation | "And the AI analyst briefs you — grounded in live telemetry, every number traceable, with a deterministic fallback so it never hallucinates and never goes down." |
| 2:20–2:45 | Bangladesh spotlight | "From Bangladesh, where residue-burning smoke chokes Dhaka every Boro season, we ran the same pipeline end-to-end on our home region." |
| 2:45–3:00 | Status rail + GitHub/HF links | "Open data, deterministic science, honest AI. IGNIS — one record, ready for responders." |

## 4. What previous winners did (and how IGNIS aligns)

Pattern analysis of recent global winners (2023–2025: e.g. FractalNet, Canaria, Scintilla, L.I.V.E. Glacier Project, Kid on the Moon) and official judging criteria (**Influence, Creativity, Validity, Relevance, Presentation**):

| Winner pattern | IGNIS alignment |
|---|---|
| A crisp one-sentence "thing" (calendar, glacier lifelog, meteor storytelling) | ✅ "The 26-year Burning Activity Calendar" — the product IS the harmonization answer |
| Real, deep NASA data — not a thin API wrapper | ✅ 26-yr precomputed record from raw GIBS vector archive + dual-path live pipeline + MOD11 scaling done to LP DAAC spec |
| Quantified, honest science (uncertainties visible) | ✅ continuity ratio CV, R², z-anomalies, per-panel provenance, coverage-lag surfacing |
| Working deployed product at judging time | ✅ Vercel production, status rail proves upstream health |
| Creativity beyond the brief | ✅ segmentation/boundary identification, persistence tracking, SITREP mode, front-ratio metric |
| Presentation: video + narrative + storytelling | ⬜ record video (script above) |
| Influence: who uses it, for what | ✅ responder-facing SITREP/early-warning framing + Bangladesh AQ-relevance; strengthen with a "who uses this" line in pitch |

**Competitive note:** at least one other 2026 team is pitching AI-MODIS/VIIRS harmonization for this challenge. IGNIS's defensible differentiators: the precomputed 26-year calendar product, deterministic in-browser segmentation (not a black box), persistence tracking, and the honesty/fallback architecture. Lead with these.

## 5. Pre-submission checklist

- [x] Hydration errors: 0 (longhand CSS props, no SSR/client drift)
- [x] GIBS 400s: 0 (vector-only layers parsed server-side; correct TileMatrix levels)
- [x] Future-date tiles: clamped to yesterday; date picker bounded
- [x] TypeScript: 0 errors in src/; production build green
- [x] All AI features verified with loaded data + fallback verified offline
- [x] README + docs + LICENSE + CI
- [x] HF dataset card + artifact upload
- [x] Judge self-review (see JUDGE_SCORECARD.md)
- [ ] Make repo public (if rules require) at submission window
- [ ] Record 3-min video
- [ ] Submit on spaceappschallenge.org project page with links

## v5 addendum — Open Science package (2026-09-21)

- 🤗 **Model:** https://huggingface.co/Nabidnur/ignis-fire-regime-model — DBSCAN+KMeans fire-complex
  segmenter trained on 138,118 real FIRMS NRT detections (Amazon + Congo + Borneo, 5 days, 5 sensors):
  63 complexes, 0.83% noise, 4 megafires; joblib weights + full training script + training snapshot + metrics card.
- 🤗 **Dataset v2:** https://huggingface.co/datasets/Nabidnur/ignis-fire-calendar — adds `analysis/`:
  long-format 26-yr calendar CSV (5,022 rows), 9-region regime matrix, calibrated FRE→CO₂e emissions
  (τ=1800 s; Amazon-2024 ≈ 322 Mt vs published ≈ 380 Mt), 50-complex live inventory.
- In-app **🤗 Open Science** tab (8th screen): live Hub status, file inventories, 4-way HF stack, datasets-server preview.
- Security note: GitHub auto-revoked the repo PAT (secret scanning) when the repo was made public; all
  credential literals except the runtime `keys.ts` fallbacks were scrubbed from tracked files.
