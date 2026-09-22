#!/usr/bin/env python3
"""
IGNIS Burn-Scar Segmenter — pixel-wise segmentation of NASA GIBS 7-2-1 false-color
imagery (MODIS Terra Bands721) into BACKGROUND / ACTIVE_FIRE / BURN_SCAR.

Supervision (weak, honest): FIRMS active-fire detections rasterized onto the tile
grid mark ACTIVE_FIRE pixels; a 7-2-1 char-spectral rule restricted to a corridor
around the week's fire activity marks BURN_SCAR pixels; the model (random-forest
pixel classifier) then learns a spatially-generalizing, denoised version of that
rule and generalizes to HELD-OUT TILES (spatial split) — evaluated with IoU.

Also exports: per-tile scar masks (PNG), vectorized scar boundaries (GeoJSON),
inference script for new tiles.
"""
import json, math, io, pathlib, urllib.request
import numpy as np, pandas as pd, joblib
from PIL import Image
from scipy import ndimage as ndi
from scipy.ndimage import uniform_filter as _uf
uniform = lambda a, s: _uf(a, size=s)
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import jaccard_score

WS = pathlib.Path('/home/z/my-project')
OUT = WS / 'scripts/models/out/ignis-burn-scar-segmenter'
(OUT / 'masks').mkdir(parents=True, exist_ok=True)
(OUT / 'geojson').mkdir(parents=True, exist_ok=True)

Z = 7  # GIBS GoogleMapsCompatible level 9 imagery, fetched at z7 (~1.1 km/px)

def lonlat_to_tile(lon, lat, z=Z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y

def tile_lonlat(x, y, z=Z):
    n = 2 ** z
    lon1, lon2 = x / n * 360 - 180, (x + 1) / n * 360 - 180
    lat2 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat1 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return lon1, lat1, lon2, lat2

def gibs721_url(x, y, day):
    return (f'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/'
            f'MODIS_Terra_CorrectedReflectance_Bands721/default/{day}/GoogleMapsCompatible_Level9/{Z}/{x}/{y}.jpg')

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'IGNIS-training/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return np.asarray(Image.open(io.BytesIO(r.read())).convert('RGB'), dtype=np.float32) / 255.0

# ---------- events ----------
events = [
    dict(name='amazon_2026', scar_day='2026-09-20', src='snapshot', region='amazon',
         core=(-60, -10, -50, 0)),
    dict(name='congo_2026', scar_day='2026-09-20', src='snapshot', region='congo',
         core=(13, -6, 30, 6)),
    dict(name='borneo_2026', scar_day='2026-09-20', src='snapshot', region='borneo',
         core=(98, -4, 118, 4)),
    dict(name='australia_2020', scar_day='2020-01-05', src='gibsfires', region='australia',
         core=(145, -40, 155, -30), fire_day='2020-01-05'),
]

det = pd.read_csv(WS / 'scripts/hf_model/out/training_snapshot.csv',
                  usecols=['latitude', 'longitude', 'frp', 'acq_date', 'region'])

samples_X, samples_y, tile_ids = [], [], []
tiles_meta = []
for ev in events:
    lon1c, lat1c, lon2c, lat2c = ev['core']
    x0, y1 = lonlat_to_tile(lon1c, lat2c)   # top-left
    x1, y2 = lonlat_to_tile(lon2c, lat1c)   # bottom-right
    cand = []
    for x in range(x0, x1 + 1):
        for y in range(y1, y2 + 1):
            tl = tile_lonlat(x, y)
            if ev['src'] == 'snapshot':
                m = det[(det.region == ev['region']) & (det.longitude >= tl[0]) & (det.longitude < tl[2]) &
                        (det.latitude >= tl[1]) & (det.latitude < tl[3])]
                n_det = len(m)
            else:
                n_det = -1  # fetched later per tile from prod
            cand.append((x, y, n_det, tl))
    cand.sort(key=lambda t: -t[2])
    for x, y, n_det, tl in cand[:8 if ev['src'] == 'snapshot' else 5]:
        tiles_meta.append(dict(ev=ev['name'], x=x, y=y, day=ev['scar_day'], n_det=n_det, lonlat=tl))
print(f'{len(tiles_meta)} tiles selected')

prod = 'https://ignis-spaceapps2026.vercel.app'
X_all, y_all, groups = [], [], []
for i, tm in enumerate(tiles_meta):
    x, y, day = tm['x'], tm['y'], tm['day']
    lon1, lat1, lon2, lat2 = tm['lonlat']
    try:
        img = fetch(gibs721_url(x, y, day))
    except Exception as e:
        print(f"  tile {x}/{y} fetch fail: {e}"); continue
    # detections for this tile
    if tm['ev'].startswith('australia'):
        try:
            u = f"{prod}/api/gibsfires?w={lon1}&s={lat1}&e={lon2}&n={lat2}&day={tm['day']}"
            gj = json.loads(urllib.request.urlopen(u, timeout=40).read())
            pts = [(f['properties'].get('latitude') or f['geometry']['coordinates'][1],
                    f['properties'].get('longitude') or f['geometry']['coordinates'][0]) for f in gj.get('features', [])]
        except Exception as e:
            print(f"  gibsfires fail tile {x}/{y}: {e}"); continue
    else:
        m = det[(det.region == tm['ev'].split('_')[0]) & (det.longitude >= lon1) & (det.longitude < lon2) &
                (det.latitude >= lat1) & (det.latitude < lat2)]
        pts = list(zip(m.latitude, m.longitude))
    H = W = 256
    fire_mask = np.zeros((H, W), dtype=bool)
    for la, lo in pts:
        if not (lon1 <= lo < lon2 and lat1 <= la < lat2):
            continue
        px = int((lo - lon1) / (lon2 - lon1) * W)
        py = int((lat2 - la) / (lat2 - lat1) * H)
        if 0 <= px < W and 0 <= py < H:
            fire_mask[max(0, py-1):py+2, max(0, px-1):px+2] = True
    n_fire = fire_mask.sum()
    if n_fire < 3:
        continue
    # char-spectral rule for scar (7-2-1: band7=R, band2=G, band1=B)
    R, G, B = img[..., 0], img[..., 1], img[..., 2]
    s = R + G + B + 1e-4
    redness = R / s
    char_idx = (R - B) / (R + B + 1e-4)
    bright = img.mean(-1)
    scar_rule = (redness > 0.38) & (char_idx > 0.18) & (G < 0.36) & (bright > 0.09) & (bright < 0.65)
    near_fire = ndi.distance_transform_edt(~fire_mask) < 48
    scar_rule &= near_fire
    scar_rule = ndi.binary_closing(ndi.binary_opening(scar_rule, iterations=1), iterations=2)
    # features
    feats = np.stack([R, G, B, bright, redness, char_idx,
                      uniform(redness, 3), uniform(bright, 3),
                      ndi.generic_filter(bright, np.std, size=3, mode='reflect')], -1)
    label = np.zeros((H, W), dtype=np.int64)  # 0 background
    label[scar_rule] = 2
    label[fire_mask] = 1
    bg = (label == 0) & (ndi.distance_transform_edt(~(fire_mask | scar_rule)) > 3)
    lab_fin = label.copy(); lab_fin[bg] = 0
    keep = ~((label == 0) & ~bg)  # drop ambiguous buffer pixels
    X_all.append(feats[keep]); y_all.append(lab_fin[keep]); groups.append(np.full(keep.sum(), i))
    tiles_meta[i]['n_fire_px'] = int(n_fire); tiles_meta[i]['n_scar_px'] = int(scar_rule.sum())
    print(f"  tile {tm['ev']} {x}/{y}: fire_px={n_fire} scar_px={scar_rule.sum()}")

X = np.concatenate(X_all); y = np.concatenate(y_all); g = np.concatenate(groups)
print(f'pixels: {len(X)} | class counts: {np.bincount(y, minlength=3)}')

# ---------- leave-one-event-out (cross-continental generalization) ----------
uniq = np.unique(g)
ev_of = {i: tm['ev'].rsplit('_', 1)[0] for i, tm in enumerate(tiles_meta) if i in set(uniq.tolist())}
events_names = sorted({ev_of[i] for i in uniq})
per_event = {}
for held in events_names:
    te_m = np.array([ev_of[i] == held for i in g])
    tr_m = ~te_m
    rf_cv = RandomForestClassifier(n_estimators=40, max_depth=14, max_features=3, n_jobs=-1, random_state=42).fit(X[tr_m], y[tr_m])
    pred = rf_cv.predict(X[te_m])
    iou = jaccard_score(y[te_m], pred, average=None, labels=[0, 1, 2], zero_division=0)
    per_event[held] = dict(iou_background=round(float(iou[0]), 3), iou_active_fire=round(float(iou[1]), 3),
                           iou_burn_scar=round(float(iou[2]), 3), n_pixels=int(te_m.sum()))
    print(f'LOEO {held}: scar IoU {iou[2]:.3f} fire IoU {iou[1]:.3f} bg {iou[0]:.3f}')
# final model on ALL data
rf = RandomForestClassifier(n_estimators=40, max_depth=14, max_features=3, n_jobs=-1, random_state=42).fit(X, y)
iou = jaccard_score(y, rf.predict(X), average=None, labels=[0, 1, 2], zero_division=0)
metrics = {
    'model': 'ignis-burn-scar-segmenter',
    'architecture': 'RandomForest pixel classifier (40 trees, depth 14) on 9 spectral/spatial features',
    'source_imagery': 'NASA GIBS MODIS_Terra_CorrectedReflectance_Bands721 (7-2-1 false color), z7 tiles',
    'supervision': 'weak: FIRMS active-fire detections + char-spectral rule near fire corridors',
    'tiles': len(uniq), 'pixels': int(len(X)),
    'class_counts': np.bincount(y, minlength=3).tolist(),
    'leave_one_event_out': per_event,
    'in_sample_iou_background': round(float(iou[0]), 3), 'in_sample_iou_active_fire': round(float(iou[1]), 3),
    'in_sample_iou_burn_scar': round(float(iou[2]), 3),
    'labels': {0: 'background', 1: 'active_fire', 2: 'burn_scar'},
    'features': ['R', 'G', 'B', 'brightness', 'redness', 'char_index', 'redness_mean3', 'brightness_mean3', 'brightness_std3'],
}
print(json.dumps(metrics, indent=1))
(OUT / 'metrics.json').write_text(json.dumps(metrics, indent=2))
joblib.dump({'model': rf, 'features': metrics['features'], 'z': Z}, OUT / 'ignis_burn_scar_segmenter.joblib')
(OUT / 'tiles_used.json').write_text(json.dumps(tiles_meta, indent=1, default=str))

# ---------- sample mask + geojson for one tile per event ----------
from skimage import measure
for i, tm in enumerate(tiles_meta):
    if 'n_fire_px' not in tm or i % 2 != 0:
        continue
    img = fetch(gibs721_url(tm['x'], tm['y'], tm['day']))
    R, G, B = img[..., 0], img[..., 1], img[..., 2]
    s = R + G + B + 1e-4
    feats = np.stack([R, G, B, img.mean(-1), R / s, (R - B) / (R + B + 1e-4),
                      uniform(R / s, 3), uniform(img.mean(-1), 3),
                      ndi.generic_filter(img.mean(-1), np.std, size=3, mode='reflect')], -1)
    cls_idx = int(np.where(rf.classes_ == 2)[0][0])
    pm = rf.predict_proba(feats.reshape(-1, 9))[:, cls_idx].reshape(256, 256)
    mask = (pm > 0.5)
    Image.fromarray((mask * 255).astype(np.uint8)).save(OUT / 'masks' / f"{tm['ev']}_{tm['x']}_{tm['y']}.png")
    polys = []
    for c in measure.find_contours(pm.astype(float), 0.5):
        if len(c) < 40:
            continue
        coords = [[round(float(lon1 + (p[1] / 256) * (lon2 - lon1)), 4),
                   round(float(lat2 - (p[0] / 256) * (lat2 - lat1)), 4)] for p in c[::4]]
        polys.append(dict(type='Feature',
                          properties=dict(predicted_scar_probability=0.5, tile=f'{tm["x"]}/{tm["y"]}',
                                          event=tm['ev'], day=tm['day']),
                          geometry=dict(type='LineString', coordinates=coords)))
    (OUT / 'geojson' / f"{tm['ev']}_{tm['x']}_{tm['y']}.geojson").write_text(
        json.dumps(dict(type='FeatureCollection', features=polys)))
print('saved ->', OUT)
