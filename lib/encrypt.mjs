// lib/encrypt.mjs — optional age (https://age-encryption.org) archive encryption.
//
// Config shape (config.json):
//   "encryption": {
//     "recipients": ["age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"],
//     "identityFiles": ["/root/aegis-backup.key"],
//     "passphrase": false   // optional: also accept a passphrase-based identity
//   }
//
// Behavior:
//   - Encryption applies AFTER the .tar.zst is built and BEFORE upload.
//     Encrypted archives end in `.tar.zst.age`. The .sha256 sidecar is the
//     hash of the ENCRYPTED bytes (so the backup server can't compute it
//     without the recipient).
//   - Decryption applies AFTER download and BEFORE extract. Detected by
//     the `age-encryption.org/v1` ASCII magic header.
//   - Supports multiple recipients (e.g. yubikey + paper backup).
//   - The `age` binary must be on $PATH. We shell out instead of pulling
//     a JS crypto dep — age is small (~6 MiB), well-audited, and the user
//     almost certainly already has it on a modern Linux.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export function isEnabled(cfg) {
  return Array.isArray(cfg?.encryption?.recipients) && cfg.encryption.recipients.length > 0;
}

export function hasDecryptConfig(cfg) {
  const e = cfg?.encryption;
  if (!e) return false;
  if (Array.isArray(e.identityFiles) && e.identityFiles.length > 0) return true;
  if (e.passphrase) return true;
  return false;
}

// Encrypt a file with `age`. Returns the new (encrypted) path on success.
export async function encryptFile(inPath, outPath, recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error("encryptFile: at least one recipient is required");
  }
  const args = [];
  for (const r of recipients) args.push("-r", r);
  args.push("-o", outPath, inPath);
  const r = await runAge(args);
  if (r.code !== 0) {
    throw new Error(`age encrypt failed (exit ${r.code}): ${r.stderr}`);
  }
  return outPath;
}

// Detect age-encrypted file by magic header (first 25 bytes).
export async function isEncrypted(filePath) {
  let head;
  try {
    const { open } = await import("node:fs/promises");
    const fh = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(25);
      const { bytesRead } = await fh.read(buf, 0, 25, 0);
      head = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
  return head.startsWith("age-encryption.org/v1");
}

export async function decryptFile(inPath, outPath, { identityFiles = [], passphrase = false } = {}) {
  if (identityFiles.length === 0 && !passphrase) {
    throw new Error("decryptFile: need at least one identity file or passphrase");
  }
  const args = ["-d"];
  for (const id of identityFiles) args.push("-i", id);
  args.push("-o", outPath, inPath);
  const env = { ...process.env };
  if (passphrase) {
    // Read passphrase from stdin via env var AGE_PASSPHRASE — age reads it.
    // (If user wants, they can also create an identity file instead.)
    env.AGE_PASSPHRASE = passphrase;
  }
  const r = await runAge(args, env);
  if (r.code !== 0) {
    throw new Error(`age decrypt failed (exit ${r.code}): ${r.stderr}`);
  }
  return outPath;
}

function runAge(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn("age", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const so = [], se = [];
    child.stdout.on("data", (b) => so.push(b));
    child.stderr.on("data", (b) => se.push(b));
    child.on("error", (e) => reject(new Error(`failed to run age: ${e.message}. Is 'age' installed?`)));
    child.on("close", (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(so).toString("utf8"),
      stderr: Buffer.concat(se).toString("utf8"),
    }));
  });
}

// Generate a new age keypair via `age-keygen`. Returns { publicKey, identityPath }.
// Caller is responsible for storing the identity file securely.
export async function generateKeypair(identityPath) {
  const args = ["-o", identityPath];
  const r = await new Promise((resolve, reject) => {
    const child = spawn("age-keygen", args, { stdio: ["ignore", "pipe", "pipe"] });
    const so = [], se = [];
    child.stdout.on("data", (b) => so.push(b));
    child.stderr.on("data", (b) => se.push(b));
    child.on("error", (e) => reject(new Error(`failed to run age-keygen: ${e.message}. Is 'age' installed?`)));
    child.on("close", (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(so).toString("utf8"),
      stderr: Buffer.concat(se).toString("utf8"),
    }));
  });
  if (r.code !== 0) throw new Error(`age-keygen failed: ${r.stderr}`);
  // Output may say "Public key: age1..." (stdout) or "# public key: age1..."
  // (comment in the .key file, which age-keygen also writes). Check both.
  const m = (r.stdout + "\n" + r.stderr).match(/(?:^|\s)#?\s*[Pp]ublic key:\s*(age1\S+)/);
  if (!m) throw new Error("could not parse public key from age-keygen output");
  return { publicKey: m[1], identityPath };
}
