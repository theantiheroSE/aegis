// lib/colors.mjs — direct ANSI escape helpers.
// Use these instead of blessed `{red-fg}` tags which apparently don't render
// in some terminals / SSH sessions.

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

export const C = {
  reset: RESET,
  // foreground
  red: (s) => `${ESC}31m${s}${ESC}39m`,
  green: (s) => `${ESC}32m${s}${ESC}39m`,
  yellow: (s) => `${ESC}33m${s}${ESC}39m`,
  blue: (s) => `${ESC}34m${s}${ESC}39m`,
  magenta: (s) => `${ESC}35m${s}${ESC}39m`,
  cyan: (s) => `${ESC}36m${s}${ESC}39m`,
  white: (s) => `${ESC}37m${s}${ESC}39m`,
  gray: (s) => `${ESC}90m${s}${ESC}39m`,
  bold: (s) => `${ESC}1m${s}${ESC}22m`,
  dim: (s) => `${ESC}2m${s}${ESC}22m`,
  inverse: (s) => `${ESC}7m${s}${ESC}27m`,
  // bare codes for inline use
  fg: {
    red: `${ESC}31m`, green: `${ESC}32m`, yellow: `${ESC}33m`,
    blue: `${ESC}34m`, magenta: `${ESC}35m`, cyan: `${ESC}36m`,
    white: `${ESC}37m`, gray: `${ESC}90m`,
  },
  bg: {
    red: `${ESC}41m`, green: `${ESC}42m`, yellow: `${ESC}43m`,
    blue: `${ESC}44m`,
  },
};

// Strip ANSI codes — useful for log file output
export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

// Pad right with spaces, accounting for ANSI escape codes in length calculation
export function padEnd(s, width) {
  const visible = stripAnsi(s).length;
  if (visible >= width) return s;
  return s + " ".repeat(width - visible);
}

export function padStart(s, width) {
  const visible = stripAnsi(s).length;
  if (visible >= width) return s;
  return " ".repeat(width - visible) + s;
}

// Render a horizontal bar: "█████░░░░░░"
export function bar(pct, width = 24, filled = "█", empty = "░") {
  pct = Math.max(0, Math.min(100, pct || 0));
  const f = Math.round((pct / 100) * width);
  return filled.repeat(f) + empty.repeat(width - f);
}
