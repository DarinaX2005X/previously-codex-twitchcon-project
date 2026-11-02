// Extra captures for the ending: the local setup page and the hosted example replay (viewport shots).
const { chromium } = require(process.env.PW_PATH || 'C:/Users/user/Desktop/previouslu/review/pw/node_modules/playwright');
const path = require('path');
const O = path.join(__dirname, '..', 'film', 'assets', 'ui') + path.sep;
const APP = process.env.APP_URL || 'https://localhost:4317';
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, deviceScaleFactor: 1.5 });
  await p.goto(APP + '/setup'); await p.waitForTimeout(2500); await p.screenshot({ path: O + 'setup.png' });
  await p.goto(APP + '/replay'); await p.waitForTimeout(2500); await p.screenshot({ path: O + 'replay-top.png' });
  await b.close(); console.log('ok');
})();
