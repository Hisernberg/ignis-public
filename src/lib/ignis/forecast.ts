/**
 * IGNIS Footprint Forecaster — in-app next-day fire-footprint prediction
 * (portable twin of Nabidnur/ignis-fire-footprint-forecaster, LogReg weights).
 *
 * Mirrors scripts/models/train_footprint_forecaster.py + train_forecaster_portable.py (v2):
 * predicts TOMORROW's fire-complex footprint as a per-cell probability field on a
 * 0.05-deg grid (~5.5 km) from PRIOR-days detection-density features — a forward-
 * looking segmentation companion to the same-day DBSCAN hulls in Fire Cluster Lab.
 * v2 contract: every KDE is scene-max normalized before log1p, so the model
 * transfers across day-window lengths and detection source densities.
 *
 * Production wiring notes (documented, honest):
 *  - feature 5 'kde_targetday_priorhr' was a same-day-early proxy at training time;
 *    here it is substituted with the last fully-available day's KDE (the training
 *    metrics.json caveat covers exactly this).
 *  - lon_n/lat_n are normalized to the CURRENT AOI (domain adaptation); outside the
 *    three training domains (Amazon/Congo/Borneo) the forecast is labelled
 *    extrapolated in the UI.
 *  - densities are gaussian-filtered detection histograms, sigma in cells =
 *    bandwidth/cellDeg, separable convolution with edge clamp (mirrors
 *    scipy.ndimage.gaussian_filter mode='nearest' closely enough for sparse fields).
 */
import forecasterW from './forecasterWeights.json';
import type { MultiHotspots } from './types';

const W = forecasterW as unknown as {
  features: string[];
  cell: number;
  train_regions: Record<string, [number, number, number, number]>;
  scaler_mean: number[];
  scaler_scale: number[];
  coef: number[];
  intercept: number;
  version: string;
  featureContract?: string;
  skill: { logreg: Record<string, { iou: number; precision: number; recall: number; persistence_baseline_iou: number }>; hgb_reference: Record<string, { iou: number }> };
  caveat?: string;
};

const TRAIN_DOMAINS = Object.keys(W.train_regions);
const MAX_CELLS = 8000; // cap returned cells (top by probability)

export type ForecastField = {
  targetDay: string;
  cellDeg: number;
  cells: { lon: number; lat: number; p: number }[]; // predicted footprint (p >= 0.5), capped
  stats: {
    gridW: number; gridH: number; cellsEvaluated: number;
    predicted: number; predictedAreaKm2: number;
    meanP: number; maxP: number;
    actualCells: number; overlap: number; consistencyIou: number;
    hiConfCells: number; topAlignedPct: number; // of the 2,000 highest-risk cells, % that are active today
  };
  domain: 'in-sample' | 'extrapolated';
  regionKey: string;
  modelVersion: string;
};

function doyOf(day: string): number {
  const d = new Date(day + 'T00:00:00Z');
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86400000) + 1;
}

function separableGaussian(grid: Float32Array, gw: number, gh: number, sigmaCells: number, tmp: Float32Array): void {
  const r = Math.max(1, Math.round(4 * sigmaCells));
  const size = 2 * r + 1;
  const kern = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - r;
    kern[i] = Math.exp(-(x * x) / (2 * sigmaCells * sigmaCells));
    sum += kern[i];
  }
  for (let i = 0; i < size; i++) kern[i] /= sum;
  // horizontal pass with edge clamp
  for (let j = 0; j < gh; j++) {
    const row = j * gw;
    for (let i = 0; i < gw; i++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const ii = Math.min(gw - 1, Math.max(0, i + k));
        acc += grid[row + ii] * kern[k + r];
      }
      tmp[row + i] = acc;
    }
  }
  // vertical pass
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const jj = Math.min(gh - 1, Math.max(0, j + k));
        acc += tmp[jj * gw + i] * kern[k + r];
      }
      grid[j * gw + i] = acc;
    }
  }
  // scene-max normalization (feature contract v2 — source/day-window agnostic)
  let max = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
  if (max > 0) for (let i = 0; i < grid.length; i++) grid[i] /= max;
}

function histogram2d(
  pts: { lat: number; lon: number; frp: number }[], gw: number, gh: number,
  w: number, s: number, cell: number, weighted?: boolean,
): Float32Array {
  const h = new Float32Array(gw * gh);
  for (const p of pts) {
    const i = Math.floor((p.lon - w) / cell);
    const j = Math.floor((p.lat - s) / cell);
    if (i < 0 || i >= gw || j < 0 || j >= gh) continue;
    h[j * gw + i] += weighted ? (p.frp || 0) : 1;
  }
  return h;
}

/**
 * Predicts the footprint for the day AFTER the last available day, using all
 * available days as priors. Returns null when there is not enough data.
 */
export function forecastNextFootprint(
  multi: MultiHotspots, bbox: number[], regionKey: string,
): ForecastField | null {
  try {
    const dayKeys = Object.keys(multi.days).sort();
    if (dayKeys.length < 1) return null;
    const lastDay = dayKeys[dayKeys.length - 1];
    const target = new Date(new Date(lastDay + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);

    const [w0, s0, e0, n0] = bbox;
    const maxSpan = Math.max(e0 - w0, n0 - s0, 0.5);
    const cell = Math.max(W.cell, +(maxSpan / 560).toFixed(4));
    const gw = Math.min(640, Math.ceil((e0 - w0) / cell) + 1);
    const gh = Math.min(640, Math.ceil((n0 - s0) / cell) + 1);

    // gather detections per day (all sensors merged)
    const perDay = new Map<string, { lat: number; lon: number; frp: number }[]>();
    for (const d of dayKeys) {
      const res = multi.days[d];
      const merged = Object.values(res.sensors).flatMap((sn) => sn.points.map((p) => ({ lat: p.lat, lon: p.lon, frp: p.frp })));
      perDay.set(d, merged);
    }
    // prior days: up to 4 days before the target — mirrors the training protocol
    // (more prior days broaden the normalized density field and skew the model)
    const priorDays = dayKeys.slice(0, -1).slice(-4);
    const prior = perDay.get(lastDay) ?? [];
    for (const d of priorDays) prior.push(...(perDay.get(d) ?? []));
    if (prior.length < 30) return null;

    const tmp = new Float32Array(gw * gh);
    const sigmas = [0.10, 0.35, 0.80].map((bw) => bw / cell);
    const frpSigma = 0.35 / cell;

    // kde_0.10 / kde_0.35 / kde_0.80 over prior days
    const kde = sigmas.map((sg) => {
      const h = histogram2d(prior, gw, gh, w0, s0, cell);
      separableGaussian(h, gw, gh, sg, tmp);
      return h;
    });
    // frp-weighted kde (0.35 deg)
    const frpH = histogram2d(prior, gw, gh, w0, s0, cell, true);
    separableGaussian(frpH, gw, gh, frpSigma, tmp);
    // feat 5: last available day (production stand-in for same-day-early)
    const lastH = histogram2d(perDay.get(lastDay) ?? [], gw, gh, w0, s0, cell);
    separableGaussian(lastH, gw, gh, frpSigma, tmp);
    // feat 6: previous day (the day before lastDay, if any — else same as lastDay)
    const prevDay = dayKeys.length >= 2 ? dayKeys[dayKeys.length - 2] : lastDay;
    const prevH = histogram2d(perDay.get(prevDay) ?? [], gw, gh, w0, s0, cell);
    separableGaussian(prevH, gw, gh, frpSigma, tmp);

    const doy = doyOf(target);
    const doyS = Math.sin((2 * Math.PI * doy) / 365);
    const doyC = Math.cos((2 * Math.PI * doy) / 365);

    // actual cells (last day) for consistency stats
    const actual = new Uint8Array(gw * gh);
    for (const p of perDay.get(lastDay) ?? []) {
      const i = Math.floor((p.lon - w0) / cell);
      const j = Math.floor((p.lat - s0) / cell);
      if (i >= 0 && i < gw && j >= 0 && j < gh) actual[j * gw + i] = 1;
    }

    const cellsOut: { lon: number; lat: number; p: number }[] = [];
    let predicted = 0, meanP = 0, maxP = 0, overlap = 0, actualCells = 0;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const idx = j * gw + i;
        if (actual[idx]) actualCells++;
        const x = [
          Math.log1p(kde[0][idx]),
          Math.log1p(kde[1][idx]),
          Math.log1p(kde[2][idx]),
          Math.log1p(frpH[idx]),
          Math.log1p(lastH[idx]),
          Math.log1p(prevH[idx]),
          (w0 + (i + 0.5) * cell - w0) / (e0 - w0),
          (s0 + (j + 0.5) * cell - s0) / (n0 - s0),
          doyS, doyC,
        ];
        let z = W.intercept;
        for (let f = 0; f < 10; f++) z += W.coef[f] * ((x[f] - W.scaler_mean[f]) / (W.scaler_scale[f] || 1));
        const p = 1 / (1 + Math.exp(-z));
        if (p >= 0.5) {
          predicted++;
          meanP += p;
          if (p > maxP) maxP = p;
          if (actual[idx]) overlap++;
          cellsOut.push({ lon: +(w0 + (i + 0.5) * cell).toFixed(4), lat: +(s0 + (j + 0.5) * cell).toFixed(4), p: +p.toFixed(3) });
        }
      }
    }
    if (!predicted) return null;
    cellsOut.sort((a, b) => b.p - a.p);
    if (cellsOut.length > MAX_CELLS) cellsOut.length = MAX_CELLS;
    meanP /= predicted;
    const cellAreaKm2 = cell * 111.32 * (cell * 111.32 * Math.cos(((s0 + n0) / 2) * Math.PI / 180));
    const union = predicted + actualCells - overlap;
    // high-confidence subset + top-N alignment with currently active cells
    const hiConf = cellsOut.filter((c) => c.p >= 0.85);
    const top = cellsOut.slice(0, Math.min(2000, cellsOut.length));
    const topHit = actualSet(top);
    function actualSet(list: { lon: number; lat: number }[]): number {
      let n = 0;
      for (const c of list) {
        const i = Math.floor((c.lon - w0) / cell), j = Math.floor((c.lat - s0) / cell);
        if (i >= 0 && i < gw && j >= 0 && j < gh && actual[j * gw + i]) n++;
      }
      return n;
    }
    return {
      targetDay: target,
      cellDeg: cell,
      cells: cellsOut,
      stats: {
        gridW: gw, gridH: gh, cellsEvaluated: gw * gh,
        predicted,
        predictedAreaKm2: Math.round(predicted * cellAreaKm2),
        meanP: +meanP.toFixed(3), maxP: +maxP.toFixed(3),
        actualCells, overlap,
        consistencyIou: union ? +(overlap / union).toFixed(3) : 0,
        hiConfCells: hiConf.length,
        topAlignedPct: top.length ? Math.round((topHit / top.length) * 100) : 0,
      },
      domain: TRAIN_DOMAINS.includes(regionKey) ? 'in-sample' : 'extrapolated',
      regionKey,
      modelVersion: `v${W.version}`,
    };
  } catch {
    return null;
  }
}

export const FORECASTER_SKILL = W.skill;
export const FORECASTER_CAVEAT = W.caveat;
export const FORECASTER_META = {
  name: 'ignis-fire-footprint-forecaster',
  version: W.version,
  trainDomains: TRAIN_DOMAINS,
  source: 'Hugging Face Nabidnur/ignis-fire-footprint-forecaster (LogReg portable twin)',
};
