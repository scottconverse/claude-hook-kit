import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HOOKS, makeProject, rimraf, runHook, writeText } from "./helpers.mjs";

const HOOK = path.join(HOOKS, "read-ledger-gate.mjs");
const write = (cwd, file_path, content = "x") => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", cwd, tool_input: { file_path, content } });
const edit = (cwd, file_path) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd, tool_input: { file_path, old_string: "a", new_string: "b" } });
const bash = (cwd, command) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } });

// A project with an "upstream" folder holding two real files of known length.
function project(extra = {}) {
  const p = makeProject({ "read-ledger-gate": { upstreamRoots: ["upstream"], ...extra } });
  writeText(path.join(p.root, "upstream", "engines.ts"), "a\nb\nc\n"); // 3 lines
  writeText(path.join(p.root, "upstream", "ladder.ts"), "1\n2\n3\n4\n5"); // 5 lines, no final newline
  return p;
}

test("read-ledger-gate: a code write with no ledger is blocked", async () => {
  const p = project({ label: "Demo" });
  try {
    const got = await runHook(HOOK, write(p.cwd, path.join(p.root, "src", "app.ts")), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /^BLOCKED by read-ledger-gate \(Demo\)/);
    assert.match(got.stderr, /the ledger file does not exist/);
    assert.match(got.stderr, /READ-LEDGER\.md/);
  } finally {
    rimraf(p.root);
  }
});

test("read-ledger-gate: a complete, true ledger lets code through", async () => {
  const p = project();
  try {
    writeText(path.join(p.root, ".claude", "READ-LEDGER.md"), "# Read\n- engines.ts — 3 lines\n- `ladder.ts` — 5 lines\n");
    for (const ev of [write(p.cwd, path.join(p.root, "src", "app.ts")), edit(p.cwd, "src/app.ts"), bash(p.cwd, "cat <<'EOF' > src/x.mjs\nhi\nEOF")]) {
      const got = await runHook(HOOK, ev, { cwd: p.cwd });
      assert.equal(got.code, 0, got.stderr);
      assert.equal(got.stderr, "");
    }
  } finally {
    rimraf(p.root);
  }
});

test("read-ledger-gate: a wrong line count is caught", async () => {
  const p = project();
  try {
    writeText(path.join(p.root, ".claude", "READ-LEDGER.md"), "- engines.ts — 300 lines\n");
    const got = await runHook(HOOK, write(p.cwd, "src/app.ts"), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /row says 300 lines but engines\.ts has 3/);
  } finally {
    rimraf(p.root);
  }
});

test("read-ledger-gate: a made-up file is caught", async () => {
  const p = project();
  try {
    writeText(path.join(p.root, ".claude", "READ-LEDGER.md"), "| nothere.ts | 12 |\n");
    const got = await runHook(HOOK, write(p.cwd, "src/app.ts"), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /does not exist under any upstream root: nothere\.ts/);
  } finally {
    rimraf(p.root);
  }
});

test("read-ledger-gate: minEntries, minLines and mustMention", async () => {
  const p = project({ minEntries: 2, minLines: 8, mustMention: ["wagalo"] });
  try {
    writeText(path.join(p.root, ".claude", "READ-LEDGER.md"), "- engines.ts — 3 lines\n");
    let got = await runHook(HOOK, write(p.cwd, "src/app.ts"), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /ledger has 1 row\(s\); at least 2 needed/);
    assert.match(got.stderr, /3 real lines read; at least 8 needed/);
    assert.match(got.stderr, /no row mentions "wagalo"/);

    fs.mkdirSync(path.join(p.root, "upstream", "wagalo"), { recursive: true });
    fs.renameSync(path.join(p.root, "upstream", "ladder.ts"), path.join(p.root, "upstream", "wagalo", "ladder.ts"));
    writeText(path.join(p.root, ".claude", "READ-LEDGER.md"), "- engines.ts — 3 lines\n- wagalo/ladder.ts — 5 lines\n");
    got = await runHook(HOOK, write(p.cwd, "src/app.ts"), { cwd: p.cwd });
    assert.equal(got.code, 0, got.stderr);
  } finally {
    rimraf(p.root);
  }
});

test("read-ledger-gate: docs, config, the ledger itself and non-write shell commands are never gated", async () => {
  const p = project();
  try {
    const free = [
      write(p.cwd, path.join(p.root, "README.md")),
      write(p.cwd, path.join(p.root, ".claude", "READ-LEDGER.md"), "- engines.ts — 3 lines"),
      write(p.cwd, path.join(p.root, ".claude", "hook-kit.json")),
      write(p.cwd, "notes/plan.txt"),
      bash(p.cwd, "node --test tests/x.test.mjs"),
      bash(p.cwd, "git diff -- src/app.ts"),
      bash(p.cwd, "cat src/app.ts | head"),
    ];
    for (const ev of free) {
      const got = await runHook(HOOK, ev, { cwd: p.cwd });
      assert.equal(got.code, 0, ev + "\n" + got.stderr);
    }
    // A shell write to code is gated.
    const got = await runHook(HOOK, bash(p.cwd, "echo 'x' > src/app.ts"), { cwd: p.cwd });
    assert.equal(got.code, 2);
  } finally {
    rimraf(p.root);
  }
});

// Oct 17, 2026: the old rule took every code-looking token in a shell command as a write target,
// so `node doctor.mjs` and a quoted path in an issue body were blocked. Only write destinations count.
test("read-ledger-gate: running, reading or naming a code file in a shell command is not a write; its destinations are", async () => {
  const p = project();
  try {
    const free = [
      "node C:/kit/doctor.mjs --project .",
      "python scripts/check.py --fix",
      "powershell -NoProfile -File tests/Test-Thing.ps1",
      "bash scripts/run.sh > out.log",
      "cat src/app.ts >> notes.txt",
      "gh issue create --body \"blocked on node x.mjs and y.py\" > /dev/null",
      "cp src/app.ts /tmp/backup.txt",
      "sed -n 1,5p src/app.ts",
      "git diff --cached -- src/app.ts | tee review.txt",
    ];
    for (const c of free) {
      const got = await runHook(HOOK, bash(p.cwd, c), { cwd: p.cwd });
      assert.equal(got.code, 0, c + "\n" + got.stderr);
    }
    const gated = [
      "echo x > src/app.ts",
      "cat <<'EOF' > src/app.ts\nx\nEOF",
      "node gen.mjs | tee src/out.ts",
      "cp /tmp/x.ts src/app.ts",
      "mv a.ts src/b.ts",
      "echo x | Set-Content -Path src/app.ps1",
      "Get-Content a.txt | Out-File src/x.py",
      "sed -i 's/a/b/' src/app.ts",
      "git checkout -- src/app.ts",
      "python - <<'PY' > src/app.mjs\nprint(1)\nPY",
    ];
    for (const c of gated) {
      const got = await runHook(HOOK, bash(p.cwd, c), { cwd: p.cwd });
      assert.equal(got.code, 2, "should block: " + c);
    }
  } finally {
    rimraf(p.root);
  }
});

test("read-ledger-gate: off when its section is missing or enabled is false", async () => {
  for (const config of [{ "inject-rules": {} }, { "read-ledger-gate": { enabled: false } }, { enabled: false, "read-ledger-gate": {} }]) {
    const p = makeProject(config);
    try {
      const got = await runHook(HOOK, write(p.cwd, "src/app.ts"), { cwd: p.cwd });
      assert.equal(got.code, 0, JSON.stringify(config));
      assert.equal(got.stderr, "");
    } finally {
      rimraf(p.root);
    }
  }
});
