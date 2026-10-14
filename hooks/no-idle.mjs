// Stop hook: Claude may not end a turn while the project's workers are unarmed.
// Port of reference/tr-no-idle.mjs. Blocks (exit 2) when:
//   1. a worker in runsDir finished (last event turn.completed, or finished.txt) inside the
//      lookback window and has no handled.txt saying what the NEXT step is;
//   2. a worker looks stuck (log quiet quietMinutes or more);
//   3. a worker is running and no waiter is alive (waiterCheck command says nothing).
// Config section "no-idle": { runsDir, logNames, quietMinutes, handledFile, waiterCheck, ... }
import fs from "node:fs";
import path from "node:path";
import { loadFromStdin, resolveIn } from "../lib/config.mjs";

const { section } = loadFromStdin("no-idle");
if (!section) process.exit(0);

const runsDir = resolveIn(section.cfg, section.runsDir);
if (!runsDir) process.exit(0);

const logNames = Array.isArray(section.logNames) && section.logNames.length ? section.logNames : ["run.jsonl", "stream.jsonl"];
const handledFile = String(section.handledFile || "handled.txt");
const finishedFile = String(section.finishedFile || "finished.txt");
const quietMinutes = Number(section.quietMinutes ?? 15);
const lookbackHours = Number(section.lookbackHours ?? 48);
const handledHint = String(section.handledHint || "");
const stuckHint = String(section.stuckHint || "Diagnose and relaunch, or mark it handled on purpose.");
const waiterHint = String(section.waiterHint || "");
const header = String(section.header || "you may not end this turn yet.");

const now = Date.now();
const H = lookbackHours * 3600 * 1000;

let names = [];
try {
  names = fs.readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
} catch {
  process.exit(0); // no runs folder: nothing to check
}

// Newest log for a worker, mirroring the reference's find()-first-match order.
function logFor(dir) {
  for (const f of logNames) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Last non-empty line of the tail of a file.
function tailLast(p, st) {
  try {
    const fd = fs.openSync(p, "r");
    const size = st ? st.size : fs.fstatSync(fd).size;
    const len = Math.min(size, 4096);
    const buf = Buffer.alloc(len);
    if (len) fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").trim().split("\n").pop() || "";
  } catch {
    return "";
  }
}

const unhandled = [];
const running = [];
for (const n of names) {
  const dir = path.join(runsDir, n);
  const handledPath = path.join(dir, handledFile);
  // First log name that exists wins, in config order -- the same rule as the reference.
  const log = logFor(dir);
  if (!log) continue;
  let st;
  try {
    st = fs.statSync(log);
  } catch {
    continue;
  }
  if (now - st.mtimeMs > H) continue;
  if (fs.existsSync(handledPath)) continue;
  let done = fs.existsSync(path.join(dir, finishedFile));
  if (!done) done = /"type":"turn\.completed"/.test(tailLast(log, st));
  if (done) unhandled.push(n);
  else running.push({ n, quietMin: Math.round((now - st.mtimeMs) / 60000) });
}

// Waiter liveness: the reference stats a heartbeat file newer than 3 minutes.
// waiterHeartbeat is a file path; a waiter that is alive keeps touching it.
// waiterCheck is an optional escape hatch: a command that exits 0 when a waiter is alive.
// It is spawned directly, with no shell quoting, so a bad command fails closed.
let waiterAlive = false;
let waiterKnown = false;
if (section.waiterHeartbeat) {
  try {
    waiterAlive = now - fs.statSync(resolveIn(section.cfg, section.waiterHeartbeat)).mtimeMs < Number(section.waiterFreshMinutes ?? 3) * 60 * 1000;
  } catch {
    waiterAlive = false; // no heartbeat file yet: nothing is watching
  }
  waiterKnown = true;
} else if (section.waiterCheck) {
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync(String(section.waiterCheck), Array.isArray(section.waiterCheckArgs) ? section.waiterCheckArgs.map(String) : [], { stdio: "ignore" });
    waiterAlive = true;
  } catch {
    waiterAlive = false;
  }
  waiterKnown = true;
}

const problems = [];
if (unhandled.length) {
  problems.push(
    "These workers FINISHED and nothing was done with them: " + unhandled.join(", ") + ".\n" +
      (handledHint
        ? "  " + handledHint
        : "  Act now: START the next step, then write " + handledFile + " in the worker's folder with one line: the time, and the next step you started."),
  );
}
const stuck = running.filter((r) => r.quietMin >= quietMinutes);
if (stuck.length) {
  problems.push("These workers look STUCK (log quiet " + quietMinutes + "+ min): " + stuck.map((r) => r.n + " (" + r.quietMin + " min)").join(", ") + ". " + stuckHint);
}
if (running.length && waiterKnown && !waiterAlive) {
  problems.push(
    "Workers are running (" + running.map((r) => r.n).join(", ") + ") and NO waiter is alive, so nothing will wake you when they end.\n" +
      (waiterHint ? "  " + waiterHint : ""),
  );
}
if (!problems.length) process.exit(0);

const name = String(section.hookName || "no-idle");
process.stderr.write("BLOCKED by the no-idle hook (" + name + "): " + header + "\n- " + problems.join("\n- ") + "\n");
process.exit(2);
