// Stop hook with "asyncRewake": true (documented: https://code.claude.com/docs/en/hooks, "Run hooks in the background").
// Every time a turn ends, this starts in the background, waits 20 minutes, then exits 2 -> Claude wakes up,
// even when idle, and gets the worker status below as a system reminder.
// Only one sleeper at a time: a lock file holds the live sleeper's pid and start time.
// Scott, Oct 10 2026: "I WANT YOU WOKEN UP EVERY 20 MINUTES AND I WANT YOU TO CHECK."
import fs from "node:fs";
import path from "node:path";

const RUNS = "C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/runs";
const LOCK = path.join(RUNS, ".rewake-lock.json");
const override = (() => { try { return Number(fs.readFileSync(path.join(RUNS, ".rewake-seconds"), "utf8").trim()); } catch { return 0; } })();
const DELAY_MS = (override > 0 ? override : 20 * 60) * 1000;

try { fs.readFileSync(0); } catch {}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  if (lock.pid !== process.pid && alive(lock.pid) && Date.now() - lock.started < DELAY_MS + 120000) process.exit(0);
} catch {}
fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started: Date.now(), wakeAt: new Date(Date.now() + DELAY_MS).toISOString() }));

await new Promise((r) => setTimeout(r, DELAY_MS));

// Status of every recent worker (same rules as tr-no-idle.mjs).
const now = Date.now();
const lines = [];
for (const d of fs.readdirSync(RUNS, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  // Codex/Haiku workers write run.jsonl; DeepSeek workers (ds.ps1, Oct 13) write stream.jsonl.
  const dir = path.join(RUNS, d.name);
  const log = ["run.jsonl", "stream.jsonl"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!log) continue;
  let st; try { st = fs.statSync(log); } catch { continue; }
  if (now - st.mtimeMs > 48 * 3600 * 1000 || fs.existsSync(path.join(dir, "handled.txt"))) continue;
  let tail = ""; try { const b = fs.readFileSync(log); tail = b.subarray(Math.max(0, b.length - 4096)).toString("utf8"); } catch {}
  const last = tail.trim().split("\n").pop() || "";
  const done = fs.existsSync(path.join(dir, "finished.txt")) || /"type":"turn\.completed"/.test(last) || /"type":"result"/.test(tail);
  const quiet = Math.round((now - st.mtimeMs) / 60000);
  lines.push(done ? `FINISHED-NOT-HANDLED ${d.name}` : quiet >= 15 ? `STALLED ${d.name} (quiet ${quiet} min)` : `RUNNING ${d.name} (quiet ${quiet} min)`);
  // Token use (Scott, Oct 11: track it; over 272K input tokens is billed at the long-context rate).
  try {
    const { tokenInfo, tokenLine } = await import("file:///C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/tools/worker-tokens.mjs");
    lines.push("   tokens: " + tokenLine(tokenInfo(d.name)));
  } catch (e) { lines.push("   tokens: ? (" + e.message + ")"); }
}
try { fs.unlinkSync(LOCK); } catch {}
const t = new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver", hour: "numeric", minute: "2-digit" });
console.error(
  `20-MINUTE WAKE-UP (${t} Mountain, hook tr-wake-20.mjs). Scott's order: check now.\n` +
  (lines.length ? lines.join("\n") : "No unhandled workers.") +
  "\nCheck every worker and server; start the next step for anything finished; relaunch anything stalled; report to Scott in 3 lines.",
);
process.exit(2);
