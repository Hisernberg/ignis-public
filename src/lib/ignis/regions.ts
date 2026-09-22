export type Region = { key: string; name: string; bbox: [number, number, number, number]; note: string };

// Keep in sync with scripts/ignis/build_calendar.mjs
export const REGIONS: Region[] = [
  { key: 'amazon', name: 'Amazon Basin', bbox: [-74, -12, -46, 2], note: 'Deforestation & drought-driven fire regime' },
  { key: 'california', name: 'California / US West', bbox: [-125, 32, -114, 42], note: 'Mediterranean chaparral + forest fire regime' },
  { key: 'canada', name: 'Boreal Canada', bbox: [-140, 52, -95, 70], note: 'Record 2023 fire season (23+ Mha burned)' },
  { key: 'siberia', name: 'Eastern Siberia', bbox: [100, 50, 145, 70], note: 'Boreal + permafrost peat fires (Yakutia)' },
  { key: 'congo', name: 'Congo Basin', bbox: [8, -8, 32, 8], note: 'Tropical evergreen + savanna boundary' },
  { key: 'borneo', name: 'Borneo & Sumatra', bbox: [95, -6, 120, 6], note: 'El Niño peat-land megafires (2015, 2019, 2023)' },
  { key: 'australia', name: 'Australia', bbox: [112, -42, 154, -10], note: 'Black Summer 2019-20 (24+ Mha burned)' },
  { key: 'mediterranean', name: 'Mediterranean Basin', bbox: [-8, 30, 32, 46], note: 'European heatwave-driven fires (2021-2025)' },
  { key: 'bangladesh', name: 'Bangladesh', bbox: [88.0, 20.6, 92.9, 26.7], note: 'Crop-residue (Boro Mar–Apr, Aman Nov) + Sundarbans mangrove fires' },
];

// ---- Bangladesh spotlight: sub-AOIs + fire-season calendar (team home region) ----
export type BdAoi = { key: string; name: string; bbox: [number, number, number, number]; note: string };
export const BD_AOIS: BdAoi[] = [
  { key: 'bd_full', name: 'All Bangladesh', bbox: [88.0, 20.6, 92.9, 26.7], note: 'Whole country — harmonized MODIS+VIIRS record since Nov 2000' },
  { key: 'sundarbans', name: 'Sundarbans', bbox: [88.0, 21.5, 89.9, 22.9], note: 'UNESCO mangrove, last Bengal tiger habitat — dry-season fires Jan–May' },
  { key: 'rajshahi', name: 'Rajshahi crop belt', bbox: [88.0, 24.0, 89.8, 25.6], note: 'Boro rice-residue burning peaks Mar–Apr' },
  { key: 'dhaka', name: 'Dhaka–Gazipur', bbox: [90.0, 23.6, 90.9, 24.4], note: 'Landfill & settlement fires around the capital' },
  { key: 'chattogram', name: 'Chattogram–Cox\u2019s Bazar', bbox: [91.5, 20.7, 92.7, 22.8], note: 'Hill-forest fires and camp settlements' },
  { key: 'sylhet', name: 'Sylhet hills', bbox: [91.3, 23.9, 92.7, 25.4], note: 'Tea-garden & evergreen forest fires' },
];
// relative seasonal intensity Jan..Dec (Boro residue Mar–Apr peak; Aman residue Nov; monsoon low Jun–Sep)
export const BD_SEASON: number[] = [2, 2, 3, 3, 2, 0, 0, 0, 0, 1, 2, 2];

export const SENSOR_COLORS: Record<string, string> = {
  'MODIS-Terra': '#F97316',
  'MODIS-Aqua': '#FB7185',
  'VIIRS-SNPP': '#38BDF8',
  'VIIRS-NOAA20': '#E879F9',
  'VIIRS-NOAA21': '#A3E635',
};

export const SENSOR_INFO: Record<string, { res: string; start: string; orbit: string }> = {
  'MODIS-Terra': { res: '1 km', start: '2000-02', orbit: 'Terra · ~10:30 local descent' },
  'MODIS-Aqua': { res: '1 km', start: '2002-07', orbit: 'Aqua · ~13:30 local ascent' },
  'VIIRS-SNPP': { res: '375 m', start: '2012-01', orbit: 'Suomi NPP · ~13:30' },
  'VIIRS-NOAA20': { res: '375 m', start: '2018-01', orbit: 'NOAA-20 (JPSS-1) · ~13:30' },
  'VIIRS-NOAA21': { res: '375 m', start: '2023-02', orbit: 'NOAA-21 (JPSS-2) · ~13:30' },
};

// Latest GIBS vector coverage observed via WMTS Capabilities + tile probes (2026-09-21)
export const GIBS_LATEST: Record<string, string> = {
  'MODIS-Terra': '2026-09-20',
  'MODIS-Aqua': '2026-09-19',
  'VIIRS-SNPP': '2026-07-16',
  'VIIRS-NOAA20': '2025-12-23',
  'VIIRS-NOAA21': '2026-09-19',
};

// ---- GIBS raster layer registry (epsg3857 / GoogleMapsCompatible) ----
export type GibsRaster = { id: string; fmt: 'jpg' | 'png'; level: number; label: string; daily: boolean; note?: string };

export const GIBS_BASEMAPS: Record<string, GibsRaster> = {
  truecolor_modis_terra: { id: 'MODIS_Terra_CorrectedReflectance_TrueColor', fmt: 'jpg', level: 9, label: 'MODIS Terra · True Color (daily)', daily: true, note: '1 km corrected reflectance — the classic daily global view' },
  truecolor_viirs_snpp: { id: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', fmt: 'jpg', level: 9, label: 'VIIRS S-NPP · True Color (daily)', daily: true, note: '375 m imagery, sharper smoke plumes' },
  bands721: { id: 'MODIS_Terra_CorrectedReflectance_Bands721', fmt: 'jpg', level: 9, label: 'MODIS Terra · 7-2-1 False Color (daily)', daily: true, note: 'Active fires glow magenta/pink, burn scars deep red — best for fire analysis' },
  bluemarble: { id: 'BlueMarble_ShadedRelief_Bathymetry', fmt: 'jpg', level: 8, label: 'Blue Marble (static)', daily: false },
};

export const GIBS_OVERLAYS: Record<string, GibsRaster> = {
  coastlines: { id: 'Coastlines_15m', fmt: 'png', level: 13, label: 'Coastlines & borders', daily: false },
  labels: { id: 'Reference_Labels_15m', fmt: 'png', level: 13, label: 'Place labels', daily: false },
  // LP DAAC MOD11 / Terra — Land Surface Temperature. GIBS serves this as image/png
  // at GoogleMapsCompatible_Level7 in epsg3857 (verified via WMTS Capabilities + tile probe).
  lst_day: { id: 'MODIS_Terra_Land_Surface_Temp_Day', fmt: 'png', level: 7, label: 'MODIS LST · Day (MOD11)', daily: true, note: 'Land surface temperature from LP DAAC MOD11/Terra — thermal context under the fire detections' },
  lst_night: { id: 'MODIS_Terra_Land_Surface_Temp_Night', fmt: 'png', level: 7, label: 'MODIS LST · Night (MOD11)', daily: true, note: 'Night-time LST — smouldering & carry-over heat signature' },
};

// MOD11 palette reference (as rendered by GIBS): cool blues/greens → hot oranges/reds (LP DAAC convention), fill = black
export const LST_RAMP: [number, string][] = [
  [-25, '#31356E'], [-10, '#3F6BC4'], [0, '#5FB3D9'], [10, '#7DC57F'], [20, '#E7D95A'], [30, '#E58B3A'], [40, '#C43D2B'], [50, '#7E1B14'],
];
// MOD11 scaling rules (LP DAAC): LST_K = raw × 0.02 · emissivity = raw × 0.02 + 0.49 · fill = 0
export const MOD11_NOTES = {
  scale: 'LST (Kelvin) = stored value × 0.02 — e.g. raw 1592 → 31.84 K',
  emissivity: 'Emissivity = stored value × 0.02 + 0.49 — e.g. raw 241 → 0.972 (97.2%)',
  fill: 'Fill / no-data value = 0 (rendered black)',
  products: 'MOD11_L2 / MYD11_L2 swaths → MOD11A1 (daily) → MOD11A2 (8-day) → MOD11B3 (monthly, incl. new 6 km grids)',
};

export function gibs3857Url(l: GibsRaster, day: string): string {
  const date = l.daily ? day : '2026-01-01';
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${l.id}/default/${date}/GoogleMapsCompatible_Level${l.level}/{z}/{y}/{x}.${l.fmt}`;
}

export function gibs4326MvtUrl(layerId: string, tms: string, day: string, z: number, r: number, c: number): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${layerId}/default/${day}/${tms}/${z}/${r}/${c}.mvt`;
}

// NASA Worldview snapshot export (free, no key)
// NOTE: REQUEST must be GetSnapshot — "DownloadImage" is rejected with an OWS
// ServiceException ("REQUEST type not supported").
export function worldviewSnapshotUrl(bbox: number[], day: string, layers = 'MODIS_Terra_CorrectedReflectance_Bands721,Coastlines_15m'): string {
  const [w, s, e, n] = bbox;
  const width = 1100;
  const height = Math.max(200, Math.round(((n - s) / (e - w)) * 1100));
  return `https://wvs.earthdata.nasa.gov/api/v1/snapshot?REQUEST=GetSnapshot&TIME=${day}&BBOX=${s},${w},${n},${e}&CRS=EPSG:4326&LAYERS=${layers}&WRAP=DAY,x&WIDTH=${width}&HEIGHT=${height}&FORMAT=image/jpeg`;
}
