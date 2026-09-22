import { NextResponse } from 'next/server';
import { getGibsFiresGeoJSON } from '@/lib/ignis/firms';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GIBS fire-pixel cross-check layer: GIBS WMTS vector tiles parsed server-side -> GeoJSON.
// Cached in-memory 15 min (same day+bbox repeats are free).
const cache = new Map<string, { at: number; data: unknown }>();
const TTL = 15 * 60 * 1000;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const w = Number(searchParams.get('w')), s = Number(searchParams.get('s'));
  const e = Number(searchParams.get('e')), n = Number(searchParams.get('n'));
  const day = searchParams.get('day') || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (![w, s, e, n].every(Number.isFinite) || e <= w || n <= s) {
    return NextResponse.json({ error: 'invalid bbox' }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ error: 'invalid day' }, { status: 400 });
  }
  const key = `${w},${s},${e},${n}|${day}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) {
    return NextResponse.json(hit.data, { headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=1800' } });
  }
  try {
    const fc = await getGibsFiresGeoJSON([w, s, e, n], day);
    cache.set(key, { at: Date.now(), data: fc });
    if (cache.size > 120) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    return NextResponse.json(fc, { headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=1800' } });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
