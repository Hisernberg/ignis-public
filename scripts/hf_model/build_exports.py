#!/usr/bin/env python3
"""Build enriched open-data exports for HF dataset repo + GitHub data archive.
Outputs (all derived from REAL NASA data already in-repo / just trained):
  1. ignis_calendar_long.csv      — 9 regions × 3 sensors × 26-yr monthly harmonized series
  2. ignis_regime_matrix.csv      — per-region fire-regime feature matrix
  3. ignis_emissions_estimates.csv— per-region per-year FRE proxy → CO2e first-order estimate
  4. ignis_complexes_latest.csv   — today's 63 DBSCAN fire complexes (5-day NRT window)
  5. complexes_summary.json       — same, JSON (app-consumable schema)
"""
import json
import os

import numpy as np
import pandas as pd

DATA = "/home/z/my-project/data/ignis"
OUT = "/home/z/my-project/scripts/hf_model/out"
REGIONS = ["amazon", "australia", "bangladesh", "borneo", "california",
           "canada", "congo", "mediterranean", "siberia"]

# --- 1. calendar long CSV -------------------------------------------------
rows = []
for r in REGIONS:
    doc = json.load(open(f"{DATA}/calendar_{r}.json"))
    for sensor, s in doc["sensors"].items():
        for m in s["monthly"]:
            rows.append({
                "region": r, "ym": m["ym"], "sensor": sensor,
                "estimated_detections": m["est"], "frp_mw_total": m["frp"],
                "mean_frp_mw": m["meanFrp"], "high_confidence": m["hiConf"],
                "night_detections": m["night"], "sampled_points": m["sampled"],
                "sampled_days": m["days"],
            })
cal = pd.DataFrame(rows)
cal.to_csv(f"{OUT}/ignis_calendar_long.csv", index=False)
print("calendar_long:", cal.shape)

# --- 2. regime matrix ------------------------------------------------------
reg = []
for r in REGIONS:
    d = cal[cal.region == r]
    tot = d.groupby("ym").estimated_detections.sum()
    frp = d.groupby("ym").frp_mw_total.sum()
    months = pd.to_datetime(tot.index, format="%Y-%m")
    peak = tot.groupby(tot.index.str[5:7]).mean().idxmax()
    reg.append({
        "region": r,
        "months_observed": int(len(tot)),
        "total_est_detections_26yr": int(tot.sum()),
        "mean_monthly_detections": round(float(tot.mean()), 1),
        "peak_month": int(peak),
        "peak_month_mean": round(float(tot.groupby(tot.index.str[5:7]).mean().max()), 1),
        "total_frp_gw_26yr": round(float(frp.sum() / 1e6), 1),
        "mean_frp_mw": round(float(d.mean_frp_mw.mean()), 1),
        "seasonality_index": round(float((tot.max() - tot.min()) / max(tot.mean(), 1)), 2),
        "active_months_pct": round(float((tot > tot.mean() * 0.1).mean() * 100), 1),
    })
pd.DataFrame(reg).to_csv(f"{OUT}/ignis_regime_matrix.csv", index=False)
print("regime_matrix:", len(reg), "regions")

# --- 3. emissions estimates -------------------------------------------------
# First-order FRE proxy, calibrated & fully documented:
#   frp_scaled_monthly(MW) = est_detections × meanFrp      (sampled→monthly scaled)
#   FRE_month(MJ) = frp_scaled × τ,  τ = 1800 s effective burn window per detection.
#     τ bounds: 60 s (overpass dwell) < τ < 3 h (persistence); 30 min reconciles
#     Amazon-2024 with published basin totals (~380 Mt CO2, GFED4-class).
#   DM(kg) = FRE(MJ) × 0.223 kg/MJ   (Wooster et al. 2005)
#   CO2(kg)= DM × 1.613              (Andreae & Merlet 2001)
# Units: FRE TJ = MJ/1e6; DM kt = kg/1e6; CO2 Mt = DM kt × 1.613e-3.
TAU_S = 1800.0
em = []
for r in REGIONS:
    d = cal[cal.region == r].copy()
    ratio = d.estimated_detections / d.sampled_points.replace(0, np.nan)
    d["frp_scaled"] = (d.frp_mw_total * ratio).fillna(d.frp_mw_total)
    d["year"] = d.ym.str[:4]
    g = d.groupby("year").agg(frp_mw_sampled=("frp_mw_total", "sum"),
                              frp_scaled_mw=("frp_scaled", "sum"),
                              est=("estimated_detections", "sum"))
    g["fre_proxy_tj"] = (g.frp_scaled_mw * TAU_S / 1e6).round(1)
    g["dm_est_kt"] = (g.fre_proxy_tj * 0.223).round(1)
    g["co2e_est_mt"] = (g.dm_est_kt * 1.613e-3).round(2)
    g["region"] = r
    em.append(g.reset_index()[["region", "year", "frp_mw_sampled", "frp_scaled_mw",
                               "est", "fre_proxy_tj", "dm_est_kt", "co2e_est_mt"]])
emissions = pd.concat(em, ignore_index=True)
emissions.columns = ["region", "year", "frp_mw_sampled", "frp_scaled_mw", "est_detections",
                     "fre_proxy_tj", "dry_matter_kt", "co2e_mt"]
emissions.to_csv(f"{OUT}/ignis_emissions_estimates.csv", index=False)
_25 = emissions.loc[emissions.year == "2025"]
print("emissions:", emissions.shape,
      "| 2025 CO2e:", round(float(_25.co2e_mt.sum()), 1), "Mt across", len(_25), "regions")

# --- 4. complexes ------------------------------------------------------------
cx = json.load(open(f"{OUT}/complexes_summary.json"))
rows = [{
    "complex_id": c["complex_id"], "rank": c["rank"], "class": c["class"],
    "detections": c["detections"], "total_frp_mw": c["total_frp_mw"],
    "mean_frp_mw": c["mean_frp_mw"], "max_frp_mw": c["max_frp_mw"],
    "mean_confidence": c["mean_confidence"], "sensors": "+".join(c["sensors"]),
    "region": "+".join(c["regions"]), "centroid_lat": c["centroid_lat"],
    "centroid_lon": c["centroid_lon"], "bbox_w": c["bbox"][0], "bbox_s": c["bbox"][1],
    "bbox_e": c["bbox"][2], "bbox_n": c["bbox"][3], "active_days": c["acq_days"],
    "night_fraction": c["night_fraction"],
} for c in cx]
pd.DataFrame(rows).to_csv(f"{OUT}/ignis_complexes_latest.csv", index=False)
print("complexes:", len(rows))
print("DONE ->", OUT)
