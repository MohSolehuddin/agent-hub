# Tech Stack: Agent Hub

Dokumentasi ini merinci spesifikasi runtime, bahasa, dependensi, serta keputusan arsitektur terkait dependensi pada repositori `agent-hub`.

---

## 1. Runtime & Bahasa

- **Runtime**: Bun `v1.4.2` (terkunci via `bun.lock`, lockfileVersion 1, configVersion 1).
- **Bahasa**: TypeScript (dieksekusi secara native oleh Bun runtime tanpa compiler/bundler terpisah).

---

## 2. Dependensi Utama (Production Dependencies)

Daftar dependensi yang tercantum di `package.json` dan terkunci di `bun.lock`:

| Paket | Versi di `package.json` | Versi Terkunci (`bun.lock`) | Peran / Kegunaan |
|---|---|---|---|
| `elysia` | `^1.4.30` | `1.4.30` | Web framework HTTP server lokal untuk REST API (`/api/health`, `/api/local-tasks`, `/api/backlog`) dan static dashboard server. |

### Dependensi Transisi (Resolusi via Elysia)
- `@sinclair/typebox`: `0.34.52`
- `cookie`: `1.1.1`
- `exact-mirror`: `0.2.7`
- `fast-decode-uri-component`: `1.0.1`
- `memoirist`: `0.4.0`

---

## 3. Modul Bawaan Runtime & Sistem (Native / Zero-Dependency)

Sistem memanfaatkan modul bawaan Bun dan standard library Node.js untuk menjaga footprint tetap minimal:

- `bun:sqlite`: Driver database SQLite lokal (`Database`) untuk antrean tugas (`agent_tasks.sqlite`).
- `bun:test`: Test runner bawaan Bun untuk unit testing logika murni (`logic.test.ts`).
- `child_process` (`spawn`, `exec`): Eksekutor proses eksternal untuk CLI `agy` (default) atau CLI `opencode` (headless, `opencode run`; eksekutor alternatif via `ENGINE=opencode`, bin absolut `$HOME/.opencode/bin/opencode`), perintah gate verifikasi repo, dan instruksi `git`.
- `fs` & `path`: Operasi sistem berkas sinkron, manajemen direktori log, dan pembacaan konfigurasi/metadata.
- `util` (`promisify`): Utilitas promise wrapper untuk eksekusi perintah shell asinkron.
- Native `fetch`: Global web standard API pada Bun untuk komunikasi HTTP polling/callback ke server dispatcher.

---

## 4. Yang Sengaja Tidak Dipakai (Design Decisions)

- **ORM Berat (Prisma / Drizzle / TypeORM)**: Tidak digunakan. Antrean lokal menggunakan query SQL mentah via `bun:sqlite` untuk meminimalkan dependensi, mempercepat startup, dan menjaga transparansi skema.
- **Library HTTP Eksternal (Axios / Got / Node-Fetch)**: Tidak digunakan. Komunikasi HTTP ke server dispatcher memanfaatkan native `fetch` bawaan Bun.
- **Frontend Bundler / Build Step (Vite / Webpack / React build)**: Tidak digunakan. Antarmuka dashboard di `public/index.html` berupa file HTML tunggal dengan Vue.js 3 dan Tailwind CSS yang dimuat via CDN, sehingga tidak membutuhkan pipeline kompilasi frontend.
- **Message Broker / Queue Eksternal (Redis / RabbitMQ / BullMQ)**: Tidak digunakan. SQLite lokal digunakan sebagai antrean FIFO tunggal per-lane untuk menjaga kesederhanaan operasional dan isolasi proses antar-lane.
