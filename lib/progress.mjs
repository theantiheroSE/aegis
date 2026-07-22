// Progress bus — shared EventEmitter for backup progress events.
// Used by both the CLI (ignored) and the TUI (subscribed).
import { EventEmitter } from "node:events";

export class ProgressBus extends EventEmitter {
  emit_(event, data) { this.emit(event, data); }
  log(level, message) { this.emit("log", { level, message, ts: Date.now() }); }
  phase(name, message, total = 0) { this.emit("phase", { name, message, total, ts: Date.now() }); }
  progress(phase, current, total) { this.emit("progress", { phase, current, total, ts: Date.now() }); }
  item(kind, name, status, extra = {}) { this.emit("item", { kind, name, status, ...extra, ts: Date.now() }); }
  done(result) { this.emit("done", { ...result, ts: Date.now() }); }
  fail(error) { this.emit("fail", { error: String(error?.message || error), ts: Date.now() }); }
}

export function attachConsole(bus) {
  const orig = console.log;
  bus.on("log", ({ level, message }) => {
    const tag = `[${level.padEnd(5)}]`.padEnd(8);
    orig(`${tag} ${message}`);
  });
}
