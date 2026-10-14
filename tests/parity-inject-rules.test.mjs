import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HOOKS, makeProject, mkTemp, portReference, rimraf, runHook, writeText } from "./helpers.mjs";

const KIT = path.join(HOOKS, "inject-rules.mjs");
const REF_RULES = "C:/Users/scott/.claude/skills/townreporter-release-path/RULES.md";

// The reference reads one fixed rules file. Copy a rules file into temp and point a
// copy of the reference at it, so both hooks read the same text.
function fixture(rulesText) {
  const dir = mkTemp("hook-kit-inject-");
  const rules = writeText(path.join(dir, "RULES.md"), rulesText);
  const ref = portReference("tr-inject-rules.mjs", [[REF_RULES, rules.replace(/\\/g, "/")]], dir);
  const proj = makeProject({
    "inject-rules": {
      rulesFile: rules,
      heading: "SCOTT'S NEVER-FORGET RULES (from skill townreporter-release-path; obey every line, no exceptions):",
    },
  });
  return { dir, rules, ref, proj };
}

test("inject-rules parity: UserPromptSubmit injects the rules", async () => {
  const f = fixture("RULE ONE: never forget.\nRULE TWO: always walk.\n");
  try {
    const stdin = JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: f.proj.cwd, prompt: "hello" });
    const [got, want] = await Promise.all([runHook(KIT, stdin), runHook(f.ref, stdin)]);
    assert.equal(got.code, want.code);
    assert.equal(got.stdout, want.stdout);
    assert.ok(got.stdout.includes("SCOTT'S NEVER-FORGET RULES"));
    assert.ok(got.stdout.includes("RULE ONE: never forget."));
    assert.ok(got.stdout.includes('"hookEventName":"UserPromptSubmit"'));
  } finally {
    rimraf(f.dir);
    rimraf(f.proj.root);
  }
});

test("inject-rules parity: SessionStart carries its own event name", async () => {
  const f = fixture("RULE ONE: never forget.\n");
  try {
    const stdin = JSON.stringify({ hook_event_name: "SessionStart", cwd: f.proj.cwd, source: "startup" });
    const [got, want] = await Promise.all([runHook(KIT, stdin), runHook(f.ref, stdin)]);
    assert.equal(got.code, want.code);
    assert.equal(got.stdout, want.stdout);
    assert.ok(got.stdout.includes('"hookEventName":"SessionStart"'));
    assert.ok(got.stdout.includes("RULE ONE: never forget."));
  } finally {
    rimraf(f.dir);
    rimraf(f.proj.root);
  }
});

test("inject-rules parity: empty stdin still injects with the default event name", async () => {
  const f = fixture("RULE ONE: never forget.\n");
  try {
    // No stdin means no cwd in the event, so the kit falls back to the process
    // working directory. Run it from inside the project.
    const [got, want] = await Promise.all([
      runHook(KIT, "", { cwd: f.proj.cwd }),
      runHook(f.ref, "", { cwd: f.proj.cwd }),
    ]);
    assert.equal(got.code, want.code);
    assert.equal(got.stdout, want.stdout);
    assert.ok(got.stdout.includes('"hookEventName":"UserPromptSubmit"'));
  } finally {
    rimraf(f.dir);
    rimraf(f.proj.root);
  }
});

test("inject-rules parity: missing rules file injects nothing", async () => {
  const dir = mkTemp("hook-kit-inject-");
  try {
    const missing = path.join(dir, "nope", "RULES.md");
    const ref = portReference("tr-inject-rules.mjs", [[REF_RULES, missing.replace(/\\/g, "/")]], dir);
    const proj = makeProject({ "inject-rules": { rulesFile: missing } });
    const stdin = JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: proj.cwd });
    const [got, want] = await Promise.all([runHook(KIT, stdin), runHook(ref, stdin)]);
    assert.equal(got.code, 0);
    assert.equal(want.code, 0);
    assert.equal(got.stdout, "");
    assert.equal(want.stdout, "");
  } finally {
    rimraf(dir);
  }
});
