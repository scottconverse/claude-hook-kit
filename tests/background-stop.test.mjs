import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { HOOKS, makeProject, rimraf, runHook } from "./helpers.mjs";

// Stop hooks are for a person's session. A background run (claude -p from a script)
// has CLAUDE_CODE_SESSION_ATTENDED=0 and its Stop hooks do nothing. Tool gates still run.
const DOUBLE = path.join(HOOKS, "double-check.mjs");
const WALK = path.join(HOOKS, "walk-brief-guard.mjs");
const stop = (cwd, ev = "Stop") => JSON.stringify({ hook_event_name: ev, cwd });

test("background stop: an unattended Stop is let through", async () => {
  const p = makeProject({ "double-check": {} });
  try {
    const got = await runHook(DOUBLE, stop(p.cwd), { cwd: p.cwd, env: { CLAUDE_CODE_SESSION_ATTENDED: "0" } });
    assert.equal(got.code, 0);
    assert.equal(got.stderr, "");
  } finally {
    rimraf(p.root);
  }
});

test("background stop: an unattended SubagentStop is let through", async () => {
  const p = makeProject({ "double-check": {} });
  try {
    const got = await runHook(DOUBLE, stop(p.cwd, "SubagentStop"), { cwd: p.cwd, env: { CLAUDE_CODE_SESSION_ATTENDED: "0" } });
    assert.equal(got.code, 0);
  } finally {
    rimraf(p.root);
  }
});

test("background stop: an attended Stop is still blocked", async () => {
  const p = makeProject({ "double-check": {} });
  try {
    const got = await runHook(DOUBLE, stop(p.cwd), { cwd: p.cwd, env: { CLAUDE_CODE_SESSION_ATTENDED: "1" } });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /^DOUBLE-CHECK/);
  } finally {
    rimraf(p.root);
  }
});

test("background stop: no attended flag at all counts as attended", async () => {
  const p = makeProject({ "double-check": {} });
  try {
    const got = await runHook(DOUBLE, stop(p.cwd), { cwd: p.cwd, env: { CLAUDE_CODE_SESSION_ATTENDED: "" } });
    assert.equal(got.code, 2);
  } finally {
    rimraf(p.root);
  }
});

test("background stop: a tool gate still blocks in an unattended run", async () => {
  const p = makeProject({ "walk-brief-guard": { pathPattern: "walk-", bannedPatterns: [{ pattern: "do not publish", message: "no" }] } });
  try {
    const ev = JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: p.cwd,
      tool_name: "Write",
      tool_input: { file_path: path.join(p.cwd, "walk-x.md"), content: "Do not publish this story." },
    });
    const attended = await runHook(WALK, ev, { cwd: p.cwd, env: { CLAUDE_CODE_SESSION_ATTENDED: "1" } });
    const unattended = await runHook(WALK, ev, { cwd: p.cwd, env: { CLAUDE_CODE_SESSION_ATTENDED: "0" } });
    assert.equal(attended.code, 2);
    assert.equal(unattended.code, 2);
    assert.equal(unattended.stdout + unattended.stderr, attended.stdout + attended.stderr);
  } finally {
    rimraf(p.root);
  }
});
