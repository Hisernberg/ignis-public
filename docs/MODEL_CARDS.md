# IGNIS Model Cards — the trained model family

*Every model below is trained on real NASA FIRMS (LANCE) harmonized MODIS+VIIRS
detections and ships inside the app. Weights are exported to JSON so inference
runs deterministically in TypeScript (no Python, no network calls) at
interactive latency. Training scripts live in `scripts/models/`, runtime
weights in `src/lib/ignis/*.json`, and full training/metrics snapshots in
`data/ignis/analysis/metrics.json`.*

---

## Family overview

| # | Model | Kind | Algorithm (shipped) | Runtime location | Latency |
|---|-------|------|--------------------|------------------|---------|
| 1 | **ignis-fire-segmenter** | Per-pixel active-fire segmentation of GIBS 7-2-1 imagery + boundary vectorization | RandomForest (60 trees, depth 16) | `scripts/models/train_fire_segmenter.py` → server-side joblib | < 1 s/tile set |
| 2 | **ignis-fire-classifier** v2.0.0 | Per-detection fire-behavior classification (5 classes) | Extra-Trees, 40 trees × depth 12, JS-native | `src/lib/ignis/inference.ts` + `classifierWeights.json` | ~ms per detection batch |
| 3 | **ignis-event-detector** v1.0.0 | Next-month extreme fire-month likelihood | Logistic Regression (16 standardized features) | `src/lib/ignis/eventModel.ts` + `eventWeights.json` | ~0 (deterministic) |
| 4 | **ignis-fire-footprint-forecaster** v2.0.0 | Next-day 0.05° fire-footprint probability field | Logistic-Regression twin + separable Gaussian KDE field | `src/lib/ignis/forecast.ts` + `forecasterWeights.json` | ~600 ms client-side |
| 5 | **ignis-fire-regime** | Region fire-regime profiling & family matching | Nearest-prototype matching + k-means (k=6) regime families | `src/lib/ignis/regions.ts` + `regimePrototypes.json` | ~0 (deterministic) |

**Shared training data contract.** All models consume the *harmonized*
detection table — five sensors (MODIS Terra/Aqua, VIIRS S-NPP/NOAA-20/NOAA-21)
normalized to one schema: confidence harmonized to 0–100, FRP in MW, acquisition
time in UTC hours, per-detection sensor flags. The v2 snapshot (2026-09-16 → 20)
contains **138,118 detections** across Amazon/Congo/Borneo
(43,520 VIIRS-S-NPP · 43,161 NOAA-20 · 40,957 NOAA-21 · 6,211 Aqua · 4,269 Terra).

> **Confidence-harmonization note (honest calibration history).** VIIRS reports
> confidence categorically (`l/n/h`). The runtime proxy maps `l→30, n→60, h→90`
> (`src/lib/ignis/firms.ts`); the training snapshot that fed models 1–4 used the
> earlier `l→20, n→50, h→90` calibration (`data/ignis/analysis/metrics.json`).
> The models are trained consistently within their snapshot; we document the
> delta rather than silently changing either side.

---

## 1 · ignis-fire-segmenter — fire-pixel segmentation on 7-2-1 imagery

**Task.** Segment *active fire pixels* directly in NASA GIBS **7-2-1 false-color
imagery** (MODIS Terra bands 7-2-1, where fires glow magenta/pink) and
vectorize the boundaries — i.e., see fires the way the satellite sees them, not
just as CSV points.

**Algorithm & hyperparameters** (`scripts/models/train_fire_segmenter.py`):

```python
RandomForestClassifier(
    n_estimators=60, max_depth=16, max_features=3,
    class_weight='balanced_subsample',
    n_jobs=-1, random_state=42,
)
```

- **Input tiles:** GIBS WMTS EPSG:3857, zoom **Z=7**, processed as **256×256 px**
  patches (`TS=256`); RGB normalized to [0,1].
- **Features:** per-pixel spectral context of the 7-2-1 composite — SWIR contrast
  between the pixel neighborhood and the scene, channel ratios and local means
  via `scipy.ndimage.uniform_filter`.
- **Label quality control (the honest way):**
  - only **daytime** detections (visible in ~10:30 local Terra overpass);
  - only tiles where the SWIR contrast at fire pixels proves the fire signature
    is actually visible — **visibility gate** `vis = R_fire_mean − R_scene_mean ≥ 0.05`;
  - FIRMS detections (buffered) act as positive labels; sampled background as negatives.
- **Evaluation:** **leave-one-EVENT-out** across 6 region-years on 3 continents —
  i.e., the model is scored on fires it has never seen from entirely different
  events, a cross-continental generalization test. Smoke/cloud degradation is
  reported per event rather than averaged away.
- **Boundary vectorization:** connected-component masks → `skimage.measure`
  contours → GeoJSON polygons (WGS84), served to the map as an overlay.

**Where it runs in the app:** the segmentation overlay on the fire map —
pixel-true fire shapes with vector boundaries, served via the
`/api/gibsfires` pipeline.

---

## 2 · ignis-fire-classifier v2.0.0 — per-detection fire behavior

**Task.** Classify *every detection* into one of five behavior classes so the
map reads like a field report, not a heat scatter.

**Classes:** `EMERGING` · `ESTABLISHED` · `ISOLATED` · `MEGAFIRE` · `SCATTERED`

**Weak-supervision design.** Human labels don't exist at detection granularity.
Labels are generated **physically**: DBSCAN complex statistics (per-detection
FRP ratio to complex mean, local density, night share, complex size) are folded
into rule-based behavior labels, then a supervised model learns the mapping —
so at runtime the physical rule set is replaced by a learned ensemble that also
captures interactions the rules miss.

**Features (9):**

| feature | meaning |
|---|---|
| `log_frp` | log₁₀(1+FRP), fire radiative power in MW |
| `confidence_harmonized` | 0–100, MODIS numeric kept / VIIRS l-n-h mapped |
| `is_night` | overpass at night (1/0) |
| `acq_hour` | UTC acquisition hour |
| `is_viirs` | sensor family flag (VIIRS vs MODIS) |
| `dens_5km` / `dens_25km` / `dens_100km` | neighbour detection density at ~5.5 / ~28 / ~110 km |
| `frp_ratio` | detection FRP ÷ mean FRP of its complex |

**Shipped ensemble:** Extra-Trees **40 trees × depth 12** (`et40_d12`), selected
from candidates `{et15_d8, et25_d10, et40_d12, et25_d8_leaf20}` on held-out day
agreement. **HistGradientBoosting reference** (`max_iter=200, max_depth=6,
learning_rate=0.1`) tracked but not shipped — it scored higher offline but does
not export to deterministic JS inference.

**Skill:**

| metric | value |
|---|---|
| held-out **day** agreement (shipped ET-40/12) | **0.685** |
| HGB reference test accuracy | 0.763 |

*Held-out day agreement is deliberately stricter than random row splits: entire
acquisition days are held out, so the model can't memorize a day's spatial
footprint.*

**Runtime parity.** `src/lib/ignis/inference.ts` recomputes features with
parameters identical to training: density grid `CELL = 0.01°`, box radii
`[0.05, 0.25, 1.0]°` via **integral-image** box counts × area-ratio. Tree nodes
export as `[featIdx, threshold, left, right, probs[]]`; voting is a mean over
per-tree class probabilities. Bundle size ~2.6 MB, loaded once server-side.

**Where it runs in the app:** per-detection behavior badges on the map, and the
Cluster Lab's cluster-level majority votes (which behavior dominates each
segmented complex).

---

## 3 · ignis-event-detector v1.0.0 — extreme fire-month outlook

**Task.** For each of the 9 regions, output **P(next month is an extreme fire
month)**, where *extreme* = unified monthly detections **z ≥ 2** against that
region-month's **2000–2021 climatology**.

**Shipped model:**

```python
LogisticRegression(C=1.0, max_iter=2000, class_weight='balanced')
```

on StandardScaler-normalized features. Weights (`coef`, `scaler_mean`,
`scaler_scale`, `intercept = −1.4853`) export to JSON; inference is a
deterministic sigmoid in TypeScript — zero network cost, fully auditable.

**HistGradientBoosting reference** (`max_iter=150, max_depth=4,
learning_rate=0.08`) is trained alongside as a skill ceiling; the shipped
logistic model was kept for interpretability and exact JS parity.

**Features (16):** `est_lag1, est_lag3, est_lag12` (detection-count lags),
`frp_lag1` (prior-month total FRP), `hic_lag1` (hi-confidence share lag),
`night_lag1` (night-fraction lag), `msin, mcos` (month phase encoding), and 9
region one-hots (`r_amazon … r_bangladesh`).

**Data & split:** 2,178 train / 504 test region-months (test = recent years,
positives 11.2% train / 32.7% test). Decision threshold 0.5.

**Skill:**

| model | AUC | AP | F1 | Brier |
|---|---|---|---|---|
| **LogReg (shipped), test** | **0.652** | 0.480 | 0.524 | 0.333 |
| LogReg, train | 0.872 | 0.407 | 0.470 | 0.153 |
| HGB reference, test | **0.740** | **0.606** | 0.543 | 0.192 |

**Where it runs in the app:** the Outlook panel — per-region P(extreme) for the
coming month with the climatology baseline made explicit.

---

## 4 · ignis-fire-footprint-forecaster v2.0.0 — next-day probability field

**Task.** Predict **tomorrow's fire footprint as a probability field on a
0.05° grid (~5.5 km cells)** from the prior days' detection density — a
forward-looking map layer, not just a count forecast.

**Labels (training):** a cell is positive iff it falls inside **any DBSCAN
complex hull of the target day** (the app's own segmentation engine, training
contract: StandardScaler space, eps 0.12, minPts 6, convex hull rasterized) —
so the forecaster learns to predict the *segmentation*, not raw points.

**Features (10):** Gaussian-KDE detection densities at three bandwidths
(`kde_0.10_n, kde_0.35_n, kde_0.80_n` degrees), FRP-weighted KDE
(`frp_kde_0.35_n`), yesterday's and the day-before KDE (`kde_lastday_n,
kde_prevday_n`), normalized position (`lon_n, lat_n`), and day-of-year phase
(`doy_sin, doy_cos`).

**v2 feature contract (the key fix).** Densities are **scene-max-normalized**
then `log1p` — `density / max(density)` per region-target-day grid. v1 raw KDEs
scaled with prior-day detection counts and source density (43–49% of cells
above p=0.5 in production — distribution shift). The v2 contract is
source-density and day-window agnostic; the shipped twin was retrained under
exactly this contract.

**Shipped model:** Logistic-Regression **portable twin** (coef + scaler +
intercept in JSON). HGB reference retained for comparison.

**Skill (IoU on held-out target days vs persistence baseline = yesterday's
footprint):**

| region | LR twin IoU | precision | recall | persistence IoU |
|---|---|---|---|---|
| Amazon | **0.583** | 0.643 | 0.862 | 0.355 |
| Congo | **0.551** | 0.873 | 0.599 | 0.388 |
| Borneo | **0.423** | 0.424 | 0.997 | 0.378 |
| *HGB reference, Amazon* | *0.645* | 0.844 | 0.733 | — |

**Runtime (`src/lib/ignis/forecast.ts`):** separable Gaussian filter (kernel
radius 4σ, `scipy.ndimage.gaussian_filter(mode='nearest')` equivalence),
≤ 4-day prior window, probability computed per cell, footprint = cells with
**p ≥ 0.5**, high-confidence = **p ≥ 0.85**, capped at **8,000 cells** (top by
probability). Runs client-side in **~600 ms** — no server round-trip.

**Documented caveat (shipped in weights JSON):** the same-day-early density
feature is approximated with the last-available-day KDE in production.

**Where it runs in the app:** the 🔮 **ML forecast** map toggle — a
probability-graded risk-field overlay beneath the segmentation hulls — plus the
Daily Dynamics forecaster card (predicted vs high-confidence cells, top-cell
alignment with actual detections, held-out skill shown next to the live score).

---

## 5 · ignis-fire-regime — region fire-regime profiles

**Task.** Characterize *how* each region burns (not how much) and place each
region in a family of comparable fire regimes.

**Prototype features (6):** `peakMonth`, `seasonality` (peak/trough ratio of the
monthly climatology), `interannualCV`, `nightFraction`, `meanFrp`,
`logMedianCount`.

**Region prototypes (8):** Amazon Basin, California/US West, Boreal Canada,
Eastern Siberia, Congo Basin, Borneo & Sumatra, Australia, Mediterranean Basin
— each with a written regime note (e.g. Amazon: *"Deforestation-driven fire
regime: dry-season (Aug–Oct) ignition front along the agricultural frontier;
large, hot, day-dominant detections."*)

**Regime families:** k-means over the unified detection table yields **k=6**
families (chosen on silhouette stability). The v2 snapshot profile
(`data/ignis/analysis/metrics.json`):

| family | n | mean FRP (MW) | mean conf | night frac | mean hour |
|---|---|---|---|---|---|
| 0 | 42,105 | 8.86 | 58.7 | 0.00 | 11.2 |
| 1 | 8,835 | 7.81 | 62.0 | **1.00** | 13.4 |
| 2 | 8,182 | **81.32** | 67.8 | 0.13 | 11.5 |
| 3 | 23,414 | 21.60 | 63.6 | 0.04 | 11.2 |
| 4 | 35,743 | 3.99 | 55.9 | 0.00 | 11.4 |
| 5 | 19,839 | 1.74 | 60.0 | **1.00** | 10.9 |

*(e.g. family 2 = large, hot, day-dominant deforestation fires; families 1/5 =
night-dominant agricultural burning.)* Clustering quality: silhouette 0.178,
noise ratio 0.83%.

**Where it runs in the app:** the Burn Regime panel — a live radar of the
currently viewed region against its prototype, plus family assignment.

---

## Reproducibility

| artifact | location |
|---|---|
| training scripts (all 5 models) | `scripts/models/train_*.py` |
| portable-twin trainers (classifier, forecaster) | `scripts/models/train_*_portable.py` |
| twin validation harness | `scripts/models/validate_twin.py`, `diag_twin.py` |
| runtime weights | `src/lib/ignis/classifierWeights.json`, `eventWeights.json`, `forecasterWeights.json`, `regimePrototypes.json` |
| v2 metrics snapshot | `data/ignis/analysis/metrics.json` |
| HF model repos (weights + cards) | `huggingface.co/Nabidnur/ignis-*` (private during judging) |

```bash
pip install scikit-learn pandas numpy scipy scikit-image pillow joblib
python scripts/models/train_event_detector.py          # ~1 min
python scripts/models/train_classifier_portable.py     # ~3 min
python scripts/models/train_forecaster_portable.py     # ~3 min
python scripts/models/train_fire_segmenter.py          # ~10 min (fetches GIBS tiles)
```

All trainers fetch labels through the **IGNIS harmonization proxy → NASA FIRMS
(LANCE) NRT**; no manual data wrangling is required.
