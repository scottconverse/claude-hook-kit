import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HOOKS, makeProject, rimraf, runHook, writeText } from "./helpers.mjs";

const HOOK = path.join(HOOKS, "measure-gate.mjs");
let n = 0;
const stop = (cwd, extra = {}) => JSON.stringify({ hook_event_name: "Stop", cwd, session_id: "mg-test-" + process.pid + "-" + n++, ...extra });
const touch = (file, when) => fs.utimesSync(file, when, when);
const ago = (secs) => new Date(Date.now() - secs * 1000);

function project(extra = {}) {
  const p = makeProject({ "measure-gate": { receiptDir: "receipts", receiptPattern: "^receipt-.*\\.json$", measureCommand: "node measure.mjs", label: "Demo", ...extra } });
  const code = writeText(path.join(p.root, "src", "app.ts"), "x\n");
  fs.mkdirSync(path.join(p.root, "receipts"), { recursive: true });
  return { ...p, code };
}

test("measure-gate: code newer than the newest receipt blocks the stop, with the command", async () => {
  const p = project();
  try {
    const r = writeText(path.join(p.root, "receipts", "receipt-1.json"), "{\"found\": 3}");
    touch(r, ago(600));
    touch(p.code, ago(60));
    const got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /^MEASURE-GATE \(Demo\): you may not end this turn as done/);
    assert.match(got.stderr, /newest code file .*app\.ts changed at/);
    assert.match(got.stderr, /node measure\.mjs/);
    assert.match(got.stderr, /\(1\/3\)/);
  } finally {
    rimraf(p.root);
  }
});

test("measure-gate: a receipt newer than every code file lets the turn end", async () => {
  const p = project();
  try {
    touch(p.code, ago(600));
    writeText(path.join(p.root, "receipts", "receipt-2.json"), "{\"found\": 3}");
    const got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0, got.stderr);
    assert.equal(got.stderr, "");
    assert.equal(got.stdout, "");
  } finally {
    rimraf(p.root);
  }
});

test("measure-gate: no receipt at all blocks; a receipt of the wrong name does not count", async () => {
  const p = project();
  try {
    writeText(path.join(p.root, "receipts", "notes.json"), "{}");
    const got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /newest receipt \(none\) is from never/);
  } finally {
    rimraf(p.root);
  }
});

test("measure-gate: requireMatch checks the receipt's content", async () => {
  const p = project({ requireMatch: "\"found\":\\s*\\d+" });
  try {
    touch(p.code, ago(600));
    writeText(path.join(p.root, "receipts", "receipt-3.json"), "{\"status\": \"ok\"}");
    const got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /does not match requireMatch/);
  } finally {
    rimraf(p.root);
  }
});

test("measure-gate: ignored folders (node_modules, vendor, .git) do not count as code", async () => {
  const p = project();
  try {
    touch(p.code, ago(600));
    const r = writeText(path.join(p.root, "receipts", "receipt-4.json"), "{}");
    touch(r, ago(300));
    writeText(path.join(p.root, "node_modules", "dep", "index.js"), "x");
    writeText(path.join(p.root, "vendor", "lib.js"), "x");
    writeText(path.join(p.root, ".git", "hooks", "pre-commit.sh"), "x");
    const got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0, got.stderr);
  } finally {
    rimraf(p.root);
  }
});

test("measure-gate: gives up after maxBlocks in the same turn and lets the turn end with a note", async () => {
  const p = project({ maxBlocks: 2 });
  try {
    const user = { type: "user", message: { content: [{ type: "text", text: "do it" }] } };
    const tr = writeText(path.join(p.root, "t.jsonl"), JSON.stringify(user) + "\n");
    const sid = "mg-giveup-" + process.pid;
    const ev = () => JSON.stringify({ hook_event_name: "Stop", cwd: p.cwd, session_id: sid, transcript_path: tr });
    assert.equal((await runHook(HOOK, ev(), { cwd: p.cwd })).code, 2, "block 1");
    assert.equal((await runHook(HOOK, ev(), { cwd: p.cwd })).code, 2, "block 2");
    const third = await runHook(HOOK, ev(), { cwd: p.cwd });
    assert.equal(third.code, 0, "gave up");
    assert.match(third.stdout, /gave up after 2 blocks this turn/);
    // A new user message starts a new turn: the counter resets.
    fs.appendFileSync(tr, JSON.stringify(user) + "\n");
    assert.equal((await runHook(HOOK, ev(), { cwd: p.cwd })).code, 2, "new turn blocks again");
  } finally {
    rimraf(p.root);
  }
});

test("measure-gate: off with no receipt location, no code, a missing section, or enabled false", async () => {
  const cases = [
    { "measure-gate": { label: "no location" } },
    { "inject-rules": {} },
    { "measure-gate": { enabled: false, receiptDir: "receipts" } },
    { enabled: false, "measure-gate": { receiptDir: "receipts" } },
  ];
  for (const config of cases) {
    const p = makeProject(config);
    try {
      writeText(path.join(p.root, "src", "app.ts"), "x");
      const got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
      assert.equal(got.code, 0, JSON.stringify(config) + got.stderr);
      assert.equal(got.stderr, "");
    } finally {
      rimraf(p.root);
    }
  }
  const empty = makeProject({ "measure-gate": { receiptDir: "receipts" } });
  try {
    const got = await runHook(HOOK, stop(empty.cwd), { cwd: empty.cwd });
    assert.equal(got.code, 0, "no code files: nothing to measure");
  } finally {
    rimraf(empty.root);
  }
});
