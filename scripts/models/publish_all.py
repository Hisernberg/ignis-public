#!/usr/bin/env python3
"""Publish the IGNIS model family to private Hugging Face model repos with full model cards."""
import os, json, pathlib, shutil
from huggingface_hub import HfApi

WS = pathlib.Path('/home/z/my-project')
HF_TOKEN = (WS / 'vault/hf/token.txt').read_text().strip()
api = HfApi(token=HF_TOKEN)
OUT = WS / 'scripts/models/out'
STAGE = WS / 'scripts/models/stage'
if STAGE.exists():
    shutil.rmtree(STAGE)

MODELS = [
    dict(repo='Nabidnur/ignis-fire-classifier',
         src=OUT / 'ignis-fire-classifier',
         files=['ignis_fire_classifier.joblib', 'ignis_fire_classifier_logreg.joblib', 'metrics.json', 'labeled_sample.csv'],
         scripts=['train_classifier.py'],
         card='classifier_card.md'),
    dict(repo='Nabidnur/ignis-event-detector',
         src=OUT / 'ignis-event-detector',
         files=['weights.json', 'ignis_event_detector.joblib', 'ignis_event_detector_hgb_reference.joblib', 'live_scores.json'],
         scripts=['train_event_detector.py'],
         card='event_card.md'),
    dict(repo='Nabidnur/ignis-fire-footprint-forecaster',
         src=OUT / 'ignis-fire-footprint-forecaster',
         files=['ignis_fire_footprint_forecaster.joblib', 'metrics.json'],
         scripts=['train_footprint_forecaster.py'],
         card='forecaster_card.md'),
]

CARDS = {}
CARDS['classifier_card.md'] = """---
license: mit
library_name: scikit-learn
tags:
- nasa-space-apps-2026
- ignis
- fires
- firms
- weak-supervision
- fire-behavior
datasets:
- Nabidnur/ignis-fire-calendar
language: en
---
# IGNIS Fire Classifier (fire-behavior, weakly supervised)

Per-detection fire-behavior classification for the IGNIS platform (NASA Space Apps 2026,
challenge #9 — Harmonization of MODIS and VIIRS Hot Spots). **PRIVATE during judging.**

## Task
Classify each FIRMS hotspot detection into a fire-behavior class:

`ISOLATED · SCATTERED · EMERGING · ESTABLISHED · MEGAFIRE`

## Weak supervision (honest labeling)
Labels come from the IGNIS unsupervised segmentation engine (grid-accelerated DBSCAN,
StandardScaler space, eps 0.12 / minPts 6 — the same engine as the in-app Fire Cluster
Lab). Complexes are graded by size and summed FRP; unclustered detections are ISOLATED.
A supervised model then learns to reproduce the behavior classes directly from
per-detection features, enabling zero-latency classification of new detections.

## Training data
138,118 real FIRMS detections (MODIS Terra/Aqua + VIIRS S-NPP/NOAA-20/NOAA-21),
Amazon + Congo + Borneo, 2026-09-16 → 2026-09-20. Temporal split: first 4 days train,
last day (2026-09-20) fully held out.

## Features
`log1p(FRP) · harmonized confidence · is_night · acq_hour · is_viirs ·
local density at 5 km / 28 km / 110 km · FRP ratio vs region-day median`

## Metrics (held-out day)
| metric | value |
|---|---|
| accuracy | 0.75 |
| macro-F1 | 0.55 |
| majority-class baseline acc | 0.62 |

Class imbalance and day-to-day fire-regime shift make this a hard task; per-class
confusion is in `metrics.json`. The model is intended as a fast prior, not a replacement
for the full segmentation pass.

## Usage
```python
import joblib
b = joblib.load('ignis_fire_classifier.joblib')
X = [[log1p_frp, confidence, is_night, acq_hour, is_viirs, dens_5km, dens_25km, dens_100km, frp_ratio]]
print(b['classes'][b['model'].predict(X)[0]])
```

## Provenance & license
Data: NASA FIRMS (public domain). Code: MIT. Trained by team IGNIS (Hisernberg / Nabidnur).
"""

CARDS['event_card.md'] = """---
license: mit
library_name: scikit-learn
tags:
- nasa-space-apps-2026
- ignis
- fires
- early-warning
- extreme-events
datasets:
- Nabidnur/ignis-fire-calendar
language: en
---
# IGNIS Event Detector (monthly extreme-fire-month early warning)

Predicts whether **next month** will be an extreme fire month for a region
(z >= 2 vs the 2000-2021 climatological month). Built on the 25-year harmonized
MODIS+VIIRS calendars (9 regions, 2000-11 → 2026-09). **PRIVATE during judging.**

## Label
Next-month unified detections ≥ climatological month mean + 2σ
(climatology computed on training years only, per region-month — no leakage).

## Features (all lagged)
`est lag1 · lag3 mean · lag12 same-month · FRP lag1 · high-confidence share lag1 ·
night share lag1 · month sin/cos · region one-hot (9 regions)`

## Metrics (2022-2026 temporal holdout — includes the record 2023-24 fire years)
| model | AUC | PR-AUC | F1 | Brier |
|---|---|---|---|---|
| LogisticRegression (shipped, portable) | 0.652 | 0.480 | 0.524 | 0.333 |
| HistGradientBoosting (reference) | **0.740** | **0.606** | 0.543 | 0.192 |

The 2022-2026 holdout is deliberately hard (32.7% positive rate vs 11.2% in training).

## Portable weights
`weights.json` contains the scaler + logistic coefficients so the IGNIS web app scores
events deterministically in TypeScript (no server round-trip).

## Usage
```python
import joblib
b = joblib.load('ignis_event_detector.joblib')
p = b['model'].predict_proba(b['scaler'].transform([features]))[0, 1]  # P(extreme next month)
```

## Provenance & license
Data: NASA FIRMS via the IGNIS harmonization pipeline (public domain). Code: MIT.
"""

CARDS['forecaster_card.md'] = """---
license: mit
library_name: scikit-learn
tags:
- nasa-space-apps-2026
- ignis
- fires
- segmentation
- fire-growth
- forecast
datasets:
- Nabidnur/ignis-fire-calendar
language: en
---
# IGNIS Fire-Footprint Forecaster (segmentation-based fire-growth model)

Predicts **tomorrow's fire-complex footprint** as a per-cell probability field from the
previous days' detection density — forward-looking segmentation of fire complexes.
**PRIVATE during judging.**

## Why this model
The IGNIS app segments same-day fire complexes with DBSCAN + convex-hull boundaries.
This model extends that into the future: a supervised, cell-wise (0.05° ≈ 5.5 km)
segmenter that learns where complexes grow, persist and collapse.

## Data
138,118 harmonized FIRMS detections — Amazon, Congo, Borneo — 2026-09-16 → 20,
all five sensors (MODIS Terra/Aqua, VIIRS S-NPP/NOAA-20/NOAA-21).

## Features (strictly prior-days; no leakage)
Gaussian KDE of detection density at 0.10° / 0.35° / 0.80° bandwidths, FRP-weighted
density, previous-day density, normalized coordinates, day-of-year sin/cos.

## Labels
Cells inside DBSCAN complex hulls of the target day (app engine parameters:
StandardScaler space, eps 0.12, minPts 6 → convex hulls rasterized).

## Metrics (strict forward holdout: train targets 09-17..19 → test target 2026-09-20)
| region | model IoU | precision | recall | persistence baseline IoU |
|---|---|---|---|---|
| Amazon | **0.657** | 0.828 | 0.760 | 0.355 |
| Congo | **0.549** | 0.953 | 0.564 | 0.388 |
| Borneo | **0.500** | 0.504 | 0.983 | 0.378 |

The model beats the persistence baseline by **1.3-1.9× IoU** across all three regions.
Logistic-regression reference: Amazon 0.575 / Congo 0.584 / Borneo 0.236.

## Usage
```python
import joblib
b = joblib.load('ignis_fire_footprint_forecaster.joblib')
# build the 10 density features from prior-day FIRMS detections on a 0.05° grid,
# then: P = b['hgb'].predict_proba(F)[:, 1].reshape(n_lat, n_lon)
```
`forecast_field_<region>_2026-09-20.npy` files are example probability fields.

## Limitations
- Trained/evaluated on one 5-day window (3 regions); seasonal generalization not yet measured.
- Same-day "prior-hours" density approximated with prior-day KDEs; production wiring
  should use partial-day NRT feeds.
- Labels inherit DBSCAN hull coarseness.

## Provenance & license
Data: NASA FIRMS (public domain). Code: MIT.
"""

for spec in MODELS:
    repo, src = spec['repo'], spec['src']
    api.create_repo(repo_id=repo, private=True, exist_ok=True)
    stage = STAGE / repo.split('/')[-1]
    stage.mkdir(parents=True, exist_ok=True)
    for f in spec['files']:
        s = src / f
        if s.exists():
            shutil.copy2(s, stage / f)
    for sname in spec['scripts']:
        for cand in [WS / 'scripts/models' / sname, WS / 'scripts/hf_model' / sname]:
            if cand.exists():
                shutil.copy2(cand, stage / sname)
                break
    (stage / 'README.md').write_text(CARDS[spec['card']])
    api.upload_folder(folder_path=str(stage), repo_id=repo, repo_type='model')
    info = api.model_info(repo)
    print(f"published {repo} | private={info.private} | files={len(list(stage.rglob('*')))}")

print('ALL MODEL REPOS PUBLISHED (private)')
