import sqlite3
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parent.parent
SOURCE_XLSX = ROOT / "data" / "tarc_org.xlsx"
DB_PATH = ROOT / "server" / "tarc.db"

wb = openpyxl.load_workbook(SOURCE_XLSX, data_only=True)
ws = wb["Full Directory"]
rows = list(ws.iter_rows(min_row=2, values_only=True))

conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

cur.executescript("""
DROP TABLE IF EXISTS employees;
CREATE TABLE employees (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT,
    level TEXT,
    division TEXT,
    location TEXT,
    seller TEXT,
    seller_territory TEXT,
    reports_to TEXT,
    priority_tags TEXT,
    priority_goal TEXT
);
CREATE INDEX idx_employees_name ON employees(name);
CREATE INDEX idx_employees_reports_to ON employees(reports_to);
CREATE INDEX idx_employees_seller ON employees(seller);
""")

PLACEHOLDER_CHARS = {"�", "—", "-", "N/A", "n/a"}

def clean(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text or text in PLACEHOLDER_CHARS:
        return None
    return text

inserted = 0
for row in rows:
    emp_id, name, title, level, division, location, seller, seller_territory, reports_to, priority_tags, priority_goal = row
    cur.execute(
        """INSERT INTO employees
           (id, name, title, level, division, location, seller, seller_territory, reports_to, priority_tags, priority_goal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            emp_id,
            clean(name),
            clean(title),
            clean(level),
            clean(division),
            clean(location),
            clean(seller),
            clean(seller_territory),
            clean(reports_to),
            clean(priority_tags),
            clean(priority_goal),
        ),
    )
    inserted += 1

conn.commit()
conn.close()
print(f"Imported {inserted} employees into {DB_PATH}")
