# IGNIS Brand Kit

Official visual identity for **IGNIS** — *Earth's Burning Activity Calendar* (NASA Space Apps Challenge 2026, Challenge #9: *Harmonization of MODIS and VIIRS Hot Spots*).

---

## 1. Name

**IGNIS** — Latin for *fire*.

| Considered | Verdict | Reason |
|---|---|---|
| **IGNIS** | **chosen** | Latin "fire" — direct, international, professional; evokes *ignite*; short and pronounceable in every language; already consistent across all repos, models, dataset and the deployed app (`ignis-spaceapps2026.vercel.app`) |
| AGNI | rejected | Sanskrit fire god, culturally resonant in South Asia — but heavily collided (Indian missile program, many existing tech products) and a rebrand would break every established link at judging time |
| PYRA / EMBER / other | rejected | either trademark-crowded or less literal |

The name is a statement of purpose, not decoration: IGNIS turns NASA's raw hotspot record into **one living calendar of fire**.

## 2. Logo — the *Scan-Flame*

The mark is a flame **sliced into horizontal bands** — each band is one observation layer (a calendar row, a satellite scanline, a day of detections). The **detached tip** is a hotspot detection rising free of the record. The **heat-scale ramp** (deep red → gold) mirrors FIRMS fire-intensity palettes, and the optional **orbit arc + satellite dot** places the flame where IGNIS sees it: from space.

| Element | Meaning |
|---|---|
| Flame silhouette | fire itself — the planet's burning activity |
| 5 scan bands + rising tip | daily observations stacked into a calendar; the tip = a live detection escaping the archive |
| Color ramp (bottom → top) | FIRMS-style heat scale: `#E03A0C → #FF5A1F → #FF7A2E → #FFA02E → #FFC53D → #FFE49A` |
| Orbit arc (banner/OG only) | the satellite vantage — MODIS & VIIRS |

## 3. Color system

| Token | Hex | Use |
|---|---|---|
| **Ignis Night** | `#0B0E17` | primary background (dark-first brand) |
| Charcoal Panel | `#151B2C` | cards / panels on dark |
| Border | `#22304C` | hairlines on dark |
| **Ignis Ember** | `#FF5A1F` | primary accent, CTAs, active states |
| Flame Gold | `#FFB627` | secondary accent, highlights |
| Spark | `#FFE49A` | hottest accent, tiny highlights only |
| Orbit Blue | `#4DA8DA` | satellite / data / informational accents |
| Text (dark bg) | `#F2F5FA` | primary text |
| Muted (dark bg) | `#8B95A9` | secondary text |
| Text (light bg) | `#10141F` | primary text on light |
| Muted (light bg) | `#5A6478` | secondary text on light |

**Contrast rule:** Ignis Ember on Ignis Night passes AA for large text and UI accents; never set body copy in Ember on Night.

## 4. Typography

- **Wordmark:** Liberation Sans Bold (open-license, Arial-metric) — always used as converted vector paths in the shipped SVGs, tracking +0.16 em.
- **Tagline:** Liberation Sans Bold, tracking +0.30 em, sentence case with true apostrophe (’).
- **App UI:** Geist Sans / Geist Mono (Next.js built-in).
- **Recommendation for print/slide reuse:** any geometric grotesque (Inter, Space Grotesk); keep caps + wide tracking for the wordmark role.

## 5. Assets

| File | Purpose |
|---|---|
| `svg/ignis-mark.svg` | the mark alone — transparent, for dark backgrounds |
| `svg/ignis-mark-solid.svg` | one-piece flame — favicons and sizes < 32 px |
| `svg/ignis-lockup-horizontal.svg` / `-light.svg` | mark + wordmark + tagline (dark / light text) |
| `svg/ignis-wordmark.svg` / `-light.svg` | wordmark alone (dark / light) |
| `svg/ignis-banner.svg` | 1200×300 README banner |
| `og-image.png` | 1200×630 social preview (repo social preview + Open Graph) |
| `png/` | raster exports (mark 512/1024, banner 2400×600, lockup, icon tile) |
| `icons/` | `favicon.ico` (16/32/48), `icon-*.png` (16–512), `apple-touch-icon.png` (180), `maskable-512.png` |

## 6. Usage rules

**Clear space:** keep ≥ 25 % of the mark's height free on all sides.
**Minimum sizes:** mark 24 px · lockup 140 px wide · below 32 px always use the solid variant.
**Backgrounds:** dark-first (Ignis Night, #0B0E17); on light backgrounds use the `-light` text variants — the flame ramp works on both.
**Don'ts:**
- don't recolor outside the ramp, add gradients of your own, or apply shadows/outlines
- don't stretch, rotate, tilt or animate the flame bands
- don't set the wordmark in another typeface or change tracking
- don't place the full-color mark on mid-tone photography without a scrim

**Do's:** pair with Orbit Blue for data/informational accents; use the star-field night backdrop for hero surfaces; keep the tagline set one visual step below the wordmark.

## 7. App wiring (already done)

- `/favicon.ico`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, `/maskable-icon-512.png` served from the app root
- Open Graph / Twitter card → `/og-image.png`
- `/logo.svg` = the IGNIS mark

## 8. License

Code: MIT. Brand assets: © Team IGNIS — free to reproduce for NASA Space Apps Challenge judging and non-commercial coverage with attribution.
