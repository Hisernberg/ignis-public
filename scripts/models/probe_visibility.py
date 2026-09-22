#!/usr/bin/env python3
"""Probe fire-visibility (SWIR contrast at detections) across candidate events/dates/tiles."""
import json, math, io, urllib.request
import numpy as np, pandas as pd
from PIL import Image
from scipy import ndimage as ndi

Z = 7
PROD = 'https://ignis-spaceapps2026.vercel.app'

def tile_lonlat(x, y):
    n = 2 ** Z
    return (x / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n)))),
            (x + 1) / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n)))))

def lonlat_to_tile(lon, lat):
    n = 2 ** Z
    return int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)

def fetch(x, y, day):
    url = (f'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_Bands721/'
           f'default/{day}/GoogleMapsCompatible_Level9/{Z}/{x}/{y}.jpg')
    raw = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'IGNIS/1.0'}), timeout=30).read()
    return np.asarray(Image.open(io.BytesIO(raw)).convert('RGB'), dtype=np.float32) / 255

det = pd.read_csv('/home/z/my-project/scripts/hf_model/out/training_snapshot.csv',
                  usecols=['latitude', 'longitude', 'daynight', 'region'])
det = det[det.daynight == 'D']  # daytime only — visible in Terra ~10:30 imagery

EVENTS = [
    ('amazon', -62, -11, -48, 1, ['2026-09-18', '2026-09-19', '2026-09-20'], 'snapshot'),
    ('congo', 12, -7, 30, 6, ['2026-09-19', '2026-09-20'], 'snapshot'),
    ('borneo', 97, -5, 118, 5, ['2026-09-19', '2026-09-20'], 'snapshot'),
    ('congo23', 12, -7, 30, 6, ['2023-07-10', '2023-07-15'], 'gibsfires'),
    ('amazon24', -62, -11, -48, 1, ['2024-08-20', '2024-08-24'], 'gibsfires'),
    ('australia20', 142, -40, 155, -28, ['2019-12-20', '2020-01-05'], 'gibsfires'),
    ('canada23', -125, 52, -95, 66, ['2023-06-25'], 'gibsfires'),
    ('siberia21', 100, 50, 145, 70, ['2021-08-10'], 'gibsfires'),
]
for name, w, s, e, n_, days, src in EVENTS:
    x0, y1 = lonlat_to_tile(w, n_); x1, y2 = lonlat_to_tile(e, s)
    tiles = [(x, y) for x in range(x0, x1 + 1) for y in range(y1, y2 + 1)]
    if src == 'gibsfires':
        # fetch detections once per date
        pts_by_day = {}
        for d in days:
            try:
                gj = json.loads(urllib.request.urlopen(
                    f'{PROD}/api/gibsfires?w={w}&s={s}&e={e}&n={n_}&day={d}', timeout=60).read())
                pts_by_day[d] = [(f['properties'].get('latitude') or f['geometry']['coordinates'][1],
                                  f['properties'].get('longitude') or f['geometry']['coordinates'][0])
                                 for f in gj.get('features', [])]
            except Exception as ex:
                pts_by_day[d] = []
                print(f'  {name} {d}: gibsfires fail {str(ex)[:60]}')
    best = []
    for x, y in tiles:
        tl1, la1, tl2, la2 = tile_lonlat(x, y)
        for d in days:
            if src == 'snapshot':
                m = det[(det.region == name) & (det.longitude >= tl1) & (det.longitude < tl2) &
                        (det.latitude >= la1) & (det.latitude < la2)]
                pts = list(zip(m.latitude, m.longitude))
            else:
                pts = [(la, lo) for la, lo in pts_by_day.get(d, []) if tl1 <= lo < tl2 and la1 <= la < la2]
            if len(pts) < 30:
                continue
            try:
                img = fetch(x, y, d)
            except Exception:
                continue
            fire = np.zeros((256, 256), bool)
            for la, lo in pts:
                px = int((lo - tl1) / (tl2 - tl1) * 256); py = int((la2 - la) / (la2 - la1) * 256)
                if 0 <= px < 256 and 0 <= py < 256:
                    fire[py, px] = True
            fd = ndi.binary_dilation(fire, iterations=1)
            R = img[..., 0]
            vis = float(R[fd].mean() - R.mean())      # SWIR contrast at fire vs scene
            cloud = float(((img[..., 1] > 0.7) & (R < 0.35)).mean())
            best.append((round(vis, 3), x, y, d, int(fire.sum()), round(cloud, 2)))
    best.sort(reverse=True)
    print(f'\n== {name} ==')
    for b in best[:5]:
        print('   vis', b)
