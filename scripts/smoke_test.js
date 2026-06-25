const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('http://localhost:3000');
  await page.waitForSelector('.org-card', { timeout: 10000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'scripts/screenshot-drilldown-initial.png' });

  // Magnify removed: hovering should not change card size at all
  const card = await page.locator('.org-card').nth(2);
  const before = await card.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2, { steps: 5 });
  await page.waitForTimeout(300);
  const after = await card.boundingBox();
  console.log('STEP magnify removed - size unchanged on hover:', before.width === after.width && before.height === after.height);

  // Drilldown: root dropdown shows Lisa Ross, level-2 dropdown has SVPs
  const rows = await page.locator('.drilldown-row').count();
  console.log('STEP initial drilldown row count (just root):', rows);
  const rootSelectText = await page.locator('.drilldown-row select').first().locator('option').first().textContent();
  console.log('STEP root dropdown option:', rootSelectText);

  // Level-2 dropdown (SVPs) is the second .drilldown-row, auto-built under the root
  const svpSelect = page.locator('.drilldown-row select').nth(1);
  await svpSelect.selectOption({ label: 'James Mitchell' });
  await page.waitForTimeout(600);
  console.log('STEP drilldown rows after selecting SVP (should be 3):', await page.locator('.drilldown-row').count());
  console.log('STEP isolated card count after SVP select:', await page.locator('.org-card').count());

  // Selecting a VP (3rd row) reveals the Director-level 4th row
  const vpSelect = page.locator('.drilldown-row select').nth(2);
  const vpOptionText = await vpSelect.locator('option').nth(1).textContent();
  await vpSelect.selectOption({ index: 1 });
  await page.waitForTimeout(600);
  console.log('STEP selected VP:', vpOptionText.trim(), 'rows now (should be 4):', await page.locator('.drilldown-row').count());

  // Changing the SVP dropdown (row 2) back to blank discards everything below it
  await svpSelect.selectOption({ index: 0 });
  await page.waitForTimeout(300);
  console.log('STEP rows after clearing SVP selection (should be 2, root + empty SVP select):', await page.locator('.drilldown-row').count());

  // Show Full Org resets the drilldown back to root + SVP-level only
  await svpSelect.selectOption({ label: 'James Mitchell' });
  await page.waitForTimeout(500);
  await page.click('#clearBtn');
  await page.waitForTimeout(300);
  console.log('STEP rows after Show Full Org (should be 2):', await page.locator('.drilldown-row').count());

  console.log('CONSOLE_ERRORS:', JSON.stringify(errors));
  await browser.close();
})();
