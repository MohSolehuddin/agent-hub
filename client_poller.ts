import { exec } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

// Tentukan direktori spesifik project yang akan dikerjakan
const TARGET_PROJECT_DIR = join(homedir(), "project/have-fun/personal-tools");
// Alamat server Elysia Anda
const SERVER_URL = "http://localhost:3000";

async function pollTasks() {
  try {
    // 1. Tanya ke server apakah ada tugas baru
    const response = await fetch(`${SERVER_URL}/api/tasks/pending`);
    const data = await response.json();

    if (data.has_task && data.task) {
      console.log(`\n[+] Menemukan tugas baru dari server: "${data.task}"`);
      console.log(`[+] Memulai Antigravity di background...`);

      const agyCommand = `agy -p "${data.task}" --dangerously-skip-permissions --add-dir "${TARGET_PROJECT_DIR}"`;

      try {
        // 2. Eksekusi agy di folder project spesifik
        const { stdout, stderr } = await execAsync(agyCommand, {
          cwd: TARGET_PROJECT_DIR,
          maxBuffer: 1024 * 1024 * 10,
        });

        console.log(`[+] Tugas berhasil diselesaikan.`);

        // 3. Laporkan hasilnya kembali ke server
        await fetch(`${SERVER_URL}/api/tasks/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: data.task,
            status: "success",
            output: stdout,
            error: stderr,
          }),
        });
      } catch (execError: any) {
        console.error(`[!] Gagal mengeksekusi agy:`, execError.message);
      }
    } else {
      // Tidak ada tugas, tampilkan indikator loading sederhana
      process.stdout.write(".");
    }
  } catch (err: any) {
    console.error(`\n[!] Gagal menghubungi server:`, err.message);
  }
}

// Jalankan fungsi polling setiap 10 detik (10000 ms)
console.log(`🤖 Agent Poller aktif. Mengecek tugas ke server setiap 10 detik...`);
setInterval(pollTasks, 10000);
