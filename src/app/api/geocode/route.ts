import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

type NomResult = { display_name: string; lat: string; lon: string; boundingbox?: string[]; type?: string; importance?: number };

const cache = new Map<string, { at: number; data: unknown }>();

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim().slice(0, 120);
  if (q.length < 2) return NextResponse.json({ results: [] });
  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < 3600_000) return NextResponse.json(hit.data);
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=0&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'IGNIS-SpaceApps2026/1.0 (NASA Space Apps challenge fire calendar)', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return NextResponse.json({ results: [] });
    const arr = (await res.json()) as NomResult[];
    const results = arr.map((r) => ({
      name: r.display_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
      bbox: r.boundingbox && r.boundingbox.length === 4
        ? [Number(r.boundingbox[2]), Number(r.boundingbox[0]), Number(r.boundingbox[3]), Number(r.boundingbox[1])]
        : null,
      kind: r.type || 'place',
    }));
    const data = { results };
    cache.set(q, { at: Date.now(), data });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ results: [] });
  }
}
