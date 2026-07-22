// lib/state.mjs — persist runtime state between runs.
//
// File: <TOOL_DIR>/state.json (chmod 600). Tracks:
//   - lastRun: { ts, ok, durationMs, items, errors, bytes, archive, logFile }
//   - history: [ last N runs ]
//   - totalBytesUploaded (lifetime)
//   - totalRuns, totalFailures
//
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { stripAnsi } from "./colors.mjs";

const TOOL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const STATE_PATH = path.join(TOOL_DIR, "state.json");
const MAX_HISTORY = 50;

const EMPTY = {
  schema: 1,
  lastRun: null,
  history: [],
  totals: { runs: 0, failures: 0, bytesUploaded: 0 },
};

export function statePath() { return STATE_PATH; }

export async function loadState() {
  if (!existsSync(STATE_PATH)) return { ...EMPTY, history: [] };
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const s = JSON.parse(raw);
    // forward-compat: ensure required keys exist
    return {
      schema: 1,
      lastRun: s.lastRun || null,
      history: Array.isArray(s.history) ? s.history : [],
      totals: { ...EMPTY.totals, ...(s.totals || {}) },
    };
  } catch {
    return { ...EMPTY, history: [] };
  }
}

export async function saveState(state) {
  const tmp = STATE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, STATE_PATH);
  try { await fs.chmod(STATE_PATH, 0o600); } catch {}
}

export async function recordRun(result) {
  const state = await loadState();
  const entry = {
    ts: Date.now(),
    ok: !!result.ok,
    durationMs: result.durationMs || 0,
    items: result.items || 0,
    errors: result.errors || 0,
    bytes: result.bytes || 0,
    archive: result.archive ? path.basename(result.archive) : null,
    logFile: result.logFile ? path.basename(result.logFile) : null,
    error: result.error || null,
  };
  state.lastRun = entry;
  state.history.unshift(entry);
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  state.totals.runs = (state.totals.runs || 0) + 1;
  if (!entry.ok) state.totals.failures = (state.totals.failures || 0) + 1;
  state.totals.bytesUploaded = (state.totals.bytesUploaded || 0) + (entry.ok && entry.bytes ? entry.bytes : 0);
  await saveState(state);
  return entry;
}

// Format last run as a short one-liner for display
export function fmtLastRun(state) {
  const lr = state.lastRun;
  if (!lr) return "never";
  const ago = fmtAgo(lr.ts);
  const status = lr.ok ? "ok" : `FAILED (${lr.error || "unknown"})`;
  const dur = lr.durationMs ? `${Math.round(lr.durationMs / 1000)}s` : "?";
  return `${ago} (${status}, ${dur}, ${lr.items} items)`;
}

export function fmtAgo(ts) {
  const ms = Date.now() - ts;
  if (ms < 0) return "in the future";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m${rs}s ago`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return `${h}h${rm}m ago`;
  const d = Math.floor(h / 24), rh = h % 24;
  return `${d}d${rh}h ago`;
}

// Format next-run from cron expression (simple parser)
export function nextRunFromCronExpr(expr) {
  try {
    const [m, h, dom, mon, dow] = expr.split(/\s+/);
    const now = new Date();
    for (let day = 0; day < 8; day++) {
      const d = new Date(now);
      d.setDate(d.getDate() + day);
      d.setSeconds(0, 0);
      const matchesDoW = dow === "*" || parseInt(dow, 10) === d.getDay();
      const matchesDoM = dom === "*" || parseInt(dom, 10) === d.getDate();
      const matchesMon = mon === "*" || parseInt(mon, 10) === d.getMonth() + 1;
      if (!matchesDoW || !matchesDoM || !matchesMon) continue;
      for (let hour = 0; hour < 24; hour++) {
        for (let minute = 0; minute < 60; minute++) {
          if (m !== "*" && !m.includes("/") && parseInt(m, 10) !== minute) continue;
          if (m.includes("/")) {
            const step = parseInt(m.split("/")[1], 10) || 1;
            if (minute % step !== 0) continue;
          }
          if (h !== "*" && !h.includes("/") && parseInt(h, 10) !== hour) continue;
          if (h.includes("/")) {
            const step = parseInt(h.split("/")[1], 10) || 1;
            if (hour % step !== 0) continue;
          }
          d.setHours(hour, minute, 0, 0);
          if (d > now) return d;
        }
      }
    }
    return null;
  } catch { return null; }
}

export function fmtNextRun(expr) {
  if (!expr) return "—";
  const n = nextRunFromCronExpr(expr);
  if (!n) return "could not parse";
  const ms = n.getTime() - Date.now();
  if (ms < 0) return "overdue";
  if (ms < 60 * 60 * 1000) return `in ${Math.round(ms / 60000)}m`;
  return `in ${(ms / 3600000).toFixed(1)}h`;
}

// Re-export stripAnsi for convenience
export { stripAnsi };
