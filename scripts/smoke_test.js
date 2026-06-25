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

  // Idempotency: restore version 1 directly via API before testing, regardless of leftover edits.
  await page.evaluate(async () => {
    await fetch(`/api/orgs/${currentOrgId}/versions/1/restore`, {
      method: 'POST',
      headers: { 'x-edit-passcode': 'test123' },
    });
  });
  await page.reload();
  await page.waitForSelector('.org-card', { timeout: 10000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'scripts/screenshot-sidebar.png' });
  console.log('STEP initial sidebar render OK, card count:', await page.locator('.org-card').count());

  // --- Depth slider: 0 = root only, expanding to more levels ---
  await page.fill('#depthSlider', '0');
  await page.dispatchEvent('#depthSlider', 'input');
  await page.waitForTimeout(700);
  console.log('STEP depth=0 card count:', await page.locator('.org-card').count());

  await page.fill('#depthSlider', '3');
  await page.dispatchEvent('#depthSlider', 'input');
  await page.waitForTimeout(700);
  console.log('STEP depth=3 card count:', await page.locator('.org-card').count());

  await page.fill('#depthSlider', '2');
  await page.dispatchEvent('#depthSlider', 'input');
  await page.waitForTimeout(700);

  // --- Single click isolates; double click opens edit panel ---
  await page.locator('.node-card-title:has-text("James Mitchell")').first().click();
  await page.waitForTimeout(600);
  const isolatedCount = await page.locator('.org-card').count();
  console.log('STEP single-click isolate card count (should be small):', isolatedCount);
  await page.screenshot({ path: 'scripts/screenshot-isolated.png' });

  await page.locator('.node-card-title:has-text("James Mitchell")').first().dblclick();
  await page.waitForSelector('#edManager', { timeout: 5000 });
  console.log('STEP double-click opened edit panel OK');
  await page.click('#closeDetail');

  await page.click('#clearBtn');
  await page.waitForTimeout(700);
  console.log('STEP show full org restored card count:', await page.locator('.org-card').count());

  // --- AM filter: select one seller, others should grey out ---
  const firstAmCheckbox = page.locator('.am-filter-item input[type="checkbox"]').first();
  await firstAmCheckbox.check();
  await page.waitForTimeout(400);
  const greyedCount = await page.locator('.org-card').evaluateAll((els) => els.filter((el) => el.style.filter === 'grayscale(1)').length);
  console.log('STEP AM filter greyed-out card count (should be >0):', greyedCount);
  await page.click('#allAmsBtn');
  await page.waitForTimeout(300);

  // --- Mark CTO departed, then fill the position (root editability) ---
  await page.locator('.node-card-title:has-text("Lisa Ross")').first().dblclick();
  await page.waitForSelector('#markDepartedBtn');
  await page.click('#markDepartedBtn');
  await page.waitForTimeout(600);
  console.log('STEP root marked departed, vacant cards:', await page.locator('.node-card-title:has-text("VACANT")').count());

  await page.locator('.node-card-title:has-text("VACANT")').first().dblclick();
  await page.waitForSelector('#fillPositionBtn');
  await page.fill('#fillName', 'New CTO Person');
  await page.fill('#fillTitle', 'CTO');
  await page.click('#fillPositionBtn');
  await page.waitForTimeout(600);
  console.log('STEP root filled, found New CTO Person:', await page.locator('text=New CTO Person').count() > 0);

  // --- Version history: open, preview, restore version 1 ---
  await page.click('#versionHistoryBtn');
  await page.waitForSelector('.version-item');
  const versionCount = await page.locator('.version-item').count();
  console.log('STEP version history entries:', versionCount);
  await page.locator('.version-item').last().click();
  await page.waitForSelector('#restoreVersionBtn:not(.hidden)');
  await page.click('#restoreVersionBtn');
  await page.waitForTimeout(700);
  console.log('STEP restored oldest version, root is Lisa Ross again:', await page.locator('text=Lisa Ross').count() > 0);

  console.log('CONSOLE_ERRORS:', JSON.stringify(errors));
  await browser.close();
})();
