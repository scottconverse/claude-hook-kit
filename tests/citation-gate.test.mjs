import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { HOOKS, REFERENCE, makeProject, mkTemp, rimraf, runHook, writeText } from "./helpers.mjs";

const HOOK = path.join(HOOKS, "citation-gate.mjs");
const REF = path.join(REFERENCE, "audit-citation-gate.ps1");
const hasPowershell = (() => {
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

// A project with a 3-line source file, a transcript that READ it and WROTE the audit doc.
function fixture(docName = "x-audit.md", { readFiles = ["real.txt"] } = {}) {
  const p = makeProject({ "citation-gate": { label: "Demo" } });
  const real = writeText(path.join(p.root, "real.txt"), "line1\nline2\nline3\n");
  writeText(path.join(p.root, "never-read.txt"), "a\n");
  const doc = path.join(p.root, docName);
  const msgs = [
    { type: "user", message: { content: [{ type: "text", text: "audit it" }] } },
    ...readFiles.map((f, i) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "r" + i, name: "Read", input: { file_path: path.join(p.root, f) } }] } })),
    { type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: doc, content: "x" } }] } },
  ];
  const transcript = writeText(path.join(p.root, "t.jsonl"), msgs.map((m) => JSON.stringify(m)).join("\n"));
  const event = JSON.stringify({ hook_event_name: "Stop", cwd: p.root, session_id: "s", transcript_path: transcript });
  return { ...p, real, doc, event };
}
const body = (ledger) => "# Audit\nVERDICT: PASS\n\n## Verification ledger\n" + ledger;

test("citation-gate: a VERIFIED row citing a file the transcript never read is blocked", async () => {
  const f = fixture();
  try {
    writeText(f.doc, body("VERIFIED: real thing | real.txt:2\nVERIFIED: fake thing | never-read.txt:1\n"));
    const got = await runHook(HOOK, f.event, { cwd: f.root });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /^BLOCKED by citation-gate \(Demo\)/);
    assert.match(got.stderr, /never-read\.txt:1' but this session's transcript contains no tool call that read that file/);
    assert.doesNotMatch(got.stderr, /real\.txt:2/);
  } finally {
    rimraf(f.root);
  }
});

test("citation-gate: downgrading to UNVERIFIED lets the turn end; so does citing only read files", async () => {
  const f = fixture();
  try {
    writeText(f.doc, body("VERIFIED: real thing | real.txt:2\nUNVERIFIED: fake thing - not checked\n"));
    let got = await runHook(HOOK, f.event, { cwd: f.root });
    assert.equal(got.code, 0, got.stderr);
    assert.equal(got.stderr, "");
    writeText(f.doc, body("VERIFIED: abs | " + f.real + ":3\n"));
    got = await runHook(HOOK, f.event, { cwd: f.root });
    assert.equal(got.code, 0, got.stderr);
  } finally {
    rimraf(f.root);
  }
});

test("citation-gate: missing ledger, verdict without rows, bad line, missing file, no file:line", async () => {
  const f = fixture();
  try {
    const cases = [
      ["# Audit\nVERDICT: PASS\nno ledger here\n", /missing a '## Verification ledger' section/],
      [body(""), /states a verdict or recommendation but the ledger has no VERIFIED: or UNVERIFIED: entries/],
      [body("VERIFIED: too far | real.txt:9\n"), /cited line 9 is out of range \(file has 3 lines\)/],
      [body("VERIFIED: ghost | ghost.txt:1\n"), /cited file does not exist -> 'ghost\.txt:1'/],
      [body("VERIFIED: vague | real.txt\n"), /VERIFIED entry has no file:line citation/],
    ];
    for (const [text, re] of cases) {
      writeText(f.doc, text);
      const got = await runHook(HOOK, f.event, { cwd: f.root });
      assert.equal(got.code, 2, text);
      assert.match(got.stderr, re);
    }
  } finally {
    rimraf(f.root);
  }
});

test("citation-gate: fenced examples are not claims; a doc with no verdict and an empty ledger passes", async () => {
  const f = fixture();
  try {
    writeText(f.doc, "# Notes\n\n## Verification ledger\n```\nVERIFIED: example | nothing.txt:1\n```\n");
    const got = await runHook(HOOK, f.event, { cwd: f.root });
    assert.equal(got.code, 0, got.stderr);
  } finally {
    rimraf(f.root);
  }
});

test("citation-gate: only governed names are checked; memory notes and non-matching docs are ignored", async () => {
  for (const name of ["memory/x-audit.md", "plan.md", "README.md"]) {
    const f = fixture(name);
    try {
      writeText(f.doc, "VERDICT: PASS with no ledger at all\n");
      const got = await runHook(HOOK, f.event, { cwd: f.root });
      assert.equal(got.code, 0, name + "\n" + got.stderr);
    } finally {
      rimraf(f.root);
    }
  }
  // A custom docPattern governs other names.
  const p = makeProject({ "citation-gate": { docPattern: "^report" } });
  try {
    const doc = path.join(p.root, "report-1.md");
    writeText(doc, "VERDICT: PASS\n");
    const tr = writeText(path.join(p.root, "t.jsonl"), JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: doc, content: "x" } }] } }));
    const got = await runHook(HOOK, JSON.stringify({ hook_event_name: "Stop", cwd: p.root, transcript_path: tr }), { cwd: p.root });
    assert.equal(got.code, 2);
  } finally {
    rimraf(p.root);
  }
});

test("citation-gate: no transcript or no governed document is allowed (infrastructure fail-open)", async () => {
  const p = makeProject({ "citation-gate": {} });
  try {
    let got = await runHook(HOOK, JSON.stringify({ hook_event_name: "Stop", cwd: p.root, transcript_path: path.join(p.root, "missing.jsonl") }), { cwd: p.root });
    assert.equal(got.code, 0);
    const tr = writeText(path.join(p.root, "t.jsonl"), JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }));
    got = await runHook(HOOK, JSON.stringify({ hook_event_name: "Stop", cwd: p.root, transcript_path: tr }), { cwd: p.root });
    assert.equal(got.code, 0);
  } finally {
    rimraf(p.root);
  }
});

// Oct 17, 2026: a days-long session was blocked over handoff notes written in other folders on
// earlier days. Default scope is the project; "session" restores the old reach.
test("citation-gate: scope project ignores a governed document outside the project; scope session governs it", async () => {
  const p = makeProject({ "citation-gate": {} });
  const elsewhere = mkTemp("hook-kit-elsewhere-");
  try {
    const doc = path.join(elsewhere, "old-handoff.md");
    writeText(doc, "VERDICT: PASS with no ledger\n");
    const tr = writeText(path.join(p.root, "t.jsonl"), JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: doc, content: "x" } }] } }));
    const ev = JSON.stringify({ hook_event_name: "Stop", cwd: p.root, transcript_path: tr });
    let got = await runHook(HOOK, ev, { cwd: p.root });
    assert.equal(got.code, 0, "outside the project: not governed\n" + got.stderr);
    fs.writeFileSync(p.configFile, JSON.stringify({ "citation-gate": { scope: "session" } }));
    got = await runHook(HOOK, ev, { cwd: p.root });
    assert.equal(got.code, 2, "scope session: governed");
  } finally {
    rimraf(p.root);
    rimraf(elsewhere);
  }
});

// Oct 17, 2026: `docs/VERIFICATION.md:54` written inside repo B's docs/ was resolved against the
// session folder and reported as a missing file.
test("citation-gate: a relative citation resolves against the document's own folder", async () => {
  const p = makeProject({ "citation-gate": { label: "Demo" } });
  try {
    const src = writeText(path.join(p.root, "docs", "VERIFICATION.md"), "l1\nl2\nl3\n");
    const doc = path.join(p.root, "docs", "handoff-x.md");
    writeText(doc, "# H\n\n## Verification ledger\nVERIFIED: thing | VERIFICATION.md:2\n");
    const msgs = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: src } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: doc, content: "x" } }] } },
    ];
    const tr = writeText(path.join(p.root, "t.jsonl"), msgs.map((m) => JSON.stringify(m)).join("\n"));
    // Event cwd is the project root, where VERIFICATION.md does not exist; it exists beside the doc.
    const got = await runHook(HOOK, JSON.stringify({ hook_event_name: "Stop", cwd: p.root, transcript_path: tr }), { cwd: p.root });
    assert.equal(got.code, 0, got.stderr);
  } finally {
    rimraf(p.root);
  }
});

// A subagent's handoff note never enters the main transcript. On SubagentStop the gate reads the
// subagent's own transcript (agent_transcript_path).
test("citation-gate: on SubagentStop it reads agent_transcript_path", async () => {
  const f = fixture();
  try {
    writeText(f.doc, body("VERIFIED: fake thing | never-read.txt:1\n"));
    const main = writeText(path.join(f.root, "main.jsonl"), JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }));
    const ev = JSON.stringify({ hook_event_name: "SubagentStop", cwd: f.root, session_id: "s", transcript_path: main, agent_transcript_path: path.join(f.root, "t.jsonl"), agent_id: "a1" });
    const got = await runHook(HOOK, ev, { cwd: f.root });
    assert.equal(got.code, 2, got.stderr);
    assert.match(got.stderr, /never-read\.txt:1' but this session's transcript contains no tool call/);
    // The same event on Stop sees only the main transcript, which wrote nothing: allowed.
    const onStop = JSON.stringify({ hook_event_name: "Stop", cwd: f.root, session_id: "s", transcript_path: main });
    assert.equal((await runHook(HOOK, onStop, { cwd: f.root })).code, 0);
  } finally {
    rimraf(f.root);
  }
});

test("citation-gate: off when its section is missing or enabled is false", async () => {
  for (const config of [{ "inject-rules": {} }, { "citation-gate": { enabled: false } }, { enabled: false, "citation-gate": {} }]) {
    const f = fixture();
    try {
      fs.writeFileSync(f.configFile, JSON.stringify(config));
      writeText(f.doc, body("VERIFIED: fake | never-read.txt:1\n"));
      const got = await runHook(HOOK, f.event, { cwd: f.root });
      assert.equal(got.code, 0, JSON.stringify(config));
      assert.equal(got.stderr, "");
    } finally {
      rimraf(f.root);
    }
  }
});

test("parity: the kit and reference/audit-citation-gate.ps1 agree on block/allow for the same fixtures", { skip: !hasPowershell && "powershell not available" }, async () => {
  const f = fixture();
  try {
    const cases = [
      [body("VERIFIED: real thing | real.txt:2\nVERIFIED: fake thing | never-read.txt:1\n"), 2],
      [body("VERIFIED: real thing | real.txt:2\nUNVERIFIED: fake thing - not checked\n"), 0],
      ["# Audit\nVERDICT: PASS\nno ledger\n", 2],
      [body("VERIFIED: too far | real.txt:9\n"), 2],
      ["# Notes\n\n## Verification ledger\n```\nVERIFIED: example | nothing.txt:1\n```\n", 0],
    ];
    for (const [text, expected] of cases) {
      writeText(f.doc, text);
      const kit = await runHook(HOOK, f.event, { cwd: f.root });
      // runHook runs node; the reference is PowerShell, so run it directly.
      const r = await new Promise((resolve) => {
        const child = execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", REF], { cwd: f.root, windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }));
        child.stdin.end(f.event);
      });
      assert.equal(kit.code, expected, "kit: " + text);
      assert.equal(r.code, expected, "reference: " + text + "\n" + r.stderr);
    }
  } finally {
    rimraf(f.root);
  }
});

