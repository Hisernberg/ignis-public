#!/usr/bin/env python3
"""
IGNIS Event Detector — monthly extreme-fire-event early-warning model.

Learns from the 25-year harmonized MODIS+VIIRS calendars (9 regions, 2000-11 -> 2026-08)
to predict whether NEXT month will be an extreme fire month for a region.

Label: next-month unified detections >= climatological month mean + 2 sigma
       (climatology computed on TRAINING years only, per region-month).
Features (all lagged — no leakage):
  log1p est lag1, lag3mean, lag12same-month, FRP lag1, hiConf share lag1,
  night share lag1, region one-hot(9), month sin/cos.

Primary shipped model: LogisticRegression (weights exported to JSON so the app can
score deterministically in TypeScript). Reference model: HistGradientBoosting.
"""
import json, pathlib
import numpy as np, pandas as pd, joblib
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score, average_precision_score, f1_score, brier_score_loss
from sklearn.preprocessing import StandardScaler

WS = pathlib.Path('/home/z/my-project')
OUT = WS / 'scripts/models/out/ignis-event-detector'
OUT.mkdir(parents=True, exist_ok=True)
REGIONS = ['amazon', 'california', 'canada', 'siberia', 'congo', 'borneo', 'australia', 'mediterranean', 'bangladesh']

# ---------- load & unify ----------
rows = []
for r in REGIONS:
    d = json.load(open(WS / f'data/ignis/calendar_{r}.json'))
    by_ym = {}
    for sensor, s in d['sensors'].items():
        for m in s.get('monthly', []):
            rec = by_ym.setdefault(m['ym'], dict(ym=m['ym'], est=0, frp=0, hiConf=0, night=0, days=0, n_sensors=0))
            rec['est'] += m.get('est', 0); rec['frp'] += m.get('frp', 0)
            rec['hiConf'] += m.get('hiConf', 0); rec['night'] += m.get('night', 0)
            rec['days'] += m.get('days', 0); rec['n_sensors'] += 1
    for rec in by_ym.values():
        rows.append(dict(region=r, ym=rec['ym'], est=rec['est'], frp=rec['frp'],
                         hiConf_share=rec['hiConf'] / max(rec['est'], 1),
                         night_share=rec['night'] / max(rec['est'], 1)))
df = pd.DataFrame(rows).sort_values(['region', 'ym']).reset_index(drop=True)
df['month'] = df['ym'].str[5:7].astype(int)
df['year'] = df['ym'].str[:4].astype(int)
print(f'unified region-months: {len(df)} ({df.region.nunique()} regions, {df.ym.min()}..{df.ym.max()})')

# ---------- lag features ----------
g = df.groupby('region')
df['est_lag1'] = g['est'].shift(1)
df['est_lag3'] = g['est'].shift(3).rolling(3, min_periods=1).mean()  # mean of lag3..lag1 approx
df['est_lag12'] = g['est'].shift(12)
df['frp_lag1'] = g['frp'].shift(1)
df['hic_lag1'] = g['hiConf_share'].shift(1)
df['night_lag1'] = g['night_share'].shift(1)
df['est_next'] = g['est'].shift(-1)

# ---------- climatology on TRAIN years only (<= 2021) ----------
train_years = df['year'] <= 2021
clim = df[train_years].groupby(['region', 'month'])['est'].agg(['mean', 'std']).reset_index()
clim.columns = ['region', 'month', 'clim_mean', 'clim_std']
df = df.merge(clim, on=['region', 'month'], how='left')
reg_default = df[train_years].groupby('region')['est'].mean()
df['clim_mean'] = df['clim_mean'].fillna(df['region'].map(reg_default)).fillna(df['est'])
df['clim_std'] = df['clim_std'].fillna(df['clim_mean'] * 0.6).clip(lower=1)
df['z_next'] = (df['est_next'] - df['clim_mean']) / df['clim_std']
df['y'] = (df['z_next'] >= 2.0).astype(int)

feat = ['est_lag1', 'est_lag3', 'est_lag12', 'frp_lag1', 'hic_lag1', 'night_lag1', 'msin', 'mcos']
df['msin'] = np.sin(2 * np.pi * df['month'] / 12); df['mcos'] = np.cos(2 * np.pi * df['month'] / 12)
# region one-hot
for r in REGIONS[1:]:
    df[f'r_{r}'] = (df['region'] == r).astype(int); feat.append(f'r_{r}')

data = df.dropna(subset=feat + ['est_next', 'y']).reset_index(drop=True)
tr = data[data['year'] <= 2021]; te = data[data['year'] > 2021]
Xtr, ytr = tr[feat].values, tr['y'].values
Xte, yte = te[feat].values, te['y'].values
print(f'train: {len(tr)} months, positives {ytr.sum()} ({100*ytr.mean():.1f}%) | test: {len(te)}, positives {yte.sum()} ({100*yte.mean():.1f}%)')

sc = StandardScaler().fit(Xtr)
lr = LogisticRegression(C=1.0, max_iter=2000, class_weight='balanced').fit(sc.transform(Xtr), ytr)
hgb = HistGradientBoostingClassifier(max_iter=150, max_depth=4, learning_rate=0.08).fit(Xtr, ytr)

def rep(name, model, X, y, scaled=False):
    p = model.predict_proba(sc.transform(X) if scaled else X)[:, 1]
    return dict(model=name, auc=round(float(roc_auc_score(y, p)), 3),
                ap=round(float(average_precision_score(y, p)), 3),
                f1=round(float(f1_score(y, (p >= 0.5).astype(int))), 3),
                brier=round(float(brier_score_loss(y, p)), 3))
metrics = {
    'logreg_test': rep('LogisticRegression', lr, Xte, yte, scaled=True),
    'logreg_train': rep('LogisticRegression', lr, Xtr, ytr, scaled=True),
    'hgb_test': rep('HistGradientBoosting', hgb, Xte, yte),
}
print('metrics:', json.dumps(metrics, indent=1))

# ---------- portable artifacts ----------
weights = {
    'name': 'ignis-event-detector',
    'version': '1.0.0',
    'description': 'Next-month extreme fire-month likelihood (z>=2 vs 2000-2021 climatology), harmonized MODIS+VIIRS calendars',
    'features': feat,
    'scaler_mean': sc.mean_.tolist(), 'scaler_scale': sc.scale_.tolist(),
    'coef': lr.coef_[0].tolist(), 'intercept': float(lr.intercept_[0]),
    'decision_threshold': 0.5,
    'labels': {0: 'normal month', 1: 'extreme fire month ahead'},
    'metrics': metrics, 'n_train': int(len(tr)), 'n_test': int(len(te)),
    'positives_rate_train': float(ytr.mean()), 'positives_rate_test': float(yte.mean()),
    'regions': REGIONS,
}
(OUT / 'weights.json').write_text(json.dumps(weights, indent=2))
joblib.dump({'scaler': sc, 'model': lr, 'features': feat}, OUT / 'ignis_event_detector.joblib')
joblib.dump(hgb, OUT / 'ignis_event_detector_hgb_reference.joblib')

# ---------- live scoring preview for every region, latest month ----------
latest = df.dropna(subset=['est_lag1']).groupby('region').tail(1)
pv = []
for _, r in latest.iterrows():
    x = np.array([r[f] for f in feat]).reshape(1, -1)
    p = float(lr.predict_proba(sc.transform(x))[0, 1])
    pv.append({'region': r['region'], 'ym': r['ym'], 'p_extreme_next': round(p, 3)})
(OUT / 'live_scores.json').write_text(json.dumps(pv, indent=2))
print('live preview:', json.dumps(pv[:4]))
print('saved ->', OUT)
