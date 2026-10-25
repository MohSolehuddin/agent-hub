# Ringkasan Perubahan: SEC-AH1 — Hardening Keamanan Worker Agent-Hub

## Masalah & Latar Belakang
1. **Gate Command Injection via Shell Execution**: `.agent-hub.json` yang dapat ditulis oleh agen di dalam repo dieksekusi menggunakan shell (`execAsync`), memungkinkan eksekusi perintah arbitrer atau berbahaya setelah agen selesai.
2. **Project Path Traversal**: `t.project_path` dari server dispatcher diterima tanpa batasan direktori, berpotensi mengakses direktori sensitif di sistem host.

## Perubahan yang Dilakukan

### 1. Modul Logika Murni (`logic.ts`)
- Menambahkan `DEFAULT_ALLOWED_GATE_COMMANDS`: allowlist perintah verifikasi resmi (`go build`, `go vet`, `go test`, `bun test`, `bun run build`, `bunx tsc --noEmit`, `npm test`, `npm run build`, `pnpm build`, `pnpm test`, `pnpm install --frozen-lockfile`, `npx tsc --noEmit`, `cargo test`, `cargo build`, `pytest`, `python -m pytest`).
- Menambahkan `parseGateCommands`: memvalidasi array perintah, menolak string > 200 karakter, string kosong, dan karakter shell berbahaya (`;`, `|`, `&`, `$`, backtick, `>`, `<`, `(`, `)`, `{`, `}`, `\`, `\n`, `\r`).
- Menambahkan `isGateCommandAllowed`: memeriksa awalan perintah terhadap allowlist dengan toleransi spasi ganda.
- Menambahkan `resolveGateConfig`: memisahkan perintah yang lolos dan yang ditolak (`{ commands, rejected }`).
- Menambahkan `isPathInsideAllowlist`: memvalidasi path target terhadap allowlist prefix dengan normalisasi `path.resolve` dan perlindungan `..`.
- Menambahkan utilitas pembantu: `parseAllowPrefixes`, `resolveAllowedGateCommands`, `splitCommand`, `readGateConfigFingerprint`, dan `resolveGateAfterRun`.
- Memperbarui `detectGate`: memfilter perintah `.agent-hub.json` melalui `resolveGateConfig`. Jika seluruh perintah ditolak, otomatis jatuh ke gate `builtin` atau `heuristic`. Menyimpan daftar perintah ditolak di `rejected`.

### 2. Modul Runner & Service (`runner.ts`)
- Menambahkan `runGateCommand`: eksekusi perintah gate secara langsung menggunakan `spawn` tanpa shell (zero shell injection), dengan timeout 10 menit per perintah.
- Menghubungkan `runGate` ke `runGateCommand` dengan format output log yang konsisten (`$ <cmd>\n<stdout+stderr>\n`).
- Guard integritas konfigurasi: merekam fingerprint `.agent-hub.json` sebelum agen berjalan, dan memverifikasinya ulang sesudah agen selesai. Jika berkas berubah selama eksekusi tugas, konfigurasi diabaikan dan diganti dengan gate `builtin`/`heuristic`.
- Workspace Allowlist: memvalidasi `target_project` terhadap `PROJECT_ALLOW_PREFIXES` saat awal eksekusi tugas. Jika di luar allowlist, tugas langsung digagalkan (`FAILED`) tanpa menjalankan agen.
- Startup logging: mencatat status `PROJECT_ALLOW_PREFIXES` dan jumlah perintah gate yang diizinkan saat worker dimulai.

### 3. Konfigurasi Lingkungan (`.env.hub.example`)
- Mendokumentasikan variabel lingkungan `PROJECT_ALLOW_PREFIXES` dan `GATE_ALLOW_EXTRA`.

### 4. Dokumentasi Kontrak Kode (`docs/CODE_CONTRACT.md`)
- Menambahkan seksi "Keamanan: Gate & Path Safety" yang merangkum aturan allowlist, eksekusi tanpa shell, guard perubahan konfigurasi, dan batasan workspace.
