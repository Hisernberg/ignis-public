#!/usr/bin/env python3
"""Upload enriched open-data exports to Nabidnur/ignis-fire-calendar + update card."""
from huggingface_hub import HfApi

TOKEN = __import__("os").environ.get("HF_TOKEN", "")
REPO = "Nabidnur/ignis-fire-calendar"
OUT = "/home/z/my-project/scripts/hf_model/out"

CARD_ADDENDUM = """

---

## Analysis products (v2 — 2026-09-21)

| File | Rows | What it is |
|---|---|---|
| `analysis/ignis_calendar_long.csv` | 5,022 | Long-format harmonized calendar: 9 regions × 3 sensors × 26-yr monthly (est detections, FRP, hiConf, night) |
| `analysis/ignis_regime_matrix.csv` | 9 | Per-region fire-regime features: totals, peak month, seasonality index, active-month % |
| `analysis/ignis_emissions_estimates.csv` | 243 | First-order FRE→CO2e per region-year (τ=1800 s calibrated vs GFED4-class basin totals; Wooster 2005 DM factor 0.223 kg/MJ; Andreae & Merlet CO2 1.613) |
| `analysis/ignis_complexes_latest.csv` | 50 | Live DBSCAN fire complexes (5-day NRT window, Amazon+Congo+Borneo): ΣFRP, class (megafire/major/active/smoldering), bbox, persistence |
| `analysis/complexes_summary.json` | 50 | Same complexes, app-consumable JSON schema |

### Emissions method (first-order, honest)
`FRE = Σ(estimated_detections × meanFRP) × 1800 s` — τ calibrated so Amazon-2024 ≈ 320 Mt CO2
(published GFED4-class ≈ 380 Mt). Expect factor-2 uncertainty; this is an early-warning scale estimate,
not an inventory. Python: `pandas` + `sklearn` — see `notebook/ignis_calendar_analysis.ipynb`.

### Companion model
The segmentation that produced `ignis_complexes_latest.csv` is open:
**[Nabidnur/ignis-fire-regime-model](https://huggingface.co/Nabidnur/ignis-fire-regime-model)**
(DBSCAN+KMeans, 138k real detections, full training script + metrics included).
"""


def main():
    api = HfApi(token=TOKEN)
    api.create_repo(REPO, repo_type="dataset", exist_ok=True)
    uploads = {
        f"{OUT}/ignis_calendar_long.csv": "analysis/ignis_calendar_long.csv",
        f"{OUT}/ignis_regime_matrix.csv": "analysis/ignis_regime_matrix.csv",
        f"{OUT}/ignis_emissions_estimates.csv": "analysis/ignis_emissions_estimates.csv",
        f"{OUT}/ignis_complexes_latest.csv": "analysis/ignis_complexes_latest.csv",
        f"{OUT}/complexes_summary.json": "analysis/complexes_summary.json",
    }
    for src, dst in uploads.items():
        api.upload_file(path_or_fileobj=src, path_in_repo=dst, repo_id=REPO,
                        repo_type="dataset",
                        commit_message="v2 analysis products: long calendar, regime matrix, calibrated emissions, DBSCAN complexes")
    print("UPLOADED", list(uploads.values()))

    # append addendum to card
    from huggingface_hub import hf_hub_download
    card_path = hf_hub_download(REPO, "README.md", repo_type="dataset", token=TOKEN)
    card = open(card_path).read()
    if "Analysis products (v2" not in card:
        card += CARD_ADDENDUM
        api.upload_file(path_or_fileobj=card.encode(), path_in_repo="README.md",
                        repo_id=REPO, repo_type="dataset",
                        commit_message="dataset card v2: analysis products + emissions method + companion model")
        print("CARD UPDATED")
    else:
        print("CARD ALREADY v2")


if __name__ == "__main__":
    main()
