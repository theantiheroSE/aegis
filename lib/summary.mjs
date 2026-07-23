#!/usr/bin/env node
// lib/summary.mjs — write a human-readable summary of each backup run.
//
// Two formats are written side by side:
//   - logs/backup-<ts>-summary.md  (Markdown, plain text, greppable)
//   - logs/backup-<ts>-summary.html (same content, lightly styled for the web)
//
// Both files live next to the run's log file so everything from one run
// is co-located. They include per-phase breakdown, sizes, durations,
// the SHA256 of the uploaded archive, and a link to the full log.
import { promises as fs } from "node:fs";
import path from "node:path";

function fmtBytes(n) {
  if (!n || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

function fmtDur(ms) {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Group items by kind for the per-phase section.
function groupByKind(items) {
  const out = {};
  for (const it of items || []) {
    const k = it.kind || "other";
    (out[k] ||= []).push(it);
  }
  return out;
}

export async function writeSummary({
  logDir,
  prefix = "backup",
  timestamp = new Date(),
  ok,
  durationMs,
  hostname,
  transfer,
  remote,
  archive,
  archiveBytes,
  sha256,
  items,
  errors,
  logFile,
  errorMessage,
}) {
  await fs.mkdir(logDir, { recursive: true });
  const stamp = timestamp.toISOString().replace(/[:.]/g, "-");
  const mdPath = path.join(logDir, `${prefix}-${stamp}-summary.md`);
  const htmlPath = path.join(logDir, `${prefix}-${stamp}-summary.html`);

  const byKind = groupByKind(items);
  const kindOrder = ["postgres", "mysql", "redis", "mongodb", "sqlite", "pm2", "nginx", "extras", "aegis"];
  const kindRows = [];
  for (const k of kindOrder) {
    const list = byKind[k];
    if (!list || list.length === 0) continue;
    const bytes = list.reduce((s, it) => s + (it.bytes || 0), 0);
    const label = list.map((it) => {
      if (k === "pm2") return it.name;
      if (k === "extras") return it.path;
      if (k === "sqlite") return it.source;
      if (k === "aegis") return it.file;
      return it.database || it.file;
    }).filter(Boolean).join(", ");
    kindRows.push({ k, count: list.length, bytes, label });
  }

  const allErrors = [];
  if (errorMessage) allErrors.push(errorMessage);
  for (const e of errors || []) allErrors.push(typeof e === "string" ? e : e?.message || JSON.stringify(e));

  // ---- Markdown ----
  const lines = [];
  lines.push(`# Aegis backup summary`);
  lines.push("");
  lines.push(`- **Status**: ${ok ? "✅ OK" : "❌ FAILED"}`);
  lines.push(`- **Host**: ${hostname || "(unknown)"}`);
  lines.push(`- **Started**: ${timestamp.toISOString()}`);
  lines.push(`- **Duration**: ${fmtDur(durationMs || 0)}`);
  lines.push(`- **Transfer**: ${transfer || "(unknown)"}${remote ? ` → ${remote}` : ""}`);
  lines.push(`- **Archive**: ${archive ? `\`${path.basename(archive)}\`` : "(none)"} (${fmtBytes(archiveBytes || 0)})`);
  lines.push(`- **SHA256**: \`${sha256 || "(none)"}\``);
  lines.push(`- **Items**: ${items?.length || 0} (${kindRows.reduce((s, r) => s + r.count, 0)} files)`);
  lines.push(`- **Errors**: ${allErrors.length}`);
  lines.push(`- **Log**: \`${path.basename(logFile || "")}\``);
  lines.push("");

  if (kindRows.length > 0) {
    lines.push(`## Components`);
    lines.push("");
    lines.push(`| Kind | Count | Size | Contents |`);
    lines.push(`|------|-------|------|----------|`);
    for (const r of kindRows) {
      lines.push(`| ${r.k} | ${r.count} | ${fmtBytes(r.bytes)} | ${r.label} |`);
    }
    lines.push("");
  }

  if (allErrors.length > 0) {
    lines.push(`## Errors`);
    lines.push("");
    for (const e of allErrors) lines.push(`- ${e}`);
    lines.push("");
  }

  lines.push(`## Files for this run`);
  lines.push("");
  lines.push(`- Markdown summary: \`${path.basename(mdPath)}\``);
  lines.push(`- HTML summary: \`${path.basename(htmlPath)}\``);
  if (logFile) lines.push(`- Full log: \`${path.basename(logFile)}\``);
  lines.push("");
  await fs.writeFile(mdPath, lines.join("\n"));

  // ---- HTML (lightly styled) ----
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Aegis backup ${esc(timestamp.toISOString())}</title>
<style>
body { font: 14px/1.4 -apple-system, system-ui, sans-serif; max-width: 900px; margin: 2em auto; padding: 0 1em; color: #222; }
h1 { border-bottom: 1px solid #ccc; padding-bottom: .3em; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { padding: .5em; text-align: left; border-bottom: 1px solid #eee; }
th { background: #f6f8fa; }
code { background: #f6f8fa; padding: 1px 4px; border-radius: 3px; font-size: 90%; }
.ok { color: #1a7f37; } .fail { color: #cf222e; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: .3em 1em; }
.kv dt { font-weight: 600; }
</style></head><body>
<h1>Aegis backup summary</h1>
<dl class="kv">
  <dt>Status</dt><dd class="${ok ? "ok" : "fail"}">${ok ? "✅ OK" : "❌ FAILED"}</dd>
  <dt>Host</dt><dd>${esc(hostname || "")}</dd>
  <dt>Started</dt><dd>${esc(timestamp.toISOString())}</dd>
  <dt>Duration</dt><dd>${esc(fmtDur(durationMs || 0))}</dd>
  <dt>Transfer</dt><dd>${esc(transfer || "")}${remote ? ` → ${esc(remote)}` : ""}</dd>
  <dt>Archive</dt><dd><code>${esc(path.basename(archive || ""))}</code> (${esc(fmtBytes(archiveBytes || 0))})</dd>
  <dt>SHA256</dt><dd><code>${esc(sha256 || "")}</code></dd>
  <dt>Items</dt><dd>${items?.length || 0}</dd>
  <dt>Errors</dt><dd class="${allErrors.length > 0 ? "fail" : "ok"}">${allErrors.length}</dd>
  <dt>Log</dt><dd><code>${esc(path.basename(logFile || ""))}</code></dd>
</dl>
${kindRows.length > 0 ? `
<h2>Components</h2>
<table>
  <thead><tr><th>Kind</th><th>Count</th><th>Size</th><th>Contents</th></tr></thead>
  <tbody>
    ${kindRows.map((r) => `<tr><td>${esc(r.k)}</td><td>${r.count}</td><td>${esc(fmtBytes(r.bytes))}</td><td>${esc(r.label)}</td></tr>`).join("\n    ")}
  </tbody>
</table>
` : ""}
${allErrors.length > 0 ? `
<h2>Errors</h2>
<ul>${allErrors.map((e) => `<li class="fail">${esc(e)}</li>`).join("")}</ul>
` : ""}
<h2>Files for this run</h2>
<ul>
  <li>Markdown summary: <code>${esc(path.basename(mdPath))}</code></li>
  <li>HTML summary: <code>${esc(path.basename(htmlPath))}</code></li>
  ${logFile ? `<li>Full log: <code>${esc(path.basename(logFile))}</code></li>` : ""}
</ul>
</body></html>`;
  await fs.writeFile(htmlPath, html);

  return { mdPath, htmlPath };
}
