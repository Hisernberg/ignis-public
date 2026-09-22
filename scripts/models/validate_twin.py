#!/usr/bin/env python3
"""Offline validation: does the exported LogReg twin reproduce training-time behavior?
Runs the EXACT algorithm the TS inference.ts implements (integral-image area-ratio box
counts + StandardScaler + multinomial LR) on the training snapshot's last Amazon day,
and compares the predicted class distribution against the DBSCAN weak labels."""
import json
import numpy as np
import pandas as pd
import joblib
from sklearn.cluster import DBSCAN
from sklearn.preprocessing import StandardScaler

W = json.load(open('/home/z/my-project/src/lib/ignis/classifierWeights.json'))
df = pd.read_csv('/home/z/my-project/scripts/hf_model/out/training_snapshot.csv',
                 usecols=['latitude', 'longitude', 'frp', 'confidence_harmonized', 'acq_hour',
                          'daynight', 'satellite', 'acq_date', 'region'])
df = df.dropna(subset=['latitude', 'longitude', 'frp', 'confidence_harmonized', 'acq_hour'])
df['is_night'] = (df['daynight'] == 'N').astype(int)
df['is_viirs'] = df['satellite'].str.startswith('VIIRS').astype(int)
day = sorted(df.acq_date.unique())[-1]
g = df[(df.region == 'amazon') & (df.acq_date == day)].reset_index(drop=True)
print(f'group: amazon {day} | {len(g)} detections')

# --- weak labels (training ground truth generator) ---
X = StandardScaler().fit_transform(g[['latitude', 'longitude']].values)
lab = DBSCAN(eps=0.12, min_samples=6).fit(X).labels_
weak = np.full(len(g), 'ISOLATED', dtype=object)
for c in np.unique(lab[lab >= 0]):
    m = lab == c
    sub = g[m]
    n = int(m.sum()); frp = float(sub.frp.sum()); night = float(sub.is_night.mean())
    if n >= 800 and frp >= 25000: k = 'MEGAFIRE'
    elif n >= 150: k = 'ESTABLISHED'
    elif n >= 40: k = 'EMERGING'
    else: k = 'SCATTERED'
    weak[m] = k
print('weak-label distribution:', pd.Series(weak).value_counts().to_dict())

# --- TS-equivalent inference: integral image box counts with area-ratio correction ---
CELL = 0.01
RADII = [0.05, 0.25, 1.0]
w = g.longitude.min() - 1.05; s = g.latitude.min() - 1.05
e = g.longitude.max() + 1.05; n = g.latitude.max() + 1.05
gw = int(np.ceil((e - w) / CELL)) + 1; gh = int(np.ceil((n - s) / CELL)) + 1
cnt = np.zeros((gh, gw))
ci = np.clip(((g.longitude - w) / CELL).astype(int), 0, gw - 1)
cj = np.clip(((g.latitude - s) / CELL).astype(int), 0, gh - 1)
np.add.at(cnt, (cj, ci), 1)
ii = cnt.cumsum(0).cumsum(1)
ks = [max(1, round(r / CELL)) for r in RADII]
facs = [np.pi * r * r / ((2 * k + 1) * CELL) ** 2 for r, k in zip(RADII, ks)]
med = float(g.frp.median())

def box_count(cjj, cii, k):
    i0, i1 = max(0, cii - k), min(gw - 1, cii + k)
    j0, j1 = max(0, cjj - k), min(gh - 1, cjj + k)
    tot = ii[j1, i1]
    if j0 > 0: tot -= ii[j0 - 1, i1]
    if i0 > 0: tot -= ii[j1, i0 - 1]
    if j0 > 0 and i0 > 0: tot += ii[j0 - 1, i0 - 1]
    return tot

feats = np.zeros((len(g), 9))
feats[:, 0] = np.log1p(g.frp.values)
feats[:, 1] = g.confidence_harmonized.values
feats[:, 2] = g.is_night.values
feats[:, 3] = g.acq_hour.values
feats[:, 4] = g.is_viirs.values
for ri, k in enumerate(ks):
    d = np.zeros(len(g))
    for idx in range(len(g)):
        d[idx] = box_count(cj[idx], ci[idx], k) * facs[ri]
    feats[:, 5 + ri] = d
feats[:, 8] = g.frp.values / (med or 1)

Xs = (feats - np.array(W['scaler_mean'])) / np.array(W['scaler_scale'])
Z = np.array(W['coef']) @ Xs.T + np.array(W['intercept'])[:, None]
probs = np.exp(Z - Z.max(0)); probs /= probs.sum(0)
pred = np.array(W['classes'])[probs.argmax(0)]
print('TS-twin predicted distribution:', pd.Series(pred).value_counts().to_dict())
agree = (pred == weak).mean()
print(f'agreement with weak labels: {agree:.3f}')
conf_mean = float(probs.max(0).mean())
print(f'mean max-prob: {conf_mean:.3f}')
# per-class crosstab
ct = pd.crosstab(pd.Series(weak, name='weak'), pd.Series(pred, name='pred'))
print(ct.to_string())
