/**
 * IGNIS on-device model inference — portable twin of the Hugging Face
 * ignis-fire-classifier (per-detection fire-behavior classification).
 *
 * The published HF repo holds the HGB reference model (not JS-portable) and a
 * LogReg twin (too weak on skewed days: 0.08 held-out agreement). We distill a
 * COMPACT EXTRA-TREES ENSEMBLE (40 trees, depth 12) on the same weak labels —
 * held-out-day agreement 0.685 (HGB reference: 0.763) — and export it as a flat
 * node array: classifierWeights.json (server-only bundle, ~2.6 MB).
 *
 * Density features use an integral-image box count with an exact area-ratio
 * correction (corr >= 0.98 vs the training pipeline's exact KD-tree counts),
 * so the in-app features mirror scripts/models/train_classifier_portable.py.
 */
import classifierW from './classifierWeights.json';
import type { FirePoint } from './types';

type WShape = {
  classes: string[];
  features: string[];
  nTrees: number;
  nodes: TreeNode[][]; // [tree][node] = [featIdx, threshold, left, right, probs[]]
  skill: { heldout_day_agreement: number; hgb_reference_test_acc: number };
  version: string;
};
/** [featIdx (-1 = leaf), threshold, left, right, probs per class] */
type TreeNode = [number, number, number, number, number[]];
const W = classifierW as unknown as WShape;

const CELL = 0.01; // degree per grid cell for neighbour counting
const RADII = [0.05, 0.25, 1.0]; // training radii (~5 km / ~28 km / ~110 km in degree space)
const N_CLS = W.classes.length;

/** Walk one tree. Leaf when featIdx < 0. */
function treeProbs(nodes: TreeNode[], x: number[]): number[] {
  let i = 0;
  for (;;) {
    const nd = nodes[i];
    if (nd[0] < 0) return nd[4];
    i = x[nd[0]] <= nd[1] ? nd[2] : nd[3];
  }
}

/**
 * Classifies every detection in-place with the fire-behavior ensemble twin.
 * Features (must mirror train_classifier_portable.py):
 *   log_frp, confidence_harmonized, is_night, acq_hour, is_viirs,
 *   dens_5km, dens_25km, dens_100km, frp_ratio
 * Grouping mirrors training: features are computed per (AOI, acquisition-day)
 * group across ALL sensors — the caller passes one day's merged points.
 */
export function classifyDetections(points: FirePoint[]): void {
  const n = points.length;
  if (n === 0) return;

  // ---- group bbox + grid ----
  let w = Infinity, s = Infinity, e = -Infinity, nrt = -Infinity;
  for (const p of points) {
    if (p.lon < w) w = p.lon;
    if (p.lat < s) s = p.lat;
    if (p.lon > e) e = p.lon;
    if (p.lat > nrt) nrt = p.lat;
  }
  w -= 1.05; s -= 1.05; e += 1.05; nrt += 1.05;
  const gw = Math.min(4000, Math.ceil((e - w) / CELL) + 1);
  const gh = Math.min(4000, Math.ceil((nrt - s) / CELL) + 1);

  // ---- integral image of point counts ----
  const counts = new Float32Array(gw * gh);
  const cellOf = (lat: number, lon: number): [number, number] => [
    Math.min(gw - 1, Math.max(0, Math.floor((lon - w) / CELL))),
    Math.min(gh - 1, Math.max(0, Math.floor((lat - s) / CELL))),
  ];
  for (const p of points) {
    const [ci, cj] = cellOf(p.lat, p.lon);
    counts[cj * gw + ci] += 1;
  }
  const ii = new Float64Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    let rowSum = 0;
    for (let i = 0; i < gw; i++) {
      rowSum += counts[j * gw + i];
      ii[j * gw + i] = rowSum + (j > 0 ? ii[(j - 1) * gw + i] : 0);
    }
  }
  const boxCount = (ci: number, cj: number, k: number): number => {
    const i0 = Math.max(0, ci - k), i1 = Math.min(gw - 1, ci + k);
    const j0 = Math.max(0, cj - k), j1 = Math.min(gh - 1, cj + k);
    const a = j0 > 0 ? ii[(j0 - 1) * gw + i1] : 0;
    const b = i0 > 0 ? ii[j1 * gw + i0 - 1] : 0;
    const c = j0 > 0 && i0 > 0 ? ii[(j0 - 1) * gw + i0 - 1] : 0;
    return ii[j1 * gw + i1] - a - b + c;
  };
  // exact area-ratio correction (uniform-density circle equivalent of the box count)
  const ks = RADII.map((r) => Math.max(1, Math.round(r / CELL)));
  const boxSide = ks.map((k) => (2 * k + 1) * CELL);
  const areaFactor = RADII.map((r, i) => (Math.PI * r * r) / (boxSide[i] * boxSide[i]));

  // ---- regional median FRP for frp_ratio ----
  const frps = points.map((p) => p.frp).sort((a, b) => a - b);
  const medianFrp = frps[Math.floor(n / 2)] || 1;

  // ---- classify ----
  const x = new Array<number>(W.features.length).fill(0);
  const probs = new Array<number>(N_CLS).fill(0);
  for (const p of points) {
    const [ci, cj] = cellOf(p.lat, p.lon);
    x[0] = Math.log1p(p.frp || 0);
    x[1] = p.conf ?? 60;
    x[2] = p.night ? 1 : 0;
    x[3] = p.acq ? Number(p.acq.slice(0, 2)) || 12 : 12;
    x[4] = (p.sat ?? '').toUpperCase().startsWith('VIIRS') ? 1 : 0;
    x[5] = boxCount(ci, cj, ks[0]) * areaFactor[0];
    x[6] = boxCount(ci, cj, ks[1]) * areaFactor[1];
    x[7] = boxCount(ci, cj, ks[2]) * areaFactor[2];
    x[8] = (p.frp || 0) / (medianFrp || 1);
    probs.fill(0);
    for (let t = 0; t < W.nodes.length; t++) {
      const tp = treeProbs(W.nodes[t], x);
      for (let k = 0; k < N_CLS; k++) probs[k] += tp[k];
    }
    let best = 0;
    for (let k = 1; k < N_CLS; k++) if (probs[k] > probs[best]) best = k;
    const sum = W.nodes.length;
    p.beh = W.classes[best];
    p.behP = Math.round((probs[best] / sum) * 1000) / 1000;
  }
}

export const CLASSIFIER_META = {
  name: 'ignis-fire-classifier',
  version: W.version,
  classes: W.classes,
  heldoutAgreement: W.skill?.heldout_day_agreement ?? null,
  source: 'Hugging Face Nabidnur/ignis-fire-classifier (extra-trees portable twin)',
};
