// Hugging Face model usage (transformers.js, server-side ONNX): all-MiniLM-L6-v2
// Used for semantic alert triage — ranks live wildfire events against region profiles.
// No chat-LLM dependency: a small embedding model runs fully on-device (onnxruntime).

import type { FeatureExtractionPipeline } from '@huggingface/transformers';

type Extractor = FeatureExtractionPipeline;

const MODEL = 'Xenova/all-MiniLM-L6-v2';
let extractor: Extractor | null = null;
let loading: Promise<Extractor> | null = null;

export async function getEmbedder(): Promise<Extractor> {
  if (extractor) return extractor;
  if (loading) return loading;
  loading = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Vercel/production filesystems are read-only except /tmp
    env.cacheDir = process.env.VERCEL || process.env.NODE_ENV === 'production' ? '/tmp/hf_cache' : process.cwd() + '/.hf_cache';
    env.allowLocalModels = false;
    const pipe = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
    extractor = pipe;
    return pipe;
  })();
  return loading;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

export async function embed(texts: string[]): Promise<number[][]> {
  const ex = await getEmbedder();
  const out = await ex(texts, { pooling: 'mean', normalize: true });
  const dims = out.dims as number[];
  const n = dims[dims.length - 1];
  const data = Array.from(out.data as Float32Array);
  const rows: number[][] = [];
  for (let i = 0; i < data.length; i += n) rows.push(data.slice(i, i + n));
  return rows;
}

export const REGION_PROFILES: Record<string, string> = {
  amazon: 'Tropical rainforest fires in the Amazon basin, deforestation burning season in Brazil, drought-driven forest fires in South America.',
  california: 'Wildfires in California and the US West coast, chaparral and forest fires, Santa Ana wind-driven urban interface fires.',
  canada: 'Boreal forest fires in Canada, record-breaking fire seasons, long-range smoke transport, lightning-caused fires.',
  siberia: 'Wildfires in Siberia and Yakutia, boreal and permafrost peat fires, Arctic smoke plumes.',
  congo: 'Fires in the Congo basin of Central Africa, tropical forest and savanna burning, agricultural slash-and-burn fires.',
  borneo: 'Indonesian peatland fires in Borneo and Sumatra, El Nino driven megafires, transboundary haze in Southeast Asia.',
  australia: 'Australian bushfires, Black Summer megafires, eucalyptus forest fires in New South Wales and Victoria.',
  mediterranean: 'Mediterranean wildfires in Spain, Greece, Italy, Portugal and Turkey, heatwave-driven fires in Southern Europe.',
};
