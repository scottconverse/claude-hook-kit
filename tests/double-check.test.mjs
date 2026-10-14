import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { HOOKS, makeProject, rimraf, runHook, writeText } from "./helpers.mjs";

const HOOK = path.join(HOOKS, "double-check.mjs");
const stop = (cwd, extra = {}) => JSON.stringify({ hook_event_name: "Stop", cwd, ...extra });

test("double-check: the first stop of a turn is blocked with the checklist", async () => {
  const p = makeProject({ "double-check": { quote: 'Owner: "Check everything twice."', label: "Demo" } });
  try {
    const got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /^DOUBLE-CHECK \(Demo\)/);
    assert.match(got.stderr, /Owner: "Check everything twice\."/);
    assert.match(got.stderr, /1\. Re-read every file you wrote or changed/);
    assert.match(got.stderr, /Checked twice:/);
    assert.equal(got.stdout, "");
  } finally {
    rimraf(p.root);
  }
});

test("double-check: the second stop (stop_hook_active) is let through, so it never loops", async () => {
  const p = makeProject({ "double-check": {} });
  try {
    const got = await runHook(HOOK, stop(p.cwd, { stop_hook_active: true }), { cwd: p.cwd });
    assert.equal(got.code, 0);
    assert.equal(got.stderr, "");
  } finally {
    rimraf(p.root);
  }
});

test("double-check: a custom checklist replaces the default", async () => {
  const p = makeProject({ "double-check": { checklist: ["Open the diff.", "Run the test."] } });
  try {
    const got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /1\. Open the diff\.\n2\. Run the test\./);
    assert.doesNotMatch(got.stderr, /Re-read every file/);
  } finally {
    rimraf(p.root);
  }
});

test("double-check: minToolCalls skips a turn with fewer tool calls, and asks after a busy one", async () => {
  const p = makeProject({ "double-check": { minToolCalls: 2 } });
  try {
    const user = { type: "user", message: { content: [{ type: "text", text: "do it" }] } };
    const call = { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } };
    const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } };
    const quiet = writeText(path.join(p.root, "quiet.jsonl"), [user, call, result].map((m) => JSON.stringify(m)).join("\n"));
    const busy = writeText(path.join(p.root, "busy.jsonl"), [user, call, result, call, result].map((m) => JSON.stringify(m)).join("\n"));
    assert.equal((await runHook(HOOK, stop(p.cwd, { transcript_path: quiet }), { cwd: p.cwd })).code, 0, "1 call < 2: let through");
    assert.equal((await runHook(HOOK, stop(p.cwd, { transcript_path: busy }), { cwd: p.cwd })).code, 2, "2 calls: ask");
    assert.equal(
      (await runHook(HOOK, stop(p.cwd, { transcript_path: path.join(p.root, "missing.jsonl") }), { cwd: p.cwd })).code,
      2,
      "unreadable transcript: ask anyway",
    );
  } finally {
    rimraf(p.root);
  }
});

test("double-check: off when its section is missing or enabled is false", async () => {
  for (const config of [{ "inject-rules": {} }, { "double-check": { enabled: false } }, { enabled: false, "double-check": {} }]) {
    const p = makeProject(config);
    try {
      const got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
      assert.equal(got.code, 0, JSON.stringify(config));
      assert.equal(got.stderr, "");
    } finally {
      rimraf(p.root);
    }
  }
});

test("relative paths in a config resolve against the config's own folder", async () => {
  // Every hook that reads a path calls resolveIn(section.cfg, ...). Before the fix, section.cfg
  // was undefined and a relative path crashed the hook (exit 1). The minimal example uses them.
  const p = makeProject({ "inject-rules": { rulesFile: ".claude/RULES.md", heading: "R:" } });
  try {
    writeText(path.join(p.root, ".claude", "RULES.md"), "rule one\n");
    const got = await runHook(
      path.join(HOOKS, "inject-rules.mjs"),
      JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: p.cwd }),
      { cwd: p.cwd },
    );
    assert.equal(got.code, 0, got.stderr);
    assert.match(got.stdout, /"additionalContext":"R:\\nrule one\\n"/);
  } finally {
    rimraf(p.root);
  }
});
