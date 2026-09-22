import { NextResponse } from 'next/server';
import { embed, cosine, REGION_PROFILES } from '@/lib/ignis/ai';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type EonetEvent = { id: string; title: string; date: string; lon: number | null; lat: number | null; link: string; sources: string[] };

const EONET = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=wildfires&limit=60';

function distDeg(aLat: number, aLon: number, bLat: number, bLon: number) {
  return Math.hypot(aLat - bLat, aLon - bLon);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const region = searchParams.get('region') || 'amazon';
  try {
    const res = await fetch(EONET, { next: { revalidate: 300 } });
    const json = await res.json();
    type Geom = { type: string; coordinates: number[] | number[][]; date?: string };
    const events: EonetEvent[] = (json.events || []).map((ev: Record<string, unknown>) => {
      const geom = (ev.geometry as Geom[]) || [];
      const last = geom[geom.length - 1];
      let lon: number | null = null;
      let lat: number | null = null;
      if (last && Array.isArray(last.coordinates)) {
        const c = last.coordinates;
        if (typeof c[0] === 'number') { lon = c[0]; lat = c[1] as number; }
        else if (Array.isArray(c[0])) { const p = c[0] as number[]; lon = p[0]; lat = p[1]; }
      }
      return {
        id: String(ev.id), title: String(ev.title),
        date: last?.date ?? '',
        lon, lat,
        link: (ev.link as string) || '', sources: ((ev.sources as Array<{ id: string }>) || []).map((s) => s.id),
      };
    });

    // rank: geo score always; semantic score via HF MiniLM when available
    const profile = REGION_PROFILES[region] || '';
    const [regCenter] = regionProfileBBox(region);
    let semantic: number[] | null = null;
    try {
      const [emb] = await embed([profile]);
      semantic = emb;
    } catch { semantic = null; }

    const texts = events.map((ev) => ev.title + ' ' + (ev.sources.join(' ') || 'wildfire'));
    let evEmb: number[][] = [];
    if (semantic) { try { evEmb = await embed(texts); } catch { evEmb = []; } }

    const ranked = events.map((ev, i) => {
      let geo = 0.25;
      if (ev.lat !== null && ev.lon !== null) geo = Math.max(0, 1 - distDeg(ev.lat, ev.lon, regCenter[0], regCenter[1]) / 60);
      const sem = semantic && evEmb[i] ? Math.max(0, cosine(semantic, evEmb[i])) : null;
      const score = sem !== null ? +(0.55 * sem + 0.45 * geo).toFixed(4) : +geo.toFixed(4);
      return { ...ev, geoScore: +geo.toFixed(3), semanticScore: sem !== null ? +sem.toFixed(3) : null, relevance: score };
    }).sort((a, b) => b.relevance - a.relevance);

    return NextResponse.json({ count: ranked.length, ranked: ranked.slice(0, 20), model: semantic ? 'Xenova/all-MiniLM-L6-v2 (Hugging Face, on-device)' : 'geo-only fallback' });
  } catch (err) {
    return NextResponse.json({ error: String(err), ranked: [] }, { status: 200 });
  }
}

function regionProfileBBox(region: string): [[number, number], [number, number, number, number]] {
  const bboxes: Record<string, [number, number, number, number]> = {
    amazon: [-74, -12, -46, 2], california: [-125, 32, -114, 42], canada: [-140, 52, -95, 70],
    siberia: [100, 50, 145, 70], congo: [8, -8, 32, 8], borneo: [95, -6, 120, 6],
    australia: [112, -42, 154, -10], mediterranean: [-8, 30, 32, 46],
  };
  const b = bboxes[region] || bboxes.amazon;
  return [[(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], b];
}
