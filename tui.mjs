#!/usr/bin/env node
// tui.mjs — full-screen ncurses-style terminal UI for aegis.
// Imported by aegis.mjs (the canonical entry point). On a TTY, launches the
// dashboard; on a non-TTY (cron, scripts) or when AEGIS_NO_TUI=1, runs as CLI.
//
import blessed from "neo-blessed";
import { spawn } from "node:child_process";
import { promises as fs, existsSync, createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import {
  VERSION, TOOL_DIR, parseArgs, printHelp,
  loadConfig, runBackup, uploadBundle, pruneRemote, cleanupLocal,
} from "./backup.mjs";
import { ProgressBus } from "./lib/progress.mjs";
import { C, bar, padEnd } from "./lib/colors.mjs";
import { loadState, fmtLastRun, fmtNextRun, fmtAgo } from "./lib/state.mjs";
import { getLogo, centerLines } from "./lib/logo.mjs";

const CONFIG_PATH = path.join(TOOL_DIR, "config.json");
const LOG_DIR = path.join(TOOL_DIR, "logs");
const ARCHIVE_DIR_DEFAULT = "/var/backups/vps/archive";

// ---------- non-TTY fallback ----------------------------------------------

if (!process.stdout.isTTY || process.env.AEGIS_NO_TUI) {
  const opts = parseArgs(process.argv);
  if (opts.help) { console.log(printHelp()); process.exit(0); }
  if (opts.version) { console.log(VERSION); process.exit(0); }
  const { runFullBackup } = await import("./backup.mjs");
  const r = await runFullBackup(opts.config, opts);
  process.exit(r.ok ? 0 : 1);
}

// ---------- theme ---------------------------------------------------------
// We use ANSI codes directly in content (via lib/colors.mjs) and disable
// blessed's `{...}` tag parsing. That way colors render in any terminal.

const THEME = {
  border: { type: "line" },
  style: {
    border: { fg: "cyan" },
    focus: { border: { fg: "yellow" } },
    selected: { bg: "blue", fg: "white" },
  },
};

// ---------- helpers -------------------------------------------------------

function fmtBytes(n) {
  if (!n && n !== 0) return "—";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}

// Wrap a promise so it resolves to `fallback` after `ms` milliseconds.
// Used to keep the dashboard responsive when remote SSH/FTP calls hang.
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(fallback);
    }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(t); resolve(fallback); } },
    );
  });
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  return `${m}m${rs.toString().padStart(2, "0")}s`;
}
function two(n) { return n.toString().padStart(2, "0"); }
function now() { const d = new Date(); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; }
function bell() { process.stdout.write("\x07"); }

function shell(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args);
    const so = [], se = [];
    c.stdout.on("data", (b) => so.push(b));
    c.stderr.on("data", (b) => se.push(b));
    c.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(so).toString("utf8"), stderr: Buffer.concat(se).toString("utf8") }));
    c.on("error", () => resolve({ code: -1, stdout: "", stderr: "spawn error" }));
  });
}

async function listRemoteBackups(cfg) {
  const transfer = cfg?.transfer || "ssh";
  if (transfer === "ftp") return listRemoteBackupsFtp(cfg);
  return listRemoteBackupsSsh(cfg);
}

async function listRemoteBackupsSsh(cfg) {
  if (!cfg?.ssh?.host) return [];
  const r = await shell("ssh", [
    "-i", cfg.ssh.identityFile || "/root/.ssh/id_ed25519",
    "-p", String(cfg.ssh.port || 22),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=8",
    `${cfg.ssh.user}@${cfg.ssh.host}`,
    `ls -1t ${cfg.ssh.remoteDir}/aegis-*.tar.zst 2>/dev/null | sed 's|.*/||'`,
  ]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function listRemoteBackupsFtp(cfg) {
  if (!cfg?.ftp?.host) return [];
  const f = cfg.ftp;
  const proto = f.secure ? "ftps" : "ftp";
  const base = `${proto}://${f.host}:${f.port || 21}${f.remoteDir}/`;
  const r = await shell("curl", [
    "--silent", "--show-error",
    "--connect-timeout", "15", "--max-time", "30",
    "-u", `${f.user}:${f.password}`,
    ...(f.secure ? ["--ssl"] : []),
    "--list-only", base,
  ]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n")
    .map((s) => s.trim())
    .filter((s) => /^aegis-.*\.tar\.(zst|gz)$/.test(s))
    .sort().reverse();
}

async function remoteDiskInfo(cfg) {
  const transfer = cfg?.transfer || "ssh";
  if (transfer === "ftp") return remoteDiskInfoFtp(cfg);
  return remoteDiskInfoSsh(cfg);
}

async function remoteDiskInfoSsh(cfg) {
  const out = { ok: false, free: null, total: null, count: 0, totalBytes: 0 };
  if (!cfg?.ssh?.host) return out;
  const cmd = [
    `cd ${cfg.ssh.remoteDir} 2>/dev/null &&`,
    `free=$(df -PB1 . 2>/dev/null | awk 'NR==2 {print $4}')`,
    `total=$(df -PB1 . 2>/dev/null | awk 'NR==2 {print $2}')`,
    `cnt=$(ls aegis-*.tar.zst 2>/dev/null | wc -l)`,
    `siz=$(du -sb . 2>/dev/null | awk '{print $1}')`,
    `echo "$free|$total|$cnt|$siz"`,
  ].join("; ");
  const r = await shell("ssh", [
    "-i", cfg.ssh.identityFile || "/root/.ssh/id_ed25519",
    "-p", String(cfg.ssh.port || 22),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=8",
    `${cfg.ssh.user}@${cfg.ssh.host}`,
    cmd,
  ]);
  if (r.code !== 0) return out;
  const [f, t, c, s] = r.stdout.trim().split("|");
  out.ok = true;
  out.free = parseInt(f, 10) || null;
  out.total = parseInt(t, 10) || null;
  out.count = parseInt(c, 10) || 0;
  out.totalBytes = parseInt(s, 10) || 0;
  return out;
}

async function remoteDiskInfoFtp(cfg) {
  const out = { ok: false, free: null, total: null, count: 0, totalBytes: 0 };
  if (!cfg?.ftp?.host) return out;
  const f = cfg.ftp;
  const proto = f.secure ? "ftps" : "ftp";
  const base = `${proto}://${f.host}:${f.port || 21}${f.remoteDir}/`;
  const r = await shell("curl", [
    "--silent", "--show-error",
    "--connect-timeout", "15", "--max-time", "30",
    "-u", `${f.user}:${f.password}`,
    ...(f.secure ? ["--ssl"] : []),
    "--list-only", base,
  ]);
  if (r.code !== 0) return out;
  const names = r.stdout.split("\n")
    .map((s) => s.trim())
    .filter((s) => /^aegis-.*\.tar\.(zst|gz)(\.age)?$/.test(s));
  out.ok = true;
  out.count = names.length;
  return out;
}

async function localDiskInfo(dir) {
  const out = { ok: false, free: null, total: null };
  try {
    const r = await shell("df", ["-PB1", dir]);
    if (r.code === 0) {
      const line = r.stdout.split("\n")[1] || "";
      const parts = line.split(/\s+/);
      out.free = parseInt(parts[3], 10) || null;
      out.total = parseInt(parts[1], 10) || null;
      out.ok = true;
    }
  } catch {}
  return out;
}

async function readLastLogLines(logDir, n = 12) {
  if (!existsSync(logDir)) return [];
  let files;
  try { files = (await fs.readdir(logDir)).filter((f) => f.startsWith("backup-")).sort(); }
  catch { return []; }
  if (files.length === 0) return [];
  const latest = path.join(logDir, files[files.length - 1]);
  const stat = await fs.stat(latest);
  const lines = [];
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: createReadStream(latest), crlfDelay: Infinity });
    rl.on("line", (l) => { lines.push({ ts: latest, mtime: stat.mtimeMs, text: l }); });
    rl.on("close", () => resolve(lines.slice(-n)));
    rl.on("error", () => resolve(lines.slice(-n)));
  });
}

function parseCronLine(line) {
  const m = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+?)\s*(#.*)?$/);
  return m ? { expr: m[1], command: m[2] } : null;
}

async function getCrontabEntry() {
  const r = await shell("bash", ["-c", "crontab -l 2>/dev/null | grep -F '# Aegis' || true"]);
  return r.stdout.trim() ? parseCronLine(r.stdout.trim()) : null;
}

// ---------- TUI class -----------------------------------------------------

class Tui {
  constructor() {
    this.cfg = null;
    this.cfgError = null;
    this.cfgPath = CONFIG_PATH;
    this.disk = { local: null, remote: null };
    this.remoteBackups = [];
    this.cron = null;
    this.lastLog = [];
    this.state = null; // runtime state from state.json
    this.bus = null;
    this.busy = false;
    this.view = "menu";
    this.progressView = null;
    this.progressLog = [];
    this.firstRun = false;

    this.screen = blessed.screen({
      smartCSR: true,
      title: `Aegis ${VERSION}`,
      fullUnicode: true,
      autoPadding: true,
    });
    this.screen.cursorReset();

    this.buildLayout();
    this.bindKeys();
    this.screen.render();

    this.refreshConfig()
      .catch((e) => { this.cfgError = e.message; })
      .then(() => this.handleFirstRun().catch(() => {}))
      .then(() => this.refreshAll().catch(() => {}));

    process.on("SIGWINCH", () => this.screen.render());
  }

  async handleFirstRun() {
    const { isFirstRun } = await import("./lib/setup.mjs");
    const status = isFirstRun(this.cfgPath);
    this.firstRun = status.firstRun;
    if (status.firstRun) {
      this.menu.setItems([
        C.green("▶ Run first-time setup wizard"),
        "  Edit config manually",
        C.gray("  Quit"),
      ]);
      this.menu.setLabel(" First run ");
      this.screen.render();
    }
  }

  buildLayout() {
    // Header — fixed-height cyan bar at the top
    this.header = blessed.box({
      parent: this.screen, top: 0, left: 0, right: 0, height: 1,
      tags: false,
      style: { fg: "black", bg: "cyan" },
      content: ` ${C.bold("Aegis")} v${VERSION} — ${os.hostname()} `,
    });

    // Footer — gray bar at the bottom
    this.footer = blessed.box({
      parent: this.screen, bottom: 0, left: 0, right: 0, height: 1,
      tags: false,
      style: { fg: "gray" },
      content: ` q:quit  ↑/↓:navigate  Enter:select  r:refresh  ?:help `,
    });

    // Body container
    this.body = blessed.box({
      parent: this.screen, top: 1, bottom: 1, left: 0, right: 0,
    });

    // Left menu
    this.menu = blessed.list({
      parent: this.body, top: 0, left: 0, width: 28, bottom: 0,
      label: " Actions ", border: THEME.border, style: THEME.style,
      keys: true, vi: true, mouse: true, tags: false,
      items: this.menuItems(),
    });

    // Right panel: dashboard / progress / list / etc. — switched via showView()
    this.dashboard = blessed.box({
      parent: this.body, top: 0, left: 28, right: 0, bottom: 0,
      label: " Status ", tags: false,
      border: THEME.border, style: THEME.style,
      scrollable: true, alwaysScroll: true, keys: true, mouse: true,
      content: this.renderDashboard(),
    });

    this.progress = blessed.box({
      parent: this.body, top: 0, left: 28, right: 0, bottom: 0,
      label: " Backup in progress ", tags: false,
      border: THEME.border, style: THEME.style,
      scrollable: true, alwaysScroll: true, keys: true, mouse: true,
      hidden: true,
    });

    this.logView = blessed.log({
      parent: this.body, top: 0, left: 28, right: 0, bottom: 0,
      label: " Logs ", tags: false,
      border: THEME.border, style: { ...THEME.style, scrollbar: { bg: "blue" } },
      scrollable: true, alwaysScroll: true, keys: true, mouse: true,
      hidden: true,
    });

    this.listView = blessed.list({
      parent: this.body, top: 0, left: 28, right: 0, bottom: 0,
      label: " Select ", tags: false,
      border: THEME.border, style: THEME.style,
      keys: true, vi: true, mouse: true,
      hidden: true,
    });

    // Splash overlay — shown briefly when a backup starts (logo + spinner)
    this.splash = blessed.box({
      parent: this.screen, top: 0, left: 0, right: 0, bottom: 0,
      tags: false, hidden: true, transparent: false,
      style: { bg: "black", fg: "white" },
    });

    // Completion modal — shown after a backup finishes (logo + summary).
    // Bigger and more prominent so it can't be missed.
    this.modal = blessed.box({
      parent: this.screen, top: "center", left: "center",
      width: "70%", height: "shrink",
      tags: false, hidden: true,
      border: { type: "line" },
      style: { border: { fg: "green" }, bg: "black", fg: "white" },
      keys: true, mouse: true,
      scrollable: true, alwaysScroll: true,
    });

    this.menu.on("select", (_, idx) => this.activate(idx));
    this.menu.focus();
  }

  menuItems() {
    const items = [
      "── Run ──────────────────",
      C.green("▶ Backup now (full)"),
      "  Quick backup (postgres+sqlite)",
      "── Browse ───────────────",
      "  List remote backups",
      "  Restore from backup...",
      "  Show backup contents (preview)",
      "  Verify backup integrity",
      "  View logs",
      "  Test remote connection",
      "── Maintain ──────────────",
      "  Prune remote now",
      "  Refresh status",
      "  Install / update cron",
      "── Configure ─────────────",
      "  Configure notifications",
      "  Edit config",
      "──────────────────────────",
      C.gray("  Quit"),
    ];
    // Indices of section headers — non-selectable dividers.
    this._menuHeaderIdxs = [];
    items.forEach((it, i) => {
      if (typeof it === "string" && it.startsWith("── ")) this._menuHeaderIdxs.push(i);
    });
    return items;
  }

  bindKeys() {
    this.screen.key(["q", "C-c"], () => this.quit());
    this.screen.key(["?"], () => this.showHelp());
    this.screen.key(["r"], () => this.refreshAll());
    this.screen.key(["escape"], () => this.cancelModal());
    // ENTER dismisses the completion modal when it's visible (regardless
    // of which widget has focus, in case the modal's key binding misses).
    this.screen.key(["enter"], () => {
      if (this.modal && !this.modal.hidden) this.hideModal();
    });
    this.menu.key(["j"], () => this.menu.down());
    this.menu.key(["k"], () => this.menu.up());

    // Modal dismiss keys — ENTER/ESC/q on the completion modal close it
    // and return to the main menu.
    this.modal.key(["enter", "escape", "q"], () => this.hideModal());
  }

  showView(name) {
    this.view = name;
    this.dashboard.hide();
    this.progress.hide();
    this.logView.hide();
    this.listView.hide();
    if (name === "menu") this.dashboard.show();
    else if (name === "progress") this.progress.show();
    else if (name === "logs") this.logView.show();
    else if (name === "list") this.listView.show();
    // Focus the widget for the current view — not always the menu. The
    // list/log/etc. pickers live in the right panel and need their own
    // focus, otherwise the ↑/↓ keys keep navigating the left menu.
    if (name === "list") {
      this.listView.setFront();
      this.listView.focus();
    } else if (name === "logs") {
      this.logView.setFront();
      this.logView.focus();
    } else if (name === "progress") {
      this.progress.setFront();
    } else {
      this.menu.setFront();
      this.menu.focus();
    }
    this.screen.render();
  }

  cancelModal() {
    if (this.modal && !this.modal.hidden) {
      this.hideModal();
      return;
    }
    if (this.busy) return;
    if (this.view !== "menu") {
      this.showView("menu");
      this.refreshAll();
    }
  }

  // ---------- splash + completion modal -----------------------------------

  showSplash(subtitle = "Starting backup…") {
    const cols = this.screen.width || 80;
    const logo = getLogo(cols);
    const render = (spinner) => {
      const lines = [];
      lines.push("");
      lines.push(...centerLines(logo, cols));
      lines.push("");
      lines.push(...centerLines([C.bold(C.cyan(subtitle))], cols));
      lines.push(...centerLines([C.gray(`${spinner}  please wait…`)], cols));
      this.splash.setContent(lines.join("\n"));
      this.screen.render();
    };
    const frames = ["|", "/", "-", "\\"];
    this.splashFrame = 0;
    render(frames[0]);
    this.splash.show();
    this.splash.setFront();
    this.splashTimer = setInterval(() => {
      this.splashFrame = (this.splashFrame + 1) % frames.length;
      render(frames[this.splashFrame]);
    }, 120);
  }

  hideSplash() {
    if (this.splashTimer) {
      clearInterval(this.splashTimer);
      this.splashTimer = null;
    }
    this.splash.hide();
    this.screen.render();
  }

  showCompletionModal({ ok, durMs, items, errors, bytes, archive, errorMsg, logFile }) {
    const cols = this.screen.width || 80;
    const status = ok
      ? C.bold(C.green("✓  BACKUP COMPLETE"))
      : C.bold(C.red("✗  BACKUP FAILED"));
    const lines = [];
    lines.push("");
    lines.push(...centerLines([status], cols));
    lines.push("");
    const stats = [
      C.bold("Duration:") + "  " + fmtDuration(durMs),
      C.bold("Items:") + "     " + String(items ?? "—"),
      C.bold("Errors:") + "    " + (errors > 0 ? C.red(String(errors)) : C.green("0")),
      C.bold("Size:") + "      " + fmtBytes(bytes),
      archive ? C.bold("Archive:") + "   " + C.cyan(archive) : null,
      errorMsg ? C.bold("Error:") + "     " + C.red(errorMsg) : null,
      logFile ? C.gray("log: logs/" + logFile) : null,
    ].filter(Boolean);
    for (const s of stats) lines.push("  " + s);
    lines.push("");
    lines.push("");
    // Big, obvious dismiss hint — center it and use bold + cyan so it
    // can't be missed.
    lines.push(...centerLines([C.bold(C.cyan(">>> Press ENTER to return to menu <<<"))], cols));
    lines.push(...centerLines([C.gray("(also: ESC or q)")], cols));
    this.modal.setContent(lines.join("\n"));
    this.modal.style.border.fg = ok ? "green" : "red";
    this.modal.show();
    this.modal.setFront();
    this.modal.focus();
    this.screen.render();
  }

  hideModal() {
    this.modal.hide();
    this.showView("menu");
    this.screen.render();
  }

  async quit() {
    if (this.modal && !this.modal.hidden) {
      this.hideModal();
      return;
    }
    this.screen.destroy();
    process.exit(0);
  }

  async showHelp() {
    const help = blessed.message({
      parent: this.screen,
      top: "center", left: "center", width: "60%", height: "60%",
      label: " Help ", border: THEME.border, style: THEME.style,
      tags: false, keys: true,
    });
    help.setContent([
      C.bold("Aegis TUI"),
      "",
      C.yellow("Navigation:"),
      "  ↑/↓ or j/k    Move selection",
      "  Enter         Activate item",
      "  Esc           Cancel modal / back to menu",
      "  r             Refresh status panel",
      "  ?             This help",
      "  q / Ctrl-C    Quit",
      "",
      C.yellow("Backup phases:"),
      "  postgres → sqlite → pm2 → nginx → extras → archive → upload → prune",
      "",
      C.yellow("Config:") + "  " + this.cfgPath,
      C.yellow("Logs:") + "    " + LOG_DIR,
      C.yellow("State:") + "   " + path.join(TOOL_DIR, "state.json"),
      "",
      "Press any key to close.",
    ].join("\n"));
    help.focus();
    help.pressAnyKey();
  }

  // ---------- dashboard content ------------------------------------------

  async refreshConfig() {
    try {
      if (!existsSync(this.cfgPath)) {
        this.cfgError = `No config at ${this.cfgPath}. Copy config.example.json first.`;
        this.cfg = null;
      } else {
        this.cfg = await loadConfig(this.cfgPath);
        this.cfgError = null;
      }
    } catch (e) {
      this.cfgError = e.message;
      this.cfg = null;
    }
  }

  async refreshAll() {
    // Render immediately with whatever state we have so the dashboard is
    // responsive even while remote calls are in flight. Network/SSH calls
    // are time-bounded by withTimeout in the per-resource refreshers, so
    // they can't hang the dashboard forever.
    try { this.state = await withTimeout(loadState(), 3000, { lastRun: null, history: [], totals: { runs: 0, failures: 0, bytesUploaded: 0 } }); } catch {}
    this.dashboard.setContent(this.renderDashboard());
    this.screen.render();
    // Fire-and-forget: each refreher has its own timeout so the UI stays
    // responsive while we wait.
    Promise.all([
      this.cfg ? this.refreshDisk() : Promise.resolve(),
      this.cfg ? this.refreshRemoteBackups() : Promise.resolve(),
      this.refreshCron(),
      this.refreshLastLog(),
    ]).then(() => {
      this.dashboard.setContent(this.renderDashboard());
      this.screen.render();
    }).catch(() => {});
  }

  async refreshDisk() {
    const localDir = this.cfg.localArchiveDir || this.cfg.localStagingDir || ARCHIVE_DIR_DEFAULT;
    try {
      this.disk.local = await withTimeout(localDiskInfo(localDir), 5000, { ok: false, free: null, total: null });
    } catch (e) { this.disk.local = { ok: false, error: e.message }; }
    try {
      this.disk.remote = await withTimeout(remoteDiskInfo(this.cfg), 10000, { ok: false, free: null, total: null });
    } catch (e) { this.disk.remote = { ok: false, error: e.message }; }
  }

  async refreshRemoteBackups() {
    try {
      this.remoteBackups = await withTimeout(listRemoteBackups(this.cfg), 10000, []);
    } catch (e) { this.remoteBackups = []; }
  }

  async refreshCron() {
    try {
      this.cron = await withTimeout(getCrontabEntry(), 3000, null);
    } catch (e) { this.cron = null; }
  }

  async refreshLastLog() {
    try {
      this.lastLog = await withTimeout(readLastLogLines(LOG_DIR, 15), 3000, []);
    } catch (e) { this.lastLog = []; }
  }

  renderDashboard() {
    if (this.cfgError) {
      return [
        C.red("Config error:") + " " + this.cfgError,
        "",
        `Edit config:  $EDITOR ${this.cfgPath}`,
        `Example:      ${path.join(TOOL_DIR, "config.example.json")}`,
        "",
        "Press r to retry after editing.",
      ].join("\n");
    }
    if (!this.cfg) return C.gray("Loading config...");

    const transfer = this.cfg.transfer || "ssh";
    const remote = this.disk.remote || {};
    const local = this.disk.local || {};

    let target;
    if (transfer === "ftp") {
      const f = this.cfg.ftp;
      target = `${C.cyan("ftp" + (f.secure ? "s" : ""))}://${C.cyan(f.user)}@${C.cyan(f.host)}:${C.cyan(f.port || 21)}${C.cyan(f.remoteDir)}`;
    } else {
      const s = this.cfg.ssh;
      target = `${C.cyan(s.user)}@${C.cyan(s.host)}:${C.cyan(s.remoteDir)}`;
    }

    let cronLine;
    if (this.cron) {
      cronLine = `${C.green("installed")}  schedule: ${C.yellow(this.cron.expr)}  (next: ${fmtNextRun(this.cron.expr)})`;
    } else {
      cronLine = `${C.red("not installed")}  — pick "Install / update cron" in the menu`;
    }

    const remoteStats = remote.ok
      ? `${this.remoteBackups.length} backups, ${fmtBytes(remote.totalBytes)} used${remote.free != null ? ", " + fmtBytes(remote.free) + " free" : ""}`
      : C.gray("unavailable");
    const localStats = local.ok
      ? `${fmtBytes(local.free)} free / ${fmtBytes(local.total)} (${Math.round((1 - local.free / local.total) * 100)}% used)`
      : C.gray("unavailable");

    let lastRunLine = C.gray("(no runs yet)");
    let totalsLine = "";
    if (this.state?.lastRun) {
      const lr = this.state.lastRun;
      const status = lr.ok ? C.green("ok") : C.red("FAILED");
      const dur = lr.durationMs ? `${Math.round(lr.durationMs / 1000)}s` : "?";
      lastRunLine = `${fmtAgo(lr.ts)} (${status}, ${dur}, ${lr.items || 0} items${lr.errors ? `, ${C.red(lr.errors + " errors")}` : ""})`;
      const t = this.state.totals || {};
      totalsLine = `${C.gray("lifetime:")} ${t.runs || 0} runs, ${t.failures || 0} failures, ${fmtBytes(t.bytesUploaded || 0)} uploaded`;
    }

    const logTail = this.lastLog.length === 0
      ? C.gray("(no log files yet)")
      : this.lastLog.map((l) => `${C.gray(path.basename(l.ts))}  ${l.text.replace(/\[[\d-]+ [\d:]+\] /, "")}`).join("\n");

    return [
      `${C.bold("Target:")}    ${target}`,
      `${C.bold("Transfer:")}  ${transfer.toUpperCase()}`,
      `${C.bold("Cron:")}      ${cronLine}`,
      `${C.bold("Last run:")}  ${lastRunLine}`,
      totalsLine ? `            ${totalsLine}` : "",
      `${C.bold("Local:")}     ${localStats}`,
      `${C.bold("Remote:")}    ${remoteStats}`,
      "",
      C.bold("── Recent log tail ──────────────────────────────────────"),
      logTail,
    ].filter(Boolean).join("\n");
  }

  // ---------- menu actions -----------------------------------------------

  async activate(idx) {
    if (this.busy) return;
    // Header lines are non-selectable dividers — auto-advance on Enter.
    if (this._menuHeaderIdxs && this._menuHeaderIdxs.includes(idx)) {
      this.menu.down();
      return;
    }
    // Map the raw list idx (which includes header offsets) to the action idx.
    const headersBefore = (this._menuHeaderIdxs || []).filter((h) => h < idx).length;
    const a = idx - headersBefore;
    if (this.firstRun) {
      if (a === 0) return this.runSetupWizard();
      if (a === 1) return this.editConfig();
      if (a === 2) return this.quit();
      return;
    }
    switch (a) {
      case 0: return this.startBackup({});
      case 1: return this.startBackup({ only: ["postgres", "sqlite"] });
      case 2: return this.showListBackups();
      case 3: return this.showRestorePicker();
      case 4: return this.showBackupContents();
      case 5: return this.showVerifyPicker();
      case 6: return this.showLogs();
      case 7: return this.testConnection();
      case 8: return this.pruneNow();
      case 9: return this.refreshAll();
      case 10: return this.installCronMenu();
      case 11: return this.configureNotifications();
      case 12: return this.editConfig();
      case 13: return this.quit();
    }
  }

  async runSetupWizard() {
    // Tear down the TUI screen and clean up stdin listeners so the
    // child's readline can attach to the TTY.
    this.screen.destroy();
    try {
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }
    } catch {}
    try {
      process.stdin.removeAllListeners("keypress");
      process.stdin.removeAllListeners("data");
    } catch {}

    // We have to spawn the wizard inside a `script -qfc` wrapper because
    // neo-blessed leaves the TTY in a state where the wizard's readline
    // silently receives empty strings for every prompt — even after we
    // remove all listeners and stop libuv from polling stdin. The exact
    // cause is murky, but the workaround is to give the wizard a brand
    // new pty via `script`, which bypasses the parent's broken stdin.
    const scriptPath = await new Promise((resolve) => {
      const r = spawn("which", ["script"]);
      let out = "";
      r.stdout.on("data", (b) => { out += b.toString(); });
      r.on("close", () => resolve(out.trim() || "/usr/bin/script"));
    });
    const env = { ...process.env, AEGIS_NO_TUI: "1" };
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(TOOL_DIR, "backup.mjs"))} --setup --config ${JSON.stringify(this.cfgPath)}`;
    const child = spawn(
      scriptPath,
      ["-qfc", cmd, "/dev/null"],
      { stdio: "inherit", env },
    );

    child.on("exit", (code) => {
      const ok = existsSync(this.cfgPath);
      // Reset terminal to a clean state — `script -qfc` leaves the TTY in
      // a half-configured state that confuses the new TUI.
      try { process.stdin.setRawMode?.(false); } catch {}
      try {
        process.stdin.removeAllListeners("keypress");
        process.stdin.removeAllListeners("data");
      } catch {}
      // Clear screen and reset attributes, then show the result message
      // before launching the new TUI.
      process.stdout.write("\x1b[0m\x1b[2J\x1b[H");
      if (ok) {
        console.log(C.green("✓ Setup complete.\n"));
      } else {
        console.log(C.yellow("Setup did not finish. You can edit config manually from the TUI.\n"));
      }
      console.log(C.gray("(launching TUI in 1.5s…)"));

      // Give the user a moment to read the message, then spawn the new TUI.
      // Using a timeout instead of waiting for Enter avoids hangs if stdin
      // is in a weird state from script's pty.
      setTimeout(() => {
        // Aggressive TTY reset before spawning the new TUI so it inherits
        // a clean terminal. `script -qfc` and the blessed teardown can
        // leave cooked mode / cursor / attributes in a half-configured
        // state that makes the dashboard hang.
        try { process.stdin.setRawMode?.(false); } catch {}
        try {
          process.stdin.removeAllListeners("keypress");
          process.stdin.removeAllListeners("data");
        } catch {}
        try { process.stdin.pause(); } catch {}
        // Reset all terminal attributes, show cursor, leave alt screen,
        // move to home position.
        process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l\x1b[H\x1b[2J");
        try { process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l"); } catch {}
        // Wait a tick for the kernel to flush, then spawn a fresh TUI
        // subprocess. The parent process stays alive until the new TUI
        // exits so it can keep the TTY session consistent.
        setTimeout(() => {
          const env = { ...process.env, AEGIS_NO_SETUP: "1" };
          const next = spawn(process.execPath, [
            path.join(TOOL_DIR, "tui.mjs"), "--config", this.cfgPath,
          ], { stdio: "inherit", env, detached: false });
          next.on("exit", (c) => process.exit(c ?? 0));
        }, 100);
      }, 1500);
    });
  }

  // ---------- backup progress view ---------------------------------------

  async startBackup(opts) {
    if (this.busy) return;
    if (!this.cfg) return this.toast("Config not loaded");

    this.busy = true;
    this.showView("progress");
    this.progress.setLabel(" Backup in progress ");
    this.progress.setContent(C.yellow("Starting..."));

    this.progressLog = [];
    this.progressState = {
      startedAt: Date.now(),
      phases: {
        postgres: { current: 0, total: 0, status: "pending", errors: 0 },
        sqlite:   { current: 0, total: 0, status: "pending", errors: 0 },
        pm2:      { current: 0, total: 0, status: "pending", errors: 0 },
        nginx:    { current: 0, total: 1, status: "pending", errors: 0 },
        extras:   { current: 0, total: 0, status: "pending", errors: 0 },
        archive:  { current: 0, total: 1, status: "pending", errors: 0 },
        upload:   { current: 0, total: 1, status: "pending", errors: 0 },
        prune:    { current: 0, total: 1, status: "pending", errors: 0 },
      },
    };

    const bus = new ProgressBus();
    this.bus = bus;
    bus.on("log", ({ level, message }) => {
      this.progressLog.push(`[${now()}] ${message}`);
      if (this.progressLog.length > 200) this.progressLog.shift();
      this.renderProgress();
    });
    bus.on("phase", ({ name, message, total }) => {
      const p = this.progressState.phases[name];
      if (p) { p.total = total ?? p.total; p.status = "running"; p.current = 0; }
      this.progressLog.push(`[${now()}] ▶ ${message}`);
      if (this.progressLog.length > 200) this.progressLog.shift();
      this.renderProgress();
    });
    bus.on("progress", ({ phase, current, total }) => {
      const p = this.progressState.phases[phase];
      if (p) { p.current = current; p.total = total || p.total; }
      this.renderProgress();
    });
    bus.on("item", ({ kind, name, status, error }) => {
      const p = this.progressState.phases[kind];
      if (p && status === "error") p.errors++;
      const mark = status === "ok" ? C.green("✓") : status === "skipped" ? C.gray("~") : C.red("✗");
      this.progressLog.push(`[${now()}] ${mark} ${kind}: ${name}${error ? " — " + C.red(error) : ""}`);
      if (this.progressLog.length > 200) this.progressLog.shift();
      this.renderProgress();
    });

    let result, errorMsg;
    try {
      result = await runBackup(this.cfg, opts, bus);
      this.progressState.phases.archive.status = "ok";
      this.progressState.phases.archive.current = 1;
      await uploadBundle(this.cfg, result.archive, opts);
      this.progressState.phases.upload.status = "ok";
      this.progressState.phases.upload.current = 1;
      await pruneRemote(this.cfg, opts);
      this.progressState.phases.prune.status = "ok";
      this.progressState.phases.prune.current = 1;
      await cleanupLocal(this.cfg, result.staging, result.archive, opts);
    } catch (e) {
      errorMsg = e?.message || String(e);
      this.progressLog.push(`[${now()}] ${C.red("✗ FAILED:")} ${errorMsg}`);
    } finally {
      this.bus = null;
      this.busy = false;
      this.renderProgress();
    }

    // Persist run + show completion notification
    const ok = !errorMsg;
    const durMs = Date.now() - this.progressState.startedAt;
    const logFile = (await loadState()).lastRun?.logFile || null;
    const { recordRun } = await import("./lib/state.mjs");
    const entry = await recordRun({
      ok,
      durationMs: durMs,
      items: result?.items?.length || 0,
      errors: (result?.errors?.length || 0) + (errorMsg ? 1 : 0),
      bytes: result?.bytes || 0,
      archive: result?.archive,
      logFile,
      error: errorMsg,
    });

    this.renderProgress();

    // Audible + visual notification
    bell();
    bell();
    bell();

    // Real completion modal — stays up until user dismisses
    this.showCompletionModal({
      ok,
      durMs,
      items: entry.items,
      errors: entry.errors,
      bytes: entry.bytes,
      archive: entry.archive,
      errorMsg,
      logFile,
    });
  }

  renderProgress() {
    if (!this.progressState) return;
    const elapsed = fmtDuration(Date.now() - this.progressState.startedAt);
    const lines = [];
    lines.push(`${C.bold("Elapsed:")} ${elapsed}    ${C.gray("(any key = return to menu; auto in 8s)")}`);
    lines.push("");
    lines.push(`${C.bold("Phase").padEnd(16)} ${"Progress".padEnd(40)} ${"Status".padEnd(12)} Errors`);
    const order = ["postgres", "sqlite", "pm2", "nginx", "extras", "archive", "upload", "prune"];
    for (const name of order) {
      const p = this.progressState.phases[name];
      const total = p.total > 0 ? p.total : (p.status === "ok" ? 1 : 0);
      const pct = total > 0 ? Math.round((p.current / total) * 100) : 0;
      const b = bar(pct, 24);
      const prog = total > 0 ? `${p.current}/${total} (${pct}%)` : (p.status === "ok" ? "done" : "—");
      const status =
        p.status === "ok" ? C.green("ok") :
        p.status === "running" ? C.yellow("running") :
        p.status === "error" ? C.red("error") :
        C.gray("pending");
      const err = p.errors > 0 ? C.red(String(p.errors)) : "0";
      lines.push(`${padEnd(name, 16)} ${b} ${padEnd(prog, 14)} ${padEnd(status, 12)} ${err}`);
    }
    lines.push("");
    lines.push(C.bold("── Live log (last 60) ────────────────────────────────────"));
    lines.push(this.progressLog.slice(-60).join("\n"));
    this.progress.setContent(lines.join("\n"));
    this.screen.render();
  }

  // ---------- list / restore / logs --------------------------------------

  async showListBackups() {
    if (!this.cfg) return this.toast("Config not loaded");
    this.toast("Querying remote...");
    const list = await listRemoteBackups(this.cfg);
    this.remoteBackups = list;
    if (list.length === 0) return this.toast(`No remote backups at ${this.cfg.ssh?.host || this.cfg.ftp?.host}`);

    this.listView.setLabel(` ${list.length} remote backups (Enter for details, Esc to back) `);
    this.listView.setItems(list.map((n, i) => `${(i + 1).toString().padStart(3)}. ${n}`));
    this.showView("list");
    this.listView.once("select", (_, idx) => {
      this.toast(`${list[idx]}\nSaved on remote — use "Restore..." to fetch.`);
      this.showView("menu");
      this.refreshAll();
    });
  }

  async showRestorePicker() {
    if (!this.cfg) return this.toast("Config not loaded");
    this.toast("Querying remote...");
    const list = await listRemoteBackups(this.cfg);
    this.remoteBackups = list;
    if (list.length === 0) return this.toast("No remote backups to restore");

    this.listView.setLabel(` Pick a backup to restore (Esc to cancel) `);
    this.listView.setItems(list.map((n, i) => `${(i + 1).toString().padStart(3)}. ${n}`));
    this.showView("list");
    this.listView.once("select", (_, idx) => {
      this.showView("menu");
      this.runRestore(list[idx]);
    });
  }

  async runRestore(archiveName) {
    this.screen.destroy();
    const child = spawn(process.execPath, [
      path.join(TOOL_DIR, "restore.mjs"),
      "--archive", archiveName,
      "--config", this.cfgPath,
    ], { stdio: "inherit" });
    child.on("exit", (code) => {
      console.log("");
      console.log(C.bold(`Restore exited with code ${code}. Press Enter to return to TUI.`));
      process.stdin.once("data", () => {
        const tui = new Tui();
        tui.menu.focus();
      });
    });
  }

  // "Show backup contents (preview)" — downloads a chosen archive, runs
  // `restore.mjs --plan` to read its manifest, and renders the result in
  // the logView so the user can see what they'd be restoring without
  // touching anything on disk.
  async showBackupContents() {
    if (!this.cfg) return this.toast("Config not loaded");
    this.toast("Querying remote...");
    const list = await listRemoteBackups(this.cfg);
    if (list.length === 0) return this.toast("No remote backups to preview");
    this.remoteBackups = list;
    this.listView.setLabel(` Pick a backup to preview (Esc to cancel) `);
    this.listView.setItems(list.map((n, i) => `${(i + 1).toString().padStart(3)}. ${n}`));
    this.showView("list");
    this.listView.once("select", async (_, idx) => {
      const archive = list[idx];
      this.toast(`Downloading & previewing ${archive}...`);
      const r = await shell(process.execPath, [
        path.join(TOOL_DIR, "restore.mjs"),
        "--archive", archive,
        "--config", this.cfgPath,
        "--plan", "--yes",
      ]);
      this.logView.setLabel(` ${archive} — contents preview (↑/↓ to scroll, Esc to back) `);
      this.logView.setContent(
        (r.stdout || "(no output)") +
        (r.code !== 0 ? `\n\n${C.red(`exit ${r.code}`)}\n${r.stderr || ""}` : "")
      );
      this.showView("logs");
      this.refreshAll();
    });
  }

  async showVerifyPicker() {
    if (!this.cfg) return this.toast("Config not loaded");
    this.toast("Querying remote...");
    const list = await listRemoteBackups(this.cfg);
    if (list.length === 0) return this.toast("No remote backups to verify");

    this.listView.setLabel(` Pick a backup to verify (Esc to cancel) `);
    this.listView.setItems(list.map((n, i) => `${(i + 1).toString().padStart(3)}. ${n}`));
    this.showView("list");
    this.listView.once("select", (_, idx) => {
      this.showView("menu");
      this.pickVerifyMode(list[idx]);
    });
  }

  // After picking an archive, ask what depth of verification to run.
  async pickVerifyMode(archiveName) {
    await this.runSubMenu({
      title: ` Verify ${archiveName} — pick mode `,
      buildChoices: () => [
        "  Transport check (sha256 only, fast)",
        "  Content check (extract + per-component verify, slow)",
        "  Both (transport then content)",
      ],
      handleChoice: async (idx) => {
        if (idx === 0) {
          this.runVerify(archiveName, false);
        } else if (idx === 1) {
          this.runDeepVerify(archiveName);
        } else if (idx === 2) {
          // Run transport first, then deep — chained.
          this.runVerifyChained(archiveName);
        }
        return { exit: true };
      },
    });
  }

  async runVerify(archiveName, showMode = true) {
    this.screen.destroy();
    const child = spawn(process.execPath, [
      path.join(TOOL_DIR, "verify.mjs"),
      "--archive", archiveName,
      "--config", this.cfgPath,
    ], { stdio: "inherit" });
    child.on("exit", (code) => {
      console.log("");
      console.log(C.bold(code === 0 ? `✓ Transport verification PASSED. Press Enter to return to TUI.` : `✗ Transport verification FAILED (exit ${code}). Press Enter to return to TUI.`));
      process.stdin.once("data", () => {
        const tui = new Tui();
        tui.menu.focus();
      });
    });
  }

  async runDeepVerify(archiveName) {
    this.screen.destroy();
    // --verify --download-only: extract, verify contents, exit before restore.
    const child = spawn(process.execPath, [
      path.join(TOOL_DIR, "restore.mjs"),
      "--archive", archiveName,
      "--config", this.cfgPath,
      "--verify", "--download-only",
      "--yes",
    ], { stdio: "inherit" });
    child.on("exit", (code) => {
      console.log("");
      console.log(C.bold(code === 0 ? `✓ Content verification PASSED. Press Enter to return to TUI.` : `✗ Content verification FAILED (exit ${code}). Press Enter to return to TUI.`));
      process.stdin.once("data", () => {
        const tui = new Tui();
        tui.menu.focus();
      });
    });
  }

  async runVerifyChained(archiveName) {
    this.screen.destroy();
    // Run transport first; only if it passes, run content.
    const transport = spawn(process.execPath, [
      path.join(TOOL_DIR, "verify.mjs"),
      "--archive", archiveName,
      "--config", this.cfgPath,
    ], { stdio: "inherit" });
    transport.on("exit", (code) => {
      if (code !== 0) {
        console.log("");
        console.log(C.red(`✗ Transport check failed (exit ${code}) — skipping content check.`));
        process.stdin.once("data", () => {
          const tui = new Tui();
          tui.menu.focus();
        });
        return;
      }
      const content = spawn(process.execPath, [
        path.join(TOOL_DIR, "restore.mjs"),
        "--archive", archiveName,
        "--config", this.cfgPath,
        "--verify", "--download-only",
        "--yes",
      ], { stdio: "inherit" });
      content.on("exit", (code2) => {
        console.log("");
        console.log(C.bold(code2 === 0 ? `✓ Full verification PASSED. Press Enter to return to TUI.` : `✗ Content verification FAILED (exit ${code2}). Press Enter to return to TUI.`));
        process.stdin.once("data", () => {
          const tui = new Tui();
          tui.menu.focus();
        });
      });
    });
  }

  async showLogs() {
    if (!existsSync(LOG_DIR)) return this.toast("No logs yet");
    const files = (await fs.readdir(LOG_DIR)).filter((f) => f.startsWith("backup-")).sort().reverse();
    if (files.length === 0) return this.toast("No log files yet");
    this.listView.setLabel(` Log files (Enter to view, Esc to back) `);
    this.listView.setItems(files.map((f, i) => `${(i + 1).toString().padStart(3)}. ${f}`));
    this.showView("list");
    this.listView.once("select", async (_, idx) => {
      const file = files[idx];
      const lines = (await fs.readFile(path.join(LOG_DIR, file), "utf8")).split("\n");
      this.logView.setLabel(` ${file} (↑/↓ to scroll, Esc to back) `);
      this.logView.setContent(lines.join("\n"));
      this.showView("logs");
    });
  }

  async testConnection() {
    if (!this.cfg) return this.toast("Config not loaded");
    const transfer = this.cfg.transfer || "ssh";
    if (transfer === "ftp") {
      this.toast(`Testing FTP to ${this.cfg.ftp.host}...`);
      const f = this.cfg.ftp;
      const proto = f.secure ? "ftps" : "ftp";
      const base = `${proto}://${f.host}:${f.port || 21}/`;
      const r = await shell("curl", [
        "--silent", "--show-error",
        "--connect-timeout", "10", "--max-time", "20",
        "-u", `${f.user}:${f.password}`,
        ...(f.secure ? ["--ssl"] : []),
        "--list-only", base,
      ]);
      if (r.code === 0) {
        this.toast(`${C.green("FTP OK")} (${proto}://${f.host}:${f.port || 21})`);
      } else {
        this.toast(`${C.red("FTP FAILED")} (exit ${r.code})\n${(r.stderr || r.stdout || "").slice(0, 200)}`);
      }
    } else {
      this.toast(`Testing SSH to ${this.cfg.ssh.host}...`);
      const r = await shell("ssh", [
        "-i", this.cfg.ssh.identityFile || "/root/.ssh/id_ed25519",
        "-p", String(this.cfg.ssh.port || 22),
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=10",
        `${this.cfg.ssh.user}@${this.cfg.ssh.host}`,
        "echo ok && uname -a",
      ]);
      if (r.code === 0) {
        const info = r.stdout.trim().split("\n").pop();
        this.toast(`${C.green("SSH OK")}\n${info}`);
      } else {
        this.toast(`${C.red("SSH FAILED")} (exit ${r.code})\n${(r.stderr || "").slice(0, 200)}`);
      }
    }
    this.refreshAll();
  }

  async pruneNow() {
    if (!this.cfg) return this.toast("Config not loaded");
    this.toast("Pruning remote...");
    try {
      const n = await pruneRemote(this.cfg, {});
      this.toast(`${C.green("Pruned")} ${n} backup(s).`);
    } catch (e) {
      this.toast(`${C.red("Prune failed:")} ${e.message}`);
    }
    this.refreshAll();
  }

  async installCronMenu() {
    const current = this.cron;
    const choices = [
      "  Hourly                — 0 * * * *",
      "  Every 2 hours         — 0 */2 * * *",
      "  Every 4 hours         — 0 */4 * * *",
      "  Every 6 hours         — 0 */6 * * *",
      "  Every 12 hours        — 0 */12 * * *",
      "  Daily at 00:00        — 0 0 * * *",
      "  Daily at 02:00  ★     — 0 2 * * *",
      "  Daily at 04:00        — 0 4 * * *",
      "  Weekly Sun 04:00      — 0 4 * * 0",
      "  Weekly Mon 04:00      — 0 4 * * 1",
      "  Monthly 1st 02:00     — 0 2 1 * *",
      "  Custom — enter expression",
      "  Add weekly verify cron (Sun 06:00) — independent",
      "  Uninstall (remove ALL cron jobs)",
      "  Cancel",
    ];
    const exprs = [
      "0 * * * *",
      "0 */2 * * *",
      "0 */4 * * *",
      "0 */6 * * *",
      "0 */12 * * *",
      "0 0 * * *",
      "0 2 * * *",
      "0 4 * * *",
      "0 4 * * 0",
      "0 4 * * 1",
      "0 2 1 * *",
    ];
    this.listView.setLabel(" Choose cron schedule (Esc to cancel) ");
    this.listView.setItems(choices);
    this.showView("list");
    this.listView.once("select", async (_, idx) => {
      this.showView("menu");
      const cancelIdx = choices.length - 1;
      const uninstallIdx = choices.length - 2;
      const verifyCronIdx = choices.length - 3;
      const customIdx = choices.length - 4;
      if (idx === cancelIdx) return;
      if (idx === uninstallIdx) return this.runInstallCron(null, true);
      if (idx === verifyCronIdx) return this.runInstallCronVerify();
      let expr;
      if (idx === customIdx) {
        const ans = await this.prompt(
          "Cron expression (M H DoM Mo DoW):",
          current?.expr || "0 2 * * *",
        );
        if (!ans) return;
        expr = ans.trim();
      } else if (exprs[idx]) {
        expr = exprs[idx];
      } else {
        return;
      }
      await this.runInstallCron(expr, false);
    });
    if (current) this.toast(`Currently installed: ${C.yellow(current.expr)}`);
  }

  async runInstallCron(expr, uninstall) {
    const args = [path.join(TOOL_DIR, "install-cron.sh")];
    if (uninstall) args.push("--uninstall");
    else if (expr) args.push(expr);
    const r = await shell("bash", args);
    this.toast(uninstall ? "Cron removed." : (r.code === 0 ? `${C.green("Cron installed:")} ${expr || "default"}` : `${C.red("install failed:")} ${r.stderr}`));
    await this.refreshCron();
    this.refreshAll();
  }

  // Install ONLY the weekly verify cron (does not touch the backup cron).
  // Lets a user add the safety net without re-running setup.
  async runInstallCronVerify() {
    const expr = await this.prompt(
      "Weekly verify cron expression (M H DoM Mo DoW):",
      "0 6 * * 0",
    );
    if (!expr) return;
    const r = await shell("bash", [path.join(TOOL_DIR, "install-cron.sh"), "--verify", expr.trim()]);
    this.toast(r.code === 0 ? `${C.green("Weekly verify cron installed:")} ${expr.trim()}` : `${C.red("install failed:")} ${r.stderr}`);
    await this.refreshCron();
    this.refreshAll();
  }

  async editConfig() {
    const editor = process.env.EDITOR || process.env.VISUAL || (await this.pickEditor());
    if (!editor) return this.toast("No editor configured (set $EDITOR)");

    if (!existsSync(this.cfgPath)) {
      const example = path.join(TOOL_DIR, "config.example.json");
      if (existsSync(example)) {
        await fs.copyFile(example, this.cfgPath);
        this.toast(`Copied ${example} → ${this.cfgPath}`);
      } else {
        return this.toast(`No config and no example found`);
      }
    }

    // Tear down the TUI screen so the editor can use the terminal.
    this.screen.destroy();
    const child = spawn(editor, [this.cfgPath], { stdio: "inherit" });
    child.on("exit", () => {
      console.log(C.bold("\nPress Enter to return to TUI…"));
      process.stdin.setRawMode?.(false);
      process.stdin.resume();
      process.stdin.once("data", () => {
        process.stdin.pause();
        const tui = new Tui();
        tui.menu.focus();
      });
    });
  }

  async configureNotifications() {
    if (!this.cfg) return this.toast("Config not loaded");

    await this.runSubMenu({
      title: " Configure notifications (Esc to cancel) ",
      buildChoices: () => {
        const cur = this.cfg.notifications || {};
        const hc = cur.healthcheckUrl || "";
        const whSec = cur.webhook?.secret;
        return [
          `Enable failure notifications: ${cur.onFailure !== false ? C.green("yes") : C.gray("no")}`,
          `Enable success notifications: ${cur.onSuccess === true ? C.green("yes") : C.gray("no")}`,
          "  Configure webhook URL",
          `  Configure webhook signing secret: ${whSec ? C.green("•".repeat(8)) : C.gray("(not set)")}`,
          "  Configure email recipient (to)",
          "  Configure email sender (from)",
          "  Configure SMTP server...",
          `Healthcheck URL: ${hc ? C.green(hc.length > 40 ? hc.slice(0, 37) + "…" : hc) : C.gray("(not set — dead-man's switch off)")}`,
          "  Test healthcheck ping now",
          "  Test notifications now",
        ];
      },
      handleChoice: async (idx) => {
        const cur = this.cfg.notifications || {};
        if (idx === 0) {
          cur.onFailure = cur.onFailure !== false ? false : true;
        } else if (idx === 1) {
          cur.onSuccess = cur.onSuccess === true ? false : true;
        } else if (idx === 2) {
          const url = await this.prompt("Webhook URL (e.g. Slack/Discord/ntfy):", cur.webhook?.url || "");
          if (url) cur.webhook = { ...cur.webhook, url };
        } else if (idx === 3) {
          const secret = await this.prompt(
            "Webhook signing secret (sent as X-Aegis-Signature: sha256=<hex>; blank to clear):",
            cur.webhook?.secret || "",
          );
          if (secret && secret.trim()) {
            cur.webhook = { ...cur.webhook, secret: secret.trim() };
          } else {
            if (cur.webhook) delete cur.webhook.secret;
          }
        } else if (idx === 4) {
          const to = await this.prompt("Email recipient (to):", cur.email?.to || "");
          if (to) cur.email = { ...cur.email, to };
        } else if (idx === 5) {
          const from = await this.prompt("Email sender (from):", cur.email?.from || "Aegis");
          if (from) cur.email = { ...cur.email, from };
        } else if (idx === 6) {
          await this.configureSmtp();
          return { stay: true };
        } else if (idx === 7) {
          const url = await this.prompt(
            "Healthchecks.io / Uptime Kuma ping URL (leave blank to clear):",
            cur.healthcheckUrl || "",
          );
          if (url && url.trim()) cur.healthcheckUrl = url.trim();
          else delete cur.healthcheckUrl;
        } else if (idx === 8) {
          if (!cur.healthcheckUrl) {
            this.toast("No healthcheck URL set — nothing to test");
            return { stay: true };
          }
          this.toast("Sending healthcheck ping…");
          try {
            const { pingHealthcheck } = await import("./lib/notifications.mjs");
            await pingHealthcheck(cur.healthcheckUrl, true);
            this.toast(C.green("✓ Healthcheck ping sent (success path)"));
          } catch (e) {
            this.toast(C.red(`✗ Healthcheck ping failed: ${e.message}`));
          }
          return { stay: true };
        } else if (idx === 9) {
          await this.testNotifications();
          return { stay: true };
        }
        this.cfg.notifications = cur;
        await fs.writeFile(this.cfgPath, JSON.stringify(this.cfg, null, 2) + "\n", { mode: 0o600 });
        this.toast("Notifications config updated");
        await this.refreshConfig();
        return { stay: true };
      },
    });
    this.showView("menu");
  }

  async configureSmtp() {
    if (!this.cfg) return this.toast("Config not loaded");

    const mask = (v) => (v ? C.gray("•".repeat(Math.min(v.length, 12))) : C.gray("(not set)"));
    const set = (v) => v || C.gray("(not set)");

    await this.runSubMenu({
      title: " Configure SMTP (Esc to back) ",
      buildChoices: () => {
        const s = this.cfg.notifications?.smtp || {};
        return [
          `Server (host):   ${set(s.host)}`,
          `Port:            ${s.port || 587}`,
          `Username:        ${mask(s.user)}`,
          `Password:        ${mask(s.pass)}`,
          `Sender (from):   ${set(s.from || s.user)}`,
          `Recipient (to):  ${set(s.to)}`,
          `Use TLS (465):   ${s.secure === true ? C.green("yes") : C.gray("no (STARTTLS)")}`,
          "  Clear all SMTP settings",
        ];
      },
      handleChoice: async (idx) => {
        const cur = this.cfg.notifications || {};
        cur.smtp = cur.smtp || {};
        const s = cur.smtp;
        if (idx === 0) {
          const host = await this.prompt("SMTP server (host):", s.host || "");
          if (host) s.host = host.trim();
        } else if (idx === 1) {
          const portStr = await this.prompt("SMTP port:", String(s.port || 587));
          if (portStr) {
            const port = parseInt(portStr, 10);
            if (!Number.isNaN(port) && port > 0 && port < 65536) s.port = port;
            else this.toast("Invalid port — ignored");
          }
        } else if (idx === 2) {
          const user = await this.prompt("SMTP username:", s.user || "");
          if (user) s.user = user;
        } else if (idx === 3) {
          const pass = await this.prompt("SMTP password:", "");
          if (pass) s.pass = pass;
        } else if (idx === 4) {
          const from = await this.prompt("Sender address (from):", s.from || s.user || "");
          if (from) s.from = from;
        } else if (idx === 5) {
          const to = await this.prompt("Recipient address (to):", s.to || "");
          if (to) s.to = to;
        } else if (idx === 6) {
          s.secure = s.secure === true ? false : true;
        } else if (idx === 7) {
          delete cur.smtp;
          this.toast("SMTP settings cleared");
          this.cfg.notifications = cur;
          await fs.writeFile(this.cfgPath, JSON.stringify(this.cfg, null, 2) + "\n", { mode: 0o600 });
          await this.refreshConfig();
          return { stay: true };
        }
        this.cfg.notifications = cur;
        await fs.writeFile(this.cfgPath, JSON.stringify(this.cfg, null, 2) + "\n", { mode: 0o600 });
        this.toast("SMTP config updated");
        await this.refreshConfig();
        return { stay: true };
      },
    });
  }

  // Generic sub-menu runner: shows a list, loops, calls handleChoice for each
  // selection. Returns when handleChoice returns { exit: true } or Esc is pressed.
  // handleChoice may return { stay: true } (default — re-render and keep going)
  // or { exit: true } (leave the sub-menu). Esc always exits.
  async runSubMenu({ title, buildChoices, handleChoice }) {
    if (!this._subMenuStack) this._subMenuStack = [];
    const myToken = {};
    this._subMenuStack.push(myToken);
    const isTop = () => this._subMenuStack[this._subMenuStack.length - 1] === myToken;

    const render = () => {
      this.listView.setLabel(title);
      this.listView.setItems(buildChoices());
      this.listView.select(0);
      this.listView.focus();
      this.screen.render();
    };

    const waitForChoice = () => new Promise((resolve) => {
      const onSelect = (_, idx) => {
        if (!isTop()) return;
        this.listView.removeListener("select", onSelect);
        this.listView.removeListener("keypress", onKey);
        resolve({ idx, esc: false });
      };
      const onKey = (ch, key) => {
        if (!isTop()) return;
        if (key && key.name === "escape") {
          this.listView.removeListener("select", onSelect);
          this.listView.removeListener("keypress", onKey);
          resolve({ idx: -1, esc: true });
        }
      };
      this.listView.on("select", onSelect);
      this.listView.on("keypress", onKey);
    });

    render();
    this.showView("list");

    try {
      while (true) {
        const { idx, esc } = await waitForChoice();
        if (esc) return;
        const result = (await handleChoice(idx)) || {};
        if (result.exit) return;
        render();
      }
    } finally {
      const idx = this._subMenuStack.indexOf(myToken);
      if (idx >= 0) this._subMenuStack.splice(idx, 1);
    }
  }

  async testNotifications() {
    if (!this.cfg?.notifications) return this.toast("No notifications configured");
    this.toast("Sending test notification…");
    try {
      const { sendNotifications } = await import("./lib/notifications.mjs");
      await sendNotifications(this.cfg, {
        ok: true,
        summary: {
          host: os.hostname(),
          timestamp: new Date().toISOString(),
          duration: "0s",
          items: 0,
          errors: 0,
          bytes: 0,
          archive: "test-notification",
          error: null,
          logFile: null,
        },
      });
      this.toast(C.green("✓ Test notification sent"));
    } catch (e) {
      this.toast(C.red(`✗ Failed: ${e.message}`));
    }
  }

  async pickEditor() {
    for (const e of ["nano", "vim", "vi"]) {
      const r = await shell("which", [e]);
      if (r.code === 0) return e;
    }
    return null;
  }

  // ---------- misc --------------------------------------------------------

  toast(msg, ttl = 4500) {
    const t = blessed.message({
      parent: this.screen,
      top: "center", left: "center", width: "70%", height: "shrink",
      label: " Info ",
      border: { type: "line", fg: "cyan" },
      style: { border: { fg: "cyan" } },
      tags: false, keys: false, mouse: false,
    });
    t.setContent(String(msg));
    // Don't steal focus — a focused toast eats the user's first keystroke
    // after a save and leaves focus on a destroyed widget, which makes the
    // underlying list/menu appear unresponsive until something else refocuses.
    setTimeout(() => { try { t.destroy(); this.screen.render(); } catch {} }, ttl);
    this.screen.render();
  }

  async prompt(question, defaultValue = "") {
    return new Promise((resolve) => {
      const box = blessed.textbox({
        parent: this.screen,
        top: "center", left: "center", width: 60, height: 5,
        label: ` ${question} `,
        border: { type: "line", fg: "cyan" },
        style: { border: { fg: "cyan" } },
        keys: true, inputOnFocus: true, tags: false,
      });
      if (defaultValue) box.setValue(defaultValue);
      this.screen.saveFocus();
      const cleanup = (v) => {
        box.destroy();
        try { this.screen.restoreFocus(); } catch {}
        this.screen.render();
        resolve(v);
      };
      box.on("submit", (v) => cleanup(v));
      box.on("cancel", () => cleanup(null));
      box.focus();
      this.screen.render();
    });
  }
}

// ---------- main ----------------------------------------------------------

const tui = new Tui();
tui.menu.focus();
tui.screen.render();
