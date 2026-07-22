#!/usr/bin/env node
// aegis.mjs — single entry point. TTY → launches TUI; non-TTY → runs CLI.
// All actual logic lives in tui.mjs (which auto-detects the same way).
import "./tui.mjs";
