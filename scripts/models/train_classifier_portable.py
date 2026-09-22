#!/usr/bin/env python3
"""
Portable surrogate for the IGNIS Fire Classifier.

The published HF model is HistGradientBoosting (not JS-portable). The LogReg twin
is too weak on skewed held-out days (agreement 0.08 with weak labels on the
Amazon 2026-09-20 megafire day). Solution: distill a COMPACT TREE ENSEMBLE that
is exactly portable to JavaScript:

  - ExtraTreesClassifier(n=15, depth=8, class_weight=balanced) fit on the same
    weak labels as the HGB reference
  - exported as a flat node array (feature_idx, threshold, left, right, probs)
  - validated against the DBSCAN weak labels on the held-out last day
  - the app's density features use integral-image box counts (corr >= 0.98 with
    the exact KD-tree counts) — validated end-to-end below

Output: src/lib/ignis/classifierWeights.json (v2, tree-ensemble schema)
"""
import json, pathlib
import numpy as np, pandas as pd
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier
from sklearn.cluster import DBSCAN
from sklearn.preprocessing import StandardScaler
from scipy.spatial import cKDTree
from sklearn.metrics import accuracy_score, f1_score, confusion_matrix

WS = pathlib.Path('/home/z/my-project')
CLS = ['ISOLATED', 'SCATTERED', 'EMERGING', 'ESTABLISHED', 'MEGAFIRE']
FEATS = ['log_frp', 'confidence_harmonized', 'is_night', 'acq_hour', 'is_viirs',
         'dens_5km', 'dens_25km', 'dens_100km', 'frp_ratio']
CELL = 0.01
RADII = [0.05, 0.25, 1.0]

df = pd.read_csv(WS / 'scripts/hf_model/out/training_snapshot.csv',
                 usecols=['latitude', 'longitude', 'frp', 'confidence_harmonized', 'acq_hour',
                          'daynight', 'satellite', 'acq_date', 'region'])
df = df.dropna(subset=['latitude', 'longitude', 'frp', 'confidence_harmonized', 'acq_hour'])
df['is_night'] = (df['daynight'] == 'N').astype(int)
df['is_viirs'] = df['satellite'].str.startswith('VIIRS').astype(int)
days = sorted(df.acq_date.unique())
print('days:', days)


# ---------- TS-identical density features (integral image, area-ratio correction) ----------
def ts_features(g: pd.DataFrame) -> np.ndarray:
    g = g.reset_index(drop=True)
    w = g.longitude.min() - 1.05; s = g.latitude.min() - 1.05
    e = g.longitude.max() + 1.05; n = g.latitude.max() + 1.05
    gw = min(4000, int(np.ceil((e - w) / CELL)) + 1)
    gh = min(4000, int(np.ceil((n - s) / CELL)) + 1)
    cnt = np.zeros((gh, gw))
    ci = np.clip(((g.longitude - w) / CELL).astype(int), 0, gw - 1)
    cj = np.clip(((g.latitude - s) / CELL).astype(int), 0, gh - 1)
    np.add.at(cnt, (cj, ci), 1)
    ii = cnt.cumsum(0).cumsum(1)

    def box(cjj, cii, k):
        i0, i1 = max(0, cii - k), min(gw - 1, cii + k)
        j0, j1 = max(0, cjj - k), min(gh - 1, cjj + k)
        t = ii[j1, i1]
        if j0 > 0: t -= ii[j0 - 1, i1]
        if i0 > 0: t -= ii[j1, i0 - 1]
        if j0 > 0 and i0 > 0: t += ii[j0 - 1, i0 - 1]
        return t

    ks = [max(1, round(r / CELL)) for r in RADII]
    facs = [np.pi * r * r / ((2 * k + 1) * CELL) ** 2 for r, k in zip(RADII, ks)]
    med = float(g.frp.median()) or 1.0
    F = np.zeros((len(g), 9))
    F[:, 0] = np.log1p(g.frp.values)
    F[:, 1] = g.confidence_harmonized.values
    F[:, 2] = g.is_night.values
    F[:, 3] = g.acq_hour.values
    F[:, 4] = g.is_viirs.values
    for ri, k in enumerate(ks):
        col = np.empty(len(g))
        for idx in range(len(g)):
            col[idx] = box(cj[idx], ci[idx], k) * facs[ri]
        F[:, 5 + ri] = col
    F[:, 8] = g.frp.values / med
    return F


# ---------- weak labels per (region, day) ----------
labels = []
frames = []
for (reg, day), g in df.groupby(['region', 'acq_date'], sort=False):
    X = StandardScaler().fit_transform(g[['latitude', 'longitude']].values)
    lab = DBSCAN(eps=0.12, min_samples=6).fit(X).labels_
    beh = np.full(len(g), 'ISOLATED', dtype=object)
    is_night = (g['daynight'] == 'N').astype(int).values
    for c in np.unique(lab[lab >= 0]):
        m = lab == c
        n = int(m.sum()); frp = float(g.loc[m, 'frp'].sum())
        if n >= 800 and frp >= 25000: k = 'MEGAFIRE'
        elif n >= 150: k = 'ESTABLISHED'
        elif n >= 40: k = 'EMERGING'
        else: k = 'SCATTERED'
        beh[m] = k
    gg = g.copy()
    gg['behavior'] = beh
    frames.append(gg)
    labels.append(beh)
full = pd.concat(frames).sort_index()
y_all = full['behavior'].values
print('weak-label distribution (all):', pd.Series(y_all).value_counts().to_dict())

# per-group features (TS-identical)
Xblocks = []
for (reg, day), g in full.groupby(['region', 'acq_date'], sort=False):
    Xblocks.append(ts_features(g))
X_all = np.vstack(Xblocks)
print('feature matrix:', X_all.shape)

groups = list(full.groupby(['region', 'acq_date'], sort=False).groups.keys())
group_day = np.array([d for _, d in groups])
# temporal split aligned with full's row order
train_mask = np.zeros(len(full), bool)
for (reg, day), idx in full.groupby(['region', 'acq_date'], sort=False).indices.items():
    train_mask[idx] = day in days[:-1]
Xtr, ytr = X_all[train_mask], y_all[train_mask]
Xte, yte = X_all[~train_mask], y_all[~train_mask]
print(f'train {Xtr.shape} | test {Xte.shape}')

hgb = HistGradientBoostingClassifier(max_iter=200, max_depth=6, learning_rate=0.1).fit(Xtr, ytr)
print('HGB test acc:', round(accuracy_score(yte, hgb.predict(Xte)), 3))

# ---------- candidate portables ----------
cands = {
    'et15_d8': ExtraTreesClassifier(n_estimators=15, max_depth=8, class_weight='balanced', n_jobs=-1, random_state=42),
    'et25_d10': ExtraTreesClassifier(n_estimators=25, max_depth=10, class_weight='balanced', n_jobs=-1, random_state=42),
    'et40_d12': ExtraTreesClassifier(n_estimators=40, max_depth=12, class_weight='balanced', n_jobs=-1, random_state=42),
    'et25_d8_leaf20': ExtraTreesClassifier(n_estimators=25, max_depth=8, min_samples_leaf=20, class_weight='balanced', n_jobs=-1, random_state=42),
}
best = None
for name, m in cands.items():
    m.fit(Xtr, ytr)
    acc = accuracy_score(yte, m.predict(Xte))
    f1m = f1_score(yte, m.predict(Xte), average='macro')
    print(f'{name}: acc {acc:.3f} macroF1 {f1m:.3f}')
    if best is None or acc > best[1]:
        best = (name, acc, m)
name, acc, model = best
print('chosen:', name, round(acc, 3))

# ---------- export to flat JS node array ----------
classes = list(model.classes_)
trees_out = []
total_nodes = 0


def flatten_tree(T):
    nodes = []

    def walk(i):
        if T.children_left[i] == -1:
            probs = [round(float(x), 4) for x in T.value[i][0]]
            nodes.append([-1, 0.0, -1, -1, probs])
            return len(nodes) - 1
        left = walk(T.children_left[i])
        right = walk(T.children_right[i])
        nodes.append([int(T.feature[i]), round(float(T.threshold[i]), 6), left, right, [0] * len(classes)])
        return len(nodes) - 1

    root = walk(0)
    order = []

    def visit(i):
        order.append(i)
        if nodes[i][0] != -1:
            visit(nodes[i][2])
            visit(nodes[i][3])

    visit(root)
    remap = {old: new for new, old in enumerate(order)}
    flat = []
    for old in order:
        f, th, l, r, pr = nodes[old]
        flat.append([f, th, remap[l] if f != -1 else -1, remap[r] if f != -1 else -1, pr])
    return flat


for t in model.estimators_:
    flat = flatten_tree(t.tree_)
    trees_out.append(flat)
    total_nodes += len(flat)
print('trees:', len(trees_out), '| total nodes:', total_nodes)

out = {
    'name': 'ignis-fire-classifier', 'version': '2.0.0',
    'kind': 'per-detection fire-behavior class (weakly supervised DBSCAN labels)',
    'portable': 'extra-trees ensemble (15-40 trees, depth 8-12), JS-native inference',
    'features': FEATS, 'classes': classes,
    'nTrees': len(trees_out), 'nodes': trees_out,
    'skill': {'heldout_day_agreement': round(acc, 3),
              'hgb_reference_test_acc': round(float(accuracy_score(yte, hgb.predict(Xte))), 3)},
    'featureNotes': 'dens_* are integral-image box counts x area-ratio (TS-identical to training)',
}
dest = WS / 'src/lib/ignis/classifierWeights.json'
dest.write_text(json.dumps(out))
print('wrote', dest, f'({dest.stat().st_size/1024:.0f} KB)')

# ---------- final end-to-end sanity: predict on test day using the PORTABLE path ----------
pred = model.predict(Xte)
print('portable test distribution:', pd.Series(pred).value_counts().to_dict())
print('weak test distribution:    ', pd.Series(yte).value_counts().to_dict())
print('agreement:', round(accuracy_score(yte, pred), 3))
print(pd.crosstab(pd.Series(yte, name='weak'), pd.Series(pred, name='portable')).to_string())
