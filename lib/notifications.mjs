// lib/notifications.mjs — send notifications on backup success/failure.
//
// Supported channels:
//   - webhook: HTTP POST a JSON payload to a URL
//   - email:   hand off to the system's sendmail/mailx (no SMTP creds to manage)
//   - smtp:    direct SMTP via nodemailer (host/port/user/pass stored in config)
//
// Config (config.json):
//   "notifications": {
//     "onSuccess": false,
//     "onFailure": true,
//     "webhook": {
//       "url": "https://hooks.slack.com/services/...",
//       "method": "POST",
//       "headers": { "Content-Type": "application/json" }
//     },
//     "email": {
//       "to": "ops@example.com",
//       "from": "vps-backup@example.com"
//     },
//     "smtp": {
//       "host": "smtp.gmail.com",
//       "port": 587,
//       "secure": false,
//       "user": "user@gmail.com",
//       "pass": "app-password",
//       "from": "user@gmail.com",
//       "to": "ops@example.com"
//     }
//   }
//
// Notifications are best-effort: any failure to send is logged but does
// not affect the backup result.
import { spawn } from "node:child_process";
import nodemailer from "nodemailer";

export async function sendNotifications(cfg, { ok, summary }) {
  const n = cfg.notifications;
  if (!n) return;
  const wantSuccess = n.onSuccess === true;
  const wantFailure = n.onFailure !== false; // default to true
  if (ok && !wantSuccess) return;
  if (!ok && !wantFailure) return;

  const subject = ok
    ? `[vps-backup] OK — ${summary.items} items, ${summary.duration}`
    : `[vps-backup] FAILED — ${summary.error || "unknown error"}`;
  const body = formatBody({ ok, summary });

  if (n.webhook?.url) {
    try { await sendWebhook(n.webhook, { subject, body, ok, summary }); }
    catch (e) { console.error(`[notify] webhook failed: ${e.message}`); }
  }
  if (n.email?.to) {
    try { await sendEmail(n.email, subject, body); }
    catch (e) { console.error(`[notify] email failed: ${e.message}`); }
  }
  if (n.smtp?.host && n.smtp?.to) {
    try { await sendSmtp(n.smtp, { subject, body }); }
    catch (e) { console.error(`[notify] smtp failed: ${e.message}`); }
  }
}

function formatBody({ ok, summary }) {
  const lines = [];
  lines.push(`Status:  ${ok ? "OK" : "FAILED"}`);
  lines.push(`Host:    ${summary.host}`);
  lines.push(`When:    ${summary.timestamp}`);
  lines.push(`Duration: ${summary.duration}`);
  if (summary.items != null) lines.push(`Items:   ${summary.items}`);
  if (summary.errors != null) lines.push(`Errors:  ${summary.errors}`);
  if (summary.bytes) lines.push(`Size:    ${summary.bytes}`);
  if (summary.archive) lines.push(`Archive: ${summary.archive}`);
  if (summary.error) lines.push(`Error:   ${summary.error}`);
  if (summary.logFile) lines.push(`Log:     ${summary.logFile}`);
  return lines.join("\n");
}

async function sendWebhook(cfg, payload) {
  // Most webhooks (Slack, Discord, ntfy, generic) accept a JSON body.
  // We pass the payload through as-is; users can configure headers for
  // services that need auth or different content types.
  const headers = cfg.headers || { "Content-Type": "application/json" };
  const args = [
    "--silent", "--show-error",
    "--max-time", "15",
    "--request", cfg.method || "POST",
  ];
  for (const [k, v] of Object.entries(headers)) {
    args.push("--header", `${k}: ${v}`);
  }
  args.push("--data-raw", JSON.stringify(payload));
  args.push(cfg.url);
  await new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["ignore", "ignore", "ignore"] });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`curl exited ${code}`)));
    child.on("error", reject);
  });
}

async function sendEmail(cfg, subject, body) {
  // Try mailx first, fall back to sendmail. Both are pre-installed on
  // most Linux distros and don't need credentials configured here.
  const from = cfg.from || "vps-backup";
  const tryBin = (bin, argsFn) => new Promise((resolve, reject) => {
    const child = spawn(bin, argsFn(), { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.write(`From: ${from}\nTo: ${cfg.to}\nSubject: ${subject}\n\n${body}\n`);
    child.stdin.end();
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`)));
    child.on("error", reject);
  });
  try {
    await tryBin("mailx", () => ["-s", subject, cfg.to]);
    return;
  } catch {}
  try {
    await tryBin("sendmail", () => ["-t"]);
    return;
  } catch {}
  try {
    await tryBin("mail", () => ["-s", subject, cfg.to]);
    return;
  } catch (e) {
    throw new Error(`no working mail binary (mailx/sendmail/mail): ${e.message}`);
  }
}

async function sendSmtp(cfg, { subject, body }) {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port || 587,
    secure: cfg.secure === true, // true for 465, false for 587/STARTTLS
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    tls: { rejectUnauthorized: cfg.rejectUnauthorized !== false },
  });
  await transport.sendMail({
    from: cfg.from || cfg.user,
    to: cfg.to,
    subject,
    text: body,
  });
}
