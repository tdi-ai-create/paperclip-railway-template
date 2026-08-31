#!/usr/bin/env node
/**
 * paperclip-railway/scripts/start.mjs
 *
 * Startup wrapper for paperclipai on Railway.
 *
 * Port layout:
 *   PUBLIC_PORT (3100) — owned by this wrapper, always
 *   PAPERCLIP_PORT (3099) — internal, Paperclip only
 *
 * Routing:
 *   /setup/*  → always handled here (env check, launch, invite, reset)
 *   /         → proxy if ready, else redirect to /setup
 *   everything else → proxy if ready, else redirect to /setup
 *
 * "Ready" is derived — no flag files, no SETUP_COMPLETE env var.
 *   isReady() = config.json exists AND all 4 required env vars are set
 */

import { createServer, request as httpRequest } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, chmodSync } from "fs";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PUBLIC_PORT = parseInt(process.env.PORT || "3100", 10);
const PAPERCLIP_PORT = 3099;
const HOME = process.env.PAPERCLIP_HOME || "/paperclip";
const CONFIG_PATH = join(HOME, "config.json");
const INVITE_FILE = join(HOME, "bootstrap-invite.txt");
const SKIP_REASON_FILE = join(HOME, "bootstrap-skip-reason.txt");

// Strip ANSI escape sequences (colors, cursor, etc.) from strings
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

// ── Global state ─────────────────────────────────────────────────────────────

let paperclipProc = null;
let paperclipReady = false;
let inviteUrl = null;
let bootstrapSkippedReason = null;

// ── Ready check (derived from reality, no flags) ─────────────────────────────

const REQUIRED_VARS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_ALLOWED_HOSTNAMES",
];

function isReady() {
  return REQUIRED_VARS.every(k => !!process.env[k]) && existsSync(CONFIG_PATH);
}

function allEnvVarsSet() {
  return REQUIRED_VARS.every(k => !!process.env[k]);
}

// ── Config builder ────────────────────────────────────────────────────────────

function writeConfig() {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(join(HOME, "logs"), { recursive: true });
  mkdirSync(join(HOME, "storage"), { recursive: true });

  const config = {
    $meta: {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: "onboard",
    },
    database: {
      provider: "postgres",
      connectionString: process.env.DATABASE_URL,
    },
    logging: {
      mode: "file",
      logDir: join(HOME, "logs"),
    },
    server: {
      deploymentMode: process.env.PAPERCLIP_DEPLOYMENT_MODE || "authenticated",
      deploymentExposure: process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE || "public",
      allowedHostnames: (process.env.PAPERCLIP_ALLOWED_HOSTNAMES || "")
        .split(",").map(h => h.trim()).filter(Boolean),
      port: PAPERCLIP_PORT,
      host: "127.0.0.1",
    },
    auth: {
      baseUrlMode: "explicit",
      publicBaseUrl: process.env.PAPERCLIP_PUBLIC_URL || "",
      disableSignUp: process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP === "true",
    },
    storage: {
      provider: "local_disk",
      localDiskPath: join(HOME, "storage"),
    },
    secrets: {
      provider: "local_encrypted",
      localEncrypted: {
        keyFilePath: join(HOME, "secrets.key"),
      },
    },
  };

  // Always overwrite — keeps config in sync with env vars on every boot
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`   Config written to ${CONFIG_PATH}`);
}

// ── Paperclip process ─────────────────────────────────────────────────────────

// ── TDI Hub Sync Tools ──────────────────────────────────────────────────────
// Creates wrapper scripts in /paperclip/bin/ that agents call to sync content
// to the TDI Learning Hub. Runs once on startup, idempotent.

function installSyncTools() {
  const binDir = join(HOME, "bin");
  const envFile = join(HOME, ".sync-env");

  try {
    if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

    // Env file with API credentials
    writeFileSync(envFile, [
      'export TDI_SYNC_KEY="tdi-sync-4c94b4195bb0c6272772e0ea6dd9c318"',
      'export TDI_API_BASE="https://www.teachersdeserveit.com"',
    ].join("\n") + "\n");

    // tdi-create-draft
    writeFileSync(join(binDir, "tdi-create-draft"), `#!/bin/bash
source ${envFile}
curl -s -X POST "$TDI_API_BASE/api/hub/content-sync" \\
  -H "Authorization: Bearer $TDI_SYNC_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{\\"action\\":\\"create_draft\\",\\"title\\":\\"$1\\",\\"slug\\":\\"$2\\",\\"description\\":\\"$3\\",\\"category\\":\\"$\{4:-Classroom Tools}\\",\\"topic_tags\\":$\{5:-[\\"classroom-management\\"]},\\"roles\\":$\{6:-[\\"teacher\\"]},\\"danielson_domains\\":$\{7:-[\\"3-instruction\\"]},\\"lift\\":\\"$\{8:-LOW}\\",\\"access_tier\\":\\"$\{9:-professional}\\"}"
echo ""
`);
    chmodSync(join(binDir, "tdi-create-draft"), 0o755);

    // tdi-upload-pdf
    writeFileSync(join(binDir, "tdi-upload-pdf"), `#!/bin/bash
source ${envFile}
QW_ID="$1"; PDF_PATH="$2"
if [ ! -f "$PDF_PATH" ]; then echo "Error: File not found: $PDF_PATH"; exit 1; fi
FILENAME=$(basename "$PDF_PATH")
PDF_B64=$(base64 -w0 "$PDF_PATH" 2>/dev/null || base64 "$PDF_PATH")
curl -s -X POST "$TDI_API_BASE/api/hub/content-sync" \\
  -H "Authorization: Bearer $TDI_SYNC_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{\\"action\\":\\"upload_pdf\\",\\"id\\":\\"$QW_ID\\",\\"pdf_base64\\":\\"$PDF_B64\\",\\"filename\\":\\"$FILENAME\\"}"
echo ""
`);
    chmodSync(join(binDir, "tdi-upload-pdf"), 0o755);

    // tdi-seed-community
    writeFileSync(join(binDir, "tdi-seed-community"), `#!/bin/bash
source ${envFile}
curl -s -X POST "$TDI_API_BASE/api/hub/community/seed" \\
  -H "Authorization: Bearer $TDI_SYNC_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{\\"quick_win_id\\":\\"$1\\",\\"user_id\\":\\"$2\\",\\"contribution_type\\":\\"$3\\",\\"body\\":\\"$4\\"}"
echo ""
`);
    chmodSync(join(binDir, "tdi-seed-community"), 0o755);

    // tdi-status
    writeFileSync(join(binDir, "tdi-status"), `#!/bin/bash
source ${envFile}
echo "=== Hub Content Pipeline Status ==="
curl -s "$TDI_API_BASE/api/hub/content-sync?action=get_status" -H "Authorization: Bearer $TDI_SYNC_KEY"
echo ""
echo "=== Drafts ==="
curl -s "$TDI_API_BASE/api/hub/content-sync?action=list_drafts" -H "Authorization: Bearer $TDI_SYNC_KEY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for draft in d.get('drafts',[]):
    flags = []
    if not draft.get('has_pdf'): flags.append('NEEDS PDF')
    if not draft.get('has_description'): flags.append('NEEDS DESC')
    print(f'  {draft[\"title\"]} [{\", \".join(flags) if flags else \"READY\"}]')
" 2>/dev/null || echo "(parse error)"
`);
    chmodSync(join(binDir, "tdi-status"), 0o755);

    console.log("[tdi-sync] Installed sync tools in /paperclip/bin/");
  } catch (err) {
    console.error("[tdi-sync] Failed to install sync tools:", err.message);
  }
}

// ── Claude wrapper ──────────────────────────────────────────────────────────
// Every agent's adapter Command points at /paperclip/bin/claude-as-node, so
// that file is on the critical path for all 18 agents. It used to exist only
// on the volume, uncommitted, and it took the fleet down for four days in
// August 2026 while the repo showed no changes at all. Installing it from
// scripts/ on every boot puts it under review and makes a volume loss
// self-healing. See scripts/claude-as-node for the failure it encodes.
//
// This overwrites on every boot on purpose: a hand-edit on the volume should
// not outlive a restart.

function installClaudeWrapper() {
  const binDir = join(HOME, "bin");
  const dest = join(binDir, "claude-as-node");
  const src = join(__dirname, "claude-as-node");

  try {
    if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
    const body = readFileSync(src);

    try {
      writeFileSync(dest, body);
    } catch (writeErr) {
      // If this file ends up owned by another user, every boot write fails with
      // EACCES and all 18 agents lose their wrapper. That exact thing happened
      // to the liveness state file on the first deploy of this change. A file
      // owned by someone else cannot be overwritten, but it CAN be unlinked,
      // because binDir is owned by the runtime user. Remove and recreate rather
      // than leaving the fleet without a wrapper.
      if (existsSync(dest)) unlinkSync(dest);
      writeFileSync(dest, body);
      console.warn(
        `[claude-wrapper] existing file was not writable (${writeErr.code || writeErr.message}), recreated it`
      );
    }

    chmodSync(dest, 0o755);
    console.log("[claude-wrapper] Installed claude-as-node in /paperclip/bin/");
  } catch (err) {
    // Loud, because every agent fails without this.
    console.error("[claude-wrapper] FAILED to install claude-as-node:", err.message);
  }
}

// ── Agent liveness watchdog ─────────────────────────────────────────────────
// From 26 to 30 Aug 2026 every agent failed every heartbeat and nothing told
// anyone, because a dead agent and an idle agent look identical. This polls for
// "zero successful runs in N hours" and posts to Slack.
//
// Owned by the supervisor for the same reason the backup prune is: a schedule
// is only as durable as the process that owns it.

const LIVENESS_INTERVAL_MS = 30 * 60 * 1000;
const LIVENESS_FIRST_DELAY_MS = 5 * 60 * 1000; // let agents get going after a boot
let livenessTimer = null;

function installAgentLivenessWatchdog() {
  const run = async () => {
    try {
      const { checkAgentLiveness } = await import("./agent-liveness-check.mjs");
      await checkAgentLiveness({});
    } catch (err) {
      console.error("[liveness] check failed:", err.message);
    }
  };

  setTimeout(run, LIVENESS_FIRST_DELAY_MS);
  if (livenessTimer) clearInterval(livenessTimer);
  livenessTimer = setInterval(run, LIVENESS_INTERVAL_MS);
  console.log("[liveness] Watchdog scheduled every 30m, owned by the supervisor");
}

// ── Backup cleanup ──────────────────────────────────────────────────────────
// Paperclip writes an hourly SQL dump to data/backups and never prunes it.
// Unpruned, that fills the 46G volume in about ten days.
//
// This lives here, in the long-lived supervisor process, on purpose. The
// Aug 12 2026 fix put the same cleanup in a `while true; do sleep; done &`
// subshell launched from an interactive `railway ssh` session. That subshell
// died with the SSH session, so it never pruned once, the volume hit 100% on
// Aug 22, and 47 consecutive backups silently wrote 0 bytes. A schedule is
// only as durable as the process that owns it.

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly, matches the dump cadence
let cleanupTimer = null;

function installBackupCleanup() {
  const binDir = join(HOME, "bin");
  const scriptPath = join(binDir, "cleanup-backups.sh");

  try {
    if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

    // Empty dumps are deleted BEFORE the keep-newest-N rule. A full disk
    // produces 0-byte dumps, and since those are the newest files, a naive
    // "keep newest 24" would retain the empty ones and delete every valid
    // backup. That turns a disk-full incident into a data-loss incident.
    writeFileSync(scriptPath, `#!/bin/sh
BACKUP_DIR="${HOME}/instances/default/data/backups"
LOG="${HOME}/instances/default/data/cleanup.log"
KEEP=24

if [ -d "$BACKUP_DIR" ]; then
  cd "$BACKUP_DIR" || exit 0
  find . -maxdepth 1 -type f -name '*.sql' -size 0 -delete 2>/dev/null
  ls -t *.sql 2>/dev/null | tail -n +$((KEEP + 1)) | xargs rm -f 2>/dev/null
  KEPT=$(ls -1 *.sql 2>/dev/null | wc -l)
else
  KEPT=0
fi

find ${HOME}/instances/default/data/run-logs/ -type f -mtime +7 -delete 2>/dev/null
find /home/node/.claude/projects/*/memory/ -type f -mtime +30 -delete 2>/dev/null

# Leave evidence that this ran. An unproven schedule is how we got here.
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) prune ok: kept=\${KEPT} disk=$(df -h ${HOME} 2>/dev/null | awk 'NR==2{print $5}')" >> "$LOG" 2>/dev/null
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null
`);
    chmodSync(scriptPath, 0o755);
    console.log("[cleanup] Installed backup cleanup in /paperclip/bin/");
  } catch (err) {
    console.error("[cleanup] Failed to install cleanup script:", err.message);
    return;
  }

  const runCleanup = () => {
    const proc = spawn("sh", [scriptPath], { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr.on("data", (d) => console.error("[cleanup]", d.toString().trim()));
    proc.on("error", (err) => console.error("[cleanup] run failed:", err.message));
  };

  runCleanup(); // once at boot, so a restart always reclaims space
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  console.log("[cleanup] Scheduled hourly, owned by the supervisor process");
}

function startPaperclip() {
  if (paperclipProc) return; // already running

  console.log(`\n🚀 Starting Paperclip on internal port ${PAPERCLIP_PORT}...\n`);

  installSyncTools();
  installClaudeWrapper();
  installBackupCleanup();
  installAgentLivenessWatchdog();
  writeConfig();

  paperclipProc = spawn(
    "node",
    ["node_modules/.bin/paperclipai", "run"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PAPERCLIP_CONFIG: CONFIG_PATH,
        PAPERCLIP_HOME: HOME,
        PORT: String(PAPERCLIP_PORT),
        HOST: "127.0.0.1",
        NODE_ENV: process.env.NODE_ENV || "production",
      },
    }
  );

  paperclipProc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);

    const clean = stripAnsi(text);

    // Capture bootstrap invite URL
    const match = clean.match(/https?:\/\/\S+\/invite\/pcp_bootstrap_\S+/);
    if (match) {
      inviteUrl = match[0].trim();
      bootstrapSkippedReason = null;
      writeFileSync(INVITE_FILE, inviteUrl);
      if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
      console.log(`\n✅ Bootstrap invite URL saved to ${INVITE_FILE}\n`);
    }

    // Detect "admin already exists" — Paperclip skips invite generation
    if (clean.includes("Instance already has an admin user")) {
      bootstrapSkippedReason = "An admin account already exists. You can log in directly from the dashboard.";
      writeFileSync(SKIP_REASON_FILE, bootstrapSkippedReason);
      console.log(`\n⚠️ Bootstrap invite skipped: admin already exists.\n`);
    }

    // Detect ready
    if (!paperclipReady && (text.includes("Server listening on") || text.includes("server listening"))) {
      paperclipReady = true;
      console.log(`\n✅ Paperclip ready — proxying :${PUBLIC_PORT} → :${PAPERCLIP_PORT}\n`);
    }
  });

  paperclipProc.stderr.on("data", chunk => process.stderr.write(chunk));

  paperclipProc.on("error", err => {
    console.error("Paperclip process error:", err);
    paperclipProc = null;
    paperclipReady = false;
  });

  paperclipProc.on("exit", (code) => {
    console.log(`Paperclip exited with code ${code}`);
    // Railway will restart the whole container on exit — don't try to restart here
    process.exit(code ?? 1);
  });
}

function stopPaperclip() {
  if (!paperclipProc) return;
  paperclipReady = false;
  paperclipProc.kill("SIGTERM");
  paperclipProc = null;
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function resetSetup() {
  stopPaperclip();
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  if (existsSync(INVITE_FILE)) unlinkSync(INVITE_FILE);
  if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
  inviteUrl = null;
  bootstrapSkippedReason = null;
  console.log("\n🔄 Setup reset. Config and invite file deleted.\n");
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

function proxy(req, res) {
  if (!paperclipReady) {
    res.writeHead(503, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f10;color:#fff">
      <div style="text-align:center">
        <div style="font-size:32px;margin-bottom:16px">⏳</div>
        <h2>Paperclip is starting up...</h2>
        <p style="color:#71717a;margin-top:8px">This page will refresh automatically.</p>
        <script>setTimeout(()=>location.reload(),3000)<\/script>
      </div></body></html>`);
    return;
  }

  const opts = {
    hostname: "127.0.0.1",
    port: PAPERCLIP_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      "x-forwarded-host": req.headers.host,
      "x-forwarded-proto": "https",
      "x-forwarded-for": req.socket.remoteAddress,
    },
  };

  // Health check timeout: return 503 (not fake 200) so the external
  // watchdog gets honest data about Paperclip's actual state.
  const isHealthCheck = req.url === "/api/health" || req.url.startsWith("/api/health?");
  const HEALTH_TIMEOUT_MS = 8000;

  const upstream = httpRequest(opts, (upRes) => {
    if (healthTimer) clearTimeout(healthTimer);
    if (res.headersSent) return;
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res, { end: true });
  });

  let healthTimer = null;
  if (isHealthCheck) {
    healthTimer = setTimeout(() => {
      if (!res.headersSent) {
        console.warn("[proxy] /api/health timed out after 8s — returning 503");
        upstream.destroy();
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "degraded", source: "wrapper-timeout", message: "Health check took >8s" }));
      }
    }, HEALTH_TIMEOUT_MS);
  }

  upstream.on("error", () => {
    if (healthTimer) clearTimeout(healthTimer);
    if (res.headersSent) return;
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Paperclip is restarting — please refresh in a moment.");
  });

  req.pipe(upstream, { end: true });
}

// ── Env var status (for setup page) ──────────────────────────────────────────

function envVarStatus() {
  const all = [
    { key: "DATABASE_URL", required: true, label: "Database URL", example: "postgresql://user:pass@host:5432/db" },
    { key: "BETTER_AUTH_SECRET", required: true, label: "Auth Secret", example: "${{secret(32)}} — use Railway generator" },
    { key: "PAPERCLIP_PUBLIC_URL", required: true, label: "Public URL", example: "https://your-app.up.railway.app" },
    { key: "PAPERCLIP_ALLOWED_HOSTNAMES", required: true, label: "Allowed Hostnames", example: "your-app.up.railway.app" },
    { key: "PAPERCLIP_DEPLOYMENT_MODE", required: false, label: "Deployment Mode", example: "authenticated" },
    { key: "PAPERCLIP_HOME", required: false, label: "Paperclip Home", example: "/paperclip" },
    { key: "ANTHROPIC_API_KEY", required: false, label: "Anthropic API Key", example: "sk-ant-..." },
    { key: "OPENAI_API_KEY", required: false, label: "OpenAI API Key", example: "sk-..." },
  ];
  return all.map(v => ({
    ...v,
    set: !!process.env[v.key],
    missing: v.required && !process.env[v.key],
  }));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;
    const ready = isReady();

    // ── Setup API routes (always available) ──────────────────────────────────

    if (path === "/setup/status" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        vars: envVarStatus(),
        configExists: existsSync(CONFIG_PATH),
        paperclipReady: paperclipReady,
        ready: ready,
      }));
      return;
    }

    if (path === "/setup/invite" && method === "GET") {
      // Try loading from memory, then file
      if (!inviteUrl && existsSync(INVITE_FILE)) {
        try { inviteUrl = stripAnsi(readFileSync(INVITE_FILE, "utf8")).trim(); } catch (_) { }
      }
      if (!bootstrapSkippedReason && existsSync(SKIP_REASON_FILE)) {
        try { bootstrapSkippedReason = readFileSync(SKIP_REASON_FILE, "utf8").trim(); } catch (_) { }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        url: inviteUrl,
        paperclipReady,
        skippedReason: bootstrapSkippedReason || null,
      }));
      return;
    }

    if (path === "/setup/launch" && method === "POST") {
      if (paperclipProc) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, already: true }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => startPaperclip(), 300);
      return;
    }

    if (path === "/setup/rotate-invite" && method === "POST") {
      const proc = spawn(
        "node",
        ["node_modules/.bin/paperclipai", "auth", "bootstrap-ceo", "--force"],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PAPERCLIP_CONFIG: CONFIG_PATH } }
      );
      let out = "";
      proc.stdout.on("data", d => {
        out += d.toString();
        const clean = stripAnsi(out);
        const match = clean.match(/https?:\/\/\S+\/invite\/pcp_bootstrap_\S+/);
        if (match) {
          inviteUrl = match[0].trim();
          writeFileSync(INVITE_FILE, inviteUrl);
          // Clear skip reason since we now have a fresh invite
          bootstrapSkippedReason = null;
          if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
        }
      });
      proc.stderr.on("data", d => process.stderr.write(d));
      proc.on("exit", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ url: inviteUrl }));
      });
      return;
    }

    if (path === "/setup/reset" && method === "POST") {
      resetSetup();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Setup page ────────────────────────────────────────────────────────────

    if (path === "/setup") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(join(__dirname, "setup.html"), "utf8"));
      return;
    }

    // ── Root + everything else ────────────────────────────────────────────────

    if (!ready) {
      res.writeHead(302, { Location: "/setup" });
      res.end();
      return;
    }

    proxy(req, res);
  });

  server.listen(PUBLIC_PORT, "0.0.0.0", () => {
    console.log(`\n🔧 Wrapper listening on port ${PUBLIC_PORT}`);
    console.log(`   Visit /setup to configure or manage your instance.\n`);
  });
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

startServer();

if (isReady()) {
  startPaperclip();
}
