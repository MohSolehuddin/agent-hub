import { Database } from "bun:sqlite";

// Membuka/membuat database lokal agent-hub
export const db = new Database("agent_tasks.sqlite", { create: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_prompt TEXT NOT NULL,
    target_project TEXT NOT NULL,
    server_task_id TEXT,
    server_task_ref TEXT,
    timeout_minutes INTEGER DEFAULT 30,
    model_used TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, RUNNING, COMPLETED, FAILED
    stdout TEXT,
    stderr TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migrasi ringan untuk DB lama (kolom baru) — aman diulang.
for (const ddl of [
  "ALTER TABLE tasks ADD COLUMN server_task_ref TEXT",
  "ALTER TABLE tasks ADD COLUMN timeout_minutes INTEGER DEFAULT 30",
  "ALTER TABLE tasks ADD COLUMN model_used TEXT",
]) {
  try {
    db.exec(ddl);
  } catch {
    // kolom sudah ada -> abaikan
  }
}
