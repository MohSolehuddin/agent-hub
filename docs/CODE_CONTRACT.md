# Code Contract: Agent Hub

Dokumentasi kontrak kode, tipe data, fungsi utama, parameter, nilai balik, serta efek samping/error yang ada pada `db.ts`, `logic.ts`, dan `runner.ts`.

---

## 1. Modul Database (`db.ts`)

### `export const db: Database`
- **Tipe**: Instance `bun:sqlite` `Database`.
- **Inisialisasi**: Membuka berkas SQLite yang ditentukan oleh `resolveDbPath(process.env.DB_PATH)` (default: `agent_tasks.sqlite` relatif terhadap direktori kerja).
- **Skema Tabel `tasks`**:
  - `id` (INTEGER, PK, AUTOINCREMENT)
  - `task_prompt` (TEXT, NOT NULL)
  - `target_project` (TEXT, NOT NULL)
  - `server_task_id` (TEXT)
  - `server_task_ref` (TEXT)
  - `timeout_minutes` (INTEGER, DEFAULT 30)
  - `model_used` (TEXT)
  - `status` (TEXT, NOT NULL, DEFAULT 'PENDING') — nilai: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `UNVERIFIED`, `TIMED_OUT`, `NO_CHANGES`
  - `stdout` (TEXT)
  - `stderr` (TEXT)
  - `created_at` (DATETIME, DEFAULT CURRENT_TIMESTAMP)
  - `updated_at` (DATETIME, DEFAULT CURRENT_TIMESTAMP)
- **Efek Samping**: Menjalankan DDL `CREATE TABLE IF NOT EXISTS` dan migrasi kolom baru (`server_task_ref`, `timeout_minutes`, `model_used`) saat modul pertama kali di-import.

---

## 2. Modul Logika Murni (`logic.ts`)

### Tipe Data Utama

#### `Engine`
`"agy" | "opencode"` — CLI eksekutor yang dipakai worker.

#### `EngineInvocation`
`{ cmd: string; args: string[] }` — perintah + argumen hasil `buildEngineArgs`.

#### `GateSpec`
```ts
type GateSpec = {
  name: string;
  commands: string[];
  source: "repo-config" | "builtin" | "heuristic";
};
```

#### `RepoFs`
```ts
type RepoFs = {
  exists: (p: string) => boolean;
  readJson?: (p: string) => any;
};
```

#### `Verdict`
```ts
type Verdict = {
  ok: boolean;
  status: "COMPLETED" | "FAILED" | "TIMED_OUT" | "UNVERIFIED" | "NO_CHANGES";
  reason: string;
};
```

#### `BacklogItem`
```ts
type BacklogItem = {
  id: string;
  project_dir: string;
  commit: string;
  status: string;
  model?: string;
  verify?: string;
  timeout?: string;
};
```

#### `DocSection`
```ts
type DocSection = {
  section: string;
  content: string;
};
```

#### `LogEntryFields`
```ts
type LogEntryFields = {
  timestamp?: string | Date;
  taskRef?: string;
  verdict?: string;
  commit7?: string;
  commit?: string;
  numFiles?: number | string;
  nFiles?: number | string;
  filesCount?: number | string;
};
```

### Konstanta
- `CLAIM_RETRY_DELAYS`: `number[]` = `[1000, 2000, 4000]` (jeda waktu retry klaim HTTP).
- `DOCS_SECTIONS_CONFIG`: `Array<{ section: string; filename: string }>` = Pemetaan section dokumentasi ke nama file target (`tech_stack` -> `TECH_STACK.md`, `code_contract` -> `CODE_CONTRACT.md`, `runbook` -> `RUNBOOK.md`, `log` -> `LOG.md`).
- `DOC_DRIVEN_PREAMBLE`: `string` = Teks panduan operasional CLI dan instruksi Doc-Driven Development yang diinjeksi ke prompt tugas sebelum dijalankan oleh agy.

- `DEFAULT_AGY_MODELS`: `string[]` = `["gemini-3.7-flash-medium","gemini-3.6-flash-medium","gemini-3.8-flash-medium"]`.
- `DEFAULT_OPENCODE_MODELS`: `string[]` = `["opencode/longcat-2.5-preview-free","opencode/fledge-alpha-free","opencode/muse-spark-1.3-contributor-free","opencode/nemotron-3.5-lightning-free"]`.

### Fungsi-Fungsi

#### `resolveEngine(envEngine?: string): Engine`
- **Peran**: trim + lowercase; `"opencode"` -> `"opencode"`, selain itu `"agy"`.

#### `resolveEngineModels(engine: Engine, env?: { AGY_MODELS?: string; OPENCODE_MODELS?: string }): string[]`
- **Peran**: Memilih env `OPENCODE_MODELS` / `AGY_MODELS` sesuai engine, dipisah whitespace; bila kosong mengembalikan salinan default engine tersebut.

#### `resolveOpencodeBin(envBin?: string, home?: string): string`
- **Peran**: `envBin` (trim) bila non-kosong; jika tidak `${home}/.opencode/bin/opencode` (trailing slash `home` di-strip); bila `home` kosong -> `"opencode"`.

#### `buildEngineArgs(opts: { engine: Engine; prompt: string; model: string; repoDir: string; printTimeout: string; opencodeBin?: string }): EngineInvocation`
- **Peran**: `opencode` -> `{ cmd: opencodeBin || "opencode", args: ["run", prompt, "--model", model] }`; `agy` -> `{ cmd: "agy", args: ["-p", prompt, "--dangerously-skip-permissions", "--add-dir", repoDir, "--model", model, "--print-timeout", printTimeout] }`.

#### `detectGate(repoDir: string, repoName: string, io: RepoFs): GateSpec | null`
- **Parameter**:
  - `repoDir` (`string`): Path direktori repositori target.
  - `repoName` (`string`): Nama folder repositori.
  - `io` (`RepoFs`): Abstraksi I/O sistem berkas (`exists`, `readJson`).
- **Nilai Balik**: `GateSpec | null` — Mengembalikan spesifikasi gate verifikasi jika ditemukan (prioritas: `.agent-hub.json` → gate bawaan per nama repo → heuristik `go.mod`/`package.json`), atau `null` jika tidak ada gate.
- **Efek Samping**: Tidak melakukan I/O langsung. Kesalahan pembacaan JSON ditangkap dan di-fallback.

#### `pickModel(models: string[], tried: string[]): string | null`
- **Parameter**:
  - `models` (`string[]`): Daftar kandidat nama model.
  - `tried` (`string[]`): Daftar model yang telah dicoba.
- **Nilai Balik**: `string | null` — Model berikutnya yang belum dicoba, atau `null` jika seluruh model sudah habis.
- **Efek Samping**: Murni tanpa efek samping.

#### `isQuotaError(text: string): boolean`
- **Parameter**: `text` (`string`): Teks output dari CLI `agy`.
- **Nilai Balik**: `boolean` — `true` bila terdeteksi pola kuota habis (`RESOURCE_EXHAUSTED`, `quota reached`, `rate limit`, `429`, dll.).
- **Efek Samping**: Murni.

#### `parseResetSeconds(text: string): number | null`
- **Parameter**: `text` (`string`): Teks log output error kuota.
- **Nilai Balik**: `number | null` — Durasi sisa reset window dalam detik (mis. dari format `210.6 mnt` atau `2h15m20s`), atau `null` bila tidak cocok.
- **Efek Samping**: Murni.

#### `isNoiseGitLine(line: string): boolean`
- **Parameter**: `line` (`string`): Satu baris teks output `git status --porcelain`.
- **Nilai Balik**: `boolean` — `true` bila baris merupakan entri noise yang harus diabaikan (`.agent-hub.json`, `logs/`, `node_modules/`, atau baris kosong).
- **Efek Samping**: Murni.

#### `hasGitChanges(beforeStatus: string, afterStatus: string): boolean`
- **Parameter**:
  - `beforeStatus` (`string`): Output `git status --porcelain` sebelum `agy` berjalan.
  - `afterStatus` (`string`): Output `git status --porcelain` sesudah `agy` berjalan.
- **Nilai Balik**: `boolean` — `true` bila terdapat perubahan file riil di luar entri noise.
- **Efek Samping**: Murni.

#### `verdict(opts: { agyExitCode: number | null; agyOutput: string; gate: { ran: boolean; ok: boolean; summary?: string } | null; killed: boolean; changed?: boolean }): Verdict`
- **Parameter**: Objek status eksekusi `agy`, hasil gate, flag timeout (`killed`), dan flag deteksi perubahan file (`changed`).
- **Nilai Balik**: `Verdict` — Menentukan status akhir (`COMPLETED`, `FAILED`, `TIMED_OUT`, `UNVERIFIED`, `NO_CHANGES`) dan penjelasannya.
- **Efek Samping**: Murni.

#### `summarizeGateOutput(cmd: string, ok: boolean, output: string, maxLines = 12): string`
- **Parameter**: `cmd` (`string`), `ok` (`boolean`), `output` (`string`), `maxLines` (`number`, default: 12).
- **Nilai Balik**: `string` — Potongan ringkas output verifikasi gate dengan prioritas baris kegagalan/error.
- **Efek Samping**: Murni.

#### `isRetryableHttpStatus(status: number): boolean`
- **Parameter**: `status` (`number`): HTTP status code.
- **Nilai Balik**: `boolean` — `true` hanya untuk kode 502, 503, dan 504.
- **Efek Samping**: Murni.

#### `parseMetaContent(content: string): Record<string, string>`
- **Parameter**: `content` (`string`): Isi file `*.meta`.
- **Nilai Balik**: `Record<string, string>` — Pasangan key-value baris demi baris, aman dari eval, dengan pembersihan kutip ganda/tunggal.
- **Efek Samping**: Murni.

#### `extractBacklogRef(prompt: string): string | null`
- **Parameter**: `prompt` (`string`): Teks prompt tugas.
- **Nilai Balik**: `string | null` — ID referensi backlog dalam huruf kapital bila ada baris `REF: <ID>`, atau `null`.
- **Efek Samping**: Murni.

#### `resolveBacklogStatus(opts: { isDoneInSubdir: boolean; localTaskStatus?: string | null }): string`
- **Parameter**: Flag keberadaan file di `done/` dan status tugas di DB lokal.
- **Nilai Balik**: `string` — `"DONE"`, status tabel lokal, atau fallback `"PENDING"`.
- **Efek Samping**: Murni.

#### `parseBacklogMeta(id: string, content: string, status: string): BacklogItem`
- **Parameter**: `id` (`string`), `content` (`string`), `status` (`string`).
- **Nilai Balik**: `BacklogItem` — Objek data backlog terstruktur.
- **Efek Samping**: Murni.

#### `resolveDbPath(envPath?: string): string`
- **Parameter**: `envPath` (`string | undefined`).
- **Nilai Balik**: `string` — Nilai `envPath.trim()` atau default `"agent_tasks.sqlite"`.
- **Efek Samping**: Murni.

#### `resolveLogDir(envLogDir?: string, cwd: string = process.cwd()): string`
- **Parameter**: `envLogDir` (`string | undefined`), `cwd` (`string`, default: `process.cwd()`).
- **Nilai Balik**: `string` — Path direktori log (`envLogDir` atau `<cwd>/logs`).
- **Efek Samping**: Murni / membaca path string.

#### `resolveDashboardPath(baseDir: string): string`
- **Parameter**: `baseDir` (`string`): Lokasi direktori modul.
- **Nilai Balik**: `string` — Path absolut berkas HTML dashboard (`<baseDir>/public/index.html`).
- **Efek Samping**: Murni.

#### `getStatusBadgeClass(status: string): string`
- **Parameter**: `status` (`string`).
- **Nilai Balik**: `string` — Nama class CSS Tailwind untuk badge status antarmuka.
- **Efek Samping**: Murni.

#### `getStatusLabel(status: string): string`
- **Parameter**: `status` (`string`).
- **Nilai Balik**: `string` — Label teks tampilan (mis. `"NO_CHANGES"` -> `"NO CHANGES"`).
- **Efek Samping**: Murni.

#### `getStatusDescription(status: string): string`
- **Parameter**: `status` (`string`).
- **Nilai Balik**: `string` — Deskripsi penjelasan status.
- **Efek Samping**: Murni.

#### `withDocPreamble(prompt: string): string`
- **Parameter**: `prompt` (`string`): Teks prompt tugas asli.
- **Nilai Balik**: `string` — Prompt yang telah dibungkus dengan `DOC_DRIVEN_PREAMBLE` di bagian atas (`${DOC_DRIVEN_PREAMBLE}\n\n--- TUGAS ---\n${prompt}`).
- **Efek Samping**: Murni.

#### `collectDocsSections(dir: string, fs: RepoFs): DocSection[]`
- **Parameter**:
  - `dir` (`string`): Path direktori repositori target.
  - `fs` (`RepoFs`): Abstraksi I/O sistem berkas (`exists`, `readText`/`readFile`, `readdir`/`listDir`).
- **Nilai Balik**: `DocSection[]` — Daftar berkas dokumentasi yang berhasil ditemukan dan dibaca dari folder `docs/` (case-insensitive: `TECH_STACK.md`, `CODE_CONTRACT.md`, `RUNBOOK.md`, `LOG.md`).
- **Efek Samping**: Tidak melakukan I/O langsung. Kesalahan baca ditangani secara aman dengan fallback.

#### `buildLogEntry(fields: LogEntryFields): string`
- **Parameter**: `fields` (`LogEntryFields`): Objek field entri log (`timestamp`, `taskRef`, `verdict`, `commit7`/`commit`, `numFiles`/`nFiles`/`filesCount`).
- **Nilai Balik**: `string` — Satu baris entri markdown log dengan format: `- <ISO timestamp> | <taskRef> | <verdict> | <commit7> | <n files>`.
- **Efek Samping**: Murni.

#### `appendLogEntry(existing: string, entry: string): string`
- **Parameter**:
  - `existing` (`string`): Isi markdown log yang sudah ada.
  - `entry` (`string`): Satu baris entri markdown baru.
- **Nilai Balik**: `string` — Menggabungkan entri baru di akhir dokumen secara append-only, memastikan pemisah baris (`\n`) tetap rapi.
- **Efek Samping**: Murni.

---

## 3. Modul Runner & Service (`runner.ts`)

### Tipe Data
- `CliRun`: `{ code: number | null; stdout: string; stderr: string; killed: boolean }`

### Fungsi / Prosedur Internal

#### `authHeaders(): Record<string, string>`
- **Nilai Balik**: Header HTTP JSON, menyertakan header `X-Worker-Token` jika variabel lingkungan `AGENT_WORKER_TOKEN` terisi.

#### `fetchTasksFromServer(): Promise<void>`
- **Peran**: Mengirim HTTP POST ke `${SERVER_URL}/api/agent-dispatcher/claim` dengan payload `{ agent: AGENT_NAME }`.
- **Efek Samping / Error Handling**: Melakukan percobaan ulang (retry) pada status 502/503/504 berdasarkan `CLAIM_RETRY_DELAYS`. Menyimpan tugas ke database SQLite lokal jika klaim berhasil.

#### `firstFailingCmd(gate: GateSpec, out: string): string`
- **Peran**: Menemukan perintah verifikasi pertama yang gagal dalam rantai eksekusi gate berdasarkan log output.

#### `runGate(gate: GateSpec, cwd: string): Promise<{ ran: boolean; ok: boolean; summary: string; output: string }>`
- **Peran**: Menjalankan setiap perintah verifikasi gate secara serial di direktori `cwd` via `execAsync` (buffer 8MB, timeout 10 menit).
- **Efek Samping**: Mengeksekusi proses shell eksternal; berhenti pada kegagalan pertama.

#### `runCli(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<CliRun>`
- **Peran**: Menjalankan child process `spawn(cmd, args, ...)` (cmd = `agy` atau bin `opencode`) di folder target dengan batas waktu `timeoutMs`.
- **Efek Samping**: Mengirim sinyal `SIGKILL` bila waktu eksekusi melampaui batas; mengumpulkan stream `stdout` dan `stderr`.

#### `appendQuota(model: string, resetSeconds: number | null): void`
- **Peran**: Mencatat insiden kehabisan kuota model ke berkas `${LOG_DIR}/quota.jsonl`.
- **Efek Samping**: Menulis log secara sinkron (`fs.appendFileSync`).

#### `finish(task: any, r: {...}): Promise<void>`
- **Peran**: Finalisasi tugas lokal.
- **Efek Samping**:
  1. Menulis log lengkap ke file `${LOG_DIR}/${server_task_id || task.id}.log`.
  2. Memperbarui status, log tail, dan model pada tabel SQLite lokal.
  3. Mengirim payload status callback ke `${SERVER_URL}/api/agent-dispatcher/callback`.

#### `syncProjectDocs(projectPath: string, commitSha?: string): Promise<void>`
- **Peran**: Mengumpulkan dokumen dari folder `docs/` di `projectPath` via `collectDocsSections` dan mengirimkannya melalui HTTP POST ke `${SERVER_URL}/api/project-docs/sync` dengan payload `{ project, files, commit_sha }` (timeout 10 detik via `AbortController`).
- **Efek Samping / Error Handling**: Non-fatal. Menulis log `[📄]` jika sukses atau `[!]` jika gagal/error; kegagalan tidak membatalkan alur eksekusi tugas.

#### `processLocalTasks(): Promise<void>`
- **Peran**: Loop utama pemrosesan antrean lokal. Mengambil satu tugas `PENDING` tertua, menandai `RUNNING`, membungkus prompt dengan `withDocPreamble()`, mengeksekusi `agy` dengan failover model rotasi, menjalankan gate verifikasi jika exit code 0, memeriksa perubahan git, menghitung `verdict()`, lalu memanggil `finish()`. Jika status akhir `COMPLETED`, worker otomatis memperbarui `docs/LOG.md` (via `buildLogEntry` & `appendLogEntry`) dan memanggil `syncProjectDocs()`.
- **Efek Samping**: Modifikasi database lokal, eksekusi proses eksternal, mutasi filesystem target (termasuk penulisan `docs/LOG.md`), dan pengiriman HTTP callback serta sync dokumentasi.

#### `getBacklogTasks(): BacklogItem[]`
- **Peran**: Membaca direktori `BACKLOG_DIR`, mem-parse file `*.meta`, memeriksa keberadaan subfolder `done/`, mencocokkan ID dengan database lokal, dan mengembalikan array `BacklogItem` terurut.

### HTTP Endpoints (Elysia Server)
- `GET /api/local-tasks`: Mengembalikan 100 entri tugas terakhir dari tabel `tasks` SQLite lokal.
- `GET /api/backlog`: Mengembalikan daftar backlog item dari direktori `BACKLOG_DIR`.
- `GET /api/health`: Mengembalikan status kesehatan worker `{ ok: true, agent, engine, models, running }`.
- `GET /`: Menyajikan berkas static frontend `public/index.html`.
