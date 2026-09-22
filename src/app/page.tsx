'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import MapPanel from '@/components/ignis/MapPanel';
import CalendarPanel from '@/components/ignis/CalendarPanel';
import SensorPanel from '@/components/ignis/SensorPanel';
import AlertsPanel from '@/components/ignis/AlertsPanel';
import OutlookPanel from '@/components/ignis/OutlookPanel';
import StatusRail from '@/components/ignis/StatusRail';
import TimeSeriesPanel from '@/components/ignis/TimeSeriesPanel';
import RegimePanel from '@/components/ignis/RegimePanel';
import FireWeatherPanel from '@/components/ignis/FireWeatherPanel';
import OpenSciencePanel from '@/components/ignis/OpenSciencePanel';
import MethodologyPanel from '@/components/ignis/MethodologyPanel';
import SegmentationPanel from '@/components/ignis/SegmentationPanel';
import DynamicsPanel from '@/components/ignis/DynamicsPanel';
import AiAnalyst from '@/components/ignis/AiAnalyst';
import { REGIONS, BD_AOIS, BD_SEASON } from '@/lib/ignis/regions';
import { segmentFires, trackPersistence } from '@/lib/ignis/segmentation';
import { forecastNextFootprint, type ForecastField } from '@/lib/ignis/forecast';
import { buildUnified, buildClimatology, latestAnomalies, harmonicForecast, forecastPeak, regimeFeatures, classifyRegime, theilSen, changePoints, fmtNum, ymLabel, MONTH_LABELS } from '@/lib/ignis/analytics';
import { fetchFireWeather, type FireWeather } from '@/lib/ignis/fireweather';
import type { CalendarDoc, EonetRanked, Health, MultiHotspots, OutlookDoc } from '@/lib/ignis/types';

function yesterdayStr(): string {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

const BD_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BD_SEASON_CLS = [
  '',
  'bg-amber-500/25 text-amber-300',
  'bg-orange-500/35 text-orange-200',
  'bg-red-500/45 text-red-200',
];

type GeoResult = { name: string; lat: number; lon: number; bbox: number[] | null; kind: string };

export default function Home() {
  const [regionKey, setRegionKey] = useState('amazon');
  const [customBbox, setCustomBbox] = useState<number[] | null>(null);
  const [customLabel, setCustomLabel] = useState<string | null>(null);
  const [day, setDay] = useState(yesterdayStr());
  const [animDays, setAnimDays] = useState(1);
  const [pickMode, setPickMode] = useState(false);
  const [multi, setMulti] = useState<MultiHotspots | null>(null);
  const [hotLoading, setHotLoading] = useState(true);
  const [calendar, setCalendar] = useState<CalendarDoc | null>(null);
  const [calLoading, setCalLoading] = useState(true);
  const [outlook, setOutlook] = useState<OutlookDoc | null>(null);
  const [eonet, setEonet] = useState<{ ranked: EonetRanked[]; model?: string } | null>(null);
  const [eonetLoading, setEonetLoading] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);
  const [tab, setTab] = useState<'calendar' | 'timeseries' | 'clusters' | 'dynamics' | 'outlook' | 'regime' | 'method' | 'opensci'>('calendar');
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSeed, setAiSeed] = useState<string | null>(null);
  const [geoQ, setGeoQ] = useState('');
  const [geoResults, setGeoResults] = useState<GeoResult[]>([]);
  const [geoBusy, setGeoBusy] = useState(false);
  const [fw, setFw] = useState<FireWeather | null>(null);
  const [fwLoading, setFwLoading] = useState(true);
  const [fwError, setFwError] = useState<string | null>(null);

  const region = useMemo(() => REGIONS.find((r) => r.key === regionKey) || REGIONS[0], [regionKey]);
  const bbox = customBbox ?? region.bbox;
  const regionName = customLabel ?? region.name;

  // ---- analytics over the harmonized calendar ----
  const analytics = useMemo(() => {
    if (!calendar) return null;
    const u = buildUnified(calendar);
    const clim = buildClimatology(u.rows);
    const anomalies = latestAnomalies(u.rows, clim, 3);
    const f = harmonicForecast(u.rows, 12);
    const peak = forecastPeak(f.points);
    const fv = regimeFeatures(calendar, u.rows);
    const regime = fv ? classifyRegime(fv) : null;
    const ts = theilSen(u.rows.map((r) => r.count));
    const cps = changePoints(u.rows);
    return { rows: u.rows, meta: u.meta, clim, anomalies, forecast: f.points, r2: f.r2, peak, regime, slopePerDecade: ts.slope * 12, changePoints: cps };
  }, [calendar]);

  // ---- health ----
  useEffect(() => {
    let alive = true;
    (async () => {
      const h = await fetch('/api/health').then((r) => r.json()).catch(() => null);
      if (alive && h) setHealth(h);
    })();
    const t = setInterval(() => {
      fetch('/api/health').then((r) => r.json()).then((h) => { if (alive) setHealth(h); }).catch(() => {});
    }, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // ---- hotspots (window = animDays ending at `day`) ----
  useEffect(() => {
    let alive = true;
    (async () => {
      setHotLoading(true);
      setMulti(null); // clear stale window immediately on AOI/day change
      const [w, s, e, n] = bbox;
      const d = await fetch(`/api/hotspots?w=${w}&s=${s}&e=${e}&n=${n}&day=${day}&days=${animDays}`).then((r) => r.json()).catch(() => null);
      if (alive) {
        setMulti(d && !d.error ? d : null);
        setHotLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [bbox, day, animDays]);

  // ---- calendar + outlook + eonet per region ----
  useEffect(() => {
    let alive = true;
    (async () => {
      setCalLoading(true);
      const d = await fetch(`/api/calendar?region=${regionKey}`).then((r) => r.json()).catch(() => null);
      if (!alive) return;
      setCalendar(d && !d.status ? d : null);
      setCalLoading(false);
      const o = await fetch(`/api/outlook?region=${regionKey}`).then((r) => r.json()).catch(() => null);
      if (alive) setOutlook(o && !o.status ? o : null);
      setEonetLoading(true);
      const ev = await fetch(`/api/eonet?region=${regionKey}`).then((r) => r.json()).catch(() => null);
      if (alive) {
        setEonet(ev && ev.ranked ? ev : { ranked: [] });
        setEonetLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [regionKey]);

  // ---- fire weather (client-direct Open-Meteo) ----
  const center = useMemo<[number, number]>(() => [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], [bbox]);
  useEffect(() => {
    let alive = true;
    fetchFireWeather(center[0], center[1])
      .then((f) => { if (alive) { setFw(f); setFwError(null); setFwLoading(false); } })
      .catch((e: Error) => { if (alive) { setFw(null); setFwError(e.message); setFwLoading(false); } });
    return () => { alive = false; };
  }, [center]);

  // ---- geocode ----
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      if (geoQ.trim().length < 3) {
        if (!cancelled) { setGeoResults([]); setGeoBusy(false); }
        return;
      }
      setGeoBusy(true);
      const d = await fetch(`/api/geocode?q=${encodeURIComponent(geoQ)}`).then((r) => r.json()).catch(() => null);
      if (!cancelled) setGeoResults((d?.results || []).slice(0, 5));
      setGeoBusy(false);
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [geoQ]);

  const onPick = useCallback((b: number[]) => {
    setCustomBbox(b);
    setCustomLabel(null);
    setPickMode(false);
  }, []);

  const onPickDate = useCallback((ym: string) => {
    setDay(`${ym}-08`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const onNavigate = useCallback((r?: string, d?: string) => {
    if (r && REGIONS.some((x) => x.key === r)) { setRegionKey(r); setCustomBbox(null); setCustomLabel(null); }
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDay(d);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const onAskAi = useCallback((q: string) => {
    setAiSeed(q);
    setAiOpen(true);
  }, []);

  const hot = multi?.days[day] ?? (multi ? multi.days[Object.keys(multi.days).at(-1) ?? ''] ?? null : null);
  const liveTotal = hot ? Object.values(hot.sensors).reduce((a, s) => a + s.count, 0) : 0;
  const liveFrp = hot ? Object.values(hot.sensors).reduce((a, s) => a + s.points.reduce((x, p) => x + (p.frp || 0), 0), 0) : 0;
  const latestA = analytics?.anomalies.at(-1);

  // ---- segmentation: clusters + boundaries (computed once, shared by map + lab panel + AI) ----
  const seg = useMemo(() => (hot ? segmentFires(bbox, hot.sensors) : null), [hot, bbox]);
  const tracks = useMemo(() => {
    if (!multi || Object.keys(multi.days).length < 3) return [];
    const daily = Object.entries(multi.days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, h]) => ({ day: d, clusters: segmentFires(bbox, h.sensors).clusters }));
    return trackPersistence(daily);
  }, [multi, bbox]);
  const persistent = useMemo(() => tracks.filter((t) => t.daysSeen >= 2).slice(0, 8), [tracks]);

  // ML next-day footprint forecast (ignis-fire-footprint-forecaster, on-demand compute)
  const [showForecast, setShowForecast] = useState(false);
  const [forecast, setForecast] = useState<ForecastField | null>(null);
  const [forecastBusy, setForecastBusy] = useState(false);
  useEffect(() => {
    if (!showForecast || !multi) return; // usage sites derive the null case at render
    let cancelled = false;
    // busy flag + heavy compute are deferred to timeouts (async) so no state is
    // set synchronously inside the effect body (react-hooks/set-state-in-effect)
    const t1 = setTimeout(() => { if (!cancelled) setForecastBusy(true); }, 0);
    const t2 = setTimeout(() => {
      if (cancelled) return;
      setForecast(forecastNextFootprint(multi, bbox, regionKey));
      setForecastBusy(false);
    }, 60);
    return () => { cancelled = true; clearTimeout(t1); clearTimeout(t2); };
  }, [showForecast, multi, bbox, regionKey]);


  const aiContext = useMemo(() => {
    const hot = multi?.days[day] ?? multi?.days[Object.keys(multi?.days || {})[0]] ?? null;
    const total = hot ? Object.values(hot.sensors).reduce((a, s) => a + s.count, 0) : 0;
    const frp = hot ? Object.values(hot.sensors).reduce((a, s) => a + s.points.reduce((x, p) => x + (p.frp || 0), 0), 0) : 0;
    return {
      regionName, regionKey, day, bbox,
      dataSource: hot?.source, pipelineNote: hot?.note,
      totalDetections: total, totalFrpMW: Math.round(frp),
      perSensor: hot ? Object.fromEntries(Object.entries(hot.sensors).map(([k, s]) => [k, { count: s.count, meanFrp: s.meanFrp, maxFrp: s.maxFrp, hiConfPct: s.count ? Math.round((s.hiConf / s.count) * 100) : 0, nightPct: s.nightPct }])) : {},
      harmonization: analytics ? { continuityRatio: analytics.meta.ratioCount, overlapMonths: analytics.meta.overlapMonths, ratioCV: analytics.meta.ratioCV } : null,
      peakMonth: analytics ? MONTH_LABELS[analytics.clim.peakMonth] : null,
      peakWindow: analytics ? analytics.clim.peakWindow.map((i) => MONTH_LABELS[i]) : [],
      latestMonths: analytics?.anomalies.map((a) => ({ ym: a.ym, detections: a.count, z: a.z })) ?? [],
      latestZ: analytics?.anomalies.at(-1)?.z ?? null,
      trendPerDecade: analytics ? Math.round(analytics.slopePerDecade) : null,
      changePoints: analytics?.changePoints ?? [],
      forecast: analytics?.forecast.slice(0, 6).map((f) => ({ ym: f.ym, mean: f.mean })) ?? [],
      forecastPeak: analytics?.peak ? { ym: analytics.peak.ym, mean: analytics.peak.mean } : null,
      regime: analytics?.regime ? { label: analytics.regime.top.label, similarity: analytics.regime.top.similarity, note: analytics.regime.top.note } : null,
      fireWeather: fw ? { peakDay: fw.peak.date, peakScore: fw.peak.score, verdict: fw.verdict.label, advice: fw.verdict.advice } : null,
      eonetTop: (eonet?.ranked || []).slice(0, 3).map((e) => e.title),
      segmentation: seg ? {
        method: `DBSCAN ε=${seg.epsDeg}° minPts=${seg.minPts} + convex-hull boundaries (in-browser, deterministic)`,
        clusters: seg.clusters.length,
        classes: Object.fromEntries(['MEGAFIRE', 'ESTABLISHED', 'EMERGING', 'SCATTERED'].map((c) => [c, seg.clusters.filter((x) => x.cls === c).length])),
        clusteredPct: Math.round(seg.clusteredPct),
        topClusters: seg.topByFrp.slice(0, 5).map((c) => ({ id: c.id, cls: c.cls, n: c.n, frpSum: Math.round(c.frpSum), spreadKm: c.spreadKm, areaKm2: c.areaKm2, elongation: c.elongation, nightPct: Math.round(c.nightPct), sensors: Object.keys(c.sensors) })),
        persistentSystems: persistent.map((t) => ({ id: t.id, days: t.daysSeen, first: t.firstDay, last: t.lastDay, peakFrp: Math.round(t.peakFrp), trend: t.frpTrend > 0.25 ? 'growing' : t.frpTrend < -0.25 ? 'decaying' : 'steady' })),
      } : null,
    };
  }, [multi, day, regionName, regionKey, bbox, analytics, fw, eonet, seg, persistent]);

  return (
    <main className="min-h-screen bg-[#050A14] text-slate-200">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-[#13253D] bg-[#060D1A]/92 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
          <div>
            <h1 className="text-lg font-bold tracking-[0.18em] text-slate-100">
              IGNIS<span className="text-[#F97316]">·</span><span className="text-[#38BDF8]">FIRE</span> CALENDAR
            </h1>
            <p className="text-[10px] text-slate-400">One 26-year burning-activity record from NASA&apos;s split MODIS + VIIRS hot-spot archive — early warning for responders</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
            <span className="rounded-full border border-[#1E3A5F] px-2 py-1">NASA Space Apps 2026 · Harmonization of MODIS &amp; VIIRS Hot Spots</span>
            <span className="rounded-full border border-[#1E3A5F] px-2 py-1">FIRMS · GIBS · EONET · HF</span>
            <button onClick={() => setAiOpen(true)}
              className="rounded-full bg-gradient-to-r from-orange-500 to-amber-400 px-3 py-1.5 text-[10.5px] font-bold text-slate-950 transition-transform hover:scale-105">
              ✦ AI Analyst
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] space-y-4 px-4 py-4">
        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-3">
            <div className="text-[9.5px] uppercase tracking-widest text-slate-500">Live detections · {day}</div>
            <div className="font-mono text-xl font-bold text-orange-300">{hotLoading ? '…' : liveTotal.toLocaleString()}</div>
            <div className="text-[9.5px] text-slate-500">{hot?.source === 'firms-api' ? 'FIRMS live NRT' : hot?.source === 'mixed' ? 'FIRMS + GIBS fallback' : 'GIBS vector fallback'}</div>
          </div>
          <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-3">
            <div className="text-[9.5px] uppercase tracking-widest text-slate-500">Total FRP in AOI</div>
            <div className="font-mono text-xl font-bold text-amber-300">{hotLoading ? '…' : `${fmtNum(liveFrp)} MW`}</div>
            <div className="text-[9.5px] text-slate-500">fire radiative power, all sensors</div>
          </div>
          <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-3">
            <div className="text-[9.5px] uppercase tracking-widest text-slate-500">Climatological peak</div>
            <div className="text-xl font-bold text-slate-100">{analytics ? MONTH_LABELS[analytics.clim.peakMonth] : '—'}</div>
            <div className="text-[9.5px] text-slate-500">{analytics ? `window: ${analytics.clim.peakWindow.map((i) => MONTH_LABELS[i]).join('–')}` : '—'}</div>
          </div>
          <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-3">
            <div className="text-[9.5px] uppercase tracking-widest text-slate-500">Latest month vs normal</div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xl font-bold text-slate-100">{latestA ? fmtNum(latestA.count) : '—'}</span>
              {latestA && (
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${Math.abs(latestA.z) >= 2 ? 'bg-cyan-500/25 text-cyan-300' : 'bg-[#13253D] text-slate-400'}`}>
                  z {latestA.z > 0 ? '+' : ''}{latestA.z}
                </span>
              )}
            </div>
            <div className="text-[9.5px] text-slate-500">{latestA ? `${ymLabel(latestA.ym)} · |z|≥2 = unusual` : '—'}</div>
          </div>
          <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-3">
            <div className="text-[9.5px] uppercase tracking-widest text-slate-500">Forecast peak (12 mo)</div>
            <div className="text-xl font-bold text-orange-200">{analytics?.peak ? ymLabel(analytics.peak.ym) : '—'}</div>
            <div className="text-[9.5px] text-slate-500">{analytics?.peak ? `~${fmtNum(analytics.peak.mean)} detections · R² ${analytics.r2}` : '—'}</div>
          </div>
          <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/70 p-3">
            <div className="text-[9.5px] uppercase tracking-widest text-slate-500">Burn regime</div>
            <div className="truncate text-[13px] font-bold text-slate-100" title={analytics?.regime?.top.note}>{analytics?.regime?.top.label ?? '—'}</div>
            <div className="text-[9.5px] text-slate-500">{analytics?.regime ? `${Math.round(analytics.regime.top.similarity * 100)}% prototype match` : '—'}</div>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#14273F] bg-[#0A1423]/50 p-2.5">
          {REGIONS.map((r) => {
            const active = regionKey === r.key && !customBbox;
            const bd = r.key === 'bangladesh';
            return (
              <button key={r.key} onClick={() => { setRegionKey(r.key); setCustomBbox(null); setCustomLabel(null); }}
                title={r.note}
                className={`rounded-full border px-3 py-1.5 text-[11px] transition-colors ${
                  active
                    ? bd ? 'border-emerald-400 bg-emerald-400/15 text-emerald-200' : 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#7DD3FC]'
                    : bd ? 'border-emerald-500/50 text-emerald-300/80 hover:border-emerald-400' : 'border-[#1E3A5F] text-slate-400 hover:border-[#38BDF8]/50'
                }`}>
                {bd ? '🇧🇩 ' : ''}{r.name}
              </button>
            );
          })}
          {customBbox && (
            <button onClick={() => { setCustomBbox(null); setCustomLabel(null); }} className="rounded-full border border-[#F97316] bg-[#F97316]/15 px-3 py-1.5 text-[11px] text-orange-300">
              {customLabel || 'CUSTOM AOI'} ×
            </button>
          )}
          <button onClick={() => setPickMode((p) => !p)}
            className={`rounded-full border px-3 py-1.5 text-[11px] ${pickMode ? 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#7DD3FC]' : 'border-[#1E3A5F] text-slate-400 hover:border-[#38BDF8]/50'}`}>
            ⌖ Pick AOI
          </button>
          <div className="relative">
            <input
              value={geoQ}
              onChange={(e) => setGeoQ(e.target.value)}
              placeholder="Search any place on Earth…"
              className="w-52 rounded-full border border-[#1E3A5F] bg-[#0A1423] px-3 py-1.5 text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-[#38BDF8]"
            />
            {(geoQ.trim().length >= 3 && (geoResults.length > 0 || geoBusy)) && (
              <div className="absolute left-0 top-9 z-30 w-72 overflow-hidden rounded-lg border border-[#1E3A5F] bg-[#060D1A] shadow-2xl">
                {geoBusy && <div className="px-3 py-2 text-[11px] text-slate-500">searching…</div>}
                {geoResults.map((g) => (
                  <button key={g.name} onClick={() => {
                    const bb = g.bbox && Math.abs(g.bbox[2] - g.bbox[0]) < 25 && Math.abs(g.bbox[3] - g.bbox[1]) < 25
                      ? g.bbox
                      : [g.lon - 2.25, g.lat - 2, g.lon + 2.25, g.lat + 2];
                    setCustomBbox(bb);
                    setCustomLabel(g.name.split(',').slice(0, 2).join(','));
                    setGeoResults([]);
                    setGeoQ('');
                  }} className="block w-full px-3 py-2 text-left text-[11px] text-slate-300 hover:bg-[#0C1A2E]">
                    📍 {g.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <button onClick={() => setAnimDays(animDays === 7 ? 1 : 7)}
              className={`rounded-full border px-3 py-1.5 text-[11px] ${animDays === 7 ? 'border-orange-400 bg-orange-500/15 text-orange-300' : 'border-[#1E3A5F] text-slate-400 hover:border-[#38BDF8]/50'}`}>
              {animDays === 7 ? '⏮ 7-day window ON' : '⏮ Load 7-day window'}
            </button>
            <label htmlFor="day">Detection date</label>
            <input id="day" type="date" value={day} max={yesterdayStr()} min="2000-11-01" onChange={(e) => setDay(e.target.value)} suppressHydrationWarning
              className="rounded border border-[#1E3A5F] bg-[#0A1423] px-2 py-1 text-[11px] text-slate-200" />
          </div>
        </div>

        {/* Bangladesh spotlight — team home region */}
        {regionKey === 'bangladesh' && (
          <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-r from-emerald-950/40 via-[#0A1423]/70 to-[#0A1423]/70 p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="text-sm font-bold tracking-wide text-emerald-200">🇧🇩 BANGLADESH FIRE SEASON SPOTLIGHT</h3>
              <span className="rounded-full border border-emerald-500/50 px-2 py-0.5 text-[9.5px] text-emerald-300">home region of Team IGNIS</span>
              <span className="text-[10.5px] text-slate-400">Boro rice-residue burning peaks <b className="text-orange-300">Mar–Apr</b> · Aman residue <b className="text-orange-300">Nov</b> · monsoon lull <b className="text-cyan-300">Jun–Sep</b> · Sundarbans dry-season fires <b className="text-orange-300">Jan–May</b></span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
              <div>
                <div className="mb-1 text-[9.5px] uppercase tracking-widest text-slate-500">Seasonal calendar (relative intensity)</div>
                <div className="flex gap-1">
                  {BD_MONTHS.map((m, i) => (
                    <div key={m} className="w-9 text-center">
                      <div className={`rounded py-1.5 text-[10px] font-bold ${BD_SEASON_CLS[BD_SEASON[i]] || 'bg-[#13253D] text-slate-500'}`}>{m}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {BD_AOIS.map((a) => (
                  <button key={a.key} title={a.note}
                    onClick={() => {
                      if (a.key === 'bd_full') { setCustomBbox(null); setCustomLabel(null); }
                      else { setCustomBbox(a.bbox); setCustomLabel(`🇧🇩 ${a.name}`); }
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className={`rounded-full border px-3 py-1.5 text-[11px] transition-colors ${a.key === 'bd_full' ? 'border-emerald-400/70 bg-emerald-400/10 text-emerald-200' : 'border-[#1E3A5F] text-slate-300 hover:border-emerald-400/70 hover:text-emerald-200'}`}>
                    {a.name}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-slate-500">
              The same harmonized pipeline runs here end-to-end: a 26-year MODIS+VIIRS calendar for the country, live FIRMS NRT detections for any sub-region, fire-weather early warning from Open-Meteo, and GIBS LST/fire-pixel overlays — the dataset IGNIS was built for, applied at home where crop-residue smoke is a leading driver of Dhaka&apos;s winter air-quality crisis.
            </p>
          </div>
        )}

        {/* Map + right column */}
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3" style={{ height: 'clamp(600px, calc(100vh - 275px), 880px)' }}>
            <MapPanel
              bbox={bbox}
              regionKey={regionKey}
              day={day}
              hotspots={hot}
              multiDay={multi}
              pickMode={pickMode}
              onPick={onPick}
              eonet={eonet?.ranked ?? []}
              onAskAi={onAskAi}
              seg={seg}
              forecast={showForecast ? forecast : null}
              forecastLoading={showForecast && forecastBusy}
              onToggleForecast={() => setShowForecast((v) => !v)}
            />
          </div>
          <div className="space-y-4 lg:col-span-2">
            <AlertsPanel hotspots={hot} eonet={eonet} loading={eonetLoading} />
            <FireWeatherPanel fw={fw} loading={fwLoading} error={fwError} name={regionName} />
            <SensorPanel hotspots={hot} harmonization={calendar?.harmonization ?? null} />
          </div>
        </div>

        {/* Analytics tabs */}
        <div className="rounded-xl border border-[#14273F] bg-[#0A1423]/40 p-1.5">
          <div className="flex flex-wrap gap-1 px-1 pt-1">
            {([['calendar', '🔥 Burning Calendar'], ['clusters', '🧪 Fire Cluster Lab'], ['dynamics', '📊 Daily Dynamics'], ['timeseries', '📈 Time-Series Lab'], ['outlook', '🔭 Seasonal Outlook'], ['regime', '🧭 Burn Regime'], ['method', '🔬 Methodology & Data'], ['opensci', '🤗 Open Science']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`rounded-lg px-3 py-2 text-[11.5px] transition-colors ${tab === k ? 'bg-[#13253D] text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="p-2 pt-3">
            {tab === 'calendar' && <CalendarPanel doc={calendar} loading={calLoading} onPickDate={onPickDate} />}
            {tab === 'clusters' && <SegmentationPanel hotspots={hot} multiDay={multi} seg={seg} tracks={tracks} regionName={regionName} day={day} calendar={calendar} onAskAi={onAskAi} />}
            {tab === 'dynamics' && <DynamicsPanel multiDay={multi} day={day} regionName={regionName} onAskAi={onAskAi} forecast={showForecast ? forecast : null} forecastOn={showForecast} onToggleForecast={() => setShowForecast((v) => !v)} />}
            {tab === 'timeseries' && <TimeSeriesPanel doc={calendar} />}
            {tab === 'outlook' && <OutlookPanel doc={outlook} calendar={calendar} />}
            {tab === 'regime' && <RegimePanel doc={calendar} />}
            {tab === 'method' && <MethodologyPanel bbox={bbox} day={day} doc={calendar} hotspots={hot} />}
            {tab === 'opensci' && <OpenSciencePanel />}
          </div>
        </div>

        {/* Status rail + pipeline */}
        <div className="space-y-2">
          <StatusRail health={health} />
          <div className="rounded-lg border border-[#14273F] bg-[#0A1423]/70 p-3 text-[10.5px] leading-relaxed text-slate-400">
            <span className="text-slate-200">Data pipeline:</span> NASA FIRMS area API (primary — MODIS Terra/Aqua C6.1 + VIIRS S-NPP/NOAA-20/NOAA-21 V2, MAP_KEY authenticated) → NASA GIBS WMTS vector tiles (independent fallback, archive to Nov 2000) · GIBS daily true-color &amp; 7-2-1 imagery basemaps · EONET v3 event triage · Open-Meteo fire weather ·
            Hugging Face: <span className="text-cyan-300">all-MiniLM-L6-v2</span> on-device semantic triage + <span className="text-cyan-300">Llama-3.1-8B-Instruct</span> grounded analyst with deterministic rule-engine fallback. Earthdata Login JWT for CMR/ASF. No chat-LLM dependency — every AI feature is API-first and automation-friendly.
          </div>
        </div>
      </div>

      <footer className="border-t border-[#13253D] bg-[#060D1A]/90 py-3">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-1 px-4 text-[10.5px] text-slate-500">
          <span>IGNIS — built for NASA Space Apps Challenge 2026 · Challenge #9: Harmonization of MODIS &amp; VIIRS Hot Spots</span>
          <a href="https://github.com/Hisernberg/ignis-spaceapps2026" target="_blank" rel="noreferrer" className="text-[#7DD3FC] hover:underline">GitHub ↗</a>
          <a href="https://ignis-spaceapps2026.vercel.app" target="_blank" rel="noreferrer" className="text-[#7DD3FC] hover:underline">Live deployment ↗</a>
          <span className="ml-auto">Data: NASA FIRMS/LANCE · GIBS · EONET · Earthdata · Open-Meteo · OSM Nominatim</span>
        </div>
      </footer>

      <AiAnalyst
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        context={aiContext}
        seedQuestion={aiSeed}
        onSeedConsumed={() => setAiSeed(null)}
        onNavigate={onNavigate}
      />
    </main>
  );
}
