import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HOOKS, makeProject, mkTemp, portReference, rimraf, runHook, writeText } from "./helpers.mjs";

const KIT = path.join(HOOKS, "no-idle.mjs");
const REF_RUNS = "C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/runs";
const REF_WAITER_HINT = "bash C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/tools/wait-workers.sh <names>";

// Old mtime, in minutes back from now.
function age(file, minutes) {
  const t = Date.now() / 1000 - minutes * 60;
  fs.utimesSync(file, t, t);
}

// Build a runs folder out of { name: { log, lastLine, handled, finished, ageMin } }.
function makeRuns(dir, spec) {
  const runs = path.join(dir, "runs");
  fs.mkdirSync(runs, { recursive: true });
  for (const [name, w] of Object.entries(spec)) {
    const wd = path.join(runs, name);
    fs.mkdirSync(wd, { recursive: true });
    if (w !== null) {
      const log = writeText(path.join(wd, w.log || "run.jsonl"), w.body ?? "");
      if (w.ageMin) age(log, w.ageMin);
      if (w.handled) writeText(path.join(wd, "handled.txt"), "handled\n");
      if (w.finished) writeText(path.join(wd, "finished.txt"), "done\n");
    }
  }
  return runs;
}

// The reference reads its own heartbeat file; the kit takes a waiterCheck command.
// Point both at the same heartbeat file inside the temp runs dir.
function fixture(spec, { heartbeatAgeMin = null } = {}) {
  const dir = mkTemp("hook-kit-noidle-");
  const runs = makeRuns(dir, spec);
  const hb = path.join(runs, ".waiter-heartbeat");
  if (heartbeatAgeMin !== null) {
    writeText(hb, "beat\n");
    age(hb, heartbeatAgeMin);
  }
  const ref = portReference("tr-no-idle.mjs", [
    [REF_RUNS, runs.replace(/\\/g, "/")],
    ["bash C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/tools/wait-workers.sh <names>", "WAITER-HINT"],
    // These are the source-text forms (a doubled backslash inside the JS string literal).
    ["runs\\\\<name>\\\\last.txt", "LAST-TXT"],
    ["runs\\\\<name>\\\\handled.txt", "HANDLED-TXT"],
  ], dir);
  const proj = makeProject({
    "no-idle": {
      runsDir: runs,
      logNames: ["run.jsonl"],
      handledFile: "handled.txt",
      finishedFile: "finished.txt",
      quietMinutes: 15,
      lookbackHours: 48,
      waiterHeartbeat: hb,
      waiterFreshMinutes: 3,
      waiterHint: "WAITER-HINT",
      handledHint: "Act now: read LAST-TXT, START the next step (dev, Test walk, gate, deploy, or a fix worker),\n  then write HANDLED-TXT with one line: the time, and the next step you started.",
      stuckHint: "Diagnose and relaunch, or mark handled.txt if dead on purpose.",
      hookName: "tr-no-idle.mjs",
    },
  });
  return { dir, runs, hb, ref, proj };
}

// Compare only the substance: exit code, and the worker names and verdict words, since the
// kit's hint text comes from config and the reference's is hard-coded.
function verdict(stderr) {
  const words = ["FINISHED", "STUCK", "waiter", "handled", "BLOCKED", "no-idle"];
  return words.filter((w) => stderr.toLowerCase().includes(w.toLowerCase())).sort();
}

const CASES = [
  {
    name: "a finished worker with no handled.txt blocks",
    spec: { w1: { body: '{"type":"turn.completed"}\n', ageMin: 5 } },
    heartbeat: null,
    blocked: true,
    words: ["FINISHED", "w1"],
  },
  {
    name: "a finished worker with handled.txt is fine",
    spec: { w1: { body: '{"type":"turn.completed"}\n', ageMin: 5, handled: true } },
    heartbeat: null,
    blocked: false,
  },
  {
    name: "finished.txt makes a worker finished even with a quiet log",
    spec: { w1: { body: "working...\n", ageMin: 5, finished: true } },
    heartbeat: null,
    blocked: true,
    words: ["FINISHED", "w1"],
  },
  {
    name: "a stalled worker blocks",
    spec: { w1: { body: "still going\n", ageMin: 40 } },
    heartbeat: 0,
    blocked: true,
    words: ["STUCK", "w1"],
  },
  {
    name: "a running worker with a dead waiter blocks",
    spec: { w1: { body: "still going\n", ageMin: 2 } },
    heartbeat: 30,
    blocked: true,
    words: ["w1"],
  },
  {
    name: "a running worker with a live waiter and a fresh log is fine",
    spec: { w1: { body: "still going\n", ageMin: 2 } },
    heartbeat: 0,
    blocked: false,
  },
  {
    name: "an empty runs folder is fine",
    spec: {},
    heartbeat: null,
    blocked: false,
  },
  {
    name: "a worker whose log is older than the lookback is ignored",
    spec: { w1: { body: '{"type":"turn.completed"}\n', ageMin: 60 * 72 } },
    heartbeat: null,
    blocked: false,
  },
  // tr-no-idle.mjs reads only run.jsonl (stream.jsonl is the wake hook's), so a worker with
  // only a stream log is invisible to both hooks. The example config lists ["run.jsonl"].
  {
    name: "a worker with only stream.jsonl is invisible to both",
    spec: { w1: { log: "stream.jsonl", body: '{"type":"turn.completed"}\n', ageMin: 5 } },
    heartbeat: null,
    blocked: false,
  },
  {
    name: "two finished workers are both named",
    spec: {
      a: { body: '{"type":"turn.completed"}\n', ageMin: 5 },
      b: { body: '{"type":"turn.completed"}\n', ageMin: 6 },
    },
    heartbeat: null,
    blocked: true,
    words: ["FINISHED", "a", "b"],
  },
];

for (const c of CASES) {
  test("no-idle parity: " + c.name, async () => {
    const f = fixture(c.spec, { heartbeatAgeMin: c.heartbeat });
    try {
      const stdin = JSON.stringify({ hook_event_name: "Stop", cwd: f.proj.cwd });
      const [got, want] = await Promise.all([runHook(KIT, stdin), runHook(f.ref, stdin)]);
      assert.equal(got.code, want.code, "exit code matches the reference");
      assert.equal(got.code, c.blocked ? 2 : 0);
      assert.deepEqual(verdict(got.stderr), verdict(want.stderr), "same verdict words as the reference");
      if (c.words) for (const w of c.words) assert.ok(got.stderr.includes(w), "stderr mentions " + w);
    } finally {
      rimraf(f.dir);
      rimraf(f.proj.root);
    }
  });
}
