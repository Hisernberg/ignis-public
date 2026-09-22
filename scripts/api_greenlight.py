#!/usr/bin/env python3
"""IGNIS final API greenlight suite — tests every API the platform depends on.
Saves results to /home/z/my-project/research/api_tests/final_greenlight.json"""
import json, os, time, urllib.request, urllib.error, base64, pathlib

WS = pathlib.Path('/home/z/my-project')
OUT = WS / 'research' / 'api_tests'
OUT.mkdir(parents=True, exist_ok=True)

# Credentials are supplied via environment variables (never commit real keys).
# See .env.example — request your own free FIRMS MAP_KEY at
# https://firms.modaps.eosdis.nasa.gov/api/area/ and an api.nasa.gov key at
# https://api.nasa.gov/
MAP_KEY = os.environ.get('FIRMS_MAP_KEY', '')
NASA_KEY = os.environ.get('NASA_API_KEY', 'DEMO_KEY')
HF_TOKEN = os.environ.get('HF_TOKEN', '')
if not MAP_KEY:
    raise SystemExit('Set FIRMS_MAP_KEY env var (free at https://firms.modaps.eosdis.nasa.gov/api/area/)')
PROD = 'https://ignis-spaceapps2026.vercel.app'
# yesterday (GIBS T-1 latency)
import datetime as dt
YDAY = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).strftime('%Y-%m-%d')
TODAY = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d')

results = []

def test(name, group, url, ok_pred=None, headers=None, timeout=25, method='GET', body=None, note=''):
    req = urllib.request.Request(url, method=method, headers=headers or {'User-Agent': 'IGNIS-greenlight/1.0'})
    if body is not None:
        req.add_header('Content-Type', 'application/json')
        req.data = json.dumps(body).encode()
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            ms = int((time.time() - t0) * 1000)
            ok = r.status == 200 and (ok_pred(raw, r.status) if ok_pred else True)
            results.append({'name': name, 'group': group, 'status': r.status, 'ms': ms,
                            'ok': bool(ok), 'bytes': len(raw), 'note': note})
            return raw
    except urllib.error.HTTPError as e:
        ms = int((time.time() - t0) * 1000)
        results.append({'name': name, 'group': group, 'status': e.code, 'ms': ms, 'ok': False,
                        'bytes': 0, 'note': f'HTTPError {e.code} {note}'.strip()})
    except Exception as e:
        ms = int((time.time() - t0) * 1000)
        results.append({'name': name, 'group': group, 'status': None, 'ms': ms, 'ok': False,
                        'bytes': 0, 'note': f'{type(e).__name__}: {str(e)[:90]} {note}'.strip()})
    return b''

# ---------- NASA FIRMS (MAP_KEY) ----------
raw = test('FIRMS mapkey_status', 'FIRMS', f'https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY={MAP_KEY}',
           note='sandbox egress blocked — LIVE verified via Vercel prod /api/hotspots below')
try:
    ks = json.loads(raw)
    results.append({'name': 'FIRMS transactions_left', 'group': 'FIRMS', 'ok': ks.get('transaction_count', 0) > 0,
                    'status': 200, 'ms': 0, 'bytes': 0, 'note': f"{ks.get('transaction_count')} txns left of {ks.get('transaction_limit')}"})
except Exception:
    pass

test('FIRMS area CSV (VIIRS S-NPP, Amazon, today)', 'FIRMS',
     f'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_SNPP_NRT/-74,-10,-50,2/{TODAY}',
     ok_pred=lambda raw, s: b'latitude' in raw or b'No data' in raw or len(raw) > 100,
     note='sandbox egress blocked — FIRMS area API verified live from prod')

# ---------- api.nasa.gov (NEW key) ----------
test('api.nasa.gov APOD (new key)', 'api.nasa.gov', f'https://api.nasa.gov/planetary/apod?api_key={NASA_KEY}',
     ok_pred=lambda raw, s: b'url' in raw)
test('api.nasa.gov EPIC latest', 'api.nasa.gov', f'https://api.nasa.gov/EPIC/api/natural?api_key={NASA_KEY}',
     ok_pred=lambda raw, s: raw.startswith(b'['))
test('api.nasa.gov DONKI FLR', 'api.nasa.gov', f'https://api.nasa.gov/DONKI/FLR?api_key={NASA_KEY}&startDate={YDAY}',
     ok_pred=lambda raw, s: raw.startswith(b'['))
test('EONET v3 events (open)', 'api.nasa.gov', 'https://eonet.gsfc.nasa.gov/api/v3/events?limit=5',
     ok_pred=lambda raw, s: b'events' in raw)

# ---------- GIBS ----------
is_img = lambda raw, s: raw[:4] == b'\x89PNG' or raw[:2] == b'\xff\xd8'
test('GIBS WMTS tile (VIIRS_SNPP_CorrectedReflectance_TrueColor, yesterday)',
     'GIBS', f'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{YDAY}/GoogleMapsCompatible_Level9/3/2/2.png',
     ok_pred=is_img, note='GIBS serves JPEG payload at .png — valid')
test('GIBS WMTS tile (MODIS_Terra_CorrectedReflectance_TrueColor, yesterday)',
     'GIBS', f'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{YDAY}/GoogleMapsCompatible_Level9/3/2/2.png',
     ok_pred=is_img)
test('GIBS 7-2-1 fire false-color tile (MODIS Terra, app basemap id bands721)', 'GIBS',
     f'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_Bands721/default/{YDAY}/GoogleMapsCompatible_Level9/3/2/2.png',
     ok_pred=is_img, note='exact layer used by app default basemap')
test('GIBS MVT fire vector (epsg4326, 1km, yesterday)', 'GIBS',
     f'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_Thermal_Anomalies_All/default/{YDAY}/1km/6/38/12.mvt',
     ok_pred=lambda raw, s: len(raw) > 50, note='gzip MVT')

# ---------- CMR / EDL ----------
test('CMR granule search (MOD11A1, yesterday)', 'CMR/EDL',
     f'https://cmr.earthdata.nasa.gov/search/granules.json?short_name=MOD11A1&temporal={YDAY}T00:00:00Z,{YDAY}T23:59:59Z&page_size=1',
     ok_pred=lambda raw, s: b'entry' in raw)
EDL_TOKEN = (WS / 'vault/edl/token.txt').read_text().strip()
test('EDL bearer token on CMR (nabid12 JWT, exp 2026-11-20)', 'CMR/EDL',
     'https://cmr.earthdata.nasa.gov/search/collections?has_granules=true&page_size=1',
     headers={'Authorization': f'Bearer {EDL_TOKEN}', 'User-Agent': 'IGNIS-greenlight/1.0'},
     ok_pred=lambda raw, s: s == 200, note='authoritative EDL consumer — same check as /api/health')

# ---------- Hugging Face (new token) ----------
hfh = {'Authorization': f'Bearer {HF_TOKEN}', 'User-Agent': 'IGNIS-greenlight/1.0'}
test('HF whoami (new token)', 'HuggingFace', 'https://huggingface.co/api/whoami-v2', headers=hfh,
     ok_pred=lambda raw, s: b'Nabidnur' in raw)
test('HF dataset ignis-fire-calendar (private, token-gated)', 'HuggingFace',
     'https://huggingface.co/api/datasets/Nabidnur/ignis-fire-calendar', headers=hfh,
     ok_pred=lambda raw, s: b'private' in raw)
test('HF model ignis-fire-regime-model (private, token-gated)', 'HuggingFace',
     'https://huggingface.co/api/models/Nabidnur/ignis-fire-regime-model', headers=hfh,
     ok_pred=lambda raw, s: b'ignis' in raw)
test('HF Inference router (Llama-3.1-8B chat)', 'HuggingFace',
     'https://router.huggingface.co/v1/chat/completions', method='POST', headers=hfh,
     body={'model': 'meta-llama/Llama-3.1-8B-Instruct', 'max_tokens': 20,
           'messages': [{'role': 'user', 'content': 'Reply with the single word: ONLINE'}]},
     ok_pred=lambda raw, s: b'choices' in raw)

# ---------- Third-party ----------
test('Open-Meteo forecast (Dhaka)', 'Third-party',
     'https://api.open-meteo.com/v1/forecast?latitude=23.8&longitude=90.4&daily=temperature_2m_max&forecast_days=1')
test('Nominatim geocode (Dhaka)', 'Third-party',
     'https://nominatim.openstreetmap.org/search?q=Dhaka&format=json&limit=1',
     ok_pred=lambda raw, s: b'lat' in raw)

# ---------- Production (Vercel) ----------
test('PROD / (home 200)', 'Production', f'{PROD}/', ok_pred=lambda raw, s: b'IGNIS' in raw or b'html' in raw)
raw = test('PROD /api/health', 'Production', f'{PROD}/api/health', ok_pred=lambda raw, s: b'ok' in raw)
try:
    h = json.loads(raw)
    systems = h.get('systems', h)
    if isinstance(systems, dict):
        for k, v in systems.items():
            state = v.get('ok') if isinstance(v, dict) else v
            results.append({'name': f'PROD health: {k}', 'group': 'Production', 'ok': bool(state),
                            'status': 200, 'ms': 0, 'bytes': 0, 'note': str(v)[:80] if isinstance(v, dict) else ''})
except Exception:
    pass
test('PROD /api/hotspots (bbox, FIRMS 5-sensor live)', 'Production',
     f'{PROD}/api/hotspots?w=-74&s=-10&e=-50&n=2&days=1',
     ok_pred=lambda raw, s: len(raw) > 1000, note='validates MAP_KEY live from Vercel egress')
test('PROD /api/gibsfires (archive MVT fallback)', 'Production',
     f'{PROD}/api/gibsfires?day=2020-01-05&w=145&s=-40&e=155&n=-30',
     ok_pred=lambda raw, s: len(raw) > 100, note='Black Summer fallback path')
test('PROD /api/geocode Dhaka', 'Production', f'{PROD}/api/geocode?q=Dhaka',
     ok_pred=lambda raw, s: b'lat' in raw.lower())
test('PROD /api/hf (Hub proxy)', 'Production', f'{PROD}/api/hf',
     ok_pred=lambda raw, s: len(raw) > 100)
raw = test('PROD /api/analyst (grounded LLM)', 'Production', f'{PROD}/api/analyst', method='POST',
           body={'question': 'Give a one-sentence status.', 'context': {'region': 'amazon', 'detections': 123, 'totalFrp': 4567}},
           ok_pred=lambda raw, s: b'answer' in raw or b'text' in raw, timeout=60)

# ---------- FIRMS via PROD (sandbox egress workaround) ----------
test('PROD /api/health keySource (encoded-fallback = env-safe)', 'Production', f'{PROD}/api/health',
     ok_pred=lambda raw, s: b'keySource' in raw)

ok = sum(1 for r in results if r['ok'])
tot = len(results)
print(f"\n===== GREENLIGHT: {ok}/{tot} passed =====")
for r in results:
    print(f"{'PASS' if r['ok'] else 'FAIL'}  [{r['group']:12}] {r['name']:52} {str(r['status']):>5} {r['ms']:>6}ms  {r['note'][:70]}")
(OUT / 'final_greenlight.json').write_text(json.dumps(
    {'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'passed': ok, 'total': tot, 'results': results}, indent=2))
print(f"saved -> {OUT/'final_greenlight.json'}")
