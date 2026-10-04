import { describe, expect, test } from "bun:test";
import {
  detectGate,
  pickModel,
  isQuotaError,
  parseResetSeconds,
  verdict,
  summarizeGateOutput,
  CLAIM_RETRY_DELAYS,
  isRetryableHttpStatus,
  parseMetaContent,
  resolveBacklogStatus,
  parseBacklogMeta,
  hasGitChanges,
  isNoiseGitLine,
  resolveDbPath,
  resolveLogDir,
  resolveDashboardPath,
  getStatusBadgeClass,
  getStatusLabel,
  getStatusDescription,
  extractBacklogRef,
  collectDocsSections,
  DOC_DRIVEN_PREAMBLE,
  withDocPreamble,
  buildLogEntry,
  appendLogEntry,
} from "./logic";

const io = (files: string[], json?: Record<string, any>) => ({
  exists: (p: string) => files.includes(p),
  readJson: (p: string) => {
    if (json && json[p] !== undefined) return json[p];
    throw new Error("no json");
  },
});

describe("detectGate", () => {
  test("pakai .agent-hub.json kalau ada", () => {
    const g = detectGate("/repo/a", "a", io(["/repo/a/.agent-hub.json"], { "/repo/a/.agent-hub.json": { gate: ["make test"] } }));
    expect(g?.source).toBe("repo-config");
    expect(g?.commands).toEqual(["make test"]);
  });

  test("gate bawaan personal-tools (hindari ./... karena folder data/)", () => {
    const g = detectGate("/repo/personal-tools", "personal-tools", io(["/repo/personal-tools/go.mod"]));
    expect(g?.source).toBe("builtin");
    expect(g?.commands.join(" ")).toContain("./internal/...");
    expect(g?.commands.join(" ")).not.toContain("go test ./...");
  });

  test("gate bawaan hair4all-pb = npm test", () => {
    const g = detectGate("/repo/hair4all-pb", "hair4all-pb", io(["/repo/hair4all-pb/package.json"]));
    expect(g?.commands).toEqual(["npm test"]);
  });

  test("heuristik go.mod", () => {
    const g = detectGate("/repo/other", "other", io(["/repo/other/go.mod"]));
    expect(g?.source).toBe("heuristic");
    expect(g?.commands[0]).toBe("go build ./...");
  });

  test("heuristik package.json + tests/", () => {
    const g = detectGate("/repo/web", "web", io(["/repo/web/package.json", "/repo/web/tests"]));
    expect(g?.commands).toEqual(["npm test"]);
  });

  test("tanpa penanda -> null (UNVERIFIED)", () => {
    expect(detectGate("/repo/docs", "docs", io(["/repo/docs/README.md"]))).toBeNull();
  });

  test("config rusak -> jatuh ke gate bawaan", () => {
    const g = detectGate("/repo/personal-tools", "personal-tools", io(["/repo/personal-tools/.agent-hub.json", "/repo/personal-tools/go.mod"], { "/repo/personal-tools/.agent-hub.json": { gate: [] } }));
    expect(g?.source).toBe("builtin");
  });
});

describe("rotasi model", () => {
  test("pickModel melewati yang sudah dicoba", () => {
    expect(pickModel(["a", "b", "c"], ["a"])).toBe("b");
    expect(pickModel(["a", "b"], ["a", "b"])).toBeNull();
  });

  test("isQuotaError mendeteksi RESOURCE_EXHAUSTED / rate limit", () => {
    expect(isQuotaError("Error: RESOURCE_EXHAUSTED")).toBe(true);
    expect(isQuotaError("quota reached, reset in 2h")).toBe(true);
    expect(isQuotaError("HTTP 429 too many requests")).toBe(true);
    expect(isQuotaError("compilation failed")).toBe(false);
  });

  test("parseResetSeconds membaca 2h15m20s", () => {
    expect(parseResetSeconds("reset in 2h15m20s")).toBe(2 * 3600 + 15 * 60 + 20);
    expect(parseResetSeconds("reset 210.6 mnt -> 2026-09-29 14:42")).toBe(Math.round(210.6 * 60));
    expect(parseResetSeconds("42.8 mnt")).toBe(Math.round(42.8 * 60));
    expect(parseResetSeconds("tanpa angka")).toBeNull();
  });
});

describe("verdict — exit 0 saja TIDAK cukup", () => {
  test("agy 0 + gate hijau -> COMPLETED", () => {
    const v = verdict({ agyExitCode: 0, agyOutput: "done", gate: { ran: true, ok: true }, killed: false });
    expect(v.ok).toBe(true);
    expect(v.status).toBe("COMPLETED");
  });

  test("agy 0 tapi gate MERAH -> FAILED", () => {
    const v = verdict({ agyExitCode: 0, agyOutput: "done", gate: { ran: true, ok: false, summary: "GATE GAGAL" }, killed: false });
    expect(v.ok).toBe(false);
    expect(v.status).toBe("FAILED");
    expect(v.reason).toContain("gate");
  });

  test("agy 0 tapi tidak ada gate -> UNVERIFIED (bukan sukses palsu)", () => {
    const v = verdict({ agyExitCode: 0, agyOutput: "done", gate: null, killed: false });
    expect(v.status).toBe("UNVERIFIED");
    expect(v.ok).toBe(false);
  });

  test("timeout -> TIMED_OUT", () => {
    const v = verdict({ agyExitCode: null, agyOutput: "", gate: null, killed: true });
    expect(v.status).toBe("TIMED_OUT");
  });

  test("agy gagal -> FAILED", () => {
    const v = verdict({ agyExitCode: 2, agyOutput: "boom", gate: null, killed: false });
    expect(v.status).toBe("FAILED");
  });

  // (a) exit 0 + ada perubahan + gate ok -> COMPLETED
  test("(a) exit 0 + ada perubahan + gate ok -> COMPLETED", () => {
    const v = verdict({
      agyExitCode: 0,
      agyOutput: "done",
      gate: { ran: true, ok: true },
      killed: false,
      changed: true,
    });
    expect(v.ok).toBe(true);
    expect(v.status).toBe("COMPLETED");
    expect(v.reason).toBe("agy sukses & gate hijau");
  });

  // (b) exit 0 + TIDAK ada perubahan -> bukan COMPLETED (NO_CHANGES)
  test("(b) exit 0 + TIDAK ada perubahan -> bukan COMPLETED (NO_CHANGES)", () => {
    const v = verdict({
      agyExitCode: 0,
      agyOutput: "done",
      gate: { ran: true, ok: true },
      killed: false,
      changed: false,
    });
    expect(v.ok).toBe(false);
    expect(v.status).toBe("NO_CHANGES");
    expect(v.reason).toContain("tidak ada perubahan file");
  });

  // (c) gate merah -> FAILED
  test("(c) gate merah -> FAILED (bahkan jika ada perubahan)", () => {
    const v = verdict({
      agyExitCode: 0,
      agyOutput: "done",
      gate: { ran: true, ok: false, summary: "GATE GAGAL: test error" },
      killed: false,
      changed: true,
    });
    expect(v.ok).toBe(false);
    expect(v.status).toBe("FAILED");
    expect(v.reason).toContain("gate verifikasi MERAH");
  });

  test("(c) gate merah -> FAILED (jika tidak ada perubahan)", () => {
    const v = verdict({
      agyExitCode: 0,
      agyOutput: "done",
      gate: { ran: true, ok: false, summary: "GATE GAGAL: syntax error" },
      killed: false,
      changed: false,
    });
    expect(v.ok).toBe(false);
    expect(v.status).toBe("FAILED");
    expect(v.reason).toContain("gate verifikasi MERAH");
  });
});

describe("deteksi perubahan git & filter noise", () => {
  test("isNoiseGitLine mendeteksi .agent-hub.json, logs/, node_modules/", () => {
    expect(isNoiseGitLine("?? .agent-hub.json")).toBe(true);
    expect(isNoiseGitLine(" M .agent-hub.json")).toBe(true);
    expect(isNoiseGitLine("?? logs/task-123.log")).toBe(true);
    expect(isNoiseGitLine("?? logs/service.log")).toBe(true);
    expect(isNoiseGitLine("?? node_modules/pkg/index.js")).toBe(true);
    expect(isNoiseGitLine(" M node_modules/pkg/package.json")).toBe(true);
    expect(isNoiseGitLine('?? "logs/quoted.log"')).toBe(true);
    expect(isNoiseGitLine("?? sub/logs/debug.log")).toBe(true);

    // Bukan noise
    expect(isNoiseGitLine("?? src/index.ts")).toBe(false);
    expect(isNoiseGitLine(" M logic.ts")).toBe(false);
    expect(isNoiseGitLine("A  README.md")).toBe(false);
    expect(isNoiseGitLine(" D old.go")).toBe(false);
  });

  test("hasGitChanges: sama persis -> false (tidak ada perubahan)", () => {
    expect(hasGitChanges("", "")).toBe(false);
    expect(hasGitChanges(" M file.txt", " M file.txt")).toBe(false);
  });

  test("hasGitChanges: mengabaikan file noise", () => {
    expect(hasGitChanges("", "?? logs/task-bac.log")).toBe(false);
    expect(hasGitChanges("", "?? .agent-hub.json\n?? logs/task-1.log")).toBe(false);
    expect(hasGitChanges("", "?? node_modules/foo/bar.js")).toBe(false);
  });

  test("hasGitChanges: mengabaikan untracked yang sudah ada sebelum run", () => {
    const before = "?? pre-existing.txt\n?? another.txt";
    const after = "?? pre-existing.txt\n?? another.txt\n?? logs/task-1.log";
    expect(hasGitChanges(before, after)).toBe(false);
  });

  test("hasGitChanges: mendeteksi perubahan file nyata", () => {
    const before = "?? pre-existing.txt";
    const after = "?? pre-existing.txt\n M src/logic.ts";
    expect(hasGitChanges(before, after)).toBe(true);
  });

  test("hasGitChanges: mendeteksi penambahan file baru", () => {
    expect(hasGitChanges("", "?? src/new-feature.ts")).toBe(true);
  });

  test("hasGitChanges: mendeteksi penghapusan file", () => {
    expect(hasGitChanges("?? temp.txt", "")).toBe(true);
  });
});

describe("summarizeGateOutput", () => {
  test("prioritaskan baris error", () => {
    const out = "ok line\nFAIL TestFoo\nother\n";
    const s = summarizeGateOutput("go test", false, out);
    expect(s).toContain("GATE GAGAL");
    expect(s).toContain("FAIL TestFoo");
  });
});

describe("claim retry logic", () => {
  test("CLAIM_RETRY_DELAYS memakai jeda 1s, 2s, 4s (maks 3 percobaan ulang)", () => {
    expect(CLAIM_RETRY_DELAYS).toEqual([1000, 2000, 4000]);
  });

  test("isRetryableHttpStatus HANYA retry untuk HTTP 502, 503, 504", () => {
    expect(isRetryableHttpStatus(502)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(504)).toBe(true);
  });

  test("isRetryableHttpStatus TIDAK retry untuk 4xx (mis. 401, 403, 404, 400)", () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
    expect(isRetryableHttpStatus(429)).toBe(false);
  });

  test("isRetryableHttpStatus TIDAK retry untuk 2xx / status lain", () => {
    expect(isRetryableHttpStatus(200)).toBe(false);
    expect(isRetryableHttpStatus(500)).toBe(false);
  });
});

describe("parser *.meta dan backlog logic", () => {
  test("parseMetaContent membaca format KEY=value baris per baris", () => {
    const raw = `
PROJECT_DIR=/home/msytc/project/have-fun/personal-tools
FILES=frontend/src/app/page.tsx
TIMEOUT=900
PRINT_TIMEOUT=15m
MODEL=gemini-3.6-flash-medium gemini-3.8-flash-medium
VERIFY=cd frontend && bun run build
COMMIT=docs: correct worker location copy in dispatch UI
`;
    const parsed = parseMetaContent(raw);
    expect(parsed.PROJECT_DIR).toBe("/home/msytc/project/have-fun/personal-tools");
    expect(parsed.FILES).toBe("frontend/src/app/page.tsx");
    expect(parsed.TIMEOUT).toBe("900");
    expect(parsed.PRINT_TIMEOUT).toBe("15m");
    expect(parsed.MODEL).toBe("gemini-3.6-flash-medium gemini-3.8-flash-medium");
    expect(parsed.VERIFY).toBe("cd frontend && bun run build");
    expect(parsed.COMMIT).toBe("docs: correct worker location copy in dispatch UI");
  });

  test("parseMetaContent mengabaikan komentar dan baris kosong", () => {
    const raw = `
# Ini adalah komentar
PROJECT_DIR=/path/to/repo

# Komentar lain
COMMIT=fix: something
`;
    const parsed = parseMetaContent(raw);
    expect(Object.keys(parsed)).toEqual(["PROJECT_DIR", "COMMIT"]);
    expect(parsed.PROJECT_DIR).toBe("/path/to/repo");
    expect(parsed.COMMIT).toBe("fix: something");
  });

  test("parseMetaContent menghapus tanda kutip luar (double quotes & single quotes)", () => {
    const raw = `
VERIFY="cd backend && go test ./... 2>&1 | tail -8"
MSG='hello world: testing quotes'
EXTRA="nested 'quote' test"
`;
    const parsed = parseMetaContent(raw);
    expect(parsed.VERIFY).toBe("cd backend && go test ./... 2>&1 | tail -8");
    expect(parsed.MSG).toBe("hello world: testing quotes");
    expect(parsed.EXTRA).toBe("nested 'quote' test");
  });

  test("parseMetaContent menangani nilai dengan tanda sama dengan (=)", () => {
    const raw = `CMD=bun test --filter=foo=bar`;
    const parsed = parseMetaContent(raw);
    expect(parsed.CMD).toBe("bun test --filter=foo=bar");
  });

  test("parseMetaContent menangani input kosong / tanpa pasangan valid", () => {
    expect(parseMetaContent("")).toEqual({});
    expect(parseMetaContent("   \n\n  # comment only\n")).toEqual({});
    expect(parseMetaContent("invalid line without equals")).toEqual({});
  });

  test("resolveBacklogStatus memprioritaskan subfolder done/ -> DONE", () => {
    expect(resolveBacklogStatus({ isDoneInSubdir: true, localTaskStatus: "RUNNING" })).toBe("DONE");
    expect(resolveBacklogStatus({ isDoneInSubdir: true, localTaskStatus: "COMPLETED" })).toBe("DONE");
    expect(resolveBacklogStatus({ isDoneInSubdir: true, localTaskStatus: null })).toBe("DONE");
  });

  test("resolveBacklogStatus menggunakan status tabel lokal jika ada dan belum di done/", () => {
    expect(resolveBacklogStatus({ isDoneInSubdir: false, localTaskStatus: "RUNNING" })).toBe("RUNNING");
    expect(resolveBacklogStatus({ isDoneInSubdir: false, localTaskStatus: "COMPLETED" })).toBe("COMPLETED");
    expect(resolveBacklogStatus({ isDoneInSubdir: false, localTaskStatus: "FAILED" })).toBe("FAILED");
  });

  test("resolveBacklogStatus fallback ke PENDING jika tidak di done/ dan tidak ada di db lokal", () => {
    expect(resolveBacklogStatus({ isDoneInSubdir: false, localTaskStatus: null })).toBe("PENDING");
    expect(resolveBacklogStatus({ isDoneInSubdir: false, localTaskStatus: undefined })).toBe("PENDING");
  });

  test("parseBacklogMeta mengembalikan field minimal id, project_dir, commit, status", () => {
    const raw = `PROJECT_DIR=/repo/app\nCOMMIT=feat: awesome feature\nMODEL=gemini-3.7-flash-medium`;
    const item = parseBacklogMeta("PT-99", raw, "PENDING");
    expect(item.id).toBe("PT-99");
    expect(item.project_dir).toBe("/repo/app");
    expect(item.commit).toBe("feat: awesome feature");
    expect(item.status).toBe("PENDING");
    expect(item.model).toBe("gemini-3.7-flash-medium");
  });
});

describe("resolusi path lingkungan & multi-lane", () => {
  test("resolveDbPath default relatif ke cwd (agent_tasks.sqlite)", () => {
    expect(resolveDbPath()).toBe("agent_tasks.sqlite");
    expect(resolveDbPath("")).toBe("agent_tasks.sqlite");
    expect(resolveDbPath("   ")).toBe("agent_tasks.sqlite");
  });

  test("resolveDbPath menerima override env DB_PATH", () => {
    expect(resolveDbPath("/custom/path/agent.sqlite")).toBe("/custom/path/agent.sqlite");
    expect(resolveDbPath("custom.sqlite")).toBe("custom.sqlite");
  });

  test("resolveLogDir default ke <cwd>/logs", () => {
    expect(resolveLogDir(undefined, "/lane2/dir")).toBe("/lane2/dir/logs");
    expect(resolveLogDir("", "/lane2/dir")).toBe("/lane2/dir/logs");
  });

  test("resolveLogDir menerima override env LOG_DIR", () => {
    expect(resolveLogDir("/var/log/agent-hub", "/lane2/dir")).toBe("/var/log/agent-hub");
  });

  test("resolveDashboardPath selalu merujuk ke public/index.html di folder module", () => {
    expect(resolveDashboardPath("/opt/agent-hub")).toBe("/opt/agent-hub/public/index.html");
  });
});

describe("format status dashboard", () => {
  test("getStatusBadgeClass mengembalikan class badge yang sesuai", () => {
    expect(getStatusBadgeClass("NO_CHANGES")).toBe("bg-slate-100 text-slate-700");
    expect(getStatusBadgeClass("COMPLETED")).toBe("bg-green-100 text-green-800");
    expect(getStatusBadgeClass("FAILED")).toBe("bg-red-100 text-red-800");
    expect(getStatusBadgeClass("PENDING")).toBe("bg-yellow-100 text-yellow-800");
    expect(getStatusBadgeClass("RUNNING")).toBe("bg-blue-100 text-blue-800 animate-pulse");
    expect(getStatusBadgeClass("TIMED_OUT")).toBe("bg-orange-100 text-orange-800");
    expect(getStatusBadgeClass("UNVERIFIED")).toBe("bg-amber-100 text-amber-800");
    expect(getStatusBadgeClass("UNKNOWN")).toBe("bg-gray-100 text-gray-800");
  });

  test("getStatusLabel mengubah NO_CHANGES menjadi 'NO CHANGES'", () => {
    expect(getStatusLabel("NO_CHANGES")).toBe("NO CHANGES");
    expect(getStatusLabel("COMPLETED")).toBe("COMPLETED");
    expect(getStatusLabel("PENDING")).toBe("PENDING");
  });

  test("getStatusDescription memberikan penjelasan untuk NO_CHANGES", () => {
    expect(getStatusDescription("NO_CHANGES")).toBe("agy tidak mengubah file apa pun (bukan sukses, bukan gagal)");
    expect(getStatusDescription("COMPLETED")).toBe("");
  });
});

describe("extractBacklogRef", () => {
  test("(a) prompt memuat baris 'REF: PT-49' -> 'PT-49'", () => {
    expect(extractBacklogRef("REF: PT-49")).toBe("PT-49");
    expect(extractBacklogRef("REF: PT-49\nTolong perbaiki bug ini")).toBe("PT-49");
  });

  test("(b) 'ref: aw-31' -> 'AW-31' (case-insensitive)", () => {
    expect(extractBacklogRef("ref: aw-31")).toBe("AW-31");
    expect(extractBacklogRef("Ref: Aw-31")).toBe("AW-31");
    expect(extractBacklogRef("REF: aw_31.v2")).toBe("AW_31.V2");
  });

  test("(c) prompt tanpa REF -> null", () => {
    expect(extractBacklogRef("Tolong jalankan migrasi database")).toBeNull();
    expect(extractBacklogRef("PREFIX_REF: PT-49")).toBeNull();
    expect(extractBacklogRef("REF: ")).toBeNull();
  });

  test("(d) prompt multi-baris dengan REF di tengah -> tetap terdeteksi", () => {
    const prompt = `ATURAN OPERASIONAL CLI:
- Kerjakan di foreground

REF: PT-49

--- TUGAS ---
Perbaiki issue pada dashboard.`;
    expect(extractBacklogRef(prompt)).toBe("PT-49");

    const promptLower = `Header line 1
Header line 2
  ref: aw-31  
Detail tugas di bawah.`;
    expect(extractBacklogRef(promptLower)).toBe("AW-31");
  });

  test("(e) prompt kosong -> null", () => {
    expect(extractBacklogRef("")).toBeNull();
    expect(extractBacklogRef("   \n\t  ")).toBeNull();
    expect(extractBacklogRef(null as any)).toBeNull();
    expect(extractBacklogRef(undefined as any)).toBeNull();
  });
});

describe("collectDocsSections", () => {
  const createMockFs = (files: Record<string, string>) => ({
    exists: (p: string) => p in files,
    readText: (p: string) => {
      if (p in files) return files[p];
      throw new Error(`File not found: ${p}`);
    },
    readdir: (p: string) => {
      const normalized = p.replace(/\/+$/, "");
      const matched = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(normalized + "/")) {
          const rest = f.slice(normalized.length + 1);
          const segment = rest.split("/")[0];
          if (segment) matched.add(segment);
        }
      }
      return Array.from(matched);
    },
  });

  test("skenario 1: semua 4 file docs ada -> mengembalikan 4 section lengkap", () => {
    const fs = createMockFs({
      "/repo/my-app/docs/TECH_STACK.md": "# Tech Stack\nBun, TypeScript, Elysia",
      "/repo/my-app/docs/CODE_CONTRACT.md": "# Code Contract\nNo mutation",
      "/repo/my-app/docs/RUNBOOK.md": "# Runbook\nbun run dev",
      "/repo/my-app/docs/LOG.md": "# Log\n- 2026-10-04: Initial setup",
    });

    const res = collectDocsSections("/repo/my-app", fs);
    expect(res).toHaveLength(4);
    expect(res).toEqual([
      { section: "tech_stack", content: "# Tech Stack\nBun, TypeScript, Elysia" },
      { section: "code_contract", content: "# Code Contract\nNo mutation" },
      { section: "runbook", content: "# Runbook\nbun run dev" },
      { section: "log", content: "# Log\n- 2026-10-04: Initial setup" },
    ]);
  });

  test("skenario 2: hanya sebagian file yang ada -> mengabaikan file yang tidak ada", () => {
    const fs = createMockFs({
      "/repo/partial/docs/TECH_STACK.md": "# Tech Stack\nGo, SQLite",
      "/repo/partial/docs/LOG.md": "# Log\nChangelog here",
    });

    const res = collectDocsSections("/repo/partial", fs);
    expect(res).toHaveLength(2);
    expect(res).toEqual([
      { section: "tech_stack", content: "# Tech Stack\nGo, SQLite" },
      { section: "log", content: "# Log\nChangelog here" },
    ]);
  });

  test("skenario 3: nama file case-insensitive (mis. tech_stack.md, CODE_CONTRACT.MD, Runbook.md, log.md)", () => {
    const fs = createMockFs({
      "/repo/mixed-case/docs/tech_stack.md": "tech stack lowercase",
      "/repo/mixed-case/docs/CODE_CONTRACT.MD": "contract uppercase ext",
      "/repo/mixed-case/docs/RunBook.md": "runbook mixed case",
      "/repo/mixed-case/docs/log.MD": "log content",
      "/repo/mixed-case/docs/README.md": "should be ignored",
    });

    const res = collectDocsSections("/repo/mixed-case", fs);
    expect(res).toHaveLength(4);
    expect(res).toEqual([
      { section: "tech_stack", content: "tech stack lowercase" },
      { section: "code_contract", content: "contract uppercase ext" },
      { section: "runbook", content: "runbook mixed case" },
      { section: "log", content: "log content" },
    ]);
  });

  test("skenario 4: folder docs kosong atau tidak memiliki 4 file yang dicari -> mengembalikan array kosong", () => {
    const fsEmpty = createMockFs({
      "/repo/empty/docs/README.md": "# Overview only",
      "/repo/empty/docs/ARCHITECTURE.md": "# Architecture",
    });
    expect(collectDocsSections("/repo/empty", fsEmpty)).toEqual([]);

    const fsNoDocs = createMockFs({
      "/repo/no-docs/src/index.ts": "console.log('hi')",
    });
    expect(collectDocsSections("/repo/no-docs", fsNoDocs)).toEqual([]);
  });

  test("skenario 5: fallback in-memory fs tanpa readdir (hanya exists dan readText)", () => {
    const files: Record<string, string> = {
      "/repo/simple/docs/tech_stack.md": "tech stack simple",
      "/repo/simple/docs/RUNBOOK.md": "runbook simple",
    };
    const simpleFs = {
      exists: (p: string) => p in files,
      readText: (p: string) => files[p],
    };

    const res = collectDocsSections("/repo/simple", simpleFs);
    expect(res).toHaveLength(2);
    expect(res).toEqual([
      { section: "tech_stack", content: "tech stack simple" },
      { section: "runbook", content: "runbook simple" },
    ]);
  });
});

describe("withDocPreamble & DOC_DRIVEN_PREAMBLE", () => {
  test("skenario 1: membungkus prompt sederhana dengan preamble dan header tugas", () => {
    const prompt = "Perbaiki error di modul login";
    const result = withDocPreamble(prompt);
    expect(result).toBe(`${DOC_DRIVEN_PREAMBLE}\n\n--- TUGAS ---\n${prompt}`);
    expect(result.startsWith(DOC_DRIVEN_PREAMBLE)).toBe(true);
    expect(result.endsWith(prompt)).toBe(true);
  });

  test("skenario 2: membungkus prompt kompleks multi-baris dan mempertahankan isi prompt", () => {
    const complexPrompt = `REF: PT-100\n\nBuat unit test baru untuk fungsi withDocPreamble.\nPastikan coverage 100%.`;
    const result = withDocPreamble(complexPrompt);
    expect(result).toBe(`${DOC_DRIVEN_PREAMBLE}\n\n--- TUGAS ---\n${complexPrompt}`);
    expect(result).toContain("\n\n--- TUGAS ---\nREF: PT-100");
  });

  test("skenario 3: menangani prompt string kosong", () => {
    const result = withDocPreamble("");
    expect(result).toBe(`${DOC_DRIVEN_PREAMBLE}\n\n--- TUGAS ---\n`);
  });

  test("skenario 4: DOC_DRIVEN_PREAMBLE memuat aturan wajib Doc-Driven Dev & operasional CLI", () => {
    expect(DOC_DRIVEN_PREAMBLE).toContain("docs/");
    expect(DOC_DRIVEN_PREAMBLE).toContain("TECH_STACK.md");
    expect(DOC_DRIVEN_PREAMBLE).toContain("CODE_CONTRACT.md");
    expect(DOC_DRIVEN_PREAMBLE).toContain("RUNBOOK.md");
    expect(DOC_DRIVEN_PREAMBLE).toContain("FOREGROUND");
    expect(DOC_DRIVEN_PREAMBLE).toContain("push");
    expect(DOC_DRIVEN_PREAMBLE).toContain("Indonesia");
  });
});

describe("buildLogEntry & appendLogEntry", () => {
  test("skenario 1: buildLogEntry menyusun baris format: - <ISO timestamp> | <taskRef> | <verdict> | <commit7> | <n files>", () => {
    const entry = buildLogEntry({
      timestamp: "2026-10-04T09:00:00.000Z",
      taskRef: "PT-49",
      verdict: "COMPLETED",
      commit7: "744846f",
      numFiles: 3,
    });
    expect(entry).toBe("- 2026-10-04T09:00:00.000Z | PT-49 | COMPLETED | 744846f | 3 files");
  });

  test("skenario 2: buildLogEntry memotong commit > 7 char dan menangani 1 file vs n files", () => {
    const singleFile = buildLogEntry({
      timestamp: "2026-10-04T09:00:00.000Z",
      taskRef: "AW-12",
      verdict: "COMPLETED",
      commit: "abcdef1234567890",
      numFiles: 1,
    });
    expect(singleFile).toBe("- 2026-10-04T09:00:00.000Z | AW-12 | COMPLETED | abcdef1 | 1 file");

    const zeroFiles = buildLogEntry({
      timestamp: "2026-10-04T09:00:00.000Z",
      taskRef: "TASK-1",
      verdict: "COMPLETED",
      numFiles: 0,
    });
    expect(zeroFiles).toBe("- 2026-10-04T09:00:00.000Z | TASK-1 | COMPLETED | - | 0 files");
  });

  test("skenario 3: buildLogEntry menghasilkan timestamp ISO default jika tidak diisi", () => {
    const entry = buildLogEntry({
      taskRef: "PT-50",
      verdict: "COMPLETED",
      commit7: "a1b2c3d",
      numFiles: 2,
    });
    expect(entry).toMatch(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \| PT-50 \| COMPLETED \| a1b2c3d \| 2 files$/);
  });

  test("skenario 4: appendLogEntry dari string kosong", () => {
    const entry = "- 2026-10-04T09:00:00.000Z | PT-49 | COMPLETED | 744846f | 3 files";
    const result = appendLogEntry("", entry);
    expect(result).toBe("- 2026-10-04T09:00:00.000Z | PT-49 | COMPLETED | 744846f | 3 files\n");
  });

  test("skenario 5: appendLogEntry dari isi lama berakhiran newline", () => {
    const existing = "# Log\n";
    const entry = "- 2026-10-04T09:00:00.000Z | PT-49 | COMPLETED | 744846f | 3 files";
    const result = appendLogEntry(existing, entry);
    expect(result).toBe("# Log\n- 2026-10-04T09:00:00.000Z | PT-49 | COMPLETED | 744846f | 3 files\n");
  });

  test("skenario 6: appendLogEntry dari isi lama tanpa newline", () => {
    const existing = "# Log";
    const entry = "- 2026-10-04T09:00:00.000Z | PT-49 | COMPLETED | 744846f | 3 files";
    const result = appendLogEntry(existing, entry);
    expect(result).toBe("# Log\n- 2026-10-04T09:00:00.000Z | PT-49 | COMPLETED | 744846f | 3 files\n");
  });

  test("skenario 7: appendLogEntry multi-entri beruntun", () => {
    const header = "# Log\n";
    const entry1 = "- 2026-10-04T08:00:00.000Z | PT-48 | COMPLETED | 1111111 | 1 file";
    const entry2 = "- 2026-10-04T09:00:00.000Z | PT-49 | COMPLETED | 2222222 | 2 files";

    const step1 = appendLogEntry(header, entry1);
    const step2 = appendLogEntry(step1, entry2);

    expect(step2).toBe(
      "# Log\n- 2026-10-04T08:00:00.000Z | PT-48 | COMPLETED | 1111111 | 1 file\n- 2026-10-04T09:00:00.000Z | PT-49 | COMPLETED | 2222222 | 2 files\n",
    );
  });
});





