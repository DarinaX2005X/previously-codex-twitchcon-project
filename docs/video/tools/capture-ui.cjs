// Captures the real product UI pieces the film uses, from the running app (https://localhost:4317).
// node capture-ui.cjs  -> docs/video/film/assets/ui/*.png  (re-run after UI changes, then re-render)
const { chromium } = require(process.env.PW_PATH || 'C:/Users/user/Desktop/previouslu/review/pw/node_modules/playwright');
const path = require('path');
const O = path.join(__dirname, '..', 'film', 'assets', 'ui') + path.sep;
const APP = process.env.APP_URL || 'https://localhost:4317';
const shot = async (loc, name) => { try { await loc.first().scrollIntoViewIfNeeded(); await loc.first().screenshot({ path: O + name + '.png' }); console.log('ok', name); } catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); } };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true, deviceScaleFactor: 1.5 });
  // chat answer to !previously (landing renders the real composeReply output)
  await p.goto(APP + '/'); await p.waitForTimeout(2000);
  const sec = p.locator('section', { hasText: 'Anyone who joins late' }).first();
  await sec.scrollIntoViewIfNeeded(); await p.mouse.wheel(0, 200); await p.waitForTimeout(6000);
  await shot(sec.locator('[aria-label*="chat" i]').first(), 'chat-answer');
  // public recap page
  await p.goto(APP + '/c/foxlight_dev'); await p.waitForTimeout(2500);
  await p.screenshot({ path: O + 'public-page.png', fullPage: true });
  await shot(p.locator('article, section, div', { hasText: 'Right now' }).filter({ hasText: 'The goal' }).last(), 'public-now');
  await shot(p.locator('article', { hasText: 'The moon jump' }).first(), 'public-moon');
  // replay: dock before any change, forget dialog, after forget
  await p.goto(APP + '/replay'); await p.waitForTimeout(2500);
  await p.getByRole('button', { name: 'Jump to the raid' }).click(); await p.waitForTimeout(6000);
  await shot(p.locator('section', { hasText: 'Change the recap' }).last(), 'change-before');
  await p.getByRole('button', { name: 'Open the streamer dock' }).click(); await p.waitForTimeout(2500);
  await shot(p.locator('[aria-label="Streamer dock"]'), 'dock-before');
  await p.getByRole('button', { name: 'Forget last 2 min' }).click(); await p.waitForTimeout(1500);
  await shot(p.getByRole('dialog'), 'forget-dialog');
  await p.getByRole('button', { name: /^Forget/ }).last().click(); await p.waitForTimeout(3000);
  await shot(p.locator('[aria-label="Streamer dock"]'), 'dock-after-forget');
  // replay: correction applied
  await p.goto(APP + '/replay'); await p.waitForTimeout(2500);
  await p.getByRole('button', { name: 'Jump to the raid' }).click(); await p.waitForTimeout(6000);
  await p.getByRole('button', { name: 'Apply my wording' }).click(); await p.waitForTimeout(4000);
  await shot(p.locator('section', { hasText: 'Change the recap' }).last(), 'change-after');
  await p.getByRole('button', { name: 'Open the streamer dock' }).click(); await p.waitForTimeout(2500);
  await shot(p.locator('[aria-label="Streamer dock"]'), 'dock-after-correction');
  await b.close();
})();
