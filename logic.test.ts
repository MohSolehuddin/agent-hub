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


