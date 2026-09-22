#!/usr/bin/env python3
"""Debug the in-app forecaster: replicate forecast.ts exactly on live API data,
inspect feature ranges vs training scaler, find the saturation driver."""
import json, urllib.request
import numpy as np

def fetch(url):
    return json.load(urllib.request.urlopen(url, timeout=120))

multi = fetch('http://localhost:3000/api/hotspots?w=-74&s=-12&e=-46&n=2&day=2026-09-20&days=7')
W = json.load(open('/home/z/my-project/src/lib/ignis/forecasterWeights.json'))
dayKeys = sorted(multi['days'].keys())
print('days:', dayKeys, '| source:', multi['source'])
lastDay = dayKeys[-1]
w0, s0, e0, n0 = -74, -12, -46, 2
CELL = 0.05
gw = min(640, int(np.ceil((e0 - w0) / CELL)) + 1)
gh = min(640, int(np.ceil((n0 - s0) / CELL)) + 1)
print('grid:', gw, gh)

def hist(pts, weighted=False):
    h = np.zeros((gh, gw))
    for p in pts:
        i = int((p['lon'] - w0) / CELL); j = int((p['lat'] - s0) / CELL)
        if 0 <= i < gw and 0 <= j < gh:
            h[j, i] += p['frp'] if weighted else 1
    return h

def gauss(h, sigma):
    # edge-clamp separable (mirror of forecast.ts)
    from scipy.ndimage import gaussian_filter
    return gaussian_filter(h, sigma=sigma, mode='nearest')

per_day = {d: [dict(lat=q['lat'], lon=q['lon'], frp=q['frp']) for sn in multi['days'][d]['sensors'].values() for q in sn['points']] for d in dayKeys}
for d in dayKeys:
    print(d, len(per_day[d]), 'pts')
prior = list(per_day[dayKeys[-1]])
for d in dayKeys[:-1]: prior += per_day[d]
print('prior total:', len(prior))

sig = [0.10 / CELL, 0.35 / CELL, 0.80 / CELL]
kde = [gauss(hist(prior).astype(float), s) for s in sig]
frpK = gauss(hist(prior, True).astype(float), 0.35 / CELL)
lastK = gauss(hist(per_day[lastDay]).astype(float), 0.35 / CELL)
prevDay = dayKeys[-2] if len(dayKeys) >= 2 else lastDay
prevK = gauss(hist(per_day[prevDay]).astype(float), 0.35 / CELL)

import datetime
doy = (datetime.date(2026, 9, 21) - datetime.date(2026, 1, 1)).days + 1
doyS, doyC = np.sin(2 * np.pi * doy / 365), np.cos(2 * np.pi * doy / 365)

F = np.stack([
    np.log1p(kde[0]), np.log1p(kde[1]), np.log1p(kde[2]),
    np.log1p(frpK), np.log1p(lastK), np.log1p(prevK),
    (np.arange(gw)[None, :] + 0.5) * CELL / (e0 - w0) * np.ones((gh, gw)),
    ((np.arange(gh)[:, None] + 0.5) * CELL / (n0 - s0)) * np.ones((gh, gw)),
    np.full((gh, gw), doyS), np.full((gh, gw), doyC),
], -1).reshape(-1, 10)

mean = np.array(W['scaler_mean']); scale = np.array(W['scaler_scale'])
Xs = (F - mean) / scale
z = Xs @ np.array(W['coef']) + W['intercept']
p = 1 / (1 + np.exp(-z))
print('\nfeature means (in-app):', dict(zip(W['features'], np.round(F.mean(0), 3))))
print('feature means (train): ', dict(zip(W['features'], np.round(mean, 3))))
print('frac p>=0.5:', (p >= 0.5).mean().round(3), '| predicted cells:', int((p >= 0.5).sum()))
# contribution breakdown at a random mid cell
idx = int(np.argmax(p))
print('\nworst cell contributions:')
for i, f in enumerate(W['features']):
    print(f'  {f:22} x={F.reshape(-1,10)[idx, i]:8.3f} z={(F.reshape(-1,10)[idx, i]-mean[i])/scale[i]:8.2f} contrib={(F.reshape(-1,10)[idx, i]-mean[i])/scale[i]*W["coef"][i]:8.2f}')
print('intercept', W['intercept'], '-> p', p[idx])
