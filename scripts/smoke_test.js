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

  // --- Chevron removed ---
  console.log('STEP chevron buttons remaining (should be 0):', await page.locator('#chart button').count());

  // --- Lines touch cards: check path endpoint vs card edge ---
  const lineCheck = await page.evaluate(() => {
    const svg = document.querySelector('#chart svg');
    const path = svg.querySelector('path.link') || svg.querySelector('path');
    const card = document.querySelector('.org-card');
    return { pathD: path ? path.getAttribute('d').slice(0, 40) : null, cardRect: card ? card.getBoundingClientRect().top : null };
  });
  console.log('STEP sample path d-start:', lineCheck.pathD);

  // --- Magnify with reflow: hover near a row, check offsetX applied to neighbor ---
  await page.fill('#depthSlider', '3');
  await page.dispatchEvent('#depthSlider', 'input');
  await page.waitForTimeout(700);
  const cards = await page.locator('.org-card').all();
  const box0 = await cards[6].boundingBox();
  await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
  await page.waitForTimeout(150);
  const transforms = await page.locator('.org-card').evaluateAll((els) => els.slice(0, 12).map((el) => el.style.transform));
  console.log('STEP transforms near hovered row:', JSON.stringify(transforms));
  const anyTranslate = transforms.some((t) => t.includes('translateX') && !t.includes('translateX(0px)'));
  console.log('STEP at least one neighbor got reflowed (translateX != 0):', anyTranslate);

  // --- Arrow key panning ---
  const beforeTransform = await page.evaluate(() => document.querySelector('#chart svg g').getAttribute('transform'));
  await page.click('#chart');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  const afterTransform = await page.evaluate(() => document.querySelector('#chart svg g').getAttribute('transform'));
  console.log('STEP pan transform changed:', beforeTransform !== afterTransform, beforeTransform, '->', afterTransform);

  // --- Notes ---
  await page.click('#clearBtn');
  await page.waitForTimeout(500);
  await page.locator('.node-card-title:has-text("Lisa Ross")').first().dblclick();
  await page.waitForSelector('#saveNoteBtn');
  await page.fill('#newNoteText', 'First test note');
  await page.click('#saveNoteBtn');
  await page.waitForTimeout(800);
  // re-open panel (save reloads org data)
  await page.locator('.node-card-title:has-text("Lisa Ross")').first().dblclick();
  await page.waitForSelector('#saveNoteBtn');
  await page.fill('#newNoteText', 'Second test note');
  await page.click('#saveNoteBtn');
  await page.waitForTimeout(800);
  await page.locator('.node-card-title:has-text("Lisa Ross")').first().dblclick();
  await page.waitForSelector('.note-item');
  const noteCount = await page.locator('.note-item').count();
  const firstNoteText = await page.locator('.note-toggle').first().textContent();
  console.log('STEP note count:', noteCount);

  // notes collapsed by default - body hidden
  const firstBodyHidden = await page.locator('.note-body').first().evaluate((el) => el.classList.contains('hidden'));
  console.log('STEP first note body hidden by default:', firstBodyHidden);

  // open all
  await page.click('#notesOpenAll');
  const allOpen = await page.locator('.note-body').evaluateAll((els) => els.every((el) => !el.classList.contains('hidden')));
  console.log('STEP open all worked:', allOpen);

  // most recent on top: first toggle should correspond to "Second test note"
  await page.click('.note-toggle');
  const firstBodyText = await page.locator('.note-body').first().textContent();
  console.log('STEP most recent note on top (should be Second test note):', firstBodyText.trim());

  // panel height should not have grown from opening notes (check detailPanel scrollHeight stays same order of magnitude)
  console.log('CONSOLE_ERRORS:', JSON.stringify(errors));
  await browser.close();
})();
