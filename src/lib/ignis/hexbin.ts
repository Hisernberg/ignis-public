// IGNIS — FRP-weighted spatial binning shared by BOTH map renderers:
//   · MapLibre GL path (MapPanel.tsx — WebGL2 browsers)
//   · Leaflet DOM path (LeafletFireMap.tsx — GPU-blocked browsers, e.g. Brave shields)
// Square degree-cells sized adaptively to the AOI span (same math as the
// original in-panel implementation — kept in one place so the two renderers
// can never drift apart).
export function hexbin(points: { lon: number; lat: number; frp: number }[], bbox: number[]) {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  const bin = Math.min(2, Math.max(0.25, +(span / 24).toFixed(2)));
  const map = new Map<string, { n: number; frp: number; lat: number; lon: number }>();
  for (const p of points) {
    const gx = Math.floor(p.lon / bin), gy = Math.floor(p.lat / bin);
    const k = `${gx},${gy}`;
    const g = map.get(k) || { n: 0, frp: 0, lat: (gy + 0.5) * bin, lon: (gx + 0.5) * bin };
    g.n++; g.frp += p.frp || 0;
    map.set(k, g);
  }
  const maxN = Math.max(1, ...[...map.values()].map((v) => v.n));
  return { bin, maxN, features: [...map.values()] };
}
