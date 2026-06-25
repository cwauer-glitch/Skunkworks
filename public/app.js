const SELLER_COLORS = [
  '#3a7bd5', '#e07a5f', '#81b29a', '#f2cc8f', '#9b5de5', '#5dade2'
];

let sellerColorMap = new Map();
let chart;
let flatData = [];
let originalOrder = [];
let nameToId = new Map();
let currentOrgId = null;
let showOnlyFlagged = false;
let selectedSellers = new Set();
let currentIsolatedId = null;
let depthSliderValue = 2;
let greyedSiblingIds = new Set();

const VP_PASTELS = ['#fde2e2', '#e2f0fd', '#e2fde6', '#fdf6e2', '#f0e2fd', '#e2fdfa', '#fde2f6', '#eaf5d8'];

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

// ---------- Chart rendering ----------

function nodeContent(d) {
  const data = d.data;

  if (data.status === 'vacant') {
    return `
      <div class="org-card" data-node-id="${data.id}" style="width:220px; border:3px solid #d33; border-radius:8px; background:#fdeaea; padding:8px 10px; font-family:inherit;">
        <div class="node-card-title" style="color:#a00;">VACANT</div>
        <div class="node-card-sub">previously: ${data.departed_name || 'Unknown'}</div>
        <div class="node-card-sub">${data.location || ''}</div>
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

  return `
    <div class="org-card" data-node-id="${data.id}" style="position:relative; width:220px; border:2px solid ${color}; border-radius:8px; background:#fff; padding:8px 10px; font-family:inherit; opacity:${opacity}; filter:${filterCss};">
      ${badge}
      <div class="node-card-title">${data.name}</div>
      <div class="node-card-sub">${data.title || ''}</div>
      <div class="node-card-sub">${data.location || ''}</div>
      ${data.seller ? `<div class="node-card-sub" style="color:${color}; font-weight:600;">${data.seller}</div>` : ''}
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
    .nodeWidth(() => 240)
    .nodeHeight(() => 110)
    .childrenMargin(() => 50)
    .compactMarginBetween(() => 25)
    .compactMarginPair(() => 60)
    .neighbourMargin(() => 30)
    .nodeContent(nodeContent)
    .onNodeClick(handleNodeClick)
    .onZoom(() => scheduleRectRefresh())
    .linkUpdate(function (d) {
      d3.select(this)
        .attr('stroke', d.data._upToTheRootHighlighted ? '#E27396' : '#1a3a6b')
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

  scheduleRectRefresh();
}

// ---------- Hover-magnify effect ----------
//
// The card under the cursor should read as large as it would in an isolated
// few-card view, regardless of how zoomed-out the full org currently is - so
// the boost amount is derived from the chart's current zoom scale (1/k - 1
// roughly cancels out the zoom-out), not a fixed constant. Falloff away from
// the cursor follows a Gaussian bell curve (not linear) so it reads as a
// smooth lens rather than a hard-edged circle.

let nodeRects = [];
let scaledEls = new Set();
let mouseMoveRafPending = false;
const MAGNIFY_RADIUS = 260;
const MAGNIFY_SIGMA = MAGNIFY_RADIUS / 2.2;
const MAX_BOOST_CAP = 9; // generous ceiling for extreme zoom-out (avoids runaway scale)

function currentZoomScale() {
  try {
    return chart.getChartState().lastTransform.k || 1;
  } catch (e) {
    return 1;
  }
}

function refreshNodeRects() {
  const cards = document.querySelectorAll('#chart .org-card');
  nodeRects = Array.from(cards).map((el) => {
    const rect = el.getBoundingClientRect();
    return { el, id: Number(el.dataset.nodeId), cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, rect };
  });
  updateVpBackdrops();
}

function scheduleRectRefresh() {
  // d3-org-chart animates layout changes (~400ms transition) - wait for it to
  // settle before caching screen positions, or the magnify radius would be stale.
  setTimeout(refreshNodeRects, 450);
}

function handleChartMouseMove(e) {
  if (mouseMoveRafPending) return;
  mouseMoveRafPending = true;
  requestAnimationFrame(() => {
    mouseMoveRafPending = false;
    const k = currentZoomScale();
    const boost = Math.max(0, Math.min(1 / k - 1, MAX_BOOST_CAP));
    const stillScaled = new Set();
    for (const node of nodeRects) {
      const dx = e.clientX - node.cx;
      const dy = e.clientY - node.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < MAGNIFY_RADIUS) {
        const bell = Math.exp(-(dist * dist) / (2 * MAGNIFY_SIGMA * MAGNIFY_SIGMA));
        const scale = 1 + boost * bell;
        node.el.style.transform = `scale(${scale})`;
        node.el.style.zIndex = '10';
        stillScaled.add(node.el);
      }
    }
    for (const el of scaledEls) {
      if (!stillScaled.has(el)) {
        el.style.transform = 'scale(1)';
        el.style.zIndex = '';
      }
    }
    scaledEls = stillScaled;
  });
}

// ---------- VP group backdrops ----------

function updateVpBackdrops() {
  const layer = document.getElementById('vpBackdropLayer');
  if (!layer) return;
  layer.innerHTML = '';

  const visibleVps = nodeRects.filter((n) => {
    const d = flatData.find((fd) => fd.id === n.id);
    return d && d.level === 'VP';
  });
  if (visibleVps.length < 2) return;

  const containerRect = document.getElementById('chart').getBoundingClientRect();
  const padding = 16;

  visibleVps.forEach((vpNode, i) => {
    const descendantIds = new Set();
    const collect = (pid) => {
      descendantIds.add(pid);
      flatData.filter((d) => d.manager_id === pid).forEach((c) => collect(c.id));
    };
    collect(vpNode.id);

    const groupRects = nodeRects.filter((n) => descendantIds.has(n.id));
    if (!groupRects.length) return;

    const minX = Math.min(...groupRects.map((n) => n.rect.left)) - containerRect.left - padding;
    const maxX = Math.max(...groupRects.map((n) => n.rect.right)) - containerRect.left + padding;
    const minY = Math.min(...groupRects.map((n) => n.rect.top)) - containerRect.top - padding;
    const maxY = Math.max(...groupRects.map((n) => n.rect.bottom)) - containerRect.top + padding;

    const backdrop = document.createElement('div');
    backdrop.className = 'vp-backdrop';
    backdrop.style.left = `${minX}px`;
    backdrop.style.top = `${minY}px`;
    backdrop.style.width = `${maxX - minX}px`;
    backdrop.style.height = `${maxY - minY}px`;
    backdrop.style.background = VP_PASTELS[i % VP_PASTELS.length];
    layer.appendChild(backdrop);
  });
}

// ---------- Depth limit (replaces the old fixed collapse-to-directors) ----------

function applyDepthLimit() {
  const viewRootId = currentIsolatedId != null ? currentIsolatedId : trueRootId();
  if (viewRootId == null) return;

  chart.collapseAll();

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
  chart.data(filtered).render();
  applyDepthLimit();
}

function showFullOrg() {
  currentIsolatedId = null;
  greyedSiblingIds = new Set();
  chart.data(originalOrder).render();
  applyDepthLimit();
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
    <label>Name <input id="${prefix}Name" type="text" value="${data.name || ''}" /></label>
    <label>Title <input id="${prefix}Title" type="text" value="${data.title || ''}" /></label>
    <label>Level
      <select id="${prefix}Level">
        ${['CTO', 'SVP', 'VP', 'Director', 'Manager', 'Staff'].map((lvl) =>
          `<option value="${lvl}" ${data.level === lvl ? 'selected' : ''}>${lvl}</option>`).join('')}
      </select>
    </label>
    <label>Division <input id="${prefix}Division" type="text" value="${data.division || ''}" /></label>
    <label>Location <input id="${prefix}Location" type="text" value="${data.location || ''}" /></label>
    <label>Apex Seller <input id="${prefix}Seller" type="text" value="${data.seller || ''}" /></label>
    <label>Seller Territory <input id="${prefix}SellerTerritory" type="text" value="${data.seller_territory || ''}" /></label>
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
        await loadOrgData(currentOrgId);
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
          await loadOrgData(currentOrgId);
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
          await loadOrgData(currentOrgId);
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
    <label>Reports To <select id="edManager"></select></label>
    <p id="editError" class="modal-error"></p>
    <div class="modal-actions">
      <button id="saveDetailBtn">Save changes</button>
      <button id="markDepartedBtn" class="danger">Mark as Departed</button>
    </div>
  `;

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
      await loadOrgData(currentOrgId);
    }
  });

  document.getElementById('markDepartedBtn').addEventListener('click', async () => {
    if (!confirm(`Mark ${data.name} as departed? Their card will become a vacant placeholder; nobody is reassigned until you act on it later.`)) return;
    const res = await editFetch(`/api/orgs/${currentOrgId}/employees/${data.id}/mark-departed`, {
      method: 'POST',
    });
    if (res) {
      panel.classList.remove('open');
      await loadOrgData(currentOrgId);
    }
  });

  panel.classList.remove('hidden');
  panel.classList.add('open');
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

// ---------- Search ----------

function focusOnPerson(name) {
  const id = nameToId.get(name);
  if (!id) return;
  isolatePerson(id);
  chart.setUpToTheRootHighlighted(id).setCentered(id).render().fit();
  scheduleRectRefresh();
}

// ---------- Org loading ----------

async function loadOrgData(orgId) {
  currentOrgId = orgId;
  currentIsolatedId = null;
  greyedSiblingIds = new Set();
  const [treeRes, metaRes] = await Promise.all([
    fetch(`/api/orgs/${orgId}/tree`),
    fetch(`/api/orgs/${orgId}/meta`),
  ]);
  const tree = await treeRes.json();
  const meta = await metaRes.json();

  sellerColorMap = new Map();
  flatData = flatten(tree, []);
  originalOrder = flatData.slice();
  nameToId = new Map(flatData.map((d) => [d.name, d.id]));

  meta.sellers.forEach((s) => colorForSeller(s));
  buildAmFilter();

  renderChart(flatData);
  applyDepthLimit();

  const dataList = document.getElementById('employee-list');
  dataList.innerHTML = meta.people
    .filter((p) => p.status === 'active')
    .map((p) => `<option value="${p.name}">${p.title || ''}</option>`)
    .join('');
}

async function loadOrgSwitcher(selectOrgId) {
  const res = await fetch('/api/orgs');
  const orgs = await res.json();
  const switcher = document.getElementById('orgSwitcher');
  switcher.innerHTML = orgs.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');
  const target = selectOrgId || Number(localStorage.getItem('skunkworks_org_id')) || orgs[0]?.id;
  if (target) {
    switcher.value = String(target);
    localStorage.setItem('skunkworks_org_id', String(target));
    await loadOrgData(target);
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

  document.getElementById('chart').addEventListener('mousemove', handleChartMouseMove);
  window.addEventListener('resize', () => scheduleRectRefresh());

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
  });

  document.getElementById('sortBy').addEventListener('change', (e) => applySort(e.target.value));

  document.getElementById('depthSlider').addEventListener('input', (e) => {
    depthSliderValue = Number(e.target.value);
    document.getElementById('depthValue').textContent = String(depthSliderValue);
    applyDepthLimit();
  });

  document.getElementById('closeDetail').addEventListener('click', () => {
    document.getElementById('detailPanel').classList.remove('open');
  });

  document.getElementById('priorityFilter').addEventListener('change', (e) => {
    showOnlyFlagged = e.target.checked;
    chart.render();
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
