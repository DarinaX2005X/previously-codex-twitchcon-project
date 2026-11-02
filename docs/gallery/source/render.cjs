// Renders every <section class="slide"> of deck.html into docs/gallery/ and builds a contact sheet.
// node render.cjs [id,id]   PNG at 2x (thumbnail at its data-scale); falls back to JPEG when a PNG passes 4.9 MB.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const { chromium } = require(process.env.PW || 'C:/Users/user/Desktop/previouslu/review/pw/node_modules/playwright');
const only = (process.argv[2] || '').split(',').filter(Boolean);
const outDir = path.resolve(__dirname, '..');
const sheetDir = process.env.SHEET_DIR || 'C:/Users/user/Desktop/previouslu/review/gallery';
const LIMIT = 4.9 * 1024 * 1024;
(async () => {
  const b = await chromium.launch();
  const url = require('url').pathToFileURL(path.join(__dirname, 'deck.html')).href;
  const probe = await b.newPage({ viewport: { width: 1800, height: 1200 } });
  await probe.goto(url); await probe.evaluate(() => document.fonts.ready);
  const slides = await probe.$$eval('section.slide', els => els.map(e => ({ id: e.id, out: e.dataset.out, scale: Number(e.dataset.scale || 2) })));
  await probe.close();
  const written = [];
  for (const s of slides) {
    if (only.length && !only.includes(s.id)) continue;
    const ctx = await b.newContext({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: s.scale });
    const p = await ctx.newPage();
    await p.goto(url + '#' + s.id);
    await p.evaluate(() => document.fonts.ready);
    await p.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
    await p.waitForTimeout(300);
    for (const ext of ['.png', '.jpg']) { const f = path.join(outDir, s.out + ext); if (fs.existsSync(f)) fs.unlinkSync(f); }
    let file = path.join(outDir, s.out + '.png');
    await p.locator('#' + s.id).screenshot({ path: file });
    if (fs.statSync(file).size > LIMIT) {
      const jpg = file.replace(/\.png$/, '.jpg');
      await p.locator('#' + s.id).screenshot({ path: jpg, type: 'jpeg', quality: 92 });
      fs.unlinkSync(file); file = jpg;
    }
    written.push(file);
    console.log(path.basename(file), (fs.statSync(file).size / 1048576).toFixed(2) + ' MB');
    await ctx.close();
  }
  await b.close();
  // contact sheet of everything currently in docs/gallery (plus a 300x200 check of the thumbnail)
  fs.mkdirSync(sheetDir, { recursive: true });
  execFileSync('python', [path.join(__dirname, 'capture', 'sheet.py'), outDir, sheetDir], { stdio: 'inherit' });
})().catch(e => { console.error(e); process.exit(1); });
