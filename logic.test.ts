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


