import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOOKS, makeProject, mkTemp, rimraf, runHook, writeJson, writeText } from "./helpers.mjs";

const ALL = ["inject-rules.mjs", "deploy-gate.mjs", "walk-brief-guard.mjs", "db-write-guard.mjs", "no-idle.mjs", "wake.mjs"];

// Inputs that would make each hook block if it were awake. With the kit off, none may.
const TRIGGERS = {
  "inject-rules.mjs": JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" }),
  "deploy-gate.mjs": JSON.stringify({ tool_name: "Bash", tool_input: { command: "pwsh -File deploy-production.ps1" } }),
  "walk-brief-guard.mjs": JSON.stringify({ tool_name: "Write", tool_input: { file_path: "briefs/walk-x.md", content: "Do not publish." } }),
  "db-write-guard.mjs": JSON.stringify({ tool_name: "Bash", tool_input: { command: 'psql -p 5433 -d townreporter -c "DROP TABLE posts"' } }),
  "no-idle.mjs": JSON.stringify({ hook_event_name: "Stop" }),
  "wake.mjs": JSON.stringify({ hook_event_name: "Stop" }),
};

// A cwd with no .claude/hook-kit.json anywhere above it. The temp root qualifies on Windows,
// but the kit walks to the filesystem root, so a config in a real ancestor would defeat this;
// the temp dir tree is checked to be clean of one first.
function assertNoConfigAbove(dir) {
  let d = path.resolve(dir);
  for (;;) {
    assert.equal(fs.existsSync(path.join(d, ".claude", "hook-kit.json")), false, "test cwd must have no config above it: " + d);
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
}

test("scope: with no config, every hook exits 0 and prints nothing", async () => {
  const dir = mkTemp("hook-kit-nocfg-");
  try {
    assertNoConfigAbove(dir);
    for (const name of ALL) {
      const got = await runHook(path.join(HOOKS, name), TRIGGERS[name], { cwd: dir, timeout: 20000 });
      assert.equal(got.code, 0, name + " exits 0");
      assert.equal(got.stdout, "", name + " prints nothing on stdout");
      assert.equal(got.stderr, "", name + " prints nothing on stderr");
    }
  } finally {
    rimraf(dir);
  }
});

test("scope: a config with enabled false switches the whole kit off", async () => {
  const dir = mkTemp("hook-kit-off-");
  // A config that would otherwise be loud: a real rules file and a live-looking runs folder.
  const rules = writeText(path.join(dir, "RULES.md"), "RULE: obey me.\n");
  const runs = path.join(dir, "runs");
  fs.mkdirSync(path.join(runs, "w1"), { recursive: true });
  writeText(path.join(runs, "w1", "run.jsonl"), '{"type":"turn.completed"}\n');
  const proj = makeProject({
    enabled: false,
    "inject-rules": { rulesFile: rules },
    "deploy-gate": { commandPattern: "deploy-production[.]ps1", gatesDir: path.join(dir, "gates"), repoDir: dir },
    "walk-brief-guard": { pathPattern: "walk-.*[.]md" },
    "db-write-guard": { port: 5433, databases: ["townreporter"], okFile: path.join(dir, "ok.txt") },
    "no-idle": { runsDir: runs },
    wake: { minutes: 1, runsDir: runs },
  });
  try {
    for (const name of ALL) {
      const got = await runHook(path.join(HOOKS, name), TRIGGERS[name], { cwd: proj.cwd, timeout: 20000 });
      assert.equal(got.code, 0, name + " exits 0 when the kit is off");
      assert.equal(got.stdout, "", name + " prints nothing on stdout");
      assert.equal(got.stderr, "", name + " prints nothing on stderr");
    }
  } finally {
    rimraf(dir);
    rimraf(proj.root);
  }
});

test("scope: a missing section switches only that hook off", async () => {
  const dir = mkTemp("hook-kit-section-");
  const runs = path.join(dir, "runs");
  fs.mkdirSync(path.join(runs, "w1"), { recursive: true });
  writeText(path.join(runs, "w1", "run.jsonl"), '{"type":"turn.completed"}\n');
  // no-idle is configured and must block; wake has no section and must stay quiet.
  const proj = makeProject({ "no-idle": { runsDir: runs, waiterHint: "W", handledHint: "H", stuckHint: "S" } });
  try {
    const blocked = await runHook(path.join(HOOKS, "no-idle.mjs"), TRIGGERS["no-idle.mjs"], { cwd: proj.cwd, timeout: 20000 });
    assert.equal(blocked.code, 2, "the configured hook blocks");
    const off = await runHook(path.join(HOOKS, "wake.mjs"), TRIGGERS["wake.mjs"], { cwd: proj.cwd, timeout: 20000 });
    assert.equal(off.code, 0, "the hook with no section does nothing");
    assert.equal(off.stderr, "");
    const alsoOff = await runHook(path.join(HOOKS, "inject-rules.mjs"), TRIGGERS["inject-rules.mjs"], { cwd: proj.cwd, timeout: 20000 });
    assert.equal(alsoOff.code, 0);
    assert.equal(alsoOff.stdout, "");
  } finally {
    rimraf(dir);
    rimraf(proj.root);
  }
});

test("scope: the nearest config up the tree wins", async () => {
  const outer = mkTemp("hook-kit-outer-");
  const outerRules = writeText(path.join(outer, "OUTER-RULES.md"), "OUTER RULE\n");
  writeJson(path.join(outer, ".claude", "hook-kit.json"), {
    "inject-rules": { rulesFile: outerRules, heading: "OUTER:" },
  });
  const inner = path.join(outer, "inner");
  const innerRules = writeText(path.join(inner, "INNER-RULES.md"), "INNER RULE\n");
  writeJson(path.join(inner, ".claude", "hook-kit.json"), {
    "inject-rules": { rulesFile: innerRules, heading: "INNER:" },
  });
  const cwd = path.join(inner, "deep", "down");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const got = await runHook(path.join(HOOKS, "inject-rules.mjs"), JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd }), { cwd, timeout: 20000 });
    assert.equal(got.code, 0);
    assert.ok(got.stdout.includes("INNER RULE"), "the nearest config is used");
    assert.ok(!got.stdout.includes("OUTER RULE"), "the ancestor config is not used");
  } finally {
    rimraf(outer);
  }
});

test("scope: cwd comes from the hook event, not the process", async () => {
  // Run the hook from an unrelated folder but pass a cwd that has a config.
  const proj = makeProject({ "inject-rules": { rulesFile: writeText(path.join(os.tmpdir(), "hook-kit-cwd-rules.md"), "FROM CWD\n"), heading: "H:" } });
  const elsewhere = mkTemp("hook-kit-elsewhere-");
  try {
    const got = await runHook(path.join(HOOKS, "inject-rules.mjs"), JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: proj.cwd }), { cwd: elsewhere, timeout: 20000 });
    assert.equal(got.code, 0);
    assert.ok(got.stdout.includes("FROM CWD"), "the event cwd drove the lookup");
  } finally {
    rimraf(proj.root);
    rimraf(elsewhere);
  }
});
