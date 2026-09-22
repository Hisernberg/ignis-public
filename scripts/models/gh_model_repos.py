#!/usr/bin/env python3
"""Create private GitHub repos for each IGNIS model + the ignis-data store, push artifacts."""
import json, os, pathlib, shutil, subprocess, urllib.request

WS = pathlib.Path('/home/z/my-project')
PAT = (WS / 'vault/github/pat.txt').read_text().strip()
GH = 'https://api.github.com'
OWNER = 'Hisernberg'
OUT = WS / 'scripts/models/out'
STAGE = WS / 'scripts/models/gh_stage'
if STAGE.exists():
    shutil.rmtree(STAGE)
STAGE.mkdir(parents=True)

def api(url, method='GET', payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': f'Bearer {PAT}', 'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json', 'User-Agent': 'ignis-setup'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode()
            return r.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]

MODELS = [
    dict(name='ignis-model-fire-classifier', hf='Nabidnur/ignis-fire-classifier',
         src=OUT / 'ignis-fire-classifier',
         artifacts=['ignis_fire_classifier.joblib', 'ignis_fire_classifier_logreg.joblib', 'metrics.json', 'labeled_sample.csv'],
         script='train_classifier.py',
         title='IGNIS Fire Classifier — weakly-supervised fire-behavior classification',
         body='Classifies each FIRMS hotspot detection into ISOLATED / SCATTERED / EMERGING / ESTABLISHED / MEGAFIRE from per-detection features (FRP, confidence, diurnal phase, sensor family, multi-scale local density). Labels are weak supervision from the IGNIS DBSCAN complex segmentation engine (the app\'s Fire Cluster Lab). Temporal holdout: accuracy 0.75, macro-F1 0.55 on the fully held-out day 2026-09-20.'),
    dict(name='ignis-model-event-detector', hf='Nabidnur/ignis-event-detector',
         src=OUT / 'ignis-event-detector',
         artifacts=['weights.json', 'ignis_event_detector.joblib', 'ignis_event_detector_hgb_reference.joblib', 'live_scores.json'],
         script='train_event_detector.py',
         title='IGNIS Event Detector — next-month extreme-fire-month early warning',
         body='Predicts whether next month will be an extreme fire month (z >= 2 vs 2000-2021 climatology) from lagged harmonized MODIS+VIIRS calendar features across 9 regions. HGB reference: AUC 0.740 / PR-AUC 0.606 on the hard 2022-2026 holdout (the record 2023-24 fire years). Ships portable logistic weights (weights.json) wired into the IGNIS web app for deterministic in-browser scoring.'),
    dict(name='ignis-model-footprint-forecaster', hf='Nabidnur/ignis-fire-footprint-forecaster',
         src=OUT / 'ignis-fire-footprint-forecaster',
         artifacts=['ignis_fire_footprint_forecaster.joblib', 'metrics.json'],
         script='train_footprint_forecaster.py',
         title='IGNIS Fire-Footprint Forecaster — segmentation-based next-day fire-complex footprint',
         body='Cell-wise (0.05 deg) segmentation model predicting tomorrow\'s fire-complex footprint from prior-days detection-density features (multi-bandwidth Gaussian KDE, FRP-weighted density). Strict forward holdout (train targets 09-17..19, test target 2026-09-20): Amazon IoU 0.657, Congo 0.549, Borneo 0.500 vs persistence baseline 0.355/0.388/0.378 — 1.3-1.9x skill.'),
    dict(name='ignis-model-fire-regime', hf='Nabidnur/ignis-fire-regime-model',
         src=WS / 'scripts/hf_model/out',
         artifacts=['ignis_fire_segmenter.joblib', 'metrics.json', 'complexes_summary.json'],
         script='train_segmenter.py',
         title='IGNIS Fire Regime Model — DBSCAN complex segmentation + K-means regime classifier',
         body='The original IGNIS model: StandardScaler->DBSCAN complex segmentation (63 complexes, silhouette 0.178) + K-means k=6 fire-regime classifier, trained on 138,118 real FIRMS detections across Amazon, Congo and Borneo. Powers the in-app regime panel.'),
]

LICENSE = """MIT License

Copyright (c) 2026 Team IGNIS — NASA Space Apps Challenge 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

def git(dirpath, cmds):
    for c in cmds:
        subprocess.run(c, cwd=dirpath, check=True, capture_output=True)

for spec in MODELS:
    name = spec['name']
    st, body = api(f'{GH}/repos/{OWNER}/{name}', 'GET')
    if st == 404:
        st, body = api(f'{GH}/user/repos', 'POST', {'name': name, 'private': True,
                                                    'description': spec['title'] + ' — NASA Space Apps 2026 (IGNIS)'})
        assert st in (201, 202), f'create {name}: {st} {body}'
    else:
        api(f'{GH}/repos/{OWNER}/{name}', 'PATCH', {'private': True})
    d = STAGE / name
    d.mkdir(parents=True, exist_ok=True)
    for a in spec['artifacts']:
        s = spec['src'] / a
        if s.exists():
            shutil.copy2(s, d / a)
    for cand in [WS / 'scripts/models' / spec['script'], WS / 'scripts/hf_model' / spec['script']]:
        if cand.exists():
            shutil.copy2(cand, d / spec['script'])
            break
    (d / 'LICENSE').write_text(LICENSE)
    (d / 'README.md').write_text(f"""# {spec['title']}

> Part of the **IGNIS** platform — NASA Space Apps Challenge 2026, challenge #9
> *Harmonization of MODIS and VIIRS Hot Spots*. **Private during judging.**

{spec['body']}

## Contents
- `{spec['script']}` — full reproducible training pipeline (real NASA FIRMS data)
- model artifacts (scikit-learn joblib bundles) + `metrics.json`
- `LICENSE` — MIT

## Hugging Face
The same model, with the full model card, lives at
**https://huggingface.co/{spec['hf']}** (private; request access or see the main repo).

## Main project
https://github.com/Hisernberg/ignis-spaceapps2026 — live app:
https://ignis-spaceapps2026.vercel.app

## Provenance
All training data derives from NASA FIRMS active-fire detections (public domain),
harmonized across MODIS (Terra/Aqua) and VIIRS (S-NPP/NOAA-20/NOAA-21) by the IGNIS
pipeline. No synthetic data is used for supervised labels.
""")
    (d / '.gitignore').write_text('__pycache__/\n*.pyc\n.DS_Store\n')
    git(d, [
        ['git', 'init', '-q', '-b', 'main'],
        ['git', 'config', 'user.name', 'Hisernberg'],
        ['git', 'config', 'user.email', os.environ.get('GIT_EMAIL', 'ignis@users.noreply.github.com')],
        ['git', 'add', '-A'],
        ['git', 'commit', '-q', '-m', f'{spec["title"]} — training pipeline, artifacts, metrics'],
    ])
    subprocess.run(['git', 'remote', 'add', 'origin', f'https://x-access-token:{PAT}@github.com/{OWNER}/{name}.git'],
                   cwd=d, capture_output=True)
    r = subprocess.run(['git', 'push', '-q', '-f', 'origin', 'main'], cwd=d, capture_output=True, text=True)
    print(name, '->', 'pushed' if r.returncode == 0 else f'FAIL {r.stderr[:120]}')

# ---- ignis-data store ----
name = 'ignis-data'
st, body = api(f'{GH}/repos/{OWNER}/{name}', 'GET')
if st == 404:
    st, body = api(f'{GH}/user/repos', 'POST', {'name': name, 'private': True,
                                                'description': 'IGNIS harmonized fire-climate data store — 25-year MODIS+VIIRS calendars, emissions, regimes, training snapshots (NASA Space Apps 2026)'})
else:
    api(f'{GH}/repos/{OWNER}/{name}', 'PATCH', {'private': True})
d = STAGE / name
d.mkdir(parents=True, exist_ok=True)
for f in (WS / 'data/ignis').glob('calendar_*.json'):
    shutil.copy2(f, d / f.name)
an = d / 'analysis'
an.mkdir(exist_ok=True)
for f in (WS / 'data/ignis/analysis').glob('*'):
    if f.is_file():
        shutil.copy2(f, an / f.name)
for f in (WS / 'scripts/hf_model/out').glob('*'):
    if f.is_file() and f.suffix in ('.csv', '.json'):
        shutil.copy2(f, an / f.name)
(d / 'LICENSE').write_text(LICENSE)
(d / 'README.md').write_text("""# IGNIS Data Store

Harmonized fire-climate data produced by the IGNIS pipeline (NASA Space Apps 2026,
challenge #9). **Private during judging.**

## Contents
- `calendar_<region>.json` — 9 regional 25-year harmonized MODIS+VIIRS monthly
  calendars (2000-11 → 2026-09), per-sensor with harmonization ratios
- `analysis/ignis_calendar_long.csv` — long-format unified calendar (5,022 region-months)
- `analysis/ignis_emissions_estimates.csv` — FRE-derived CO2e emissions (tau = 1800 s,
  calibrated against published Amazon-2024 estimates)
- `analysis/ignis_regime_matrix.csv` — 9-region fire-regime feature matrix
- `analysis/training_snapshot.csv` — 138k-detection multi-sensor training snapshot
  (Amazon/Congo/Borneo, 5 days, 5 sensors)
- `analysis/ignis_complexes_latest.csv` + `complexes_summary.json` — DBSCAN complex stats

## Provenance
All data derives from NASA FIRMS active-fire detections (public domain) and NASA GIBS.
Harmonization methodology in the main repo: https://github.com/Hisernberg/ignis-spaceapps2026
""")
git(d, [
    ['git', 'init', '-q', '-b', 'main'],
    ['git', 'config', 'user.name', 'Hisernberg'],
    ['git', 'config', 'user.email', os.environ.get('GIT_EMAIL', 'ignis@users.noreply.github.com')],
    ['git', 'add', '-A'],
    ['git', 'commit', '-q', '-m', 'IGNIS data store: 9 regional calendars, harmonized long-format calendar, emissions, regimes, 138k training snapshot'],
])
subprocess.run(['git', 'remote', 'add', 'origin', f'https://x-access-token:{PAT}@github.com/{OWNER}/{name}.git'],
               cwd=d, capture_output=True)
r = subprocess.run(['git', 'push', '-q', '-f', 'origin', 'main'], cwd=d, capture_output=True, text=True)
print(name, '->', 'pushed' if r.returncode == 0 else f'FAIL {r.stderr[:120]}')
print('DONE')
