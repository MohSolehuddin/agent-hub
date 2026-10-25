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
  CLAIM_RETRY_DELAYS,
  CLAIM_MAX_BACKOFF_MS,
  isRetryableHttpStatus,
  isThrottledStatus,
  parseRetryAfterSeconds,
  nextClaimDelayMs,
  parseBacklogMeta,
  resolveBacklogStatus,
  type BacklogItem,
  hasGitChanges,
  resolveLogDir,
  resolveDashboardPath,
  extractBacklogRef,
  collectDocsSections,
  withDocPreamble,
  buildLogEntry,
  appendLogEntry,
  isNoiseGitLine,
  resolveEngine,
  resolveEngineModels,
  resolveOpencodeBin,
  buildEngineArgs,
  isPathInsideAllowlist,
  parseAllowPrefixes,
  resolveAllowedGateCommands,
  readGateConfigFingerprint,
  resolveGateAfterRun,
  splitCommand,
} from "./logic";

const execAsync = promisify(exec);

// ---------- Konfigurasi ----------
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const WORKER_TOKEN = process.env.AGENT_WORKER_TOKEN || "";
const AGENT_NAME = process.env.AGENT_NAME || "agent-hub";
const ENGINE = resolveEngine(process.env.ENGINE);
const MODELS = resolveEngineModels(ENGINE, {
  AGY_MODELS: process.env.AGY_MODELS,
  OPENCODE_MODELS: process.env.OPENCODE_MODELS,
});
const OPENCODE_BIN = resolveOpencodeBin(process.env.OPENCODE_BIN, process.env.HOME);
const PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT || "15m";
const DEFAULT_TIMEOUT_MIN = Number(process.env.DEFAULT_TIMEOUT_MIN || 30);
const HOME_DIR = process.env.HOME || "/home/msytc";
const DEFAULT_WORKSPACE =
  process.env.DEFAULT_WORKSPACE || join(HOME_DIR, "project/have-fun/personal-tools");
const BACKLOG_DIR = process.env.BACKLOG_DIR || join(HOME_DIR, "hermes-work/review-loop/tasks");
const POLL_MS = Number(process.env.POLL_MS || 10000);
const LOG_DIR = resolveLogDir(process.env.LOG_DIR, process.cwd());
const DASHBOARD_HTML_PATH = resolveDashboardPath(import.meta.dir);
const PROJECT_ALLOW_PREFIXES = parseAllowPrefixes(process.env.PROJECT_ALLOW_PREFIXES);
const ALLOWED_GATE_COMMANDS = resolveAllowedGateCommands(process.env.GATE_ALLOW_EXTRA);

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

let isRunning = false;

const log = (...a: any[]) => console.log(new Date().toISOString(), ...a);

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (WORKER_TOKEN) h["X-Worker-Token"] = WORKER_TOKEN;
  return h;
}

// ---------- 1. Ambil tugas (klaim atomik dari server) ----------
//
// Mengembalikan outcome siklus poll supaya pemanggil bisa mengatur backoff:
//
//	ok       : true bila server membalas 200 (siklus sehat, walau tidak ada tugas)
//	status   : kode HTTP terakhir bila gagal
//	claimed  : true bila satu tugas berhasil diklaim
//	retryAfter: nilai header Retry-After (detik) bila server mengirimkannya
type ClaimOutcome = {
  ok: boolean;
  status?: number;
  claimed: boolean;
  retryAfterSeconds?: number | null;
};

async function fetchTasksFromServer(): Promise<ClaimOutcome> {
  for (let attempt = 0; attempt <= CLAIM_RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetch(`${SERVER_URL}/api/agent-dispatcher/claim`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent: AGENT_NAME }),
      });
      if (!res.ok) {
        const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get("Retry-After"));

        // 429 (throttle) TIDAK di-retry cepat di siklus yang sama — poller menyerahkan
        // pengaturan jeda ke cooldown antar-siklus (lihat pollOnce), supaya tidak
        // memperparah limpahan request ke server.
        if (isThrottledStatus(res.status)) {
          return { ok: false, status: res.status, claimed: false, retryAfterSeconds };
        }

        if (isRetryableHttpStatus(res.status) && attempt < CLAIM_RETRY_DELAYS.length) {
          const delayMs = CLAIM_RETRY_DELAYS[attempt];
          log(
            `[!] claim gagal: HTTP ${res.status} ${res.statusText} -> retry ${attempt + 1}/${CLAIM_RETRY_DELAYS.length} dalam ${delayMs / 1000}s...`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        return { ok: false, status: res.status, claimed: false, retryAfterSeconds };
      }

      const data: any = await res.json();
      if (!data?.has_task || !data?.task) return { ok: true, status: res.status, claimed: false };

      const t = data.task;
      const project = t.project_path || DEFAULT_WORKSPACE;
      const serverTaskRef = extractBacklogRef(t.prompt) ?? t.server_task_ref ?? t.task_id ?? null;
      db.run(
        `INSERT INTO tasks (task_prompt, target_project, server_task_id, server_task_ref, timeout_minutes, status)
         VALUES (?, ?, ?, ?, ?, 'PENDING')`,
        [t.prompt, project, t.task_id ?? null, serverTaskRef, Number(t.timeout_minutes) || DEFAULT_TIMEOUT_MIN],
      );
      log(`[⬇️] Tugas ${t.task_id} diklaim dari server (repo: ${project})`);
      return { ok: true, status: res.status, claimed: true };
    } catch (err: any) {
      if (attempt < CLAIM_RETRY_DELAYS.length) {
        const delayMs = CLAIM_RETRY_DELAYS[attempt];
        log(
          `[!] claim error: ${err?.message ?? err} -> retry ${attempt + 1}/${CLAIM_RETRY_DELAYS.length} dalam ${delayMs / 1000}s...`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      log(`[!] claim error: ${err?.message ?? err}`);
      return { ok: false, claimed: false };
    }
  }
  return { ok: false, claimed: false };
}

// ---------- 2. Gate verifikasi ----------
function firstFailingCmd(gate: GateSpec, out: string): string {
  const last = out.lastIndexOf("$ ");
  const near = out.slice(Math.max(0, last - 2000));
  const failed = gate.commands.find((c) => near.includes(`$ ${c}`));
  return failed ?? gate.commands[0];
}

function runGateCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number = 10 * 60 * 1000,
): Promise<CliRun> {
  const argv = splitCommand(cmd);
  if (argv.length === 0) {
    return Promise.resolve({ code: 1, stdout: "", stderr: "Empty command", killed: false });
  }

  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      log(`[!] timeout ${Math.round(timeoutMs / 60000)} menit -> SIGKILL gate ${cmd}`);
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

async function runGate(gate: GateSpec, cwd: string) {
  let out = "";
  let allOk = true;
  let failedCmd = "";
  for (const cmd of gate.commands) {
    const res = await runGateCommand(cmd, cwd, 10 * 60 * 1000);
    out += `$ ${cmd}\n${res.stdout}${res.stderr}\n`;
    if (res.code !== 0 || res.killed) {
      allOk = false;
      failedCmd = cmd;
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
type CliRun = { code: number | null; stdout: string; stderr: string; killed: boolean };

function runCli(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<CliRun> {
  return new Promise((resolve) => {
    // engine opencode menggantung bila stdin berupa pipe (menunggu EOF) -> stdin di-ignore
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      log(`[!] timeout ${Math.round(timeoutMs / 60000)} menit -> SIGKILL ${cmd}`);
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
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`[!] callback gagal: HTTP ${res.status} ${res.statusText} | ${body.slice(0, 200)}`);
    }
  } catch (e: any) {
    log(`[!] callback error: ${e?.message ?? e}`);
  }
}

async function syncProjectDocs(projectPath: string, commitSha?: string) {
  try {
    const realFs = {
      exists: (p: string) => fs.existsSync(p),
      readText: (p: string) => fs.readFileSync(p, "utf8"),
      readdir: (p: string) => fs.readdirSync(p),
    };

    const files = collectDocsSections(projectPath, realFs);
    if (files.length === 0) {
      log(`[ℹ️] docs sync: tidak ada file docs di ${basename(projectPath)}`);
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const body: Record<string, any> = {
      project: basename(projectPath),
      files,
    };
    if (commitSha) {
      body.commit_sha = commitSha;
    }

    try {
      const res = await fetch(`${SERVER_URL}/api/project-docs/sync`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        log(`[!] docs sync gagal: HTTP ${res.status} ${res.statusText}`);
      } else {
        log(`[📄] docs sync sukses (${files.length} sections) untuk ${basename(projectPath)}`);
      }
    } catch (fetchErr: any) {
      clearTimeout(timeoutId);
      log(`[!] docs sync error: ${fetchErr?.message ?? fetchErr}`);
    }
  } catch (err: any) {
    log(`[!] docs sync error: ${err?.message ?? err}`);
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

  if (PROJECT_ALLOW_PREFIXES.length > 0 && !isPathInsideAllowlist(targetProject, PROJECT_ALLOW_PREFIXES)) {
    await finish(task, {
      status: "FAILED",
      exitCode: 1,
      outputTail: "",
      error: `project_path di luar allowlist: ${targetProject}`,
      t0,
      startedAt,
      project: targetProject,
    });
    isRunning = false;
    return;
  }

  if (!fs.existsSync(targetProject)) {
    const hint = targetProject === DEFAULT_WORKSPACE
      ? ` (DEFAULT_WORKSPACE=${DEFAULT_WORKSPACE}). Set env DEFAULT_WORKSPACE atau buat foldernya.`
      : "";
    await finish(task, {
      status: "FAILED",
      exitCode: 1,
      outputTail: "",
      error: `Workspace tidak ditemukan: ${targetProject}${hint}`,
      t0,
      startedAt,
      project: targetProject,
    });
    isRunning = false;
    return;
  }

  db.run(`UPDATE tasks SET status = 'RUNNING', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [task.id]);

  let initialGitStatus = "";
  try {
    initialGitStatus = (await execAsync("git status --porcelain", { cwd: targetProject })).stdout.trim();
  } catch (e: any) {
    log(`[!] gagal mengambil git status awal: ${e?.message ?? e}`);
  }

  const repoIo = {
    exists: (p: string) => fs.existsSync(p),
    readText: (p: string) => fs.readFileSync(p, "utf8"),
    readJson: (p: string) => JSON.parse(fs.readFileSync(p, "utf8")),
  };
  const gateConfigBefore = readGateConfigFingerprint(targetProject, repoIo);

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

    const inv = buildEngineArgs({
      engine: ENGINE,
      prompt: withDocPreamble(task.task_prompt),
      model,
      repoDir: targetProject,
      printTimeout: PRINT_TIMEOUT,
      opencodeBin: OPENCODE_BIN,
    });

    const result = await runCli(inv.cmd, inv.args, targetProject, timeoutMs);
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

  let gate = detectGate(targetProject, basename(targetProject), repoIo, ALLOWED_GATE_COMMANDS);
  if (gate?.rejected && gate.rejected.length > 0) {
    log(`[!] gate repo-config menolak ${gate.rejected.length} perintah: ${gate.rejected.join(", ")}`);
  }

  const gateConfigAfter = readGateConfigFingerprint(targetProject, repoIo);
  if (gate?.source === "repo-config" && gateConfigBefore !== gateConfigAfter) {
    log(`[!] .agent-hub.json berubah saat task berjalan -> gate repo-config diabaikan`);
    const fallbackGate = detectGate(targetProject, basename(targetProject), repoIo, {
      ignoreRepoConfig: true,
      allow: ALLOWED_GATE_COMMANDS,
    });
    gate = resolveGateAfterRun(gate, gateConfigBefore, gateConfigAfter, fallbackGate);
  }

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

  let gitCommit = "";
  let gitStatus = "";
  try {
    gitCommit = (await execAsync("git rev-parse --short HEAD", { cwd: targetProject })).stdout.trim();
    gitStatus = (await execAsync("git status --porcelain", { cwd: targetProject })).stdout.trim();
  } catch (e: any) {
    stderrData += `\n[!] git info gagal: ${e?.message ?? e}`;
  }

  const changed = hasGitChanges(initialGitStatus, gitStatus);

  const v = verdict({
    agyExitCode: quotaExhausted ? 1 : agyExitCode,
    agyOutput: `${stdoutData}\n${stderrData}`,
    gate: gateResult ? { ran: true, ok: gateResult.ok, summary: gateResult.summary } : null,
    killed,
    changed,
  });

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
    status: v.status,
    exitCode: killed ? 124 : agyExitCode ?? 1,
    outputTail,
    error: v.ok ? "" : v.reason,
    t0,
    startedAt,
    project: targetProject,
    gitCommit,
  });

  if (v.status === "COMPLETED") {
    try {
      const docsDir = join(targetProject, "docs");
      if (!fs.existsSync(docsDir)) {
        fs.mkdirSync(docsDir, { recursive: true });
      }

      let logFileName = "LOG.md";
      if (fs.existsSync(docsDir)) {
        const entries = fs.readdirSync(docsDir);
        const matched = entries.find((e) => e.toLowerCase() === "log.md");
        if (matched) logFileName = matched;
      }
      const logFilePath = join(docsDir, logFileName);
      const existingContent = fs.existsSync(logFilePath) ? fs.readFileSync(logFilePath, "utf8") : "# Log\n";

      const changedFilesCount = (gitStatus || "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !isNoiseGitLine(l)).length;

      const taskRef = task.server_task_ref || task.server_task_id || (task.id ? `#${task.id}` : "-");

      const entry = buildLogEntry({
        timestamp: new Date().toISOString(),
        taskRef,
        verdict: v.status,
        commit7: gitCommit || "-",
        numFiles: changedFilesCount,
      });

      const updatedLog = appendLogEntry(existingContent, entry);
      fs.writeFileSync(logFilePath, updatedLog, "utf8");
      log(`[📝] LOG.md diperbarui untuk ${basename(targetProject)}: ${entry}`);
    } catch (logErr: any) {
      log(`[!] gagal menulis docs/LOG.md: ${logErr?.message ?? logErr}`);
    }

    await syncProjectDocs(targetProject, gitCommit || undefined);
  }

  isRunning = false;
}

// ---------- 4. Dashboard & API lokal ----------
function getBacklogTasks(): BacklogItem[] {
  try {
    if (!fs.existsSync(BACKLOG_DIR)) {
      return [];
    }

    const entries = fs.readdirSync(BACKLOG_DIR, { withFileTypes: true });
    const metaFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".meta"));

    if (metaFiles.length === 0) {
      return [];
    }

    const doneDir = join(BACKLOG_DIR, "done");
    const hasDoneDir = fs.existsSync(doneDir);

    const localTasks = db.query(`SELECT id, server_task_id, server_task_ref, status FROM tasks`).all() as Array<{
      id: number;
      server_task_id: string | null;
      server_task_ref: string | null;
      status: string;
    }>;

    const statusMap = new Map<string, string>();
    for (const t of localTasks) {
      if (t.server_task_id) statusMap.set(t.server_task_id, t.status);
      if (t.server_task_ref) statusMap.set(t.server_task_ref, t.status);
      statusMap.set(String(t.id), t.status);
    }

    const items: BacklogItem[] = [];

    for (const entry of metaFiles) {
      const fileName = entry.name;
      const id = fileName.slice(0, -5);
      const filePath = join(BACKLOG_DIR, fileName);

      let content = "";
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const isDone =
        hasDoneDir &&
        (fs.existsSync(join(doneDir, fileName)) ||
          fs.existsSync(join(doneDir, `${id}.meta`)) ||
          fs.existsSync(join(doneDir, id)));

      const localStatus = statusMap.get(id) || null;
      const status = resolveBacklogStatus({ isDoneInSubdir: isDone, localTaskStatus: localStatus });

      items.push(parseBacklogMeta(id, content, status));
    }

    items.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" }));

    return items;
  } catch (err: any) {
    log(`[!] error membaca backlog dir: ${err?.message ?? err}`);
    return [];
  }
}

new Elysia()
  .get("/api/local-tasks", () => db.query(`SELECT * FROM tasks ORDER BY id DESC LIMIT 100`).all())
  .get("/api/backlog", () => getBacklogTasks())
  .get("/api/health", () => ({ ok: true, agent: AGENT_NAME, engine: ENGINE, models: MODELS, running: isRunning }))
  .get("/", () => Bun.file(DASHBOARD_HTML_PATH))
  .listen(Number(process.env.PORT || 4000));

log(`🚀 [Agent Hub] aktif — dashboard: http://localhost:${process.env.PORT || 4000}`);
log(`   server: ${SERVER_URL} | agent: ${AGENT_NAME}`);
log(`   engine: ${ENGINE} | model: ${MODELS.join(", ")} | print-timeout: ${PRINT_TIMEOUT}`);
log(`   workspace: ${DEFAULT_WORKSPACE} | backlog: ${BACKLOG_DIR}`);
log(`   token worker: ${WORKER_TOKEN ? "aktif" : "TIDAK diset (endpoint publik)"}`);
if (PROJECT_ALLOW_PREFIXES.length === 0) {
  log(`[!] PROJECT_ALLOW_PREFIXES kosong: worker menerima project_path apa pun`);
} else {
  log(`   workspace allowlist: ${PROJECT_ALLOW_PREFIXES.join(", ")}`);
}
log(`[i] gate allowlist: ${ALLOWED_GATE_COMMANDS.length} perintah diizinkan`);

// Poller self-scheduling: jeda dihitung ulang setiap siklus sehingga kegagalan
// (429/502/503/504/jaringan) memicu backoff eksponensial + jitter, bukan tembakan
// tetap tiap POLL_MS. Ini mencegah 4 lane membanjiri /claim saat server sedang
// membatasi request, dan menghormati header Retry-After bila ada.
let consecutiveClaimFailures = 0;

function shouldLogClaimFailure(failures: number): boolean {
  // Log pada kegagalan ke-1, lalu 2, 4, 8, ... supaya log tidak membanjir selama outage.
  return failures === 1 || (failures & (failures - 1)) === 0;
}

async function pollOnce(): Promise<void> {
  const outcome = await fetchTasksFromServer();

  if (outcome.ok) {
    if (consecutiveClaimFailures > 0) {
      log(`[✓] claim kembali normal setelah ${consecutiveClaimFailures} kegagalan berturut-turut`);
    }
    consecutiveClaimFailures = 0;
  } else {
    consecutiveClaimFailures++;
    if (shouldLogClaimFailure(consecutiveClaimFailures)) {
      const detail = outcome.status ? `HTTP ${outcome.status}` : "error jaringan";
      log(`[!] claim gagal (${detail}) — kegagalan berturut-turut ${consecutiveClaimFailures}, poll berikutnya ditunda (backoff)`);
    }
  }

  const delayMs = nextClaimDelayMs({
    baseMs: POLL_MS,
    failures: consecutiveClaimFailures,
    retryAfterSeconds: outcome.retryAfterSeconds,
    maxMs: CLAIM_MAX_BACKOFF_MS,
  });

  setTimeout(pollOnce, delayMs);
}

void pollOnce();
setInterval(processLocalTasks, 3000);
