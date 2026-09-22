#!/bin/bash
# IGNIS — verify both map renderers (MapLibre GL path + Leaflet GPU-free path)
# The sandbox reaps background processes between Bash calls, so server+browser
# checks must run inside ONE command invocation.
cd /home/z/my-project

pkill -f "standalone/server.js" 2>/dev/null || true
sleep 1
setsid nohup node .next/standalone/server.js > /home/z/my-project/server.log 2>&1 &
code="000"
for i in $(seq 1 25); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/ping --max-time 3 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "server ready: $code"
[ "$code" = "200" ] || { echo "SERVER FAILED TO START"; tail -20 server.log; exit 1; }

agent-browser close >/dev/null 2>&1 || true

# ---------- PATH A: GPU-free Leaflet renderer (?nogpu=1) ----------
agent-browser open "http://127.0.0.1:3000/?nogpu=1" --timeout 90000 >/dev/null 2>&1
agent-browser wait --load networkidle --timeout 60000 >/dev/null 2>&1 || true
agent-browser wait 12000 >/dev/null 2>&1 || true
echo "=== [A] page errors ==="
agent-browser errors 2>&1 | tail -5
echo "=== [A] leaflet presence ==="
echo -n "leaflet-container: "; agent-browser eval "!!document.querySelector('.leaflet-container')"
echo -n "tiles loaded: ";    agent-browser eval "document.querySelectorAll('.leaflet-tile-loaded').length"
echo -n "canvas layers: ";   agent-browser eval "document.querySelectorAll('.leaflet-overlay-pane canvas, .leaflet-container canvas').length"
echo -n "zoom control: ";    agent-browser eval "!!document.querySelector('.leaflet-control-zoom')"
echo -n "attrib text: ";     agent-browser eval "document.querySelector('.leaflet-control-attribution')?.innerText || 'n/a'"
echo "=== [A] HUD ==="
agent-browser eval "document.body.innerText.match(/renderer: [^\n]*/)?.[0] || 'n/a'"
agent-browser eval "document.body.innerText.match(/ACTIVE FIRE DETECTIONS/)?.[0] || 'HUD missing'"
agent-browser eval "document.body.innerText.match(/GPU blocked/)?.[0] || 'no pill'"
agent-browser eval "document.body.innerText.match(/[0-9,]+ detections/)?.[0] || 'no count'"
agent-browser screenshot /home/z/my-project/download/ignis-verify-leaflet-gpufree.png >/dev/null 2>&1 && echo "[A] screenshot saved"

# ---------- PATH B: default WebGL MapLibre path ----------
agent-browser open "http://127.0.0.1:3000/" --timeout 90000 >/dev/null 2>&1
agent-browser wait --load networkidle --timeout 60000 >/dev/null 2>&1 || true
agent-browser wait 12000 >/dev/null 2>&1 || true
echo "=== [B] page errors ==="
agent-browser errors 2>&1 | tail -5
echo "=== [B] maplibre presence ==="
echo -n "maplibre canvas: "; agent-browser eval "!!document.querySelector('.maplibregl-canvas')"
echo "=== [B] HUD ==="
agent-browser eval "document.body.innerText.match(/renderer: [^\n]*/)?.[0] || 'n/a'"
agent-browser screenshot /home/z/my-project/download/ignis-verify-maplibre.png >/dev/null 2>&1 && echo "[B] screenshot saved"

# leave server running for follow-up probes
echo "ALL CHECKS DONE"
