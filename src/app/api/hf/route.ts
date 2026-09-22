import { NextResponse } from 'next/server';
import { KEYS } from '@/lib/ignis/keys';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * IGNIS Open Science proxy — Hugging Face Hub (token-gated).
 * Surfaces the IGNIS model family + datasets with LIVE metadata and metrics:
 *  - Models:   ignis-fire-regime-model · ignis-fire-classifier ·
 *              ignis-event-detector · ignis-fire-footprint-forecaster
 *  - Dataset:  ignis-fire-calendar (9 regions × 26-yr harmonized calendars)
 * Repos are PRIVATE during judging; reads use the server-side HF token and are
 * never exposed to the client. Cached 5 min.
 */

const OWNER = 'Nabidnur';
const MODELS = [
  { id: 'ignis-fire-regime-model', task: 'Fire-complex segmentation + regime classifier', metric: '63 complexes · silhouette 0.178 · LIVE in Burn Regime panel' },
  { id: 'ignis-fire-classifier', task: 'Per-detection fire-behavior classification', metric: 'extra-trees twin held-out agreement 0.685 (HGB ref 0.763) · LIVE per detection' },
  { id: 'ignis-event-detector', task: 'Next-month extreme-fire-month early warning', metric: 'AUC 0.740 · PR-AUC 0.606 (2022-26 holdout) · LIVE in Seasonal Outlook' },
  { id: 'ignis-fire-footprint-forecaster', task: 'Next-day complex footprint (segmentation)', metric: 'IoU 0.50-0.66 vs persistence 0.36-0.39 · LIVE map forecast overlay' },
] as const;
const DATASET = `${OWNER}/ignis-fire-calendar`;

export const revalidate = 300;

function hfHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': 'IGNIS/1.0 (NASA Space Apps 2026)' };
  if (KEYS.HF_TOKEN) h.Authorization = `Bearer ${KEYS.HF_TOKEN}`;
  return h;
}

async function j(url: string, ms = 12000): Promise<Record<string, unknown> | null> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    const res = await fetch(url, { signal: ac.signal, headers: hfHeaders() });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET() {
  const family = await Promise.all(
    MODELS.map(async (m) => {
      const info = await j(`https://huggingface.co/api/models/${OWNER}/${m.id}`);
      const metrics = await j(`https://huggingface.co/${OWNER}/${m.id}/resolve/main/metrics.json`, 8000);
      return {
        id: `${OWNER}/${m.id}`,
        task: m.task,
        metric: m.metric,
        private: info ? ((info.private as boolean) ?? true) : null,
        lastModified: info ? ((info.lastModified as string) ?? null) : null,
        files: info && Array.isArray(info.siblings) ? (info.siblings as { rfilename: string }[]).map((s) => s.rfilename) : [],
        metrics: metrics ?? null,
        url: `https://huggingface.co/${OWNER}/${m.id}`,
      };
    }),
  );

  const datasetInfo = await j(`https://huggingface.co/api/datasets/${DATASET}`);
  const splits = await j(`https://datasets-server.huggingface.co/splits?dataset=${encodeURIComponent(DATASET)}`, 15000);
  let cfg: string | null = null;
  let split: string | null = null;
  if (splits && Array.isArray(splits.splits) && splits.splits.length > 0) {
    const first = splits.splits[0] as { config: string; split: string };
    cfg = first.config;
    split = first.split;
  }
  const rows = cfg
    ? await j(
        `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
          `&config=${encodeURIComponent(cfg)}&split=${encodeURIComponent(split ?? 'train')}&offset=0&length=6`,
        15000,
      )
    : null;

  const previewRows =
    rows && Array.isArray(rows.rows)
      ? (rows.rows as { row: Record<string, unknown> }[]).slice(0, 6).map((r) => r.row)
      : null;
  const previewColumns =
    rows && Array.isArray(rows.rows) && rows.rows.length > 0
      ? Object.keys((rows.rows[0] as { row: Record<string, unknown> }).row ?? {}).slice(0, 10)
      : null;

  const pickRepoMeta = (d: Record<string, unknown> | null) =>
    d
      ? {
          id: d.id as string,
          private: (d.private as boolean) ?? false,
          likes: (d.likes as number) ?? 0,
          downloads: (d.downloads as number) ?? 0,
          lastModified: (d.lastModified as string) ?? null,
          files: Array.isArray(d.siblings) ? (d.siblings as { rfilename: string }[]).map((s) => s.rfilename) : [],
        }
      : null;

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    visibility: 'private-during-judging (token-gated reads; released public after the competition)',
    modelFamily: family,
    dataset: pickRepoMeta(datasetInfo),
    urls: {
      dataset: `https://huggingface.co/datasets/${DATASET}`,
      viewer: `https://huggingface.co/datasets/${DATASET}/viewer`,
      family: MODELS.map((m) => `https://huggingface.co/${OWNER}/${m.id}`),
    },
    preview: { config: cfg, split, columns: previewColumns, rows: previewRows },
    stack: [
      { name: 'Llama-3.1-8B-Instruct (Qwen3-8B fallback)', role: 'Grounded AI analyst + SITREP briefings', via: 'Hugging Face Inference Router' },
      { name: 'all-MiniLM-L6-v2', role: 'On-device semantic triage of EONET events', via: '@huggingface/transformers (WASM, in-browser)' },
      { name: 'ignis-fire-regime-model', role: 'DBSCAN+KMeans complex segmentation + regime classification', via: 'Hugging Face Hub (joblib)' },
      { name: 'ignis-fire-classifier', role: 'Fire-behavior classification of detections', via: 'Hugging Face Hub (joblib)' },
      { name: 'ignis-event-detector', role: 'Extreme-fire-month early warning (weights wired in-app)', via: 'Hugging Face Hub + client-side TS' },
      { name: 'ignis-fire-footprint-forecaster', role: 'Next-day complex footprint probability field', via: 'Hugging Face Hub (joblib)' },
      { name: 'ignis-fire-calendar', role: '26-yr harmonized fire calendar dataset', via: 'Hugging Face Hub (dataset)' },
    ],
  });
}
