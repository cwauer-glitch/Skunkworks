const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tarc.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'public')));

function buildTree() {
  const rows = db.prepare('SELECT * FROM employees').all();
  const byName = new Map(rows.map((row) => [row.name, { ...row, children: [] }]));
  let root = null;

  for (const node of byName.values()) {
    if (!node.reports_to) {
      root = node;
      continue;
    }
    const parent = byName.get(node.reports_to);
    if (parent) {
      parent.children.push(node);
    } else {
      // Orphaned record (manager not found) - treat as a top-level node under root.
      root && root.children.push(node);
    }
  }

  return root;
}

app.get('/api/org-tree', (req, res) => {
  res.json(buildTree());
});

app.get('/api/meta', (req, res) => {
  const sellers = db.prepare('SELECT DISTINCT seller FROM employees WHERE seller IS NOT NULL ORDER BY seller').all().map((r) => r.seller);
  const locations = db.prepare('SELECT DISTINCT location FROM employees WHERE location IS NOT NULL ORDER BY location').all().map((r) => r.location);
  const names = db.prepare('SELECT name, title FROM employees ORDER BY name').all();
  res.json({ sellers, locations, names });
});

app.listen(PORT, () => {
  console.log(`Skunkworks server listening on port ${PORT}`);
});
