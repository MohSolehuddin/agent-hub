# Ringkasan Perubahan: SEC-AH2 — API Lokal Loopback + Redaksi Secret

## Masalah & Latar Belakang
1. Dashboard/API lokal di-bind ke `0.0.0.0`, sehingga `GET /api/local-tasks` (termasuk prompt, stdout, stderr) dapat diakses dari LAN tanpa autentikasi.
2. `finish()` menyimpan dan mengirim `output_tail` mentah sehingga secret di output task bisa tersimpan di log/SQLite dan terkirim ke server.

## Perubahan yang Dilakukan

### 1. Bind Loopback & Token (`runner.ts`)
- Server Elysia sekarang listen dengan `hostname` dari `HUB_HOST` (default `127.0.0.1`).
- Middleware auth untuk seluruh `/api/*` kecuali `/api/health`: bila `HUB_TOKEN` diset, wajib `Authorization: Bearer <HUB_TOKEN>` atau `?token=<HUB_TOKEN>`.
- Perbandingan token memakai helper `timingSafeEqual` (panjang sama + XOR loop).
- Bila `HUB_TOKEN` kosong, API tetap berjalan dan mencatat peringatan sekali saat startup.
- Route `/` tetap menyajikan dashboard HTML statis tanpa menyematkan data task.

### 2. Redaksi Secret (`logic.ts` + `runner.ts`)
- Menambahkan `redactSecrets(text)` untuk mengganti token OpenAI/Anthropic (`sk-`), Google (`AIza`), GitHub (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`), AWS (`AKIA`), Slack (`xox*`), JWT, serta nilai pada baris `KEY`/`TOKEN`/`SECRET`/`PASSWORD` (nama variabel dipertahankan).
- `finish()` menerapkan redaksi pada output tail dan error sebelum menulis berkas log, memperbarui SQLite, dan mengirim callback. `verdict()`/status tidak berubah.

### 3. Permission SQLite (`db.ts`)
- Setelah database dibuka/dibuat, berkas DB di-`chmod 0600` secara best-effort pada platform non-Windows.

### 4. Dokumentasi
- `.env.hub.example` dan `docs/RUNBOOK.md` mendokumentasikan `HUB_HOST`, `HUB_TOKEN`, serta redaksi output otomatis.

### 5. Pengujian
- Menambahkan 10 kasus `redactSecrets` di `logic.test.ts` (setiap pola, nama variabel dipertahankan, teks aman tidak berubah, dua secret dalam satu baris, JWT utuh, dan tidak ada substring secret asli).
