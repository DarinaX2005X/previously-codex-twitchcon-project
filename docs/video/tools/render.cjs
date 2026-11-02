// Frame-exact render of the film page through Playwright.
// node render.cjs --out <dir> [--from 0] [--to 24] [--fps 60] [--video out.mp4] [--stills 1.5,2.0] [--events ev.json] [--scene-sfx s.wav]
// Needs the capture server: npx vite --config docs/video/tools/vite.film.config.mjs (127.0.0.1:4330, no HMR).
const PW = process.env.PW_PATH || 'C:/Users/user/Desktop/previouslu/review/pw/node_modules/playwright';
const { chromium } = require(PW);
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('base', process.env.FILM_BASE || 'http://127.0.0.1:4330');
(async () => {
  const out = opt('out', '.'); fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync', '--force-color-profile=srgb'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) console.log('[page]', m.type(), m.text().slice(0, 300)); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`${BASE}/docs/video/film/index.html?capture=1`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
  await page.evaluate(() => window.__ready);
  const stage = await page.$('#stage');
  if (opt('events')) { fs.writeFileSync(opt('events'), JSON.stringify(await page.evaluate(() => window.EVENTS), null, 1)); console.log('events', opt('events')); }
  if (opt('scene-sfx')) {
    const b64 = await page.evaluate(() => window.SCENE_SFX());
    if (b64) { fs.writeFileSync(opt('scene-sfx'), Buffer.from(b64, 'base64')); fs.writeFileSync(opt('scene-sfx').replace(/\.wav$/, '.events.json'), JSON.stringify(await page.evaluate(() => window.SCENE_EVENTS()), null, 1)); console.log('scene sfx', opt('scene-sfx')); }
  }
  const shot = async t => { await page.evaluate(t => window.renderAt(t), t); return stage.screenshot({ type: 'jpeg', quality: 93 }); };
  if (opt('stills')) {
    for (const t of opt('stills').split(',').map(Number)) fs.writeFileSync(path.join(out, `t${t.toFixed(3).padStart(8, '0')}.jpg`), await shot(t));
    console.log('stills done');
  }
  if (opt('sheet-fps')) {
    const fps = Number(opt('sheet-fps')), from = Number(opt('from', 0)), to = Number(opt('to', 24));
    for (let i = 0; from + i / fps < to - 1e-9; i++) { const t = from + i / fps; fs.writeFileSync(path.join(out, `t${t.toFixed(3).padStart(8, '0')}.jpg`), await shot(t)); }
    console.log('sheet frames done');
  }
  if (opt('video')) {
    const fps = Number(opt('fps', 60)), from = Number(opt('from', 0)), to = Number(opt('to', 24));
    const n = Math.round((to - from) * fps);
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '18', '-b:v', '0', '-pix_fmt', 'yuv420p', '-r', String(fps), opt('video')], { stdio: ['pipe', 'inherit', 'inherit'] });
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      const buf = await shot(from + i / fps);
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (i % 120 === 0) console.log(`frame ${i}/${n} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    ff.stdin.end(); await new Promise(r => ff.on('close', r));
    console.log(`video ${opt('video')} ${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
