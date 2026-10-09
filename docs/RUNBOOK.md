# Runbook: Agent Hub

Petunjuk operasional, konfigurasi environment, cara menjalankan, pengujian, deployment systemd, dan pemeriksaan kesehatan service `agent-hub`.

---

## 1. Konfigurasi Environment (Env)

Variabel lingkungan dikonfigurasi melalui berkas `.env.hub` (disalin dari `.env.hub.example`).

### Variabel Inti

| Variabel | Contoh / Default | Deskripsi & Peran |
|---|---|---|
| `SERVER_URL` | `https://msytc.my.id` (atau `http://localhost:3000`) | Base URL server dispatcher (Personal OS) untuk endpoint `/api/agent-dispatcher/claim`, `/callback`, serta sinkronisasi dokumentasi (`/api/project-docs/sync`). |
| `AGENT_NAME` | `agent-hub` | Identifier nama worker agen saat mengklaim tugas dan mengirim callback. |
| `AGY_MODELS` | `gemini-3.7-flash-medium gemini-3.6-flash-medium gemini-3.8-flash-medium` | Daftar nama model (dipisahkan spasi) yang dicoba berurutan saat terjadi quota limit/rate limit. |
| `ENGINE` | `agy` | Engine eksekutor per-instance: `agy` (default) atau `opencode` (`opencode run`). Nilai lain -> `agy`. |
| `OPENCODE_BIN` | `$HOME/.opencode/bin/opencode` | Path absolut bin `opencode` (tidak ada di PATH). Hanya dipakai bila `ENGINE=opencode`. |
| `OPENCODE_MODELS` | `opencode/longcat-2.5-preview-free opencode/fledge-alpha-free opencode/muse-spark-1.3-contributor-free opencode/nemotron-3.5-lightning-free` | Daftar model (spasi) untuk engine `opencode`, dirotasi saat quota limit. |
| `AGY_PRINT_TIMEOUT` | `15m` | Nilai parameter timeout output per-langkah (`--print-timeout`) untuk CLI `agy`. |
| `DEFAULT_TIMEOUT_MIN` | `30` | Durasi batas waktu eksekusi tugas dalam menit jika server tidak mengirim `timeout_minutes`. |
| `POLL_MS` | `10000` | Interval polling worker ke server dispatcher dalam satuan milidetik (10 detik). |
| `PORT` | `4000` | Port HTTP server dashboard & API lokal. *(Catatan: disarankan diatur per-lane via systemd).* |

### Variabel Tambahan / Opsional

| Variabel | Default | Deskripsi |
|---|---|---|
| `AGENT_WORKER_TOKEN` | *(kosong)* | Token autentikasi worker (dikirim via header `X-Worker-Token`). Wajib cocok dengan server bila server mengaktifkan verifikasi token (fail-closed). |
| `DEFAULT_WORKSPACE` | `$HOME/project/have-fun/personal-tools` | Direktori workspace default bila payload tugas server tidak menentukan `project_path`. |
| `BACKLOG_DIR` | `/home/msytc/hermes-work/review-loop/tasks` | Lokasi direktori pembacaan file tugas `*.meta`. |
| `LOG_DIR` | `<cwd>/logs` | Lokasi penyimpanan berkas log eksekusi (`<id>.log`) dan `quota.jsonl`. |
| `DB_PATH` | `agent_tasks.sqlite` | Path database SQLite lokal antrean tugas. |

> **PENTING Mengenai `PORT` pada Multi-Lane**:
> `PORT` tidak didefinisikan di `.env.hub` bersama jika menjalankan beberapa lane. Nilai `PORT` di-set secara eksplisit per-unit systemd (mis. `Environment=PORT=4000`, `Environment=PORT=4002`) karena direktif `EnvironmentFile` dapat menimpa nilai `Environment=`.

---

## 2. Cara Menjalankan Secara Manual

### Instalasi Dependensi
```bash
bun install
```

### Menjalankan Worker & Dashboard
```bash
bun run start
# Atau secara langsung:
bun runner.ts
```
Saat dijalankan, worker akan:
1. Menginisialisasi `agent_tasks.sqlite` jika belum ada.
2. Membuka server Elysia di `http://localhost:4000` (atau sesuai `PORT`).
3. Memulai polling tugas dari server dispatcher setiap `POLL_MS`.
4. Memproses antrean tugas lokal satu demi satu secara serial.

### Menjalankan Instance `opencode`
Set `ENGINE=opencode` pada instance (mis. unit systemd lane terpisah atau shell). Setiap lane memakai `PORT` dan working directory (`WorkingDirectory`) sendiri agar tidak bentrok dengan instance `agy`:
```bash
ENGINE=opencode PORT=4002 bun runner.ts   # jalankan dari cwd lane ini
curl -s http://localhost:4002/api/health  # field "engine": "opencode"
```
Tanpa `ENGINE`, perilaku tetap `agy`.

---

## 3. Cara Menjalankan Pengujian (Testing)

Untuk memvalidasi logika deteksi gate, rotasi model, kuota, perbandingan git status, dan penentuan verdict:

```bash
bun test
```

Untuk pengujian End-to-End lokal menggunakan mock server tiruan:
```bash
MODE=ok  bash scripts/e2e.sh   # Simulasi gate sukses -> COMPLETED
MODE=red bash scripts/e2e.sh   # Simulasi gate gagal -> FAILED
```

---

## 4. Menjalankan Sebagai Service (systemd --user)

Agent Hub didesain untuk berjalan sebagai service pengguna yang persisten (`systemd --user`).

### File Template Service (`contrib/agent-hub.service`)
```ini
[Unit]
Description=Agent Hub Worker (agy runner)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=__HUB__
EnvironmentFile=-__HUB__/.env.hub
Environment=PATH=/home/msytc/.local/bin:/home/msytc/.bun/bin:/usr/local/go/bin:/home/msytc/go/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/msytc/.bun/bin/bun runner.ts
Restart=on-failure
RestartSec=10
StandardOutput=append:__HUB__/logs/service.log
StandardError=append:__HUB__/logs/service.log

[Install]
WantedBy=default.target
```

### Instalasi Otomatis
Jalankan skrip pemasangan:
```bash
bash scripts/install-service.sh
```

### Perintah Pengelolaan Service
- **Cek status service**:
  ```bash
  systemctl --user status agent-hub.service
  ```
- **Melihat live logs**:
  ```bash
  journalctl --user -u agent-hub.service -f
  # atau lihat log file:
  tail -f logs/service.log
  ```
- **Restart service**:
  ```bash
  systemctl --user restart agent-hub.service
  ```
- **Stop service**:
  ```bash
  systemctl --user stop agent-hub.service
  ```

---

## 5. Pemeriksaan Kesehatan (Health Check)

### 1. Endpoint Health API
Periksa respons endpoint JSON lokal pada port yang aktif:
```bash
curl -s http://localhost:4000/api/health
```
Contoh respons sehat:
```json
{
  "ok": true,
  "agent": "agent-hub",
  "engine": "agy",
  "models": [
    "gemini-3.7-flash-medium",
    "gemini-3.6-flash-medium",
    "gemini-3.8-flash-medium"
  ],
  "running": false
}
```

### 2. Antarmuka Web Dashboard
Buka URL berikut pada browser web:
```
http://localhost:4000
```
Halaman dashboard akan menampilkan:
- Status antrean lokal (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `UNVERIFIED`, `TIMED_OUT`, `NO_CHANGES`).
- Daftar backlog file `.meta`.
- Tombol **"Lihat Log"** untuk inspeksi rinci keluaran terminal tiap tugas.

---

## 6. Alur Doc-Driven Development & Sinkronisasi Dokumentasi

Worker `agent-hub` menerapkan pendekatan **Doc-Driven Development** dalam setiap siklus pengerjaan tugas:

### 1. Injeksi Preamble Tugas (`withDocPreamble`)
Sebelum eksekusi `agy` dimulai, prompt tugas dibungkus dengan `DOC_DRIVEN_PREAMBLE` untuk memastikan agen membaca dokumentasi repo (`docs/TECH_STACK.md`, `docs/CODE_CONTRACT.md`, `docs/RUNBOOK.md`) dan mematuhi aturan operasional CLI sebelum mengubah kode.

### 2. Penulisan Log Tugas (`docs/LOG.md`)
Setelah tugas mencapai status `COMPLETED`:
- Worker membuat atau memperbarui berkas `docs/LOG.md` di repo target menggunakan fungsi `buildLogEntry` dan `appendLogEntry`.
- Format entri log: `- <ISO timestamp> | <taskRef> | COMPLETED | <commit7> | <n files>`.

### 3. Sinkronisasi Dokumentasi (`syncProjectDocs`)
- Worker mengekstrak seluruh berkas dokumentasi di folder `docs/` repo target via `collectDocsSections`.
- Dokumen dikirimkan via HTTP POST ke endpoint `${SERVER_URL}/api/project-docs/sync` bersama parameter `commit_sha`.

### 4. Perilaku Non-Fatal & Penanganan Error
- Operasi penulisan `docs/LOG.md` dan sinkronisasi dokumentasi `syncProjectDocs` bersifat **non-fatal**.
- Jika server dispatcher offline, endpoint `/api/project-docs/sync` mengembalikan error HTTP, atau permintaan mengalami timeout (10 detik), error akan dicatat ke log worker sebagai peringatan `[!]` tanpa membatalkan status tugas maupun memutus callback utama.

### 5. Verifikasi Operasional melalui Log
Anda dapat memantau log service worker (`logs/service.log` atau console) dengan indikator simbol berikut:
- `[📝]`: Penulisan/pembaruan berkas `docs/LOG.md` berhasil.
- `[📄]`: Sinkronisasi dokumentasi (`syncProjectDocs`) ke server berhasil.
- `[ℹ️]`: Folder `docs/` kosong atau tidak ditemukan pada workspace target.
- `[!]`: Terjadi kesalahan non-fatal saat penulisan log lokal atau sinkronisasi dokumentasi.
