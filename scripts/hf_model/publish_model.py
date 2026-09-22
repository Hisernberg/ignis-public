#!/usr/bin/env python3
"""Publish IGNIS Fire Regime Model to Hugging Face Hub (model repo)."""
import json
import sys
import time

from huggingface_hub import HfApi

TOKEN = __import__("os").environ.get("HF_TOKEN", "")
REPO = "Nabidnur/ignis-fire-regime-model"
OUT = "/home/z/my-project/scripts/hf_model/out"

MODEL_CARD = """---
license: mit
library_name: sklearn
tags:
- nasa-space-apps-2026
- wildfire
- remote-sensing
- dbscan
- kmeans
- fires
- modis
- viirs
- firms
- segmentation
datasets:
- Nabidnur/ignis-fire-calendar
metrics:
- silhouette
---

# IGNIS Fire Complex Segmenter

Unsupervised segmentation model that turns raw NASA FIRMS hotspot detections (MODIS Terra/Aqua + VIIRS
S-NPP/NOAA-20/NOAA-21, harmonized) into **fire complexes** — contiguous, physically-meaningful fire systems —
and types their **fire behavior regime**. Built for [IGNIS](https://ignis-spaceapps2026.vercel.app), the
Burning Activity Calendar app for NASA Space Apps Challenge 2026, Challenge #9
*Harmonization of MODIS and VIIRS Hot Spots*.

## How it works

```
FIRMS NRT CSV (MODIS C6.1 + VIIRS V2, harmonized)
        │  latitude, longitude, FRP, confidence(l/n/h→20/50/90), acq_time UTC, daynight
        ▼
StandardScaler  →  [lat, lon, log1p(FRP)]        (spatial-intensity space)
        ▼
DBSCAN(eps=0.12 scaled ≈ 5 km, min_samples=6)     Stage 1 — fire complexes
        ▼
KMeans(k=6) on [log1p(FRP), conf, hour, night, log1p(bright)]   Stage 2 — behavior regimes
        ▼
complex stats: detections, ΣFRP, bbox, sensors, persistence, class
               (megafire / major / active / smoldering)
```

## Training run (this artifact)

| | |
|---|---|
| Trained (UTC) | {TRAINED_AT} |
| Detections | {N_DET} live NRT detections |
| Window | {WINDOW} ({DAYS} days) × Amazon · Congo · Borneo |
| Sensors | VIIRS S-NPP / NOAA-20 / NOAA-21 + MODIS Terra/Aqua |
| Complexes found | {N_CPLX} |
| Noise ratio | {NOISE} |
| Silhouette (sampled) | {SIL} |
| Behavior classes | {CLASSES} |

## Usage

```python
from huggingface_hub import hf_hub_download
import joblib, pandas as pd

path = hf_hub_download("Nabidnur/ignis-fire-regime-model", "ignis_fire_segmenter.joblib")
bundle = joblib.load(path)

df = pd.read_csv("firms_detections.csv")   # latitude, longitude, frp, ...
X = bundle["scaler"].transform(__import__("numpy").column_stack(
    [df.latitude, df.longitude, __import__("numpy").log1p(df.frp.fillna(0))]))
df["complex_id"] = bundle["dbscan"].fit_predict(X)  # or .labels_ if refitting per-batch
```

For production reproducibility, run `train_segmenter.py` (included) end-to-end: it re-fetches live FIRMS,
harmonizes, fits both stages, and emits identical JSON stats consumed by IGNIS's Fire Cluster Lab.

## Files

| File | Purpose |
|---|---|
| `ignis_fire_segmenter.joblib` | scaler + DBSCAN + KMeans + config + run metrics |
| `train_segmenter.py` | full training pipeline (FIRMS fetch → harmonize → fit → stats) |
| `training_snapshot.csv` | the exact real detections this artifact trained on |
| `metrics.json` | run metrics, per-regime profiles, class counts |
| `complexes_summary.json` | top-50 complexes with stats (app-consumable schema) |

## Provenance & license

- Data: NASA FIRMS NRT (LANCE), MODIS Collection 6.1 & VIIRS V2, NASA FIRMS API — public domain.
- Harmonization rules follow the IGNIS dataset card (`Nabidnur/ignis-fire-calendar`).
- Code & weights: MIT. Citation: `IGNIS Team (2026). IGNIS Fire Complex Segmenter. Hugging Face.`

## Limitations

NRT-only training window (7 days); equatorial eps approximation (~5 km degrades with latitude);
VIIRS confidence is qualitative (l/n/h) and is mapped linearly; DBSCAN is deterministic but refit per
batch — cluster IDs are not stable across refits (IGNIS re-ranks by ΣFRP instead).
"""


def main():
    from pathlib import Path
    meta = json.load(open(f"{OUT}/metrics.json"))
    card = (MODEL_CARD
            .replace("{TRAINED_AT}", meta["trained_at_utc"])
            .replace("{N_DET}", f"{meta['n_detections']:,}")
            .replace("{WINDOW}", meta["window_start"])
            .replace("{DAYS}", str(meta["data_window_days"]))
            .replace("{N_CPLX}", str(meta["n_complexes"]))
            .replace("{NOISE}", str(meta["noise_ratio"]))
            .replace("{SIL}", str(meta["silhouette_sampled"]))
            .replace("{CLASSES}", ", ".join(f"{k}={v}" for k, v in meta["class_counts"].items())))

    api = HfApi(token=TOKEN)
    api.create_repo(REPO, repo_type="model", exist_ok=True)
    p = Path(f"{OUT}/model_repo")
    p.mkdir(parents=True, exist_ok=True)
    (p / "README.md").write_text(card)
    (p / "train_segmenter.py").write_text(open("/home/z/my-project/scripts/hf_model/train_segmenter.py").read())
    import shutil
    for f in ["ignis_fire_segmenter.joblib", "training_snapshot.csv", "metrics.json", "complexes_summary.json"]:
        shutil.copy(f"{OUT}/{f}", p / f)
    api.upload_folder(folder_path=str(p), repo_id=REPO, repo_type="model",
                      commit_message="IGNIS Fire Complex Segmenter — DBSCAN+KMeans on live FIRMS NRT (NASA Space Apps 2026)")
    print("PUBLISHED", f"https://huggingface.co/{REPO}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FAILED:", e)
        sys.exit(1)
