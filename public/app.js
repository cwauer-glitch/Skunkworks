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

// Performs a mutating request, prompting for a passcode if none is cached yet,
// and re-prompting (clearing the bad one) if the server rejects it.
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

// ---------- Tree building ----------

function flatten(node, out) {
  out.push({ ...node, children: undefined });
  for (const child of node.children || []) {
    flatten(child, out);
  }
  return out;
}

function buildLegend() {
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  for (const [seller, color] of sellerColorMap.entries()) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-swatch" style="background:${color}"></span>${seller}`;
    legend.appendChild(item);
  }
}

function nodeContent(d) {
  const data = d.data;

  if (data.status === 'vacant') {
    return `
      <div style="width:220px; border:3px solid #d33; border-radius:8px; background:#fdeaea; padding:8px 10px; font-family:inherit;">
        <div class="node-card-title" style="color:#a00;">VACANT</div>
        <div class="node-card-sub">previously: ${data.departed_name || 'Unknown'}</div>
        <div class="node-card-sub">${data.location || ''}</div>
      </div>
    `;
  }

  const color = colorForSeller(data.seller);
  const dim = showOnlyFlagged && data.priority_signal !== 'high';
  const badge = data.priority_signal === 'high'
    ? '<span class="priority-badge priority-high" title="High priority signal">★</span>'
    : data.priority_signal === 'watch'
      ? '<span class="priority-badge priority-watch" title="Watching">•</span>'
      : '';

  return `
    <div style="position:relative; width:220px; border:2px solid ${color}; border-radius:8px; background:#fff; padding:8px 10px; font-family:inherit; opacity:${dim ? 0.25 : 1};">
      ${badge}
      <div class="node-card-title">${data.name}</div>
      <div class="node-card-sub">${data.title || ''}</div>
      <div class="node-card-sub">${data.location || ''}</div>
      ${data.seller ? `<div class="node-card-sub" style="color:${color}; font-weight:600;">${data.seller}</div>` : ''}
    </div>
  `;
}

function renderChart(data) {
  document.getElementById('chart').innerHTML = '';
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
    .onNodeClick((d) => showDetail(d.data))
    .render();
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

function showDetail(data) {
  const panel = document.getElementById('detailPanel');
  const content = document.getElementById('detailContent');

  if (data.status === 'vacant') {
    content.innerHTML = `
      <h2 style="color:#a00;">Vacant Slot</h2>
      <p>Previously: <strong>${data.departed_name || 'Unknown'}</strong></p>
      <p>Location: ${data.location || '—'} &middot; Division: ${data.division || '—'}</p>
      <p>Apex Seller: ${data.seller || '—'} ${data.seller_territory ? `(${data.seller_territory})` : ''}</p>
      <hr />
      <label>Reassign direct reports to:
        <select id="reassignTarget"></select>
      </label>
      <div class="modal-actions">
        <button id="removeVacantBtn" class="danger">Remove this vacant slot</button>
      </div>
    `;
    const select = document.getElementById('reassignTarget');
    managerOptions(select, data.id);
    document.getElementById('removeVacantBtn').addEventListener('click', async () => {
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
    panel.classList.remove('hidden');
    panel.classList.add('open');
    return;
  }

  content.innerHTML = `
    <h2>${data.name}</h2>
    <label>Name <input id="edName" type="text" value="${data.name || ''}" /></label>
    <label>Title <input id="edTitle" type="text" value="${data.title || ''}" /></label>
    <label>Division <input id="edDivision" type="text" value="${data.division || ''}" /></label>
    <label>Location <input id="edLocation" type="text" value="${data.location || ''}" /></label>
    <label>Apex Seller <input id="edSeller" type="text" value="${data.seller || ''}" /></label>
    <label>Seller Territory <input id="edSellerTerritory" type="text" value="${data.seller_territory || ''}" /></label>
    <label>Reports To <select id="edManager"></select></label>
    <label>Priority Tags <input id="edPriorityTags" type="text" value="${data.priority_tags || ''}" /></label>
    <label>Priority Goal <textarea id="edPriorityGoal">${data.priority_goal || ''}</textarea></label>
    <label>Priority Signal
      <select id="edPrioritySignal">
        <option value="none" ${data.priority_signal === 'none' ? 'selected' : ''}>None</option>
        <option value="watch" ${data.priority_signal === 'watch' ? 'selected' : ''}>Watch</option>
        <option value="high" ${data.priority_signal === 'high' ? 'selected' : ''}>High</option>
      </select>
    </label>
    <p id="editError" class="modal-error"></p>
    <div class="modal-actions">
      <button id="saveDetailBtn">Save changes</button>
      ${data.manager_id !== null ? '<button id="markDepartedBtn" class="danger">Mark as Departed</button>' : ''}
    </div>
  `;

  const managerSelect = document.getElementById('edManager');
  managerOptions(managerSelect, data.id);
  managerSelect.value = data.manager_id != null ? String(data.manager_id) : '';

  document.getElementById('saveDetailBtn').addEventListener('click', async () => {
    const body = {
      name: document.getElementById('edName').value.trim(),
      title: document.getElementById('edTitle').value.trim(),
      division: document.getElementById('edDivision').value.trim(),
      location: document.getElementById('edLocation').value.trim(),
      seller: document.getElementById('edSeller').value.trim(),
      seller_territory: document.getElementById('edSellerTerritory').value.trim(),
      priority_tags: document.getElementById('edPriorityTags').value.trim(),
      priority_goal: document.getElementById('edPriorityGoal').value.trim(),
      priority_signal: document.getElementById('edPrioritySignal').value,
      manager_id: managerSelect.value ? Number(managerSelect.value) : null,
    };
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

  const markDepartedBtn = document.getElementById('markDepartedBtn');
  if (markDepartedBtn) {
    markDepartedBtn.addEventListener('click', async () => {
      if (!confirm(`Mark ${data.name} as departed? Their card will become a vacant placeholder; nobody is reassigned until you finalize it later.`)) return;
      const res = await editFetch(`/api/orgs/${currentOrgId}/employees/${data.id}/mark-departed`, {
        method: 'POST',
      });
      if (res) {
        panel.classList.remove('open');
        await loadOrgData(currentOrgId);
      }
    });
  }

  panel.classList.remove('hidden');
  panel.classList.add('open');
}

// ---------- Sort / expand helpers ----------

function applySort(mode) {
  if (mode === 'none') {
    chart.data(originalOrder).render();
    return;
  }
  const key = mode === 'seller' ? 'seller' : 'location';
  const sorted = [...flatData].sort((a, b) => (a[key] || '').localeCompare(b[key] || ''));
  chart.data(sorted).render();
}

function collapseToDirectors() {
  chart.collapseAll();
  flatData
    .filter((d) => ['CTO', 'SVP', 'VP'].includes(d.level))
    .forEach((d) => chart.setExpanded(d.id, true));
  chart.render().fit();
}

function expandSubtree(rootId) {
  const childrenByParent = new Map();
  for (const d of flatData) {
    if (d.manager_id == null) continue;
    if (!childrenByParent.has(d.manager_id)) childrenByParent.set(d.manager_id, []);
    childrenByParent.get(d.manager_id).push(d.id);
  }
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    chart.setExpanded(id, true);
    (childrenByParent.get(id) || []).forEach((childId) => stack.push(childId));
  }
}

function focusOnPerson(name) {
  const id = nameToId.get(name);
  if (!id) return;
  chart.clearHighlighting();
  collapseToDirectors();
  chart.setUpToTheRootHighlighted(id).setCentered(id);
  expandSubtree(id);
  chart.render().fit();
}

// ---------- Org loading ----------

async function loadOrgData(orgId) {
  currentOrgId = orgId;
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
  buildLegend();

  renderChart(flatData);
  collapseToDirectors();

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

// ---------- Modals ----------

function setupModal(modalId, cancelId) {
  const modal = document.getElementById(modalId);
  document.getElementById(cancelId).addEventListener('click', () => modal.classList.add('hidden'));
}

async function init() {
  await loadOrgSwitcher();

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
    collapseToDirectors();
  });

  document.getElementById('sortBy').addEventListener('change', (e) => applySort(e.target.value));
  document.getElementById('expandAllBtn').addEventListener('click', () => chart.expandAll().fit());
  document.getElementById('collapseBtn').addEventListener('click', collapseToDirectors);
  document.getElementById('closeDetail').addEventListener('click', () => {
    document.getElementById('detailPanel').classList.remove('open');
  });

  document.getElementById('priorityFilter').addEventListener('change', (e) => {
    showOnlyFlagged = e.target.checked;
    chart.render();
  });

  document.getElementById('resetOrgBtn').addEventListener('click', async () => {
    if (!confirm('Reset this organization back to its original imported data? All edits will be lost.')) return;
    const res = await editFetch(`/api/orgs/${currentOrgId}/reset`, { method: 'POST' });
    if (res) await loadOrgData(currentOrgId);
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
