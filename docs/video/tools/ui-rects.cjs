// Records where controls sit inside the captured dock / change panel (CSS px, relative to the element), for the film to aim at.
const { chromium } = require(process.env.PW_PATH || 'C:/Users/user/Desktop/previouslu/review/pw/node_modules/playwright');
const fs = require('fs'), path = require('path');
const APP = process.env.APP_URL || 'https://localhost:4317';
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
  await p.goto(APP + '/replay'); await p.waitForTimeout(2500);
  await p.getByRole('button', { name: 'Jump to the raid' }).click(); await p.waitForTimeout(6000);
  const out = {};
  const rel = async (container, loc) => { const c = await container.boundingBox(); const r = await loc.first().boundingBox(); return { x: r.x - c.x, y: r.y - c.y, w: r.width, h: r.height, cw: c.width, ch: c.height }; };
  const change = p.locator('section', { hasText: 'Change the recap' }).last();
  await change.scrollIntoViewIfNeeded();
  out.applyBtn = await rel(change, p.getByRole('button', { name: 'Apply my wording' }));
  await p.getByRole('button', { name: 'Open the streamer dock' }).click(); await p.waitForTimeout(2500);
  const dock = p.locator('[aria-label="Streamer dock"]');
  out.pause = await rel(dock, dock.getByRole('button', { name: 'Pause listening' }));
  out.forget = await rel(dock, dock.getByRole('button', { name: 'Forget last 2 min' }));
  out.card330 = await rel(dock, dock.locator('article, li, section', { hasText: 'Spring gets a speed limit' }).last());
  fs.writeFileSync(path.join(__dirname, '..', 'film', 'assets', 'ui', 'rects.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
  await b.close();
})();
