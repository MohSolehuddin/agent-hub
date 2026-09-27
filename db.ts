import { Database } from "bun:sqlite";

// Membuat atau membuka database SQLite
export const db = new Database("agent_tasks.sqlite", { create: true });

// Membuat tabel jika belum ada
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_prompt TEXT NOT NULL,
    target_project TEXT NOT NULL,
    server_task_id INTEGER,
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, RUNNING, SUCCESS, FAILED
    stdout TEXT,
    stderr TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
