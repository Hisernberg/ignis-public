#!/usr/bin/env python3
"""
IGNIS Fire Classifier — per-detection fire-behavior classification.

Weak supervision: unsupervised DBSCAN segmentation (the same engine as the app's
Fire Cluster Lab) labels fire complexes as MEGAFIRE / ESTABLISHED / EMERGING /
SCATTERED; unclustered detections become ISOLATED. A supervised classifier then
learns to reproduce those behavior classes directly from per-detection features
(FRP, confidence, diurnal phase, sensor family, local density) — enabling
zero-latency classification of brand-new detections before clustering runs.

Temporal split: first 4 acquisition days train, last day test.
"""
import json, pathlib
import numpy as np, pandas as pd, joblib
from sklearn.cluster import DBSCAN
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import f1_score, accuracy_score, confusion_matrix

WS = pathlib.Path('/home/z/my-project')
OUT = WS / 'scripts/models/out/ignis-fire-classifier'
OUT.mkdir(parents=True, exist_ok=True)

df = pd.read_csv(WS / 'scripts/hf_model/out/training_snapshot.csv')
df = df.dropna(subset=['latitude', 'longitude', 'frp', 'confidence_harmonized', 'acq_hour'])
df['is_night'] = (df['daynight'] == 'N').astype(int)
df['is_viirs'] = df['satellite'].str.startswith('VIIRS').astype(int)
df['log_frp'] = np.log1p(df['frp'])
print(f'detections: {len(df)} | regions: {df.region.unique()} | days: {sorted(df.acq_date.unique())}')

# ---------- weak labels: DBSCAN per region-day (StandardScaler space, app engine params) ----------
from sklearn.preprocessing import StandardScaler as _SS
classes_all = []
CLS = ['ISOLATED', 'SCATTERED', 'EMERGING', 'ESTABLISHED', 'MEGAFIRE']
for (reg, day), g in df.groupby(['region', 'acq_date']):
    X = _SS().fit_transform(g[['latitude', 'longitude']].values)
    lab = DBSCAN(eps=0.12, min_samples=6).fit(X).labels_
    cls = np.full(len(g), 'ISOLATED', dtype=object)
    for c in np.unique(lab[lab >= 0]):
        m = lab == c
        sub = g[m]
        n = int(m.sum()); frp = float(sub.frp.sum()); night = float(sub.is_night.mean())
        if n >= 800 and frp >= 25000:
            k = 'MEGAFIRE'
        elif n >= 150:
            k = 'ESTABLISHED'
        elif n >= 40:
            k = 'EMERGING'
        else:
            k = 'SCATTERED'
        cls[m] = k
    classes_all.append(pd.Series(cls, index=g.index))
df['behavior'] = pd.concat(classes_all).sort_index()
print(df.behavior.value_counts().to_string())

# ---------- multi-scale local density (~5 km, ~28 km, ~110 km boxes) ----------
from scipy.spatial import cKDTree
for radius_deg, col in [(0.05, 'dens_5km'), (0.25, 'dens_25km'), (1.0, 'dens_100km')]:
    colvals = np.zeros(len(df))
    for (reg, day), g in df.groupby(['region', 'acq_date']):
        pts = g[['latitude', 'longitude']].values
        tree = cKDTree(pts)
        colvals[g.index] = np.array([len(tree.query_ball_point(p, radius_deg)) for p in pts])
    df[col] = colvals
med = df.groupby(['region', 'acq_date'])['frp'].median()
df['frp_ratio'] = df.frp / df.set_index(['region', 'acq_date']).index.map(med)

FEATS = ['log_frp', 'confidence_harmonized', 'is_night', 'acq_hour', 'is_viirs',
         'dens_5km', 'dens_25km', 'dens_100km', 'frp_ratio']
days = sorted(df.acq_date.unique())
tr, te = df[df.acq_date.isin(days[:-1])], df[df.acq_date == days[-1]]
Xtr, ytr = tr[FEATS].values, tr.behavior.values
Xte, yte = te[FEATS].values, te.behavior.values
print(f'train {len(tr)} | test {len(te)} (day {days[-1]})')

hgb = HistGradientBoostingClassifier(max_iter=200, max_depth=6, learning_rate=0.1).fit(Xtr, ytr)
sc = StandardScaler().fit(Xtr)
lr = LogisticRegression(max_iter=1500, class_weight='balanced').fit(sc.transform(Xtr), ytr)

for name, m, X, y in [('HGB test', hgb, Xte, yte), ('HGB train', hgb, Xtr, ytr)]:
    pred = m.predict(X)
    print(f'{name}: acc={accuracy_score(y, pred):.3f} macroF1={f1_score(y, pred, average="macro"):.3f}')
cm = confusion_matrix(yte, hgb.predict(Xte), labels=CLS)
print('confusion (rows=true, cols=pred):', CLS)
print(cm)

metrics = {
    'hgb_test_accuracy': round(float(accuracy_score(yte, hgb.predict(Xte))), 3),
    'hgb_test_macro_f1': round(float(f1_score(yte, hgb.predict(Xte), average='macro')), 3),
    'hgb_train_macro_f1': round(float(f1_score(ytr, hgb.predict(Xtr), average='macro')), 3),
    'logreg_test_macro_f1': round(float(f1_score(yte, lr.predict(sc.transform(Xte)), average='macro')), 3),
    'n_train': int(len(tr)), 'n_test': int(len(te)), 'classes': CLS,
    'confusion_test': cm.tolist(),
    'class_counts': df.behavior.value_counts().to_dict(),
    'features': FEATS,
    'split': f'train days {days[:-1]} / test day {days[-1]}',
    'labeling': 'weak supervision from DBSCAN complex segmentation (app Fire Cluster Lab engine)',
}
(OUT / 'metrics.json').write_text(json.dumps(metrics, indent=2))
joblib.dump({'model': hgb, 'features': FEATS, 'classes': CLS}, OUT / 'ignis_fire_classifier.joblib')
joblib.dump({'scaler': sc, 'model': lr, 'features': FEATS, 'classes': CLS}, OUT / 'ignis_fire_classifier_logreg.joblib')
df.sample(min(5000, len(df)), random_state=42).to_csv(OUT / 'labeled_sample.csv', index=False)
print('saved ->', OUT)
