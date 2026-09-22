import { NextResponse } from 'next/server';
import { KEYS, KEY_SOURCES } from '@/lib/ignis/keys';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function edlStatus() {
  if (!KEYS.EDL_TOKEN) return { configured: false, reason: 'EDL_TOKEN not set' };
  try {
    const payload = JSON.parse(Buffer.from(KEYS.EDL_TOKEN.split('.')[1], 'base64url').toString());
    const msLeft = payload.exp * 1000 - Date.now();
    return {
      configured: true,
      uid: payload.uid,
      exp: payload.exp,
      expired: msLeft < 0,
      daysLeft: Math.max(0, Math.round(msLeft / 86400000)),
    };
  } catch {
    return { configured: false, reason: 'malformed JWT' };
  }
}

async function checkEdl() {
  try {
    // Authenticated CMR query — the authoritative consumer of EDL bearer tokens.
    const res = await timed('https://cmr.earthdata.nasa.gov/search/collections?has_granules=true&page_size=1', 8000, {
      headers: { Authorization: `Bearer ${KEYS.EDL_TOKEN}` },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} (token rejected)` };
    return { ok: true, endpoint: 'cmr.earthdata.nasa.gov/search (Bearer auth)' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

async function timed(url: string, ms: number, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

async function checkFirms() {
  try {
    const res = await timed(`https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${KEYS.FIRMS_MAP_KEY}`, 6000);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const j = (await res.json()) as Record<string, unknown>;
    return { ok: true, ...j };
  } catch {
    return { ok: false, reason: 'unreachable from this host (works on standard networks / production)' };
  }
}

async function checkNasaKey() {
  try {
    const res = await timed(`https://api.nasa.gov/planetary/apod?api_key=${KEYS.NASA_API_KEY}&thumbs=true`, 8000);
    return { ok: res.ok, limit: res.headers.get('X-RateLimit-Limit'), remaining: res.headers.get('X-RateLimit-Remaining') };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

async function checkGibs() {
  try {
    const res = await timed('https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_Thermal_Anomalies_All/default/2024-08-08/1km/5/9/11.mvt', 8000);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

async function checkHf() {
  try {
    const res = await timed('https://huggingface.co/api/whoami-v2', 8000, { headers: { Authorization: `Bearer ${KEYS.HF_TOKEN}` } });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const j = (await res.json()) as { name?: string };
    return { ok: true, user: j.name, inference: 'router.huggingface.co (Llama-3.1-8B-Instruct / Qwen3-8B / MiniLM)' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

async function checkOpenMeteo() {
  try {
    const res = await timed('https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&daily=temperature_2m_max&forecast_days=1', 8000);
    const j = (await res.json()) as { error?: boolean; reason?: string };
    if (j.error) return { ok: false, reason: j.reason || 'quota' };
    return { ok: res.ok };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

export async function GET() {
  const [firms, nasa, gibs, hf, openmeteo, edlCheck] = await Promise.all([
    checkFirms(), checkNasaKey(), checkGibs(), checkHf(), checkOpenMeteo(), checkEdl(),
  ]);
  const eonet = await fetch('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=1')
    .then((r) => ({ ok: r.ok }))
    .catch(() => ({ ok: false, reason: 'unreachable' }));
  return NextResponse.json({
    firms: { service: 'FIRMS area API (5-sensor hotspots)', keySource: KEY_SOURCES.FIRMS_MAP_KEY, ...firms },
    nasa: { service: 'api.nasa.gov', keySource: KEY_SOURCES.NASA_API_KEY, ...nasa },
    gibs: { service: 'GIBS WMTS (raster + vector)', ...gibs },
    eonet: { service: 'EONET v3', ...eonet },
    hf: { service: 'Hugging Face (MiniLM triage · Llama analyst)', keySource: KEY_SOURCES.HF_TOKEN, ...hf },
    openmeteo: { service: 'Open-Meteo fire weather (client-side)', ...openmeteo },
    edl: { service: 'Earthdata Login (CMR bearer · LP DAAC/ASF entitlements)', keySource: KEY_SOURCES.EDL_TOKEN, ...edlCheck, ...edlStatus() },
    checkedAt: new Date().toISOString(),
  });
}
