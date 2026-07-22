// lib/setup.mjs — first-time setup wizard.
//
// Detects missing/incomplete config and walks the user through:
//   - choosing SSH (recommended) or FTP
//   - for SSH: generating a dedicated keypair, displaying the public key
//   - for FTP: collecting host/port/user/password/dir
//   - testing the connection
//   - writing config.json
//
import { spawn } from "node:child_process";
import { promises as fs, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const TOOL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export function isFirstRun(cfgPath) {
  if (!existsSync(cfgPath)) return { firstRun: true, reason: "no config file" };
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    const hasSsh = raw.ssh?.host && raw.ssh?.user && raw.ssh?.remoteDir;
    const hasFtp = raw.ftp?.host && raw.ftp?.user && raw.ftp?.password && raw.ftp?.remoteDir;
    const transfer = raw.transfer || "ssh";
    if (transfer === "ssh" && !hasSsh) return { firstRun: true, reason: "ssh block incomplete" };
    if (transfer === "ftp" && !hasFtp) return { firstRun: true, reason: "ftp block incomplete" };
    return { firstRun: false };
  } catch (e) {
    return { firstRun: true, reason: `parse error: ${e.message}` };
  }
}

// ---------- prompt helpers ------------------------------------------------

function makeRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdout.isTTY });
}

async function prompt(question, defaultValue = "") {
  const rl = makeRl();
  const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(display, (answer) => {
      rl.close();
      const v = answer.trim();
      resolve(v === "" ? defaultValue : v);
    });
  });
}

async function promptPassword(question) {
  // Hidden password input. Falls back to plain input if no TTY.
  if (!process.stdin.isTTY) {
    return prompt(question);
  }
  process.stdout.write(`${question}: `);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (!wasRaw) stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let pw = "";
    const onData = (ch) => {
      for (let i = 0; i < ch.length; i++) {
        const c = ch[i];
        if (c === "\n" || c === "\r" || c === "\u0004") {
          stdin.removeListener("data", onData);
          if (!wasRaw) stdin.setRawMode?.(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(pw);
          return;
        }
        if (c === "\u0003") {
          process.stdout.write("^C\n");
          process.exit(1);
        }
        if (c === "\u007f" || c === "\b") {
          if (pw.length > 0) {
            pw = pw.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        pw += c;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function promptChoice(question, choices) {
  console.log(`\n${question}\n`);
  choices.forEach((c, i) => {
    const num = (i + 1).toString().padStart(1);
    console.log(`  ${num}. ${c.label}${c.description ? `  — ${c.description}` : ""}`);
  });
  const rl = makeRl();
  return new Promise((resolve) => {
    rl.question(`\nPick [1]: `, (answer) => {
      rl.close();
      const s = answer.trim();
      if (s === "") return resolve(0);
      const n = parseInt(s, 10);
      if (Number.isFinite(n) && n >= 1 && n <= choices.length) return resolve(n - 1);
      console.log(`(invalid, picking 1)`);
      resolve(0);
    });
  });
}

async function promptYesNo(question, defaultYes = true) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = makeRl();
  return new Promise((resolve) => {
    rl.question(`${question} ${hint}: `, (answer) => {
      rl.close();
      const s = answer.trim().toLowerCase();
      if (s === "") return resolve(defaultYes);
      resolve(s === "y" || s === "yes");
    });
  });
}

// ---------- visual helpers ------------------------------------------------

function header(title) {
  const bar = "─".repeat(Math.max(40, title.length + 4));
  console.log(`\n┌${bar}┐`);
  console.log(`│ ${title.padEnd(bar.length - 2)} │`);
  console.log(`└${bar}┘\n`);
}

function box(title, content, width = 78) {
  const bar = "─".repeat(width - 2);
  console.log(`\n┌── ${title} ${"─".repeat(Math.max(0, width - title.length - 6))}┐`);
  for (const line of content.split("\n")) {
    console.log(`│ ${line.padEnd(width - 4)} │`);
  }
  console.log(`└${"─".repeat(width - 2)}┘\n`);
}

function info(msg) { console.log(`  ${msg}`); }
function step(msg) { console.log(`\n→ ${msg}`); }

// ---------- shell helpers -------------------------------------------------

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

async function testSshConnection(keyPath, user, host, port = 22) {
  const r = await run("ssh", [
    "-i", keyPath,
    "-p", String(port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    `${user}@${host}`,
    "echo ok",
  ]);
  return r;
}

async function testFtpConnection(ftp) {
  // Use curl to test; --user user:pass, list root.
  const url = `ftp://${ftp.host}:${ftp.port || 21}/`;
  const r = await run("curl", [
    "--silent", "--show-error",
    "--connect-timeout", "10",
    "--max-time", "20",
    "-u", `${ftp.user}:${ftp.password}`,
    "--list-only", url,
  ]);
  return r;
}

// ---------- SSH flow ------------------------------------------------------

async function setupSsh() {
  step("SSH transfer — we'll generate a fresh keypair dedicated to backups.");

  const defaultKeyPath = "/root/.ssh/vps-backup_ed25519";
  const keyPath = await prompt("SSH key path", defaultKeyPath);
  if (existsSync(keyPath)) {
    info(`(key already exists at ${keyPath} — reusing)`);
  } else {
    info(`Generating ed25519 keypair at ${keyPath} ...`);
    const r = await run("ssh-keygen", [
      "-t", "ed25519",
      "-N", "",
      "-f", keyPath,
      "-C", `vps-backup@${os.hostname()}`,
    ]);
    if (r.code !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
    info("Key generated.");
  }

  // Read the public key
  const pubKey = (await fs.readFile(keyPath + ".pub", "utf8")).trim();

  box(
    "Add this PUBLIC key to your backup server",
    `Run on the backup server (as the backup user):\n\n` +
    `  mkdir -p ~/.ssh && chmod 700 ~/.ssh\n` +
    `  echo '${pubKey}' >> ~/.ssh/authorized_keys\n` +
    `  chmod 600 ~/.ssh/authorized_keys\n\n` +
    `Public key (also shown above):\n${pubKey}`,
  );

  const host = await prompt("Remote SSH host (e.g. backup.example.com)");
  if (!host) throw new Error("host is required");
  const user = await prompt("Remote SSH user", "backup");
  const portStr = await prompt("Remote SSH port", "22");
  const port = parseInt(portStr, 10) || 22;
  const remoteDir = await prompt("Remote backup directory", "/backups/vps");

  if (await promptYesNo("Test the SSH connection now?", true)) {
    info("Testing ...");
    const r = await testSshConnection(keyPath, user, host, port);
    if (r.code === 0) {
      info("✓ Connection works.");
    } else {
      info(`✗ Connection failed (exit ${r.code}).`);
      info("  Make sure you've added the public key to the server first.");
      info(`  stderr: ${(r.stderr || "").split("\n").slice(0, 3).join(" | ")}`);
      if (!(await promptYesNo("Continue anyway?", true))) {
        throw new Error("setup aborted by user");
      }
    }
  }

  return {
    transfer: "ssh",
    ssh: {
      host,
      port,
      user,
      identityFile: keyPath,
      remoteDir,
    },
  };
}

// ---------- FTP flow ------------------------------------------------------

async function setupFtp() {
  step("FTP transfer — plain-text, password-based.");

  const host = await prompt("FTP host (e.g. ftp.example.com)");
  if (!host) throw new Error("host is required");
  const portStr = await prompt("FTP port", "21");
  const port = parseInt(portStr, 10) || 21;
  const user = await prompt("FTP user", "backup");
  const password = await promptPassword("FTP password");
  if (!password) throw new Error("password is required");
  const remoteDir = await prompt("Remote backup directory", "/backups/vps");
  const secure = await promptYesNo("Use FTPS (TLS)?", false);

  if (await promptYesNo("Test the FTP connection now?", true)) {
    info("Testing ...");
    const r = await testFtpConnection({ host, port, user, password });
    if (r.code === 0) {
      info("✓ Connected.");
    } else {
      info(`✗ Connection failed (exit ${r.code}).`);
      info(`  stderr: ${(r.stderr || "").split("\n").slice(0, 3).join(" | ")}`);
      if (!(await promptYesNo("Continue anyway?", true))) {
        throw new Error("setup aborted by user");
      }
    }
  }

  return {
    transfer: "ftp",
    ftp: {
      host,
      port,
      user,
      password,
      remoteDir,
      secure,
    },
  };
}

// ---------- write config --------------------------------------------------

function buildConfigFromAnswers(answers) {
  // Start from the example to inherit sane defaults for everything else.
  const examplePath = path.join(TOOL_DIR, "config.example.json");
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(examplePath, "utf8")); }
  catch {}

  cfg.transfer = answers.transfer;
  if (answers.transfer === "ssh") {
    cfg.ssh = { ...cfg.ssh, ...answers.ssh };
    delete cfg.ftp;
  } else {
    cfg.ftp = { ...(cfg.ftp || {}), ...answers.ftp };
    cfg.ssh = { identityFile: "/root/.ssh/id_ed25519" };
  }
  return cfg;
}

export async function writeConfig(cfgPath, cfg) {
  const json = JSON.stringify(cfg, null, 2) + "\n";
  await fs.writeFile(cfgPath, json, { mode: 0o600 });
}

// ---------- main wizard entry ---------------------------------------------

export async function runSetupWizard(cfgPath, { force = false, nonInteractive = false } = {}) {
  if (!existsSync(cfgPath) || force) {
    header(`vps-backup first-time setup`);
    info(`Config path: ${cfgPath}`);
    info("No config found. Let's create one.\n");
  } else {
    const status = isFirstRun(cfgPath);
    if (!status.firstRun && !force) {
      info(`Config at ${cfgPath} looks complete. Use --setup --force to overwrite.`);
      return { ok: false, reason: "config already exists and is complete" };
    }
    header(`vps-backup setup (${status.reason})`);
    info(`Config path: ${cfgPath}\n`);
  }

  if (nonInteractive) {
    throw new Error("non-interactive mode not supported; run without --non-interactive");
  }

  const choice = await promptChoice(
    "Choose how to transfer backups to your remote server:",
    [
      { label: "SSH  (recommended)", description: "encrypted, uses an SSH keypair" },
      { label: "FTP", description: "plain FTP or FTPS, password auth" },
      { label: "Cancel", description: "exit without changes" },
    ],
  );

  let answers;
  if (choice === 0) answers = await setupSsh();
  else if (choice === 1) answers = await setupFtp();
  else throw new Error("setup cancelled");

  const cfg = buildConfigFromAnswers(answers);
  await writeConfig(cfgPath, cfg);

  box(
    "Setup complete",
    `Config written to: ${cfgPath}\n` +
    `Transfer method:   ${cfg.transfer}\n` +
    (cfg.transfer === "ssh"
      ? `SSH target:        ${cfg.ssh.user}@${cfg.ssh.host}:${cfg.ssh.port}\n` +
        `Remote dir:        ${cfg.ssh.remoteDir}\n` +
        `SSH key:           ${cfg.ssh.identityFile}`
      : `FTP target:        ${cfg.ftp.user}@${cfg.ftp.host}:${cfg.ftp.port}\n` +
        `Remote dir:        ${cfg.ftp.remoteDir}\n` +
        `FTPS:              ${cfg.ftp.secure ? "yes" : "no (plaintext)"}`),
  );

  return { ok: true, config: cfg };
}
