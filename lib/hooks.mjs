// lib/hooks.mjs — run user-configured shell commands around backup phases.
//
// Config shape (config.json):
//   "hooks": {
//     "preBackup":  ["docker stop myapp", "redis-cli bgsave"],
//     "postBackup": ["docker start myapp"],
//     "preUpload":  ["/usr/local/bin/aegis-pre-upload"],
//     "postUpload": ["/usr/local/bin/aegis-post-upload"]
//   }
//
// Behavior:
//   - preBackup failure aborts the run with a clear error.
//   - post* failures are logged but do not change the run result.
//   - Each command inherits a controlled environment with these vars added
//     on top of process.env:
//       AEGIS_PHASE         "preBackup" | "postBackup" | "preUpload" | "postUpload"
//       AEGIS_TIMESTAMP     ISO timestamp of run start
//       AEGIS_ARCHIVE_PATH  absolute path to the just-built archive (postBackup+)
//       AEGIS_CONFIG_PATH   absolute path to config.json
//   - Commands run with /bin/sh -c so pipes, redirects, && work naturally.
import { spawn } from "node:child_process";

export const VALID_HOOKS = ["preBackup", "postBackup", "preUpload", "postUpload"];

export async function runHooks(phase, cfg, extraEnv = {}, opts = {}) {
  const { logger, logStream, fatal = false } = opts;
  const list = cfg?.hooks?.[phase];
  if (!Array.isArray(list) || list.length === 0) return { ran: 0, failed: 0 };

  const log = (level, msg) => {
    if (logger) logger[level]?.(msg);
    else console.log(`[${level}] ${msg}`);
  };

  let failed = 0;
  for (const cmd of list) {
    if (typeof cmd !== "string" || cmd.trim() === "") continue;
    const env = {
      ...process.env,
      AEGIS_PHASE: phase,
      ...extraEnv,
    };
    const r = await runOne(cmd, env, logStream);
    if (r.code !== 0) {
      failed++;
      const msg = `hook ${phase} failed (exit ${r.code}): ${cmd}`;
      log(fatal ? "ERROR" : "WARN", msg);
      if (r.stderr) {
        for (const l of r.stderr.split("\n").filter(Boolean).slice(0, 6)) {
          log("WARN", `  ${l}`);
        }
      }
      if (fatal) {
        const e = new Error(msg);
        e.hookFailure = true;
        throw e;
      }
    } else {
      log("OK", `hook ${phase}: ${cmd}`);
    }
  }
  return { ran: list.length, failed };
}

function runOne(cmd, env, logStream) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], { env, stdio: ["ignore", "pipe", "pipe"] });
    const so = [], se = [];
    child.stdout.on("data", (b) => { so.push(b); if (logStream) logStream.write(b); });
    child.stderr.on("data", (b) => { se.push(b); if (logStream) logStream.write(b); });
    child.on("error", (e) => resolve({ code: -1, stdout: "", stderr: e.message }));
    child.on("close", (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(so).toString("utf8"),
      stderr: Buffer.concat(se).toString("utf8"),
    }));
  });
}
