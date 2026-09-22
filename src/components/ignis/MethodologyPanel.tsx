'use client';

import { SENSOR_INFO, worldviewSnapshotUrl, MOD11_NOTES } from '@/lib/ignis/regions';
import type { CalendarDoc, HotspotsResult } from '@/lib/ignis/types';

type Props = { bbox: number[]; day: string; doc: CalendarDoc | null; hotspots: HotspotsResult | null };

export default function MethodologyPanel({ bbox, day, doc, hotspots }: Props) {
  const ratio = doc?.harmonization?.meanRatioSNPPtoMODIS ?? null;
  const overlap = doc?.harmonization?.overlapMonths ?? null;

  function exportCsv() {
    if (!hotspots) return;
    const lines = ['sensor,satellite,latitude,longitude,frp_mw,confidence,daynight,acq_time'];
    for (const [sensor, s] of Object.entries(hotspots.sensors)) {
      for (const p of s.points) {
        lines.push([sensor, p.sat || '', p.lat, p.lon, p.frp, p.confRaw ?? p.conf ?? '', p.night ? 'N' : 'D', p.acq || ''].join(','));
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ignis_hotspots_${day}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
        <h3 className="text-sm font-semibold tracking-wide text-slate-100">THE PROBLEM: A SPLIT RECORD</h3>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-300">
          Satellites have tracked active fires for more than two decades, but the record is split across instruments that cannot be compared directly.
          MODIS (1 km pixels) has flown on Terra since 2000 and Aqua since 2002. VIIRS (375 m) began on Suomi NPP in 2012 and continues on NOAA-20 and NOAA-21.
          A 375 m sensor resolves fires roughly <span className="text-orange-300">450× smaller in area</span>, so raw VIIRS counts run much higher for the same landscape — stitching the two eras together naively creates artificial jumps that would mislead any trend analysis.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-300">
          IGNIS heals the break with an <span className="text-cyan-300">overlap-derived continuity coefficient</span>: during the 2012+ window where both sensors observe the same skies, we compute the monthly ratio between them and use its median as the transfer function that scales MODIS-era months into VIIRS-equivalent terms. FRP (fire radiative power, MW) is physically comparable across sensors and is carried as a second, bias-resistant channel.
        </p>
        <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5 font-mono text-[10.5px] text-slate-300">
            k<sub>count</sub> = median(VIIRS<sub>est</sub> / MODIS<sub>est</sub>) over {overlap ?? '—'} overlap months{ratio ? ` = ${ratio.toFixed(2)}` : ''}
            <br />unified<sub>pre-2012</sub> = MODIS<sub>est</sub> × k<sub>count</sub>
          </div>
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5 text-[10.5px] text-slate-400">
            Uncertainty is reported honestly: ratio variability (CV) propagates to scaled months; VIIRS archive lag (S-NPP → {doc?.sensors['VIIRS-SNPP']?.monthly.at(-1)?.ym ?? '2026-07'}, NOAA-20 → {doc?.sensors['VIIRS-NOAA20']?.monthly.at(-1)?.ym ?? '2025-12'}) is surfaced in the status rail instead of being hidden.
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
        <h3 className="text-sm font-semibold tracking-wide text-slate-100">THE NASA SENSOR ARSENAL</h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[11px]">
            <thead>
              <tr className="border-b border-[#1E3A5F] text-[10px] uppercase tracking-wider text-slate-500">
                <th className="py-1.5 pr-3">Sensor</th><th className="py-1.5 pr-3">Resolution</th><th className="py-1.5 pr-3">Record start</th><th className="py-1.5 pr-3">Orbit / overpass</th><th className="py-1.5">Role in IGNIS</th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {Object.entries(SENSOR_INFO).map(([k, v]) => (
                <tr key={k} className="border-b border-[#0F1D31]">
                  <td className="py-1.5 pr-3 font-semibold text-slate-100">{k}</td>
                  <td className="py-1.5 pr-3">{v.res}</td>
                  <td className="py-1.5 pr-3">{v.start}</td>
                  <td className="py-1.5 pr-3">{v.orbit}</td>
                  <td className="py-1.5 text-slate-400">{k.startsWith('MODIS') ? 'deep history + morning/afternoon views' : 'fine-resolution continuity era'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10.5px] text-slate-500">
          All detections flow from NASA FIRMS/LANCE (NRT products MODIS C6.1, VIIRS V2) via the area API, with NASA GIBS WMTS vector tiles as an independent fallback path; daily true-color and 7-2-1 imagery backdrops come from GIBS; open wildfire event triage from EONET v3; Earthdata Login secures CMR/ASF access.
        </p>
      </div>

      <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
        <h3 className="text-sm font-semibold tracking-wide text-slate-100">PROCESSING MODIS LST THE RIGHT WAY (LP DAAC MOD11)</h3>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-300">
          Alongside active-fire detections, IGNIS overlays <span className="text-orange-300">Land Surface Temperature</span> from LP DAAC&apos;s MOD11/Terra suite as thermal context — surface heat precedes and lingers after flaming fronts. We follow LP DAAC&apos;s official processing guidance exactly: products (MOD11_L2/MYD11_L2 swaths, daily MOD11A1, 8-day MOD11A2, monthly MOD11B3) ship as HDF with per-pixel Kelvin and emissivity, and every science dataset needs its documented scaling applied before interpretation.
        </p>
        <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5 font-mono text-[10.5px] text-slate-300">
            LST (K) = stored × 0.02 — e.g. 1592 → 31.84 K<br />
            ε = stored × 0.02 + 0.49 — e.g. 241 → 0.972<br />
            fill / no-data = 0 (rendered black)
          </div>
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5 text-[10.5px] text-slate-400">
            QA layers are bit-packed integers read right→left (bits 0–1 mandatory QA, 2–3 pixel quality); decode with LDOPE <i>unpack_sds_bits</i>, AppEEARS quality filters, or the MODIS Python Toolbox. V6 removed cloud-contaminated LST, updated the split-window LUT, and added two 6 km grids.
          </div>
        </div>
        <p className="mt-2 text-[10px] text-slate-500">
          In-app, the GIBS-rendered MOD11 Day/Night rasters (epsg3857 · GoogleMapsCompatible_Level7) use the standard LP DAAC convention — hot = red/orange, cool = green/blue, fill = black — so raw HDF handling and colormap semantics stay consistent from download to display.
        </p>
      </div>

      <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
        <h3 className="text-sm font-semibold tracking-wide text-slate-100">THE ANALYTICS STACK (DETERMINISTIC & AUDITABLE)</h3>
        <div className="mt-2 grid gap-2 text-[11px] text-slate-300 sm:grid-cols-2">
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5"><b className="text-cyan-300">Harmonization</b> — overlap-ratio continuity + FRP channel; per-sensor series never silently mixed.</div>
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5"><b className="text-cyan-300">Unusual conditions</b> — monthly z-scores vs 2000–2023 climatology; |z| ≥ 2 flagged on the calendar.</div>
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5"><b className="text-cyan-300">Trend</b> — Theil-Sen robust slope (per-decade, outlier-resistant).</div>
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5"><b className="text-cyan-300">Change points</b> — CUSUM on annual totals with before/after levels + confidence.</div>
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5"><b className="text-cyan-300">Forecast</b> — harmonic (Fourier) regression in log-space with ±1.96σ residual band; replaces heavy TS models with something every judge can re-derive.</div>
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5"><b className="text-cyan-300">Regime classifier</b> — nearest-prototype over 8 NASA-derived reference regions using peak timing, seasonality, interannual CV, night fraction, mean FRP.</div>
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5"><b className="text-cyan-300">Segmentation</b> — grid-accelerated DBSCAN (ε adaptive, minPts 3) + convex-hull boundaries (monotone chain); cluster classes, front-ratio, persistence tracking — all deterministic, in-browser.</div>
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5"><b className="text-cyan-300">AI triage</b> — Hugging Face all-MiniLM-L6-v2 (on-device ONNX) ranks EONET events against region profiles; zero data leaves the server.</div>
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5"><b className="text-cyan-300">AI analyst + SITREP</b> — Llama-3.1-8B-Instruct via Hugging Face inference, grounded in live telemetry (incl. segmentation), zero-hallucination guard, deterministic rule-engine fallback that produces the same SITREP structure offline.</div>
          <div className="rounded-lg border border-[#1E3A5F] bg-[#060D1A] p-2.5"><b className="text-cyan-300">Open artifact</b> — <a href="https://huggingface.co/datasets/Nabidnur/ignis-fire-calendar" target="_blank" rel="noreferrer" className="text-[#7DD3FC] hover:underline">Nabidnur/ignis-fire-calendar on Hugging Face ↗</a>: all 9 regional calendars + outlooks + the reproducible build scripts + analysis notebook.</div>
        </div>
      </div>

      <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-4">
        <h3 className="text-sm font-semibold tracking-wide text-slate-100">DATA PROVENANCE & EXPORTS</h3>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
          <a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noreferrer" className="rounded border border-[#1E3A5F] px-2.5 py-1 text-slate-300 hover:border-[#38BDF8]/60">NASA FIRMS/LANCE ↗</a>
          <a href="https://worldview.earthdata.nasa.gov/" target="_blank" rel="noreferrer" className="rounded border border-[#1E3A5F] px-2.5 py-1 text-slate-300 hover:border-[#38BDF8]/60">NASA Worldview / GIBS ↗</a>
          <a href="https://eonet.gsfc.nasa.gov/" target="_blank" rel="noreferrer" className="rounded border border-[#1E3A5F] px-2.5 py-1 text-slate-300 hover:border-[#38BDF8]/60">NASA EONET v3 ↗</a>
          <a href="https://www.earthdata.nasa.gov/" target="_blank" rel="noreferrer" className="rounded border border-[#1E3A5F] px-2.5 py-1 text-slate-300 hover:border-[#38BDF8]/60">NASA Earthdata ↗</a>
          <a href="https://lpdaac.usgs.gov/products/mod11a1v061/" target="_blank" rel="noreferrer" className="rounded border border-[#1E3A5F] px-2.5 py-1 text-slate-300 hover:border-[#38BDF8]/60">LP DAAC MOD11 ↗</a>
          <a href="https://huggingface.co/datasets/Nabidnur/ignis-fire-calendar" target="_blank" rel="noreferrer" className="rounded border border-[#1E3A5F] px-2.5 py-1 text-slate-300 hover:border-[#38BDF8]/60">🤗 IGNIS dataset (calendars) ↗</a>
          <a href={worldviewSnapshotUrl(bbox, day)} target="_blank" rel="noreferrer" className="rounded border border-[#38BDF8]/60 bg-[#38BDF8]/10 px-2.5 py-1 text-[#7DD3FC]">⇩ AOI satellite snapshot (JPEG)</a>
          <button onClick={exportCsv} disabled={!hotspots} className="rounded border border-[#38BDF8]/60 bg-[#38BDF8]/10 px-2.5 py-1 text-[#7DD3FC] disabled:opacity-40">⇩ Export current hotspots (CSV)</button>
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
          References: Giglio, L., et al. (2003) <i>An enhanced contextual fire detection algorithm for MODIS</i>, Remote Sensing of Environment 87. · Schroeder, W., et al. (2014) <i>The VIIRS 375 m active fire detection data product</i>, RSE 152. · Wan, Z. (2014) <i>MODIS Land Surface Temperature — User&apos;s Guide</i> (MOD11/MYD11, Collection 6), NASA LP DAAC, DOI 10.5067/MODIS/MOD11A1.061. · NASA FIRMS/LANCE Near Real-Time fire products (MODIS C6.1 / VIIRS V2). · NASA GIBS WMTS layers for imagery, FIRMS-derived thermal anomaly vector tiles and MOD11 LST rasters. · Fire-weather composite: Open-Meteo forecast API (temperature, humidity, wind, precipitation).
        </p>
      </div>
    </div>
  );
}
