import { describe, expect, test } from "bun:test";
import { detectGate, pickModel, isQuotaError, parseResetSeconds, verdict, summarizeGateOutput } from "./logic";

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
