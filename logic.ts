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
};

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

