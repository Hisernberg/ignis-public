# IGNIS — AUTOMATION RUNBOOK (chat-executable)

> Purpose: drive the **entire** IGNIS build → data → deploy → submission pipeline by pasting
> step-by-step instructions into a chat AI (ChatGPT / Astra / Claude). Every step is
> self-contained, uses the exact keys stored in `secrets/.env`, and is verifiable.
> Check each box as you go.

**Convention:** the chat AI can run code or produce files. If a step says "chat AI writes a file",
paste the file content it returns into the named path (or run the given command yourself).

---

## Phase 0 — Preconditions (5 min)

- [ ] **0.1** Clone the repo (secrets included as agreed for this private repo):
      ```bash
      git clone https://github.com/Hisernberg/ignis-spaceapps2026.git && cd ignis-spaceapps2026
      ```
- [ ] **0.2** Verify secrets present: `FIRMS_MAP_KEY`, `NASA_API_KEY`, `EDL_JWT`, `HF_TOKEN`,
      `EARTHDATA_LOGIN`, `EARTHDATA_PASSWORD` in `secrets/.env`.
- [ ] **0.3** Install: `bun install` (or `npm install`). Install Bun via
      `curl -fsSL https://bun.sh/install | bash` if missing.

> Prompt for your chat AI: *"Load docs/AUTOMATION_RUNBOOK.md and docs/FINALIZED_PLAN.md. Execute
> Phase 1 now, one step at a time, showing me each verification result before continuing."*

## Phase 1 — Credential verification (10 min)

- [ ] **1.1** FIRMS key status:
      ```bash
      curl -s "https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=$(rg -o 'FIRMS_MAP_KEY=\K.*' secrets/.env)"
      ```
      ✅ Expect JSON with `transaction_count`. If unreachable on a given host, the app auto-falls
      back to GIBS — deploy on Vercel/normal networks for the full FIRMS path.
- [ ] **1.2** NASA key rate window:
      ```bash
      curl -sD - -o /dev/null "https://api.nasa.gov/planetary/apod?api_key=$(rg -o 'NASA_API_KEY=\K.*' secrets/.env)" | rg -i "HTTP|X-RateLimit"
      ```
      ✅ Expect `x-ratelimit-limit: 10000` (elevated key).
- [ ] **1.3** EDL JWT validity:
      ```bash
      node -e "const t=require('fs').readFileSync('secrets/.env','utf8').match(/EDL_JWT=(.*)/)[1];const p=JSON.parse(Buffer.from(t.split('.')[1],'base64url'));console.log(p.uid,new Date(p.exp*1000).toISOString())"
      ```
      ✅ `nabid12` + expiry. If expired → Phase 3 refresh.
- [ ] **1.4** HF token:
      ```bash
      curl -s -H "Authorization: Bearer $(rg -o 'HF_TOKEN=\K.*' secrets/.env)" https://huggingface.co/api/whoami-v2 | head -c 120
      ```
      ✅ Expect user `Nabidnur`.

## Phase 2 — Data precompute (rebuild or extend calendars)

- [ ] **2.1** Build the 25-year harmonized calendar (8 regions × MODIS/VIIRS):
      ```bash
      node scripts/ignis/build_calendar.mjs            # all regions (long)
      node scripts/ignis/build_calendar.mjs amazon     # or one region at a time
      ```
      ✅ Expect `data/ignis/calendar_*.json` ×8 with harmonization ratios logged.
- [ ] **2.2** Generate seasonal outlooks:
      ```bash
      node scripts/ignis/build_outlook.mjs
      ```
      ✅ Expect `data/ignis/outlook_*.json` ×8.
- [ ] **2.3 (optional, exact counts)** Where FIRMS is reachable, ask the chat AI to add a
      `--source=firms` mode to `build_calendar.mjs` using the FIRMS **count API**
      (`/api/count/{KEY}/{SOURCE}/{west,south,east,north}/{D1}/{D2}`) for exact monthly totals,
      then rebuild and commit the refreshed JSONs.

## Phase 3 — EDL token refresh automation (10 min)

- [ ] **3.1** Ask the chat AI to write `scripts/ignis/refresh_edl.mjs` that logs in to
      `https://urs.earthdata.nasa.gov` with `EARTHDATA_LOGIN`/`EARTHDATA_PASSWORD` from
      `secrets/.env`, captures the JWT, and rewrites `EDL_JWT=`. Schedule monthly (`0 3 1 * *`).
- [ ] **3.2** Verify with Phase 1 step 1.3.

## Phase 4 — Run the app (5 min)

- [ ] **4.1** `cp secrets/.env .env.local` then `bun run dev`.
- [ ] **4.2** Open `http://localhost:3000` — verify: GIBS true-color map, per-sensor hotspot counts,
      calendar heatmap (Amazon Basin), EONET list with `semantic` scores, status rail.
- [ ] **4.3** Drive the API surface (pitch demo):
      ```bash
      curl -s "http://localhost:3000/api/hotspots?w=-74&s=-12&e=-46&n=2&day=$(date -u -d yesterday +%F)" | head -c 400
      curl -s "http://localhost:3000/api/calendar?region=amazon" | head -c 200
      curl -s "http://localhost:3000/api/outlook?region=canada" | head -c 200
      ```

## Phase 5 — Deploy (15 min)

- [ ] **5.1** Push latest: `git add -A && git commit -m "data: calendars+outlooks" && git push`
- [ ] **5.2** Vercel: `npx vercel` → link → add env vars (`FIRMS_MAP_KEY`, `NASA_API_KEY`) → deploy.
- [ ] **5.3** Verify `https://<app>.vercel.app/api/health` shows `firms.ok: true`.
- [ ] **5.4** Record the 30-second pitch screen-recording
      (map → region switch → calendar → outlook → alert level).

## Phase 6 — HF model registry (10 min, uses HF_TOKEN)

- [ ] **6.1** Upload the outlook artifact + model card:
      ```bash
      pip install -U huggingface_hub
      huggingface-cli login            # paste HF_TOKEN
      huggingface-cli upload Nabidnur/ignis-seasonal-outlook data/ignis/outlook_amazon.json outlook_amazon.json --repo-type model
      ```
- [ ] **6.2** Link the model card from README + the Space Apps project page.

## Phase 7 — Space Apps submission (15 min)

- [ ] **7.1** Project page copy: use `docs/FINALIZED_PLAN.md` §Pitch.
- [ ] **7.2** Attach: live URL, repo URL, pitch video (≤30 s), `docs/` PDFs.
- [ ] **7.3** Register team "IGNIS" for **Harmonization of MODIS and VIIRS Hot Spots** (Global Awards).

## Phase 8 — MCP automation (advanced, optional)

- [ ] **8.1** Ask the chat AI to generate an MCP server (`mini-services/ignis-mcp/`) exposing tools
      `get_hotspots(bbox, day)`, `get_calendar(region)`, `get_outlook(region)`, `get_health()`
      wrapping `/api/*` with zod schemas. Register in any MCP client.
- [ ] **8.2** Pitch moment: *"the entire pipeline is machine-drivable"* — call the tools live.

---

## Failure playbook

| Symptom | Fix |
|---|---|
| `firms … unreachable` in status rail | Host firewall; deploy on Vercel or any standard network. App already serves GIBS fallback. |
| Calendar 202 "building" | Re-run Phase 2.1; check console output. |
| MiniLM first call slow | Model downloads once (~25 MB) to `.hf_cache`; warm with one `/api/eonet` call before demo. |
| EDL expired | Phase 3 refresh. |
| GIBS VIIRS "sensor lag" tag | Normal — GIBS VIIRS vector archive lags; MODIS path is freshest; production uses FIRMS NRT. |
| High SNPP/MODIS ratio | Expected with sampled GIBS tiles; run exact-count FIRMS mode (2.3) for literature-grade ratios. |
