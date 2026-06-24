const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('http://localhost:3000');
  await page.waitForSelector('.node-card-title', { timeout: 10000 });
  await page.waitForTimeout(1000);

  // Reset first so re-running this script is idempotent regardless of leftover edits.
  await page.click('#resetOrgBtn');
  await page.waitForSelector('#passcodeModal:not(.hidden)');
  await page.fill('#passcodeInput', 'test123');
  await page.click('#passcodeSubmit');
  await page.waitForTimeout(800);
  console.log('STEP initial render OK, node count:', await page.locator('.node-card-title').count());

  // --- Reassign manager via detail panel, triggering the passcode prompt ---
  await page.locator('.node-card-title:has-text("Walter Harrington")').first().click();
  await page.waitForSelector('#edManager');
  const jamesValue = await page.$$eval('#edManager option', (opts) => opts.find((o) => o.textContent.includes('James Mitchell'))?.value);
  await page.selectOption('#edManager', jamesValue);
  await page.click('#saveDetailBtn');
  await page.waitForTimeout(800);
  console.log('STEP reassign manager OK (passcode already cached from reset step)');

  await page.screenshot({ path: 'scripts/screenshot-reassigned.png' });

  // --- Mark someone departed: card should go vacant, descendants stay attached ---
  await page.locator('.node-card-title:has-text("Kathleen Sullivan")').first().click();
  await page.waitForSelector('#markDepartedBtn');
  const childCountBefore = await page.evaluate(() => flatData.filter((d) => d.manager_id === nameToId.get('Kathleen Sullivan')).length);
  await page.click('#markDepartedBtn');
  await page.waitForTimeout(800);
  const vacantCount = await page.locator('text=VACANT').count();
  console.log('STEP mark departed OK, vacant cards:', vacantCount, 'children before removal:', childCountBefore);
  await page.screenshot({ path: 'scripts/screenshot-vacant.png' });

  // --- Finalize removal: reassign the vacant slot's reports, slot disappears ---
  await page.locator('.node-card-title:has-text("VACANT")').first().click();
  await page.waitForSelector('#reassignTarget');
  await page.selectOption('#reassignTarget', { index: 1 });
  await page.click('#removeVacantBtn');
  await page.waitForTimeout(800);
  console.log('STEP finalize removal OK, remaining vacant cards:', await page.locator('.node-card-title:has-text("VACANT")').count());

  // --- Add a new person ---
  await page.click('#addPersonBtn');
  await page.fill('#apName', 'Smoke Test Person');
  await page.fill('#apTitle', 'QA Contact');
  await page.click('#addPersonSubmit');
  await page.waitForTimeout(800);
  console.log('STEP add person OK, found:', await page.locator('text=Smoke Test Person').count() > 0);

  // --- Priority filter ---
  await page.check('#priorityFilter');
  await page.waitForTimeout(300);
  await page.uncheck('#priorityFilter');
  console.log('STEP priority filter toggle OK');

  // --- Reset org data wipes all the above edits ---
  await page.click('#resetOrgBtn');
  await page.waitForTimeout(800);
  console.log('STEP reset org OK, Smoke Test Person gone:', await page.locator('text=Smoke Test Person').count() === 0);

  // --- Sort and expand/collapse still work post-refactor ---
  await page.selectOption('#sortBy', 'seller');
  await page.waitForTimeout(500);
  await page.selectOption('#sortBy', 'none');
  await page.click('#expandAllBtn');
  await page.waitForTimeout(800);
  console.log('STEP expand all OK, node count:', await page.locator('.node-card-title').count());
  await page.click('#collapseBtn');
  await page.waitForTimeout(500);

  console.log('CONSOLE_ERRORS:', JSON.stringify(errors));

  await browser.close();
})();
