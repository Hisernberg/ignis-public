---
license: mit
task_categories:
  - time-series-forecasting
tags:
  - nasa
  - space-apps-2026
  - modis
  - viirs
  - fires
  - hotspots
  - firms
  - gibs
  - early-warning
  - remote-sensing
  - bangladesh
size_categories:
  - 10K<n<100K
configs:
  - config_name: calendars
    data_files: "data/calendar_*.json"
  - config_name: outlooks
    data_files: "data/outlook_*.json"
---

# IGNIS Fire Calendar — 26-year harmonized MODIS + VIIRS burning-activity record

<div align="center">

**The open data artifact of [IGNIS](https://github.com/Hisernberg/ignis-spaceapps2026)** · NASA Space Apps Challenge 2026 · Challenge #9 *Harmonization of MODIS and VIIRS Hot Spots*

[![NASA FIRMS](https://img.shields.io/badge/NASA-FIRMS%20·%20GIBS-F97316)](https://firms.modaps.eosdis.nasa.gov) [![App](https://img.shields.io/badge/IGNIS-live_app-38BDF8)](https://ignis-spaceapps2026.vercel.app) [![License: MIT](https://img.shields.io/badge/License-MIT-38BDF8)]()

</div>

## What this is

Nine regional **Burning Activity Calendars** harmonizing NASA's split active-fire record into one continuous monthly series (Nov 2000 → present), plus 12-month **seasonal outlooks**. Built exclusively from NASA open data: **GIBS WMTS vector tiles** (the FIRMS-derived MODIS C6.1 / VIIRS V2 thermal-anomaly records, parsed from the raw tile archive).

- **Sensors harmonized:** MODIS Terra (1 km, 2000-02–), MODIS Aqua (1 km, 2002-07–), VIIRS S-NPP (375 m, 2012-01–), VIIRS NOAA-20 (2018–), VIIRS NOAA-21 (2023–)
- **Harmonization method:** overlap-window continuity coefficient — for months where MODIS and VIIRS overlap (2012+), `r(m) = median(VIIRS/MODIS)`; pre-2012 MODIS-era rows are scaled estimates (`"scaled": true`) using that ratio, with the ratio CV shipped as an honesty field
- **Regions:** Amazon Basin, California/US West, Boreal Canada, Eastern Siberia, Congo Basin, Borneo & Sumatra, Australia, Mediterranean Basin, **Bangladesh** (team home region)

## Files

```
data/
  calendar_<region>.json   # 26-yr monthly record per sensor + harmonization meta
  outlook_<region>.json    # 12-month harmonic-regression forecast + history
scripts/
  build_calendar.mjs       # reproduces the calendars from GIBS (deterministic sampling)
  build_outlook.mjs        # harmonic regression forecast with uncertainty bands
  build_regimes.mjs        # burn-regime prototypes for nearest-prototype classification
  fix_harmonization.mjs    # continuity-coefficient repair pass (audit trail)
notebook/
  ignis_calendar_analysis.ipynb   # walk through the data: seasonality, anomalies, regimes
```

## Quick use

```python
import requests, json

cal = requests.get(
    "https://huggingface.co/datasets/Nabidnur/ignis-fire-calendar/resolve/main/data/calendar_bangladesh.json"
).json()

print(cal["harmonization"])  # continuity ratio + CV + overlap window

for row in cal["sensors"]["MODIS-Terra"]["monthly"][-12:]:
    print(row["ym"], round(row["est"]), "detections (scaled month)")
```

```javascript
// JS — feed straight into IGNIS-style analytics
const cal = await (await fetch("https://huggingface.co/datasets/Nabidnur/ignis-fire-calendar/resolve/main/data/calendar_amazon.json")).json();
const unified = cal.sensors["VIIRS-SNPP"].monthly.map(m => ({ ym: m.ym, count: m.est, scaled: m.est !== m.raw }));
```

## Schema (`calendar_<region>.json`)

```jsonc
{
  "region": "amazon", "name": "Amazon Basin", "bbox": [-74, -12, -46, 2],
  "sensors": {
    "MODIS-Terra":   { "layer": "MODIS_Terra_Thermal_Anomalies_All", "tms": "...", "monthly": [ { "ym": "2019-08", "sampled": 2, "days": 31, "est": 412.4, "frp": 8122.7, "meanFrp": 19.7, "hiConf": 301, "night": 118 } ] },
    "VIIRS-SNPP":    { "...": "same schema, 500 m layer, from 2012-01" }
  },
  "harmonization": { "overlapMonths": 165, "meanRatioSNPPtoMODIS": 12.6, "ratioCV": 0.31, "sample": [ { "ym": "2019-08", "ratio": 11.9, "m": 40, "s": 476 } ] },
  "meta": { "method": "...", "source": "GIBS WMTS vector archive", "generated": "2026-09-…" }
}
```

## Provenance & quality

| Field | Value |
|---|---|
| Source | NASA GIBS WMTS (`MODIS_Terra_Thermal_Anomalies_All`, `VIIRS_SNPP_Thermal_Anomalies_All`, …) — the same FIRMS records |
| Sampling | 2 deterministic days per month, all intersecting z5 tiles, bbox-filtered, scaled to full month |
| Known edges | MODIS-era (pre-2012) rows are scaled estimates; VIIRS vector archive lags NRT (surface in app); sampled-day variance shows in `sampled`/`days` fields |
| Live layer | The IGNIS app pairs these calendars with live FIRMS NRT + GIBS fallback at runtime |
| License | MIT. NASA data free & open. Not endorsed by NASA. |

## Citation

```bibtex
@misc{ignis2026firecalendar,
  title  = {IGNIS Fire Calendar: a 26-year harmonized MODIS+VIIRS burning-activity record},
  author = {Team IGNIS (Nabid Nur Abrar)},
  year   = {2026},
  howpublished = {NASA Space Apps Challenge 2026, Challenge 9},
  url    = {https://huggingface.co/datasets/Nabidnur/ignis-fire-calendar}
}
```
