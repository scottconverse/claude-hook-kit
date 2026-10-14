// Stop hook with "asyncRewake": true. Every time a turn ends this starts in the background,
// waits `minutes`, then exits 2 -> Claude wakes up with the worker status below.
// Port of reference/tr-wake-20.mjs.
// Only one sleeper at a time: a lock file holds the live sleeper's pid and start time.
// Config section "wake":
//   minutes            wait before the wake-up (20 today); a `<minutesFile>` in runsDir overrides it
//   runsDir            folder of worker folders
//   logNames           ["run.jsonl", "stream.jsonl"]
//   lockFile           default ".rewake-lock.json" inside runsDir
//   minutesFile        default ".rewake-seconds" inside runsDir
//   handledFile        default "handled.txt"
//   quietMinutes       default 15
//   timeZone / label   used in the message
import fs from "node:fs";
import path from "node:path";
import { loadFromStdin, resolveIn } from "../lib/config.mjs";

const { section } = loadFromStdin("wake");
if (!section) process.exit(0);
try {
  fs.readFileSync(0);
} catch {}

const s = section;
const runsDir = resolveIn(section.cfg, s.runsDir);
if (!runsDir) process.exit(0);
const lockFile = String(s.lockFile || ".rewake-lock.json");
const LOCK = path.join(runsDir, lockFile);
const minutesFile = resolveIn(section.cfg, s.minutesFile || path.join(runsDir, ".rewake-seconds"));
const minutes = Number(s.minutes ?? 20);
const override = (() => {
  try {
    return Number(fs.readFileSync(minutesFile, "utf8").trim());
  } catch {
    return 0;
  }
})();
const DELAY_MS = (override > 0 ? override : minutes * 60) * 1000;

const logNames = Array.isArray(s.logNames) && s.logNames.length ? s.logNames : ["run.jsonl", "stream.jsonl"];
const handledFile = String(s.handledFile || "handled.txt");
const finishedFile = String(s.finishedFile || "finished.txt");
const quietMinutes = Number(s.quietMinutes ?? 15);
const label = String(s.label || path.basename(section.cfg.dir));
const hookName = String(s.hookName || "wake");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
try {
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  if (lock.pid !== process.pid && alive(lock.pid) && Date.now() - lock.started < DELAY_MS + 120000) process.exit(0);
} catch {}
try {
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started: Date.now(), wakeAt: new Date(Date.now() + DELAY_MS).toISOString() }));
} catch {
  process.exit(0); // cannot arm without a lock: do nothing rather than wake twice
}

await new Promise((r) => setTimeout(r, DELAY_MS));

// Status of every recent worker (same rules as the no-idle hook).
const now = Date.now();
const lines = [];
try {
  for (const d of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(runsDir, d.name);
    const log = logNames.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (!log) continue;
    let st;
    try {
      st = fs.statSync(log);
    } catch {
      continue;
    }
    if (now - st.mtimeMs > Number(s.lookbackHours ?? 48) * 3600 * 1000 || fs.existsSync(path.join(dir, handledFile))) continue;
    let tail = "";
    try {
      const b = fs.readFileSync(log);
      tail = b.subarray(Math.max(0, b.length - 4096)).toString("utf8");
    } catch {}
    const last = tail.trim().split("\n").pop() || "";
    const done = fs.existsSync(path.join(dir, finishedFile)) || /"type":"turn\.completed"/.test(last) || /"type":"result"/.test(tail);
    const quiet = Math.round((now - st.mtimeMs) / 60000);
    lines.push(done ? "FINISHED-NOT-HANDLED " + d.name : quiet >= quietMinutes ? "STALLED " + d.name + " (quiet " + quiet + " min)" : "RUNNING " + d.name + " (quiet " + quiet + " min)");
    if (s.tokenModule) {
      try {
        const mod = await import(new URL("file:///" + resolveIn(section.cfg, s.tokenModule).replace(/\\/g, "/")).href);
        lines.push("   tokens: " + mod.tokenLine(mod.tokenInfo(d.name)));
      } catch (e) {
        lines.push("   tokens: ? (" + e.message + ")");
      }
    }
  }
} catch {}
try {
  fs.unlinkSync(LOCK);
} catch {}
const t = new Date().toLocaleTimeString("en-US", { timeZone: String(s.timeZone || "America/Denver"), hour: "numeric", minute: "2-digit" });
const zoneName = String(s.timeZoneName || "Mountain");
console.error(
  minutes + "-MINUTE WAKE-UP (" + t + " " + zoneName + ", hook " + hookName + ", project " + label + "). Check now.\n" +
    (lines.length ? lines.join("\n") : "No unhandled workers.") +
    "\n" + String(s.footer || "Check every worker and server; start the next step for anything finished; relaunch anything stalled."),
);
process.exit(2);
