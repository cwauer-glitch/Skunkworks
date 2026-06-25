const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const SEED_DB_PATH = path.join(__dirname, 'tarc.db');
const DB_PATH = process.env.DB_PATH || SEED_DB_PATH;
const EDIT_PASSCODE = process.env.EDIT_PASSCODE || '';

// On a fresh Railway volume, DB_PATH won't exist yet - seed it from the
// committed snapshot. The seed file itself is never mutated.
if (DB_PATH !== SEED_DB_PATH && !fs.existsSync(DB_PATH)) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.copyFileSync(SEED_DB_PATH, DB_PATH);
  console.log(`Seeded new database at ${DB_PATH} from ${SEED_DB_PATH}`);
}

const db = new Database(DB_PATH);
console.log(`Skunkworks database open at ${DB_PATH}`);

// Version history: every mutation snapshots the org's full employee state.
// Runs on every boot so it also migrates the already-deployed Railway DB.
db.exec(`
  CREATE TABLE IF NOT EXISTS org_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_org_versions_org ON org_versions(org_id);
`);

function recordVersion(orgId) {
  const rows = db.prepare('SELECT * FROM employees WHERE org_id = ?').all(orgId);
  db.prepare('INSERT INTO org_versions (org_id, snapshot_json) VALUES (?, ?)').run(orgId, JSON.stringify(rows));
}

// Notes live as a JSON array right on the employee row, so they're
// automatically captured by recordVersion()/restore without any extra
// plumbing. Migrates the already-deployed Railway DB on boot too.
const employeeColumns = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
if (!employeeColumns.includes('notes_json')) {
  db.exec("ALTER TABLE employees ADD COLUMN notes_json TEXT NOT NULL DEFAULT '[]'");
}

// Seed version 1 for any org that doesn't have history yet (first boot after
// this migration, or an org created before version history existed).
for (const org of db.prepare('SELECT id FROM organizations').all()) {
  const hasHistory = db.prepare('SELECT COUNT(*) AS c FROM org_versions WHERE org_id = ?').get(org.id).c > 0;
  if (!hasHistory) recordVersion(org.id);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

if (!EDIT_PASSCODE) {
  console.warn('WARNING: EDIT_PASSCODE is not set - all edit endpoints are open to anyone with the link.');
}

function requirePasscode(req, res, next) {
  if (!EDIT_PASSCODE) return next();
  if (req.get('x-edit-passcode') === EDIT_PASSCODE) return next();
  res.status(401).json({ error: 'Invalid or missing edit passcode' });
}

function buildTreeFromRows(rows) {
  const byId = new Map(rows.map((row) => [row.id, { ...row, children: [] }]));
  let root = null;

  for (const node of byId.values()) {
    if (!node.manager_id) {
      root = node;
      continue;
    }
    const parent = byId.get(node.manager_id);
    if (parent) {
      parent.children.push(node);
    } else if (root) {
      root.children.push(node);
    }
  }

  return root;
}

function buildTree(orgId) {
  return buildTreeFromRows(db.prepare('SELECT * FROM employees WHERE org_id = ?').all(orgId));
}

// True if `candidateId` is `employeeId` itself, or one of its descendants -
// i.e. setting employeeId's manager to candidateId would create a cycle.
function isSelfOrDescendant(orgId, employeeId, candidateId) {
  if (employeeId === candidateId) return true;
  const children = db.prepare('SELECT id FROM employees WHERE org_id = ? AND manager_id = ?').all(orgId, employeeId);
  return children.some((c) => isSelfOrDescendant(orgId, c.id, candidateId));
}

app.get('/api/orgs', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM organizations ORDER BY name').all());
});

app.post('/api/orgs', requirePasscode, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Organization name is required' });
  try {
    const result = db.prepare('INSERT INTO organizations (name) VALUES (?)').run(name);
    recordVersion(result.lastInsertRowid);
    res.status(201).json({ id: result.lastInsertRowid, name });
  } catch (err) {
    res.status(409).json({ error: 'An organization with that name already exists' });
  }
});

app.get('/api/orgs/:orgId/tree', (req, res) => {
  const tree = buildTree(Number(req.params.orgId));
  if (!tree) return res.status(404).json({ error: 'Organization has no employees yet' });
  res.json(tree);
});

app.get('/api/orgs/:orgId/meta', (req, res) => {
  const orgId = Number(req.params.orgId);
  const sellers = db.prepare("SELECT DISTINCT seller FROM employees WHERE org_id = ? AND seller IS NOT NULL ORDER BY seller").all(orgId).map((r) => r.seller);
  const locations = db.prepare("SELECT DISTINCT location FROM employees WHERE org_id = ? AND location IS NOT NULL ORDER BY location").all(orgId).map((r) => r.location);
  const people = db.prepare("SELECT id, name, title, status FROM employees WHERE org_id = ? ORDER BY name").all(orgId);
  res.json({ sellers, locations, people });
});

app.get('/api/orgs/:orgId/versions', (req, res) => {
  const orgId = Number(req.params.orgId);
  res.json(db.prepare('SELECT id, created_at FROM org_versions WHERE org_id = ? ORDER BY id DESC').all(orgId));
});

app.get('/api/orgs/:orgId/versions/:versionId', (req, res) => {
  const orgId = Number(req.params.orgId);
  const versionId = Number(req.params.versionId);
  const version = db.prepare('SELECT * FROM org_versions WHERE org_id = ? AND id = ?').get(orgId, versionId);
  if (!version) return res.status(404).json({ error: 'Version not found' });
  res.json({ createdAt: version.created_at, tree: buildTreeFromRows(JSON.parse(version.snapshot_json)) });
});

const EMPLOYEE_COLUMNS = [
  'id', 'org_id', 'name', 'title', 'level', 'division', 'location', 'seller', 'seller_territory',
  'manager_id', 'status', 'departed_name', 'priority_tags', 'priority_goal', 'priority_signal',
  'notes_json',
];

function insertEmployeeRow(record) {
  const columns = EMPLOYEE_COLUMNS.filter((c) => c in record);
  const placeholders = columns.map((c) => `:${c}`).join(', ');
  db.prepare(`INSERT INTO employees (${columns.join(', ')}) VALUES (${placeholders})`).run(record);
}

app.post('/api/orgs/:orgId/versions/:versionId/restore', requirePasscode, (req, res) => {
  const orgId = Number(req.params.orgId);
  const versionId = Number(req.params.versionId);
  const version = db.prepare('SELECT snapshot_json FROM org_versions WHERE org_id = ? AND id = ?').get(orgId, versionId);
  if (!version) return res.status(404).json({ error: 'Version not found' });

  const rows = JSON.parse(version.snapshot_json);
  const restoreTx = db.transaction(() => {
    db.prepare('DELETE FROM employees WHERE org_id = ?').run(orgId);
    for (const record of rows) insertEmployeeRow(record);
  });
  restoreTx();
  recordVersion(orgId); // restoring is itself a tracked change - history is append-only

  res.json({ restored: rows.length });
});

const EDITABLE_FIELDS = [
  'name', 'title', 'level', 'division', 'location', 'seller', 'seller_territory',
  'priority_tags', 'priority_goal', 'priority_signal',
];

app.patch('/api/orgs/:orgId/employees/:id', requirePasscode, (req, res) => {
  const orgId = Number(req.params.orgId);
  const id = Number(req.params.id);
  const employee = db.prepare('SELECT * FROM employees WHERE org_id = ? AND id = ?').get(orgId, id);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  const updates = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in req.body) updates[field] = req.body[field];
  }

  if ('manager_id' in req.body) {
    const managerId = req.body.manager_id === null ? null : Number(req.body.manager_id);
    if (managerId !== null) {
      const manager = db.prepare('SELECT id FROM employees WHERE org_id = ? AND id = ?').get(orgId, managerId);
      if (!manager) return res.status(400).json({ error: 'Proposed manager does not exist in this organization' });
      if (isSelfOrDescendant(orgId, id, managerId)) {
        return res.status(400).json({ error: 'Cannot reassign to yourself or one of your own direct/indirect reports' });
      }
    } else if (employee.manager_id !== null) {
      return res.status(400).json({ error: 'Only the top of the org chart can have no manager' });
    }
    updates.manager_id = managerId;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No editable fields provided' });
  }

  const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE employees SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
  recordVersion(orgId);
  res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
});

// Notes are newest-first in storage, so the client never has to re-sort.
app.post('/api/orgs/:orgId/employees/:id/notes', requirePasscode, (req, res) => {
  const orgId = Number(req.params.orgId);
  const id = Number(req.params.id);
  const employee = db.prepare('SELECT * FROM employees WHERE org_id = ? AND id = ?').get(orgId, id);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Note text is required' });

  const notes = JSON.parse(employee.notes_json || '[]');
  notes.unshift({ text, created_at: new Date().toISOString() });
  db.prepare('UPDATE employees SET notes_json = ? WHERE id = ?').run(JSON.stringify(notes), id);
  recordVersion(orgId);

  res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
});

app.post('/api/orgs/:orgId/employees', requirePasscode, (req, res) => {
  const orgId = Number(req.params.orgId);
  const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  let managerId = req.body.manager_id === undefined || req.body.manager_id === null ? null : Number(req.body.manager_id);
  if (managerId !== null) {
    const manager = db.prepare('SELECT id FROM employees WHERE org_id = ? AND id = ?').get(orgId, managerId);
    if (!manager) return res.status(400).json({ error: 'Proposed manager does not exist in this organization' });
  }

  const nextId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM employees').get().nextId;
  const record = {
    id: nextId,
    org_id: orgId,
    name,
    title: req.body.title || null,
    level: req.body.level || null,
    division: req.body.division || null,
    location: req.body.location || null,
    seller: req.body.seller || null,
    seller_territory: req.body.seller_territory || null,
    manager_id: managerId,
    status: 'active',
    departed_name: null,
    priority_tags: req.body.priority_tags || null,
    priority_goal: req.body.priority_goal || null,
    priority_signal: req.body.priority_signal || 'none',
  };

  insertEmployeeRow(record);
  recordVersion(orgId);
  res.status(201).json(record);
});

app.post('/api/orgs/:orgId/employees/:id/mark-departed', requirePasscode, (req, res) => {
  const orgId = Number(req.params.orgId);
  const id = Number(req.params.id);
  const employee = db.prepare('SELECT * FROM employees WHERE org_id = ? AND id = ?').get(orgId, id);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  db.prepare("UPDATE employees SET status = 'vacant', departed_name = ? WHERE id = ?")
    .run(`${employee.name}${employee.title ? `, ${employee.title}` : ''}`, id);
  recordVersion(orgId);

  res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
});

// Refills a vacant slot in place - same row, same manager_id, same direct
// reports, just new identity fields and status flipped back to active. This
// is also how a departed CTO/root gets replaced.
app.post('/api/orgs/:orgId/employees/:id/fill', requirePasscode, (req, res) => {
  const orgId = Number(req.params.orgId);
  const id = Number(req.params.id);
  const employee = db.prepare('SELECT * FROM employees WHERE org_id = ? AND id = ?').get(orgId, id);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (employee.status !== 'vacant') return res.status(400).json({ error: 'Only a vacant slot can be filled' });

  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const updates = {
    name,
    title: req.body.title || null,
    level: req.body.level || null,
    division: req.body.division || null,
    location: req.body.location || null,
    seller: req.body.seller || null,
    seller_territory: req.body.seller_territory || null,
    priority_tags: req.body.priority_tags || null,
    priority_goal: req.body.priority_goal || null,
    priority_signal: req.body.priority_signal || 'none',
    status: 'active',
    departed_name: null,
  };
  const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE employees SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
  recordVersion(orgId);

  res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
});

app.post('/api/orgs/:orgId/employees/:id/finalize-removal', requirePasscode, (req, res) => {
  const orgId = Number(req.params.orgId);
  const id = Number(req.params.id);
  const employee = db.prepare('SELECT * FROM employees WHERE org_id = ? AND id = ?').get(orgId, id);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (employee.status !== 'vacant') return res.status(400).json({ error: 'Only a vacant slot can be finalized' });
  if (employee.manager_id === null) {
    return res.status(400).json({ error: 'The top of the org chart cannot be permanently removed - use "Fill this position" to replace them instead.' });
  }

  const reassignTo = req.body.reassignTo === undefined || req.body.reassignTo === null ? null : Number(req.body.reassignTo);
  if (reassignTo !== null) {
    const target = db.prepare("SELECT id FROM employees WHERE org_id = ? AND id = ? AND status = 'active'").get(orgId, reassignTo);
    if (!target) return res.status(400).json({ error: 'Reassignment target must be an existing active employee' });
    if (isSelfOrDescendant(orgId, id, reassignTo)) {
      return res.status(400).json({ error: 'Cannot reassign direct reports to one of their own (former) descendants' });
    }
  }

  const directReports = db.prepare('SELECT id FROM employees WHERE org_id = ? AND manager_id = ?').all(orgId, id);
  if (directReports.length > 0 && reassignTo === null) {
    return res.status(400).json({ error: 'This vacant slot has direct reports - choose who they should report to before removing it' });
  }

  const update = db.transaction(() => {
    db.prepare('UPDATE employees SET manager_id = ? WHERE org_id = ? AND manager_id = ?').run(reassignTo, orgId, id);
    db.prepare('DELETE FROM employees WHERE id = ?').run(id);
  });
  update();
  recordVersion(orgId);

  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Skunkworks server listening on port ${PORT}`);
});
