#!/usr/bin/env node
// verify.mjs — verify integrity of a remote backup archive.
//
// Usage:
//   node verify.mjs --archive <name>   # download + verify SHA256
//   node verify.mjs --latest           # verify the most recent backup
//   node verify.mjs --list             # list available backups
//   node verify.mjs --archive <name> --keep  # keep the downloaded archive
//
// The archive is downloaded to a temp dir, SHA256 checked against the
// .sha256 sidecar, then deleted (unless --keep). Exit codes:
//   0 = verification passed
//   1 = verification failed (SHA mismatch or download error)
//   2 = no archive found / invalid arguments
import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const TOOL_DIR = path.dirname(new URL(import.meta.url).pathname);

function parseArgs(argv) {
  const opts = {
    config: path.join(TOOL_DIR, "config.json"),
    archive: null,
    latest: false,
    list: false,
    keep: false,
  };
  for (let i = 2; i < argv.length; i++) {
    let a = argv[i];
    let val = null;
    const eq = a.indexOf("=");
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === "--config" || a === "-c") opts.config = val ?? argv[++i];
    else if (a === "--archive") opts.archive = val ?? argv[++i];
    else if (a === "--latest") opts.latest = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log(`verify.mjs — verify integrity of a remote Aegis archive.

Usage:
  node verify.mjs [--config path] --archive <name> [--keep]
  node verify.mjs [--config path] --latest [--keep]
  node verify.mjs [--config path] --list

Options:
  --archive <name>   Archive to verify (exact filename)
  --latest           Verify the most recent archive
  --list             List available archives
  --keep             Keep the downloaded archive (default: delete after check)
  -c, --config <p>   Config file (default: ./config.json)
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

async function loadConfig(p) {
  const cfg = JSON.parse(await fs.readFile(p, "utf8"));
  if (!cfg.ssh?.identityFile) cfg.ssh.identityFile = "/root/.ssh/id_ed25519";
  return cfg;
}

async function listRemoteSsh(cfg) {
  const r = await run("ssh", [
    "-i", cfg.ssh.identityFile,
    "-p", String(cfg.ssh.port || 22),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    `${cfg.ssh.user}@${cfg.ssh.host}`,
    `cd ${cfg.ssh.remoteDir} && ls -1t aegis-*.tar.zst aegis-*.tar.gz 2>/dev/null`,
  ]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

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
  if (r.code !== 0) return [];
  return r.stdout.split("\n")
    .map((s) => s.trim())
    .filter((s) => /^aegis-.*\.tar\.(zst|gz)$/.test(s))
    .sort().reverse();
}

async function listRemote(cfg) {
  const transfer = cfg.transfer || "ssh";
  return transfer === "ftp" ? listRemoteFtp(cfg) : listRemoteSsh(cfg);
}

async function downloadSsh(cfg, name, dest) {
  const url = `${cfg.ssh.user}@${cfg.ssh.host}:${cfg.ssh.remoteDir}/${name}`;
  const r = await run("rsync", [
    "-av", "--progress",
    "-e", `ssh -i ${cfg.ssh.identityFile} -p ${cfg.ssh.port || 22} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15`,
    url, dest,
  ]);
  if (r.code !== 0) throw new Error(`rsync failed: ${r.stderr}`);
}

async function downloadFtp(cfg, name, dest) {
  const f = cfg.ftp;
  const proto = f.secure ? "ftps" : "ftp";
  const url = `${proto}://${f.user}:${encodeURIComponent(f.password)}@${f.host}:${f.port || 21}${f.remoteDir}/${name}`;
  const r = await run("curl", [
    "--silent", "--show-error",
    "--connect-timeout", "15", "--max-time", "120",
    ...(f.secure ? ["--ssl"] : []),
    "-o", dest, url,
  ]);
  if (r.code !== 0) throw new Error(`curl failed: ${r.stderr}`);
}

async function download(cfg, name, dest) {
  const transfer = cfg.transfer || "ssh";
  return transfer === "ftp" ? downloadFtp(cfg, name, dest) : downloadSsh(cfg, name, dest);
}

async function verifySha(archivePath) {
  const shaPath = archivePath + ".sha256";
  // Try to download the .sha256 sidecar if it doesn't exist
  if (!existsSync(shaPath)) {
    const cfg = await loadConfig(process.argv.find((a) => a.startsWith("--config="))?.split("=")[1] || path.join(TOOL_DIR, "config.json"));
    const transfer = cfg.transfer || "ssh";
    const name = path.basename(archivePath);
    if (transfer === "ssh") {
      await run("rsync", [
        "-av",
        "-e", `ssh -i ${cfg.ssh.identityFile} -p ${cfg.ssh.port || 22}`,
        `${cfg.ssh.user}@${cfg.ssh.host}:${cfg.ssh.remoteDir}/${name}.sha256`,
        shaPath,
      ]);
    } else {
      const f = cfg.ftp;
      const proto = f.secure ? "ftps" : "ftp";
      const url = `${proto}://${f.user}:${encodeURIComponent(f.password)}@${f.host}:${f.port || 21}${f.remoteDir}/${name}.sha256`;
      await run("curl", ["--silent", "-o", shaPath, url]);
    }
  }
  if (!existsSync(shaPath)) {
    throw new Error("No .sha256 sidecar found");
  }
  const shaContent = await fs.readFile(shaPath, "utf8");
  const expected = shaContent.trim().split(/\s+/)[0];
  const r = await run("sha256sum", [archivePath]);
  if (r.code !== 0) throw new Error(`sha256sum failed: ${r.stderr}`);
  const actual = r.stdout.trim().split(/\s+/)[0];
  if (expected !== actual) {
    throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
  }
  return { expected, actual };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printHelp(); return; }
  if (!existsSync(opts.config)) {
    console.error(`No config at ${opts.config}. Run \`node backup.mjs --setup\` to create one.`);
    process.exit(2);
  }
  const cfg = await loadConfig(opts.config);
  const label = (cfg.transfer || "ssh") === "ftp"
    ? `ftp://${cfg.ftp.user}@${cfg.ftp.host}:${cfg.ftp.port}${cfg.ftp.remoteDir}`
    : `${cfg.ssh.user}@${cfg.ssh.host}:${cfg.ssh.remoteDir}`;

  if (opts.list) {
    const list = await listRemote(cfg);
    console.log(`Available remote backups (${label}):`);
    if (list.length === 0) console.log("  (none)");
    else list.forEach((n, i) => console.log(`  ${String(i + 1).padStart(3)}. ${n}`));
    return;
  }

  if (!opts.archive && !opts.latest) {
    console.error("Specify --archive <name> or --latest (or --list)");
    process.exit(2);
  }

  let archiveName = opts.archive;
  if (!archiveName) {
    const list = await listRemote(cfg);
    if (list.length === 0) {
      console.error("No remote backups found");
      process.exit(2);
    }
    archiveName = list[0];
    console.log(`Using latest: ${archiveName}`);
  }

  const workDir = path.join(os.tmpdir(), `vps-verify-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });
  const archivePath = path.join(workDir, archiveName);

  try {
    console.log(`Downloading ${archiveName} from ${label}...`);
    await download(cfg, archiveName, archivePath);
    console.log("Verifying SHA256...");
    const { expected, actual } = await verifySha(archivePath);
    console.log(`✓ SHA256 verified: ${actual}`);
    console.log("Verification PASSED");
  } catch (e) {
    console.error(`Verification FAILED: ${e.message}`);
    process.exit(1);
  } finally {
    if (!opts.keep) {
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch {}
    } else {
      console.log(`Archive kept at ${archivePath}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
