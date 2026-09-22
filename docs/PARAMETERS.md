# IGNIS Algorithm & Parameter Reference

*Every tunable constant in the platform, grouped by subsystem, with the file
where it lives and why the value is what it is. Values are exactly as shipped —
nothing here is aspirational.*

---

## 1 · Harmonization layer — `src/lib/ignis/firms.ts`

The core of the challenge: making 20+ years of MODIS and VIIRS comparable.

| parameter | value | rationale |
|---|---|---|
| Sensor set | `MODIS-Terra, MODIS-Aqua, VIIRS-SNPP, VIIRS-NOAA20, VIIRS-NOAA21` | the five operating sensors with NRT FIRMS feeds |
| FIRMS NRT sources | `MODIS_NRT` (T/A), `VIIRS_SNPP_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT` | LANCE NRT collections |
| Confidence mapping (runtime) | VIIRS `l→30, n→60, h→90`; MODIS 0–100 kept | places both families on one 0–100 scale; training snapshot used `l→20, n→50, h→90` (documented in MODEL_CARDS) |
| Multi-day cache TTL | `10 min` | balances FIRMS politeness (5,000 tx / 10 min limit) against interactivity |
| Day clamp | requested day → `min(requestedDay, latest available)` | GIBS/FIRMS latency is ~T-1; future dates would 400 |
| Fallback chain | FIRMS area API → **GIBS MVT vector tiles** (FIRMS-derived, archive to 2000) → mixed | key-free operation with public NASA tiles when MAP_KEY is unset |
| GIBS archive floor | `MODIS-Terra → 2000-11`, per-sensor `GIBS_LATEST` table | MODIS record starts Nov 2000; VIIRS Jul 2012 |

**FRP / geometry units:** FRP in MW as distributed by FIRMS; lat/lon in WGS84
degrees; acquisition time normalized to UTC decimal hours from `HHMM` strings.

---

## 2 · Fire-complex segmentation engine — `src/lib/ignis/segmentation.ts`

Pure-TypeScript clustering that runs **in-browser** on every render
(<10 ms for ~10k points).

| parameter | value | rationale |
|---|---|---|
| Algorithm | grid-accelerated **DBSCAN** (cell-indexed neighbour queries, cell = eps) | O(n) neighbour lookup vs O(n²) brute force |
| Runtime `epsDeg` | `clamp(span/45, 0.14, 0.9)` degrees, `+2dp` | adaptive to region size; floor/ceiling keep behaviour sane for tiny/huge viewports |
| Runtime `minPts` | `3` | a complex needs ≥3 co-located detections to be a coherent fire |
| Training contract | StandardScaler-space **eps 0.12 ≈ 0.045°**, **minPts 6** | used by all model training (labels/labels-consistency); snapshot noise ratio 0.83%, silhouette 0.178 |
| Hull algorithm | **Andrew's monotone chain** convex hull, open ring | deterministic, O(n log n), no deps |
| Area / perimeter | shoelace on **equirectangular km projection** at cluster latitude; `R_EARTH = 6371 km` | ~5% accuracy is ample for cluster stats; exact geodesics unnecessary |
| Cluster metrics | `radiusKm` (mean member→centroid), `spreadKm`, `areaKm2`, perimeter, mean/max FRP, hi-conf %, night %, class votes | the per-complex dossier |
| Behaviour classes | `MEGAFIRE / ESTABLISHED / EMERGING / SCATTERED` | map-readable taxonomy; scattered = unclustered count |
| GeoJSON emission | `Polygon` rings closed (`hull + hull[0]`) | direct Leaflet/GeoJSON source compatibility |

---

## 3 · Fire classifier runtime — `src/lib/ignis/inference.ts`

| parameter | value | rationale |
|---|---|---|
| Density grid cell | `0.01°` | matches training feature grid |
| Density radii | `[0.05, 0.25, 1.0]°` ≈ 5.5 / 28 / 110 km | multi-scale neighbourhood context |
| Density estimator | **integral-image** box count × area-ratio | O(1) per query after O(n) build; identical math to training |
| Ensemble | 40 Extra-Trees × depth 12; mean of per-tree class probabilities | see MODEL_CARDS §2 |
| Node format | `[featIdx, threshold, left, right, probs[5]]`, featIdx −1 = leaf | compact JSON, array-walk inference |
| FRP feature | `log10(1 + FRP)` | heavy right tail; 500 MW → 2.7 |

---

## 4 · Footprint forecaster runtime — `src/lib/ignis/forecast.ts`

| parameter | value | rationale |
|---|---|---|
| Grid | **0.05°** cells (~5.5 km) | matches MODIS thermal resolution scale |
| KDE bandwidths | `0.10°, 0.35°, 0.80°` → σ in cells = bw / 0.05 | multi-scale plume persistence |
| Gaussian filter | separable, kernel radius `4σ`, edge mode ≈ `nearest` | same smoothing family as `scipy.ndimage.gaussian_filter` used in training |
| Prior window | **≤ 4 days** | captures multi-day fire persistence without stale signals |
| v2 feature contract | scene-max-normalized KDEs → `log1p` | source-density & day-window agnostic (v1 shift fixed) |
| Footprint threshold | **p ≥ 0.5** | precision-oriented operating point (IoU-optimal in validation) |
| High-confidence | **p ≥ 0.85** | the "almost certainly burning tomorrow" core |
| Cell cap | **8,000** top-by-probability | keeps Leaflet canvas overlay at 60 fps |
| Latency | ~600 ms client-side | no server round-trip |

---

## 5 · Event detector runtime — `src/lib/ignis/eventModel.ts`

| parameter | value |
|---|---|
| Extreme definition | monthly detections **z ≥ 2** vs 2000–2021 climatology, per region-month |
| Climatology baseline | train years **≤ 2021** only (no leakage into the recent test years) |
| Model | Logistic Regression, standardized features, sigmoid in TS |
| Intercept | −1.4853 |
| Decision threshold | 0.5 |
| Month encoding | `msin = sin(2πm/12)`, `mcos = cos(2πm/12)` |
| Regions one-hot | 9 (`amazon, california, canada, siberia, congo, borneo, australia, mediterranean, bangladesh`) |

---

## 6 · Burn-scar / LST context — `MethodologyPanel` + GIBS rasters

| parameter | value | rationale |
|---|---|---|
| Default basemap | GIBS **7-2-1 false color** (bands 7-2-1, JPEG, Level 9) | active fires glow magenta, burn scars deep red |
| True-color alternatives | `MODIS_Terra_CorrectedReflectance_TrueColor`, `VIIRS_SNPP_CorrectedReflectance_TrueColor` (Level 9, daily) | 1 km / 375 m daily views |
| Static layers | Blue Marble shaded relief (Level 8), coastlines & labels (Level 13) | reference furniture |
| LST guidance (MODIS V6) | LST scale 0.02 K, emissivity scale 0.02 + offset 0.49, fill = 0; QA bit-packed, decoded right→left | LP DAAC MOD11/MYD11 official processing rules |
| LST product ladder | MOD11_L2/MYD11_L2 swaths → MOD11A1 daily → MOD11A2 8-day → MOD11B3 monthly | documented in-app in the Methodology screen |

---

## 7 · Emissions model — `scripts/hf_model/build_exports.py` → `data/ignis/analysis/ignis_emissions_estimates.csv`

First-order FRE proxy, calibrated and fully cited:

```
frp_scaled_monthly (MW) = est_detections × meanFrp        # sampled → monthly scaling
FRE_month (MJ)          = frp_scaled × τ,   τ = 1800 s    # effective burn window / detection
DM (kg)                 = FRE × 0.223 kg/MJ               # Wooster et al. 2005
CO2 (kg)                = DM × 1.613                      # Andreae & Merlet 2001
```

| parameter | value | rationale |
|---|---|---|
| τ (effective burn window) | **1800 s** | bounds: 60 s (overpass dwell) < τ < 3 h (persistence); 30 min reconciles Amazon-2024 with published basin totals (~380 Mt CO₂, GFED4-class) |
| FRE→dry-matter coefficient | **0.223 kg/MJ** | Wooster et al. (2005) |
| DM→CO₂ coefficient | **1.613** | Andreae & Merlet (2001) |
| Units emitted | FRE TJ (= MJ/10⁶), DM kt, CO₂e Mt | table columns `fre_proxy_tj, dry_matter_kt, co2e_mt` |
| Coverage | 9 regions × 2000–2025 monthly | derived from the harmonized calendar |

---

## 8 · Regions — `src/lib/ignis/regions.ts`

| region | bbox [W, S, E, N] |
|---|---|
| Amazon Basin | [-74, -12, -46, 2] |
| California / US West | [-125, 32, -114, 42] |
| Boreal Canada | [-140, 52, -95, 70] |
| Eastern Siberia | [100, 50, 145, 70] |
| Congo Basin | [8, -8, 32, 8] |
| Borneo & Sumatra | [95, -6, 120, 6] |
| Australia | [112, -42, 154, -10] |
| Mediterranean Basin | [-8, 30, 32, 46] |
| **Bangladesh** | [88.0, 20.6, 92.9, 26.7] |

**Bangladesh AOIs:** all Bangladesh [88.0, 20.6, 92.9, 26.7] · Sundarbans
[88.0, 21.5, 89.9, 22.9] · Rajshahi crop belt [88.0, 24.0, 89.8, 25.6] ·
Dhaka–Gazipur [90.0, 23.6, 90.9, 24.4] · Chattogram–Cox's Bazar
[91.5, 20.7, 92.7, 22.8] · Sylhet hills [91.3, 23.9, 92.7, 25.4].

---

## 9 · Platform & delivery

| parameter | value |
|---|---|
| Map container height | `clamp(600px, calc(100vh − 275px), 880px)` — bigger on desktop, never oversized |
| FRP color ramp | logarithmic, breakpoints 0 / 25 / 120 / 500+ MW, white core at FRP ≥ 150 MW, radius ∝ √FRP |
| Hull stroke classes | MEGAFIRE `#FCA5A5` (2.4 px) · ESTABLISHED orange · EMERGING `#FDE047` (1.4 px) |
| Hydration-safe styles | module-level precomputed gradient constants, `backgroundImage` (no shorthand) |
| Deployment | Vercel production, Node 24.x, region iad1, Turbopack builds |
| Health probe | `/api/health` → FIRMS status, api.nasa.gov APOD, GIBS tile, HF whoami, EDL token decode, DB |
| AI analyst | chat-only via HF inference; every claim grounded in live API data (no runtime LLM calls in the data path) |
