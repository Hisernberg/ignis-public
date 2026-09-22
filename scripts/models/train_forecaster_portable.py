#!/usr/bin/env python3
"""
IGNIS Fire-Footprint Forecaster — PORTABLE TWIN v2 (scene-normalized).

v1 problem (found in production wiring): the KDE features are raw gaussian-filtered
counts, so their scale depends on (a) how many prior days feed the field and
(b) the detection source density (FIRMS CSV vs GIBS vector fallback). The LR twin
calibrated on 4-day dense priors saturates (43% of cells above p=0.5) when wired
to 7-day in-app windows.

v2 fix: normalize every density feature by its SCENE MAX (per region-target-day
grid) before log1p. The model then learns purely from the RELATIVE density
structure — exactly what footprint shape prediction needs — and transfers across
day-window lengths and source densities. lon/lat stay AOI-relative.

Output: src/lib/ignis/forecasterWeights.json (v2.0.0, normalized feature contract)
Also updates the HF repo files (weights + card note) via the publish step.
"""
import json, pathlib
import numpy as np, pandas as pd, joblib
from scipy.ndimage import gaussian_filter
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.cluster import DBSCAN
from sklearn.metrics import jaccard_score, precision_score, recall_score
from matplotlib.path import Path as MplPath

WS = pathlib.Path('/home/z/my-project')
OUT = WS / 'scripts/models/out/ignis-fire-footprint-forecaster'
OUT.mkdir(parents=True, exist_ok=True)
CELL = 0.05
REGIONS = {'amazon': (-74, -12, -46, 2), 'congo': (8, -8, 32, 8), 'borneo': (95, -6, 120, 6)}
BWS = [0.10, 0.35, 0.80]

df = pd.read_csv(WS / 'scripts/hf_model/out/training_snapshot.csv',
                 usecols=['latitude', 'longitude', 'frp', 'acq_date', 'region'])
days = sorted(df.acq_date.unique())
print('days:', days)


def grid_for(region):
    w, s, e, n = REGIONS[region]
    return np.arange(w, e + CELL, CELL), np.arange(s, n + CELL, CELL)


def _convex_hull(points):
    pts = sorted(map(tuple, points))
    if len(pts) <= 2:
        return None

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return np.array(lower[:-1] + upper[:-1])


def rasterize_hulls(g, lons, lats):
    w, s, e, n = REGIONS[g.region.iloc[0]]
    X = np.column_stack([g.longitude, g.latitude])
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Xs = (X - mu) / sd
    lab = DBSCAN(eps=0.12, min_samples=6).fit(Xs).labels_
    mask = np.zeros((len(lats), len(lons)), bool)
    xx, yy = np.meshgrid(lons, lats)
    pts = np.column_stack([xx.ravel(), yy.ravel()])
    for c in np.unique(lab[lab >= 0]):
        sub = X[lab == c]
        if len(sub) < 4:
            continue
        hull = _convex_hull(sub)
        if hull is None:
            continue
        p = MplPath(hull)
        mask |= p.contains_points(pts).reshape(len(lats), len(lons))
    return mask


def hist2d(g, lons, lats, weighted=False):
    h, _, _ = np.histogram2d(g.latitude, g.longitude, bins=[len(lats), len(lons)],
                             range=[[lats[0], lats[-1] + CELL], [lons[0], lons[-1] + CELL]],
                             weights=g.frp if weighted else None)
    return h.astype(float)


def scene_norm(h):
    m = h.max()
    return h / m if m > 0 else h


rows_X, rows_y, rows_meta = [], [], []
for region, (w, s, e, n) in REGIONS.items():
    lons, lats = grid_for(region)
    g = df[df.region == region]
    xx, yy = np.meshgrid(lons, lats)
    lon_n = (xx - w) / (e - w)
    lat_n = (yy - s) / (n - s)
    for day in days:
        prior = g[g.acq_date < day]
        if len(prior) < 50:
            continue
        gd = g[g.acq_date == day]
        dens = []
        for bw in BWS:
            h = scene_norm(gaussian_filter(hist2d(prior, lons, lats), sigma=bw / CELL))
            dens.append(h)
        fp = prior[prior.frp > 0]
        hf = scene_norm(gaussian_filter(hist2d(fp, lons, lats, weighted=True), sigma=0.35 / CELL))
        dens.append(hf)
        h5 = scene_norm(gaussian_filter(hist2d(gd, lons, lats), sigma=0.35 / CELL))
        dens.append(h5)
        prev_day = (pd.Timestamp(day) - pd.Timedelta(days=1)).strftime('%Y-%m-%d')
        gp = g[g.acq_date == prev_day]
        if len(gp) == 0:
            gp = prior[prior.acq_date == prior.acq_date.max()]
        h6 = scene_norm(gaussian_filter(hist2d(gp, lons, lats), sigma=0.35 / CELL))
        dens.append(h6)
        doy = pd.Timestamp(day).timetuple().tm_yday
        F = np.stack([np.log1p(d) for d in dens] + [lon_n, lat_n,
                     np.full_like(lon_n, np.sin(2 * np.pi * doy / 365)),
                     np.full_like(lon_n, np.cos(2 * np.pi * doy / 365))], -1)
        y = rasterize_hulls(gd, lons, lats)
        rows_X.append(F.reshape(-1, F.shape[-1]))
        rows_y.append(y.ravel())
        rows_meta.append(dict(region=region, target_day=day, positives=int(y.sum())))
        print(f"  {region} -> {day}: prior {len(prior)} | positive cells {int(y.sum())}")

X = np.concatenate(rows_X)
y = np.concatenate(rows_y)
meta = pd.DataFrame(rows_meta)
FEATS = ['kde_0.10_n', 'kde_0.35_n', 'kde_0.80_n', 'frp_kde_0.35_n', 'kde_lastday_n', 'kde_prevday_n', 'lon_n', 'lat_n', 'doy_sin', 'doy_cos']
print(f'cells: {len(X)} | positives: {int(y.sum())} ({100 * y.mean():.2f}%)')

region_cells = {r: len(grid_for(r)[0]) * len(grid_for(r)[1]) for r in REGIONS}
sizes = [region_cells[m.region] for m in meta.itertuples()]
offsets = np.concatenate([[0], np.cumsum(sizes)])

# forward holdout: train on all target days except each region's last, test on last
tr_m = np.zeros(len(X), bool)
te_slices = {}
for i, m in enumerate(meta.itertuples()):
    sl = slice(offsets[i], offsets[i + 1])
    if m.target_day == days[-1]:
        te_slices[m.region] = sl
    else:
        tr_m[sl] = True

sc = StandardScaler().fit(X[tr_m])
lr = LogisticRegression(C=1.0, class_weight='balanced', max_iter=2000).fit(sc.transform(X[tr_m]), y[tr_m])
hgb = HistGradientBoostingClassifier(max_iter=150, max_depth=5, learning_rate=0.08).fit(X[tr_m], y[tr_m])

rep_lr, rep_hgb = {}, {}
for region, sl in te_slices.items():
    Xte, yte = X[sl], y[sl]
    for name, mdl, scaled, rep in [('lr', lr, True, rep_lr), ('hgb', hgb, False, rep_hgb)]:
        p = mdl.predict_proba(sc.transform(Xte) if scaled else Xte)[:, 1]
        pred = (p >= 0.5).astype(int)
        prev = Xte[:, 5]
        base = (prev >= np.percentile(prev[yte == 1], 60) if (yte == 1).any() else prev >= np.percentile(prev, 95)).astype(int)
        rep[region] = dict(iou=round(float(jaccard_score(yte, pred, zero_division=0)), 3),
                           precision=round(float(precision_score(yte, pred, zero_division=0)), 3),
                           recall=round(float(recall_score(yte, pred, zero_division=0)), 3),
                           persistence_baseline_iou=round(float(jaccard_score(yte, base, zero_division=0)), 3))
        print(f"  {name} {region}: IoU {rep[region]['iou']} P {rep[region]['precision']} R {rep[region]['recall']} | persistence {rep[region]['persistence_baseline_iou']}")

out = dict(
    name='ignis-fire-footprint-forecaster', version='2.0.0',
    kind='next-day 0.05-deg fire footprint probability field (segmentation) from prior-days detection density',
    features=FEATS, cell=CELL,
    train_regions={k: list(v) for k, v in REGIONS.items()},
    scaler_mean=[round(float(x), 8) for x in sc.mean_],
    scaler_scale=[round(float(x), 8) for x in sc.scale_],
    coef=[round(float(x), 8) for x in lr.coef_[0]],
    intercept=round(float(lr.intercept_[0]), 8),
    featureContract='scene-max-normalized gaussian KDEs (per region-target-day grid, density/max(density)) then log1p — source-density and day-window agnostic',
    skill=dict(logreg=rep_lr, hgb_reference=rep_hgb),
    caveat='same-day-early density feature approximated with last-available-day KDE in production; documented in model card',
)
dest = WS / 'src/lib/ignis/forecasterWeights.json'
dest.write_text(json.dumps(out, indent=1))
print('wrote', dest, f'({dest.stat().st_size / 1024:.1f} KB)')
joblib.dump({'scaler': sc, 'lr': lr, 'hgb': hgb, 'features': FEATS, 'cell': CELL, 'regions': REGIONS, 'version': '2.0.0-normalized'},
            OUT / 'ignis_fire_footprint_forecaster.joblib')
(OUT / 'metrics.json').write_text(json.dumps(out, indent=2))
print('saved ->', OUT)
