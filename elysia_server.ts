import { Elysia } from "elysia";

// Ini simulasi database antrean tugas (Task Queue)
let pendingTasks: string[] = [
  "Tolong buatkan file sapaan.txt yang isinya 'Halo dari Antigravity!'"
];

const app = new Elysia()
  // Endpoint untuk diambil (di-pull) oleh Antigravity Client
  .get("/api/tasks/pending", () => {
    if (pendingTasks.length > 0) {
      const task = pendingTasks.shift(); // Ambil tugas teratas dan keluarkan dari antrean
      return { has_task: true, task: task };
    }
    return { has_task: false };
  })
  
  // Endpoint untuk menerima laporan jika tugas sudah selesai
  .post("/api/tasks/complete", ({ body }) => {
    console.log("\n✅ [SERVER] Laporan tugas selesai diterima dari Agen:");
    console.log(body);
    return { success: true };
  })
  .listen(3000);

console.log(`🦊 Elysia Server berjalan di http://${app.server?.hostname}:${app.server?.port}`);
console.log(`Menunggu agen melakukan polling...`);
