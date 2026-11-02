// Drives the live product pages embedded in the film (iframes named pub, land, rep, rep0, setup).
// The film shows the real app at full composition; this module puts each page into the state a passage needs
// and reports element rectangles (page CSS px) to the film as window.__ui.
const APP = process.env.APP_URL || 'https://localhost:4317';

async function allowEmbedding(context) {
  // The app forbids framing (frame-ancestors 'self'); for the offline render only, drop that header on documents.
  await context.route(APP + '/**', async r => {
    if (r.request().resourceType() !== 'document') return r.continue();
    const resp = await r.fetch(); const h = { ...resp.headers() };
    delete h['content-security-policy']; delete h['x-frame-options'];
    await r.fulfill({ response: resp, headers: h });
  });
}

const rectOf = async loc => loc.first().evaluate(e => { const b = e.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height }; });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function frameReady(page, name, check) {
  for (let i = 0; i < 200; i++) {
    const f = page.frame({ name });
    if (f) { try { if (await check(f)) return f; } catch {} }
    await wait(150);
  }
  console.log('frames:', page.frames().map(f => f.name() + ' ' + f.url()).join(' | '));
  throw new Error('frame not ready: ' + name);
}

async function setupUi(page) {
  const ui = {};
  const pub = await frameReady(page, 'pub', async f => (await f.locator('article', { hasText: 'The moon jump' }).count()) > 0);
  ui.pubNow = await rectOf(pub.locator('article, section, div', { hasText: 'Right now' }).filter({ hasText: 'The goal' }).last());
  ui.pubMoon = await rectOf(pub.locator('article', { hasText: 'The moon jump' }).first());
  ui.pubStory = await rectOf(pub.locator('article', { hasText: 'Fox learns to jump' }).first());
  try { ui.pubStoryClip = await rectOf(pub.locator('article', { hasText: 'Fox learns to jump' }).first().locator('img, video, button[aria-label*="lay" i]').first()); } catch { }
  try { ui.pubStoryTitle = await rectOf(pub.locator('article', { hasText: 'Fox learns to jump' }).first().locator('h2, h3').first()); } catch { }
  const rep = await frameReady(page, 'rep', f => f.locator('button', { hasText: 'Jump to the raid' }).isVisible());
  for (let k = 0; k < 4; k++) {
    await rep.locator('button', { hasText: 'Jump to the raid' }).evaluate(e => e.click()); await wait(5000);
    if (await rep.locator('button', { hasText: 'Apply my wording' }).count()) { const pz = rep.locator('button[aria-label="Pause"]'); if (await pz.count()) await pz.first().evaluate(e => e.click()); break; }
    console.log('replay: Apply not ready, jumping again');
  }
  ui.repChange = await rectOf(rep.locator('section', { hasText: 'Change the recap' }).last());
  ui.repApply = await rectOf(rep.locator('button', { hasText: 'Apply my wording' }));
  ui.repRecap = await rectOf(rep.locator('section', { hasText: 'The recap so far' }).last());
  ui.repPlayer = await rectOf(rep.locator('[aria-label="Stream"]'));
  await frameReady(page, 'rep0', f => f.locator('button', { hasText: 'Play the recording' }).isVisible());
  await frameReady(page, 'setup', f => f.getByText('Run Previously on this computer').first().isVisible());
  await page.evaluate(u => { window.__ui = Object.assign(window.__ui || {}, u); }, ui);
  return ui;
}

// Actions happen at film times; a render chunk that starts later performs every earlier action first.
const ACTIONS = [
  { at: 87.2, run: async (page, rep) => { for (let k = 0; k < 4 && !(await rep.locator('button', { hasText: 'Apply my wording' }).count()); k++) { console.log('replay: re-jump before Apply', JSON.stringify((await rep.evaluate(() => document.body.innerText)).slice(0, 300))); await rep.locator('button', { hasText: 'Jump to the raid' }).evaluate(e => e.click()); await wait(5000); }
      await rep.locator('button', { hasText: 'Apply my wording' }).evaluate(e => e.click()); await wait(2500);
      const ui = { repRecap2: await rectOf(rep.locator('section', { hasText: 'The recap so far' }).last()), repCheat: await rectOf(rep.locator('article, li', { hasText: 'Moon jump becomes a cheat code' }).first()), repApplied: await rectOf(rep.locator('section', { hasText: 'Change the recap' }).last()) };
      return ui; } },
  { at: 93.45, run: async (page, rep) => { await rep.locator('button', { hasText: 'Open the streamer dock' }).evaluate(e => e.click()); await wait(2500);
      const dock = rep.locator('[aria-label="Streamer dock"]');
      return { repDock: await rectOf(dock), repPause: await rectOf(dock.locator('button', { hasText: 'Pause listening' })), repForget: await rectOf(dock.locator('button', { hasText: 'Forget last 2 min' })) }; } },
  { at: 94.9, run: async (page, rep) => { await rep.locator('[aria-label="Streamer dock"]').locator('button', { hasText: 'Pause listening' }).evaluate(e => e.click()); await wait(1500); return {}; } },
  { at: 97.8, run: async (page, rep) => { await rep.locator('[aria-label="Streamer dock"]').locator('button', { hasText: 'Forget last 2 min' }).evaluate(e => e.click()); await wait(1500);
      const d = rep.locator('dialog[open], [role=dialog]'); const vr = loc => loc.first().evaluate(e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }); return { repDialogV: await vr(d), repYesV: await vr(d.locator('button', { hasText: /^Forget/ })) }; } },
  { at: 99.2, run: async (page, rep) => { await rep.locator('dialog[open], [role=dialog]').locator('button', { hasText: /^Forget/ }).evaluate(e => e.click()); await wait(2500);
      return { repDock2: await rectOf(rep.locator('[aria-label="Streamer dock"]')) }; } },
];
async function ensureUi(page, t, state) {
  state.done = state.done || 0;
  while (state.done < ACTIONS.length && ACTIONS[state.done].at <= t + 1e-6) {
    const rep = page.frame({ name: 'rep' });
    const u = await ACTIONS[state.done].run(page, rep);
    await page.evaluate(x => { window.__ui = Object.assign(window.__ui || {}, x); }, u);
    state.done++;
  }
}
module.exports = { allowEmbedding, setupUi, ensureUi };
