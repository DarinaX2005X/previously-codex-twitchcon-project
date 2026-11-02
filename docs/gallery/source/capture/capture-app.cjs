// Captures the real product states the gallery uses, from the running app.
// node capture-app.cjs [base=https://localhost:4317] [only=name,name]
const path = require('path');
const { chromium } = require(process.env.PW || 'C:/Users/user/Desktop/previouslu/review/pw/node_modules/playwright');
const base = process.argv[2] || 'https://localhost:4317';
const only = (process.argv[3] || '').split(',').filter(Boolean);
const out = path.resolve(__dirname, '../assets/app');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function openDock(p) {
  await p.getByRole('button', { name: 'Jump to the raid' }).click(); await wait(4000);
  await p.getByRole('button', { name: 'Open the streamer dock' }).click(); await wait(2500);
}
const jobs = [
  // slide 03: the chat answers on the landing page, composed by the same code the chat bot uses
  { name: 'landing-chat.png', url: '/', w: 1440, h: 900, dpr: 2, el: '.lp-chat__window', scrollTo: '.lp-chat', settle: 3500 },
  // slide 04 and 06: the public recap page on a phone, top and the chapter run further down
  { name: 'public-phone.png', url: '/example', w: 390, h: 844, dpr: 3 },
  { name: 'public-phone-chapters.png', url: '/example', w: 390, h: 844, dpr: 3, full: true, clip: { x: 0, y: 1470, width: 390, height: 844 } },
  // slide 09: the example recording after Jump to the raid
  { name: 'replay-raid.jpg', url: '/replay', w: 1440, h: 900, dpr: 2, act: async p => { await p.getByRole('button', { name: 'Jump to the raid' }).click(); await wait(9000); } },
  // slide 05 and 07: the streamer dock and its Edit and Forget dialogs
  { name: 'dock.png', url: '/replay', w: 1440, h: 1500, dpr: 2, el: '.rp-dock', act: openDock },
  { name: 'dock-edit.png', url: '/replay', w: 1440, h: 1500, dpr: 2, el: 'dialog[open], [role=dialog]', act: async p => { await openDock(p); await p.locator('.rp-dock').getByRole('button', { name: 'Edit' }).first().click(); await wait(1500); } },
  { name: 'dock-forget.png', url: '/replay', w: 1440, h: 1500, dpr: 2, el: 'dialog[open], [role=dialog]', act: async p => { await openDock(p); await p.locator('.rp-dock').getByRole('button', { name: 'Forget last 2 min' }).click(); await wait(1500); } },
];
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const j of jobs) {
    if (only.length && !only.includes(j.name.replace(/\.\w+$/, ''))) continue;
    const ctx = await b.newContext({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: j.dpr, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    await p.goto(base + j.url, { waitUntil: 'load' });
    await wait(2500);
    if (j.scrollTo) { await p.locator(j.scrollTo).first().scrollIntoViewIfNeeded(); await wait(j.settle || 2000); }
    if (j.act) await j.act(p);
    const file = path.join(out, j.name);
    const opts = { path: file, ...(file.endsWith('.jpg') ? { type: 'jpeg', quality: 90 } : {}) };
    if (j.el) await p.locator(j.el).first().screenshot(opts);
    else await p.screenshot({ ...opts, fullPage: !!j.full, ...(j.clip ? { clip: j.clip } : {}) });
    console.log('captured', j.name);
    await ctx.close();
  }
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
