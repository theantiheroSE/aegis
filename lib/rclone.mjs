// lib/rclone.mjs — S3 / B2 / R2 / SFTP-via-rclone destinations.
//
// Config shape (config.json):
//   "transfer": "rclone",
//   "rclone": {
//     "remote": "mys3",         // the name you gave in `rclone config`
//     "path": "backups/vps",    // path inside the remote (no leading slash)
//     "chunkSize": ""           // optional, e.g. "100M"
//   }
//
// How it works:
//   - Upload:    rclone copyto <local> <remote>:<path>/<basename>
//                Also copies the .sha256 sidecar.
//   - List:      rclone lsjson <remote>:<path>/ returns JSON with Name,
//                Size, ModTime. We filter by the aegis prefix and convert
//                ModTime → epoch for retention decisions.
//   - Delete:    rclone deletefile <remote>:<path>/<name>
//                Plus a best-effort delete of the .sha256 sidecar.
//
// Prerequisites:
//   - The `rclone` binary must be installed and on $PATH.
//   - The named remote must already exist (run `rclone config` once).
//
// Supports any backend rclone supports (S3, Backblaze B2, Cloudflare R2,
// Google Cloud Storage, Azure Blob, Wasabi, SFTP-over-rclone, etc.).
import { spawn } from "node:child_process";
import path from "node:path";

export function isRcloneAvailable() {
  return new Promise((resolve) => {
    const child = spawn("rclone", ["--version"], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function remoteBase(cfg) {
  const r = cfg.rclone?.remote;
  const p = cfg.rclone?.path || "";
  if (!r) throw new Error("config.rclone.remote is required for rclone transfer");
  // Normalize: ensure exactly one colon between remote and path.
  const remote = r.endsWith(":") ? r.slice(0, -1) : r;
  return `${remote}:${p}`.replace(/\/+$/, ""); // strip trailing slashes
}

function runRclone(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("rclone", args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const so = [], se = [];
    child.stdout.on("data", (b) => so.push(b));
    child.stderr.on("data", (b) => se.push(b));
    child.on("error", (e) => reject(new Error(`failed to run rclone: ${e.message}. Is rclone installed?`)));
    child.on("close", (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(so).toString("utf8"),
      stderr: Buffer.concat(se).toString("utf8"),
    }));
  });
}

export async function uploadRclone(cfg, archive) {
  const base = remoteBase(cfg);
  const baseName = path.basename(archive);
  const shaFile = archive + ".sha256";
  for (const local of [archive, shaFile]) {
    const args = [
      "copyto",
      "--progress",
      "--retries", "3",
      "--retries-sleep", "5s",
      "--low-level-retries", "10",
      local,
      `${base}/${path.basename(local)}`,
    ];
    if (cfg.rclone.chunkSize) args.push("--s3-chunk-size", cfg.rclone.chunkSize);
    const r = await runRclone(args);
    if (r.code !== 0) {
      throw new Error(`rclone copyto ${path.basename(local)} failed (exit ${r.code}): ${r.stderr}`);
    }
  }
}

// List remote backups with mtime. Returns [{ name, epoch }] sorted newest-first.
// Walks the remote path and filters by the aegis archive pattern in JS
// (cheaper than teaching rclone our regex).
export async function listRcloneDetailed(cfg) {
  const base = remoteBase(cfg);
  const args = ["lsjson", "--files-only", "--no-modtime=false", base];
  const r = await runRclone(args);
  if (r.code !== 0) {
    // Empty remote → rclone returns non-zero. Don't fail the prune; return [].
    if (/directory not found/i.test(r.stderr || "")) return [];
    throw new Error(`rclone lsjson failed (exit ${r.code}): ${r.stderr}`);
  }
  let entries = [];
  try { entries = JSON.parse(r.stdout); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    const name = e.Name;
    if (!/^aegis-.*\.tar\.(zst|gz)(\.age)?$/.test(name)) continue;
    const modTime = e.ModTime ? new Date(e.ModTime).getTime() / 1000 : 0;
    out.push({ name, epoch: Math.floor(modTime) });
  }
  out.sort((a, b) => b.epoch - a.epoch);
  return out;
}

export async function deleteRcloneFile(cfg, name) {
  const base = remoteBase(cfg);
  const args = ["deletefile", `${base}/${name}`];
  const r = await runRclone(args);
  if (r.code !== 0) return false;
  // Best-effort delete of the .sha256 sidecar.
  await runRclone(["deletefile", `${base}/${name}.sha256`]);
  return true;
}

// List archive names (no mtime) — used by restore/verify.
export async function listRclone(cfg) {
  const detailed = await listRcloneDetailed(cfg);
  return detailed.map((d) => d.name);
}

// Download a single file from the rclone remote to `dest`.
export async function downloadRclone(cfg, name, dest) {
  const base = remoteBase(cfg);
  const r = await runRclone(["copyto", `${base}/${name}`, dest]);
  if (r.code !== 0) {
    throw new Error(`rclone copyto ${name} → ${dest} failed (exit ${r.code}): ${r.stderr}`);
  }
  // Best-effort sidecar.
  await runRclone(["copyto", `${base}/${name}.sha256`, dest + ".sha256"]);
}
