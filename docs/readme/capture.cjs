// Re-captures the README media in docs/readme/ from the scene lab and the running app.
//   node docs/readme/capture.cjs [scene|app|all]     (default all)
// Needs: the scene lab dev server (LAB, default http://127.0.0.1:4321), the app (APP, default https://localhost:4317),
// Playwright (PW, default the review/pw install), ffmpeg with libwebp_anim, and python with Pillow.
// Scene timings are in milliseconds of the 12 s Foxlight raid plan; adjust MOMENTS and LOOP if the scene changes.
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const { chromium } = require(process.env.PW || 'C:/Users/user/Desktop/previouslu/review/pw/node_modules/playwright');
const LAB = process.env.LAB || 'http://127.0.0.1:4321';
const APP = process.env.APP || 'https://localhost:4317';
const OUT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-readme-'));
const mode = process.argv[2] || 'all';
const wait = ms => new Promise(r => setTimeout(r, ms));

const MOMENTS = { 'shot-scene-chapters': 4400, 'shot-scene-chat': 5750, 'shot-scene-now': 8750 };
const LOOP = { from: 1750, to: 11500, fps: 12, width: 720, quality: 80 }; // starts on the full "Previously" title

// resize + JPEG through Pillow (Lanczos), exact output size
function jpeg(src, dst, w, h, crop) {
  const py = `
from PIL import Image
im = Image.open(r'''${src}''').convert('RGB')
c = ${crop ? JSON.stringify(crop) : 'None'}
if c: im = im.crop(tuple(c))
im.resize((${w}, ${h}), Image.LANCZOS).save(r'''${dst}''', quality=85, optimize=True, progressive=True)
`;
  execFileSync('python', ['-c', py], { stdio: 'inherit' });
  console.log(path.basename(dst), (fs.statSync(dst).size / 1024).toFixed(0) + ' KB');
}

async function scene(b) {
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const open = async () => {
    await p.goto(`${LAB}/src/features/overlay/lab/index.html?plan=foxlight&capture=1&bg=video`);
    await p.waitForFunction(() => window.__seek && window.__ready, null, { timeout: 60000 });
    await p.evaluate(() => Promise.race([window.__ready, new Promise(r => setTimeout(r, 15000))]));
  };
  // the dev server can hot-reload the lab mid-capture; reopen and retry that frame
  const shot = async (ms, opts) => {
    for (let attempt = 0; ; attempt++) {
      try { await p.evaluate(t => window.__seek(t), ms); await p.screenshot(opts); return; }
      catch (e) { if (attempt >= 3) throw e; console.log('lab reloaded, reopening'); await open(); }
    }
  };
  await open();
  for (const [name, ms] of Object.entries(MOMENTS)) {
    const raw = path.join(TMP, name + '.png');
    await shot(ms, { path: raw });
    jpeg(raw, path.join(OUT, name + '.jpg'), 960, 540);
  }
  // animated loop, frame exact
  const dir = path.join(TMP, 'loop'); fs.mkdirSync(dir);
  const n = Math.round((LOOP.to - LOOP.from) * LOOP.fps / 1000);
  for (let i = 0; i < n; i++) {
    await shot(LOOP.from + i * 1000 / LOOP.fps, { path: path.join(dir, `f${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 95 });
  }
  await p.close();
  const webp = path.join(OUT, 'scene-loop.webp');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(LOOP.fps), '-i', path.join(dir, 'f%04d.jpg'),
    '-vf', `scale=${LOOP.width}:-2:flags=lanczos`, '-c:v', 'libwebp_anim', '-loop', '0', '-q:v', String(LOOP.quality),
    '-compression_level', '6', '-preset', 'picture', webp], { stdio: 'inherit' });
  console.log('scene-loop.webp', (fs.statSync(webp).size / 1048576).toFixed(2) + ' MB,', n, 'frames');
}

async function app(b) {
  const page = async (w, h) => { const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, ignoreHTTPSErrors: true, reducedMotion: 'reduce' }); return ctx.newPage(); };
  const jump = async p => { await p.goto(APP + '/replay', { waitUntil: 'load' }); await wait(2500); await p.getByRole('button', { name: 'Jump to the raid' }).click(); };

  // the replay page after Jump to the raid, scene on screen
  let p = await page(1440, 900); await jump(p); await wait(9000);
  await p.evaluate(() => window.scrollTo(0, 0));
  let raw = path.join(TMP, 'replay.png'); await p.screenshot({ path: raw }); jpeg(raw, path.join(OUT, 'shot-replay.jpg'), 1440, 900);
  await p.context().close();

  // the public recap page
  p = await page(1440, 900); await p.goto(APP + '/c/foxlight_dev', { waitUntil: 'load' }); await wait(3000);
  raw = path.join(TMP, 'recap.png'); await p.screenshot({ path: raw }); jpeg(raw, path.join(OUT, 'shot-recap-page.jpg'), 1440, 900);
  await p.context().close();

  // the replay's demo dock at OBS dock width, scrolled past the page's "as it appears inside OBS" bar
  const dock = async () => {
    const q = await page(480, 860); await jump(q); await wait(4000);
    await q.getByRole('button', { name: 'Open the streamer dock' }).click(); await wait(2500);
    await q.evaluate(() => { const d = document.querySelector('.rp-dock'), bar = document.querySelector('.rp-dock__bar'); const next = bar.nextElementSibling || d; window.scrollTo(0, window.scrollY + next.getBoundingClientRect().top); });
    await wait(800);
    return q;
  };
  const shots = [
    ['shot-dock-live', null],
    ['shot-dock-edit', q => q.locator('.rp-dock').getByRole('button', { name: 'Edit' }).first().click()],
    ['shot-dock-forget', q => q.locator('.rp-dock').getByRole('button', { name: 'Forget last 2 min' }).click()],
  ];
  for (const [name, act] of shots) {
    const q = await dock();
    if (act) { await act(q); await wait(1500); }
    raw = path.join(TMP, name + '.png'); await q.screenshot({ path: raw }); jpeg(raw, path.join(OUT, name + '.jpg'), 480, 860);
    await q.context().close();
  }
}

(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  if (mode === 'scene' || mode === 'all') await scene(b);
  if (mode === 'app' || mode === 'all') await app(b);
  await b.close();
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
