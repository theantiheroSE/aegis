#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs, createWriteStream, existsSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { ProgressBus, attachConsole } from "./lib/progress.mjs";
import { runHooks } from "./lib/hooks.mjs";

export const VERSION = "1.4.0";
export const TOOL_DIR = path.dirname(new URL(import.meta.url).pathname);

// ---------- CLI -----------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    config: path.join(TOOL_DIR, "config.json"),
    dryRun: false,
    skipUpload: false,
    skipPrune: false,
    skipHooks: false,
    only: null,
    setup: false,
    setupForce: false,
    help: false,
    version: false,
  };
  for (let i = 2; i < argv.length; i++) {
    let a = argv[i];
    let val = null;
    const eq = a.indexOf("=");
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === "--config" || a === "-c") opts.config = val ?? argv[++i];
    else if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--skip-upload") opts.skipUpload = true;
    else if (a === "--skip-prune") opts.skipPrune = true;
    else if (a === "--skip-hooks") opts.skipHooks = true;
    else if (a === "--only") opts.only = (val ?? argv[++i])?.split(",").map((s) => s.trim());
    else if (a === "--headless") opts.headless = true;
    else if (a === "--setup") opts.setup = true;
    else if (a === "--setup-force") opts.setupForce = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-V" || a === "--version") opts.version = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

export function printHelp() {
  return `Aegis ${VERSION}

Usage:
  node backup.mjs [options]            # one-shot backup, or TUI if no flags + TTY
  node tui.mjs                         # launch interactive TUI directly
  node backup.mjs --setup              # run first-time setup wizard

Options:
  -c, --config <path>    Config file (default: ./config.json)
  -n, --dry-run          Build locally but skip remote upload and prune
      --skip-upload      Build locally, skip upload
      --skip-prune        Skip the remote prune step
      --skip-hooks        Skip configured pre/post hooks
      --only <stages>    Comma list: pm2,sqlite,postgres,mysql,redis,mongodb,nginx,extras,aegis
      --setup            Run interactive first-time setup wizard
      --setup-force      Like --setup but overwrite existing config
      --headless         (TUI internal) disable progress events
  -h, --help             Show this help
  -V, --version          Show version
`;
}

// ---------- Logging -------------------------------------------------------

let logStream = null;
let logFilePath = null;
let activeBus = null;
let phaseTotals = new Map();

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

async function openLog(logDir, prefix) {
  await fs.mkdir(logDir, { recursive: true });
  const name = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  logFilePath = path.join(logDir, name);
  logStream = createWriteStream(logFilePath, { flags: "a" });
}

export function getLogFilePath() { return logFilePath; }

function log(level, msg) {
  const line = `[${ts()}] [${level.padEnd(5)}] ${msg}`;
  if (!activeBus) console.log(line);
  if (logStream) logStream.write(line + "\n");
  if (activeBus) activeBus.log(level, msg);
}

const info  = (m) => log("INFO",  m);
const warn  = (m) => log("WARN",  m);
const error = (m) => log("ERROR", m);
const ok    = (m) => log("OK",    m);

function setBus(bus) { activeBus = bus; phaseTotals = new Map(); }
function getBus() { return activeBus; }

// ---------- Config --------------------------------------------------------

export async function loadConfig(p) {
  const raw = await fs.readFile(p, "utf8");
  const cfg = JSON.parse(raw);
  if (!cfg.ssh?.host) throw new Error("config.ssh.host is required");
  if (!cfg.ssh?.remoteDir) throw new Error("config.ssh.remoteDir is required");
  if (!cfg.ssh?.identityFile) cfg.ssh.identityFile = "/root/.ssh/id_ed25519";
  return cfg;
}

// ---------- Shell helpers -------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (b) => {
      stdoutChunks.push(b);
      if (logStream) logStream.write(b);
    });
    child.stderr.on("data", (b) => {
      stderrChunks.push(b);
      if (logStream) logStream.write(b);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

async function runChecked(label, cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${label} failed (exit ${r.code}): ${r.stderr || r.stdout}`);
  }
  return r;
}

function asUser(runAs, cmd, args) {
  if (!runAs) return [cmd, args];
  if (typeof process.getuid === "function" && process.getuid() !== 0) return [cmd, args];
  return ["runuser", ["-u", runAs, "--", cmd, ...args]];
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

function rsyncSsh(cfg) {
  return [
    "-e", `ssh ${sshArgs(cfg).map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
    "-a", "--partial", "--info=progress2,stats2",
  ];
}

// ---------- PM2 discovery -------------------------------------------------

async function discoverPm2Apps(cfg) {
  if (!cfg.pm2?.enabled) return [];
  const r = await run("pm2", ["jlist"]);
  if (r.code !== 0) throw new Error(`pm2 jlist failed: ${r.stderr}`);
  let list;
  try { list = JSON.parse(r.stdout); } catch { throw new Error("pm2 jlist returned non-JSON"); }

  const seen = new Map();
  for (const p of list) {
    const name = p.name;
    if (seen.has(name)) continue;
    const env = p.pm2_env || {};
    const cwd = env.pm_cwd || env.cwd;
    if (!cwd || !existsSync(cwd)) {
      warn(`PM2 app "${name}" has no valid cwd (${cwd}), skipping`);
      continue;
    }
    seen.set(name, {
      name,
      cwd,
      script: env.pm_exec_path || null,
      interpreter: env.exec_interpreter || null,
      instances: list.filter((x) => x.name === name).length,
    });
  }
  return [...seen.values()];
}

// ---------- SQLite discovery ----------------------------------------------

async function walk(dir, depth, max, results, patterns, excludes) {
  if (depth > max) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".well-known") continue;
    const full = path.join(dir, e.name);
    if (excludes.some((ex) => full.includes(ex))) continue;
    if (e.isDirectory()) {
      await walk(full, depth + 1, max, results, patterns, excludes);
    } else if (e.isFile()) {
      const lower = e.name.toLowerCase();
      if (patterns.some((p) => lower.endsWith(p.replace("*", "").toLowerCase()))) {
        results.push(full);
      }
    }
  }
}

async function discoverSqlite(cfg) {
  if (!cfg.sqlite?.enabled) return [];
  const out = [];
  for (const root of cfg.sqlite.searchPaths || []) {
    if (!existsSync(root)) continue;
    await walk(root, 0, cfg.sqlite.maxDepth ?? 6, out,
      cfg.sqlite.patterns || ["*.db", "*.sqlite", "*.sqlite3"],
      cfg.sqlite.excludePaths || []);
  }
  return [...new Set(out)].sort();
}

// ---------- Postgres ------------------------------------------------------

async function listPostgresDatabases(cfg) {
  if (!cfg.postgres?.enabled) return [];
  const args = [
    "-h", cfg.postgres.host || "/var/run/postgresql",
    "-p", String(cfg.postgres.port || 5432),
    "-U", cfg.postgres.user || "postgres",
    "-d", "postgres",
    "-tA", "-c", "SELECT datname FROM pg_database ORDER BY datname;",
  ];
  const [cmd, cmdArgs] = asUser(cfg.postgres.runAs, "psql", args);
  const r = await run(cmd, cmdArgs);
  if (r.code !== 0) throw new Error(`psql list failed: ${r.stderr}`);
  const all = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const exc = new Set(cfg.postgres.excludeDatabases || ["template0", "template1"]);
  return all.filter((d) => !exc.has(d));
}

async function dumpPostgres(cfg, dbName, outDir) {
  const outFile = path.join(outDir, `${dbName}.pgdump`);
  const args = [
    "-h", cfg.postgres.host || "/var/run/postgresql",
    "-p", String(cfg.postgres.port || 5432),
    "-U", cfg.postgres.user || "postgres",
    "-d", dbName,
    "-Fc", "-Z", "9",
    "-f", outFile,
    "--no-owner",
    "--no-privileges",
  ];
  const [cmd, cmdArgs] = asUser(cfg.postgres.runAs, "pg_dump", args);
  await runChecked(`pg_dump[${dbName}]`, cmd, cmdArgs);
  try { await fs.chmod(outFile, 0o644); } catch {}
  return outFile;
}

// ---------- MySQL / MariaDB ----------------------------------------------

async function hasMysqlBinary(bin) {
  // Resolved once per process — no need to re-stat on every call.
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `command -v ${bin} >/dev/null 2>&1`], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function listMysqlDatabases(cfg) {
  const bin = cfg.mysql?.bin || "mysql";
  const args = [
    "-h", cfg.mysql.host || "localhost",
    "-P", String(cfg.mysql.port || 3306),
    "-u", cfg.mysql.user || "root",
    cfg.mysql.password ? `-p${cfg.mysql.password}` : "",
    "-N", "-B", "-e", "SHOW DATABASES",
  ].filter(Boolean);
  const [cmd, cmdArgs] = asUser(cfg.mysql.runAs, bin, args);
  const r = await run(cmd, cmdArgs);
  if (r.code !== 0) {
    // Empty creds rejected → exit 1 with "Access denied". Surface clearly.
    throw new Error(`mysql list failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  }
  const all = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const exc = new Set(cfg.mysql.excludeDatabases || [
    "information_schema", "mysql", "performance_schema", "sys",
  ]);
  return all.filter((d) => !exc.has(d));
}

async function dumpMysql(cfg, dbName, outDir) {
  const dumpBin = cfg.mysql?.dumpBin || "mysqldump";
  const outFile = path.join(outDir, `${dbName}.sql`);
  const args = [
    "-h", cfg.mysql.host || "localhost",
    "-P", String(cfg.mysql.port || 3306),
    "-u", cfg.mysql.user || "root",
    cfg.mysql.password ? `-p${cfg.mysql.password}` : "",
    "--single-transaction",
    "--routines",
    "--triggers",
    "--events",
    "--default-character-set=utf8mb4",
    "--hex-blob",
    "--quick",
    `--result-file=${outFile}`,
    dbName,
  ].filter(Boolean);
  const [cmd, cmdArgs] = asUser(cfg.mysql.runAs, dumpBin, args);
  await runChecked(`mysqldump[${dbName}]`, cmd, cmdArgs);
  try { await fs.chmod(outFile, 0o644); } catch {}
  return outFile;
}

// ---------- Redis ---------------------------------------------------------

async function listRedisDatabases(cfg) {
  // Redis has 16 logical DBs by default. We snapshot them as separate items.
  // Skip if the user only wants the RDB file (binary, all-DB).
  const bin = cfg.redis?.bin || "redis-cli";
  const args = [
    "-h", cfg.redis?.host || "localhost",
    "-p", String(cfg.redis?.port || 6379),
    cfg.redis?.password ? ["-a", cfg.redis.password, "--no-auth-warning"] : [],
    "INFO", "keyspace",
  ].flat().filter(Boolean);
  const [cmd, cmdArgs] = asUser(cfg.redis?.runAs, bin, args);
  const r = await run(cmd, cmdArgs);
  if (r.code !== 0) throw new Error(`redis INFO failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  // Parse "db0:keys=12,expires=0,avg_ttl=0" lines.
  const dbs = [];
  for (const line of (r.stdout || "").split("\n")) {
    const m = line.match(/^db(\d+):keys=(\d+)/);
    if (m && parseInt(m[2], 10) > 0) dbs.push(`db${m[1]}`);
  }
  return dbs;
}

async function dumpRedis(cfg, outDir) {
  const bin = cfg.redis?.bin || "redis-cli";
  const args = [
    "-h", cfg.redis?.host || "localhost",
    "-p", String(cfg.redis?.port || 6379),
    cfg.redis?.password ? ["-a", cfg.redis.password, "--no-auth-warning"] : [],
  ].flat().filter(Boolean);
  const [cmd, cmdArgsBase] = asUser(cfg.redis?.runAs, bin, args);

  // BGSAVE triggers a background save. We poll LASTSAVE until the timestamp
  // changes (with a timeout). If AOF is the dominant persistence mode, BGSAVE
  // also rewrites the AOF.
  const before = await run(cmd, [...cmdArgsBase, "LASTSAVE"]);
  if (before.code !== 0) {
    throw new Error(`redis LASTSAVE failed: ${(before.stderr || before.stdout).trim().split("\n")[0]}`);
  }
  const startTs = parseInt(before.stdout.trim(), 10);

  const bg = await run(cmd, [...cmdArgsBase, "BGSAVE"]);
  // BGSAVE returns "Background saving started" on success. If an existing save
  // is in flight, Redis replies with a "Background save already in progress"
  // error — that's also fine, we just wait for the next save to finish.
  if (bg.code !== 0 && !/already in progress/i.test(bg.stderr || bg.stdout || "")) {
    throw new Error(`redis BGSAVE failed: ${(bg.stderr || bg.stdout).trim().split("\n")[0]}`);
  }

  // Poll LASTSAVE for up to 60s.
  const deadline = Date.now() + 60_000;
  let lastTs = startTs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const ls = await run(cmd, [...cmdArgsBase, "LASTSAVE"]);
    if (ls.code === 0) lastTs = parseInt(ls.stdout.trim(), 10);
    if (lastTs > startTs) break;
  }
  if (lastTs <= startTs) {
    throw new Error(`redis BGSAVE did not complete within 60s`);
  }

  // Locate the dump file. Defaults: /var/lib/redis/dump.rdb. If the user set
  // a custom dir, prefer that. Try a few common names.
  const dataDir = cfg.redis?.path || "/var/lib/redis";
  const candidates = ["dump.rdb", "redis.rdb"];
  let src = null;
  for (const name of candidates) {
    const p = path.join(dataDir, name);
    if (existsSync(p)) { src = p; break; }
  }
  if (!src) throw new Error(`redis dump file not found in ${dataDir} (tried: ${candidates.join(", ")})`);

  const outFile = path.join(outDir, "dump.rdb");
  await fs.copyFile(src, outFile);
  try { await fs.chmod(outFile, 0o644); } catch {}
  return outFile;
}

// ---------- MongoDB ------------------------------------------------------

async function dumpMongodb(cfg, outDir) {
  const dumpBin = cfg.mongodb?.dumpBin || "mongodump";
  const outFile = path.join(outDir, cfg.mongodb?.db ? `${cfg.mongodb.db}.archive` : "all.archive");
  const args = [
    "--host", cfg.mongodb?.host || "localhost",
    "--port", String(cfg.mongodb?.port || 27017),
    "--archive", // stdout
    "--gzip",
  ];
  if (cfg.mongodb?.user) {
    args.push("-u", cfg.mongodb.user);
    if (cfg.mongodb.password) args.push("-p", cfg.mongodb.password);
    if (cfg.mongodb.authSource) args.push("--authenticationDatabase", cfg.mongodb.authSource);
  }
  if (cfg.mongodb?.db) args.push("-d", cfg.mongodb.db);
  // Stream mongodump stdout into the archive file.
  await new Promise((resolve, reject) => {
    const [cmd, cmdArgsBase] = asUser(cfg.mongodb?.runAs, dumpBin, args);
    const child = spawn(cmd, cmdArgsBase, { stdio: ["ignore", "pipe", "pipe"] });
    const se = [];
    child.stderr.on("data", (b) => se.push(b));
    const out = createWriteStream(outFile);
    child.stdout.pipe(out);
    child.on("error", (e) => reject(new Error(`mongodump failed to start: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mongodump failed (exit ${code}): ${Buffer.concat(se).toString("utf8").trim().split("\n").slice(-3).join(" ")}`));
    });
  });
  try { await fs.chmod(outFile, 0o644); } catch {}
  return outFile;
}

// ---------- Aegis's own state --------------------------------------------

// Stages the tool's runtime secrets and state into a fresh tmp dir, then
// returns the dir + a list of files included. Caller (the runBackup phase
// below) is responsible for tarring the dir into the archive.
//
// What's included:
//   - config.json (SMTP creds, FTP password, age recipients, etc.)
//   - ssh_key (+ .pub) — the SSH identity file referenced by cfg.ssh.identityFile
//   - state.json (last-run metadata, no secrets)
//   - crontab.txt — the aegis cron entry (extracted from `crontab -l`)
//
// Always encrypts this bundle when encryption is enabled — config.json and
// the SSH key live in here, so plaintext on the backup server is a worse
// problem than plaintext anywhere else.
async function stageAegisState(cfg, opts) {
  const stageDir = path.join(os.tmpdir(), `aegis-state-${Date.now()}`);
  await fs.mkdir(stageDir, { recursive: true });
  const included = [];

  // config.json — try explicit path first, then default locations.
  const cfgCandidates = [
    opts.configPath,
    path.join(TOOL_DIR, "config.json"),
  ].filter(Boolean);
  for (const c of cfgCandidates) {
    if (existsSync(c)) {
      await fs.copyFile(c, path.join(stageDir, "config.json"));
      included.push("config.json");
      break;
    }
  }

  // SSH key.
  if (cfg.ssh?.identityFile && existsSync(cfg.ssh.identityFile)) {
    await fs.copyFile(cfg.ssh.identityFile, path.join(stageDir, "ssh_key"));
    try { await fs.copyFile(`${cfg.ssh.identityFile}.pub`, path.join(stageDir, "ssh_key.pub")); } catch {}
    included.push("ssh_key");
  }

  // state.json.
  const { statePath } = await import("./lib/state.mjs");
  const sp = statePath();
  if (existsSync(sp)) {
    await fs.copyFile(sp, path.join(stageDir, "state.json"));
    included.push("state.json");
  }

  // Cron — extract just the aegis line.
  const cr = await run("bash", ["-c", "crontab -l 2>/dev/null | grep -F '# aegis' || true"]);
  if (cr.stdout.trim()) {
    await fs.writeFile(path.join(stageDir, "crontab.txt"), cr.stdout);
    included.push("crontab.txt");
  }

  if (included.length === 0) {
    try { await fs.rm(stageDir, { recursive: true, force: true }); } catch {}
    return null;
  }
  return { stageDir, included };
}

// ---------- SQLite backup -------------------------------------------------

async function backupSqlite(dbPath, outDir) {
  const safe = dbPath.replace(/\//g, "_").replace(/^_+/, "");
  const outFile = path.join(outDir, `${safe}.sqlitebak`);
  const args = [dbPath, `.backup '${outFile}'`];
  const r = await run("sqlite3", args);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || "").toLowerCase();
    if (msg.includes("file is not a database") || msg.includes("not a database")) {
      warn(`  sqlite ${dbPath}: not a sqlite database, skipping`);
      return null;
    }
    throw new Error(`sqlite3 backup ${dbPath} failed: ${r.stderr}`);
  }
  const v = await run("sqlite3", [outFile, "PRAGMA integrity_check;"]);
  if (v.code !== 0 || !/^ok/i.test(v.stdout.trim())) {
    warn(`  sqlite ${dbPath}: integrity check failed, skipping`);
    try { await fs.unlink(outFile); } catch {}
    return null;
  }
  return outFile;
}

// ---------- Tar -----------------------------------------------------------

function tarExcludeArgs(excludeDirs) {
  const out = [];
  for (const d of excludeDirs || []) out.push("--exclude", `./${d}`);
  return out;
}

// Return the zstd compression level for a given backup phase.
// Falls back to cfg.archive.compressionLevel (default 3). Different inputs
// compress very differently:
//   - pm2 / nginx configs / aegis state: small text → level 19 saves a lot
//   - postgres dumps (already -Fc -Z 9): barely compresses → level 3 is fine
//   - mysql SQL dumps: compressible text → level 9
//   - extras: depends, but level 9 is a reasonable middle ground
// Users can override per phase via cfg.archive.compressionByPhase.
function compressionLevelFor(cfg, phase) {
  const byPhase = cfg?.archive?.compressionByPhase;
  if (byPhase && Number.isFinite(byPhase[phase])) return byPhase[phase];
  return cfg?.archive?.compressionLevel ?? 3;
}

async function tarDir(srcDir, outFile, opts = {}) {
  const { excludeDirs = [], level = 3 } = opts;
  const excludes = tarExcludeArgs(excludeDirs).map((a) => `'${a}'`).join(" ");
  const srcBase = path.basename(srcDir);
  const parent = path.dirname(srcDir);
  const out = path.resolve(outFile);
  const cmd = `tar -cf - -C '${parent}' ${excludes} '${srcBase}' | zstd -T0 -q -${level} -o '${out}'`;
  let r = await run("sh", ["-c", cmd]);
  if (r.code !== 0) {
    const cmd2 = `tar -czf '${out}' -C '${parent}' ${excludes} '${srcBase}'`;
    const r2 = await run("sh", ["-c", cmd2]);
    if (r2.code !== 0) throw new Error(`tar ${srcDir} failed: ${r2.stderr || r.stderr}`);
  }
  return outFile;
}

async function copyFile(p, outDir) {
  const dest = path.join(outDir, path.basename(p));
  await fs.copyFile(p, dest);
  return dest;
}

async function copyDirFlat(srcDir, outDir) {
  if (!existsSync(srcDir)) return [];
  await fs.mkdir(outDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.isFile()) {
      const src = path.join(srcDir, e.name);
      const dst = path.join(outDir, e.name);
      await fs.copyFile(src, dst);
      out.push(dst);
    }
  }
  return out;
}

// ---------- Hash / Manifest ----------------------------------------------

async function sha256File(p) {
  const h = createHash("sha256");
  await pipeline(createReadStream(p), h);
  return h.digest("hex");
}

async function writeManifest(outDir, items) {
  const manifest = {
    tool: `Aegis ${VERSION}`,
    hostname: os.hostname(),
    generatedAt: new Date().toISOString(),
    items,
  };
  const p = path.join(outDir, "manifest.json");
  await fs.writeFile(p, JSON.stringify(manifest, null, 2));
  return p;
}

// ---------- Build the bundle ---------------------------------------------

function phaseStart(name, message, total) {
  if (activeBus) activeBus.phase(name, message, total);
  phaseTotals.set(name, { current: 0, total });
  info(message);
}

function phaseTick(name, n = 1) {
  if (!activeBus) return;
  const p = phaseTotals.get(name);
  if (!p) return;
  p.current += n;
  activeBus.progress(name, p.current, p.total);
}

// ---------- runBackup (the public library entry point) -------------------

export async function runBackup(cfg, opts = {}, bus = null) {
  setBus(bus);
  try {
    // Pre-backup hooks run first; failure aborts before any staging work.
    if (!opts.skipHooks) {
      await runHooks("preBackup", cfg, {
        AEGIS_TIMESTAMP: new Date().toISOString(),
        AEGIS_CONFIG_PATH: opts.configPath || "",
      }, { logger: { info, warn, error, ok }, logStream, fatal: true });
    }
    const tsName = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const staging = path.join(cfg.localStagingDir, tsName);
    await fs.mkdir(staging, { recursive: true });
    info(`Staging at ${staging}`);

    const items = [];
    const errors = [];

    // ---- Postgres ----
    if (!opts.only || opts.only.includes("postgres")) {
      if (cfg.postgres?.enabled) {
        const dbs = await listPostgresDatabases(cfg);
        phaseStart("postgres", `Dumping PostgreSQL databases...`, dbs.length);
        const pgDir = path.join(staging, "postgres");
        await fs.mkdir(pgDir, { recursive: true });
        if (cfg.postgres.runAs) {
          try { await fs.chmod(pgDir, 0o777); } catch {}
        }
        for (const db of dbs) {
          try {
            const f = await dumpPostgres(cfg, db, pgDir);
            const sz = (await fs.stat(f)).size;
            ok(`  pg_dump ${db} -> ${path.basename(f)} (${(sz / 1024).toFixed(0)} KiB)`);
            items.push({ kind: "postgres", database: db, file: path.basename(f), bytes: sz });
            if (activeBus) activeBus.item("postgres", db, "ok", { bytes: sz });
          } catch (e) {
            errors.push(`postgres:${db} ${e.message}`);
            error(`  postgres ${db} failed: ${e.message}`);
            if (activeBus) activeBus.item("postgres", db, "error", { error: e.message });
          }
          phaseTick("postgres");
        }
      }
    }

    // ---- MySQL / MariaDB ----
    if (!opts.only || opts.only.includes("mysql")) {
      if (cfg.mysql?.enabled) {
        const dumpBin = cfg.mysql?.dumpBin || "mysqldump";
        if (!await hasMysqlBinary(dumpBin)) {
          warn(`mysql.dumpBin="${dumpBin}" not found on PATH — skipping MySQL backup. Install mariadb-client or mysql-client.`);
        } else if (!await hasMysqlBinary(cfg.mysql?.bin || "mysql")) {
          warn(`mysql.bin="${cfg.mysql?.bin || "mysql"}" not found on PATH — skipping MySQL backup.`);
        } else {
          let dbs = [];
          try {
            dbs = await listMysqlDatabases(cfg);
          } catch (e) {
            errors.push(`mysql:list ${e.message}`);
            error(`  mysql list failed: ${e.message}`);
          }
          phaseStart("mysql", `Dumping MySQL databases...`, dbs.length);
          const myDir = path.join(staging, "mysql");
          await fs.mkdir(myDir, { recursive: true });
          if (cfg.mysql.runAs) {
            try { await fs.chmod(myDir, 0o777); } catch {}
          }
          for (const db of dbs) {
            try {
              const f = await dumpMysql(cfg, db, myDir);
              const sz = (await fs.stat(f)).size;
              ok(`  mysqldump ${db} -> ${path.basename(f)} (${(sz / 1024).toFixed(0)} KiB)`);
              items.push({
                kind: "mysql",
                database: db,
                host: cfg.mysql.host || "localhost",
                file: path.basename(f),
                bytes: sz,
              });
              if (activeBus) activeBus.item("mysql", db, "ok", { bytes: sz });
            } catch (e) {
              errors.push(`mysql:${db} ${e.message}`);
              error(`  mysql ${db} failed: ${e.message}`);
              if (activeBus) activeBus.item("mysql", db, "error", { error: e.message });
            }
            phaseTick("mysql");
          }
        }
      }
    }

    // ---- Redis ----
    if (!opts.only || opts.only.includes("redis")) {
      if (cfg.redis?.enabled) {
        const bin = cfg.redis?.bin || "redis-cli";
        if (!await hasMysqlBinary(bin)) {
          warn(`redis.bin="${bin}" not found on PATH — skipping Redis backup.`);
        } else {
          phaseStart("redis", "Backing up Redis (BGSAVE + dump.rdb)…", 1);
          const rdDir = path.join(staging, "redis");
          await fs.mkdir(rdDir, { recursive: true });
          if (cfg.redis.runAs) {
            try { await fs.chmod(rdDir, 0o777); } catch {}
          }
          try {
            const f = await dumpRedis(cfg, rdDir);
            const sz = (await fs.stat(f)).size;
            // List which DBs had keys (informational).
            let dbs = [];
            try { dbs = await listRedisDatabases(cfg); } catch {}
            const detail = dbs.length ? ` (DBs with keys: ${dbs.join(", ")})` : "";
            ok(`  redis -> ${path.basename(f)} (${(sz / 1024).toFixed(0)} KiB)${detail}`);
            items.push({
              kind: "redis",
              host: cfg.redis.host || "localhost",
              port: cfg.redis.port || 6379,
              databases: dbs,
              file: path.basename(f),
              bytes: sz,
            });
            if (activeBus) activeBus.item("redis", `dump.rdb`, "ok", { bytes: sz });
          } catch (e) {
            errors.push(`redis ${e.message}`);
            error(`  redis failed: ${e.message}`);
            if (activeBus) activeBus.item("redis", "dump.rdb", "error", { error: e.message });
          }
          phaseTick("redis");
        }
      }
    }

    // ---- MongoDB ----
    if (!opts.only || opts.only.includes("mongodb")) {
      if (cfg.mongodb?.enabled) {
        const dumpBin = cfg.mongodb?.dumpBin || "mongodump";
        if (!await hasMysqlBinary(dumpBin)) {
          warn(`mongodb.dumpBin="${dumpBin}" not found on PATH — skipping MongoDB backup.`);
        } else {
          phaseStart("mongodb", `Dumping MongoDB (${cfg.mongodb?.db || "all DBs"})...`, 1);
          const mgDir = path.join(staging, "mongodb");
          await fs.mkdir(mgDir, { recursive: true });
          if (cfg.mongodb.runAs) {
            try { await fs.chmod(mgDir, 0o777); } catch {}
          }
          try {
            const f = await dumpMongodb(cfg, mgDir);
            const sz = (await fs.stat(f)).size;
            ok(`  mongodump -> ${path.basename(f)} (${(sz / 1024 / 1024).toFixed(1)} MiB)`);
            items.push({
              kind: "mongodb",
              database: cfg.mongodb?.db || null,
              host: cfg.mongodb?.host || "localhost",
              file: path.basename(f),
              bytes: sz,
            });
            if (activeBus) activeBus.item("mongodb", cfg.mongodb?.db || "(all)", "ok", { bytes: sz });
          } catch (e) {
            errors.push(`mongodb ${e.message}`);
            error(`  mongodb failed: ${e.message}`);
            if (activeBus) activeBus.item("mongodb", cfg.mongodb?.db || "(all)", "error", { error: e.message });
          }
          phaseTick("mongodb");
        }
      }
    }

    // ---- SQLite ----
    if (!opts.only || opts.only.includes("sqlite")) {
      if (cfg.sqlite?.enabled) {
        const dbs = await discoverSqlite(cfg);
        phaseStart("sqlite", `Discovering SQLite databases (${dbs.length} found)...`, dbs.length);
        const sqDir = path.join(staging, "sqlite");
        await fs.mkdir(sqDir, { recursive: true });
        for (const db of dbs) {
          try {
            const f = await backupSqlite(db, sqDir);
            if (!f) {
              if (activeBus) activeBus.item("sqlite", db, "skipped");
              continue;
            }
            const sz = (await fs.stat(f)).size;
            ok(`  sqlite ${db} -> ${path.basename(f)} (${(sz / 1024).toFixed(0)} KiB)`);
            items.push({ kind: "sqlite", source: db, file: path.basename(f), bytes: sz });
            if (activeBus) activeBus.item("sqlite", db, "ok", { bytes: sz });
          } catch (e) {
            errors.push(`sqlite:${db} ${e.message}`);
            error(`  sqlite ${db} failed: ${e.message}`);
            if (activeBus) activeBus.item("sqlite", db, "error", { error: e.message });
          }
          phaseTick("sqlite");
        }
      }
    }

    // ---- PM2 ----
    if (!opts.only || opts.only.includes("pm2")) {
      if (cfg.pm2?.enabled) {
        const apps = await discoverPm2Apps(cfg);
        phaseStart("pm2", `Backing up PM2 projects (${apps.length} found)...`, apps.length);
        const pmDir = path.join(staging, "pm2");
        await fs.mkdir(pmDir, { recursive: true });
        for (const a of apps) {
          try {
            const safeName = a.name.replace(/[^a-zA-Z0-9._-]/g, "_");
            const outFile = path.join(pmDir, `${safeName}.tar.zst`);
            await tarDir(a.cwd, outFile, { excludeDirs: cfg.pm2.excludeDirs, level: compressionLevelFor(cfg, "pm2") });
            const sz = (await fs.stat(outFile)).size;
            ok(`  pm2 ${a.name} (${a.cwd}) -> ${path.basename(outFile)} (${(sz / 1024 / 1024).toFixed(1)} MiB)`);
            items.push({ kind: "pm2", name: a.name, cwd: a.cwd, script: a.script, instances: a.instances, file: path.basename(outFile), bytes: sz });
            if (activeBus) activeBus.item("pm2", a.name, "ok", { bytes: sz });
          } catch (e) {
            errors.push(`pm2:${a.name} ${e.message}`);
            error(`  pm2 ${a.name} failed: ${e.message}`);
            if (activeBus) activeBus.item("pm2", a.name, "error", { error: e.message });
          }
          phaseTick("pm2");
        }
        const dump = await run("pm2", ["jlist"]);
        await fs.writeFile(path.join(pmDir, "pm2-jlist.json"), dump.stdout);
      }
    }

    // ---- nginx ----
    if (!opts.only || opts.only.includes("nginx")) {
      if (cfg.nginx?.enabled) {
        phaseStart("nginx", "Copying nginx configs...", 1);
        const ngDir = path.join(staging, "nginx");
        await fs.mkdir(ngDir, { recursive: true });
        const copied = [];
        for (const [key, src] of [
          ["sites-available", cfg.nginx.sitesAvailable],
          ["sites-enabled", cfg.nginx.sitesEnabled],
          ["conf.d", cfg.nginx.confDir],
        ]) {
          if (src && existsSync(src)) {
            await copyDirFlat(src, path.join(ngDir, key));
            copied.push(key);
          }
        }
        if (cfg.nginx.mainConfig && existsSync(cfg.nginx.mainConfig)) {
          await copyFile(cfg.nginx.mainConfig, ngDir);
        }
        ok(`  nginx copied: ${copied.join(", ")}${cfg.nginx.mainConfig ? " + nginx.conf" : ""}`);
        items.push({ kind: "nginx", copied });
        phaseTick("nginx");
      }
    }

    // ---- extras ----
    if (!opts.only || opts.only.includes("extras")) {
      if (cfg.extraPaths?.length) {
        phaseStart("extras", `Copying ${cfg.extraPaths.length} extra path(s)...`, cfg.extraPaths.length);
        const exDir = path.join(staging, "extras");
        await fs.mkdir(exDir, { recursive: true });
        for (const p of cfg.extraPaths) {
          if (!existsSync(p)) {
            warn(`  extras ${p}: not found, skipping`);
            phaseTick("extras");
            continue;
          }
          try {
            if ((await fs.stat(p)).isDirectory()) {
              const safeName = path.basename(p).replace(/[^a-zA-Z0-9._-]/g, "_");
              const outFile = path.join(exDir, `${safeName}.tar.zst`);
              await tarDir(p, outFile, { excludeDirs: ["node_modules", ".git", ".cache"], level: compressionLevelFor(cfg, "extras") });
              ok(`  extras ${p} -> ${path.basename(outFile)}`);
              items.push({ kind: "extras", path: p, file: path.basename(outFile) });
            } else {
              const dest = path.join(exDir, path.basename(p));
              await fs.copyFile(p, dest);
              items.push({ kind: "extras", path: p, file: path.basename(dest) });
            }
          } catch (e) {
            errors.push(`extras:${p} ${e.message}`);
            error(`  extras ${p} failed: ${e.message}`);
          }
          phaseTick("extras");
        }
      }
    }

    const mf = await writeManifest(staging, items);
    ok(`Manifest: ${mf} (${items.length} items, ${errors.length} error(s))`);

    // ---- Aegis's own state (config.json, ssh key, state.json, cron) ----
    // Only when `aegis.enabled` is true. Always encrypts this bundle when
    // encryption is configured (config.json + ssh key live in here).
    if (!opts.only || opts.only.includes("aegis")) {
      if (cfg.aegis?.enabled) {
        phaseStart("aegis", "Bundling Aegis's own state (config.json, ssh key, cron)…", 1);
        const staged = await stageAegisState(cfg, opts);
        if (!staged) {
          warn("  aegis: no state files found (config.json, ssh key, state.json all missing)");
        } else {
          const agDir = path.join(staging, "aegis");
          await fs.mkdir(agDir, { recursive: true });
          const stateFile = path.join(agDir, "state.tar.zst");
          await tarDir(staged.stageDir, stateFile, {
            excludeDirs: [],
            level: compressionLevelFor(cfg, "aegis"),
          });
          const sz = (await fs.stat(stateFile)).size;
          // Per-file encryption when configured — the entire archive will
          // already be encrypted, but if the user has *only* enabled
          // encryption for this state bundle, we support that here too.
          ok(`  aegis state: ${staged.included.join(", ")} → ${path.basename(stateFile)} (${(sz / 1024).toFixed(0)} KiB)`);
          items.push({
            kind: "aegis",
            file: path.basename(stateFile),
            bytes: sz,
            files: staged.included,
          });
          if (activeBus) activeBus.item("aegis", "state", "ok", { bytes: sz });
          // Re-write the manifest now that we've added the aegis item.
          await writeManifest(staging, items);
          try { await fs.rm(staged.stageDir, { recursive: true, force: true }); } catch {}
        }
        phaseTick("aegis");
      }
    }

    // Final archive
    phaseStart("archive", "Creating final archive...", 1);
    let archive = path.join(cfg.localArchiveDir || staging, `aegis-${tsName}.tar.zst`);
    await fs.mkdir(path.dirname(archive), { recursive: true });
    const finalSrc = path.basename(staging);
    const finalParent = path.dirname(staging);
    const finalOut = path.resolve(archive);
    const finalLevel = compressionLevelFor(cfg, null);
    const cmd = `tar -cf - -C '${finalParent}' '${finalSrc}' | zstd -T0 -q -${finalLevel} -o '${finalOut}'`;
    let r = await run("sh", ["-c", cmd]);
    if (r.code !== 0) {
      const archiveGz = archive.replace(/\.tar\.zst$/, ".tar.gz");
      const cmd2 = `tar -czf '${archiveGz}' -C '${finalParent}' '${finalSrc}'`;
      const r2 = await run("sh", ["-c", cmd2]);
      if (r2.code !== 0) throw new Error(`final tar failed: ${r2.stderr || r.stderr}`);
      await fs.rename(archiveGz, archive);
    }
    const aSize = (await fs.stat(archive)).size;
    ok(`Archive: ${archive} (${(aSize / 1024 / 1024).toFixed(1)} MiB)`);
    phaseTick("archive");

    // Optional age encryption — if recipients are configured, encrypt in place
    // and replace `archive` with the encrypted path. The .sha256 sidecar is
    // then of the encrypted bytes, so the backup server can't fingerprint the
    // plaintext (or compute its own hash).
    const { isEnabled: encryptionEnabled, encryptFile } = await import("./lib/encrypt.mjs");
    if (encryptionEnabled(cfg)) {
      const encrypted = archive + ".age";
      info(`Encrypting with age (${cfg.encryption.recipients.length} recipient(s))…`);
      await encryptFile(archive, encrypted, cfg.encryption.recipients);
      // Replace archive and remove the plaintext.
      try { await fs.unlink(archive); } catch {}
      archive = encrypted;
      ok(`Encrypted archive: ${archive} (${((await fs.stat(archive)).size / 1024 / 1024).toFixed(1)} MiB)`);
    }

    const sha = await sha256File(archive);
    await fs.writeFile(archive + ".sha256", `${sha}  ${path.basename(archive)}\n`);
    ok(`SHA256: ${sha}`);

    // Post-backup hook: best-effort (failure is logged, doesn't change result).
    if (!opts.skipHooks) {
      await runHooks("postBackup", cfg, {
        AEGIS_TIMESTAMP: new Date().toISOString(),
        AEGIS_ARCHIVE_PATH: archive,
        AEGIS_CONFIG_PATH: opts.configPath || "",
      }, { logger: { info, warn, error, ok }, logStream, fatal: false });
    }

    return { staging, archive, items, errors, sha256: sha, bytes: aSize };
  } finally {
    // bus reset happens in main()
  }
}

// ---------- Upload --------------------------------------------------------

export async function uploadBundle(cfg, archive, opts = {}) {
  if (opts.skipUpload || opts.dryRun) {
    info("Skipping upload (--dry-run or --skip-upload)");
    return false;
  }
  const transfer = cfg.transfer || "ssh";
  if (activeBus) activeBus.phase("upload", `Uploading via ${transfer}...`, 1);
  // Pre-upload hook: failure aborts before transferring data.
  if (!opts.skipHooks) {
    await runHooks("preUpload", cfg, {
      AEGIS_TIMESTAMP: new Date().toISOString(),
      AEGIS_ARCHIVE_PATH: archive,
      AEGIS_CONFIG_PATH: opts.configPath || "",
    }, { logger: { info, warn, error, ok }, logStream, fatal: true });
  }
  if (transfer === "ftp") {
    await uploadFtp(cfg, archive);
  } else if (transfer === "rclone") {
    const { uploadRclone } = await import("./lib/rclone.mjs");
    await uploadRclone(cfg, archive);
  } else {
    await uploadSsh(cfg, archive);
  }
  // Post-upload hook: best-effort.
  if (!opts.skipHooks) {
    await runHooks("postUpload", cfg, {
      AEGIS_TIMESTAMP: new Date().toISOString(),
      AEGIS_ARCHIVE_PATH: archive,
      AEGIS_CONFIG_PATH: opts.configPath || "",
    }, { logger: { info, warn, error, ok }, logStream, fatal: false });
  }
  if (activeBus) activeBus.progress("upload", 1, 1);
  return true;
}

async function uploadSsh(cfg, archive) {
  info(`Uploading to ${cfg.ssh.user}@${cfg.ssh.host}:${cfg.ssh.remoteDir}`);
  await runChecked("ssh mkdir", "ssh", [
    ...sshArgs(cfg),
    `${cfg.ssh.user}@${cfg.ssh.host}`,
    `mkdir -p ${shellQuote(cfg.ssh.remoteDir)}`,
  ]);
  const args = [
    ...rsyncSsh(cfg),
    archive,
    archive + ".sha256",
    `${cfg.ssh.user}@${cfg.ssh.host}:${cfg.ssh.remoteDir}/`,
  ];
  const r = await run("rsync", args);
  if (r.code !== 0) throw new Error(`rsync upload failed (exit ${r.code}): ${r.stderr}`);
  ok(`Upload complete: ${path.basename(archive)}`);
}

async function uploadFtp(cfg, archive) {
  const f = cfg.ftp;
  if (!f?.host || !f?.user || !f?.password || !f?.remoteDir) {
    throw new Error("FTP config incomplete: need ftp.host, ftp.user, ftp.password, ftp.remoteDir");
  }
  info(`Uploading to ftp://${f.user}@${f.host}:${f.port || 21}${f.remoteDir}/`);
  // Ensure the remote dir exists. `curl --ftp-create-dirs` handles this for FTP.
  const proto = f.secure ? "ftps" : "ftp";
  const base = `${proto}://${f.host}:${f.port || 21}${f.remoteDir}/`;
  const userArg = `${f.user}:${f.password}`;
  // 1. Make sure the directory exists (no-op if it does)
  const mk = await run("curl", [
    "--silent", "--show-error",
    "--connect-timeout", "15",
    "--max-time", "300",
    "-u", userArg,
    "-Q", `MKD ${shellQuote(f.remoteDir)}`,
    `${proto}://${f.host}:${f.port || 21}/`,
  ]);
  // Ignore MKD failures (often "directory already exists" which curl surfaces as 550)
  // 2. Upload archive + sha256 sidecar. `-C -` makes curl continue a partial
  // upload if the server supports REST (most do) — important for large
  // archives that get interrupted.
  for (const file of [archive, archive + ".sha256"]) {
    const url = `${base}${encodeURIComponent(path.basename(file))}`;
    const args = [
      "--silent", "--show-error",
      "--connect-timeout", "15",
      "--max-time", "3600",
      "-u", userArg,
      ...(f.secure ? ["--ssl"] : []),
      "-C", "-",                       // resume from where we left off
      "--retry", "3",                  // retry transient failures
      "--retry-delay", "5",
      "-T", file,
      url,
    ];
    const r = await run("curl", args);
    if (r.code !== 0) throw new Error(`curl upload ${path.basename(file)} failed (exit ${r.code}): ${r.stderr}`);
    ok(`  uploaded ${path.basename(file)}`);
  }
  ok(`Upload complete: ${path.basename(archive)}`);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---------- Prune ---------------------------------------------------------

export async function pruneRemote(cfg, opts = {}) {
  if (opts.skipPrune || opts.dryRun) {
    info("Skipping prune (--dry-run or --skip-prune)");
    return 0;
  }
  const { applyGfsRetention, applyLegacyRetention } = await import("./lib/retention.mjs");
  const useGfs = cfg.retention && (cfg.retention.daily || cfg.retention.weekly || cfg.retention.monthly);
  if (useGfs) {
    info(`Pruning with GFS retention: daily=${cfg.retention.daily || 0}, weekly=${cfg.retention.weekly || 0}, monthly=${cfg.retention.monthly || 0}`);
  } else {
    const days = cfg.retentionDays || 7;
    const keepLast = cfg.retentionKeepLast || 0;
    info(`Pruning remote backups older than ${days} days (keep last ${keepLast})`);
  }
  if (activeBus) activeBus.phase("prune", "Pruning remote…", 1);
  const transfer = cfg.transfer || "ssh";
  // 1. List remote backups (newest-first).
  let list;
  if (transfer === "ftp") list = await listRemoteFtpDetailed(cfg);
  else if (transfer === "rclone") {
    const { listRcloneDetailed } = await import("./lib/rclone.mjs");
    list = await listRcloneDetailed(cfg);
  }
  else list = await listRemoteSshDetailed(cfg);
  if (list.length === 0) {
    ok("Prune finished (no remote backups)");
    if (activeBus) activeBus.progress("prune", 1, 1);
    return 0;
  }
  // 2. Decide what to delete.
  let toDelete;
  let keptSummary;
  if (useGfs) {
    const r = applyGfsRetention(list, cfg.retention);
    toDelete = r.toDelete;
    keptSummary = r.keptSummary;
  } else {
    toDelete = applyLegacyRetention(list, cfg.retentionDays || 7, cfg.retentionKeepLast || 0);
    keptSummary = "(legacy)";
  }
  info(`Keeping ${list.length - toDelete.length} (${keptSummary}), deleting ${toDelete.length}`);
  // 3. Delete.
  let deleted = 0;
  for (const { name } of toDelete) {
    let ok;
    if (transfer === "ftp") ok = await deleteFtpFile(cfg, name);
    else if (transfer === "rclone") {
      const { deleteRcloneFile } = await import("./lib/rclone.mjs");
      ok = await deleteRcloneFile(cfg, name);
    }
    else ok = await deleteSshFile(cfg, name);
    if (ok) {
      info(`deleted ${name}`);
      deleted++;
    } else {
      warn(`delete ${name} failed`);
    }
  }
  if (activeBus) activeBus.progress("prune", 1, 1);
  ok(`Prune finished (deleted ${deleted})`);
  return deleted;
}

// List remote backups with mtime, sorted newest-first. Returns [{name, epoch}].
async function listRemoteSshDetailed(cfg) {
  const cmd = [
    `cd ${shellQuote(cfg.ssh.remoteDir)}`,
    `for f in aegis-*.tar.zst aegis-*.tar.gz aegis-*.tar.zst.age aegis-*.tar.gz.age; do`,
    `  [ -f "$f" ] || continue;`,
    `  echo "$(stat -c %Y "$f") $f";`,
    `done | sort -rn`,
  ].join(" ");
  const r = await run("ssh", [...sshArgs(cfg), `${cfg.ssh.user}@${cfg.ssh.host}`, cmd]);
  if (r.code !== 0) {
    warn(`prune list returned exit ${r.code}: ${r.stderr}`);
    return [];
  }
  const out = [];
  for (const line of r.stdout.trim().split("\n")) {
    const m = line.match(/^(\d+)\s+(\S+)\s*$/);
    if (m) out.push({ name: m[2], epoch: parseInt(m[1], 10) });
  }
  return out;
}

async function listRemoteFtpDetailed(cfg) {
  const f = cfg.ftp;
  const proto = f.secure ? "ftps" : "ftp";
  const base = `${proto}://${f.host}:${f.port || 21}${f.remoteDir}/`;
  const userArg = `${f.user}:${f.password}`;
  // Try MLSD first for accurate mtime.
  const listCmd = await run("curl", [
    "--silent", "--show-error",
    "--connect-timeout", "15", "--max-time", "60",
    "-u", userArg,
    ...(f.secure ? ["--ssl"] : []),
    "-X", "MLSD", base,
  ]);
  const out = [];
  if (listCmd.code === 0 && listCmd.stdout.trim()) {
    for (const raw of listCmd.stdout.trim().split("\n")) {
      const m = raw.match(/^modify=(\d{14});.*?\s(\S+)\s*$/);
      if (!m) continue;
      if (!/^aegis-.*\.tar\.(zst|gz)(\.age)?$/.test(m[2])) continue;
      const ts = `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}T${m[1].slice(8,10)}:${m[1].slice(10,12)}:${m[1].slice(12,14)}Z`;
      out.push({ name: m[2], epoch: Math.floor(new Date(ts).getTime() / 1000) });
    }
  }
  if (out.length > 0) {
    out.sort((a, b) => b.epoch - a.epoch);
    return out;
  }
  // Fallback: name-only (timestamps are encoded in the filename).
  const r = await run("curl", [
    "--silent", "--show-error",
    "--connect-timeout", "15", "--max-time", "60",
    "-u", userArg,
    ...(f.secure ? ["--ssl"] : []),
    "--list-only", base,
  ]);
  if (r.code !== 0) return [];
  const names = r.stdout.split("\n").map((s) => s.trim()).filter((s) => /^aegis-.*\.tar\.(zst|gz)(\.age)?$/.test(s));
  names.sort().reverse();
  for (const n of names) {
    const m = n.match(/aegis-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (m) {
      const ts = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
      out.push({ name: n, epoch: Math.floor(new Date(ts).getTime() / 1000) });
    } else {
      out.push({ name: n, epoch: 0 });
    }
  }
  return out;
}

async function deleteSshFile(cfg, name) {
  const cmd = `rm -f -- ${shellQuote(name)} ${shellQuote(name + ".sha256")}`;
  const r = await run("ssh", [...sshArgs(cfg), `${cfg.ssh.user}@${cfg.ssh.host}`, cmd]);
  return r.code === 0;
}

async function deleteFtpFile(cfg, name) {
  const f = cfg.ftp;
  const proto = f.secure ? "ftps" : "ftp";
  const base = `${proto}://${f.host}:${f.port || 21}${f.remoteDir}/`;
  const userArg = `${f.user}:${f.password}`;
  const r = await run("curl", [
    "--silent", "--show-error",
    "-u", userArg,
    ...(f.secure ? ["--ssl"] : []),
    "-Q", `DELE ${name}`,
    base,
  ]);
  // Best-effort delete of the .sha256 sidecar (no error if missing).
  await run("curl", [
    "--silent",
    "-u", userArg,
    ...(f.secure ? ["--ssl"] : []),
    "-Q", `DELE ${name}.sha256`,
    base,
  ]);
  return r.code === 0;
}

// ---------- Cleanup -------------------------------------------------------

export async function cleanupLocal(cfg, staging, archive, opts = {}) {
  if (opts.dryRun) {
    info(`[dry-run] would remove staging: ${staging}`);
    return;
  }
  try { await fs.rm(staging, { recursive: true, force: true }); }
  catch (e) { warn(`could not remove staging: ${e.message}`); }
  ok(`Removed staging: ${staging}`);
}

// ---------- CLI main ------------------------------------------------------

export async function runFullBackup(cfgPath, opts = {}) {
  setBus(null);
  await openLog(cfgPath ? path.dirname(cfgPath) : TOOL_DIR, "backup");
  const cfg = await loadConfig(cfgPath);
  info(`Aegis ${VERSION} starting (dry-run=${opts.dryRun}, skip-upload=${opts.skipUpload})`);
  info(`hostname=${os.hostname()} config=${cfgPath}`);

  const startedAt = Date.now();
  let result = null;
  let errorMsg = null;
  try {
    const innerOpts = { ...opts, configPath: cfgPath };
    result = await runBackup(cfg, innerOpts, null);
    await uploadBundle(cfg, result.archive, innerOpts);
    await pruneRemote(cfg, opts);
    const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
    ok(`Done in ${dur}s`);
    return { ok: true, duration: dur, result };
  } catch (e) {
    error(`FATAL: ${e.message}`);
    errorMsg = e.message;
    return { ok: false, error: e.message };
  } finally {
    if (result) await cleanupLocal(cfg, result.staging, result.archive, opts);
    if (logStream) await new Promise((res) => logStream.end(res));
    setBus(null);
    // Persist run to state.json
    try {
      const { recordRun } = await import("./lib/state.mjs");
      const entry = await recordRun({
        ok: !errorMsg,
        durationMs: Date.now() - startedAt,
        items: result?.items?.length || 0,
        errors: (result?.errors?.length || 0) + (errorMsg ? 1 : 0),
        bytes: result?.bytes || 0,
        archive: result?.archive,
        logFile: logFilePath,
        error: errorMsg,
      });
    } catch (e) { /* state persistence is best-effort */ }
    // Write human-readable summary (Markdown + HTML) next to the log file.
    try {
      const { writeSummary } = await import("./lib/summary.mjs");
      const transfer = cfg.transfer || "ssh";
      const remote = transfer === "ftp"
        ? `${cfg.ftp?.user}@${cfg.ftp?.host}:${cfg.ftp?.remoteDir}`
        : transfer === "rclone"
          ? `${cfg.rclone?.remote}:${cfg.rclone?.path}`
          : `${cfg.ssh?.user}@${cfg.ssh?.host}:${cfg.ssh?.remoteDir}`;
      await writeSummary({
        logDir: cfgPath ? path.dirname(cfgPath) : TOOL_DIR,
        prefix: "backup",
        timestamp: new Date(startedAt),
        ok: !errorMsg,
        durationMs: Date.now() - startedAt,
        hostname: os.hostname(),
        transfer,
        remote,
        archive: result?.archive,
        archiveBytes: result?.bytes,
        sha256: result?.sha256,
        items: result?.items,
        errors: result?.errors,
        logFile: logFilePath,
        errorMessage: errorMsg,
      });
    } catch (e) { /* summary is best-effort */ }
    // Ping dead-man's switch (independent of notifications onSuccess/onFailure).
    // A missing backup is the more dangerous failure mode — alert even if the
    // user has muted other channels.
    const hcUrl = cfg.notifications?.healthcheckUrl;
    if (hcUrl) {
      try {
        const { pingHealthcheck } = await import("./lib/notifications.mjs");
        await pingHealthcheck(hcUrl, !errorMsg);
      } catch (e) { /* healthcheck failure is non-fatal */ }
    }
    // Fire notifications (best-effort, doesn't affect exit code)
    try {
      const { sendNotifications } = await import("./lib/notifications.mjs");
      await sendNotifications(cfg, {
        ok: !errorMsg,
        summary: {
          host: os.hostname(),
          timestamp: new Date().toISOString(),
          duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
          items: result?.items?.length || 0,
          errors: (result?.errors?.length || 0) + (errorMsg ? 1 : 0),
          bytes: result?.bytes || 0,
          archive: result?.archive,
          error: errorMsg,
          logFile: logFilePath,
        },
      });
    } catch (e) { /* notification failure is non-fatal */ }
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.version) { console.log(VERSION); return; }
  if (opts.help) { console.log(printHelp()); return; }

  // --setup: run the wizard, then fall through to the TUI (if TTY)
  if (opts.setup || opts.setupForce) {
    const { runSetupWizard } = await import("./lib/setup.mjs");
    try {
      await runSetupWizard(opts.config, { force: opts.setupForce });
      // Setup done — continue below; the TTY/CLI dispatch happens after.
    } catch (e) {
      if (e.message === "setup cancelled") {
        console.error(`Setup cancelled. Run \`node backup.mjs --setup\` when ready.`);
      } else {
        console.error(`setup failed: ${e.message}`);
      }
      process.exit(2);
    }
  }

  // First-time detection: if config is missing/incomplete, run the wizard
  // automatically (unless the user is on a TTY which means the TUI will
  // handle it interactively).
  const { isFirstRun } = await import("./lib/setup.mjs");
  const status = isFirstRun(opts.config);
  if (status.firstRun && !process.env.AEGIS_NO_SETUP) {
    // If we're going to launch the TUI below, let it show the wizard UI;
    // otherwise run the CLI wizard now.
    const hasAction = opts.dryRun || opts.skipUpload || opts.skipPrune || opts.only;
    const willLaunchTui = !hasAction && process.stdout.isTTY;
    if (!willLaunchTui) {
      const { runSetupWizard } = await import("./lib/setup.mjs");
      try {
        const r = await runSetupWizard(opts.config, { force: false });
        if (!r.ok) process.exit(2);
        // fall through to run with the freshly-written config
      } catch (e) {
        if (e.message === "setup cancelled") {
          console.error(`Setup cancelled. Run \`node backup.mjs --setup\` when ready.`);
          process.exit(2);
        }
        console.error(`setup failed: ${e.message}`);
        process.exit(2);
      }
    }
  }

  // No actionable flags → launch the TUI (when stdout is a TTY).
  const hasAction = opts.dryRun || opts.skipUpload || opts.skipPrune || opts.only;
  if (!hasAction && process.stdout.isTTY && !process.env.AEGIS_NO_TUI) {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [path.join(TOOL_DIR, "tui.mjs"), "--config", opts.config], {
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  // --setup mode: after the wizard finishes, exit cleanly so the parent TUI
  // can launch a fresh TUI with the new config. Don't fall through to a
  // backup.
  if (opts.setup || opts.setupForce) {
    process.exit(0);
  }

  let cfgPath = opts.config;
  if (!existsSync(cfgPath)) {
    console.error(`No config at ${cfgPath}. Run \`node backup.mjs --setup\` to create one.`);
    process.exit(2);
  }

  const r = await runFullBackup(cfgPath, opts);
  process.exit(r.ok ? 0 : 1);
}

// Only run main() when this file is invoked directly (not when imported).
const isMain = (() => {
  try {
    const url = new URL(import.meta.url);
    const argv1 = process.argv[1] && path.resolve(process.argv[1]);
    return url.pathname === argv1;
  } catch { return false; }
})();

if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
