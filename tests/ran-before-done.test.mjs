import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HOOKS, REFERENCE, makeProject, mkTemp, rimraf, runHook } from "./helpers.mjs";

const HOOK = path.join(HOOKS, "ran-before-done.mjs");
const REF = path.join(REFERENCE, "dev-rigor-ground.js");

const post = (tool, input, cwd, sid = "s1") => JSON.stringify({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, cwd, session_id: sid });
const stop = (cwd, sid = "s1", extra = {}) => JSON.stringify({ hook_event_name: "Stop", cwd, session_id: sid, ...extra });

test("ran-before-done: edits with zero executions block the stop once, then let it end", async () => {
  const p = makeProject({ "ran-before-done": { label: "Demo" } });
  try {
    let got = await runHook(HOOK, post("Write", { file_path: path.join(p.root, "src", "app.mjs") }, p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0);
    got = await runHook(HOOK, post("Edit", { file_path: path.join(p.root, "README.md") }, p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0, "a doc edit is not a runnable edit");
    got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /^RAN-BEFORE-DONE \(Demo\): you edited runnable file\(s\) \(\.mjs\) this session but never executed/);
    const ledger = fs.readFileSync(path.join(p.root, ".claude", "state", "ran-s1.log"), "utf8");
    assert.equal(ledger, "E.mjs\nB\n");
    got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0, "one block per session");
    assert.equal(got.stderr, "");
  } finally {
    rimraf(p.root);
  }
});

test("ran-before-done: any non-edit tool reaching the hook counts as execution; a continuation stop passes", async () => {
  const p = makeProject({ "ran-before-done": {} });
  try {
    await runHook(HOOK, post("Write", { file_path: path.join(p.root, "x.py") }, p.cwd), { cwd: p.cwd });
    await runHook(HOOK, post("Bash", { command: "python x.py" }, p.cwd), { cwd: p.cwd });
    let got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0, got.stderr);
    // A different session with an edit and no run, but a continuation stop.
    await runHook(HOOK, post("Write", { file_path: path.join(p.root, "y.ps1") }, p.cwd, "s2"), { cwd: p.cwd });
    got = await runHook(HOOK, stop(p.cwd, "s2", { stop_hook_active: true }), { cwd: p.cwd });
    assert.equal(got.code, 0, got.stderr);
    got = await runHook(HOOK, stop(p.cwd, "s2"), { cwd: p.cwd });
    assert.equal(got.code, 2, "the real stop of s2 is still caught");
  } finally {
    rimraf(p.root);
  }
});

test("ran-before-done: no session_id records and blocks nothing; stateDir and runnablePattern are configurable", async () => {
  const p = makeProject({ "ran-before-done": { stateDir: "work/.state", runnablePattern: "\\.(sql|txt)$" } });
  try {
    let got = await runHook(HOOK, JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(p.root, "a.sql") }, cwd: p.cwd }), { cwd: p.cwd });
    assert.equal(got.code, 0);
    got = await runHook(HOOK, JSON.stringify({ hook_event_name: "Stop", cwd: p.cwd }), { cwd: p.cwd });
    assert.equal(got.code, 0);
    assert.equal(fs.existsSync(path.join(p.root, "work", ".state")), false, "nothing written without a session");
    await runHook(HOOK, post("Write", { file_path: path.join(p.root, "a.sql") }, p.cwd), { cwd: p.cwd });
    await runHook(HOOK, post("Write", { file_path: path.join(p.root, "a.mjs") }, p.cwd), { cwd: p.cwd });
    got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /\(\.sql\)/, "only the custom pattern counts");
    assert.ok(fs.existsSync(path.join(p.root, "work", ".state", "ran-s1.log")));
  } finally {
    rimraf(p.root);
  }
});

test("ran-before-done: off when the section is missing or enabled is false", async () => {
  for (const config of [{ "inject-rules": {} }, { "ran-before-done": { enabled: false } }, { enabled: false, "ran-before-done": {} }]) {
    const p = makeProject(config);
    try {
      await runHook(HOOK, post("Write", { file_path: path.join(p.root, "x.mjs") }, p.cwd), { cwd: p.cwd });
      const got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
      assert.equal(got.code, 0, JSON.stringify(config));
      assert.equal(got.stderr, "");
      assert.equal(fs.existsSync(path.join(p.root, ".claude", "state")), false);
    } finally {
      rimraf(p.root);
    }
  }
});

// The reference blocks by printing {"decision":"block"} on stdout with exit 0;
// the kit blocks with exit 2. Compare the decision, not the channel.
test("parity: the kit and reference/dev-rigor-ground.js make the same block decisions over the same tool sequence", async () => {
  const p = makeProject({ "ran-before-done": {} });
  const cfg = mkTemp("hook-kit-cfg-");
  // The original is CommonJS; this package is type:module, so run a .cjs copy. reference/ is untouched.
  const ref = path.join(cfg, "dev-rigor-ground.cjs");
  fs.copyFileSync(REF, ref);
  const refRun = async (mode, stdin) => {
    const r = await runHook(ref, stdin, { args: [mode], env: { CLAUDE_CONFIG_DIR: cfg }, cwd: p.cwd });
    assert.equal(r.code, 0, r.stderr);
    return /"decision":"block"/.test(r.stdout);
  };
  const kitRun = async (stdin) => (await runHook(HOOK, stdin, { cwd: p.cwd })).code === 2;
  try {
    const steps = [
      ["record", post("Write", { file_path: path.join(p.root, "a.tsx") }, p.cwd)],
      ["record", post("Edit", { file_path: path.join(p.root, "notes.md") }, p.cwd)],
      ["check", stop(p.cwd), true],
      ["check", stop(p.cwd), false],
      ["record", post("Write", { file_path: path.join(p.root, "b.rs") }, p.cwd, "s2")],
      ["check", stop(p.cwd, "s2", { stop_hook_active: true }), false],
      ["record", post("Bash", { command: "cargo test" }, p.cwd, "s2")],
      ["check", stop(p.cwd, "s2"), false],
      ["record", post("Write", { file_path: path.join(p.root, "c.go") }, p.cwd, "s3")],
      ["check", stop(p.cwd, "s3"), true],
    ];
    for (const [mode, stdin, expected] of steps) {
      const ref = await refRun(mode, stdin);
      const kit = await kitRun(stdin);
      if (mode === "check") {
        assert.equal(kit, expected, "kit: " + stdin);
        assert.equal(ref, expected, "reference: " + stdin);
      }
    }
  } finally {
    rimraf(p.root);
    rimraf(cfg);
  }
});
