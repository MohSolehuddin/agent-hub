# Agent Hub 🤖

Hub lokal untuk menjalankan **CLI agent apa pun** (mis. Antigravity `agy`, Claude Code, Codex) secara headless: menjemput tugas dari server, mengantrekannya di SQLite, mengeksekusi satu per satu agar tidak tumpang tindih, lalu melaporkan hasilnya kembali ke server.

> Di-rename dari `antygravity-agent` (28 Sep 2026) karena perannya **general** — bukan khusus Antigravity. Sistem ini secara proaktif menjemput tugas dari server utama Anda, memasukkannya ke dalam sistem antrean lokal berbasis SQLite, mengeksekusinya satu per satu agar tidak terjadi *crash*, dan menyajikan UI Dashboard untuk memonitor hasil kerjanya.

---

## 🌟 Fitur Utama
1. **Sistem Antrean (Queue) via SQLite**: Mencegah *race condition* atau agen berjalan tumpang tindih. Jika ada 10 perintah berbarengan dari server, sistem ini akan mengeksekusinya satu demi satu secara rapi.
2. **Dashboard UI Interaktif**: Disediakan UI berbasis web (Vue.js + Tailwind) untuk memantau status setiap tugas (PENDING, RUNNING, SUCCESS, FAILED) dan melihat log eksekusi (apa saja yang dilakukan AI).
3. **Pemisahan Konteks (Decoupling)**: Aplikasi server utama Anda tidak perlu tahu bagaimana cara kerja `agy`. Server cukup memasang endpoint `GET /api/tasks/pending`, dan runner ini yang akan mengeksekusi sisanya.

## 📁 Struktur File
- `db.ts` - Konfigurasi dan inisialisasi tabel SQLite menggunakan Bun API.
- `runner.ts` - *Core logic*. Terdapat 2 *thread* utama (Fetcher dan Worker), serta Web Server API untuk melayani UI.
- `public/index.html` - *Frontend Dashboard* untuk monitoring.
- `elysia_server.ts` - *(Hanya untuk testing)* Mock server utama.

## 🚀 Cara Menjalankan (Integrasi dengan Project)

### 1. Persiapan
Pastikan Anda sudah menginstall Bun. Jika belum ada `elysia`, install dengan:
```bash
bun add elysia
```

### 2. Konfigurasi Endpoint Server Eksternal
Di dalam file `runner.ts`, ubah baris ini sesuai dengan URL server backend aplikasi Anda yang sebenarnya (Server yang akan diurus oleh tim / project lain):
```typescript
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
```
*Catatan: Pastikan server tersebut memiliki endpoint `GET /api/tasks/pending` yang mereturn JSON `{ has_task: true, task: "prompt..." }`.*

### 3. Jalankan Agent Runner
Buka terminal dan jalankan:
```bash
bun run runner.ts
```

Sistem akan langsung:
1. Membuat file database `agent_tasks.sqlite` (jika belum ada).
2. Mulai mem-polling server Anda.
3. Menjalankan Dashboard UI.

### 4. Buka Dashboard
Buka browser Anda dan navigasikan ke: **http://localhost:4000**

Anda akan melihat antarmuka monitoring secara real-time. Jika Anda mengklik tulisan **"Lihat Log"** pada tugas yang sudah selesai, sebuah jendela popup bergaya terminal akan muncul memperlihatkan semua aksi yang dilakukan AI.
