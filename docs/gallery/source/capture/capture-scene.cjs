// Re-captures raid-scene frames from the scene lab (dev server) for the gallery.
// node capture-scene.cjs [labOrigin=http://127.0.0.1:4321]   (moments and times live in scene-moments.json)
const fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PW || 'C:/Users/user/Desktop/previouslu/review/pw/node_modules/playwright');
const origin = process.argv[2] || 'http://127.0.0.1:4321';
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'scene-moments.json'), 'utf8'));
const out = path.resolve(__dirname, '../assets/scene');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.goto(`${origin}/src/features/overlay/lab/index.html?plan=${cfg.plan}&capture=1&bg=${cfg.bg}`);
  await p.waitForFunction(() => window.__seek && window.__ready, null, { timeout: 60000 });
  await p.evaluate(() => Promise.race([window.__ready, new Promise(r => setTimeout(r, 15000))]));
  for (const [name, ms] of Object.entries(cfg.moments)) {
    await p.evaluate(t => window.__seek(t), ms);
    await p.screenshot({ path: path.join(out, name + '.jpg'), type: 'jpeg', quality: 92 });
    console.log('scene', name, ms);
  }
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
