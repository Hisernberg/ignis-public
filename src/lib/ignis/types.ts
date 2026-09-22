export type FirePoint = { lat: number; lon: number; frp: number; conf: number | null; confRaw?: string; night: boolean; sat?: string; date?: string; acq?: string; beh?: string; behP?: number };
export type SensorHotspots = { points: FirePoint[]; count: number; meanFrp: number; maxFrp: number; hiConf: number; nightPct: number; source: string; dayUsed: string; clamped?: boolean };
export type HotspotsResult = { source: string; day: string; sensors: Record<string, SensorHotspots>; note?: string };
export type MultiHotspots = { source: string; days: Record<string, HotspotsResult>; note?: string };

export type MonthRow = { ym: string; sampled: number; days: number; est: number; frp: number; meanFrp: number; hiConf: number; night: number };
export type CalendarDoc = {
  region: string; name: string; note: string; bbox: number[];
  sensors: Record<string, { layer: string; tms: string; monthly: MonthRow[] }>;
  harmonization: { overlapMonths: number; meanRatioSNPPtoMODIS: number | null; sample: { ym: string; ratio: number; m: number; s: number }[] };
  meta: { method: string; source: string; generated: string };
};
export type OutlookDoc = {
  region: string; model: string; method: string; generated: string;
  history: { ym: string; est: number }[];
  forecast: { ym: string; mean: number; lo: number; hi: number }[];
  peakMonths: string[];
};

export type EonetRanked = {
  id: string; title: string; date: string; lon: number | null; lat: number | null; link: string;
  geoScore: number; semanticScore: number | null; relevance: number;
};

export type HealthEntry = { service: string; ok: boolean; reason?: string; keySource?: string; [k: string]: unknown };
export type Health = {
  firms: HealthEntry; nasa: HealthEntry; gibs: HealthEntry; eonet: HealthEntry;
  hf: HealthEntry; openmeteo: HealthEntry;
  edl: { service: string; configured: boolean; ok?: boolean; uid?: string; exp?: number; expired?: boolean; daysLeft?: number; reason?: string };
  checkedAt: string;
};

// ---- analytics ----
export type UnifiedRow = { ym: string; count: number; frp: number; scaled: boolean };
export type Climatology = { mean: number[]; std: number[]; peakMonth: number; peakWindow: number[] };
export type ForecastPoint = { ym: string; mean: number; lo: number; hi: number };
export type RegimeMatch = { key: string; label: string; similarity: number; note: string };
export type RegimeResult = { top: RegimeMatch; runners: RegimeMatch[]; features: { name: string; value: number; unit: string; matchValue: number }[]; summary: string };
export type RegimeFeatureVec = {
  peakMonth: number; seasonality: number; interannualCV: number;
  nightFraction: number; meanFrp: number; logMedianCount: number;
};

export type FireWeatherDay = { date: string; score: number; tmax: number; rh: number; wind: number; precip: number };
export type FireWeather = {
  lat: number; lon: number; days: FireWeatherDay[];
  verdict: { label: string; color: string; advice: string };
  peak: FireWeatherDay;
  error?: string;
};

export type AnalystMsg = { role: 'user' | 'assistant'; content: string; model?: string; fallback?: boolean };
