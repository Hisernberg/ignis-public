#!/usr/bin/env python3
"""Isolate the classifier twin discrepancy: exact cKDTree features vs box-count features."""
import json
import numpy as np
import pandas as pd
import joblib
from sklearn.preprocessing import StandardScaler
from scipy.spatial import cKDTree

B = joblib.load('/tmp/mw/classifier/ignis_fire_classifier_logreg.joblib')
sc, model, feats, classes = B['scaler'], B['model'], list(B['features']), [str(c) for c in B['classes']]
print('bundle features:', feats)
print('bundle classes:', classes)
print('scaler mean:', dict(zip(feats, np.round(sc.mean_, 2))))
print('scaler scale:', dict(zip(feats, np.round(sc.scale_, 2))))

W = json.load(open('/home/z/my-project/src/lib/ignis/classifierWeights.json'))
print('json scaler mean:', dict(zip(W['features'], [round(x, 2) for x in W['scaler_mean']])))
same = np.allclose(sc.mean_, W['scaler_mean'], atol=1e-6) and np.allclose(model.coef_, W['coef'], atol=1e-6)
print('json == bundle:', same)

df = pd.read_csv('/home/z/my-project/scripts/hf_model/out/training_snapshot.csv',
                 usecols=['latitude', 'longitude', 'frp', 'confidence_harmonized', 'acq_hour',
                          'daynight', 'satellite', 'acq_date', 'region'])
df = df.dropna(subset=['latitude', 'longitude', 'frp', 'confidence_harmonized', 'acq_hour'])
df['is_night'] = (df['daynight'] == 'N').astype(int)
df['is_viirs'] = df['satellite'].str.startswith('VIIRS').astype(int)
day = sorted(df.acq_date.unique())[-1]
g = df[(df.region == 'amazon') & (df.acq_date == day)].reset_index(drop=True)

# exact training-style features
for radius_deg, col in [(0.05, 'dens_5km'), (0.25, 'dens_25km'), (1.0, 'dens_100km')]:
    pts = g[['latitude', 'longitude']].values
    tree = cKDTree(pts)
    g[col] = [len(tree.query_ball_point(p, radius_deg)) for p in pts]
med = g.frp.median()
X = np.column_stack([
    np.log1p(g.frp), g.confidence_harmonized, g.is_night, g.acq_hour, g.is_viirs,
    g.dens_5km, g.dens_25km, g.dens_100km, g.frp / med,
])
print('exact feature means:', dict(zip(feats, np.round(X.mean(0), 2))))
pred_exact = model.predict(sc.transform(X))
print('exact-feature predicted distribution:', pd.Series(pred_exact).value_counts().to_dict())
print('dens means exact:', g[['dens_5km', 'dens_25km', 'dens_100km']].mean().round(1).to_dict())
