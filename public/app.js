const SELLER_COLORS = [
  '#3a7bd5', '#e07a5f', '#81b29a', '#f2cc8f', '#9b5de5', '#5dade2'
];

let sellerColorMap = new Map();
let chart;
let flatData = [];
let originalOrder = [];
let nameToId = new Map();

function colorForSeller(seller) {
  if (!seller) return '#9aa0a6';
  if (!sellerColorMap.has(seller)) {
    sellerColorMap.set(seller, SELLER_COLORS[sellerColorMap.size % SELLER_COLORS.length]);
  }
  return sellerColorMap.get(seller);
}

function flatten(node, parentId, out) {
  const id = String(node.id);
  out.push({
    id,
    parentId: parentId,
    name: node.name,
    title: node.title,
    level: node.level,
    division: node.division,
    location: node.location,
    seller: node.seller,
    sellerTerritory: node.seller_territory,
    reportsTo: node.reports_to,
    priorityTags: node.priority_tags,
    priorityGoal: node.priority_goal,
  });
  for (const child of node.children || []) {
    flatten(child, id, out);
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
  const color = colorForSeller(data.seller);
  return `
    <div style="width:220px; border:2px solid ${color}; border-radius:8px; background:#fff; padding:8px 10px; font-family:inherit;">
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

function showDetail(data) {
  const panel = document.getElementById('detailPanel');
  const content = document.getElementById('detailContent');
  content.innerHTML = `
    <h2>${data.name}</h2>
    <p><strong>${data.title || ''}</strong></p>
    <p>Location: ${data.location || '—'}</p>
    <p>Division: ${data.division || '—'}</p>
    <p>Apex Seller: ${data.seller || '—'} ${data.sellerTerritory ? `(${data.sellerTerritory})` : ''}</p>
    <p>Reports To: ${data.reportsTo || '—'}</p>
    <hr />
    <p><strong>Priorities:</strong> ${data.priorityTags || '—'}</p>
    <p><strong>Goal:</strong> ${data.priorityGoal || '—'}</p>
  `;
  panel.classList.remove('hidden');
  panel.classList.add('open');
}

// d3-org-chart preserves sibling left-to-right order from the input array order
// (confirmed via its stratify() usage, which has no internal sort). Re-sorting the
// flat array by seller/location before re-rendering re-orders siblings accordingly,
// while parent/child reporting lines stay intact since stratify groups by parentId.
function applySort(mode) {
  if (mode === 'none') {
    chart.data(originalOrder).render();
    return;
  }
  const key = mode === 'seller' ? 'seller' : 'location';
  const sorted = [...flatData].sort((a, b) => (a[key] || '').localeCompare(b[key] || ''));
  chart.data(sorted).render();
}

// Shows nodes through Director level; Manager/Staff stay hidden until expanded.
// setExpanded(id, true) reveals a node's children, so we expand every CTO/SVP/VP
// node (whose children include Directors) but leave Directors collapsed.
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
    if (!d.parentId) continue;
    if (!childrenByParent.has(d.parentId)) childrenByParent.set(d.parentId, []);
    childrenByParent.get(d.parentId).push(d.id);
  }
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    chart.setExpanded(id, true);
    (childrenByParent.get(id) || []).forEach((childId) => stack.push(childId));
  }
}

// Shows the selected person's full subtree plus the reporting line up to the
// CTO, without expanding the rest of the org (use Expand all for that).
function focusOnPerson(name) {
  const id = nameToId.get(name);
  if (!id) return;
  chart.clearHighlighting();
  collapseToDirectors();
  chart.setUpToTheRootHighlighted(id).setCentered(id);
  expandSubtree(id);
  chart.render().fit();
}

async function init() {
  const [treeRes, metaRes] = await Promise.all([
    fetch('/api/org-tree'),
    fetch('/api/meta'),
  ]);
  const tree = await treeRes.json();
  const meta = await metaRes.json();

  flatData = flatten(tree, null, []);
  originalOrder = flatData.slice();
  nameToId = new Map(flatData.map((d) => [d.name, d.id]));

  // Prime the seller color map in stable order.
  meta.sellers.forEach((s) => colorForSeller(s));
  buildLegend();

  renderChart(flatData);
  collapseToDirectors();

  const dataList = document.getElementById('employee-list');
  dataList.innerHTML = meta.names.map((n) => `<option value="${n.name}">${n.title || ''}</option>`).join('');

  document.getElementById('search').addEventListener('change', (e) => {
    const name = e.target.value.trim();
    if (nameToId.has(name)) {
      focusOnPerson(name);
    }
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    document.getElementById('search').value = '';
    chart.clearHighlighting();
    collapseToDirectors();
  });

  document.getElementById('sortBy').addEventListener('change', (e) => {
    applySort(e.target.value);
  });

  document.getElementById('expandAllBtn').addEventListener('click', () => {
    chart.expandAll().fit();
  });

  document.getElementById('collapseBtn').addEventListener('click', collapseToDirectors);

  document.getElementById('closeDetail').addEventListener('click', () => {
    document.getElementById('detailPanel').classList.remove('open');
  });
}

init();
