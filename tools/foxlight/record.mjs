// Records Foxlight gameplay frame by frame and encodes it with h264_nvenc.
// Usage: node tools/foxlight/record.mjs [clip ...] [--probe] [--sheet]
//   clips: run moon fixed lanterns stream (default: all)
//   --probe  print a position trace and save a few still frames instead of encoding
//   --sheet  also build 4 fps contact sheets into review/footage/
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/user/Desktop/previouslu/review/pw/node_modules/playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '../..');
const outDir = path.join(project, 'public/demo/foxlight');
const reviewDir = path.resolve(project, '../review/footage');
const FPS = 30;

// poster: the most telling frame, picked from game state
const CLIPS = {
  run: { script: 'run', seconds: 10, res: 720, out: 'clip-run', poster: (s) => s.t > 1.5 && !s.grounded && s.x > 610 && s.x < 700 },
  moon: { script: 'moon', seconds: 10.5, res: 720, bug: true, out: 'clip-moon', poster: (s) => s.moon && s.y < 150 },
  fixed: { script: 'fixed', seconds: 9.5, res: 720, out: 'clip-fixed', poster: (s) => !s.grounded && s.vy > 0 && s.y < 260 && s.x > 2100 },
  lanterns: { script: 'lanterns', seconds: 11, res: 720, out: 'clip-lanterns', poster: (s) => s.lit === 2 && s.events.some((e) => e.type === 'lantern' && e.id === 1 && s.t - e.t > 0.9) },
  stream: { script: 'stream', seconds: 66, res: 1080, out: 'stream-full', poster: (s) => s.lit === 1 && s.events.some((e) => e.type === 'lantern' && s.t - e.t > 1.2) },
};

const args = process.argv.slice(2);
const probe = args.includes('--probe');
const sheet = args.includes('--sheet');
const names = args.filter((a) => !a.startsWith('--'));
const todo = names.length ? names : Object.keys(CLIPS);

function encoder(file, w, h) {
  const ff = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '21',
    ...(h === 1080 ? ['-b:v', '0', '-maxrate', '1.15M', '-bufsize', '2.3M'] : ['-b:v', '0', '-maxrate', '1.35M', '-bufsize', '2.7M']),
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', '-an', file,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))));
  return { ff, done };
}

function run(cmd, a) {
  return new Promise((res, rej) => { const p = spawn(cmd, a, { stdio: 'inherit' }); p.on('close', (c) => (c === 0 ? res() : rej(new Error(cmd + ' exit ' + c)))); });
}

const browser = await chromium.launch({ args: ['--disable-gpu-vsync'] });
mkdirSync(outDir, { recursive: true });
mkdirSync(reviewDir, { recursive: true });

for (const name of todo) {
  const c = CLIPS[name];
  if (!c) { console.error('unknown clip', name); continue; }
  const w = c.res === 1080 ? 1920 : 1280, h = c.res === 1080 ? 1080 : 720;
  const ctxB = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const page = await ctxB.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  const url = pathToFileURL(path.join(here, 'index.html')).href + `?manual=1&script=${c.script}${c.bug ? '&bug=moon' : ''}${c.res === 1080 ? '&res=1080' : ''}`;
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true);
  const frames = Math.round(c.seconds * FPS);
  const t0 = Date.now();

  if (probe) {
    const shots = path.join(reviewDir, 'probe');
    mkdirSync(shots, { recursive: true });
    for (let i = 0; i < frames; i++) {
      const s = await page.evaluate(() => { window.__step(1000 / 30); const s = window.__state(); delete s.events; return s; });
      if (i % 6 === 0) console.log(i, JSON.stringify(s));
      if (i % 45 === 0) {
        const data = await page.evaluate(() => window.__frame('image/jpeg', 0.9));
        writeFileSync(path.join(shots, `${name}-${String(i).padStart(4, '0')}.jpg`), Buffer.from(data.split(',')[1], 'base64'));
      }
    }
    await ctxB.close();
    continue;
  }

  const file = path.join(outDir, c.out + '.mp4');
  const { ff, done } = encoder(file, w, h);
  let posterSaved = false, firstFrame = null;
  for (let i = 0; i < frames; i++) {
    const r = await page.evaluate((first) => {
      if (!first) window.__step(1000 / 30);
      return { png: window.__frame('image/png'), s: window.__state() };
    }, i === 0);
    const buf = Buffer.from(r.png.split(',')[1], 'base64');
    if (i === 0) firstFrame = buf;
    if (!ff.stdin.write(buf)) await new Promise((res) => ff.stdin.once('drain', res));
    if (!posterSaved && c.poster(r.s)) {
      posterSaved = true;
      const jpg = await page.evaluate(() => window.__frame('image/jpeg', 0.9));
      writeFileSync(path.join(outDir, c.out + (c.out === 'stream-full' ? '-poster' : '') + '.jpg'), Buffer.from(jpg.split(',')[1], 'base64'));
    }
  }
  ff.stdin.end();
  await done;
  if (!posterSaved) console.warn(`[${name}] poster predicate never matched; poster not written`);
  const mb = (statSync(file).size / 1048576).toFixed(2);
  console.log(`${name}: ${frames} frames, ${(frames / FPS).toFixed(1)} s, ${mb} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s wall`);
  await ctxB.close();

  if (sheet) {
    const out = path.join(reviewDir, `sheet-${name}.jpg`);
    // 4 fps for the short clips; the long stream take gets 1 fps so the sheet stays readable
    const sfps = name === 'stream' ? 1 : 4;
    const cols = 6, rows = Math.ceil((frames / FPS) * sfps / cols);
    const tw = 320;
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `fps=${sfps},scale=${tw}:-1,tile=${cols}x${rows}:padding=4:color=0x14171B`, '-frames:v', '1', '-q:v', '3', out]);
    console.log('sheet', out);
  }
}
await browser.close();
