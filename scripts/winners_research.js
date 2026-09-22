// Winners research — NASA Space Apps global winners patterns for IGNIS gap check
let ZAImod;
try { ZAImod = require('/home/z/my-project/node_modules/z-ai-web-dev-sdk'); }
catch (e) { ZAImod = require('z-ai-web-dev-sdk'); }
const ZAI = ZAImod.default || ZAImod;
const fs = require('fs');

async function main() {
  const zai = await ZAI.create();
  const queries = [
    { q: 'NASA Space Apps Challenge 2025 global winners list projects', f: 'w2025.json' },
    { q: 'NASA Space Apps Challenge best use of data winner wildfire fire detection project', f: 'wfire.json' },
    { q: 'NASA Space Apps 2024 2023 global winner project what made them win judging criteria', f: 'w2423.json' },
  ];
  for (const { q, f } of queries) {
    try {
      const res = await zai.functions.invoke('web_search', { query: q, num: 10 });
      fs.writeFileSync(`/home/z/my-project/research/${f}`, JSON.stringify(res, null, 2));
      console.log('OK', f, JSON.stringify(res).slice(0, 120));
    } catch (e) {
      console.log('FAIL', f, String(e).slice(0, 100));
    }
    await new Promise(r => setTimeout(r, 1500));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
