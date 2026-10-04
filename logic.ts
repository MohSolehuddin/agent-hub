import { join } from "path";

/**
 * logic.ts — logika MURNI agent-hub (tanpa I/O), supaya bisa diuji dengan `bun test`.
 * Semua keputusan penting ada di sini: rotasi model, deteksi kuota, deteksi gate repo,
 * dan verdict hasil.
 */

export type GateSpec = {
  name: string;
  commands: string[];
  source: "repo-config" | "builtin" | "heuristic";
};

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
export function detectGate(repoDir: string, repoName: string, io: RepoFs): GateSpec | null {
  // 1. konfigurasi repo
  const cfgPath = `${repoDir}/.agent-hub.json`;
  if (io.exists(cfgPath) && io.readJson) {
    try {
      const cfg = io.readJson(cfgPath);
      const cmds = Array.isArray(cfg?.gate) ? cfg.gate.filter((c: any) => typeof c === "string" && c.trim()) : [];
      if (cmds.length > 0) {
        return { name: repoName, commands: cmds, source: "repo-config" };
      }
    } catch {
      // config rusak -> jatuh ke bawaan
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

/** Apakah output agy menandakan kuota habis (bukan error kode)? */
export function isQuotaError(text: string): boolean {
  return /RESOURCE_EXHAUSTED|quota reached|quota exceeded|rate limit|429/i.test(text);
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
 * Putuskan status akhir berdasarkan exit code agy + hasil gate + deteksi perubahan file.
 * ATURAN PENTING: agy exit 0 TIDAK cukup — gate harus hijau dan harus ada perubahan file, kalau tidak -> bukan COMPLETED.
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
    return { ok: false, status: "FAILED", reason: `agy keluar dengan exit code ${agyExitCode}` };
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
  return { ok: true, status: "COMPLETED", reason: "agy sukses & gate hijau" };
}

/** Ringkas output gate supaya muat di callback (ambil baris penting terakhir). */
export function summarizeGateOutput(cmd: string, ok: boolean, output: string, maxLines = 12): string {
  const lines = output.split("\n").filter((l) => l.trim() !== "");
  const picked = lines.filter((l) => /FAIL|error|Error|panic|cannot|✗/i.test(l)).slice(-5);
  const tail = (picked.length > 0 ? picked : lines.slice(-3)).slice(-maxLines);
  return `[${ok ? "GATE OK" : "GATE GAGAL"}] $ ${cmd}\n${tail.join("\n")}`;
}

export const CLAIM_RETRY_DELAYS = [1000, 2000, 4000];

/**
 * Cek apakah status HTTP tergolong kegagalan gateway / server sementara
 * yang layak di-retry (502, 503, 504). Status 4xx (mis. 401) JANGAN di-retry.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
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

