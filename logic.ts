import { join, resolve } from "path";
import { createHash } from "crypto";

/**
 * logic.ts — logika MURNI agent-hub (tanpa I/O), supaya bisa diuji dengan `bun test`.
 * Semua keputusan penting ada di sini: rotasi model, deteksi kuota, deteksi gate repo,
 * dan verdict hasil.
 */

export type GateSpec = {
  name: string;
  commands: string[];
  source: "repo-config" | "builtin" | "heuristic";
  rejected?: string[];
};

export const DEFAULT_ALLOWED_GATE_COMMANDS: string[] = [
  "go build",
  "go vet",
  "go test",
  "bun test",
  "bun run build",
  "bunx tsc --noEmit",
  "npm test",
  "npm run build",
  "pnpm build",
  "pnpm test",
  "pnpm install --frozen-lockfile",
  "npx tsc --noEmit",
  "cargo test",
  "cargo build",
  "pytest",
  "python -m pytest",
];

const DANGEROUS_SHELL_CHARS = /[;|&$`><(){}\\\r\n]/;

export function parseGateCommands(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as any).gate)
      ? (raw as any).gate
      : null;

  if (!list) return [];

  const result: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > 200) continue;
    if (DANGEROUS_SHELL_CHARS.test(trimmed)) continue;
    result.push(trimmed);
  }
  return result;
}

export function isGateCommandAllowed(cmd: string, allow: string[] = DEFAULT_ALLOWED_GATE_COMMANDS): boolean {
  if (typeof cmd !== "string") return false;
  const normCmd = cmd.trim().replace(/\s+/g, " ");
  if (!normCmd) return false;

  for (const entry of allow) {
    if (typeof entry !== "string") continue;
    const normEntry = entry.trim().replace(/\s+/g, " ");
    if (!normEntry) continue;
    if (normCmd === normEntry || normCmd.startsWith(normEntry + " ")) {
      return true;
    }
  }
  return false;
}

export function resolveGateConfig(
  rawCfg: unknown,
  allow: string[] = DEFAULT_ALLOWED_GATE_COMMANDS,
): { commands: string[]; rejected: string[] } {
  const commands: string[] = [];
  const rejected: string[] = [];

  const rawList = Array.isArray(rawCfg)
    ? rawCfg
    : typeof rawCfg === "object" && rawCfg !== null && Array.isArray((rawCfg as any).gate)
      ? (rawCfg as any).gate
      : null;

  if (!rawList) {
    return { commands, rejected };
  }

  for (const item of rawList) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;

    const parsed = parseGateCommands([trimmed]);
    if (parsed.length === 0) {
      rejected.push(trimmed);
      continue;
    }

    const cmd = parsed[0];
    if (isGateCommandAllowed(cmd, allow)) {
      commands.push(cmd);
    } else {
      rejected.push(trimmed);
    }
  }

  return { commands, rejected };
}

export function isPathInsideAllowlist(target: string, prefixes: string[]): boolean {
  if (!target || typeof target !== "string" || !target.trim()) return false;
  if (!Array.isArray(prefixes) || prefixes.length === 0) return false;

  const cleanPrefixes = prefixes
    .filter((p) => typeof p === "string" && p.trim().length > 0)
    .map((p) => {
      const resolved = resolve(p.trim());
      return resolved === "/" ? "/" : resolved.replace(/\/+$/, "");
    });

  if (cleanPrefixes.length === 0) return false;

  const resolvedTarget = resolve(target.trim());
  const normTarget = resolvedTarget === "/" ? "/" : resolvedTarget.replace(/\/+$/, "");

  for (const prefix of cleanPrefixes) {
    if (prefix === "/") return true;
    if (normTarget === prefix || normTarget.startsWith(prefix + "/")) {
      return true;
    }
  }

  return false;
}

export function parseAllowPrefixes(raw?: string): string[] {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/[:\r\n]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function resolveAllowedGateCommands(
  extra?: string,
  base: string[] = DEFAULT_ALLOWED_GATE_COMMANDS,
): string[] {
  const list = [...base];
  if (extra && typeof extra === "string") {
    const extras = extra
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const item of extras) {
      if (!list.includes(item)) {
        list.push(item);
      }
    }
  }
  return list;
}

export function splitCommand(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

export function readGateConfigFingerprint(repoDir: string, io?: RepoFs): string | null {
  const cfgPath = `${repoDir.replace(/\/+$/, "")}/.agent-hub.json`;
  if (!io) return null;
  if (!io.exists(cfgPath)) return null;

  let content: string | null = null;
  if (io.readText) {
    try {
      content = io.readText(cfgPath);
    } catch {
      return null;
    }
  } else if (io.readFile) {
    try {
      content = io.readFile(cfgPath);
    } catch {
      return null;
    }
  } else if (io.readJson) {
    try {
      content = JSON.stringify(io.readJson(cfgPath));
    } catch {
      return null;
    }
  }
  if (content === null || content === undefined) return null;
  return createHash("sha256").update(content).digest("hex");
}

export function resolveGateAfterRun(
  gate: GateSpec | null,
  before: string | null,
  after: string | null,
  fallback?: GateSpec | null,
): GateSpec | null {
  if (!gate) return null;
  if (gate.source !== "repo-config") return gate;
  if (before === after) return gate;
  return fallback ?? null;
}

/** Gate bawaan per repo (nama folder repo). */
const BUILTIN_GATES: Record<string, string[]> = {
  "personal-tools": [
    "go build ./internal/... ./pkg/...",
    "go vet ./internal/... ./pkg/...",
    "go test -count=1 ./internal/... ./pkg/...",
  ],
  "agentic-workflow-platform": [
    "go build ./internal/...",
    "go vet ./internal/...",
    "go test -count=1 ./internal/...",
  ],
  "hair4all-pb": ["npm test"],
};

export type RepoFs = {
  exists: (p: string) => boolean;
  readJson?: (p: string) => any;
  readText?: (p: string) => string;
  readFile?: (p: string) => string;
  readdir?: (p: string) => string[];
  listDir?: (p: string) => string[];
};

export type DocSection = {
  section: string;
  content: string;
};

export const DOCS_SECTIONS_CONFIG: Array<{ section: string; filename: string }> = [
  { section: "tech_stack", filename: "TECH_STACK.md" },
  { section: "code_contract", filename: "CODE_CONTRACT.md" },
  { section: "runbook", filename: "RUNBOOK.md" },
  { section: "log", filename: "LOG.md" },
];

export const DOC_DRIVEN_PREAMBLE = `ATURAN OPERASIONAL CLI & DOC-DRIVEN DEVELOPMENT (WAJIB, jangan dilanggar):
- WAJIB baca folder docs/ repo (TECH_STACK.md, CODE_CONTRACT.md, RUNBOOK.md) SEBELUM menulis kode.
- Jika menambah/mengubah fungsi, endpoint, atau cara setup: WAJIB perbarui CODE_CONTRACT.md / RUNBOOK.md di repo.
- JANGAN memakai fungsi/library di luar yang tercatat di dokumentasi.
- Jalankan SEMUA perintah shell (build/test/verifikasi) di FOREGROUND (blocking). JANGAN memakai background task, task async, atau tanda "&".
- Jangan menunggu apa pun setelah menjawab; selesaikan satu turn sampai tuntas.
- Jangan push ke remote. Jangan menghapus data/database. Jangan menyentuh file di luar lingkup tugas.
- Bahasa laporan akhir: singkat, Indonesia.`;

/**
 * Bungkus prompt tugas dengan preamble Doc-Driven Development dan aturan operasional CLI.
 */
export function withDocPreamble(prompt: string): string {
  return DOC_DRIVEN_PREAMBLE + "\n\n--- TUGAS ---\n" + prompt;
}

/**
 * Kumpulkan section dokumentasi dari folder docs/ sebuah repository.
 * Memetakan:
 * - docs/TECH_STACK.md -> "tech_stack"
 * - docs/CODE_CONTRACT.md -> "code_contract"
 * - docs/RUNBOOK.md -> "runbook"
 * - docs/LOG.md -> "log"
 * Cocokkan nama file secara case-insensitive dan hanya kembalikan file yang ada.
 */
export function collectDocsSections(dir: string, fs: RepoFs): DocSection[] {
  const sections: DocSection[] = [];
  const normalizedDir = dir.replace(/\/+$/, "");

  const readFn = (p: string): string | null => {
    if (fs.readText) {
      try {
        return fs.readText(p);
      } catch {
        return null;
      }
    }
    if (fs.readFile) {
      try {
        return fs.readFile(p);
      } catch {
        return null;
      }
    }
    return null;
  };

  const listFn = (p: string): string[] | null => {
    if (fs.readdir) {
      try {
        return fs.readdir(p);
      } catch {
        return null;
      }
    }
    if (fs.listDir) {
      try {
        return fs.listDir(p);
      } catch {
        return null;
      }
    }
    return null;
  };

  // Cari folder docs (case-insensitive)
  let docsFolderName: string | null = null;
  const rootEntries = listFn(normalizedDir);
  if (rootEntries) {
    const found = rootEntries.find((e) => e.toLowerCase() === "docs");
    if (found) docsFolderName = found;
  }

  if (!docsFolderName) {
    if (fs.exists(`${normalizedDir}/docs`)) {
      docsFolderName = "docs";
    } else if (fs.exists(`${normalizedDir}/DOCS`)) {
      docsFolderName = "DOCS";
    } else if (fs.exists(`${normalizedDir}/Docs`)) {
      docsFolderName = "Docs";
    }
  }

  if (docsFolderName) {
    const docsPath = `${normalizedDir}/${docsFolderName}`;
    const docEntries = listFn(docsPath);

    if (docEntries) {
      for (const target of DOCS_SECTIONS_CONFIG) {
        const matched = docEntries.find((f) => f.toLowerCase() === target.filename.toLowerCase());
        if (matched) {
          const filePath = `${docsPath}/${matched}`;
          const content = readFn(filePath);
          if (content !== null && content !== undefined) {
            sections.push({ section: target.section, content });
          }
        }
      }
      return sections;
    }
  }

  // Fallback jika readdir/listDir tidak tersedia: cek exists untuk beberapa variasi nama umum
  const docsFolderCandidates = docsFolderName ? [docsFolderName] : ["docs", "DOCS", "Docs"];
  for (const target of DOCS_SECTIONS_CONFIG) {
    let found = false;
    for (const df of docsFolderCandidates) {
      if (found) break;
      const baseName = target.filename;
      const nameVariations = [
        baseName,
        baseName.toLowerCase(),
        baseName.toUpperCase(),
        baseName.charAt(0).toUpperCase() + baseName.slice(1).toLowerCase(),
      ];
      const uniqueNames = Array.from(new Set(nameVariations));
      for (const fn of uniqueNames) {
        const fullPath = `${normalizedDir}/${df}/${fn}`;
        if (fs.exists(fullPath)) {
          const content = readFn(fullPath);
          if (content !== null && content !== undefined) {
            sections.push({ section: target.section, content });
            found = true;
            break;
          }
        }
      }
    }
  }

  return sections;
}

/**
 * Tentukan gate verifikasi untuk sebuah repo.
 * Prioritas: .agent-hub.json (gate) -> gate bawaan per nama repo -> heuristik (go.mod / package.json).
 * Mengembalikan null kalau repo tidak punya gate (mis. repo data/docs) -> caller harus menandai
 * hasilnya "UNVERIFIED", bukan "COMPLETED".
 */
export function detectGate(
  repoDir: string,
  repoName: string,
  io: RepoFs,
  options?: { ignoreRepoConfig?: boolean; allow?: string[] } | string[],
): GateSpec | null {
  const ignoreRepoConfig =
    typeof options === "object" && !Array.isArray(options) ? options.ignoreRepoConfig : false;
  const allow = Array.isArray(options)
    ? options
    : typeof options === "object" && options?.allow
      ? options.allow
      : DEFAULT_ALLOWED_GATE_COMMANDS;

  // 1. konfigurasi repo
  if (!ignoreRepoConfig) {
    const cfgPath = `${repoDir}/.agent-hub.json`;
    if (io.exists(cfgPath) && io.readJson) {
      try {
        const cfg = io.readJson(cfgPath);
        const { commands, rejected } = resolveGateConfig(cfg, allow);
        if (commands.length > 0) {
          const spec: GateSpec = { name: repoName, commands, source: "repo-config" };
          if (rejected.length > 0) spec.rejected = rejected;
          return spec;
        }
      } catch {
        // config rusak -> jatuh ke bawaan
      }
    }
  }

  // 2. gate bawaan
  const builtin = BUILTIN_GATES[repoName];
  if (builtin) {
    return { name: repoName, commands: builtin, source: "builtin" };
  }

  // 3. heuristik
  if (io.exists(`${repoDir}/go.mod`)) {
    return {
      name: repoName,
      commands: ["go build ./...", "go vet ./...", "go test -count=1 ./..."],
      source: "heuristic",
    };
  }
  if (io.exists(`${repoDir}/package.json`) && io.exists(`${repoDir}/tests`)) {
    return { name: repoName, commands: ["npm test"], source: "heuristic" };
  }

  return null;
}

/** Pilih model berikutnya yang belum dicoba. */
export function pickModel(models: string[], tried: string[]): string | null {
  for (const m of models) {
    if (!tried.includes(m)) return m;
  }
  return null;
}

/** Apakah output engine/CLI menandakan kuota habis (bukan error kode)? */
export function isQuotaError(text: string): boolean {
  return /RESOURCE_EXHAUSTED|quota reached|quota exceeded|quota limit|insufficient[ -_]?quota|out of quota|exceeded.*quota|too many requests|rate[ -_]?limit|rate[ -_]?limited|429/i.test(text);
}

/** "2h15m20s" / "65.1 mnt" -> detik (null kalau tak ada pola). */
export function parseResetSeconds(text: string): number | null {
  // format menit: "210.6 mnt" (dipakai agy untuk window reset)
  const mnt = text.match(/(\d+(?:\.\d+)?)\s*mnt/i);
  if (mnt) return Math.round(Number(mnt[1]) * 60);

  // format jam/menit/detik: wajib ada "s" agar tidak match kosong
  const hms = text.match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(\d+(?:\.\d+)?)\s*s/i);
  if (hms) {
    const [, h, mm, ss] = hms;
    return Number(h || 0) * 3600 + Number(mm || 0) * 60 + Math.round(Number(ss || 0));
  }
  return null;
}

export type Verdict = {
  ok: boolean;
  status: "COMPLETED" | "FAILED" | "TIMED_OUT" | "UNVERIFIED" | "NO_CHANGES";
  reason: string;
};

/**
 * Cek apakah baris status git merupakan noise yang perlu diabaikan (.agent-hub.json, logs/, node_modules/).
 */
export function isNoiseGitLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  // Format git porcelain: "XY path" atau "XY path1 -> path2"
  const rawPath = trimmed.slice(2).trim();
  const pathPart = rawPath.replace(/^["']|["']$/g, "");
  if (pathPart === ".agent-hub.json" || pathPart.endsWith("/.agent-hub.json")) return true;
  if (pathPart === "logs" || pathPart.startsWith("logs/") || pathPart.includes("/logs/")) return true;
  if (pathPart === "node_modules" || pathPart.startsWith("node_modules/") || pathPart.includes("/node_modules/")) return true;
  return false;
}

/**
 * Bandingkan status git sebelum dan sesudah eksekusi agy.
 * Mengabaikan file noise (.agent-hub.json, logs/, node_modules/) dan file untracked yang sudah ada sebelum run.
 */
export function hasGitChanges(beforeStatus: string, afterStatus: string): boolean {
  const cleanBefore = (beforeStatus || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !isNoiseGitLine(l))
    .sort()
    .join("\n");

  const cleanAfter = (afterStatus || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !isNoiseGitLine(l))
    .sort()
    .join("\n");

  return cleanBefore !== cleanAfter;
}

/**
 * Putuskan status akhir berdasarkan exit code engine/CLI + hasil gate + deteksi perubahan file.
 * ATURAN PENTING: exit 0 TIDAK cukup — gate harus hijau dan harus ada perubahan file, kalau tidak -> bukan COMPLETED.
 */
export function verdict(opts: {
  agyExitCode: number | null;
  agyOutput: string;
  gate: { ran: boolean; ok: boolean; summary?: string } | null;
  killed: boolean;
  changed?: boolean;
}): Verdict {
  const { agyExitCode, agyOutput, gate, killed, changed } = opts;

  if (isQuotaError(agyOutput) && (agyExitCode ?? 1) !== 0) {
    return { ok: false, status: "FAILED", reason: "kuota model habis (semua model dicoba)" };
  }
  if (killed) {
    return { ok: false, status: "TIMED_OUT", reason: "melewati batas waktu" };
  }
  if ((agyExitCode ?? 1) !== 0) {
    return { ok: false, status: "FAILED", reason: `engine keluar dengan exit code ${agyExitCode}` };
  }
  if (!gate || !gate.ran) {
    return { ok: false, status: "UNVERIFIED", reason: "tidak ada gate verifikasi untuk repo ini" };
  }
  if (!gate.ok) {
    return { ok: false, status: "FAILED", reason: `gate verifikasi MERAH: ${gate.summary || "lihat log"}` };
  }
  if (changed === false) {
    return { ok: false, status: "NO_CHANGES", reason: "tidak ada perubahan file" };
  }
  return { ok: true, status: "COMPLETED", reason: "engine sukses & gate hijau" };
}

/** Ringkas output gate supaya muat di callback (ambil baris penting terakhir). */
export function summarizeGateOutput(cmd: string, ok: boolean, output: string, maxLines = 12): string {
  const lines = output.split("\n").filter((l) => l.trim() !== "");
  const picked = lines.filter((l) => /FAIL|error|Error|panic|cannot|✗/i.test(l)).slice(-5);
  const tail = (picked.length > 0 ? picked : lines.slice(-3)).slice(-maxLines);
  return `[${ok ? "GATE OK" : "GATE GAGAL"}] $ ${cmd}\n${tail.join("\n")}`;
}

export const CLAIM_RETRY_DELAYS = [1000, 2000, 4000];

/** Backoff maksimum antar siklus poll klaim (5 menit). */
export const CLAIM_MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Cek apakah status HTTP tergolong kegagalan gateway / server sementara
 * yang layak di-retry (502, 503, 504). Status 4xx (mis. 401) JANGAN di-retry.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * Cek status throttle (429 Too Many Requests). Ditangani lewat cooldown antar
 * siklus poll, bukan retry cepat di dalam siklus yang sama.
 */
export function isThrottledStatus(status: number): boolean {
  return status === 429;
}

/**
 * Parser murni header `Retry-After` (detik). Mengembalikan null bila kosong,
 * bukan angka, atau di luar rentang wajar (0..3600 detik).
 */
export function parseRetryAfterSeconds(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) return null;
  return Math.ceil(seconds);
}

/**
 * Menghitung jeda sebelum siklus poll berikutnya (ms).
 *
 * Aturan:
 *  - failures <= 0 (sukses)      -> baseMs (jeda normal).
 *  - failures  > 0 (gagal/throttle) -> baseMs * 2^failures, dibatasi maxMs,
 *    lalu ditambah jitter 0..25% agar 4 lane tidak menabrak server serempak.
 *  - Retry-After dari server dihormati: hasil akhir = max(retryAfter, backoff),
 *    tetap dibatasi maxMs.
 *  - `random` bisa di-inject (default Math.random) sehingga perilaku deterministik
 *    saat unit test (random = () => 0 berarti tanpa jitter).
 */
export function nextClaimDelayMs(opts: {
  baseMs: number;
  failures: number;
  retryAfterSeconds?: number | null;
  maxMs?: number;
  random?: () => number;
}): number {
  const baseMs = Number.isFinite(opts.baseMs) && opts.baseMs > 0 ? opts.baseMs : 10_000;
  const maxMs = Number.isFinite(opts.maxMs) && (opts.maxMs as number) > 0 ? (opts.maxMs as number) : CLAIM_MAX_BACKOFF_MS;
  const failures = Number.isFinite(opts.failures) && opts.failures > 0 ? Math.floor(opts.failures) : 0;
  const random = opts.random ?? Math.random;

  if (failures === 0) return Math.min(baseMs, maxMs);

  // 2^failures dibatasi supaya tidak overflow sebelum di-clamp.
  const exp = Math.min(failures, 20);
  let delay = Math.min(baseMs * Math.pow(2, exp), maxMs);

  const jitter = delay * 0.25 * random();
  delay = Math.min(delay + jitter, maxMs);

  const retryAfterMs = (opts.retryAfterSeconds ?? 0) * 1000;
  if (retryAfterMs > delay) delay = Math.min(retryAfterMs, maxMs);

  return Math.round(delay);
}

/**
 * Parser murni untuk file *.meta (format KEY=value per baris).
 * Aman dari eval/source, mendukung nilai dengan spasi, kutip, dan titik dua.
 */
export function parseMetaContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!content) return result;

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();

    // Hapus tanda kutip luar jika dibungkus "..." atau '...'
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }

    if (key) {
      result[key] = val;
    }
  }

  return result;
}

/**
 * Ekstrak REF backlog dari isi prompt (mis. "REF: PT-49" -> "PT-49").
 * Mengembalikan ID dalam HURUF BESAR, atau null bila tidak ditemukan / prompt kosong.
 */
export function extractBacklogRef(prompt: string): string | null {
  if (!prompt || typeof prompt !== "string") return null;
  const match = prompt.match(/^\s*REF:\s*([A-Za-z0-9._-]+)\s*$/im);
  return match ? match[1].toUpperCase() : null;
}

export type BacklogItem = {
  id: string;
  project_dir: string;
  commit: string;
  status: string;
  model?: string;
  verify?: string;
  timeout?: string;
};

/**
 * Tentukan status tugas backlog berdasarkan keberadaan file di done/ dan DB lokal.
 * Prioritas:
 * 1. Ada di subfolder done/ -> DONE
 * 2. Ada di tabel tasks lokal -> status tabel lokal (RUNNING / COMPLETED / FAILED / dll)
 * 3. Selain itu -> PENDING
 */
export function resolveBacklogStatus(opts: {
  isDoneInSubdir: boolean;
  localTaskStatus?: string | null;
}): string {
  if (opts.isDoneInSubdir) {
    return "DONE";
  }
  if (opts.localTaskStatus) {
    return opts.localTaskStatus;
  }
  return "PENDING";
}

/**
 * Ekstrak item backlog terstruktur dari id, isi file meta, dan status.
 */
export function parseBacklogMeta(id: string, content: string, status: string): BacklogItem {
  const meta = parseMetaContent(content);
  return {
    id,
    project_dir: meta.PROJECT_DIR || meta.project_dir || "",
    commit: meta.COMMIT || meta.commit || "",
    status,
    model: meta.MODEL || meta.model || "",
    verify: meta.VERIFY || meta.verify || "",
    timeout: meta.TIMEOUT || meta.timeout || "",
  };
}

/**
 * Resolusi path database SQLite lokal.
 * Default relatif ke cwd ("agent_tasks.sqlite") agar setiap lane yang berjalan di direktori berbeda
 * memiliki antrean lokal sendiri, dan bisa di-override via env DB_PATH.
 */
export function resolveDbPath(envPath?: string): string {
  return envPath && envPath.trim() ? envPath.trim() : "agent_tasks.sqlite";
}

/**
 * Resolusi direktori log.
 * Default ke <cwd>/logs, tetapi bisa di-override via env LOG_DIR.
 */
export function resolveLogDir(envLogDir?: string, cwd: string = process.cwd()): string {
  if (envLogDir && envLogDir.trim()) {
    return envLogDir.trim();
  }
  return join(cwd, "logs");
}

/**
 * Resolusi path file dashboard (public/index.html) relatif terhadap lokasi file module (baseDir),
 * bukan dari process cwd.
 */
export function resolveDashboardPath(baseDir: string): string {
  return join(baseDir, "public", "index.html");
}

/**
 * Class badge Tailwind untuk status di dashboard.
 */
export function getStatusBadgeClass(status: string): string {
  switch (status) {
    case "PENDING":
      return "bg-yellow-100 text-yellow-800";
    case "RUNNING":
      return "bg-blue-100 text-blue-800 animate-pulse";
    case "COMPLETED":
      return "bg-green-100 text-green-800";
    case "SUCCESS":
      return "bg-green-100 text-green-800";
    case "DONE":
      return "bg-emerald-100 text-emerald-800";
    case "UNVERIFIED":
      return "bg-amber-100 text-amber-800";
    case "TIMED_OUT":
      return "bg-orange-100 text-orange-800";
    case "FAILED":
      return "bg-red-100 text-red-800";
    case "NO_CHANGES":
      return "bg-slate-100 text-slate-700";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

/**
 * Label status di dashboard (NO_CHANGES ditampilkan sebagai "NO CHANGES").
 */
export function getStatusLabel(status: string): string {
  if (status === "NO_CHANGES") return "NO CHANGES";
  return status;
}

/**
 * Deskripsi status di dashboard.
 */
export function getStatusDescription(status: string): string {
  if (status === "NO_CHANGES") {
    return "agy tidak mengubah file apa pun (bukan sukses, bukan gagal)";
  }
  return "";
}

export type LogEntryFields = {
  timestamp?: string | Date;
  taskRef?: string;
  verdict?: string;
  commit7?: string;
  commit?: string;
  numFiles?: number | string;
  nFiles?: number | string;
  filesCount?: number | string;
};

/**
 * Susun satu baris entri log markdown:
 * `- <ISO timestamp> | <taskRef> | <verdict> | <commit7> | <n files>`
 */
export function buildLogEntry(fields: LogEntryFields): string {
  const ts = fields.timestamp
    ? typeof fields.timestamp === "string"
      ? fields.timestamp
      : fields.timestamp.toISOString()
    : new Date().toISOString();

  const taskRef = fields.taskRef && fields.taskRef.trim() ? fields.taskRef.trim() : "-";
  const verdict = fields.verdict && fields.verdict.trim() ? fields.verdict.trim() : "COMPLETED";

  const rawCommit = (fields.commit7 || fields.commit || "").trim();
  const commit7 = rawCommit ? (rawCommit.length > 7 ? rawCommit.slice(0, 7) : rawCommit) : "-";

  const rawFiles = fields.numFiles ?? fields.nFiles ?? fields.filesCount ?? 0;
  let filesStr: string;
  if (typeof rawFiles === "number") {
    filesStr = `${rawFiles} ${rawFiles === 1 ? "file" : "files"}`;
  } else {
    const trimmed = String(rawFiles).trim();
    if (/^\d+$/.test(trimmed)) {
      const count = Number(trimmed);
      filesStr = `${count} ${count === 1 ? "file" : "files"}`;
    } else {
      filesStr = trimmed || "0 files";
    }
  }

  return `- ${ts} | ${taskRef} | ${verdict} | ${commit7} | ${filesStr}`;
}

/**
 * Tambahkan satu baris entri markdown di akhir dokumen (append-only, pastikan ada newline).
 */
export function appendLogEntry(existing: string, entry: string): string {
  const trimmedEntry = entry.trim();
  if (!trimmedEntry) return existing;
  if (!existing || existing.trim() === "") {
    return trimmedEntry + "\n";
  }
  const base = existing.endsWith("\n") ? existing : existing + "\n";
  return base + trimmedEntry + "\n";
}


// ---------- Engine (agy | opencode) ----------
export type Engine = "agy" | "opencode";

export function resolveEngine(envEngine?: string): Engine {
  return (envEngine ?? "").trim().toLowerCase() === "opencode" ? "opencode" : "agy";
}

export const DEFAULT_AGY_MODELS: string[] = [
  "gemini-3.7-flash-medium",
  "gemini-3.6-flash-medium",
  "gemini-3.8-flash-medium",
];

export const DEFAULT_OPENCODE_MODELS: string[] = [
  "opencode/longcat-2.5-preview-free",
  "opencode/fledge-alpha-free",
  "opencode/muse-spark-1.3-contributor-free",
  "opencode/nemotron-3.5-lightning-free",
];

export function resolveEngineModels(
  engine: Engine,
  env: { AGY_MODELS?: string; OPENCODE_MODELS?: string } = {},
): string[] {
  const raw = engine === "opencode" ? env.OPENCODE_MODELS : env.AGY_MODELS;
  const parsed = (raw ?? "").split(/\s+/).filter(Boolean);
  if (parsed.length > 0) return parsed;
  return [...(engine === "opencode" ? DEFAULT_OPENCODE_MODELS : DEFAULT_AGY_MODELS)];
}

export function resolveOpencodeBin(envBin?: string, home?: string): string {
  const bin = (envBin ?? "").trim();
  if (bin) return bin;
  const h = (home ?? "").trim().replace(/\/+$/, "");
  return h ? `${h}/.opencode/bin/opencode` : "opencode";
}

export type EngineInvocation = { cmd: string; args: string[] };

export function buildEngineArgs(opts: {
  engine: Engine;
  prompt: string;
  model: string;
  repoDir: string;
  printTimeout: string;
  opencodeBin?: string;
}): EngineInvocation {
  if (opts.engine === "opencode") {
    return { cmd: opts.opencodeBin || "opencode", args: ["run", opts.prompt, "--model", opts.model, "--dir", opts.repoDir, "--auto"] };
  }
  return {
    cmd: "agy",
    args: [
      "-p",
      opts.prompt,
      "--dangerously-skip-permissions",
      "--add-dir",
      opts.repoDir,
      "--model",
      opts.model,
      "--print-timeout",
      opts.printTimeout,
    ],
  };
}
