import { Elysia } from "elysia";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import { db } from "./db";
import { join, basename } from "path";
import fs from "fs";
import {
  detectGate,
  pickModel,
  isQuotaError,
  parseResetSeconds,
  verdict,
  summarizeGateOutput,
  type GateSpec,
} from "./logic";

const execAsync = promisify(exec);

// ---------- Konfigurasi ----------
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const WORKER_TOKEN = process.env.AGENT_WORKER_TOKEN || "";
const AGENT_NAME = process.env.AGENT_NAME || "agent-hub";
const MODELS = (process.env.AGY_MODELS || "gemini-3.7-flash-medium gemini-3.6-flash-medium gemini-3.8-flash-medium")
  .split(/\s+/)
  .filter(Boolean);
const PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT || "15m";
const DEFAULT_TIMEOUT_MIN = Number(process.env.DEFAULT_TIMEOUT_MIN || 30);
const DEFAULT_WORKSPACE =
  process.env.DEFAULT_WORKSPACE || join(process.env.HOME || "/home/msytc", "project/have-fun/personal-tools");
const POLL_MS = Number(process.env.POLL_MS || 10000);
const LOG_DIR = join(process.cwd(), "logs");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

let isRunning = false;

const log = (...a: any[]) => console.log(new Date().toISOString(), ...a);

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (WORKER_TOKEN) h["X-Worker-Token"] = WORKER_TOKEN;
  return h;
}

// ---------- 1. Ambil tugas (klaim atomik dari server) ----------
async function fetchTasksFromServer() {
  try {
    const res = await fetch(`${SERVER_URL}/api/agent-dispatcher/claim`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agent: AGENT_NAME }),
    });
    if (!res.ok) {
      log(`[!] claim gagal: HTTP ${res.status} ${res.statusText}`);
      return;
    }

    const data: any = await res.json();
    if (!data?.has_task || !data?.task) return;

    const t = data.task;
    const project = t.project_path || DEFAULT_WORKSPACE;
    db.run(
      `INSERT INTO tasks (task_prompt, target_project, server_task_id, server_task_ref, timeout_minutes, status)
       VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      [t.prompt, project, t.task_id ?? null, t.task_id ?? null, Number(t.timeout_minutes) || DEFAULT_TIMEOUT_MIN],
    );
    log(`[⬇️] Tugas ${t.task_id} diklaim dari server (repo: ${project})`);
  } catch (err: any) {
    log(`[!] claim error: ${err?.message ?? err}`);
  }
}

// ---------- 2. Gate verifikasi ----------
function firstFailingCmd(gate: GateSpec, out: string): string {
  const last = out.lastIndexOf("$ ");
  const near = out.slice(Math.max(0, last - 2000));
  const failed = gate.commands.find((c) => near.includes(`$ ${c}`));
  return failed ?? gate.commands[0];
}

async function runGate(gate: GateSpec, cwd: string) {
  let out = "";
  let allOk = true;
  let failedCmd = "";
  for (const cmd of gate.commands) {
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 });
      out += `$ ${cmd}\n${stdout}${stderr}\n`;
    } catch (err: any) {
      allOk = false;
      failedCmd = cmd;
      out += `$ ${cmd}\n${err?.stdout ?? ""}${err?.stderr ?? err?.message ?? ""}\n`;
      break; // berhenti di kegagalan pertama
    }
  }
  const shown = allOk ? gate.commands[gate.commands.length - 1] : failedCmd || firstFailingCmd(gate, out);
  return {
    ran: true,
    ok: allOk,
    summary: summarizeGateOutput(shown, allOk, out),
    output: out,
  };
}

// ---------- 3. Jalankan satu tugas ----------
type AgyRun = { code: number | null; stdout: string; stderr: string; killed: boolean };

function runAgy(args: string[], cwd: string, timeoutMs: number): Promise<AgyRun> {
  return new Promise((resolve) => {
    const child = spawn("agy", args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      log(`[!] timeout ${Math.round(timeoutMs / 60000)} menit -> SIGKILL agy`);
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
    child.on("error", (err: any) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + `\n[spawn error] ${err?.message ?? err}`, killed });
    });
  });
}

function appendQuota(model: string, resetSeconds: number | null) {
  try {
    fs.appendFileSync(
      join(LOG_DIR, "quota.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), agent: AGENT_NAME, model, reset_seconds: resetSeconds }) + "\n",
    );
  } catch (e: any) {
    log(`[!] gagal menulis quota.jsonl: ${e?.message ?? e}`);
  }
}

async function finish(
  task: any,
  r: {
    status: string;
    exitCode: number;
    outputTail: string;
    error: string;
    t0: number;
    startedAt: Date;
    project: string;
    gitCommit?: string;
  },
) {
  const durationMs = Date.now() - r.t0;
  const completedAt = new Date();
  const logPath = join(LOG_DIR, `${task.server_task_id || task.id}.log`);

  try {
    fs.writeFileSync(logPath, r.outputTail);
  } catch (e: any) {
    log(`[!] gagal menulis log: ${e?.message ?? e}`);
  }

  db.run(
    `UPDATE tasks SET status = ?, stdout = ?, stderr = ?, model_used = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [r.status, r.outputTail, r.error, r.gitCommit ?? "", task.id],
  );

  log(`[${r.status === "COMPLETED" ? "✅" : "❌"}] tugas #${task.id} -> ${r.status} (${Math.round(durationMs / 1000)}s) ${r.error}`);

  const serverTaskId = task.server_task_id;
  if (!serverTaskId) return;

  try {
    const res = await fetch(`${SERVER_URL}/api/agent-dispatcher/callback`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        task_id: String(serverTaskId),
        agent: AGENT_NAME,
        status: r.status,
        exit_code: r.exitCode,
        prompt: task.task_prompt,
        project_path: r.project,
        full_log_path: logPath,
        output_tail: r.outputTail,
        git_commit: r.gitCommit ?? "",
        duration_ms: durationMs,
        started_at: r.startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        error: r.error,
      }),
    });
    if (!res.ok) log(`[!] callback gagal: HTTP ${res.status}`);
  } catch (e: any) {
    log(`[!] callback error: ${e?.message ?? e}`);
  }
}

async function processLocalTasks() {
  if (isRunning) return;

  const task = db.query(`SELECT * FROM tasks WHERE status = 'PENDING' ORDER BY id ASC LIMIT 1`).get() as any;
  if (!task) return;

  isRunning = true;
  const startedAt = new Date();
  const t0 = Date.now();
  const targetProject: string = task.target_project || DEFAULT_WORKSPACE;
  const timeoutMs = (Number(task.timeout_minutes) || DEFAULT_TIMEOUT_MIN) * 60 * 1000;

  log(`[⚙️] Mulai tugas lokal #${task.id} (server: ${task.server_task_id}) di ${targetProject}`);

  if (!fs.existsSync(targetProject)) {
    await finish(task, {
      status: "FAILED",
      exitCode: 1,
      outputTail: "",
      error: `Workspace tidak ditemukan: ${targetProject}`,
      t0,
      startedAt,
      project: targetProject,
    });
    isRunning = false;
    return;
  }

  db.run(`UPDATE tasks SET status = 'RUNNING', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [task.id]);

  let stdoutData = "";
  let stderrData = "";
  let killed = false;
  let usedModel = "default";
  let agyExitCode: number | null = null;
  let quotaExhausted = false;
  const tried: string[] = [];

  while (true) {
    const model = pickModel(MODELS, tried);
    if (!model) {
      quotaExhausted = true;
      break;
    }
    tried.push(model);
    usedModel = model;

    const args = [
      "-p",
      task.task_prompt,
      "--dangerously-skip-permissions",
      "--add-dir",
      targetProject,
      "--model",
      model,
      "--print-timeout",
      PRINT_TIMEOUT,
    ];

    const result = await runAgy(args, targetProject, timeoutMs);
    stdoutData += result.stdout;
    stderrData += result.stderr;
    agyExitCode = result.code;
    killed = killed || result.killed;

    if (killed || result.code === 0) break;

    const combined = `${result.stdout}\n${result.stderr}`;
    if (isQuotaError(combined)) {
      const reset = parseResetSeconds(combined);
      appendQuota(model, reset);
      log(`[↻] model ${model} kena limit (reset ~${reset ?? "?"}s) -> coba model berikutnya`);
      continue;
    }
    break; // error biasa
  }

  const gate = detectGate(targetProject, basename(targetProject), {
    exists: (p) => fs.existsSync(p),
    readJson: (p) => JSON.parse(fs.readFileSync(p, "utf8")),
  });

  let gateResult: { ran: boolean; ok: boolean; summary: string; output: string } | null = null;
  if (gate && !killed && agyExitCode === 0) {
    log(`[🔍] gate verifikasi (${gate.source}): ${gate.commands.join(" && ")}`);
    const g = await runGate(gate, targetProject);
    gateResult = g;
    stdoutData += `\n\n------ VERIFIKASI ------\n${g.output}`;
  } else if (gate) {
    log(`[!] gate dilewati (agy exit=${agyExitCode}, killed=${killed})`);
  } else {
    log(`[!] tidak ada gate untuk repo ${basename(targetProject)}`);
  }

  const v = verdict({
    agyExitCode: quotaExhausted ? 1 : agyExitCode,
    agyOutput: `${stdoutData}\n${stderrData}`,
    gate: gateResult ? { ran: true, ok: gateResult.ok, summary: gateResult.summary } : null,
    killed,
  });

  let gitCommit = "";
  let gitStatus = "";
  try {
    gitCommit = (await execAsync("git rev-parse --short HEAD", { cwd: targetProject })).stdout.trim();
    gitStatus = (await execAsync("git status --porcelain", { cwd: targetProject })).stdout.trim();
  } catch (e: any) {
    stderrData += `\n[!] git info gagal: ${e?.message ?? e}`;
  }

  const outputTail = [
    stdoutData,
    stderrData ? `\n------ STDERR ------\n${stderrData}` : "",
    "",
    "--- Post-Execution ---",
    `Verdict: ${v.status} (${v.reason})`,
    `Model dipakai: ${usedModel}`,
    `Commit: ${gitCommit || "-"}`,
    "Git status:",
    gitStatus || "(bersih)",
  ]
    .join("\n")
    .slice(-4000);

  await finish(task, {
    status: v.ok ? "COMPLETED" : "FAILED",
    exitCode: killed ? 124 : agyExitCode ?? 1,
    outputTail,
    error: v.ok ? "" : v.reason,
    t0,
    startedAt,
    project: targetProject,
    gitCommit,
  });

  isRunning = false;
}

// ---------- 4. Dashboard & API lokal ----------
new Elysia()
  .get("/api/local-tasks", () => db.query(`SELECT * FROM tasks ORDER BY id DESC LIMIT 100`).all())
  .get("/api/health", () => ({ ok: true, agent: AGENT_NAME, models: MODELS, running: isRunning }))
  .get("/", () => Bun.file("public/index.html"))
  .listen(Number(process.env.PORT || 4000));

log(`🚀 [Agent Hub] aktif — dashboard: http://localhost:${process.env.PORT || 4000}`);
log(`   server: ${SERVER_URL} | agent: ${AGENT_NAME}`);
log(`   model: ${MODELS.join(", ")} | print-timeout: ${PRINT_TIMEOUT}`);
log(`   token worker: ${WORKER_TOKEN ? "aktif" : "TIDAK diset (endpoint publik)"}`);

setInterval(fetchTasksFromServer, POLL_MS);
setInterval(processLocalTasks, 3000);
