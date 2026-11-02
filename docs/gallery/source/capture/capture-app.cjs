// Captures the real product states the gallery uses, from the running app.
// node capture-app.cjs [base=https://localhost:4317] [only=name,name]
// HOSTED (default https://previously-seven.vercel.app) is used for the landing chat, so its links show the public address.
const path = require('path');
const { chromium } = require(process.env.PW || 'C:/Users/user/Desktop/previouslu/review/pw/node_modules/playwright');
const base = process.argv[2] || 'https://localhost:4317';
const hosted = process.env.HOSTED || 'https://previously-seven.vercel.app';
const only = (process.argv[3] || '').split(',').filter(Boolean);
const out = path.resolve(__dirname, '../assets/app');
const wait = ms => new Promise(r => setTimeout(r, ms));
const jump = async p => { await p.getByRole('button', { name: 'Jump to the raid' }).click(); await wait(5000); };
async function openDock(p) { await jump(p); await p.getByRole('button', { name: 'Open the streamer dock' }).click(); await wait(2500); }
const section = (p, title) => p.locator('section', { has: p.getByRole('heading', { name: title, exact: true }) }).last();
const jobs = [
  // the chat answers on the landing page, composed by the same code the chat bot uses
  { name: 'landing-chat.png', origin: hosted, url: '/', w: 1440, h: 900, dpr: 2, el: p => p.locator('.lp-chat__window').first(), act: async p => { await p.locator('.lp-chat').first().scrollIntoViewIfNeeded(); await wait(3500); } },
  // the example's public recap page on a phone: the top and the chapter run further down
  { name: 'public-phone.png', url: '/example', w: 390, h: 844, dpr: 3 },
  { name: 'public-phone-chapters.png', url: '/example', w: 390, h: 844, dpr: 3, full: true, clip: { x: 0, y: 1500, width: 390, height: 844 } },
  // the example recording after Jump to the raid
  { name: 'replay-raid.jpg', url: '/replay', w: 1440, h: 900, dpr: 2, act: async p => { await jump(p); await wait(4000); } },
  // the recap section switched to Russian
  { name: 'recap-ru.png', url: '/replay', w: 1440, h: 900, dpr: 2, el: p => section(p, 'The recap so far'), act: async p => { await jump(p);
      await p.evaluate(() => document.querySelector('.rp-language input[value=ru]').click()); await wait(4000); } },
  // the recap right after Apply my wording, with the renamed chapter
  { name: 'recap-corrected.png', url: '/replay', w: 1440, h: 900, dpr: 2, el: p => section(p, 'The recap so far'), act: async p => { await jump(p); await p.getByRole('button', { name: 'Apply my wording' }).click(); await wait(3500); } },
  // the streamer dock and its Edit and Forget dialogs
  { name: 'dock.png', url: '/replay', w: 1440, h: 1500, dpr: 2, el: p => p.locator('.rp-dock').first(), act: openDock },
  { name: 'dock-edit.png', url: '/replay', w: 1440, h: 1500, dpr: 2, el: p => p.locator('dialog[open], [role=dialog]').first(), act: async p => { await openDock(p); await p.locator('.rp-dock').getByRole('button', { name: 'Edit' }).first().click(); await wait(1500); } },
  { name: 'dock-forget.png', url: '/replay', w: 1440, h: 1500, dpr: 2, el: p => p.locator('dialog[open], [role=dialog]').first(), act: async p => { await openDock(p); await p.locator('.rp-dock').getByRole('button', { name: 'Forget last 2 min' }).click(); await wait(1500); } },
];
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const j of jobs) {
    if (only.length && !only.includes(j.name.replace(/\.\w+$/, ''))) continue;
    const ctx = await b.newContext({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: j.dpr, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    await p.goto((j.origin || base) + j.url, { waitUntil: 'load' });
    await wait(2500);
    if (j.act) await j.act(p);
    const file = path.join(out, j.name);
    const opts = { path: file, ...(file.endsWith('.jpg') ? { type: 'jpeg', quality: 90 } : {}) };
    if (j.el) await j.el(p).screenshot(opts);
    else await p.screenshot({ ...opts, fullPage: !!j.full, ...(j.clip ? { clip: j.clip } : {}) });
    console.log('captured', j.name);
    await ctx.close();
  }
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
