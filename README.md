# Agent Hub 🤖

Hub lokal untuk menjalankan **CLI agent apa pun** (mis. Antigravity `agy`, Claude Code, Codex) secara headless: menjemput tugas dari server, mengantrekannya di SQLite, mengeksekusi satu per satu agar tidak tumpang tindih, lalu melaporkan hasilnya kembali ke server.

> Di-rename dari `antygravity-agent` (28 Sep 2026) karena perannya **general** — bukan khusus Antigravity. Sistem ini secara proaktif menjemput tugas dari server utama Anda, memasukkannya ke dalam sistem antrean lokal berbasis SQLite, mengeksekusinya satu per satu agar tidak terjadi *crash*, dan menyajikan UI Dashboard untuk memonitor hasil kerjanya.

---

## 🌟 Fitur Utama
1. **Sistem Antrean (Queue) via SQLite**: Mencegah *race condition* atau agen berjalan tumpang tindih. Jika ada 10 perintah berbarengan dari server, sistem ini akan mengeksekusinya satu demi satu secara rapi.
2. **Dashboard UI Interaktif**: Disediakan UI berbasis web (Vue.js + Tailwind) untuk memantau status setiap tugas (PENDING, RUNNING, COMPLETED, FAILED, UNVERIFIED, TIMED_OUT) dan melihat log eksekusi (apa saja yang dilakukan AI).
3. **Verifikasi Sebelum Lapor Sukses**: `agy` exit 0 **tidak** dianggap sukses. Worker menjalankan gate repo (build/test) dulu; kalau gate merah → status `FAILED`. Repo tanpa gate → `UNVERIFIED` (bukan sukses palsu).
4. **Pemisahan Konteks (Decoupling)**: server cukup menyediakan endpoint klaim + callback; tidak perlu tahu cara kerja `agy`. Worker yang menjalankan sisanya.

## 📁 Struktur File
- `runner.ts` - loop klaim → eksekusi → gate → callback, plus server Elysia (dashboard + `/api/health`).
- `logic.ts` - logika murni: deteksi gate repo, rotasi model, deteksi kuota, keputusan verdict — **ada testnya** (`logic.test.ts`).
- `db.ts` - antrean lokal SQLite (`bun:sqlite`) + migrasi ringan.
- `scripts/mock-server.ts` - server tiruan Personal OS untuk uji E2E.
- `public/index.html` - *Frontend Dashboard* untuk monitoring.

## 🚀 Cara Menjalankan (Integrasi dengan Project)

### 1. Persiapan
Pastikan Anda sudah menginstall Bun. Jika belum ada `elysia`, install dengan:
```bash
bun add elysia
```

### 2. Konfigurasi (env) — tidak perlu edit kode

| Env | Default | Guna |
|---|---|---|
| `SERVER_URL` | `http://localhost:3000` | base URL Personal OS |
| `AGENT_WORKER_TOKEN` | *(kosong)* | bila diset → dikirim sebagai header `X-Worker-Token`, **wajib** cocok dengan server (fail-closed) |
| `AGENT_NAME` | `agent-hub` | nilai `agent` pada payload & callback |
| `AGY_MODELS` | `gemini-3.7-flash-medium gemini-3.6-flash-medium gemini-3.8-flash-medium` | urutan rotasi saat kuota model habis |
| `AGY_PRINT_TIMEOUT` | `15m` | nilai `--print-timeout` |
| `DEFAULT_TIMEOUT_MIN` | `30` | timeout default bila payload tidak mengisi `timeout_minutes` |
| `POLL_MS` | `10000` | interval klaim tugas |
| `PORT` | `4000` | dashboard lokal |

Server harus punya `POST /api/agent-dispatcher/claim` (ambil + kunci tugas) dan
`POST /api/agent-dispatcher/callback` (terima hasil) — keduanya sudah tersedia di personal-tools.

### 3. Jalankan Agent Runner
```bash
bun install
bun run start      # = bun runner.ts
```
Dashboard: **http://localhost:4000** · health: `GET /api/health`

Sistem akan langsung:
1. Membuat file database `agent_tasks.sqlite` (jika belum ada).
2. Mulai mem-polling server Anda.
3. Menjalankan Dashboard UI.

### 4. Buka Dashboard
Buka browser Anda dan navigasikan ke: **http://localhost:4000**

Anda akan melihat antarmuka monitoring secara real-time. Jika Anda mengklik tulisan **"Lihat Log"** pada tugas yang sudah selesai, sebuah jendela popup bergaya terminal akan muncul memperlihatkan semua aksi yang dilakukan AI.

## 🧪 Uji E2E (tanpa kuota agy)

`scripts/e2e.sh` menjalankan mock-server + runner dengan `agy` tiruan di PATH:
```bash
MODE=ok  bash scripts/e2e.sh   # gate hijau -> callback COMPLETED
MODE=red bash scripts/e2e.sh   # exit 0 tapi gate merah -> callback FAILED
```
Keduanya mencetak `PASS`/`FAIL` dan menaruh callback di `/tmp/ah-e2e/callback.jsonl`.

## ⚙️ Jalankan sebagai service (systemd --user)

```bash
bash scripts/install-service.sh     # pasang ~/.config/systemd/user/agent-hub.service
systemctl --user status agent-hub   # cek status
journalctl --user -u agent-hub -f   # log
```
Konfigurasi lewat `.env.hub` (lihat `.env.hub.example`): `SERVER_URL`, opsional `AGENT_WORKER_TOKEN`. Karena `Linger=yes`, service tetap hidup walau user logout.
