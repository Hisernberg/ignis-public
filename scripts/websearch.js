// Reusable web search runner -> saves JSON results to /home/z/my-project/research/
// Usage: node websearch.js "query" outfile.json
const path = require('path');
let ZAImod;
try { ZAImod = require('/home/z/my-project/node_modules/z-ai-web-dev-sdk'); }
catch (e) { ZAImod = require('z-ai-web-dev-sdk'); }
const ZAI = ZAImod.default || ZAImod;

async function main() {
  const query = process.argv[2];
  const outfile = process.argv[3];
  if (!query || !outfile) { console.error('usage: node websearch.js "query" out.json'); process.exit(1); }
  const zai = await ZAI.create();
  const result = await zai.functions.invoke('web_search', { query, num: 8 });
  const fs = require('fs');
  fs.mkdirSync('/home/z/my-project/research', { recursive: true });
  fs.writeFileSync(path.join('/home/z/my-project/research', outfile), JSON.stringify(result, null, 2));
  // Print compact summary
  const items = Array.isArray(result) ? result : (result.results || []);
  items.slice(0, 8).forEach((r, i) => {
    console.log(`[${i + 1}] ${r.name || ''}`);
    console.log(`    ${r.url || ''}`);
    console.log(`    ${(r.snippet || '').slice(0, 400)}`);
  });
}
main().catch(e => { console.error('SEARCH FAILED:', e.message); process.exit(1); });
