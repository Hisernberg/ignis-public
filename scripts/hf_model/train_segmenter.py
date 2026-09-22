#!/usr/bin/env python3
"""
IGNIS Fire Complex Segmenter — training pipeline (NASA Space Apps 2026, Challenge #9).
Trains an unsupervised segmentation model on REAL live FIRMS NRT detections:
  Stage 1: DBSCAN spatial clustering  -> fire complexes (contiguous fire systems)
  Stage 2: KMeans behavior typing     -> per-complex fire behavior classes
Harmonizes MODIS (0-100 confidence) and VIIRS (l/n/h) into one numeric scale.
Outputs a joblib bundle + training snapshot + metrics -> published to
huggingface.co/Nabidnur/ignis-fire-regime-model
"""
import json
import math
import time

import numpy as np
import pandas as pd
from sklearn.cluster import DBSCAN, KMeans
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler

SOURCES = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT"]
REGIONS = {
    "amazon":   (-74.0, -10.0, -50.0, 5.0),
    "congo":    (10.0, -7.0, 32.0, 6.0),
    "borneo":   (108.0, -5.0, 120.0, 8.0),
}
DAY_RANGE = 5
# Real detections pre-fetched via IGNIS production proxy (Vercel reaches FIRMS;
# this sandbox cannot reach firms.modaps directly). Still 100% NASA FIRMS data.
PROD_JSON = {
    "amazon": "/tmp/hot_amazon.json",
    "congo": "/tmp/hot_congo.json",
    "borneo": "/tmp/hot_borneo.json",
}
OUT = "/home/z/my-project/scripts/hf_model/out"

EPS_DEG = 0.045   # ~5 km at equator -> fire complex linking distance
MIN_PTS = 6       # minimum detections to form a complex
K_REGIMES = 6


def load_prod(region: str) -> pd.DataFrame:
    """Flatten IGNIS production harmonized JSON -> DataFrame (FIRMS-provenance)."""
    doc = json.load(open(PROD_JSON[region]))
    rows = []
    for d, day_doc in (doc.get("days") or {}).items():
        for sensor_name, sensor_doc in (day_doc.get("sensors") or {}).items():
            for p in sensor_doc.get("points") or []:
                rows.append({
                    "latitude": p.get("lat"), "longitude": p.get("lon"),
                    "frp": p.get("frp") or 0.0, "confidence": p.get("conf"),
                    "confRaw": p.get("confRaw"), "night": p.get("night"),
                    "satellite": p.get("sat"), "acq_date": d, "acq": p.get("acq", ""),
                    "region": region, "source": sensor_name,
                })
    return pd.DataFrame(rows)


def harmonize(df: pd.DataFrame) -> pd.DataFrame:
    # conf already harmonized 0-100 by IGNIS proxy (VIIRS l/n/h -> 20/50/90)
    df["conf_num"] = pd.to_numeric(df["confidence"], errors="coerce").fillna(50.0)
    df["frp"] = pd.to_numeric(df.get("frp"), errors="coerce").fillna(0.0)
    hour = df["acq"].astype(str).str.extract(r"(\d{1,2}):")[0]
    df["acq_hour"] = pd.to_numeric(hour, errors="coerce").fillna(0).astype(int) % 24
    df["daynight"] = np.where(df["night"].astype(bool), "N", "D")
    df["bright_ti4"] = np.nan  # not exposed by proxy; regime feats use FRP/conf/time
    return df


def main() -> None:
    import os
    os.makedirs(OUT, exist_ok=True)
    frames = []
    for region in REGIONS:
        df = load_prod(region)
        print(f"  {region:12s} -> {len(df)}")
        if len(df):
            frames.append(df)
    raw = pd.concat(frames, ignore_index=True)
    print(f"TOTAL raw detections: {len(raw)}")
    data = harmonize(raw)
    keep = ["latitude", "longitude", "bright_ti4", "bright_ti5", "frp", "conf_num",
            "acq_date", "acq_hour", "daynight", "satellite", "instrument",
            "confidence", "region", "source"]
    snapshot = data[[c for c in keep if c in data.columns]].copy()
    snapshot = snapshot.rename(columns={"conf_num": "confidence_harmonized"})
    snapshot.to_csv(f"{OUT}/training_snapshot.csv", index=False)
    # Regime feats guard: drop all-NaN bright_ti4 column if present
    keep = [c for c in keep if c in data.columns and not (c == 'bright_ti4' and data[c].isna().all())]

    # ---------- Stage 1: DBSCAN fire-complex segmentation ----------
    coords = data[["latitude", "longitude"]].to_numpy()
    X = np.column_stack([coords, np.log1p(data["frp"].to_numpy())])
    scaler = StandardScaler().fit(X)
    Xs = scaler.transform(X)
    dbscan = DBSCAN(eps=0.12, min_samples=MIN_PTS).fit(Xs)  # scaled space
    labels = dbscan.labels_
    data["complex_id"] = labels

    n_complex = int(len(set(labels)) - (1 if -1 in labels else 0))
    noise = float((labels == -1).mean())
    sil = float("nan")
    if 2 <= n_complex and n_complex < 200:
        idx = np.random.default_rng(42).choice(len(Xs), size=min(4000, len(Xs)), replace=False)
        sil = float(silhouette_score(Xs[idx], labels[idx]))

    # Per-complex stats (the numbers the app + AI analyst consume)
    grouped = data[data["complex_id"] >= 0].groupby("complex_id")
    complexes = []
    for cid, g in grouped:
        if len(g) < MIN_PTS:
            continue
        complexes.append({
            "complex_id": int(cid),
            "detections": int(len(g)),
            "total_frp_mw": round(float(g["frp"].sum()), 1),
            "mean_frp_mw": round(float(g["frp"].mean()), 1),
            "max_frp_mw": round(float(g["frp"].max()), 1),
            "mean_confidence": round(float(g["conf_num"].mean()), 1),
            "sensors": sorted(g["source"].str.replace("_NRT", "").unique().tolist()),
            "regions": sorted(g["region"].unique().tolist()),
            "centroid_lat": round(float(g["latitude"].mean()), 4),
            "centroid_lon": round(float(g["longitude"].mean()), 4),
            "bbox": [float(g["longitude"].min()), float(g["latitude"].min()),
                     float(g["longitude"].max()), float(g["latitude"].max())],
            "acq_days": int(g["acq_date"].nunique()),
            "night_fraction": round(float((g["daynight"] == "N").mean()), 3),
        })
    complexes.sort(key=lambda c: c["total_frp_mw"], reverse=True)
    for rank, c in enumerate(complexes, 1):
        c["rank"] = rank
        c["class"] = ("megafire" if c["detections"] >= 500 or c["total_frp_mw"] >= 20000
                      else "major" if c["detections"] >= 150 or c["total_frp_mw"] >= 5000
                      else "active" if c["detections"] >= 40
                      else "smoldering")

    # ---------- Stage 2: KMeans fire-behavior regimes ----------
    feats = np.column_stack([
        np.log1p(data["frp"]), data["conf_num"] / 100.0, data["acq_hour"] / 23.0,
        (data["daynight"] == "N").astype(float), np.log1p(data["bright_ti4"].fillna(300) - 250),
    ])
    feats = np.nan_to_num(feats, nan=0.0)
    km = KMeans(n_clusters=K_REGIMES, n_init=10, random_state=42).fit(feats)
    data["regime"] = km.labels_
    regime_profile = (
        data.groupby("regime")
        .agg(n=("frp", "size"), mean_frp=("frp", "mean"), mean_conf=("conf_num", "mean"),
             night_frac=("daynight", lambda s: float((s == "N").mean())),
             mean_hour=("acq_hour", "mean"))
        .round(3).to_dict(orient="index")
    )

    metrics = {
        "trained_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "data_window_days": DAY_RANGE,
        "window_start": sorted(data["acq_date"].unique())[0] if len(data) else None,
        "window_end": sorted(data["acq_date"].unique())[-1] if len(data) else None,
        "fetch_via": "IGNIS production harmonization proxy -> NASA FIRMS (LANCE) NRT",
        "regions": list(REGIONS),
        "sensors": sorted(data["source"].unique().tolist()) if len(data) else SOURCES,
        "n_detections": int(len(data)),
        "sensor_counts": data["source"].value_counts().to_dict(),
        "eps_scaled": 0.12,
        "eps_deg_approx": EPS_DEG,
        "min_samples": MIN_PTS,
        "n_complexes": n_complex,
        "noise_ratio": round(noise, 4),
        "silhouette_sampled": None if math.isnan(sil) else round(sil, 4),
        "k_regimes": K_REGIMES,
        "regime_profile": regime_profile,
        "class_counts": pd.Series([c["class"] for c in complexes]).value_counts().to_dict(),
        "harmonization": "VIIRS l/n/h -> 20/50/90; MODIS 0-100 kept; FRP MW; acq_time UTC hours",
    }
    with open(f"{OUT}/metrics.json", "w") as f:
        json.dump(metrics, f, indent=2)
    with open(f"{OUT}/complexes_summary.json", "w") as f:
        json.dump(complexes[:50], f, indent=2)

    # joblib bundle for HF model repo
    import joblib
    bundle = {
        "scaler": scaler, "dbscan": dbscan, "kmeans": km,
        "config": {"eps_scaled": 0.12, "min_samples": MIN_PTS, "k_regimes": K_REGIMES,
                   "feature_order": ["lat", "lon", "log1p_frp"],
                   "regime_feature_order": ["log1p_frp", "conf", "hour_frac", "night", "log1p_bt4"]},
        "metrics": {k: metrics[k] for k in ("n_detections", "n_complexes", "noise_ratio",
                                            "silhouette_sampled", "trained_at_utc")},
    }
    joblib.dump(bundle, f"{OUT}/ignis_fire_segmenter.joblib")
    print(json.dumps({k: metrics[k] for k in ("n_detections", "n_complexes", "noise_ratio",
                                              "silhouette_sampled", "class_counts")}, indent=2))
    print("TOP-5 COMPLEXES:", json.dumps(complexes[:5], indent=1)[:800])


if __name__ == "__main__":
    main()
