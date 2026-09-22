/**
 * IGNIS Event Detector — in-app scoring (portable logistic weights).
 *
 * Mirrors scripts/models/train_event_detector.py: predicts whether NEXT month
 * will be an extreme fire month for the region (z >= 2 vs the 2000-2021
 * climatological month, harmonized MODIS+VIIRS unified detections).
 * Deterministic, client-side, zero network cost — weights trained on the
 * 25-year IGNIS calendar record (see Nabidnur/ignis-event-detector on HF).
 */
import type { CalendarDoc } from '@/lib/ignis/types';
import weights from './eventWeights.json';

const REGIONS = ['amazon', 'california', 'canada', 'siberia', 'congo', 'borneo', 'australia', 'mediterranean', 'bangladesh'];

type Unified = { ym: string; est: number; frp: number; hiConf: number; night: number };

function unify(doc: CalendarDoc): Unified[] {
  const byYm = new Map<string, Unified>();
  for (const sensor of Object.values(doc.sensors ?? {})) {
    for (const m of sensor?.monthly ?? []) {
      const rec = byYm.get(m.ym) ?? { ym: m.ym, est: 0, frp: 0, hiConf: 0, night: 0 };
      rec.est += m.est ?? 0;
      rec.frp += m.frp ?? 0;
      rec.hiConf += m.hiConf ?? 0;
      rec.night += m.night ?? 0;
      byYm.set(m.ym, rec);
    }
  }
  return [...byYm.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export type EventScore = {
  /** P(extreme fire month) for the month AFTER the last observed month */
  p: number;
  /** the month being predicted, e.g. '2026-10' */
  targetYm: string;
  band: 'low' | 'elevated' | 'high';
  label: string;
  modelVersion: string;
};

export function scoreNextMonth(doc: CalendarDoc): EventScore | null {
  try {
    const rows = unify(doc);
    if (rows.length < 15) return null;
    const region = doc.region && REGIONS.includes(doc.region) ? doc.region : 'amazon';
    // climatology on TRAIN years only (<= 2021), per calendar month — matches training
    const clim = new Map<number, { mean: number; std: number }>();
    for (let mo = 1; mo <= 12; mo++) {
      const vals = rows
        .filter((r) => Number(r.ym.slice(5, 7)) === mo && Number(r.ym.slice(0, 4)) <= 2021)
        .map((r) => r.est);
      const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      const variance = vals.length > 1 ? vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1) : mean * mean * 0.36;
      clim.set(mo, { mean, std: Math.max(1, Math.sqrt(variance)) });
    }
    const last = rows[rows.length - 1];
    const lastMo = Number(last.ym.slice(5, 7));
    const nextMo = lastMo === 12 ? 1 : lastMo + 1;
    const nextYear = lastMo === 12 ? Number(last.ym.slice(0, 4)) + 1 : Number(last.ym.slice(0, 4));
    const targetYm = `${nextYear}-${String(nextMo).padStart(2, '0')}`;
    const lag3 = rows.slice(-3);
    const sameMonthLastYear = rows.find((r) => r.ym === `${Number(last.ym.slice(0, 4)) - 1}-${last.ym.slice(5, 7)}`);
    const x: number[] = [
      Math.log1p(last.est),
      Math.log1p(lag3.reduce((a, b) => a + b.est, 0) / Math.max(1, lag3.length)),
      Math.log1p(sameMonthLastYear?.est ?? last.est),
      Math.log1p(last.frp),
      last.hiConf / Math.max(1, last.est),
      last.night / Math.max(1, last.est),
      Math.sin((2 * Math.PI * nextMo) / 12),
      Math.cos((2 * Math.PI * nextMo) / 12),
      ...REGIONS.slice(1).map((r) => (r === region ? 1 : 0)),
    ];
    const w = weights as unknown as {
      coef: number[]; intercept: number; scaler_mean: number[]; scaler_scale: number[]; version: string;
    };
    let z = w.intercept;
    for (let i = 0; i < x.length; i++) {
      const s = w.scaler_scale[i] || 1;
      z += w.coef[i] * ((x[i] - w.scaler_mean[i]) / s);
    }
    const p = sigmoid(z);
    const band: EventScore['band'] = p >= 0.5 ? 'high' : p >= 0.25 ? 'elevated' : 'low';
    const label =
      band === 'high' ? 'Extreme fire month likely' : band === 'elevated' ? 'Elevated fire-month risk' : 'Normal fire month expected';
    return { p: +p.toFixed(3), targetYm, band, label, modelVersion: `v${w.version}` };
  } catch {
    return null;
  }
}
