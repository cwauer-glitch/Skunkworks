const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('http://localhost:3000');
  await page.waitForSelector('.org-card', { timeout: 10000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => localStorage.setItem('skunkworks_passcode', 'test123'));
  await page.evaluate(async () => {
    await fetch(`/api/orgs/${currentOrgId}/versions/1/restore`, { method: 'POST', headers: { 'x-edit-passcode': 'test123' } });
  });
  await page.reload();
  await page.waitForSelector('.org-card');
  await page.waitForTimeout(1000);

  await page.screenshot({ path: 'scripts/screenshot-sidebar.png' });
  console.log('STEP sidebar restructured, card count:', await page.locator('.org-card').count());

  // --- Sidebar collapse ---
  await page.click('#sidebarToggle');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'scripts/screenshot-collapsed.png' });
  console.log('STEP sidebar collapsed, AM list still visible:', await page.locator('.am-filter-item').count());
  await page.click('#sidebarToggle');
  await page.waitForTimeout(300);

  // --- Isolate with greyed siblings ---
  await page.locator('.node-card-title:has-text("James Mitchell")').first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'scripts/screenshot-isolated-siblings.png' });
  const greyedCount = await page.locator('.org-card').evaluateAll((els) => els.filter((el) => el.style.filter.includes('grayscale(0.8)')).length);
  console.log('STEP isolate with siblings, greyed count:', greyedCount);

  // --- Depth 3 to get multiple VPs visible for backdrop test ---
  await page.click('#clearBtn');
  await page.fill('#depthSlider', '2');
  await page.dispatchEvent('#depthSlider', 'input');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'scripts/screenshot-vp-backdrops.png' });
  console.log('STEP VP backdrop divs:', await page.locator('.vp-backdrop').count());

  // --- Hover magnify strength at full org density ---
  const card = await page.locator('.org-card').nth(5);
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  const transform = await card.evaluate((el) => el.style.transform);
  console.log('STEP magnify transform at full org:', transform);

  // --- Connector line color/shape ---
  const linkColor = await page.evaluate(() => {
    const path = document.querySelector('#chart path');
    return path ? getComputedStyle(path).stroke : null;
  });
  console.log('STEP link stroke color:', linkColor);

  console.log('CONSOLE_ERRORS:', JSON.stringify(errors));
  await browser.close();
})();
