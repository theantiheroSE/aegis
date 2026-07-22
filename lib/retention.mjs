// lib/retention.mjs — GFS (Grandfather-Father-Son) style retention.
//
// Walks a list of remote backups (newest-first) and decides which ones to
// delete based on `cfg.retention` rules:
//
//   "retention": {
//     "daily":   7,   // keep one per day for the last 7 days
//     "weekly":  4,   // keep one per week for the last 4 weeks
//     "monthly": 6    // keep one per month for the last 6 months
//   }
//
// A single backup can satisfy multiple buckets (e.g., a backup can be both
// the daily and weekly representative for its day/week).
//
// If `cfg.retention` is missing or empty, the legacy `retentionDays` /
// `retentionKeepLast` keys are used as a fallback.

// ISO 8601 week number (1-53) — gives a stable key per week regardless of
// timezone weirdness in `Date`.
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of current week determines the year
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function dayKey(d) {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function monthKey(d) {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}

// backups: array of { name, epoch } sorted newest-first
// retention: { daily?, weekly?, monthly? }
// Returns: { toDelete: [{name, epoch}, ...], keptSummary: "7d/4w/6m" }
export function applyGfsRetention(backups, retention = {}) {
  const daily = Math.max(0, parseInt(retention.daily, 10) || 0);
  const weekly = Math.max(0, parseInt(retention.weekly, 10) || 0);
  const monthly = Math.max(0, parseInt(retention.monthly, 10) || 0);

  if (daily === 0 && weekly === 0 && monthly === 0) {
    return { toDelete: [], keptSummary: "(none)" };
  }

  const filledDays = new Set();
  const filledWeeks = new Set();
  const filledMonths = new Set();
  const toDelete = [];

  for (const b of backups) {
    const d = new Date(b.epoch * 1000);
    const dKey = dayKey(d);
    const wKey = isoWeekKey(d);
    const mKey = monthKey(d);

    const fillsDay = daily > 0 && filledDays.size < daily && !filledDays.has(dKey);
    const fillsWeek = weekly > 0 && filledWeeks.size < weekly && !filledWeeks.has(wKey);
    const fillsMonth = monthly > 0 && filledMonths.size < monthly && !filledMonths.has(mKey);

    if (fillsDay || fillsWeek || fillsMonth) {
      if (fillsDay) filledDays.add(dKey);
      if (fillsWeek) filledWeeks.add(wKey);
      if (fillsMonth) filledMonths.add(mKey);
    } else {
      toDelete.push(b);
    }
  }

  const parts = [];
  if (daily) parts.push(`${filledDays.size}d`);
  if (weekly) parts.push(`${filledWeeks.size}w`);
  if (monthly) parts.push(`${filledMonths.size}m`);
  return { toDelete, keptSummary: parts.join("/") };
}

// Legacy retention: delete anything older than `days`, but always keep
// the newest `keepLast` regardless of age.
// backups: newest-first; returns those to delete.
export function applyLegacyRetention(backups, days, keepLast) {
  const cutoffSec = Math.floor(Date.now() / 1000) - (days || 0) * 86400;
  const toDelete = [];
  backups.forEach((b, idx) => {
    if (idx < (keepLast || 0)) return; // skip the newest N
    if (b.epoch < cutoffSec) toDelete.push(b);
  });
  return toDelete;
}
