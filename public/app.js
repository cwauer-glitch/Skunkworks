const SELLER_COLORS = [
  '#3a7bd5', '#e07a5f', '#81b29a', '#f2cc8f', '#9b5de5', '#5dade2'
];

let sellerColorMap = new Map();
let chart;
let flatData = [];
let originalOrder = [];
let nameToId = new Map();
let flatDataById = new Map(); // mirrors flatData, keyed by id - avoids O(n) .find() in hot paths like isAncestor
let currentOrgId = null;
let showOnlyFlagged = false;
let selectedSellers = new Set();
let currentIsolatedId = null;
let depthSliderValue = 2;
let greyedSiblingIds = new Set();
let showVpLabels = true;

// Adjacent entries need to read as clearly different colors (not just shade
// variations of the same green), since adjacent bubbles are exactly the
// case where confusing two colors matters most - so these cycle through
// distinct hue families (sage, clay, slate, olive, mauve, moss, sand, teal)
// while staying muted/earthy in saturation.
const VP_PASTELS = ['#d8e6d0', '#ecd9c4', '#d4e0e6', '#ece0b8', '#e8d4dc', '#c8dcc4', '#ecdcc0', '#c8e0dc'];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function colorForSeller(seller) {
  if (!seller) return '#9aa0a6';
  if (!sellerColorMap.has(seller)) {
    sellerColorMap.set(seller, SELLER_COLORS[sellerColorMap.size % SELLER_COLORS.length]);
  }
  return sellerColorMap.get(seller);
}

// ---------- Edit passcode handling ----------

function getCachedPasscode() {
  return localStorage.getItem('skunkworks_passcode') || '';
}

function setCachedPasscode(value) {
  localStorage.setItem('skunkworks_passcode', value);
}

function promptForPasscode() {
  return new Promise((resolve) => {
    const modal = document.getElementById('passcodeModal');
    const input = document.getElementById('passcodeInput');
    const error = document.getElementById('passcodeError');
    error.textContent = '';
    input.value = '';
    modal.classList.remove('hidden');
    input.focus();

    function cleanup(result) {
      modal.classList.add('hidden');
      submitBtn.removeEventListener('click', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onSubmit() {
      if (!input.value.trim()) {
        error.textContent = 'Passcode cannot be empty.';
        return;
      }
      setCachedPasscode(input.value.trim());
      cleanup(true);
    }
    function onCancel() {
      cleanup(false);
    }
    const submitBtn = document.getElementById('passcodeSubmit');
    const cancelBtn = document.getElementById('passcodeCancel');
    submitBtn.addEventListener('click', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
  });
}

async function editFetch(url, options) {
  let passcode = getCachedPasscode();
  if (!passcode) {
    const proceeded = await promptForPasscode();
    if (!proceeded) return null;
    passcode = getCachedPasscode();
  }

  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), 'x-edit-passcode': passcode },
  });

  if (res.status === 401) {
    localStorage.removeItem('skunkworks_passcode');
    const modal = document.getElementById('passcodeModal');
    document.getElementById('passcodeError').textContent = 'Incorrect passcode. Try again.';
    modal.classList.remove('hidden');
    const proceeded = await promptForPasscode();
    if (!proceeded) return null;
    return editFetch(url, options);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || `Request failed (${res.status})`);
    return null;
  }

  return res;
}

// ---------- Tree flattening ----------

function flatten(node, out) {
  out.push({ ...node, children: undefined });
  for (const child of node.children || []) {
    flatten(child, out);
  }
  return out;
}

function trueRootId() {
  const root = flatData.find((d) => d.manager_id == null);
  return root ? root.id : null;
}

// ---------- AM (seller) filter ----------

function buildAmFilter() {
  const container = document.getElementById('amFilterList');
  container.innerHTML = '';
  for (const seller of sellerColorMap.keys()) {
    const color = colorForSeller(seller);
    const safeId = `am-${seller.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const item = document.createElement('div');
    item.className = 'am-filter-item';
    item.innerHTML = `
      <input type="checkbox" id="${safeId}" ${selectedSellers.has(seller) ? 'checked' : ''} />
      <span class="am-filter-swatch" style="background:${color}"></span>
      <label for="${safeId}">${seller}</label>
    `;
    item.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) selectedSellers.add(seller);
      else selectedSellers.delete(seller);
      chart.render();
    });
    container.appendChild(item);
  }
}

// ---------- Show Client Org: cascading drill-down ----------
//
// One dropdown per level, starting at the CTO. Picking someone reveals a new
// dropdown for their direct reports and isolates that person's org (same as
// clicking their card); changing an earlier dropdown discards everything
// below it, since those levels belonged to the old selection.

function buildDrilldownLevel(managerId, container) {
  const reports = flatData
    .filter((d) => d.manager_id === managerId && d.status === 'active')
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!reports.length) return;

  const row = document.createElement('div');
  row.className = 'control-row drilldown-row';
  row.innerHTML = `
    <label>${reports[0].level || 'Reports'}</label>
    <select><option value="">— choose —</option>${reports.map((r) => `<option value="${r.id}">${r.name}${r.title ? ` — ${r.title}` : ''}</option>`).join('')}</select>
  `;
  container.appendChild(row);

  row.querySelector('select').addEventListener('change', (e) => {
    let sibling = row.nextElementSibling;
    while (sibling) {
      const toRemove = sibling;
      sibling = sibling.nextElementSibling;
      toRemove.remove();
    }
    if (!e.target.value) return;
    const id = Number(e.target.value);
    isolatePerson(id);
    applyDepthLimit();
    buildDrilldownLevel(id, container);
  });
}

function buildClientOrgDrilldown() {
  const container = document.getElementById('clientOrgDrilldown');
  container.innerHTML = '';
  const root = flatData.find((d) => d.manager_id == null);
  if (!root) return;

  const rootRow = document.createElement('div');
  rootRow.className = 'control-row drilldown-row';
  rootRow.innerHTML = `<label>${root.level || 'Top'}</label><select><option value="${root.id}">${root.name}${root.title ? ` — ${root.title}` : ''}</option></select>`;
  container.appendChild(rootRow);

  buildDrilldownLevel(root.id, container);
}

// ---------- Chart rendering ----------

function parseCustomFields(data) {
  let fields = [];
  try {
    fields = JSON.parse(data.custom_fields_json || '[]');
  } catch (e) {
    fields = [];
  }
  const padded = [];
  for (let i = 0; i < 5; i++) padded.push(fields[i] || { title: '', note: '' });
  return padded;
}

// d3-org-chart calls nodeHeight() before the card's HTML is in the DOM, so
// there's nothing to measure live - instead measure into a hidden offscreen
// div with the same width/font the real card uses, to estimate how many
// lines a wrapped title and the populated custom fields will actually take.
let measureDiv = null;
function measureWrappedHeight(text, fontSizePx, fontWeight) {
  if (!text) return 0;
  if (!measureDiv) {
    measureDiv = document.createElement('div');
    measureDiv.style.position = 'absolute';
    measureDiv.style.visibility = 'hidden';
    measureDiv.style.left = '-9999px';
    measureDiv.style.top = '0';
    measureDiv.style.width = '234px'; // card width (260) minus its horizontal padding
    measureDiv.style.fontFamily = 'inherit';
    measureDiv.style.lineHeight = '1.2';
    measureDiv.style.wordWrap = 'break-word';
    document.body.appendChild(measureDiv);
  }
  measureDiv.style.fontSize = `${fontSizePx}px`;
  measureDiv.style.fontWeight = fontWeight || 'normal';
  measureDiv.textContent = text;
  return measureDiv.getBoundingClientRect().height;
}

const CARD_BASE_HEIGHT = 140;

// getBoundingClientRect() forces a synchronous layout - fine once, but
// nodeHeight() runs for every visible node on every render (click, depth
// change, sort...), and this chart has a documented history of stutter from
// exactly this kind of per-render layout thrashing. Caching by the only
// inputs that affect the result (title, custom fields) means a re-render of
// unchanged data - the common case - never touches the measuring div again.
const oneLineHeightCache = new Map();
function getOneLineHeight(fontSizePx) {
  if (!oneLineHeightCache.has(fontSizePx)) {
    oneLineHeightCache.set(fontSizePx, measureWrappedHeight('x', fontSizePx));
  }
  return oneLineHeightCache.get(fontSizePx);
}

const cardHeightCache = new Map();

// Title wraps instead of truncating, and populated custom fields add their
// own lines below the location - the card grows to fit both, capped at
// double its base height so a handful of long fields can't blow up the
// whole chart's row spacing.
function computeCardHeight(data) {
  if (data.status === 'vacant') return CARD_BASE_HEIGHT;

  const cacheKey = `${data.id}|${data.title || ''}|${data.custom_fields_json || ''}`;
  const cached = cardHeightCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const titleHeight = measureWrappedHeight(data.title || '', 15);
  const titleExtra = Math.max(0, titleHeight - getOneLineHeight(15));

  const fieldsExtra = parseCustomFields(data)
    .filter((f) => f.title && f.title.trim())
    .reduce((sum, f) => sum + measureWrappedHeight(`${f.title} : ${f.note || ''}`, 11) + 3, 0);

  const height = Math.min(CARD_BASE_HEIGHT * 2, CARD_BASE_HEIGHT + titleExtra + fieldsExtra);
  cardHeightCache.set(cacheKey, height);
  return height;
}

function nodeContent(d) {
  const data = d.data;

  if (data.status === 'vacant') {
    return `
      <div class="org-card" data-node-id="${data.id}" style="width:100%; height:100%; border:3px solid #d33; border-radius:8px; background:#fdeaea; padding:10px 12px; font-family:inherit;">
        <div class="card-name" style="font-size:21px; color:#a00;">VACANT</div>
        <div class="card-title" style="font-size:14px;">previously: ${data.departed_name || 'Unknown'}</div>
        <div class="card-location" style="font-size:13px;">${data.location || ''}</div>
      </div>
    `;
  }

  const color = colorForSeller(data.seller);
  let opacity = 1;
  let filterCss = 'none';
  if (selectedSellers.size > 0 && !selectedSellers.has(data.seller)) {
    filterCss = 'grayscale(1)';
    opacity = 0.5;
  }
  if (showOnlyFlagged && data.priority_signal !== 'high') {
    opacity = Math.min(opacity, 0.25);
  }
  if (greyedSiblingIds.has(data.id)) {
    filterCss = 'grayscale(0.8)';
    opacity = Math.min(opacity, 0.4);
  }

  const badge = data.priority_signal === 'high'
    ? '<span class="priority-badge priority-high" title="High priority signal">★</span>'
    : data.priority_signal === 'watch'
      ? '<span class="priority-badge priority-watch" title="Watching">•</span>'
      : '';

  const populatedFields = parseCustomFields(data).filter((f) => f.title && f.title.trim());
  const customFieldsHtml = populatedFields.length ? `
    <div class="card-custom-fields">
      ${populatedFields.map((f) => `<div class="card-custom-field">${escapeHtml(f.title)} : ${escapeHtml(f.note || '')}</div>`).join('')}
    </div>
  ` : '';

  return `
    <div class="org-card" data-node-id="${data.id}" style="position:relative; width:100%; height:100%; border:2px solid ${color}; border-radius:8px; background:#fff; padding:11px 13px ${data.seller ? 26 : 11}px 13px; font-family:inherit; opacity:${opacity}; filter:${filterCss}; overflow:hidden;">
      ${badge}
      <div class="card-name" style="font-size:22px;">${data.name}</div>
      <div class="card-title" style="font-size:15px;">${data.title || ''}</div>
      <div class="card-location" style="font-size:13px;">${data.location || ''}</div>
      ${customFieldsHtml}
      ${data.seller ? `<div class="card-seller" style="font-size:14px; right:12px; bottom:7px; color:${color};">${data.seller}</div>` : ''}
    </div>
  `;
}

let clickTimer = null;

function handleNodeClick(d) {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    showDetail(d.data);
  } else {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      isolatePerson(d.data.id);
      applyDepthLimit();
    }, 250);
  }
}

// Smooth flowing S-curve between parent and child, replacing d3-org-chart's
// default rounded-elbow connector. Signature matches what layoutBindings.top
// .diagonal is called with (source point, target point, mid point, offsets).
function smoothDiagonal(s, t, _m, offsets = {}) {
  const sy = s.y + (offsets.sy || 0);
  const midY = (sy + t.y) / 2;
  return `M ${s.x} ${sy} C ${s.x} ${midY}, ${t.x} ${midY}, ${t.x} ${t.y}`;
}

function renderChart(data) {
  const container = document.getElementById('chart');
  container.innerHTML = '';

  const backdropLayer = document.createElement('div');
  backdropLayer.id = 'vpBackdropLayer';
  container.appendChild(backdropLayer);

  chart = new d3.OrgChart()
    .container('#chart')
    .data(data)
    .nodeId((d) => d.id)
    .parentNodeId((d) => d.manager_id)
    .nodeWidth(() => 260)
    .nodeHeight((d) => computeCardHeight(d.data))
    .childrenMargin(() => 70) // extra breathing room between levels, partly so VP bubble labels have somewhere to sit
    .compact(false) // compact mode wraps many leaf-only siblings into a multi-row grid to save width, but that splits one manager's direct reports across two visual rows with very little vertical gap between them - leaving too little room for some (but not all) of their bubble labels to land top-left consistently. A single row per depth keeps every peer's available label room the same.
    .neighbourMargin(() => 30)
    .linkYOffset(0) // default 30px Safari fudge-factor was leaving a visible gap above every card
    .buttonContent(() => '') // hide the built-in expand/collapse chevron+count badge
    .nodeContent(nodeContent)
    .onNodeClick(handleNodeClick)
    .onZoom(() => updateVpBackdropsFromDom()) // immediate, not debounced - pan/zoom doesn't animate card layout, so positions are already accurate
    .linkUpdate(function (d) {
      d3.select(this)
        .attr('stroke', d.data._upToTheRootHighlighted ? '#E27396' : '#2e3d33')
        .attr('stroke-width', d.data._upToTheRootHighlighted ? 4 : 2)
        .attr('fill', 'none');
      if (d.data._upToTheRootHighlighted) d3.select(this).raise();
    });

  // layoutBindings.top.diagonal generates the actual link path string - override
  // it with a smooth curve before the first render.
  const layout = chart.layoutBindings();
  layout.top.diagonal = smoothDiagonal;
  chart.layoutBindings(layout).render();

  // The SVG d3-org-chart creates needs an explicit stacking context so our
  // absolutely-positioned backdrop layer (inserted before it in the DOM)
  // reliably paints behind it rather than on top.
  const svg = container.querySelector('svg');
  if (svg) {
    svg.style.position = 'relative';
    svg.style.zIndex = '1';
  }

  // Namespaced so it coexists with d3-org-chart's own internal zoom handler
  // rather than replacing it. Fires once a pan/zoom gesture finishes (not on
  // every intermediate tick), so it never fights the user mid-drag.
  // sourceEvent is only set for genuine user gestures (drag/wheel) - our own
  // programmatic .fit()/.transform() calls (after every isolate/search/depth
  // change) also dispatch 'end', and correcting in response to those caused
  // a visible second jump right after the intended animation finished.
  chart.getChartState().zoomBehavior.on('end.chainGuard', (event) => {
    if (event && event.sourceEvent) keepChainInView();
  });

  scheduleRectRefresh();
}

function scheduleRectRefresh() {
  // d3-org-chart's default transition is 400ms - this must wait longer than
  // that, or it snapshots mid-animation card positions and the backdrops
  // visibly snap into their correct place a moment after the cards finish,
  // reading as a stutter. No explicit .duration() is set on the chart, so
  // this must stay safely above the library's 400ms default.
  setTimeout(updateVpBackdropsFromDom, 480);
}

// ---------- VP group backdrops ----------

function darkenColor(hex, amount) {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.round(((num >> 16) & 255) * (1 - amount));
  const g = Math.round(((num >> 8) & 255) * (1 - amount));
  const b = Math.round((num & 255) * (1 - amount));
  return `rgb(${r}, ${g}, ${b})`;
}

// A VP's card title is e.g. "VP, IT Service Management" - the label shows
// just the functional part ("IT Service Management"), matching how SVP
// titles like "SVP, Cybersecurity & Risk" already read once the level
// prefix is stripped.
function deriveFunctionLabel(title) {
  if (!title) return '';
  const stripped = title.replace(/^(CTO|SVP|VP|Director|Manager|Staff)\s*,?\s*/i, '').trim();
  return stripped || title;
}

// True if `ancestorId` is somewhere above `nodeId` in the reporting chain.
// Called repeatedly (often in nested loops) by computeBubbleTargets, so the
// id->record lookup is a Map, not a linear .find() over all 300 employees.
function isAncestor(ancestorId, nodeId) {
  let cur = flatDataById.get(nodeId);
  while (cur && cur.manager_id != null) {
    if (cur.manager_id === ancestorId) return true;
    cur = flatDataById.get(cur.manager_id);
  }
  return false;
}

// Which nodes get a bubble, and whether each is the "focal" one (the person
// actually clicked/isolated - gets the bigger, more prominent label) vs a
// "peer" (a visible sibling at the same level - gets a smaller label so it
// can't compete with or overlap the focal one's connector line). Two rules,
// combined:
//  1. Any VP-level node with 2+ such peers simultaneously visible (the
//     original default-view behavior - e.g. an SVP's VP-level children).
//  2. The currently isolated node, at ANY level, plus its visible
//     same-manager siblings - this is what makes the bubble follow you
//     when you drill into a Director/Manager, not just VPs.
// Rule 2 is skipped for any node that would just nest around a bubble
// already produced by rule 1 (e.g. isolating an SVP whose VP children are
// already individually bubbled - re-bubbling the SVP on top would just be a
// bigger, redundant bubble around the same area).
function computeBubbleTargets(cards) {
  const targets = new Map();

  // Greyed ancestor-chain siblings (and their own expanded subtrees) are
  // rendered for context but are not part of the focal subtree - excluding
  // them here keeps the VP-level rule scoped to the isolated person's own
  // organization, so an unrelated branch's VP cards (which can land at
  // overlapping screen positions purely by coincidence) never get bubbled
  // alongside it.
  const inFocalScope = (id) => currentIsolatedId == null || id === currentIsolatedId || isAncestor(currentIsolatedId, id);
  const vpLevelVisible = cards.filter((n) => inFocalScope(n.id) && flatDataById.get(n.id)?.level === 'VP');
  if (vpLevelVisible.length >= 2) {
    vpLevelVisible.forEach((n) => targets.set(n.id, false));
  }

  if (currentIsolatedId != null) {
    const focal = flatDataById.get(currentIsolatedId);
    if (focal) {
      if (targets.has(focal.id)) {
        // Already bubbled by rule 1 (e.g. isolating a VP whose peers are
        // also VP-level) - just promote it to focal, no need to also pull
        // in its own siblings (rule 1 already covers that level).
        targets.set(focal.id, true);
      } else {
        // If the focal's own descendants are already individually bubbled
        // by rule 1 (e.g. isolating an SVP whose VP children each got their
        // own bubble), the focal itself - and by extension its unrelated
        // greyed-context siblings at the same level - should get no bubble
        // of their own; re-bubbling here would either nest redundantly or,
        // worse, pull in completely unrelated branches' siblings that just
        // happen to be rendered for ancestor-chain context.
        const focalNested = Array.from(targets.keys()).some((existingId) => isAncestor(focal.id, existingId));
        if (!focalNested) {
          const candidates = [focal, ...flatData.filter((d) => d.manager_id === focal.manager_id && d.id !== focal.id)];
          candidates.forEach((cand) => {
            const isFocalNode = cand.id === currentIsolatedId;
            if (targets.has(cand.id)) {
              if (isFocalNode) targets.set(cand.id, true);
              return;
            }
            if (!cards.some((n) => n.id === cand.id)) return; // not currently rendered
            const wouldNest = Array.from(targets.keys()).some((existingId) => isAncestor(cand.id, existingId));
            if (wouldNest) return;
            targets.set(cand.id, isFocalNode);
          });
        }
      }
    }
  }

  return Array.from(targets.entries()).map(([id, isFocal]) => ({ id, isFocal }));
}

// Groups a group's own cards into rows by tree depth from the group's
// anchor node, not by pixel position - card heights vary now (wrapped
// titles, custom fields), and d3-org-chart doesn't strictly top-align
// same-depth siblings once their heights differ, so clustering by rendered
// position misread which cards actually belong together and split single
// cards across two row rectangles. Depth from the actual manager_id chain
// is exact regardless of rendered height.
function clusterIntoRows(rootId, groupCards, containerRect) {
  const byDepth = new Map();
  groupCards.forEach((c) => {
    let depth = 0;
    let cur = flatDataById.get(c.id);
    while (cur && cur.id !== rootId && cur.manager_id != null) {
      cur = flatDataById.get(cur.manager_id);
      depth++;
    }
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth).push(c);
  });
  const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);
  return depths.map((d) => {
    const rowCards = byDepth.get(d);
    return {
      rawMinX: Math.min(...rowCards.map((c) => c.rect.left)) - containerRect.left,
      rawMaxX: Math.max(...rowCards.map((c) => c.rect.right)) - containerRect.left,
      rawMinY: Math.min(...rowCards.map((c) => c.rect.top)) - containerRect.top,
      rawMaxY: Math.max(...rowCards.map((c) => c.rect.bottom)) - containerRect.top,
    };
  });
}

function updateVpBackdropsFromDom() {
  const layer = document.getElementById('vpBackdropLayer');
  if (!layer) return;
  layer.innerHTML = '';

  const cards = Array.from(document.querySelectorAll('#chart .org-card')).map((el) => ({
    id: Number(el.dataset.nodeId),
    rect: el.getBoundingClientRect(),
  }));
  const cardsById = new Map(cards.map((c) => [c.id, c]));

  const bubbleTargets = computeBubbleTargets(cards);
  if (!bubbleTargets.length) return;

  const containerRect = document.getElementById('chart').getBoundingClientRect();
  const desiredPadding = 16;
  const minGap = 10; // always leave at least this much space between two bubbles

  // A single rectangle per group used to incidentally swallow up unrelated
  // cards: a group's own anchor card is often narrow, but its deeper
  // descendant rows can spread much wider, and a simple min/max bounding
  // box over EVERY row stretches the anchor's own (otherwise narrow,
  // unrelated-card-free) row out to that same width too. Building one
  // rectangle per depth row instead - "stepped", narrow rows on top,
  // however wide they need to be further down - means a row only ever
  // claims the screen space its own cards actually occupy, so it can never
  // reach into a foreign card that merely happens to share a deeper row's
  // column.
  const groups = bubbleTargets.map(({ id, isFocal }) => {
    const descendantIds = new Set();
    const collect = (pid) => {
      descendantIds.add(pid);
      flatData.filter((d) => d.manager_id === pid).forEach((c) => collect(c.id));
    };
    collect(id);
    const groupCards = cards.filter((n) => descendantIds.has(n.id));
    if (!groupCards.length) return null;
    const nodeData = flatDataById.get(id);
    return {
      nodeId: id,
      isFocal,
      managerId: nodeData ? nodeData.manager_id : null,
      descendantIds,
      rowBoxes: clusterIntoRows(id, groupCards, containerRect),
    };
  }).filter(Boolean);

  groups.forEach((g, i) => { g.color = VP_PASTELS[i % VP_PASTELS.length]; });

  // Sized for the block-lettering label font, generously enough that it
  // fits comfortably in the available space.
  const labelHeight = 20;
  const topLeftMinRoom = labelHeight + 4;
  const minGapToManager = 2; // tighter than the bubble-to-bubble gap - here we just need to clear the card, not leave a generous margin


  const allRows = [];
  groups.forEach((g) => {
    g.rowBoxes.forEach((rb, ri) => {
      rb.group = g;
      rb.padLeft = desiredPadding;
      rb.padRight = desiredPadding;
      if (ri === 0) {
        // The top row reserves a fixed strip for the label, capped only by
        // this node's own manager's card (a solid rectangle - genuinely
        // can't be crossed) and never below the row's own top (so the
        // bubble still fully encloses its own card even when there's no
        // room left to spare). A connector line always terminates exactly
        // at its target's own card top, so clamping by the line's bottom
        // here would always force zero room for every row that has an
        // incoming line at all - every row, in other words. Avoiding the
        // line is handled separately, by nudging the label sideways within
        // this same strip rather than giving up the room entirely.
        const managerCard = g.managerId != null ? cardsById.get(g.managerId) : null;
        const managerBottom = managerCard ? managerCard.rect.bottom - containerRect.top : -Infinity;
        rb.minY = Math.min(rb.rawMinY, Math.max(rb.rawMinY - topLeftMinRoom, managerBottom + minGapToManager));
      } else {
        // Interior rows of the same group share a seam with the row above -
        // touching, not gapped, so the bubble reads as one continuous shape.
        const prev = g.rowBoxes[ri - 1];
        const boundary = (prev.rawMaxY + rb.rawMinY) / 2;
        rb.minY = boundary;
        prev.maxY = boundary;
      }
      if (ri === g.rowBoxes.length - 1) {
        rb.padBottom = desiredPadding;
        rb.maxY = rb.rawMaxY + rb.padBottom;
      }
      allRows.push(rb);
    });
  });

  // Any two rows (from DIFFERENT groups) can be side by side or stacked -
  // either way, if their raw (unpadded) footprints have a real gap along
  // some axis, shrinking padding on the two facing sides along THAT axis
  // (just enough to leave minGap between them) keeps both intact without
  // overlapping - this applies even across a focal/peer pair, since a real
  // gap means there's room to negotiate rather than needing to accept an
  // overlap. Rows belonging to the SAME group are deliberately skipped -
  // they're meant to touch, not be pushed apart.
  // Only when the raw footprints have NO gap in either axis (one is
  // genuinely, fully inside the other's span) is there nothing padding can
  // do: drop the later one rather than render a broken overlap, unless
  // either side is focal - dropping a focal or its peer would lose
  // information the user explicitly wants kept, so that (typically small)
  // residual nesting is accepted instead.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < allRows.length; i++) {
      for (let j = i + 1; j < allRows.length; j++) {
        const a = allRows[i];
        const b = allRows[j];
        if (!a || !b || a.group === b.group) continue;
        if (a.rawMaxX <= b.rawMinX || b.rawMaxX <= a.rawMinX) {
          const left = a.rawMaxX <= b.rawMinX ? a : b;
          const right = left === a ? b : a;
          const avail = Math.max(0, (right.rawMinX - left.rawMaxX - minGap) / 2);
          left.padRight = Math.min(left.padRight, avail);
          right.padLeft = Math.min(right.padLeft, avail);
        } else if (a.rawMaxY <= b.rawMinY || b.rawMaxY <= a.rawMinY) {
          const top = a.rawMaxY <= b.rawMinY ? a : b;
          const bottom = top === a ? b : a;
          if (top.padBottom != null) {
            const avail = Math.max(0, (bottom.rawMinY - top.rawMaxY - minGap) / 2);
            top.padBottom = Math.min(top.padBottom, avail);
            top.maxY = top.rawMaxY + top.padBottom;
          }
          if (bottom.minY != null) {
            bottom.minY = Math.max(bottom.minY, top.maxY + minGap);
          }
        } else if (!a.group.isFocal && !b.group.isFocal) {
          allRows[j] = null;
        }
      }
    }
  }
  const survivingRows = allRows.filter(Boolean);

  // The negotiation above only ever runs row against row - but plenty of
  // cards on screen (greyed ancestor-chain context from a completely
  // unrelated branch, e.g. another SVP's whole team) aren't part of any
  // group at all, and a row's padding can still reach into one of those
  // incidentally. Treat every such foreign card as a zero-padding obstacle
  // and run the same gap-based shrink against it.
  survivingRows.forEach((rb) => {
    cards.forEach((c) => {
      if (rb.group.descendantIds.has(c.id)) return;
      const cardBox = {
        left: c.rect.left - containerRect.left,
        right: c.rect.right - containerRect.left,
        top: c.rect.top - containerRect.top,
        bottom: c.rect.bottom - containerRect.top,
      };
      if (rb.rawMaxX <= cardBox.left || cardBox.right <= rb.rawMinX) {
        if (rb.rawMaxX <= cardBox.left) {
          rb.padRight = Math.min(rb.padRight, Math.max(0, cardBox.left - rb.rawMaxX - minGap));
        } else {
          rb.padLeft = Math.min(rb.padLeft, Math.max(0, rb.rawMinX - cardBox.right - minGap));
        }
      } else if (rb.maxY <= cardBox.top || cardBox.bottom <= rb.minY) {
        if (rb.maxY <= cardBox.top && rb.padBottom != null) {
          rb.padBottom = Math.min(rb.padBottom, Math.max(0, cardBox.top - rb.rawMaxY - minGap));
          rb.maxY = rb.rawMaxY + rb.padBottom;
        } else if (cardBox.bottom <= rb.minY) {
          rb.minY = Math.max(rb.minY, cardBox.bottom + minGap);
        }
      }
      // else: genuinely no gap in either axis - same accepted-nesting
      // exception as the row-vs-row case above.
    });
  });

  const belowSpecs = [];
  const labelFontPx = 17;
  const labelMinFontPx = 11;

  groups.forEach((g) => {
    const rows = g.rowBoxes.filter((rb) => survivingRows.includes(rb));
    if (!rows.length) return;

    rows.forEach((rb) => {
      const minX = rb.rawMinX - rb.padLeft;
      const maxX = rb.rawMaxX + rb.padRight;
      const backdrop = document.createElement('div');
      backdrop.className = 'vp-backdrop';
      backdrop.dataset.nodeId = g.nodeId;
      backdrop.style.left = `${minX}px`;
      backdrop.style.top = `${rb.minY}px`;
      backdrop.style.width = `${maxX - minX}px`;
      backdrop.style.height = `${rb.maxY - rb.minY}px`;
      backdrop.style.background = g.color;
      layer.appendChild(backdrop);
    });

    if (!showVpLabels) return;
    const node = flatDataById.get(g.nodeId);
    const text = node ? deriveFunctionLabel(node.title) : '';
    const labelColor = darkenColor(g.color, 0.42);

    // Labels read as one uniform visual language regardless of which card
    // is currently isolated or how many peers are showing - sized purely by
    // available room, never by focal/peer status.
    const topRow = rows[0];
    const minX = topRow.rawMinX - topRow.padLeft;
    const maxX = topRow.rawMaxX + topRow.padRight;
    const availableRoom = topRow.rawMinY - topRow.minY;
    let placedTopLeft = false;
    if (availableRoom >= topLeftMinRoom) {
      const label = document.createElement('div');
      label.className = 'vp-backdrop-label vp-backdrop-label-large';
      label.textContent = text;
      label.style.color = labelColor;
      label.style.maxWidth = `${Math.max(60, maxX - minX - 16)}px`;
      let fontPx = labelFontPx;
      label.style.fontSize = `${fontPx}px`;
      layer.appendChild(label);
      while (label.getBoundingClientRect().height > availableRoom - 4 && fontPx > labelMinFontPx) {
        fontPx -= 1;
        label.style.fontSize = `${fontPx}px`;
      }
      const labelRect = label.getBoundingClientRect();
      if (labelRect.height <= availableRoom - 4) {
        // The connector line feeding this row always approaches and
        // terminates near the row's own card's horizontal center, however
        // wide the bubble itself is - so anchor the label at whichever
        // side (left or right of that center) has more room within the
        // bubble's own width, clear of where the line comes in, rather
        // than always flush-left. A bubble is typically much wider than
        // its own anchor card (it spans descendants too), so one side
        // almost always has plenty of room regardless of which sibling
        // this is - keeping every peer's label in the same visual format.
        const cardCenterX = (topRow.rawMinX + topRow.rawMaxX) / 2;
        const leftRoom = cardCenterX - minX;
        const rightRoom = maxX - cardCenterX;
        const left = leftRoom >= rightRoom
          ? Math.max(minX, 0) + 8
          : Math.min(maxX - labelRect.width - 8, cardCenterX + 8);
        label.style.left = `${Math.min(Math.max(left, minX + 4), maxX - labelRect.width - 4)}px`;
        label.style.top = `${Math.min(Math.max(topRow.minY, 0) + 6, topRow.rawMinY - labelRect.height - 4)}px`;
        label.dataset.ownerId = g.nodeId;
        placedTopLeft = true;
      } else {
        label.remove();
      }
    }
    if (!placedTopLeft) {
      const bottomRow = rows[rows.length - 1];
      const bMinX = Math.min(...rows.map((r) => r.rawMinX - r.padLeft));
      const bMaxX = Math.max(...rows.map((r) => r.rawMaxX + r.padRight));
      belowSpecs.push({ centerX: (bMinX + bMaxX) / 2, bubbleBottom: bottomRow.maxY, color: labelColor, text, nodeId: g.nodeId });
    }
  });

  if (belowSpecs.length) renderVpLabels(layer, belowSpecs);

  // The padding negotiation above only resolves conflicts between rows
  // themselves - a "below" label can still land in the gap between two
  // vertically-stacked bubbles that's wide enough for the bubbles not to
  // touch but too narrow for a label to fit in between without reaching
  // into the next bubble down. Rather than risk that (the label's own
  // font-shrinking only guards against squeezing between same-row
  // neighbors), do one final sweep: any label that overlaps a bubble it
  // doesn't belong to gets removed outright - no label is better than one
  // that violates the no-overlap rule.
  const allBackdrops = Array.from(layer.querySelectorAll('.vp-backdrop'));
  Array.from(layer.querySelectorAll('.vp-backdrop-label')).forEach((label) => {
    const lr = label.getBoundingClientRect();
    const conflict = allBackdrops.some((bd) => {
      if (bd.dataset.nodeId === label.dataset.ownerId) return false;
      const br = bd.getBoundingClientRect();
      return lr.left < br.right && lr.right > br.left && lr.top < br.bottom && lr.bottom > br.top;
    });
    if (conflict) {
      const leader = layer.querySelector(`.vp-backdrop-leader[data-owner-id="${label.dataset.ownerId}"]`);
      if (leader) leader.remove();
      label.remove();
    }
  });
}

// Labels sit just below their own bubble with a short leader line up to it,
// rather than inside the bubble (which competes with the SVP row above).
// When zoomed out, adjacent labels are squeezed toward each other and would
// start to overlap - shrinking their font-size (not just nudging position,
// since position is tied to the bubble's own center) keeps a minimum gap,
// the same principle the bubbles themselves use to avoid touching.
function renderVpLabels(layer, specs) {
  const gap = 8;
  const baseFontPx = 13;
  const minFontPx = 10;

  specs.sort((a, b) => a.centerX - b.centerX);

  const els = specs.map((spec) => {
    const label = document.createElement('div');
    label.className = 'vp-backdrop-label';
    label.textContent = spec.text;
    label.style.color = spec.color;
    label.style.fontSize = `${baseFontPx}px`;
    label.style.visibility = 'hidden';
    label.dataset.ownerId = spec.nodeId;
    layer.appendChild(label);
    return label;
  });

  // Measure at base size first, then compute how much each label needs to
  // shrink to fit within the space available to its nearest neighbor.
  // Bubbles of very different heights (e.g. a small peer card next to a
  // huge focal subtree) land their below-labels at very different depths -
  // only treat two labels as squeezing each other if they'd actually land
  // in roughly the same horizontal band; otherwise a distant, unrelated
  // label shouldn't force this one to truncate.
  const sameRowThreshold = 40;
  const widths = els.map((el) => el.getBoundingClientRect().width);
  const avails = specs.map((spec, i) => {
    const leftNeighbor = specs[i - 1];
    const rightNeighbor = specs[i + 1];
    const leftIsSameRow = leftNeighbor && Math.abs(leftNeighbor.bubbleBottom - spec.bubbleBottom) < sameRowThreshold;
    const rightIsSameRow = rightNeighbor && Math.abs(rightNeighbor.bubbleBottom - spec.bubbleBottom) < sameRowThreshold;
    const leftAvail = leftIsSameRow ? (spec.centerX - leftNeighbor.centerX) / 2 - gap / 2 : Infinity;
    const rightAvail = rightIsSameRow ? (rightNeighbor.centerX - spec.centerX) / 2 - gap / 2 : Infinity;
    return Math.max(20, Math.min(leftAvail, rightAvail));
  });
  const scales = specs.map((spec, i) => Math.max(minFontPx / baseFontPx, Math.min(1, avails[i] / (widths[i] / 2))));

  specs.forEach((spec, i) => {
    const fontPx = Math.round(baseFontPx * scales[i]);
    const label = els[i];
    label.style.fontSize = `${fontPx}px`;
    // Shrinking the font can only do so much - long text still won't always
    // fit even at the minimum readable size, so this is the hard guarantee
    // against overlap: truncate with an ellipsis rather than spill over.
    label.style.maxWidth = `${avails[i] * 2}px`;
    label.style.visibility = 'visible';
    const width = Math.min(label.getBoundingClientRect().width, avails[i] * 2);
    const labelTop = spec.bubbleBottom + 14;
    label.style.left = `${spec.centerX - width / 2}px`;
    label.style.top = `${labelTop}px`;

    const line = document.createElement('div');
    line.className = 'vp-backdrop-leader';
    line.dataset.ownerId = spec.nodeId;
    line.style.left = `${spec.centerX}px`;
    line.style.top = `${spec.bubbleBottom}px`;
    line.style.height = `${labelTop - spec.bubbleBottom}px`;
    layer.appendChild(line);
  });
}

// ---------- Depth limit (replaces the old fixed collapse-to-directors) ----------

function applyDepthLimit() {
  const viewRootId = currentIsolatedId != null ? currentIsolatedId : trueRootId();
  if (viewRootId == null) return;

  // chart.collapseAll() renders internally, which combined with the single
  // render().fit() below caused a visible two-stage "collapse, then
  // re-expand" stutter on every selection. Clearing flags directly and
  // rendering once avoids that.
  chart.getChartState().allNodes.forEach((d) => { d.data._expanded = false; });

  // d3-org-chart's _expanded flag reveals the FLAGGED node itself, by
  // unwinding the collapse state of its ancestor chain up to the root - it
  // does not reveal that node's children. So to show N levels below the view
  // root, flag every node at depth 1..N relative to it (not its ancestors).
  if (currentIsolatedId != null) {
    chart.setExpanded(currentIsolatedId, true); // unwinds the full path up to the true root
    greyedSiblingIds.forEach((sid) => chart.setExpanded(sid, true)); // greyed siblings: visible, not expanded
  }

  let frontier = [viewRootId];
  for (let level = 1; level <= depthSliderValue && frontier.length; level++) {
    const next = [];
    for (const id of frontier) {
      flatData.filter((d) => d.manager_id === id).forEach((c) => {
        chart.setExpanded(c.id, true);
        next.push(c.id);
      });
    }
    frontier = next;
  }

  chart.render().fit();
  scheduleRectRefresh();
}

// ---------- Isolate view ----------

function isolatePerson(id) {
  currentIsolatedId = id;
  const clicked = flatData.find((d) => d.id === id);

  const ancestorIds = new Set();
  let cur = clicked;
  while (cur) {
    ancestorIds.add(cur.id);
    cur = cur.manager_id != null ? flatData.find((d) => d.id === cur.manager_id) : null;
  }

  const keepIds = new Set(ancestorIds);
  const collectDescendants = (pid) => {
    keepIds.add(pid);
    flatData.filter((d) => d.manager_id === pid).forEach((c) => collectDescendants(c.id));
  };
  collectDescendants(id);

  // Siblings (other people reporting to the same manager) stay visible but
  // greyed-out rather than hidden, until clicked themselves.
  greyedSiblingIds = new Set();
  if (clicked && clicked.manager_id != null) {
    flatData
      .filter((d) => d.manager_id === clicked.manager_id && d.id !== id)
      .forEach((s) => { greyedSiblingIds.add(s.id); keepIds.add(s.id); });
  }

  const filtered = flatData.filter((d) => keepIds.has(d.id));
  chart.data(filtered); // caller renders (usually via applyDepthLimit) - not done here, so callers can set flags (e.g. highlight) first without a second render
}

function showFullOrg() {
  currentIsolatedId = null;
  greyedSiblingIds = new Set();
  chart.data(originalOrder);
  applyDepthLimit();
}

// When an org is too wide for the viewport, the selected card's path back to
// the top of the chart should never fully scroll out of view. Runs once a
// pan/zoom gesture ends; if the whole chain has drifted off one side, nudges
// the view back just enough to bring it in, rather than re-centering.
function keepChainInView() {
  if (currentIsolatedId == null || !chart) return;

  const chainIds = [];
  let cur = flatData.find((d) => d.id === currentIsolatedId);
  while (cur) {
    chainIds.push(cur.id);
    cur = cur.manager_id != null ? flatData.find((d) => d.id === cur.manager_id) : null;
  }
  if (!chainIds.length) return;

  const cardsById = new Map();
  document.querySelectorAll('#chart .org-card').forEach((el) => {
    cardsById.set(Number(el.dataset.nodeId), el.getBoundingClientRect());
  });

  const containerRect = document.getElementById('chart').getBoundingClientRect();
  const minVisible = 60; // require at least this many px of EVERY chain card actually showing, not just a sliver

  // Checking only the union of all chain cards' boxes can miss this: if the
  // chain spans wide, one card (often the root, farthest from whatever's
  // selected) can be almost entirely clipped while the union still reads as
  // "visible" overall. So the trigger is the worst individual card, while
  // the correction itself still re-centers the whole chain's bounding box
  // together (it's narrow enough that this keeps every card in view at once).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minCardVisibleX = Infinity, minCardVisibleY = Infinity;
  let found = false;
  for (const id of chainIds) {
    const r = cardsById.get(id);
    if (!r) continue;
    found = true;
    minX = Math.min(minX, r.left);
    maxX = Math.max(maxX, r.right);
    minY = Math.min(minY, r.top);
    maxY = Math.max(maxY, r.bottom);
    minCardVisibleX = Math.min(minCardVisibleX, Math.min(r.right, containerRect.right) - Math.max(r.left, containerRect.left));
    minCardVisibleY = Math.min(minCardVisibleY, Math.min(r.bottom, containerRect.bottom) - Math.max(r.top, containerRect.top));
  }
  if (!found) return;

  let dx = 0;
  let dy = 0;
  if (minCardVisibleX < minVisible) {
    dx = (containerRect.left + containerRect.right) / 2 - (minX + maxX) / 2;
  }
  if (minCardVisibleY < minVisible) {
    dy = (containerRect.top + containerRect.bottom) / 2 - (minY + maxY) / 2;
  }

  if (dx !== 0 || dy !== 0) {
    const { svg, zoomBehavior } = chart.getChartState();
    svg.transition().duration(250).call(zoomBehavior.translateBy, dx, dy);
  }
}

// ---------- Detail panel ----------

function managerOptions(selectEl, excludeId) {
  const excludeIds = new Set();
  if (excludeId != null) {
    const collect = (id) => {
      excludeIds.add(id);
      flatData.filter((d) => d.manager_id === id).forEach((c) => collect(c.id));
    };
    collect(excludeId);
  }
  const options = flatData
    .filter((d) => d.status === 'active' && !excludeIds.has(d.id))
    .map((d) => `<option value="${d.id}">${d.name} — ${d.title || ''}</option>`)
    .join('');
  selectEl.innerHTML = `<option value="">— none (top of chart) —</option>${options}`;
}

function personFormFields(prefix, data = {}) {
  return `
    <div class="field-row"><label>Name</label><input id="${prefix}Name" type="text" value="${data.name || ''}" /></div>
    <div class="field-row"><label>Title</label><input id="${prefix}Title" type="text" value="${data.title || ''}" /></div>
    <div class="field-row"><label>Level</label>
      <select id="${prefix}Level">
        ${['CTO', 'SVP', 'VP', 'Director', 'Manager', 'Staff'].map((lvl) =>
          `<option value="${lvl}" ${data.level === lvl ? 'selected' : ''}>${lvl}</option>`).join('')}
      </select>
    </div>
    <div class="field-row"><label>Division</label><input id="${prefix}Division" type="text" value="${data.division || ''}" /></div>
    <div class="field-row"><label>Location</label><input id="${prefix}Location" type="text" value="${data.location || ''}" /></div>
    <div class="field-row"><label>Apex Seller</label><input id="${prefix}Seller" type="text" value="${data.seller || ''}" /></div>
    <div class="field-row"><label>Seller Territory</label><input id="${prefix}SellerTerritory" type="text" value="${data.seller_territory || ''}" /></div>
    <label>Priority Tags <input id="${prefix}PriorityTags" type="text" value="${data.priority_tags || ''}" /></label>
    <label>Priority Goal <textarea id="${prefix}PriorityGoal">${data.priority_goal || ''}</textarea></label>
    <label>Priority Signal
      <select id="${prefix}PrioritySignal">
        <option value="none" ${data.priority_signal === 'none' ? 'selected' : ''}>None</option>
        <option value="watch" ${data.priority_signal === 'watch' ? 'selected' : ''}>Watch</option>
        <option value="high" ${data.priority_signal === 'high' ? 'selected' : ''}>High</option>
      </select>
    </label>
  `;
}

function readPersonForm(prefix) {
  return {
    name: document.getElementById(`${prefix}Name`).value.trim(),
    title: document.getElementById(`${prefix}Title`).value.trim(),
    level: document.getElementById(`${prefix}Level`).value,
    division: document.getElementById(`${prefix}Division`).value.trim(),
    location: document.getElementById(`${prefix}Location`).value.trim(),
    seller: document.getElementById(`${prefix}Seller`).value.trim(),
    seller_territory: document.getElementById(`${prefix}SellerTerritory`).value.trim(),
    priority_tags: document.getElementById(`${prefix}PriorityTags`).value.trim(),
    priority_goal: document.getElementById(`${prefix}PriorityGoal`).value.trim(),
    priority_signal: document.getElementById(`${prefix}PrioritySignal`).value,
  };
}

// Notes are stored newest-first already (server unshifts on save), so no
// client-side sorting is needed - "most recent on top" falls out for free.
function notesSectionHtml(data) {
  const notes = JSON.parse(data.notes_json || '[]');
  const items = notes.map((n, i) => `
    <div class="note-item">
      <button type="button" class="note-toggle" data-idx="${i}">
        <span class="note-toggle-title">${escapeHtml(n.title) || 'Note'}</span>
        <span class="note-toggle-time">${new Date(n.created_at).toLocaleString()}</span>
      </button>
      <div class="note-body hidden" data-idx="${i}">${escapeHtml(n.text)}</div>
    </div>
  `).join('');

  return `
    <div class="detail-section">
      <h4>Notes</h4>
      <div class="modal-actions">
        <button type="button" id="notesOpenAll">Open all</button>
        <button type="button" id="notesCloseAll">Close all</button>
      </div>
      <div id="notesList" class="notes-list">${items || '<p class="note-empty">No notes yet.</p>'}</div>
      <input id="newNoteTitle" type="text" placeholder="Note title..." />
      <textarea id="newNoteText" placeholder="Add a note..."></textarea>
      <div class="modal-actions"><button type="button" id="saveNoteBtn">Save Note</button></div>
    </div>
  `;
}

// Wires up an already-rendered notesSectionHtml() block: per-note collapse
// toggles, open/close-all, and saving a new note (which reloads the org and
// re-opens this same person's panel so the new note shows immediately).
function wireNotesSection(data) {
  document.querySelectorAll('#notesList .note-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const body = document.querySelector(`#notesList .note-body[data-idx="${btn.dataset.idx}"]`);
      body.classList.toggle('hidden');
    });
  });
  document.getElementById('notesOpenAll').addEventListener('click', () => {
    document.querySelectorAll('#notesList .note-body').forEach((b) => b.classList.remove('hidden'));
  });
  document.getElementById('notesCloseAll').addEventListener('click', () => {
    document.querySelectorAll('#notesList .note-body').forEach((b) => b.classList.add('hidden'));
  });
  document.getElementById('saveNoteBtn').addEventListener('click', async () => {
    const text = document.getElementById('newNoteText').value.trim();
    if (!text) return;
    const title = document.getElementById('newNoteTitle').value.trim();
    const res = await editFetch(`/api/orgs/${currentOrgId}/employees/${data.id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text }),
    });
    if (res) {
      await loadOrgData(currentOrgId, { preserveView: true });
      const refreshed = flatData.find((d) => d.id === data.id);
      if (refreshed) showDetail(refreshed);
    }
  });
}

// 5 collapsible Field N rows (Title + Note), shown on the card itself
// indented below the location whenever a field's title is populated.
function customFieldsSectionHtml(data) {
  const fields = parseCustomFields(data);
  const rows = fields.map((f, i) => `
    <details class="custom-field-row" ${f.title ? 'open' : ''}>
      <summary>Field ${i + 1}${f.title ? `: ${escapeHtml(f.title)}` : ''}</summary>
      <div class="field-row"><label>Title</label><input id="cfTitle${i}" type="text" value="${escapeHtml(f.title)}" /></div>
      <label>Note <textarea id="cfNote${i}">${escapeHtml(f.note)}</textarea></label>
    </details>
  `).join('');

  return `
    <div class="detail-section">
      <h4>Custom Fields</h4>
      ${rows}
      <p id="customFieldsError" class="modal-error"></p>
      <div class="modal-actions"><button type="button" id="saveCustomFieldsBtn">Save Custom Fields</button></div>
    </div>
  `;
}

function wireCustomFieldsSection(data) {
  document.getElementById('saveCustomFieldsBtn').addEventListener('click', async () => {
    const fields = [0, 1, 2, 3, 4].map((i) => ({
      title: document.getElementById(`cfTitle${i}`).value.trim(),
      note: document.getElementById(`cfNote${i}`).value.trim(),
    }));
    const res = await editFetch(`/api/orgs/${currentOrgId}/employees/${data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_fields_json: JSON.stringify(fields) }),
    });
    if (res) {
      await loadOrgData(currentOrgId, { preserveView: true });
      const refreshed = flatData.find((d) => d.id === data.id);
      if (refreshed) showDetail(refreshed);
    } else {
      document.getElementById('customFieldsError').textContent = 'Could not save custom fields.';
    }
  });
}

function showDetail(data) {
  const panel = document.getElementById('detailPanel');
  const content = document.getElementById('detailContent');

  if (data.status === 'vacant') {
    const isRoot = data.manager_id === null;
    const directReports = flatData.filter((d) => d.manager_id === data.id);

    content.innerHTML = `
      <h2 style="color:#a00;">Vacant Slot</h2>
      <p>Previously: <strong>${data.departed_name || 'Unknown'}</strong></p>
      <p>Location: ${data.location || '—'} &middot; Division: ${data.division || '—'}</p>
      <p>Apex Seller: ${data.seller || '—'} ${data.seller_territory ? `(${data.seller_territory})` : ''}</p>

      <div class="detail-section">
        <h4>Fill this position</h4>
        ${personFormFields('fill')}
        <p id="fillError" class="modal-error"></p>
        <div class="modal-actions"><button id="fillPositionBtn">Fill position</button></div>
      </div>

      ${directReports.length > 0 ? `
        <div class="detail-section">
          <h4>Reassign direct reports individually</h4>
          ${directReports.map((r) => `
            <div class="reassign-row" data-report-id="${r.id}">
              <span>${r.name}</span>
              <select class="individual-reassign-select"></select>
              <button class="individual-reassign-apply">Apply</button>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div class="detail-section">
        <h4>Remove this vacant slot</h4>
        ${isRoot
          ? '<p class="modal-error">The top of the org chart can\'t be permanently removed — use "Fill this position" above instead.</p>'
          : `
            <label>Reassign direct reports to:
              <select id="reassignTarget"></select>
            </label>
            <div class="modal-actions">
              <button id="removeVacantBtn" class="danger">Remove this vacant slot</button>
            </div>
          `}
      </div>
    `;

    document.getElementById('fillPositionBtn').addEventListener('click', async () => {
      const body = readPersonForm('fill');
      if (!body.name) {
        document.getElementById('fillError').textContent = 'Name is required.';
        return;
      }
      const res = await editFetch(`/api/orgs/${currentOrgId}/employees/${data.id}/fill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res) {
        panel.classList.remove('open');
        await loadOrgData(currentOrgId, { preserveView: true });
      }
    });

    directReports.forEach((r) => {
      const row = content.querySelector(`.reassign-row[data-report-id="${r.id}"]`);
      const select = row.querySelector('.individual-reassign-select');
      managerOptions(select, r.id);
      row.querySelector('.individual-reassign-apply').addEventListener('click', async () => {
        if (!select.value) return;
        const res = await editFetch(`/api/orgs/${currentOrgId}/employees/${r.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ manager_id: Number(select.value) }),
        });
        if (res) {
          panel.classList.remove('open');
          await loadOrgData(currentOrgId, { preserveView: true });
        }
      });
    });

    if (!isRoot) {
      const select = document.getElementById('reassignTarget');
      managerOptions(select, data.id);
      document.getElementById('removeVacantBtn').addEventListener('click', async () => {
        if (!confirm('Remove this vacant slot permanently? This cannot be undone from the card itself.')) return;
        if (!confirm('Really sure? Double-checking before this position is deleted for good.')) return;
        const reassignTo = select.value || null;
        const res = await editFetch(`/api/orgs/${currentOrgId}/employees/${data.id}/finalize-removal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reassignTo }),
        });
        if (res) {
          panel.classList.remove('open');
          await loadOrgData(currentOrgId, { preserveView: true });
        }
      });
    }

    panel.classList.remove('hidden');
    panel.classList.add('open');
    return;
  }

  content.innerHTML = `
    <h2>${data.name}</h2>
    ${personFormFields('ed', data)}
    <div class="field-row"><label>Reports To</label><select id="edManager"></select></div>
    <p id="editError" class="modal-error"></p>
    <div class="modal-actions">
      <button id="saveDetailBtn">Save changes</button>
    </div>
    ${notesSectionHtml(data)}
    ${customFieldsSectionHtml(data)}
    <div class="detail-section">
      <div class="modal-actions">
        <button id="markDepartedBtn" class="danger">Mark as Departed</button>
      </div>
    </div>
  `;

  wireNotesSection(data);
  wireCustomFieldsSection(data);

  const managerSelect = document.getElementById('edManager');
  managerOptions(managerSelect, data.id);
  managerSelect.value = data.manager_id != null ? String(data.manager_id) : '';

  document.getElementById('saveDetailBtn').addEventListener('click', async () => {
    const body = readPersonForm('ed');
    body.manager_id = managerSelect.value ? Number(managerSelect.value) : null;
    const res = await editFetch(`/api/orgs/${currentOrgId}/employees/${data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res) {
      panel.classList.remove('open');
      await loadOrgData(currentOrgId, { preserveView: true });
    }
  });

  document.getElementById('markDepartedBtn').addEventListener('click', async () => {
    if (!confirm(`Mark ${data.name} as departed? Their card will become a vacant placeholder; nobody is reassigned until you act on it later.`)) return;
    const res = await editFetch(`/api/orgs/${currentOrgId}/employees/${data.id}/mark-departed`, {
      method: 'POST',
    });
    if (res) {
      panel.classList.remove('open');
      await loadOrgData(currentOrgId, { preserveView: true });
    }
  });

  panel.classList.remove('hidden');
  panel.classList.add('open');
}

// ---------- Keyboard panning ----------
//
// Arrow key = "look more in this direction": pressing Left slides the chart's
// content right, revealing more of what was off-screen to the left.

function panChart(dx, dy) {
  const { svg, zoomBehavior } = chart.getChartState();
  svg.transition().duration(150).call(zoomBehavior.translateBy, dx, dy);
}

function handleArrowKeyPan(e) {
  const panKeys = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  if (!(e.key in panKeys)) return;

  const tag = document.activeElement && document.activeElement.tagName;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return; // don't hijack form controls/slider

  e.preventDefault();
  const step = 120;
  const [dirX, dirY] = panKeys[e.key];
  panChart(dirX * step, dirY * step);
}

// ---------- Sort ----------

function applySort(mode) {
  if (mode === 'none') {
    chart.data(currentIsolatedId != null ? chart.data() : originalOrder).render();
  } else {
    const key = mode === 'seller' ? 'seller' : 'location';
    const base = currentIsolatedId != null ? chart.data() : flatData;
    const sorted = [...base].sort((a, b) => (a[key] || '').localeCompare(b[key] || ''));
    chart.data(sorted).render();
  }
  scheduleRectRefresh();
}

// Shows the union of every flagged person's full org (their ancestors, so
// you can see where they sit, plus their own descendants) - same shape as
// isolatePerson(), just unioned across everyone matching the chosen signals
// instead of a single click target.
function isolateByPriority(values) {
  currentIsolatedId = null;
  greyedSiblingIds = new Set();

  if (values.size === 0) {
    chart.data(originalOrder).render();
    applyDepthLimit();
    return;
  }

  const flagged = flatData.filter((d) => d.status === 'active' && values.has(d.priority_signal));
  const keepIds = new Set();
  flagged.forEach((person) => {
    let cur = person;
    while (cur) {
      keepIds.add(cur.id);
      cur = cur.manager_id != null ? flatData.find((d) => d.id === cur.manager_id) : null;
    }
    const collectDescendants = (pid) => {
      keepIds.add(pid);
      flatData.filter((d) => d.manager_id === pid).forEach((c) => collectDescendants(c.id));
    };
    collectDescendants(person.id);
  });

  const filtered = flatData.filter((d) => keepIds.has(d.id));
  filtered.forEach((d) => { d._expanded = true; }); // set before the one render, not via a second expandAll() render
  chart.data(filtered).render().fit();
  scheduleRectRefresh();
}

// ---------- Search ----------

function focusOnPerson(name) {
  const id = nameToId.get(name);
  if (!id) return;
  isolatePerson(id); // sets chart.data() to include id - must happen before setCentered/etc below, which only look at the current data
  chart.setUpToTheRootHighlighted(id).setCentered(id);
  applyDepthLimit(); // the one render+fit, with the flags above already set
  scheduleRectRefresh();
}

// ---------- Org loading ----------

// Saving an edit, a note, a custom field, etc. always re-fetches the whole
// org (simplest way to stay in sync), but the user is still looking at
// whatever person/subtree they had isolated - snapping back to the full org
// view on every save reads as the chart "jumping" out from under them.
// preserveView restores the same isolated id (and its same ancestor-to-
// descendants framing) after the reload, when that id still exists.
// Returns false (and leaves the previously-rendered chart alone) if orgId
// doesn't actually exist - e.g. a stale id left over in localStorage from
// before the database was reset. Without this check, the 404 error body
// itself ({error: "..."}) would get flattened into a single fake "node"
// with no real name/id, rendering as one card whose every field shows
// "undefined" - which is exactly what a stale cached org id looks like.
async function loadOrgData(orgId, { preserveView = false } = {}) {
  const isolatedIdToRestore = preserveView && currentOrgId === orgId ? currentIsolatedId : null;

  const [treeRes, metaRes] = await Promise.all([
    fetch(`/api/orgs/${orgId}/tree`),
    fetch(`/api/orgs/${orgId}/meta`),
  ]);
  if (!treeRes.ok || !metaRes.ok) {
    console.error(`Failed to load organization ${orgId}: tree=${treeRes.status} meta=${metaRes.status}`);
    return false;
  }
  const tree = await treeRes.json();
  const meta = await metaRes.json();

  currentOrgId = orgId;
  currentIsolatedId = null;
  greyedSiblingIds = new Set();

  sellerColorMap = new Map();
  flatData = flatten(tree, []);
  originalOrder = flatData.slice();
  nameToId = new Map(flatData.map((d) => [d.name, d.id]));
  flatDataById = new Map(flatData.map((d) => [d.id, d]));

  meta.sellers.forEach((s) => colorForSeller(s));
  buildAmFilter();
  buildClientOrgDrilldown();

  renderChart(flatData);
  if (isolatedIdToRestore != null && flatDataById.has(isolatedIdToRestore)) {
    isolatePerson(isolatedIdToRestore); // sets chart.data() only - applyDepthLimit() below does the one render+fit
  }
  applyDepthLimit();

  const dataList = document.getElementById('employee-list');
  dataList.innerHTML = meta.people
    .filter((p) => p.status === 'active')
    .map((p) => `<option value="${p.name}">${p.title || ''}</option>`)
    .join('');
  return true;
}

async function loadOrgSwitcher(selectOrgId) {
  const res = await fetch('/api/orgs');
  const orgs = await res.json();
  const switcher = document.getElementById('orgSwitcher');
  switcher.innerHTML = orgs.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');

  // A cached org id (from localStorage, or the URL) can outlive the
  // organization it pointed to - e.g. after the database is reset on
  // deploy. Only trust it if it's still in the list the server just gave
  // us; otherwise fall back to the first real org rather than asking
  // loadOrgData to render something that no longer exists.
  const cachedId = Number(localStorage.getItem('skunkworks_org_id'));
  const requestedId = selectOrgId || cachedId;
  const requestedIsValid = orgs.some((o) => o.id === requestedId);
  const target = (requestedIsValid ? requestedId : orgs[0]?.id);
  if (target) {
    switcher.value = String(target);
    localStorage.setItem('skunkworks_org_id', String(target));
    const ok = await loadOrgData(target);
    if (!ok && orgs[0] && orgs[0].id !== target) {
      switcher.value = String(orgs[0].id);
      localStorage.setItem('skunkworks_org_id', String(orgs[0].id));
      await loadOrgData(orgs[0].id);
    }
  }
}

// ---------- Version history ----------

let selectedVersionId = null;

async function openVersionHistory() {
  document.getElementById('versionError').textContent = '';
  document.getElementById('restoreVersionBtn').classList.add('hidden');
  selectedVersionId = null;
  const res = await fetch(`/api/orgs/${currentOrgId}/versions`);
  const versions = await res.json();
  const list = document.getElementById('versionList');
  list.innerHTML = versions
    .map((v) => `<div class="version-item" data-id="${v.id}">${new Date(`${v.created_at}Z`).toLocaleString()}</div>`)
    .join('');
  list.querySelectorAll('.version-item').forEach((el) => {
    el.addEventListener('click', () => previewVersion(Number(el.dataset.id), el));
  });
  document.getElementById('versionPreview').innerHTML = '<p>Select a version to preview.</p>';
  document.getElementById('versionHistoryModal').classList.remove('hidden');
}

function countTreeNodes(node) {
  if (!node) return 0;
  return 1 + (node.children || []).reduce((sum, c) => sum + countTreeNodes(c), 0);
}

async function previewVersion(versionId, el) {
  document.querySelectorAll('.version-item').forEach((i) => i.classList.remove('selected'));
  el.classList.add('selected');
  selectedVersionId = versionId;
  const res = await fetch(`/api/orgs/${currentOrgId}/versions/${versionId}`);
  const data = await res.json();
  const preview = document.getElementById('versionPreview');
  preview.innerHTML = `
    <p><strong>${new Date(`${data.createdAt}Z`).toLocaleString()}</strong></p>
    <p>Top of chart: ${data.tree ? `${data.tree.name}${data.tree.status === 'vacant' ? ' (vacant)' : ''}` : '— empty —'}</p>
    <p>Total people: ${countTreeNodes(data.tree)}</p>
  `;
  document.getElementById('restoreVersionBtn').classList.remove('hidden');
}

// ---------- Init ----------

function setupModal(modalId, cancelId) {
  const modal = document.getElementById(modalId);
  document.getElementById(cancelId).addEventListener('click', () => modal.classList.add('hidden'));
}

async function init() {
  await loadOrgSwitcher();

  window.addEventListener('resize', () => scheduleRectRefresh());
  document.addEventListener('keydown', handleArrowKeyPan);

  document.getElementById('sidebarToggle').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const collapsed = sidebar.classList.toggle('collapsed');
    document.getElementById('sidebarToggle').innerHTML = collapsed ? '&raquo;' : '&laquo;';
    scheduleRectRefresh();
  });

  document.getElementById('orgSwitcher').addEventListener('change', async (e) => {
    const orgId = Number(e.target.value);
    localStorage.setItem('skunkworks_org_id', String(orgId));
    await loadOrgData(orgId);
  });

  document.getElementById('search').addEventListener('change', (e) => {
    const name = e.target.value.trim();
    if (nameToId.has(name)) focusOnPerson(name);
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    document.getElementById('search').value = '';
    chart.clearHighlighting();
    showFullOrg();
    buildClientOrgDrilldown();
    document.getElementById('sortBy').value = 'none';
    document.getElementById('prioritySortOptions').style.display = 'none';
    document.getElementById('priorityWatchChk').checked = false;
    document.getElementById('priorityHighChk').checked = false;
  });

  document.getElementById('clearDrilldownBtn').addEventListener('click', () => {
    showFullOrg();
    buildClientOrgDrilldown();
    document.getElementById('sortBy').value = 'none';
    document.getElementById('prioritySortOptions').style.display = 'none';
    document.getElementById('priorityWatchChk').checked = false;
    document.getElementById('priorityHighChk').checked = false;
  });

  function applyPriorityFilterFromCheckboxes() {
    const values = new Set();
    if (document.getElementById('priorityWatchChk').checked) values.add('watch');
    if (document.getElementById('priorityHighChk').checked) values.add('high');
    isolateByPriority(values);
  }

  document.getElementById('sortBy').addEventListener('change', (e) => {
    const mode = e.target.value;
    const prioRow = document.getElementById('prioritySortOptions');
    if (mode === 'priority') {
      prioRow.style.display = '';
      applyPriorityFilterFromCheckboxes();
    } else {
      prioRow.style.display = 'none';
      applySort(mode);
    }
  });

  document.getElementById('priorityWatchChk').addEventListener('change', applyPriorityFilterFromCheckboxes);
  document.getElementById('priorityHighChk').addEventListener('change', applyPriorityFilterFromCheckboxes);

  document.getElementById('depthSlider').addEventListener('input', (e) => {
    depthSliderValue = Number(e.target.value);
    document.getElementById('depthValue').textContent = String(depthSliderValue);
    applyDepthLimit();
  });

  document.getElementById('closeDetail').addEventListener('click', () => {
    document.getElementById('detailPanel').classList.remove('open');
  });

  // Drag the panel's left edge to widen it - only ever grows from its
  // current width (dragging right just snaps back to the floor), never
  // narrower than the original default.
  const MIN_DETAIL_PANEL_WIDTH = 340;
  let panelDragStartX = null;
  let panelDragStartWidth = MIN_DETAIL_PANEL_WIDTH;
  document.getElementById('detailResizeHandle').addEventListener('mousedown', (e) => {
    e.preventDefault();
    panelDragStartX = e.clientX;
    const current = parseFloat(getComputedStyle(document.getElementById('detailPanel')).width);
    panelDragStartWidth = current || MIN_DETAIL_PANEL_WIDTH;
    document.getElementById('detailPanel').classList.add('resizing');
    document.body.style.cursor = 'ew-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (panelDragStartX == null) return;
    const newWidth = Math.max(MIN_DETAIL_PANEL_WIDTH, panelDragStartWidth + (panelDragStartX - e.clientX));
    document.documentElement.style.setProperty('--detail-panel-width', `${newWidth}px`);
  });
  document.addEventListener('mouseup', () => {
    if (panelDragStartX == null) return;
    panelDragStartX = null;
    document.getElementById('detailPanel').classList.remove('resizing');
    document.body.style.cursor = '';
  });

  document.getElementById('priorityFilter').addEventListener('change', (e) => {
    showOnlyFlagged = e.target.checked;
    chart.render();
  });

  document.getElementById('vpLabelsToggle').addEventListener('change', (e) => {
    showVpLabels = e.target.checked;
    updateVpBackdropsFromDom();
  });

  document.getElementById('allAmsBtn').addEventListener('click', () => {
    selectedSellers.clear();
    buildAmFilter();
    chart.render();
  });

  // Version history modal
  document.getElementById('versionHistoryBtn').addEventListener('click', openVersionHistory);
  document.getElementById('versionHistoryClose').addEventListener('click', () => {
    document.getElementById('versionHistoryModal').classList.add('hidden');
  });
  document.getElementById('restoreVersionBtn').addEventListener('click', async () => {
    if (!selectedVersionId) return;
    if (!confirm('Restore this version? It becomes the new current state (this is itself saved to history, so nothing is lost).')) return;
    const res = await editFetch(`/api/orgs/${currentOrgId}/versions/${selectedVersionId}/restore`, { method: 'POST' });
    if (res) {
      document.getElementById('versionHistoryModal').classList.add('hidden');
      await loadOrgData(currentOrgId);
    }
  });

  // New Org modal
  setupModal('newOrgModal', 'newOrgCancel');
  document.getElementById('newOrgBtn').addEventListener('click', () => {
    document.getElementById('newOrgName').value = '';
    document.getElementById('newOrgError').textContent = '';
    document.getElementById('newOrgModal').classList.remove('hidden');
  });
  document.getElementById('newOrgSubmit').addEventListener('click', async () => {
    const name = document.getElementById('newOrgName').value.trim();
    if (!name) {
      document.getElementById('newOrgError').textContent = 'Name is required.';
      return;
    }
    const res = await editFetch('/api/orgs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res) {
      const org = await res.json();
      document.getElementById('newOrgModal').classList.add('hidden');
      await loadOrgSwitcher(org.id);
    }
  });

  // Add Person modal
  setupModal('addPersonModal', 'addPersonCancel');
  document.getElementById('addPersonBtn').addEventListener('click', () => {
    ['apName', 'apTitle', 'apDivision', 'apLocation', 'apSeller', 'apSellerTerritory', 'apPriorityTags', 'apPriorityGoal']
      .forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('apLevel').value = 'Staff';
    document.getElementById('apPrioritySignal').value = 'none';
    document.getElementById('addPersonError').textContent = '';
    managerOptions(document.getElementById('apManager'), null);
    document.getElementById('addPersonModal').classList.remove('hidden');
  });
  document.getElementById('addPersonSubmit').addEventListener('click', async () => {
    const name = document.getElementById('apName').value.trim();
    if (!name) {
      document.getElementById('addPersonError').textContent = 'Name is required.';
      return;
    }
    const managerVal = document.getElementById('apManager').value;
    const body = {
      name,
      title: document.getElementById('apTitle').value.trim(),
      level: document.getElementById('apLevel').value,
      division: document.getElementById('apDivision').value.trim(),
      location: document.getElementById('apLocation').value.trim(),
      seller: document.getElementById('apSeller').value.trim(),
      seller_territory: document.getElementById('apSellerTerritory').value.trim(),
      manager_id: managerVal ? Number(managerVal) : null,
      priority_tags: document.getElementById('apPriorityTags').value.trim(),
      priority_goal: document.getElementById('apPriorityGoal').value.trim(),
      priority_signal: document.getElementById('apPrioritySignal').value,
    };
    const res = await editFetch(`/api/orgs/${currentOrgId}/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res) {
      document.getElementById('addPersonModal').classList.add('hidden');
      await loadOrgData(currentOrgId);
      focusOnPerson(name);
    }
  });
}

init();
