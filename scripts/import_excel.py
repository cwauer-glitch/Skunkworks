import json
import sqlite3
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parent.parent
SOURCE_XLSX = ROOT / "data" / "tarc_org.xlsx"
DB_PATH = ROOT / "server" / "tarc.db"
ORG_NAME = "TARC, Inc."

PLACEHOLDER_CHARS = {"�", "—", "-", "N/A", "n/a"}


def clean(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text or text in PLACEHOLDER_CHARS:
        return None
    return text


wb = openpyxl.load_workbook(SOURCE_XLSX, data_only=True)
ws = wb["Full Directory"]
rows = list(ws.iter_rows(min_row=2, values_only=True))

conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

cur.executescript("""
DROP TABLE IF EXISTS org_versions;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS organizations;

CREATE TABLE organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    snapshot_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE employees (
    id INTEGER PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    title TEXT,
    level TEXT,
    division TEXT,
    location TEXT,
    seller TEXT,
    seller_territory TEXT,
    manager_id INTEGER REFERENCES employees(id),
    status TEXT NOT NULL DEFAULT 'active',
    departed_name TEXT,
    priority_tags TEXT,
    priority_goal TEXT,
    priority_signal TEXT NOT NULL DEFAULT 'none',
    notes_json TEXT NOT NULL DEFAULT '[]',
    custom_fields_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_employees_org ON employees(org_id);
CREATE INDEX idx_employees_manager ON employees(manager_id);
CREATE INDEX idx_employees_seller ON employees(seller);
""")

cur.execute("INSERT INTO organizations (name) VALUES (?)", (ORG_NAME,))
org_id = cur.lastrowid

# Every row's ID column is already a unique integer, so we can resolve
# "Reports To" names to manager ids in a single pass without a second lookup query.
name_to_id = {}
for row in rows:
    emp_id, name = row[0], clean(row[1])
    if name:
        name_to_id[name] = emp_id

inserted_rows = []
for row in rows:
    emp_id, name, title, level, division, location, seller, seller_territory, reports_to, priority_tags, priority_goal = row
    manager_name = clean(reports_to)
    manager_id = name_to_id.get(manager_name) if manager_name else None
    record = {
        "id": emp_id,
        "org_id": org_id,
        "name": clean(name),
        "title": clean(title),
        "level": clean(level),
        "division": clean(division),
        "location": clean(location),
        "seller": clean(seller),
        "seller_territory": clean(seller_territory),
        "manager_id": manager_id,
        "status": "active",
        "departed_name": None,
        "priority_tags": clean(priority_tags),
        "priority_goal": clean(priority_goal),
        "priority_signal": "none",
        "notes_json": "[]",
        "custom_fields_json": "[]",
    }
    inserted_rows.append(record)
    cur.execute(
        """INSERT INTO employees
           (id, org_id, name, title, level, division, location, seller, seller_territory,
            manager_id, status, departed_name, priority_tags, priority_goal, priority_signal, notes_json, custom_fields_json)
           VALUES (:id, :org_id, :name, :title, :level, :division, :location, :seller, :seller_territory,
                   :manager_id, :status, :departed_name, :priority_tags, :priority_goal, :priority_signal, :notes_json, :custom_fields_json)""",
        record,
    )

cur.execute(
    "UPDATE organizations SET snapshot_json = ? WHERE id = ?",
    (json.dumps(inserted_rows), org_id),
)

conn.commit()
conn.close()
print(f"Imported {len(inserted_rows)} employees into org '{ORG_NAME}' (org_id={org_id}) at {DB_PATH}")
