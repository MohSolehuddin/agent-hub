/**
 * mock-server.ts — server tiruan Personal OS untuk uji E2E agent-hub.
 * Menyediakan POST /api/agent-dispatcher/claim (1x saja) dan POST /api/agent-dispatcher/callback.
 */
const PORT = Number(process.env.MOCK_PORT || 4555);
const REPO = process.env.E2E_REPO || "/tmp/ah-e2e/repo";
const OUT = process.env.E2E_OUT || "/tmp/ah-e2e/callback.jsonl";
const TASK_ID = process.env.E2E_TASK_ID || `task-e2e-${Date.now()}`;
const GATE_OK = process.env.E2E_GATE_OK !== "0";

let served = false;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/api/agent-dispatcher/claim") {
      if (served) return Response.json({ has_task: false });
      served = true;
      return Response.json({
        has_task: true,
        task: {
          task_id: TASK_ID,
          agent: "agent-hub",
          prompt: "TUGAS UJI E2E: tidak ada perubahan file apa pun. Cukup balas 'ok'.",
          project_path: REPO,
          timeout_minutes: 2,
          auto_approve: true,
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/agent-dispatcher/callback") {
      const body: any = await req.json();
      const prev = (await Bun.file(OUT).exists()) ? await Bun.file(OUT).text() : "";
      await Bun.write(OUT, prev + JSON.stringify(body) + "\n");
      console.log("[mock] callback diterima:", body.status, "| exit", body.exit_code, "|", body.error || "-");
      return Response.json({ status: "received" });
    }

    if (url.pathname === "/api/health") return Response.json({ ok: true, served, gate_ok: GATE_OK });
    return new Response("mock server up");
  },
});

console.log(`[mock] listening :${PORT} | repo=${REPO} | out=${OUT}`);
