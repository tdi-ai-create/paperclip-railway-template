#!/usr/bin/env node
/**
 * paperclip-railway/scripts/agent-liveness-check.mjs
 *
 * Alerts when no Paperclip agent has completed a run in a while.
 *
 * Why this exists: from 26 to 30 August 2026 all 18 agents failed every single
 * heartbeat, for four days, and nothing told anyone. A dead agent and an idle
 * agent look identical from the outside. The dashboard read "18 enabled, 0
 * running" the whole time, which is also what a quiet Sunday looks like.
 *
 * The signal that would have caught it on day one is simply: zero successful
 * runs in the last N hours. Every agent is on an hourly timer, so a few hours
 * of total silence is never normal.
 *
 * The message deliberately reports failed runs as well as successful ones,
 * because the two outage shapes need different responses:
 *   failures > 0, successes 0  -> agents are running and dying (the Aug 26 case)
 *   failures 0, successes 0    -> nothing is being scheduled at all
 *
 * Dry run, no Slack post, exits non-zero if it would have alerted:
 *   node scripts/agent-liveness-check.mjs --dry-run
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import pkg from "pg";

const { Client } = pkg;

const HOME = process.env.PAPERCLIP_HOME || "/paperclip";
const STATE_PATH = join(HOME, "agent-liveness-state.json");

// Agents run hourly, so three hours of total silence is already abnormal.
const SILENCE_HOURS = Number(process.env.AGENT_SILENCE_ALERT_HOURS || 3);

// Do not re-alert more than once per this many hours while an outage continues.
const REALERT_HOURS = Number(process.env.AGENT_SILENCE_REALERT_HOURS || 6);

function readState() {
  try {
    if (!existsSync(STATE_PATH)) return {};
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  const body = JSON.stringify(state, null, 2);
  try {
    writeFileSync(STATE_PATH, body);
    return;
  } catch (err) {
    // This happened on the first deploy: the state file ended up owned by root
    // while the supervisor runs as paperclip (uid 999), so every write failed
    // with EACCES and the old code logged one line and moved on.
    //
    // Losing this file is worse than it looks. Without `alertedAt` the re-alert
    // window collapses, so a real outage would page every 30 minutes instead of
    // every 6, and the recovery notice never fires because it keys off the same
    // field. An alarm that cries every half hour gets muted, which defeats the
    // entire point of this script.
    //
    // A file owned by someone else cannot be overwritten, but it CAN be
    // unlinked, because the parent directory is owned by the runtime user. So
    // remove and recreate rather than giving up.
    try {
      if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
      writeFileSync(STATE_PATH, body);
      console.warn(`[liveness] state file was not writable (${err.code || err.message}), recreated it`);
      return;
    } catch (retryErr) {
      console.error(
        "[liveness] STATE NOT PERSISTED, alert de-duplication is disabled and outages will repeat-alert:",
        retryErr.message
      );
    }
  }
}

async function postToSlack(text) {
  const url = process.env.SLACK_WEBHOOK_RAE;
  if (!url) {
    console.error("[liveness] SLACK_WEBHOOK_RAE not set, cannot alert");
    return false;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    console.error(`[liveness] Slack post failed: ${res.status}`);
    return false;
  }
  return true;
}

async function gatherStats() {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  try {
    const { rows } = await c.query(
      `select
         count(*) filter (where status = 'succeeded' and finished_at > now() - ($1 || ' hours')::interval)::int as recent_ok,
         count(*) filter (where status = 'failed'    and finished_at > now() - ($1 || ' hours')::interval)::int as recent_failed,
         max(finished_at) filter (where status = 'succeeded') as last_ok,
         max(finished_at) filter (where status = 'failed')    as last_failed
       from heartbeat_runs`,
      [String(SILENCE_HOURS)]
    );
    return rows[0];
  } finally {
    await c.end();
  }
}

export async function checkAgentLiveness({ dryRun = false } = {}) {
  let stats;
  try {
    stats = await gatherStats();
  } catch (err) {
    // A database we cannot reach is a different incident. Say so and stop,
    // rather than reporting a false agent outage.
    console.error("[liveness] could not query heartbeat_runs:", err.message);
    return { checked: false, alerted: false };
  }

  const healthy = stats.recent_ok > 0;
  const state = readState();
  const now = Date.now();

  if (healthy) {
    if (state.alertedAt) {
      const text =
        `Paperclip agents are running again. ` +
        `${stats.recent_ok} successful run(s) in the last ${SILENCE_HOURS}h.`;
      if (!dryRun) await postToSlack(text);
      console.log("[liveness] recovered:", text);
    }
    writeState({ lastOkSeenAt: new Date(now).toISOString() });
    return { checked: true, alerted: false, healthy: true, stats };
  }

  const lastAlert = state.alertedAt ? Date.parse(state.alertedAt) : 0;
  const dueAgain = now - lastAlert > REALERT_HOURS * 3600 * 1000;

  const shape =
    stats.recent_failed > 0
      ? `${stats.recent_failed} run(s) failed in that window, so agents are starting and dying.`
      : `No runs were even attempted, so nothing is being scheduled.`;

  const text =
    `Paperclip: no successful agent run in ${SILENCE_HOURS}h. ${shape} ` +
    `Last success: ${stats.last_ok ? new Date(stats.last_ok).toISOString() : "never"}. ` +
    `Last failure: ${stats.last_failed ? new Date(stats.last_failed).toISOString() : "never"}. ` +
    `Check https://paperclip-railway-template-production.up.railway.app/TEA/agents`;

  if (dryRun) {
    console.log("[liveness] WOULD ALERT:", text);
    return { checked: true, alerted: false, wouldAlert: true, healthy: false, stats };
  }

  if (!dueAgain) {
    console.log("[liveness] still down, suppressing repeat alert");
    return { checked: true, alerted: false, healthy: false, stats };
  }

  const ok = await postToSlack(text);
  if (ok) writeState({ ...state, alertedAt: new Date(now).toISOString() });
  console.log("[liveness] alerted:", text);
  return { checked: true, alerted: ok, healthy: false, stats };
}

// Standalone invocation, for dry runs and manual checks.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry-run");
  const result = await checkAgentLiveness({ dryRun });
  if (!result.checked) process.exit(2);
  if (result.wouldAlert) process.exit(1);
  console.log("[liveness] ok:", JSON.stringify(result.stats));
  process.exit(0);
}
