// 7-day fire-weather early warning — client-direct call to Open-Meteo (free, no key, CORS-enabled).
// Composite danger score is a transparent, documented blend of the four drivers of ignition
// and spread (no black-box): temperature, relative humidity deficit, wind, and antecedent dryness.
import type { FireWeather, FireWeatherDay } from './types';

export type { FireWeather, FireWeatherDay };

type OM = {
  daily?: {
    time: string[];
    temperature_2m_max: number[];
    relative_humidity_2m_mean: number[];
    wind_speed_10m_max: number[];
    precipitation_sum: number[];
  };
  error?: boolean;
  reason?: string;
};

function clamp(v: number, lo = 0, hi = 1): number { return Math.min(hi, Math.max(lo, v)); }

export function scoreDay(tmax: number, rh: number, wind: number, precip3: number): number {
  const tempT = clamp((tmax - 10) / 32); // 10 °C -> 0, 42 °C -> 1
  const rhT = clamp((88 - rh) / 70); // 88 % -> 0, 18 % -> 1
  const windT = clamp((wind - 8) / 45); // <=8 km/h calm, 53 km/h -> 1
  const dryT = clamp(1 - precip3 / 12); // 12 mm over 3 days saturates
  return Math.round(100 * (0.34 * tempT + 0.24 * rhT + 0.16 * windT + 0.26 * dryT));
}

function verdict(score: number): { label: string; color: string; advice: string } {
  if (score >= 78) return { label: 'EXTREME', color: '#DC2626', advice: 'Any ignition will spread fast — pre-position resources, elevate public alerts.' };
  if (score >= 62) return { label: 'HIGH', color: '#EA580C', advice: 'Critical burning conditions — restrict ignitions, patrol infrastructure.' };
  if (score >= 45) return { label: 'ELEVATED', color: '#F59E0B', advice: 'Fires may escape if ignited — monitor FIRMS hotspots closely.' };
  if (score >= 28) return { label: 'MODERATE', color: '#FACC15', advice: 'Typical burning conditions; normal vigilance.' };
  return { label: 'LOW', color: '#22C55E', advice: 'Moist and cool — low ignition potential.' };
}

export async function fetchFireWeather(lat: number, lon: number): Promise<FireWeather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&daily=temperature_2m_max,relative_humidity_2m_mean,wind_speed_10m_max,precipitation_sum&forecast_days=7&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const j = (await res.json()) as OM;
  if (j.error || !j.daily) throw new Error(j.reason || 'Open-Meteo unavailable');
  const d = j.daily;
  const days: FireWeatherDay[] = d.time.map((date, i) => {
    const precip3 = (d.precipitation_sum.slice(Math.max(0, i - 2), i + 1) as number[]).reduce((a, b) => a + (b || 0), 0);
    return {
      date,
      tmax: Math.round(d.temperature_2m_max[i]),
      rh: Math.round(d.relative_humidity_2m_mean[i]),
      wind: Math.round(d.wind_speed_10m_max[i]),
      precip: +(d.precipitation_sum[i] || 0).toFixed(1),
      score: scoreDay(d.temperature_2m_max[i], d.relative_humidity_2m_mean[i], d.wind_speed_10m_max[i], precip3),
    };
  });
  const peak = days.reduce((a, b) => (b.score > a.score ? b : a), days[0]);
  return { lat, lon, days, peak, verdict: verdict(peak.score) };
}
