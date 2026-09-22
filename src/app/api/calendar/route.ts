import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const region = (searchParams.get('region') || 'amazon').replace(/[^a-z]/g, '');
  const file = path.join(process.cwd(), 'data', 'ignis', `calendar_${region}.json`);
  if (!fs.existsSync(file)) {
    return NextResponse.json({ status: 'building', message: 'Calendar precompute still running — try again shortly.' }, { status: 202 });
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  return NextResponse.json(json);
}
