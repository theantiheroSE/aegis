#!/usr/bin/env node
// restore.mjs — interactive restore from a remote vps-backup archive.
//
// Usage:
//   node restore.mjs                          # list remote backups and prompt
//   node restore.mjs --archive <name>         # restore a specific archive
//   node restore.mjs --list                   # only list
//   node restore.mjs --download-only <name>   # just download+extract, no restore
//   node restore.mjs --yes                    # skip confirmations (DANGEROUS)
//
import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
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
  console.log(`restore.mjs — restore from a vps-backup archive.

Usage:
  node restore.mjs [--config path] [--archive <name>] [--from <date>] [--to <date>] [--list] [--download-only <name>] [--yes]

Date filtering:
  --from <ISO date>   Pick the most recent archive whose timestamp is
                      at or before this date (e.g. 2024-12-31 or 2024-12-31T08:00:00Z).
  --to   <ISO date>   Lower bound: only archives AFTER this date.

Without --archive, lists available remote backups (optionally filtered by
--from/--to) and prompts.
With --yes, skips all confirmation prompts (dangerous).
Supports both SSH and FTP transfers (uses config.transfer).
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
  if (!cfg.ssh?.identityFile) cfg.ssh.identityFile = "/root/.ssh/id_ed25519";
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
  const r = await run("ssh", [
    ...sshArgs(cfg),
    `${cfg.ssh.user}@${cfg.ssh.host}`,
    `ls -1t ${cfg.ssh.remoteDir}/vps-backup-*.tar.zst 2>/dev/null | sed 's|.*/||'`,
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
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => /^vps-backup-.*\.tar\.(zst|gz)$/.test(s))
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

// ---------- Dispatchers --------------------------------------------------

async function listRemote(cfg) {
  const transfer = cfg.transfer || "ssh";
  if (transfer === "ftp") return listRemoteFtp(cfg);
  return listRemoteSsh(cfg);
}

async function download(cfg, name, dest) {
  const transfer = cfg.transfer || "ssh";
  if (transfer === "ftp") return downloadFtp(cfg, name, dest);
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
    console.error(`No config at ${opts.config}. Run \`node backup.mjs --setup\` to create one.`);
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
        const m = name.match(/vps-backup-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
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

  console.log(`Restoring ${opts.archive} via ${transfer}`);
  const work = path.join(os.tmpdir(), `vps-restore-${Date.now()}`);
  await download(cfg, opts.archive, work);
  const archivePath = path.join(work, opts.archive);
  await verifySha(archivePath);
  const extractDir = path.join(work, "extract");
  await extract(archivePath, extractDir);
  const { stagingDir, manifest } = await readManifest(extractDir);
  console.log(`Manifest: ${manifest.items.length} item(s), generated ${manifest.generatedAt}`);

  if (opts.downloadOnly) {
    console.log(`Extracted to ${stagingDir}`);
    return;
  }

  await restorePostgres(cfg, stagingDir, manifest.items, opts.yes);
  await restoreSqlite(stagingDir, manifest.items, opts.yes);
  await restorePm2(stagingDir, manifest.items, opts.yes);
  await restoreNginx(stagingDir, manifest.items, opts.yes);

  console.log("\nDone. Review and restart affected services as needed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
