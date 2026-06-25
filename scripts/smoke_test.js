const { chromium } = require('playwright');

function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

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

  // --- Full org density: zoom way out, hover, check NO overlap among any cards ---
  await page.fill('#depthSlider', '4');
  await page.dispatchEvent('#depthSlider', 'input');
  await page.waitForTimeout(600);

  const cards = await page.locator('.org-card').all();
  console.log('STEP card count at depth 4:', cards.length);
  const midIdx = Math.floor(cards.length / 2);
  const box = await cards[midIdx].boundingBox();
  const targetId = await cards[midIdx].evaluate((el) => el.dataset.nodeId);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await page.waitForTimeout(400);

  const rects = await page.locator('.org-card').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
  let overlapCount = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i], rects[j])) overlapCount++;
    }
  }
  console.log('STEP overlapping card pairs while hovering (should be 0):', overlapCount);

  console.log('DEBUG targetId:', targetId, 'magnifyScale info:', JSON.stringify(await page.evaluate((id) => ({
    size: magnifyScale.size,
    factor: magnifyScale.get(Number(id)),
  }), targetId)));

  // Query by stable data-node-id, not DOM index - the index shifts once the
  // layout reflows around the magnified card.
  const hoveredCard = await page.locator(`.org-card[data-node-id="${targetId}"]`).boundingBox();
  console.log('STEP hovered card size (should be much larger than the ~9x5 base size):', Math.round(hoveredCard.width), 'x', Math.round(hoveredCard.height));

  // --- Typography ---
  const typo = await page.evaluate(() => {
    const card = document.querySelector('.org-card');
    const name = card.querySelector('.card-name');
    const title = card.querySelector('.card-title');
    const loc = card.querySelector('.card-location');
    const seller = card.querySelector('.card-seller');
    return {
      nameSize: parseFloat(getComputedStyle(name).fontSize),
      titleSize: parseFloat(getComputedStyle(title).fontSize),
      locSize: parseFloat(getComputedStyle(loc).fontSize),
      sellerPosition: seller ? getComputedStyle(seller).position : null,
    };
  });
  console.log('STEP typography sizes (name > title > location):', JSON.stringify(typo));

  // --- Notes with title ---
  await page.mouse.move(50, 50); // away from #chart, so mouseleave clears any lingering magnify state
  await page.fill('#depthSlider', '1'); // back to a sane depth - depth=4 across all 300 nodes makes the root sub-pixel
  await page.dispatchEvent('#depthSlider', 'input');
  await page.click('#clearBtn');
  await page.waitForTimeout(800);
  const targetEl = page.locator('.card-name:has-text("Lisa Ross")').first();
  await targetEl.dblclick();
  await page.waitForSelector('#saveNoteBtn');
  await page.fill('#newNoteTitle', 'Renewal Risk');
  await page.fill('#newNoteText', 'Customer mentioned budget concerns.');
  await page.click('#saveNoteBtn');
  await page.waitForTimeout(800);
  await page.locator('.card-name:has-text("Lisa Ross")').first().dblclick();
  await page.waitForSelector('.note-item');
  const toggleText = await page.locator('.note-toggle').first().textContent();
  const bodyHiddenBeforeOpen = await page.locator('.note-body').first().evaluate((el) => el.classList.contains('hidden'));
  console.log('STEP note toggle text (title visible while collapsed):', toggleText.trim());
  console.log('STEP note body hidden while collapsed:', bodyHiddenBeforeOpen);

  console.log('CONSOLE_ERRORS:', JSON.stringify(errors));
  await browser.close();
})();
