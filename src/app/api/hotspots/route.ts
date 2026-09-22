import { NextResponse } from 'next/server';
import { getHotspotsRange } from '@/lib/ignis/firms';
import { classifyDetections, CLASSIFIER_META } from '@/lib/ignis/inference';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const w = Number(searchParams.get('w')), s = Number(searchParams.get('s'));
  const e = Number(searchParams.get('e')), n = Number(searchParams.get('n'));
  const day = searchParams.get('day') || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const days = Math.min(10, Math.max(1, Number(searchParams.get('days') || 1)));
  if (![w, s, e, n].every(Number.isFinite) || e <= w || n <= s) {
    return NextResponse.json({ error: 'invalid bbox' }, { status: 400 });
  }
  try {
    const list: string[] = [];
    const end = new Date(day + 'T00:00:00Z').getTime();
    for (let i = days - 1; i >= 0; i--) list.push(new Date(end - i * 86400000).toISOString().slice(0, 10));
    const multi = await getHotspotsRange([w, s, e, n], list);
    // Live ML inference: per-detection fire-behavior class (ignis-fire-classifier,
    // LogReg portable twin). Features are per (AOI, day) across all sensors —
    // mirrors the training grouping. Mutates points in-place with beh/behP.
    let classified = 0;
    const t0 = Date.now();
    for (const res of Object.values(multi.days)) {
      const merged = Object.values(res.sensors).flatMap((sn) => sn.points);
      if (merged.length) {
        classifyDetections(merged);
        classified += merged.length;
      }
    }
    return NextResponse.json(
      { ...multi, ml: { model: CLASSIFIER_META.name, version: CLASSIFIER_META.version, classified, ms: Date.now() - t0 } },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
