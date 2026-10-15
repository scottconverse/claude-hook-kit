import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { HOOKS, makeProject, mkTemp, rimraf, runHook } from "./helpers.mjs";

const HOOK = path.join(HOOKS, "db-write-guard.mjs");

// A write to the live port with no go file is blocked, so the block message is printed.
async function blockedMessage(section) {
  const dir = mkTemp("hook-kit-owner-");
  const proj = makeProject({
    "db-write-guard": { port: 5433, databases: ["townreporter"], clientPattern: "\\bpsql\\b", okFile: path.join(dir, "no-go.txt"), ...section },
  });
  try {
    const stdin = JSON.stringify({ tool_name: "Bash", cwd: proj.cwd, tool_input: { command: 'psql -p 5433 -d townreporter -c "INSERT INTO posts (t) VALUES (1)"' } });
    const got = await runHook(HOOK, stdin, { cwd: proj.cwd });
    assert.equal(got.code, 2, "the write is blocked");
    return got.stderr.replace(/\s+/g, " ").trim();
  } finally {
    rimraf(dir);
    rimraf(proj.root);
  }
}

test("db-write-guard ownerName: \"Scott\" puts Scott's name in the go line", async () => {
  const msg = await blockedMessage({ ownerName: "Scott" });
  assert.match(msg, /If Scott has said go in chat for this exact change/);
  assert.doesNotMatch(msg, /the owner/);
});

test("db-write-guard ownerName: a missing key says \"the owner\" and no name", async () => {
  const msg = await blockedMessage({});
  assert.match(msg, /If the owner has said go in chat for this exact change/);
  assert.doesNotMatch(msg, /Scott/);
});

test("db-write-guard ownerName: an empty value falls back to \"the owner\"", async () => {
  const msg = await blockedMessage({ ownerName: "" });
  assert.match(msg, /If the owner has said go in chat for this exact change/);
});
