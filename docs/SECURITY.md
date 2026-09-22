# Security & Credential Policy

IGNIS consumes several free-tier, user-owned API credentials. This public
repository is designed so that **no credential of any kind — plaintext or
encoded — exists anywhere in it**: not in source, not in docs, not in history.
This document explains exactly how that guarantee is achieved and how to run
the platform safely with your own keys.

## Credential inventory

| Credential | Used for | Required? | How to obtain |
|---|---|---|---|
| FIRMS MAP_KEY | FIRMS area / NRT CSV API (harmonized hotspots) | recommended (free) | https://firms.modaps.eosdis.nasa.gov/api/area/ |
| api.nasa.gov key | APOD / EPIC / DONKI / EONET-rate-limits | optional (`DEMO_KEY` works, rate-limited) | https://api.nasa.gov/ |
| Earthdata Login JWT | EDL/CMR bearer auth (`/api/health` identity probe) | optional | https://urs.earthdata.nasa.gov/ → Generate Token |
| Hugging Face token | AI analyst chat (HF Inference) + Hub API | optional | https://huggingface.co/settings/tokens |

## How this repository stays clean

1. **Environment-variable-only key resolution.** `src/lib/ignis/keys.ts`
   reads `process.env.FIRMS_MAP_KEY / NASA_API_KEY / EDL_TOKEN / HF_TOKEN` —
   there are no embedded fallback values of any form (no plaintext, no
   base64, no splits). Copy `.env.example` → `.env.local` and fill in what
   you have.
2. **Zero-key demo mode.** With no `FIRMS_MAP_KEY`, the data layer
   (`src/lib/ignis/firms.ts`) automatically falls back to **NASA GIBS
   WMTS/MVT thermal-anomaly tiles** — public, key-free, FIRMS-derived data
   with archive back to November 2000. The map, segmentation, calendar and
   analytics all run on real satellite data out of the box.
3. **Clean history.** This public repository was built as a **fresh,
   single-commit snapshot** from an audited tree of the development
   repository. No historical commit exists here that could carry a stale
   credential. `.gitignore` excludes `.env*`, `secrets/`, `vault/` and build
   artifacts; only `.env.example` (placeholder names, empty values) is
   tracked.
4. **Pattern audits before every push.** GitHub-token (`ghp_…`), Hugging
   Face-token (`hf_…`), EDL-JWT (`eyJ0eXAi…`) and 32-hex MAP_KEY patterns are
   scanned across the whole tree, **including base64/hex-encoded variants**
   of every known secret, so nothing can sneak back in through an encoding
   trick.
5. **Deployment separation.** The production deployment (Vercel) receives
   its keys as server-side environment variables configured in the hosting
   dashboard — they are never written into the repository or its build
   output. Plaintext keys live only in a separate **private** vault
   repository, outside this codebase, and are rotated after judging.

## If you fork / deploy this project

- Never commit `.env.local`. The `.gitignore` already excludes it — keep it
  that way.
- Use **server-side** environment variables in your host's dashboard for
  production; `.env.local` is for local development only.
- All NASA keys here are free-tier. If you suspect one of *your* keys leaked,
  rotate it immediately: FIRMS and api.nasa.gov keys regenerate in seconds
  from their respective portals, and EDL/JWT and HF tokens can be revoked
  from their account settings.
- Run the audit habit: `grep -rE "ghp_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}"`
  plus a scan for your own MAP_KEY value before pushing.

## Rotation runbook (post-competition)

1. Revoke / regenerate: FIRMS MAP_KEY, api.nasa.gov key, HF token, Earthdata
   JWT, GitHub PAT.
2. Update the values in the deployment dashboard (or your private vault).
3. Redeploy; verify with `GET /api/health` — every subsystem reports its own
   live status so a missed rotation is immediately visible.
