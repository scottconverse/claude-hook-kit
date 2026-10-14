import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HOOKS, makeProject, mkTemp, portReference, rimraf, runHook, writeText } from "./helpers.mjs";

const KIT = path.join(HOOKS, "wake.mjs");
const REF_RUNS = "C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/runs";
const REF_TOKENS = "C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/tools/worker-tokens.mjs";

function age(file, minutes) {
  const t = Date.now() / 1000 - minutes * 60;
  fs.utimesSync(file, t, t);
}

// The wake hook sleeps, then reports. A tiny delay comes from the minutes override file,
// which both hooks read out of the runs folder.
function fixture(spec, { seconds = 1 } = {}) {
  const dir = mkTemp("hook-kit-wake-");
  const runs = path.join(dir, "runs");
  fs.mkdirSync(runs, { recursive: true });
  writeText(path.join(runs, ".rewake-seconds"), String(seconds));
  for (const [name, w] of Object.entries(spec)) {
    const wd = path.join(runs, name);
    fs.mkdirSync(wd, { recursive: true });
    const log = writeText(path.join(wd, w.log || "run.jsonl"), w.body ?? "");
    if (w.ageMin) age(log, w.ageMin);
    if (w.handled) writeText(path.join(wd, "handled.txt"), "handled\n");
    if (w.finished) writeText(path.join(wd, "finished.txt"), "done\n");
  }
  const ref = portReference("tr-wake-20.mjs", [
    [REF_RUNS, runs.split(path.sep).join("/")],
    // The reference imports a TownReporter-only token module; drop the import so the copy runs
    // anywhere. The kit takes no token module in this fixture either.
    ['const { tokenInfo, tokenLine } = await import("file:///' + REF_TOKENS + '");', 'const tokenInfo = () => ({}); const tokenLine = () => "n/a";'],
  ], dir);
  const proj = makeProject({
    wake: {
      minutes: 20,
      runsDir: runs,
      logNames: ["run.jsonl", "stream.jsonl"],
      handledFile: "handled.txt",
      finishedFile: "finished.txt",
      quietMinutes: 15,
      lookbackHours: 48,
      timeZone: "America/Denver",
      timeZoneName: "Mountain",
      label: "TownReporter",
      hookName: "tr-wake-20.mjs",
      footer: "Check every worker and server; start the next step for anything finished; relaunch anything stalled; report to Scott in 3 lines.",
    },
  });
  return { dir, runs, ref, proj };
}

// The message wording differs by design (the kit names the project), so compare the
// substance: exit code and the per-worker verdicts.
function verdicts(stderr) {
  return stderr
    .split("\n")
    .filter((l) => /^(FINISHED-NOT-HANDLED|STALLED|RUNNING|No unhandled workers)/.test(l.trim()))
    .map((l) => l.trim())
    .sort();
}

const CASES = [
  {
    name: "a finished worker is reported as FINISHED-NOT-HANDLED",
    spec: { w1: { body: '{"type":"turn.completed"}\n', ageMin: 5 } },
    words: ["FINISHED-NOT-HANDLED", "w1"],
  },
  {
    name: "a stalled worker is reported as STALLED",
    spec: { w1: { body: "still going\n", ageMin: 40 } },
    words: ["STALLED", "w1"],
  },
  {
    name: "a running worker is reported as RUNNING",
    spec: { w1: { body: "still going\n", ageMin: 2 } },
    words: ["RUNNING", "w1"],
  },
  {
    name: "no workers reports nothing to do",
    spec: {},
    words: ["No unhandled workers."],
  },
  {
    name: "a handled worker is left out",
    spec: { w1: { body: '{"type":"turn.completed"}\n', ageMin: 5, handled: true } },
    words: ["No unhandled workers."],
  },
  {
    name: "stream.jsonl is read when run.jsonl is absent",
    spec: { w1: { log: "stream.jsonl", body: '{"type":"result"}\n', ageMin: 5 } },
    words: ["FINISHED-NOT-HANDLED", "w1"],
  },
];

for (const c of CASES) {
  test("wake parity: " + c.name, async () => {
    const f = fixture(c.spec, { seconds: 1 });
    try {
      const stdin = JSON.stringify({ hook_event_name: "Stop", cwd: f.proj.cwd });
      // Run them one after the other, each from a clean runs folder: the lock file makes the
      // hook a single sleeper, so two at once would legitimately have one stand down.
      const got = await runHook(KIT, stdin, { timeout: 30000 });
      fs.rmSync(path.join(f.runs, ".rewake-lock.json"), { force: true });
      const want = await runHook(f.ref, stdin, { timeout: 30000 });
      assert.equal(got.code, want.code, "exit code matches the reference");
      assert.equal(got.code, 2, "a wake always exits 2");
      assert.deepEqual(verdicts(got.stderr), verdicts(want.stderr), "same per-worker verdicts as the reference");
      assert.ok(got.stderr.includes("TownReporter"), "the message names the project");
      for (const w of c.words) assert.ok(got.stderr.includes(w), "stderr mentions " + w);
    } finally {
      rimraf(f.dir);
      rimraf(f.proj.root);
    }
  });
}

test("wake: a live sleeper's lock stops a second sleeper", async () => {
  const f = fixture({}, { seconds: 1 });
  try {
    // Leave a lock file owned by this very process, so it counts as alive with a long delay.
    writeText(path.join(f.runs, ".rewake-lock.json"), JSON.stringify({ pid: process.pid, started: Date.now(), wakeAt: new Date(Date.now() + 600000).toISOString() }));
    const stdin = JSON.stringify({ hook_event_name: "Stop", cwd: f.proj.cwd });
    const got = await runHook(KIT, stdin, { timeout: 15000 });
    assert.equal(got.code, 0, "the second sleeper stands down");
    assert.equal(got.stderr.trim(), "");
  } finally {
    rimraf(f.dir);
    rimraf(f.proj.root);
  }
});

test("wake: the sleeper removes its lock when it wakes", async () => {
  const f = fixture({}, { seconds: 1 });
  try {
    const stdin = JSON.stringify({ hook_event_name: "Stop", cwd: f.proj.cwd });
    const got = await runHook(KIT, stdin, { timeout: 30000 });
    assert.equal(got.code, 2);
    assert.equal(fs.existsSync(path.join(f.runs, ".rewake-lock.json")), false, "lock cleaned up");
  } finally {
    rimraf(f.dir);
    rimraf(f.proj.root);
  }
});
