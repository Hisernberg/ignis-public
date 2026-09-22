// Final-round research: 2026 judging rubric, winners' open-science/HF patterns
let ZAImod;
try { ZAImod = require('/home/z/my-project/node_modules/z-ai-web-dev-sdk'); }
catch (e) { ZAImod = require('z-ai-web-dev-sdk'); }
const ZAI = ZAImod.default || ZAImod;
const fs = require('fs');

async function main() {
  const zai = await ZAI.create();
  const queries = [
    { q: 'NASA Space Apps Challenge judging criteria rubric impact creativity validity relevance presentation', f: 'f_judging.json' },
    { q: 'NASA Space Apps winning projects open source hugging face machine learning model publish reproducible', f: 'f_openscience.json' },
    { q: 'wildfire satellite detection dashboard MODIS VIIRS best practices visualization fire radiative power', f: 'f_firmdash.json' },
  ];
  for (const { q, f } of queries) {
    try {
      const res = await zai.functions.invoke('web_search', { query: q, num: 10 });
      fs.writeFileSync(`/home/z/my-project/research/${f}`, JSON.stringify(res, null, 2));
      console.log('OK', f, JSON.stringify(res).slice(0, 110));
    } catch (e) {
      console.log('FAIL', f, e.message);
    }
  }
}
main();
