#!/usr/bin/env node
// restore.mjs — interactive restore from a remote Aegis archive.
//
// Usage:
//   node restore.mjs                          # list remote backups and prompt
//   node restore.mjs --archive <name>         # restore a specific archive
//   node restore.mjs --list                   # only list
//   node restore.mjs --download-only <name>   # just download+extract, no restore
//   node restore.mjs --yes                    # skip confirmations (DANGEROUS)
//
import { spawn } from "node:child_process";
import { promises as fs, existsSync, createReadStream, rm } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import os from "node:os";

const TOOL_DIR = path.dirname(new URL(import.meta.url).pathname);

function parseArgs(argv) {
  const opts = {
    config: path.join(TOOL_DIR, "config.json"),
    archive: null,
    list: false,
    downloadOnly: false,
    yes: false,
    from: null,
    to: null,
    mapRoot: [],
    bootstrap: false,
    verify: false,
    verifyLatest: false,
    plan: false,
  };
  for (let i = 2; i < argv.length; i++) {
    let a = argv[i];
    let val = null;
    const eq = a.indexOf("=");
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === "--config" || a === "-c") opts.config = val ?? argv[++i];
    else if (a === "--archive") opts.archive = val ?? argv[++i];
    else if (a === "--list") opts.list = true;
    else if (a === "--download-only") { opts.downloadOnly = true; opts.archive = val ?? argv[++i]; }
    else if (a === "--from") { opts.from = val ?? argv[++i]; }
    else if (a === "--to") { opts.to = val ?? argv[++i]; }
    else if (a === "--map-root") {
      const v = val ?? argv[++i];
      if (!v || !v.includes(":")) throw new Error("--map-root expects OLD:NEW (can be repeated)");
      opts.mapRoot.push(v);
    }
    else if (a === "--bootstrap") opts.bootstrap = true;
    else if (a === "--verify") opts.verify = true;
    else if (a === "--verify-latest") opts.verifyLatest = true;
    else if (a === "--plan") opts.plan = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return opts;
}

function parseDateFilter(input, label) {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid --${label} date: ${input} (use ISO 8601, e.g. 2024-12-31 or 2024-12-31T08:00:00Z)`);
  }
  return d;
}

function printHelp() {
  console.log(`restore.mjs — restore from a Aegis archive.

Usage:
  node restore.mjs [--config path] [--archive <name>] [--from <date>] [--to <date>]
                  [--list] [--download-only <name>] [--yes]
                  [--map-root OLD:NEW]... [--bootstrap] [--verify]

Date filtering:
  --from <ISO date>   Pick the most recent archive whose timestamp is
                      at or before this date (e.g. 2024-12-31 or 2024-12-31T08:00:00Z).
  --to   <ISO date>   Lower bound: only archives AFTER this date.

Cross-host restore:
  --map-root OLD:NEW  Rewrite paths in the manifest that start with OLD
                      to start with NEW. Can be repeated for multiple
                      mappings. Applied to sqlite.source, pm2.cwd/script,
                      and extras.path. Useful when restoring on a host
                      with a different filesystem layout.
                      Example: --map-root /var/www:/srv/www

Fresh-VPS recovery:
  --bootstrap         Install required system packages (apt), start
                      services (postgresql, nginx), install pm2, then
                      run the restore. Requires root. Use with --map-root
                      if paths need to change. Implies --yes.

Content verification:
  --verify            After extraction, sanity-check every component:
                      pg_restore --list on postgres dumps, sqlite
                      integrity_check, mysql applied to a scratch DB,
                      tar -t on pm2/extras, nginx -t on configs. Exits
                      non-zero if any check fails.
  --verify-latest     Find the most recent archive on the remote, download
                      just it, verify its content (same checks as --verify),
                      then clean up. Designed for weekly cron jobs that
                      confirm restores still work without staging files.
                      Implies --yes.

Dry run:
  --plan              Show what would happen during the restore without
                      actually doing anything. Lists every component, the
                      file/database it would touch, and what prompts would
                      appear. Useful before destructive operations on a
                      live system. Implies --yes. Exits 0 always.

Without --archive, lists available remote backups (optionally filtered by
--from/--to) and prompts.
With --yes, skips all confirmation prompts (dangerous).
Supports SSH, FTP, and rclone transfers (uses config.transfer).
`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const so = [], se = [];
    child.stdout.on("data", (b) => so.push(b));
    child.stderr.on("data", (b) => se.push(b));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(so).toString("utf8"),
      stderr: Buffer.concat(se).toString("utf8"),
    }));
  });
}

async function runChecked(label, cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${label} failed: ${r.stderr || r.stdout}`);
  return r;
}

function sshArgs(cfg, extra = []) {
  return [
    "-i", cfg.ssh.identityFile,
    "-p", String(cfg.ssh.port || 22),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    ...extra,
  ];
}

async function loadConfig(p) {
  const cfg = JSON.parse(await fs.readFile(p, "utf8"));
  if (!cfg.ssh?.identityFile) cfg.ssh.identityFile = "/root/.ssh/aegis_ed25519";
  return cfg;
}

async function confirm(prompt, autoYes) {
  if (autoYes) return true;
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
  rl.close();
  return ans === "y" || ans === "yes";
}

// ---------- SSH list / download ------------------------------------------

async function listRemoteSsh(cfg) {
  // Glob all four extensions; sort newest-first; drop the sidecar files.
  const r = await run("ssh", [
    ...sshArgs(cfg),
    `${cfg.ssh.user}@${cfg.ssh.host}`,
    `ls -1t ${cfg.ssh.remoteDir}/aegis-*.tar.zst ${cfg.ssh.remoteDir}/aegis-*.tar.gz ${cfg.ssh.remoteDir}/aegis-*.tar.zst.age ${cfg.ssh.remoteDir}/aegis-*.tar.gz.age 2>/dev/null | sed 's|.*/||' | grep -v '\.sha256$'`,
  ]);
  if (r.code !== 0) throw new Error(`ssh list failed: ${r.stderr}`);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function downloadSsh(cfg, name, dest) {
  const remote = `${cfg.ssh.user}@${cfg.ssh.host}:${cfg.ssh.remoteDir}/${name}`;
  await fs.mkdir(dest, { recursive: true });
  await runChecked("rsync download", "rsync", [
    "-e", `ssh ${sshArgs(cfg).map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
    "-a", "--progress",
    remote,
    `${dest}/`,
  ]);
  try {
    await runChecked("rsync sha", "rsync", [
      "-e", `ssh ${sshArgs(cfg).map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
      "-a",
      `${remote}.sha256`,
      `${dest}/`,
    ]);
  } catch { /* optional */ }
}

// ---------- FTP list / download ------------------------------------------

async function listRemoteFtp(cfg) {
  const f = cfg.ftp;
  const proto = f.secure ? "ftps" : "ftp";
  const base = `${proto}://${f.host}:${f.port || 21}${f.remoteDir}/`;
  const r = await run("curl", [
    "--silent", "--show-error",
    "--connect-timeout", "15", "--max-time", "60",
    "-u", `${f.user}:${f.password}`,
    ...(f.secure ? ["--ssl"] : []),
    "--list-only", base,
  ]);
  if (r.code !== 0) throw new Error(`ftp list failed: ${r.stderr || r.stdout}`);
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => /^aegis-.*\.tar\.(zst|gz)(\.age)?$/.test(s))
    .sort().reverse(); // newest first
}

async function downloadFtp(cfg, name, dest) {
  const f = cfg.ftp;
  const proto = f.secure ? "ftps" : "ftp";
  const base = `${proto}://${f.host}:${f.port || 21}${f.remoteDir}/`;
  await fs.mkdir(dest, { recursive: true });
  await runChecked("curl download", "curl", [
    "--silent", "--show-error",
    "--connect-timeout", "15",
    "--max-time", "3600",
    "-u", `${f.user}:${f.password}`,
    ...(f.secure ? ["--ssl"] : []),
    "-o", path.join(dest, name),
    `${base}${encodeURIComponent(name)}`,
  ]);
  try {
    await runChecked("curl sha", "curl", [
      "--silent", "--show-error",
      "-u", `${f.user}:${f.password}`,
      ...(f.secure ? ["--ssl"] : []),
      "-o", path.join(dest, `${name}.sha256`),
      `${base}${encodeURIComponent(name)}.sha256`,
    ]);
  } catch { /* optional */ }
}

// ---------- Path rewriting (--map-root) ---------------------------------

function applyMapRoot(items, mappings) {
  if (!mappings || mappings.length === 0) return items;
  const pathFields = ["source", "cwd", "script", "path"];
  return items.map((item) => {
    const out = { ...item };
    for (const m of mappings) {
      const colon = m.indexOf(":");
      if (colon < 0) continue;
      const oldRoot = m.slice(0, colon);
      const newRoot = m.slice(colon + 1);
      for (const k of pathFields) {
        if (typeof out[k] === "string" && out[k].startsWith(oldRoot)) {
          out[k] = newRoot + out[k].slice(oldRoot.length);
        }
      }
    }
    return out;
  });
}

// ---------- Fresh-VPS bootstrap (--bootstrap) ---------------------------

async function bootstrapSystem(cfg, manifest) {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("--bootstrap requires root (for apt-get install). Run with sudo.");
  }

  // Detect distro (best-effort; defaults to debian-family).
  let distro = "debian";
  try {
    const osr = await fs.readFile("/etc/os-release", "utf8");
    const id = osr.match(/^ID=([^\s]+)/m)?.[1]?.replace(/"/g, "");
    if (id === "ubuntu") distro = "ubuntu";
    else if (id === "debian") distro = "debian";
  } catch {}

  const kinds = new Set(manifest.items.map((i) => i.kind));

  // Base packages always needed (including tools that download/install use).
  const packages = [
    "tar", "zstd", "ca-certificates", "curl", "gnupg",
    "openssh-client", "rsync", "util-linux", "sqlite3",
    "postgresql-client",
  ];
  if (kinds.has("postgres")) packages.push("postgresql");
  if (kinds.has("mysql")) {
    packages.push("default-mysql-client");
    packages.push("mariadb-server");
  }
  if (kinds.has("redis")) {
    packages.push("redis-server");
    packages.push("redis-tools");
  }
  if (kinds.has("mongodb")) {
    packages.push("mongodb-clients"); // mongodump / mongorestore / mongosh
    // mongod itself is intentionally not installed — pulling in the official
    // MongoDB server requires adding their APT repo. The user can do that
    // themselves if they're restoring onto a fresh machine.
  }
  if (kinds.has("nginx")) packages.push("nginx");

  console.log(`\n[bootstrap] Detected: ${distro}`);
  console.log(`[bootstrap] apt install: ${packages.join(" ")}`);
  await runChecked("apt update", "apt-get", ["update", "-qq"]);
  await runChecked("apt install", "apt-get", ["install", "-y", "-qq", ...packages]);

  // Node.js — install via NodeSource 20.x if missing.
  let needPm2 = kinds.has("pm2");
  try {
    await run("node", ["--version"]);
  } catch {
    console.log("[bootstrap] Installing Node.js 20.x via NodeSource");
    const setup = `curl -fsSL https://deb.nodesource.com/setup_20.x | bash -`;
    await runChecked("node setup", "bash", ["-c", setup]);
    await runChecked("node install", "apt-get", ["install", "-y", "-qq", "nodejs"]);
  }

  // pm2 — install globally if needed and missing.
  if (needPm2) {
    try {
      await run("pm2", ["--version"]);
    } catch {
      console.log("[bootstrap] Installing pm2 globally");
      await runChecked("pm2 install", "npm", ["install", "-g", "pm2"]);
    }
  }

  // Enable + start services whose data is in the manifest.
  if (kinds.has("postgres")) {
    console.log("[bootstrap] systemctl enable --now postgresql");
    await run("systemctl", ["enable", "--now", "postgresql"]);
    // Ensure the configured role exists (restores won't re-create owners).
    const pgUser = cfg.postgres?.user;
    if (pgUser && pgUser !== "postgres") {
      const r = await run("sudo", ["-u", "postgres", "psql", "-tAc",
        `SELECT 1 FROM pg_roles WHERE rolname='${pgUser}'`]);
      if (!r.stdout.trim()) {
        console.log(`[bootstrap] Creating postgres role '${pgUser}'`);
        await run("sudo", ["-u", "postgres", "psql", "-c",
          `CREATE ROLE "${pgUser}" WITH LOGIN SUPERUSER`]);
      }
    }
  }
  if (kinds.has("nginx")) {
    console.log("[bootstrap] systemctl enable --now nginx");
    await run("systemctl", ["enable", "--now", "nginx"]);
  }
  if (kinds.has("mysql")) {
    console.log("[bootstrap] systemctl enable --now mariadb");
    await run("systemctl", ["enable", "--now", "mariadb"]);
  }
  if (kinds.has("redis")) {
    console.log("[bootstrap] systemctl enable --now redis-server");
    await run("systemctl", ["enable", "--now", "redis-server"]);
  }

  console.log("[bootstrap] System setup complete.\n");
}

async function startPm2Apps(cfg, manifest, stagingDir) {
  const items = manifest.items.filter((i) => i.kind === "pm2");
  if (items.length === 0) return;
  for (const item of items) {
    console.log(`\n[pm2] ${item.name} -> ${item.cwd}`);
    // If node_modules was excluded (the default), reinstall before starting.
    const hasPkg = existsSync(path.join(item.cwd, "package.json"));
    const hasLock = existsSync(path.join(item.cwd, "package-lock.json"))
      || existsSync(path.join(item.cwd, "yarn.lock"))
      || existsSync(path.join(item.cwd, "pnpm-lock.yaml"));
    if (hasPkg && hasLock) {
      console.log(`[pm2]   npm ci (node_modules was excluded from archive)`);
      const r = await run("npm", ["ci", "--no-audit", "--no-fund"],
        { cwd: item.cwd });
      if (r.code !== 0) {
        console.log(`[pm2]   npm ci failed (exit ${r.code}) — continuing; pm2 may still work`);
      }
    }
    const args = ["start", item.script, "--name", item.name];
    if (item.instances && item.instances > 1) args.push("-i", String(item.instances));
    args.push("--update-env");
    await runChecked("pm2 start", "pm2", args, { cwd: item.cwd });
  }
  console.log("\n[pm2] pm2 save (persist across reboots)");
  await run("pm2", ["save"]);
}



async function listRemote(cfg) {
  const transfer = cfg.transfer || "ssh";
  if (transfer === "ftp") return listRemoteFtp(cfg);
  if (transfer === "rclone") {
    const { listRclone } = await import("./lib/rclone.mjs");
    return listRclone(cfg);
  }
  return listRemoteSsh(cfg);
}

async function download(cfg, name, dest) {
  const transfer = cfg.transfer || "ssh";
  if (transfer === "ftp") return downloadFtp(cfg, name, dest);
  if (transfer === "rclone") {
    const { downloadRclone } = await import("./lib/rclone.mjs");
    return downloadRclone(cfg, name, dest);
  }
  return downloadSsh(cfg, name, dest);
}

// ---------- Verify / Extract ---------------------------------------------

async function verifySha(archivePath) {
  const shaPath = archivePath + ".sha256";
  if (!existsSync(shaPath)) { console.log("No .sha256 sidecar — skipping verification"); return; }
  const expected = (await fs.readFile(shaPath, "utf8")).split(/\s+/)[0];
  const r = await run("sha256sum", [archivePath]);
  const actual = r.stdout.split(/\s+/)[0];
  if (actual === expected) console.log(`SHA256 OK: ${actual}`);
  else throw new Error(`SHA256 mismatch! expected=${expected} actual=${actual}`);
}

async function extract(archivePath, dest) {
  await fs.mkdir(dest, { recursive: true });
  const cmd = `tar -xf '${archivePath}' -C '${dest}'`;
  let r = await run("sh", ["-c", cmd]);
  if (r.code !== 0) {
    const cmd2 = `zstd -dc '${archivePath}' | tar -xf - -C '${dest}'`;
    const r2 = await run("sh", ["-c", cmd2]);
    if (r2.code !== 0) throw new Error(`extract failed: ${r2.stderr || r.stderr}`);
  }
}

async function readManifest(extractDir) {
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const staging = entries.find((e) => e.isDirectory());
  if (!staging) throw new Error("no staging dir found in extract");
  const mf = path.join(extractDir, staging.name, "manifest.json");
  return { stagingDir: path.join(extractDir, staging.name), manifestPath: mf, manifest: JSON.parse(await fs.readFile(mf, "utf8")) };
}

// ---------- Verify (--verify) ---------------------------------------------

// Per-kind checks run after extract, before the actual restore. Each check
// returns null on success, or a short error string on failure. The whole
// function is best-effort: missing binaries (e.g. mysql not installed on a
// postgres-only host) downgrade a check to "skipped" rather than fail.
async function verifyExtractedArchive(stagingDir, manifest, cfg) {
  const results = [];
  const report = (kind, name, status, detail = "") => {
    const tag = status === "ok" ? C.green("✓") : status === "skipped" ? C.gray("○") : C.red("✗");
    console.log(`  ${tag} ${kind.padEnd(8)} ${name}${detail ? `  — ${detail}` : ""}`);
    results.push({ kind, name, status, detail });
  };

  console.log("\n[verify] Checking archive contents…");

  // Postgres: pg_restore --list reads the TOC. -Fc dumps (the format we use)
  // will return a non-empty listing or fail.
  const pgDir = path.join(stagingDir, "postgres");
  if (existsSync(pgDir)) {
    for (const item of manifest.items.filter((i) => i.kind === "postgres")) {
      const file = path.join(pgDir, item.file);
      if (!existsSync(file)) { report("postgres", item.database, "fail", "missing file"); continue; }
      const r = await run("pg_restore", ["-l", file]);
      if (r.code !== 0) { report("postgres", item.database, "fail", (r.stderr || "").split("\n")[0]); continue; }
      const tocLines = r.stdout.split("\n").filter((l) => /^\d+;/.test(l)).length;
      if (tocLines === 0) { report("postgres", item.database, "fail", "empty TOC"); continue; }
      report("postgres", item.database, "ok", `${tocLines} TOC entries`);
    }
  }

  // SQLite: re-run integrity_check on each .sqlitebak.
  const sqDir = path.join(stagingDir, "sqlite");
  if (existsSync(sqDir)) {
    for (const item of manifest.items.filter((i) => i.kind === "sqlite")) {
      const file = path.join(sqDir, item.file);
      if (!existsSync(file)) { report("sqlite", item.source || item.file, "fail", "missing file"); continue; }
      const r = await run("sqlite3", [file, "PRAGMA integrity_check;"]);
      if (r.code !== 0) { report("sqlite", item.source || item.file, "fail", (r.stderr || "").split("\n")[0]); continue; }
      if (!/^ok/i.test(r.stdout.trim())) { report("sqlite", item.source || item.file, "fail", r.stdout.trim()); continue; }
      report("sqlite", item.source || item.file, "ok");
    }
  }

  // MySQL: try to apply the dump into a scratch database, then drop it.
  // Skipped if `mysql` binary isn't on this host.
  const myDir = path.join(stagingDir, "mysql");
  const mysqlBin = cfg.mysql?.bin || "mysql";
  if (existsSync(myDir)) {
    const whichMysql = await run("sh", ["-c", `command -v ${mysqlBin} >/dev/null 2>&1`]);
    if (whichMysql.code !== 0) {
      report("mysql", "(skipped — mysql binary not installed)", "skipped");
    } else {
      for (const item of manifest.items.filter((i) => i.kind === "mysql")) {
        const file = path.join(myDir, item.file);
        if (!existsSync(file)) { report("mysql", item.database, "fail", "missing file"); continue; }
        const scratch = `aegis_verify_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const mysqlArgs = (extra) => [
          "-h", cfg.mysql?.host || "localhost",
          "-P", String(cfg.mysql?.port || 3306),
          "-u", cfg.mysql?.user || "root",
          cfg.mysql?.password ? `-p${cfg.mysql.password}` : "",
          ...extra,
        ].filter(Boolean);
        await run(mysqlBin, mysqlArgs(["-e", `CREATE DATABASE \`${scratch}\`;`]));
        const r = await new Promise((resolve) => {
          const child = spawn(mysqlBin, mysqlArgs([scratch]), { stdio: ["pipe", "ignore", "pipe"] });
          const se = [];
          child.stderr.on("data", (b) => se.push(b));
          const stream = createReadStream(file);
          stream.on("error", (e) => resolve({ code: 1, stderr: e.message }));
          stream.pipe(child.stdin);
          child.on("close", (code) => resolve({ code, stderr: Buffer.concat(se).toString("utf8") }));
          child.on("error", (e) => resolve({ code: 1, stderr: e.message }));
        });
        await run(mysqlBin, mysqlArgs(["-e", `DROP DATABASE IF EXISTS \`${scratch}\`;`]));
        if (r.code !== 0) {
          report("mysql", item.database, "fail", (r.stderr || "").split("\n")[0] || `exit ${r.code}`);
        } else {
          report("mysql", item.database, "ok", "applied to scratch DB");
        }
      }
    }
  }

  // pm2 + extras: list contents of each .tar.zst to prove it's a valid tar.
  for (const sub of ["pm2", "extras"]) {
    const dir = path.join(stagingDir, sub);
    if (!existsSync(dir)) continue;
    for (const item of manifest.items.filter((i) => i.kind === sub)) {
      const file = path.join(dir, item.file);
      if (!existsSync(file)) { report(sub, item.name || item.path, "fail", "missing file"); continue; }
      // Decompress to stdout, pipe to tar -t. Count entries.
      const cmd = `zstd -dc '${file}' | tar -t 2>/dev/null | wc -l`;
      const r = await run("sh", ["-c", cmd]);
      if (r.code !== 0) { report(sub, item.name || item.path, "fail", (r.stderr || "").split("\n")[0]); continue; }
      const n = parseInt(r.stdout.trim(), 10) || 0;
      if (n === 0) { report(sub, item.name || item.path, "fail", "tar empty"); continue; }
      report(sub, item.name || item.path, "ok", `${n} files`);
    }
  }

  // nginx: parse each config file with nginx -t (best-effort; needs nginx).
  const ngDir = path.join(stagingDir, "nginx");
  if (existsSync(ngDir)) {
    const whichNginx = await run("sh", ["-c", "command -v nginx >/dev/null 2>&1"]);
    if (whichNginx.code !== 0) {
      report("nginx", "(skipped — nginx binary not installed)", "skipped");
    } else {
      // Use the embedded mainConfig if present, otherwise just spot-check syntax.
      const conf = path.join(ngDir, "nginx.conf");
      if (existsSync(conf)) {
        const r = await run("nginx", ["-t", "-c", conf, "-p", ngDir + "/"]);
        if (r.code === 0) report("nginx", "nginx.conf", "ok");
        else report("nginx", "nginx.conf", "fail", (r.stderr || "").split("\n").slice(-2).join(" "));
      } else {
        report("nginx", "(no nginx.conf in archive — skipping syntax check)", "skipped");
      }
    }
  }

  const passed = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  console.log(`[verify] ${passed} passed, ${failed} failed, ${skipped} skipped`);
  return { passed, failed, skipped, results };
}

// ---------- Restore plan (--plan) -----------------------------------------

// Prints what `restore.mjs` would do for this archive without touching
// anything. Useful before destructive ops on a live box. Exits 0 always.
async function planRestore(stagingDir, manifest, cfg) {
  console.log(`\n[plan] Restore plan for ${manifest.items.length} item(s) in ${manifest.generatedAt}`);
  console.log(`       Generated on host: ${manifest.hostname || "(unknown)"}\n`);

  // Group items by kind for compact display.
  const byKind = {};
  for (const it of manifest.items) {
    (byKind[it.kind] ||= []).push(it);
  }
  const order = ["postgres", "mysql", "redis", "mongodb", "sqlite", "pm2", "nginx", "extras", "aegis"];
  for (const kind of order) {
    const list = byKind[kind];
    if (!list || list.length === 0) continue;
    console.log(`── ${kind} (${list.length}) ──`);
    for (const it of list) {
      const sz = it.bytes ? ` (${(it.bytes / 1024).toFixed(0)} KiB)` : "";
      let dest, action;
      switch (kind) {
        case "postgres":
        case "mysql":
        case "mongodb":
          dest = `${kind}://${it.host || cfg[kind]?.host || "localhost"}/${it.database}`;
          action = "DROP+RECREATE database, then restore from " + it.file;
          break;
        case "redis":
          dest = `${cfg.redis?.path || "/var/lib/redis"}/dump.rdb`;
          action = "stop redis-server, copy dump.rdb, restart, verify PING";
          break;
        case "sqlite":
          dest = it.source;
          action = "overwrite in place";
          break;
        case "pm2":
          dest = it.cwd;
          action = `extract ${it.file} over ${it.cwd}${it.instances > 1 ? `, then npm ci + pm2 start --name ${it.name} -i ${it.instances}` : `, then npm ci + pm2 start --name ${it.name}`}`;
          break;
        case "nginx":
          dest = "/etc/nginx/...";
          action = "copy site configs back, then nginx -t";
          break;
        case "extras":
          dest = it.path;
          action = `extract ${it.file} over ${it.path}`;
          break;
        case "aegis":
          dest = "(TOOL_DIR, ssh key, state, cron)";
          action = `extract ${it.file} → config.json + ssh key + state.json + crontab`;
          break;
      }
      const label = kind === "pm2" ? it.name : kind === "extras" ? it.path : (it.database || it.source || it.file);
      console.log(`  ${(label || "?").padEnd(28)} ${dest}`);
      console.log(`    action: ${action}${sz}`);
      if (kind === "postgres" || kind === "mysql" || kind === "mongodb" ||
          kind === "sqlite" || kind === "pm2" || kind === "nginx" || kind === "extras" ||
          kind === "redis" || kind === "aegis") {
        console.log(`    prompt: y/N (one per item)`);
      }
    }
    console.log();
  }

  // Cross-cutting notes.
  if (cfg.transfer === "ssh" || cfg.transfer === "ftp" || cfg.transfer === "rclone") {
    console.log(`[plan] Transfer: ${cfg.transfer} → ${cfg.ssh?.host || cfg.ftp?.host || cfg.rclone?.remote}`);
  }
  if (manifest.items.some((i) => i.kind === "aegis")) {
    console.log(`[plan] Note: archive contains an Aegis state bundle — restoring will overwrite your config.json, ssh key, and state.json on this host.`);
  }
  console.log(`\n[plan] No changes were made. Re-run without --plan to actually restore.`);
}

// ---------- Restore individual components --------------------------------

async function restorePostgres(cfg, stagingDir, items, autoYes) {
  const pgDir = path.join(stagingDir, "postgres");
  if (!existsSync(pgDir)) return;
  for (const item of items.filter((i) => i.kind === "postgres")) {
    const file = path.join(pgDir, item.file);
    if (!existsSync(file)) continue;
    const db = item.database;
    console.log(`\n[postgres] would restore '${db}' from ${item.file}`);
    if (!await confirm(`  Drop+recreate '${db}' and restore? `, autoYes)) continue;
    await run("psql", [
      "-h", cfg.postgres?.host || "/var/run/postgresql",
      "-p", String(cfg.postgres?.port || 5432),
      "-U", cfg.postgres?.user || "postgres",
      "-d", "postgres",
      "-c", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}' AND pid<>pg_backend_pid();`,
    ]);
    await run("dropdb", [
      "-h", cfg.postgres?.host || "/var/run/postgresql",
      "-p", String(cfg.postgres?.port || 5432),
      "-U", cfg.postgres?.user || "postgres",
      "--if-exists", db,
    ]);
    const owner = item.owner || cfg.postgres?.user || "postgres";
    await run("createdb", [
      "-h", cfg.postgres?.host || "/var/run/postgresql",
      "-p", String(cfg.postgres?.port || 5432),
      "-U", cfg.postgres?.user || "postgres",
      "-O", owner, db,
    ]);
    await runChecked("pg_restore", "pg_restore", [
      "-h", cfg.postgres?.host || "/var/run/postgresql",
      "-p", String(cfg.postgres?.port || 5432),
      "-U", cfg.postgres?.user || "postgres",
      "-d", db,
      "--no-owner", "--no-privileges",
      file,
    ]);
    console.log(`  restored ${db}`);
  }
}

async function restoreMysql(cfg, stagingDir, items, autoYes) {
  const myDir = path.join(stagingDir, "mysql");
  if (!existsSync(myDir)) return;
  const mysqlBin = cfg.mysql?.bin || "mysql";
  const mysqlArgs = (extra = []) => [
    "-h", cfg.mysql?.host || "localhost",
    "-P", String(cfg.mysql?.port || 3306),
    "-u", cfg.mysql?.user || "root",
    cfg.mysql?.password ? `-p${cfg.mysql.password}` : "",
    ...extra,
  ].filter(Boolean);
  for (const item of items.filter((i) => i.kind === "mysql")) {
    const file = path.join(myDir, item.file);
    if (!existsSync(file)) continue;
    const db = item.database;
    console.log(`\n[mysql] would restore '${db}' from ${item.file}`);
    if (!await confirm(`  Drop+recreate '${db}' and restore? `, autoYes)) continue;
    // Drop and recreate.
    await run(mysqlBin, mysqlArgs(["-e", `DROP DATABASE IF EXISTS \`${db}\`;`]));
    await run(mysqlBin, mysqlArgs(["-e", `CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4;`]));
    // Stream dump into `mysql <db>` via stdin.
    await new Promise((resolve, reject) => {
      const child = spawn(mysqlBin, mysqlArgs([db]), { stdio: ["pipe", "ignore", "pipe"] });
      const se = [];
      child.stderr.on("data", (b) => se.push(b));
      const stream = createReadStream(file);
      stream.on("error", reject);
      stream.pipe(child.stdin);
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`mysql restore ${db} failed: ${Buffer.concat(se).toString("utf8")}`));
      });
    });
    console.log(`  restored ${db}`);
  }
}

async function restoreRedis(cfg, stagingDir, items, autoYes) {
  const rdDir = path.join(stagingDir, "redis");
  if (!existsSync(rdDir)) return;
  const bin = cfg.redis?.bin || "redis-cli";
  for (const item of items.filter((i) => i.kind === "redis")) {
    const src = path.join(rdDir, item.file);
    if (!existsSync(src)) continue;
    // Default data dir: /var/lib/redis. Honor cfg.redis.path if set.
    const dataDir = cfg.redis?.path || "/var/lib/redis";
    const dest = path.join(dataDir, "dump.rdb");
    console.log(`\n[redis] would restore dump.rdb to ${dest}`);
    if (!await confirm(`  Stop redis-server, copy ${path.basename(src)} → ${dest}, start redis-server? `, autoYes)) continue;

    // Try to stop redis (best-effort — may not be a systemd service).
    const svc = await run("sh", ["-c", "command -v systemctl >/dev/null && systemctl stop redis-server 2>&1 || true"]);
    if (svc.code !== 0) { /* continue anyway */ }
    // Brief pause to let redis flush.
    await new Promise((r) => setTimeout(r, 1000));
    await fs.mkdir(dataDir, { recursive: true });
    await fs.copyFile(src, dest);
    try { await fs.chmod(dest, 0o660); } catch {}
    // Restart.
    await run("sh", ["-c", "systemctl start redis-server 2>&1 || true"]);
    // Verify.
    const ping = await run(bin, ["-h", cfg.redis?.host || "localhost", "-p", String(cfg.redis?.port || 6379), "PING"]);
    if (ping.code === 0 && /PONG/i.test(ping.stdout)) {
      console.log(`  restored ${dest} (PONG received)`);
    } else {
      console.log(`  restored ${dest} (couldn't ping — redis may not be running)`);
    }
  }
}

async function restoreMongodb(cfg, stagingDir, items, autoYes) {
  const mgDir = path.join(stagingDir, "mongodb");
  if (!existsSync(mgDir)) return;
  const restoreBin = cfg.mongodb?.restoreBin || "mongorestore";
  for (const item of items.filter((i) => i.kind === "mongodb")) {
    const file = path.join(mgDir, item.file);
    if (!existsSync(file)) continue;
    const dbLabel = item.database || "all databases";
    console.log(`\n[mongodb] would restore ${dbLabel} from ${item.file}`);
    if (!await confirm(`  Drop+recreate and restore? `, autoYes)) continue;
    const args = [
      "--host", cfg.mongodb?.host || "localhost",
      "--port", String(cfg.mongodb?.port || 27017),
      "--archive", file,
      "--gzip",
      "--drop", // drop each collection before re-inserting
    ];
    if (cfg.mongodb?.user) {
      args.push("-u", cfg.mongodb.user);
      if (cfg.mongodb.password) args.push("-p", cfg.mongodb.password);
      if (cfg.mongodb.authSource) args.push("--authenticationDatabase", cfg.mongodb.authSource);
    }
    if (cfg.mongodb?.db) args.push("-d", cfg.mongodb.db);
    await runChecked(`mongorestore[${dbLabel}]`, restoreBin, args);
    console.log(`  restored ${dbLabel}`);
  }
}

async function restoreSqlite(stagingDir, items, autoYes) {
  const sqDir = path.join(stagingDir, "sqlite");
  if (!existsSync(sqDir)) return;
  for (const item of items.filter((i) => i.kind === "sqlite")) {
    const src = path.join(sqDir, item.file);
    if (!existsSync(src)) continue;
    const dest = item.source;
    console.log(`\n[sqlite] would restore ${dest}`);
    if (!await confirm(`  Overwrite ${dest}? `, autoYes)) continue;
    await fs.copyFile(src, dest);
    console.log(`  restored ${dest}`);
  }
}

async function restoreAegis(stagingDir, items, autoYes) {
  const agDir = path.join(stagingDir, "aegis");
  if (!existsSync(agDir)) return;
  for (const item of items.filter((i) => i.kind === "aegis")) {
    const archive = path.join(agDir, item.file);
    if (!existsSync(archive)) continue;
    console.log(`\n[aegis] would restore Aegis's own state: ${item.files?.join(", ") || "(contents unknown)"}`);
    if (!await confirm(`  Extract state bundle to original locations? `, autoYes)) continue;

    // Decompress into a temp dir.
    const work = path.join(os.tmpdir(), `aegis-state-restore-${Date.now()}`);
    await fs.mkdir(work, { recursive: true });
    const cmd = `zstd -dc '${archive}' | tar -xf - -C '${work}'`;
    let r = await run("sh", ["-c", cmd]);
    if (r.code !== 0) {
      await runChecked("tar aegis", "tar", ["--zstd", "-xf", archive, "-C", work]);
    }

    // Restore each known file.
    if (existsSync(path.join(work, "config.json"))) {
      // Honor cfg.ssh.identityFile as a hint? No — write to a safe default
      // and tell the user. The config has the SSH path inside it.
      const target = path.join(TOOL_DIR, "config.json");
      await fs.copyFile(path.join(work, "config.json"), target);
      try { await fs.chmod(target, 0o600); } catch {}
      console.log(`  config.json -> ${target}`);
    }
    if (existsSync(path.join(work, "ssh_key"))) {
      // Read identityFile from the restored config if available, else default.
      let target = "/root/.ssh/aegis_ed25519";
      try {
        const cfg = JSON.parse(await fs.readFile(path.join(work, "config.json"), "utf8"));
        if (cfg.ssh?.identityFile) target = cfg.ssh.identityFile;
      } catch {}
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(work, "ssh_key"), target);
      try { await fs.chmod(target, 0o600); } catch {}
      if (existsSync(path.join(work, "ssh_key.pub"))) {
        await fs.copyFile(path.join(work, "ssh_key.pub"), `${target}.pub`);
        try { await fs.chmod(`${target}.pub`, 0o644); } catch {}
      }
      console.log(`  ssh_key -> ${target}`);
    }
    if (existsSync(path.join(work, "state.json"))) {
      const target = path.join(TOOL_DIR, "state.json");
      await fs.copyFile(path.join(work, "state.json"), target);
      try { await fs.chmod(target, 0o600); } catch {}
      console.log(`  state.json -> ${target}`);
    }
    if (existsSync(path.join(work, "crontab.txt"))) {
      const crontab = await fs.readFile(path.join(work, "crontab.txt"), "utf8");
      console.log(`  crontab line:`);
      console.log(`    ${crontab.trim()}`);
      if (await confirm(`  Install this cron entry? `, autoYes)) {
        // Append to current crontab.
        const cur = await run("bash", ["-c", "crontab -l 2>/dev/null"]);
        const merged = (cur.stdout || "") + "\n" + crontab;
        await run("bash", ["-c", `printf %s "${merged.replace(/"/g, '\\"')}" | crontab -`]);
        console.log(`  cron entry installed`);
      }
    }

    try { await fs.rm(work, { recursive: true, force: true }); } catch {}
    console.log(`  aegis state restored`);
  }
}

async function restorePm2(stagingDir, items, autoYes) {
  const pmDir = path.join(stagingDir, "pm2");
  if (!existsSync(pmDir)) return;
  for (const item of items.filter((i) => i.kind === "pm2")) {
    const archive = path.join(pmDir, item.file);
    if (!existsSync(archive)) continue;
    console.log(`\n[pm2] would restore ${item.name} into ${item.cwd}`);
    if (!await confirm(`  Extract ${item.file} over ${item.cwd}? `, autoYes)) continue;
    const dest = path.dirname(item.cwd);
    const cmd = `zstd -dc '${archive}' | tar -xf - -C '${dest}'`;
    let r = await run("sh", ["-c", cmd]);
    if (r.code !== 0) {
      await runChecked("tar pm2", "tar", ["--zstd", "-xf", archive, "-C", dest]);
    }
    console.log(`  restored ${item.cwd}`);
  }
}

async function restoreNginx(stagingDir, items, autoYes) {
  const ngDir = path.join(stagingDir, "nginx");
  if (!existsSync(ngDir)) return;
  console.log(`\n[nginx] would restore from ${ngDir}`);
  if (!await confirm(`  Copy nginx configs back? `, autoYes)) return;
  for (const [key, src] of [
    ["sites-available", "/etc/nginx/sites-available"],
    ["sites-enabled", "/etc/nginx/sites-enabled"],
    ["conf.d", "/etc/nginx/conf.d"],
  ]) {
    const dir = path.join(ngDir, key);
    if (!existsSync(dir)) continue;
    const files = await fs.readdir(dir);
    for (const f of files) {
      const dst = path.join(src, f);
      await fs.copyFile(path.join(dir, f), dst);
      console.log(`  ${dst}`);
    }
  }
  if (existsSync(path.join(ngDir, "nginx.conf"))) {
    await fs.copyFile(path.join(ngDir, "nginx.conf"), "/etc/nginx/nginx.conf");
    console.log(`  /etc/nginx/nginx.conf`);
  }
  await run("nginx", ["-t"]);
}

// ---------- Main ---------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printHelp(); return; }
  if (!existsSync(opts.config)) {
    console.error(`No config at ${opts.config}. Run \`node aegis.mjs --setup\` to create one.`);
    process.exit(2);
  }
  const cfg = await loadConfig(opts.config);
  const transfer = cfg.transfer || "ssh";
  const label = transfer === "ftp"
    ? `ftp://${cfg.ftp.user}@${cfg.ftp.host}:${cfg.ftp.port}${cfg.ftp.remoteDir}`
    : `${cfg.ssh.user}@${cfg.ssh.host}:${cfg.ssh.remoteDir}`;

  // Parse date filters up front so errors surface early.
  const fromDate = parseDateFilter(opts.from, "from");
  const toDate = parseDateFilter(opts.to, "to");

  if (opts.list || !opts.archive) {
    let list = await listRemote(cfg);
    // Apply --to (lower bound) and --from (upper bound) date filters.
    if (fromDate || toDate) {
      const filtered = list.filter((name) => {
        const m = name.match(/aegis-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
        if (!m) return false;
        const ts = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
        if (Number.isNaN(ts)) return false;
        if (fromDate && ts > fromDate.getTime()) return false;
        if (toDate && ts <= toDate.getTime()) return false;
        return true;
      });
      list = filtered;
    }
    const filterDesc = [
      fromDate ? `from ${fromDate.toISOString()}` : null,
      toDate ? `to ${toDate.toISOString()}` : null,
    ].filter(Boolean).join(", ");
    console.log(`Available remote backups${filterDesc ? ` (${filterDesc})` : ""} at ${label}:`);
    if (list.length === 0) console.log("  (none)");
    else list.forEach((n, i) => console.log(`  ${String(i + 1).padStart(3)}. ${n}`));
    if (opts.list) return;

    // If --from was given without --archive, automatically pick the most
    // recent backup that satisfies the filter (i.e., the newest one whose
    // timestamp is at or before --from).
    if (!opts.archive && fromDate && list.length > 0) {
      opts.archive = list[0]; // list is newest-first
      console.log(`Auto-selected: ${opts.archive}`);
    } else if (!opts.archive) {
      const rl = createInterface({ input: stdin, output: stdout });
      const ans = (await rl.question("\nArchive # to restore (or 'q'): ")).trim();
      rl.close();
      if (!ans || ans === "q") return;
      const idx = parseInt(ans, 10) - 1;
      if (!list[idx]) { console.log("invalid selection"); return; }
      opts.archive = list[idx];
    }
  }

  // --verify-latest: pick newest archive automatically, then verify it.
  // Designed for the weekly cron that comes with install-cron.sh --verify.
  if (opts.verifyLatest) {
    opts.verify = true;
    opts.yes = true;
    if (!opts.archive) {
      const list = await listRemote(cfg);
      if (list.length === 0) {
        console.error("[verify-latest] No archives found on remote.");
        process.exit(1);
      }
      opts.archive = list[0]; // newest-first
      console.log(`[verify-latest] Auto-selected: ${opts.archive}`);
    }
  }

  console.log(`Restoring ${opts.archive} via ${transfer}`);
  const work = path.join(os.tmpdir(), `vps-restore-${Date.now()}`);
  await download(cfg, opts.archive, work);
  let archivePath = path.join(work, opts.archive);
  await verifySha(archivePath);

  // If the archive is age-encrypted, decrypt it now. The downloaded .sha256
  // is of the encrypted bytes — once decrypted, we just trust age's AEAD
  // (the sha256 was already verified on the encrypted form, which proves
  // the ciphertext wasn't tampered with).
  const { isEncrypted, decryptFile, hasDecryptConfig } = await import("./lib/encrypt.mjs");
  if (await isEncrypted(archivePath)) {
    if (!hasDecryptConfig(cfg)) {
      throw new Error(
        `archive is age-encrypted but config has no encryption.identityFiles or encryption.passphrase — cannot restore`,
      );
    }
    console.log("Decrypting age-encrypted archive…");
    const decrypted = archivePath.replace(/\.age$/, "");
    await decryptFile(archivePath, decrypted, {
      identityFiles: cfg.encryption?.identityFiles || [],
      passphrase: cfg.encryption?.passphrase || false,
    });
    archivePath = decrypted;
    console.log(`  decrypted → ${path.basename(archivePath)}`);
  }

  const extractDir = path.join(work, "extract");
  await extract(archivePath, extractDir);
  const { stagingDir, manifest } = await readManifest(extractDir);
  console.log(`Manifest: ${manifest.items.length} item(s), generated ${manifest.generatedAt}`);

  // Optional content verification (--verify). Runs after extraction but
  // before any actual restore. Exits non-zero on any failed check, so it
  // doubles as a CI gate: "a backup you've never restored is a hope".
  if (opts.verify) {
    const v = await verifyExtractedArchive(stagingDir, manifest, cfg);
    if (v.failed > 0) {
      console.error(`[verify] ${v.failed} check(s) failed — aborting before restore.`);
      process.exit(1);
    }
    // If the user only wanted verification, stop here.
    if (opts.downloadOnly || opts.verifyLatest) {
      console.log(opts.verifyLatest
        ? `[verify-latest] ${opts.archive}: OK (${v.passed} checks passed)`
        : `Extracted to ${stagingDir}`);
      if (opts.verifyLatest) {
        // Clean up the downloaded archive so we don't waste disk between
        // weekly cron runs.
        try { await rm(work, { recursive: true, force: true }); } catch {}
      }
      return;
    }
  } else if (opts.downloadOnly) {
    console.log(`Extracted to ${stagingDir}`);
    return;
  }

  // --plan: print what would happen, exit 0. Always wins over restore.
  if (opts.plan) {
    await planRestore(stagingDir, manifest, cfg);
    return;
  }

  // --bootstrap implies --yes (no prompts during fresh-VPS recovery).
  if (opts.bootstrap) opts.yes = true;

  // Rewrite manifest paths for cross-host restores.
  let items = manifest.items;
  if (opts.mapRoot.length > 0) {
    items = applyMapRoot(items, opts.mapRoot);
    console.log(`[map-root] Applied ${opts.mapRoot.length} mapping(s)`);
  }

  // Install system packages + start services before the restore.
  if (opts.bootstrap) {
    await bootstrapSystem(cfg, manifest);
  }

  await restorePostgres(cfg, stagingDir, items, opts.yes);
  await restoreMysql(cfg, stagingDir, items, opts.yes);
  await restoreRedis(cfg, stagingDir, items, opts.yes);
  await restoreMongodb(cfg, stagingDir, items, opts.yes);
  await restoreSqlite(stagingDir, items, opts.yes);
  await restorePm2(stagingDir, items, opts.yes);
  await restoreNginx(stagingDir, items, opts.yes);
  await restoreAegis(stagingDir, items, opts.yes);

  if (opts.bootstrap) {
    await startPm2Apps(cfg, manifest, stagingDir);
  }

  console.log("\nDone. Review and restart affected services as needed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
