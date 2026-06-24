const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('http://localhost:3000');
  await page.waitForSelector('.node-card-title', { timeout: 10000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'scripts/screenshot-1-initial.png' });
  console.log('STEP initial render OK, node count:', await page.locator('.node-card-title').count());

  await page.fill('#search', 'Aiden Moore');
  await page.locator('#search').dispatchEvent('change');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'scripts/screenshot-2-search.png' });
  console.log('STEP search applied');

  await page.click('#clearBtn');
  await page.waitForTimeout(500);

  await page.selectOption('#sortBy', 'seller');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'scripts/screenshot-3-sort-seller.png' });
  console.log('STEP sort by seller applied');

  await page.selectOption('#sortBy', 'location');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'scripts/screenshot-4-sort-geo.png' });
  console.log('STEP sort by geography applied');

  await page.selectOption('#sortBy', 'none');
  await page.click('#expandAllBtn');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'scripts/screenshot-5-expand-all.png' });
  console.log('STEP expand all, node count:', await page.locator('.node-card-title').count());

  await page.click('#collapseBtn');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'scripts/screenshot-6-collapse-directors.png' });
  console.log('STEP collapse to directors, node count:', await page.locator('.node-card-title').count());

  console.log('CONSOLE_ERRORS:', JSON.stringify(errors));

  await browser.close();
})();
