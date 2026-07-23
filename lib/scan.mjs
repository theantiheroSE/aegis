// lib/scan.mjs — discover what's installed on this host and suggest config additions.
//
// Used by the first-time setup wizard after the connection test:
//   1. Run all probes in parallel (with per-probe timeout).
//   2. Show findings in the terminal.
//   3. Ask the user which to apply (Y/n or per-item picker).
//   4. Each finding's `apply(cfg)` mutates the in-memory config.
//
// Probes are intentionally lightweight — they check for binaries, sockets,
// and config directories. None of them query data (no `psql -l` etc.) so
// there's no auth requirement and no chance of a probe blocking on user
// input.
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

const PROBE_TIMEOUT_MS = 5000;

// Run a binary with a hard timeout. Returns { code, stdout, stderr, timedOut }.
function runTimed(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let killed = false;
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
    }, PROBE_TIMEOUT_MS);
    const so = [], se = [];
    child.stdout.on("data", (b) => so.push(b));
    child.stderr.on("data", (b) => se.push(b));
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: e.message, timedOut: killed }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: killed ? -1 : (code ?? -1),
        stdout: Buffer.concat(so).toString("utf8"),
        stderr: Buffer.concat(se).toString("utf8"),
        timedOut: killed,
      });
    });
  });
}

async function which(bin) {
  const r = await runTimed("sh", ["-c", `command -v ${bin} >/dev/null 2>&1`]);
  return r.code === 0;
}

// ---------- individual probes ---------------------------------------------

async function probePostgres() {
  if (!await which("psql") && !await which("pg_isready")) {
    return { id: "postgres", title: "PostgreSQL", detected: false };
  }
  // Get version + cluster dir from pg_config if available.
  let version = "";
  let clusterDir = "/var/lib/postgresql";
  const cfg = await runTimed("pg_config", ["--version"]);
  if (cfg.code === 0) version = cfg.stdout.trim().split("\n")[0].replace(/^PostgreSQL\s+/i, "");
  // Look for the cluster socket / port via pg_isready.
  let sock = "/var/run/postgresql";
  const ready = await runTimed("pg_isready", ["-h", sock]);
  if (ready.code === 0) {
    const m = ready.stdout.match(/-p\s+(\d+)/);
    if (m) sock = `${sock}:${m[1]}`;
  } else {
    // Try TCP localhost as fallback.
    const ready2 = await runTimed("pg_isready", ["-h", "localhost"]);
    if (ready2.code === 0) sock = "localhost";
  }
  return {
    id: "postgres",
    title: "PostgreSQL",
    detected: true,
    recommend: true,
    details: `PostgreSQL ${version || "?"} — socket ${sock}`,
    apply: (cfg) => {
      cfg.postgres = cfg.postgres || {};
      cfg.postgres.enabled = true;
      if (!cfg.postgres.host) cfg.postgres.host = sock.startsWith("/") ? sock : (sock === "localhost" ? "localhost" : "/var/run/postgresql");
      if (!cfg.postgres.port) cfg.postgres.port = 5432;
      if (!cfg.postgres.user) cfg.postgres.user = "postgres";
      if (!cfg.postgres.runAs) cfg.postgres.runAs = "postgres";
    },
  };
}

async function probeMysql() {
  const hasMysql = await which("mysql");
  const hasMysqld = await which("mysqld") || await which("mariadbd");
  if (!hasMysql && !hasMysqld) {
    return { id: "mysql", title: "MySQL / MariaDB", detected: false };
  }
  // Check for a running socket — but don't actually query (no creds yet).
  let socketHint = "/var/run/mysqld/mysqld.sock";
  const sock = existsSync(socketHint);
  const variant = hasMysqld ? "MySQL" : "MariaDB";
  return {
    id: "mysql",
    title: `${variant}`,
    detected: true,
    recommend: true,
    // We can't verify without credentials — recommend include, but the apply
    // leaves user/password blank so the user fills them in.
    details: `${variant} binaries found${sock ? ` (socket: ${socketHint})` : ""} — credentials not verified`,
    apply: (cfg) => {
      cfg.mysql = cfg.mysql || {};
      cfg.mysql.enabled = true;
      if (!cfg.mysql.host) cfg.mysql.host = "localhost";
      if (!cfg.mysql.port) cfg.mysql.port = 3306;
      if (!cfg.mysql.user) cfg.mysql.user = "root";
    },
  };
}

async function probeSqlite() {
  // Walk the default search paths and count *.db / *.sqlite files.
  const candidates = ["/var/www", "/root", "/opt", "/srv"];
  let total = 0;
  const foundIn = [];
  async function walkDir(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".well-known") continue;
      // Skip obvious junk / caches.
      const skip = ["node_modules", ".git", ".cache", ".npm", ".next", "dist"];
      if (skip.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walkDir(full, depth + 1);
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        if (lower.endsWith(".db") || lower.endsWith(".sqlite") || lower.endsWith(".sqlite3")) {
          total++;
          if (!foundIn.includes(dir)) foundIn.push(dir);
        }
      }
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) await walkDir(c, 0);
  }
  if (total === 0) {
    return { id: "sqlite", title: "SQLite", detected: false };
  }
  return {
    id: "sqlite",
    title: "SQLite",
    detected: true,
    recommend: true,
    details: `${total} file(s) in ${foundIn.length} dir(s): ${foundIn.slice(0, 3).join(", ")}${foundIn.length > 3 ? "…" : ""}`,
    apply: (cfg) => {
      cfg.sqlite = cfg.sqlite || {};
      cfg.sqlite.enabled = true;
      cfg.sqlite.searchPaths = cfg.sqlite.searchPaths || [];
      for (const c of candidates) {
        if (existsSync(c) && !cfg.sqlite.searchPaths.includes(c)) {
          cfg.sqlite.searchPaths.push(c);
        }
      }
    },
  };
}

async function probeNginx() {
  if (!existsSync("/etc/nginx")) {
    return { id: "nginx", title: "nginx", detected: false };
  }
  let siteCount = 0;
  try {
    const entries = await fs.readdir("/etc/nginx/sites-available");
    siteCount = entries.length;
  } catch {}
  return {
    id: "nginx",
    title: "nginx",
    detected: true,
    recommend: true,
    details: `/etc/nginx present${siteCount ? ` (${siteCount} site configs)` : ""}`,
    apply: (cfg) => {
      cfg.nginx = cfg.nginx || {};
      cfg.nginx.enabled = true;
      if (!cfg.nginx.sitesAvailable) cfg.nginx.sitesAvailable = "/etc/nginx/sites-available";
      if (!cfg.nginx.sitesEnabled) cfg.nginx.sitesEnabled = "/etc/nginx/sites-enabled";
      if (!cfg.nginx.confDir) cfg.nginx.confDir = "/etc/nginx/conf.d";
      if (!cfg.nginx.mainConfig) cfg.nginx.mainConfig = "/etc/nginx/nginx.conf";
    },
  };
}

async function probePm2() {
  if (!await which("pm2")) {
    return { id: "pm2", title: "PM2", detected: false };
  }
  const r = await runTimed("pm2", ["jlist"]);
  if (r.code !== 0) {
    return { id: "pm2", title: "PM2", detected: true, recommend: false, details: "pm2 jlist failed (no daemon?)" };
  }
  let apps = [];
  try { apps = JSON.parse(r.stdout); } catch {}
  const unique = new Set(apps.map((a) => a.name));
  return {
    id: "pm2",
    title: "PM2",
    detected: true,
    recommend: true,
    details: `${unique.size} app(s): ${[...unique].slice(0, 3).join(", ")}${unique.size > 3 ? "…" : ""}`,
    apply: (cfg) => {
      cfg.pm2 = cfg.pm2 || {};
      cfg.pm2.enabled = true;
    },
  };
}

async function probeLetsEncrypt() {
  if (!existsSync("/etc/letsencrypt")) {
    return { id: "letsencrypt", title: "Let's Encrypt", detected: false };
  }
  let count = 0;
  try {
    const entries = await fs.readdir("/etc/letsencrypt/live");
    count = entries.length;
  } catch {}
  return {
    id: "letsencrypt",
    title: "Let's Encrypt certificates",
    detected: true,
    recommend: true,
    details: `/etc/letsencrypt${count ? ` (${count} cert(s))` : ""}`,
    apply: (cfg) => {
      cfg.extraPaths = cfg.extraPaths || [];
      if (!cfg.extraPaths.includes("/etc/letsencrypt")) {
        cfg.extraPaths.push("/etc/letsencrypt");
      }
    },
  };
}

async function probeDocker() {
  if (!await which("docker")) {
    return { id: "docker", title: "Docker", detected: false };
  }
  const r = await runTimed("docker", ["ps", "-q"]);
  if (r.code !== 0) {
    return { id: "docker", title: "Docker", detected: true, recommend: false, details: "docker binary present but `docker ps` failed (no socket access?)" };
  }
  const ids = r.stdout.split("\n").filter(Boolean);
  return {
    id: "docker",
    title: "Docker",
    detected: true,
    recommend: false, // Aegis doesn't natively back up containers; just info.
    details: `${ids.length} running container(s) — Aegis doesn't include container data; add specific paths to extraPaths if needed`,
    apply: () => {}, // no-op
  };
}

async function probeCommonExtras() {
  // Catch-all for well-known config directories Aegis doesn't have dedicated
  // blocks for. Each is an extraPath suggestion.
  const candidates = [
    { path: "/etc/postfix",       label: "Postfix mail server" },
    { path: "/etc/dovecot",       label: "Dovecot IMAP/POP3" },
    { path: "/etc/redis",         label: "Redis (config — data usually in /var/lib/redis)" },
    { path: "/etc/mongod.conf",   label: "MongoDB (config — data in /var/lib/mongodb)" },
    { path: "/var/spool/cron",    label: "User crontabs" },
    { path: "/etc/fail2ban",      label: "fail2ban jail config" },
    { path: "/etc/ssh",           label: "SSH host config (sshd_config)" },
  ];
  const found = [];
  for (const c of candidates) {
    if (existsSync(c.path)) found.push(c);
  }
  if (found.length === 0) return null;
  return {
    id: "extras",
    title: "Other configs",
    detected: true,
    recommend: true,
    details: found.map((f) => f.label).join(", "),
    apply: (cfg) => {
      cfg.extraPaths = cfg.extraPaths || [];
      for (const f of found) {
        if (!cfg.extraPaths.includes(f.path)) cfg.extraPaths.push(f.path);
      }
    },
  };
}

// ---------- orchestrator --------------------------------------------------

export async function runScan() {
  const probes = [
    probePostgres(),
    probeMysql(),
    probeSqlite(),
    probeNginx(),
    probePm2(),
    probeLetsEncrypt(),
    probeDocker(),
    probeCommonExtras(),
  ];
  const results = await Promise.all(probes);
  return results.filter(Boolean);
}

// Apply the selected findings to a config object (mutates in place).
// `selectedIds` is a Set; missing means "don't apply".
export function applyFindings(cfg, findings, selectedIds) {
  for (const f of findings) {
    if (!selectedIds.has(f.id)) continue;
    if (!f.detected || !f.apply) continue;
    f.apply(cfg);
  }
  return cfg;
}
