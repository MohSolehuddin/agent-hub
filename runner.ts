import { Elysia } from "elysia";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import { db } from "./db";
import { homedir } from "os";
import { join } from "path";
import fs from "fs";

const execAsync = promisify(exec);

// Konfigurasi
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const DEFAULT_WORKSPACE = join(homedir(), "project/have-fun/personal-tools");
const TIMEOUT_MS = 15 * 60 * 1000; // 15 menit

let isRunning = false;

// 1. Fungsi Fetcher (Mengambil Tugas dari Server Utama)
async function fetchTasksFromServer() {
  try {
    const response = await fetch(`${SERVER_URL}/api/tasks/pending`);
    if (!response.ok) return;
    const data = await response.json();
    
    if (data.has_task && data.task) {
      const target_project = data.project_path || DEFAULT_WORKSPACE;
      // Simpan ke database lokal
      const insert = db.prepare(`INSERT INTO tasks (task_prompt, target_project, server_task_id, status) VALUES (?, ?, ?, 'PENDING')`);
      insert.run(data.task, target_project, data.id || null);
      console.log(`[⬇️] Tugas baru diunduh dari server dan dimasukkan ke antrean lokal.`);
    }
  } catch (err) {
    // Abaikan jika server utama mati, agar log tidak penuh
  }
}

// 2. Fungsi Worker (Menjalankan Antrean dari Database Lokal secara Sekuensial)
async function processLocalTasks() {
  // Cegah tumpang tindih eksekusi AI (1 AI pada 1 waktu)
  if (isRunning) return; 
  
  const getPendingTask = db.query(`SELECT * FROM tasks WHERE status = 'PENDING' ORDER BY id ASC LIMIT 1`);
  const task = getPendingTask.get() as any;

  if (!task) return; // Tidak ada antrean

  isRunning = true;
  console.log(`\n[⚙️] Memulai eksekusi tugas ID: ${task.id} (Server ID: ${task.server_task_id})`);
  
  const targetProject = task.target_project || DEFAULT_WORKSPACE;
  
  // Pastikan path target ada dan punya izin
  if (!fs.existsSync(targetProject)) {
    console.error(`[!] Workspace tidak ditemukan: ${targetProject}`);
    db.run(`UPDATE tasks SET status = 'FAILED', stderr = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, ["Workspace tidak ditemukan", task.id]);
    await sendCallback(task.server_task_id, "FAILED", 1, "", "Workspace tidak ditemukan");
    isRunning = false;
    return;
  }

  db.run(`UPDATE tasks SET status = 'RUNNING', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [task.id]);

  // Command agy (Bun spawn)
  const agyArgs = ["-p", task.task_prompt, "--dangerously-skip-permissions", "--add-dir", targetProject];

  let stdoutData = "";
  let stderrData = "";
  let gitStatus = "";
  let gitLog = "";
  
  try {
    const child = spawn("agy", agyArgs, {
      cwd: targetProject,
      env: process.env
    });

    let timeoutId = setTimeout(() => {
      console.log(`[!] Timeout tercapai. Menghentikan tugas ID ${task.id}...`);
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    // Streaming stdout
    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdoutData += text;
      // Update DB realtime
      db.run(`UPDATE tasks SET stdout = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [stdoutData, task.id]);
    });

    // Streaming stderr
    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderrData += text;
      db.run(`UPDATE tasks SET stderr = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [stderrData, task.id]);
    });

    child.on("close", async (code) => {
      clearTimeout(timeoutId);
      
      const isSuccess = code === 0;
      let finalStatus = isSuccess ? "SUCCESS" : "FAILED";
      
      if (isSuccess) {
         try {
           const { stdout: gStat } = await execAsync("git status --porcelain", { cwd: targetProject });
           const { stdout: gLog } = await execAsync("git log -1 --oneline", { cwd: targetProject });
           gitStatus = gStat;
           gitLog = gLog;
           stdoutData += `\n\n--- Post-Execution Verification ---\nGit Status:\n${gitStatus}\nGit Log:\n${gitLog}`;
         } catch(e: any) {
           stdoutData += `\n\n[!] Gagal menjalankan verifikasi git: ${e.message}`;
         }
      }

      db.run(`UPDATE tasks SET status = ?, stdout = ?, stderr = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, 
        [finalStatus, stdoutData, stderrData, task.id]);
      
      console.log(`[${isSuccess ? "✅" : "❌"}] Tugas ID ${task.id} selesai dengan exit code ${code}.`);

      const outputTail = stdoutData.slice(-1000);
      const errorMsg = isSuccess ? "" : stderrData.slice(-1000);
      
      await sendCallback(task.server_task_id, isSuccess ? "COMPLETED" : "FAILED", code || (isSuccess ? 0 : 1), outputTail, errorMsg);
      
      isRunning = false;
    });

    child.on("error", async (error) => {
      clearTimeout(timeoutId);
      stderrData += error.message;
      db.run(`UPDATE tasks SET status = 'FAILED', stderr = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [stderrData, task.id]);
      await sendCallback(task.server_task_id, "FAILED", 1, stdoutData.slice(-1000), error.message);
      isRunning = false;
    });

  } catch (error: any) {
    db.run(`UPDATE tasks SET status = 'FAILED', stderr = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [error.message, task.id]);
    console.log(`[❌] Tugas ID ${task.id} gagal dieksekusi.`);
    await sendCallback(task.server_task_id, "FAILED", 1, stdoutData.slice(-1000), error.message);
    isRunning = false;
  }
}

async function sendCallback(serverTaskId: any, status: string, exitCode: number, outputTail: string, error: string) {
  if (!serverTaskId) return;
  try {
    await fetch(`${SERVER_URL}/api/agent-dispatcher/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: serverTaskId,
        agent: "agent-hub",
        status: status,
        exit_code: exitCode,
        output_tail: outputTail,
        error: error
      })
    });
  } catch(e) {
    console.error(`[!] Gagal mengirim webhook callback ke Personal OS.`);
  }
}

// 3. Lokal Dashboard & API menggunakan ElysiaJS
const app = new Elysia()
  // API untuk UI Dashboard membaca data dari SQLite
  .get("/api/local-tasks", () => {
    return db.query(`SELECT * FROM tasks ORDER BY id DESC LIMIT 100`).all();
  })
  // Route untuk menyajikan UI HTML
  .get("/", () => Bun.file("public/index.html"))
  .listen(4000);

console.log(`\n🚀 [Agent Hub] - Sistem Aktif!`);
console.log(`📊 Buka Dashboard UI Lokal Anda di: http://localhost:4000`);

// Menjadwalkan Loop
setInterval(fetchTasksFromServer, 10000); // Tiap 10 detik menjemput tugas dari server
setInterval(processLocalTasks, 3000);    // Tiap 3 detik mengecek DB lokal untuk eksekusi
