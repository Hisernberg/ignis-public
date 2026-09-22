// SERVER-ONLY key resolution. Never import this from a client component.
//
// SECURITY DESIGN (see docs/SECURITY.md):
//  This public repository contains NO credentials of any kind — plaintext or
//  encoded. All NASA/Hugging Face keys are supplied exclusively through
//  environment variables (see .env.example).
//
//  How to get your own free keys (they take ~2 minutes):
//   1. FIRMS MAP_KEY  → https://firms.modaps.eosdis.nasa.gov/api/area/
//      (free NASA FIRMS account; 5,000 transactions / 10 min limit)
//   2. NASA_API_KEY   → https://api.nasa.gov/  (free; 1,000 req/hour, or use DEMO_KEY)
//   3. EDL_TOKEN      → https://urs.earthdata.nasa.gov/ → Generate Token
//      (optional; used only by /api/health to verify Earthdata Login identity)
//   4. HF_TOKEN       → https://huggingface.co/settings/tokens
//      (optional; used only by /api/analyst for the AI chat feature)
//
//  ZERO-KEY DEMO MODE: the platform is fully functional without any keys.
//  With FIRMS_MAP_KEY unset, src/lib/ignis/firms.ts automatically falls back
//  to NASA GIBS WMTS/MVT thermal-anomaly tiles — public, key-free NASA data
//  (FIRMS-derived, archive back to 2000) — so the map, segmentation, calendar
//  and analytics all run on real satellite data out of the box.
//
//  The private deployment keeps its keys in a separate private vault
//  repository and injects them as Vercel environment variables at build/run
//  time. Keys are never committed to this (public) repository.

const ENV = (name: string): string => process.env[name] ?? '';

export const KEYS = {
  FIRMS_MAP_KEY: ENV('FIRMS_MAP_KEY'),
  NASA_API_KEY: ENV('NASA_API_KEY') || 'DEMO_KEY',
  HF_TOKEN: ENV('HF_TOKEN'),
  EDL_TOKEN: ENV('EDL_TOKEN'),
};

export const KEY_SOURCES = {
  FIRMS_MAP_KEY: KEYS.FIRMS_MAP_KEY ? 'env' : 'unconfigured (GIBS key-free fallback active)',
  NASA_API_KEY: process.env.NASA_API_KEY ? 'env' : 'DEMO_KEY (rate-limited)',
  HF_TOKEN: KEYS.HF_TOKEN ? 'env' : 'unconfigured (AI analyst offline)',
  EDL_TOKEN: KEYS.EDL_TOKEN ? 'env' : 'unconfigured (health-check EDL probe offline)',
};
