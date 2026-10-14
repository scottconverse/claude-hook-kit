// Stop hook: Claude may NOT end a turn while TownReporter work is unarmed.
// Scott, Oct 10 2026: "You have done this dozens of times over the months. Hook please."
// Blocks (exit 2) when:
//   1. a worker in runs\ finished (last event turn.completed, or finished.txt) in the last 48 h
//      and has no runs\<name>\handled.txt saying what the NEXT step is (and that it was started);
//   2. a worker is still running and no waiter is alive (wait-workers.sh touches runs\.waiter-heartbeat
//      every 10 s; it must be fresher than 3 minutes), so nothing will wake Claude when it ends.
// The fix is to act: start the next tier, then write handled.txt; or arm a waiter.
import fs from "node:fs";
import path from "node:path";

const RUNS = "C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/runs";
const now = Date.now();
const H48 = 48 * 3600 * 1000;
let names = [];
try { names = fs.readdirSync(RUNS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { process.exit(0); }

const unhandled = [];
const running = [];
for (const n of names) {
  const dir = path.join(RUNS, n);
  const log = path.join(dir, "run.jsonl");
  let st;
  try { st = fs.statSync(log); } catch { continue; }
  if (now - st.mtimeMs > H48) continue;
  if (fs.existsSync(path.join(dir, "handled.txt"))) continue;
  let done = fs.existsSync(path.join(dir, "finished.txt"));
  if (!done) {
    try {
      const fd = fs.openSync(log, "r");
      const size = st.size, len = Math.min(size, 4096);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      const lines = buf.toString("utf8").trim().split("\n");
      done = /"type":"turn\.completed"/.test(lines[lines.length - 1] || "");
    } catch {}
  }
  if (done) unhandled.push(n);
  else running.push({ n, quietMin: Math.round((now - st.mtimeMs) / 60000) });
}

let waiterAlive = false;
try { waiterAlive = now - fs.statSync(path.join(RUNS, ".waiter-heartbeat")).mtimeMs < 3 * 60 * 1000; } catch {}

const problems = [];
if (unhandled.length) {
  problems.push(
    "These workers FINISHED and nothing was done with them: " + unhandled.join(", ") + ".\n" +
    "  Act now: read runs\\<name>\\last.txt, START the next step (dev, Test walk, gate, deploy, or a fix worker),\n" +
    "  then write runs\\<name>\\handled.txt with one line: the time, and the next step you started.",
  );
}
const stuck = running.filter((r) => r.quietMin >= 15);
if (stuck.length) {
  problems.push("These workers look STUCK (log quiet 15+ min): " + stuck.map((r) => `${r.n} (${r.quietMin} min)`).join(", ") + ". Diagnose and relaunch, or mark handled.txt if dead on purpose.");
}
if (running.length && !waiterAlive) {
  problems.push(
    "Workers are running (" + running.map((r) => r.n).join(", ") + ") and NO waiter is alive, so nothing will wake you when they end.\n" +
    "  Arm one in the background: bash C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/tools/wait-workers.sh <names>",
  );
}
if (!problems.length) process.exit(0);
console.error("BLOCKED by Scott's no-idle hook (tr-no-idle.mjs): you may not end this turn yet.\n- " + problems.join("\n- "));
process.exit(2);
