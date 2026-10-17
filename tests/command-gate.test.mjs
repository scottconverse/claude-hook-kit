import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { HOOKS, REFERENCE, makeProject, mkTemp, rimraf, runHook, writeText } from "./helpers.mjs";

const HOOK = path.join(HOOKS, "command-gate.mjs");
const GATE_REF = path.join(REFERENCE, "hardgate-gate.py");
const SIZE_REF = path.join(REFERENCE, "hardgate-commit-size-gate.py");
const which = (exe, args) => {
  try {
    execFileSync(exe, args, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
};
const hasPython = which("python", ["--version"]);
const hasGit = which("git", ["--version"]);

const ev = (command, cwd, tool = "Bash") => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd });
// Run a reference python gate with the event on stdin.
const runPy = (script, stdin, env, cwd) =>
  new Promise((resolve) => {
    const child = execFile("python", [script], { cwd, env: { ...process.env, ...env }, windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }));
    child.stdin.end(stdin);
  });

test("command-gate: the default rules block every kill-by-name form and allow kill-by-PID", async () => {
  const p = makeProject({ "command-gate": { label: "Demo" } });
  try {
    const blocked = [
      ["pkill -f server.mjs", "Bash"],
      ["killall node", "Bash"],
      ["taskkill /IM node.exe /F", "PowerShell"],
      ["Stop-Process -Name node -Force", "PowerShell"],
      ["Get-Process node | Stop-Process -Force", "PowerShell"],
      ["Get-Process | Where-Object { $_.CommandLine -like '*server.mjs*' } | Stop-Process", "PowerShell"],
      ["/usr/bin/pkill -f node", "Bash"],
      ["sudo killall -9 node", "Bash"],
      ['sh -c "pkill -f node"', "Bash"],
    ];
    for (const [c, tool] of blocked) {
      const got = await runHook(HOOK, ev(c, p.cwd, tool), { cwd: p.cwd });
      assert.equal(got.code, 2, c + "\n" + got.stderr);
      assert.match(got.stderr, /^BLOCKED by command-gate \(Demo\)/);
      assert.match(got.stderr, /PID you own/);
    }
    const allowed = ["kill 4242", "taskkill /PID 4242 /F", "Stop-Process -Id 4242", "Get-Process node", "pgrep node", "git status", "node server.mjs"];
    for (const c of allowed) {
      const got = await runHook(HOOK, ev(c, p.cwd), { cwd: p.cwd });
      assert.equal(got.code, 0, c + "\n" + got.stderr);
      assert.equal(got.stderr, "");
    }
  } finally {
    rimraf(p.root);
  }
});

test("command-gate: custom forbidden rules replace the defaults; an empty list turns verb rules off", async () => {
  const p = makeProject({ "command-gate": { forbidden: [{ verbs: ["rm"], flags: ["-rf", "-fr"], message: "no recursive rm" }] } });
  try {
    let got = await runHook(HOOK, ev("rm -rf build", p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /no recursive rm/);
    got = await runHook(HOOK, ev("rm build.log", p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0, got.stderr);
    got = await runHook(HOOK, ev("pkill -f node", p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0, "defaults replaced: " + got.stderr);
    fs.writeFileSync(p.configFile, JSON.stringify({ "command-gate": { forbidden: [] } }));
    got = await runHook(HOOK, ev("pkill -f node", p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0, got.stderr);
  } finally {
    rimraf(p.root);
  }
});

test("command-gate: nested shells fail closed past maxShellDepth and on an unparseable -c argument", async () => {
  const p = makeProject({ "command-gate": { forbidden: [{ verbs: ["cat"] }] } });
  try {
    let got = await runHook(HOOK, ev("sh -c 'bash -c \"sh -c \\\"cat x\\\"\"'", p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /nested shell deeper than 2 levels/);
    got = await runHook(HOOK, ev("sh -c 'cat \"x'", p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2, got.stderr);
    assert.match(got.stderr, /unparseable `-c` argument/);
    // Outer parse error fails open, as the original.
    got = await runHook(HOOK, ev('echo "unterminated', p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0, got.stderr);
  } finally {
    rimraf(p.root);
  }
});

test("command-gate: a fresh override marker grants exactly one bypass and is deleted; a stale one is deleted without a bypass", async () => {
  const p = makeProject({ "command-gate": {} });
  try {
    const marker = path.join(p.root, ".claude", "command-gate-override");
    writeText(marker, "");
    let got = await runHook(HOOK, ev("pkill -f node", p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0, got.stderr);
    assert.match(got.stderr, /override marker accepted/);
    assert.equal(fs.existsSync(marker), false, "marker consumed");
    got = await runHook(HOOK, ev("pkill -f node", p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2, "second run is not covered");
    writeText(marker, "");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(marker, old, old);
    got = await runHook(HOOK, ev("pkill -f node", p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2, "stale marker grants nothing");
    assert.equal(fs.existsSync(marker), false, "stale marker deleted");
  } finally {
    rimraf(p.root);
  }
});

test("command-gate: off when the section is missing, enabled is false, or the tool is not a shell", async () => {
  for (const config of [{ "inject-rules": {} }, { "command-gate": { enabled: false } }, { enabled: false, "command-gate": {} }]) {
    const p = makeProject(config);
    try {
      const got = await runHook(HOOK, ev("pkill -f node", p.cwd), { cwd: p.cwd });
      assert.equal(got.code, 0, JSON.stringify(config) + got.stderr);
      assert.equal(got.stderr, "");
    } finally {
      rimraf(p.root);
    }
  }
  const p = makeProject({ "command-gate": {} });
  try {
    const got = await runHook(HOOK, ev("pkill -f node", p.cwd, "Write"), { cwd: p.cwd });
    assert.equal(got.code, 0);
  } finally {
    rimraf(p.root);
  }
});

// A git repo with one 900-line file staged.
function stagedRepo(lines = 900) {
  const root = mkTemp("hook-kit-git-");
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "ignore", windowsHide: true });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeText(path.join(root, ".claude", "hook-kit.json"), JSON.stringify({ "command-gate": { commitSize: {} } }));
  writeText(path.join(root, "big.txt"), Array.from({ length: lines }, (_, i) => "line " + i).join("\n") + "\n");
  git("add", "big.txt");
  return root;
}

test("command-gate: commit-size gate blocks an untagged 900-line commit, allows a tagged one, --amend, -F and small commits", { skip: !hasGit && "git not available" }, async () => {
  const root = stagedRepo();
  try {
    let got = await runHook(HOOK, ev('git commit -m "big drop"', root), { cwd: root });
    assert.equal(got.code, 2, got.stderr);
    assert.match(got.stderr, /Staged diff is 900 lines \(threshold 800\)/);
    for (const c of ['git commit -m "[LARGE-CHANGE] big drop"', 'git commit -m "[SCOPE-EXPANSION: initial import] big"', 'git commit --amend -m "big"', "git commit -F msg.txt", "git commit"]) {
      got = await runHook(HOOK, ev(c, root), { cwd: root });
      assert.equal(got.code, 0, c + "\n" + got.stderr);
    }
    // "MVP" as a word is not the literal tag.
    got = await runHook(HOOK, ev('git commit -m "fixed the MVP flow"', root), { cwd: root });
    assert.equal(got.code, 2);
    // Threshold is configurable.
    writeText(path.join(root, ".claude", "hook-kit.json"), JSON.stringify({ "command-gate": { commitSize: { maxLines: 1000 } } }));
    got = await runHook(HOOK, ev('git commit -m "big drop"', root), { cwd: root });
    assert.equal(got.code, 0, got.stderr);
    // commitSize absent = off.
    writeText(path.join(root, ".claude", "hook-kit.json"), JSON.stringify({ "command-gate": {} }));
    got = await runHook(HOOK, ev('git commit -m "big drop"', root), { cwd: root });
    assert.equal(got.code, 0, got.stderr);
  } finally {
    rimraf(root);
  }
});

test("parity: the kit configured like reference/hardgate-gate.py agrees with it on every tokenizer case", { skip: !hasPython && "python not available" }, async () => {
  const p = makeProject({ "command-gate": { forbidden: [{ verbs: ["cat", "head", "tail", "grep", "rg", "find"], message: "read verb" }], blockInlineCode: true } });
  try {
    const cases = [
      ["cat README.md", 2],
      ["/usr/bin/sudo cat README.md", 2],
      ["FOO=1 env /bin/cat x", 2],
      ["ls -la | grep foo", 2],
      ["ls && head -5 x", 2],
      ['sh -c "cat x"', 2],
      ["bash -c \"sh -c 'cat x'\"", 2],
      ["sh -c 'cat \"x'", 2],
      ['python -c "print(1)"', 2],
      ["node -e 1", 2],
      ["python script.py", 0],
      ["ls -la", 0],
      ["echo cat", 0],
      ["concatenate x", 0],
      ['echo "unterminated', 0],
      ["sh -c", 0],
    ];
    for (const [c, expected] of cases) {
      const kit = await runHook(HOOK, ev(c, p.cwd), { cwd: p.cwd });
      const ref = await runPy(GATE_REF, ev(c, p.cwd), { CLAUDE_PROJECT_DIR: p.root }, p.cwd);
      assert.equal(kit.code, expected, "kit: " + c + "\n" + kit.stderr);
      assert.equal(ref.code, expected, "reference: " + c + "\n" + ref.stderr);
    }
  } finally {
    rimraf(p.root);
  }
});

// Measured 2026-10-17: the original returns 0 for all three of these, because it splits on
// `;`/`|` before tokenizing and re-joins nested tokens with spaces. The kit blocks them.
test("stricter than the original: operators inside a quoted -c string and a third nesting level are caught", { skip: !hasPython && "python not available" }, async () => {
  const p = makeProject({ "command-gate": { forbidden: [{ verbs: ["cat", "head", "tail", "grep", "rg", "find"] }], blockInlineCode: true } });
  try {
    for (const c of ["bash -c 'ls; tail x'", "sh -c 'cat x | grep y'", "sh -c 'bash -c \"sh -c \\\"cat x\\\"\"'"]) {
      const kit = await runHook(HOOK, ev(c, p.cwd), { cwd: p.cwd });
      const ref = await runPy(GATE_REF, ev(c, p.cwd), { CLAUDE_PROJECT_DIR: p.root }, p.cwd);
      assert.equal(kit.code, 2, "kit: " + c + "\n" + kit.stderr);
      assert.equal(ref.code, 0, "reference (documented gap): " + c);
    }
  } finally {
    rimraf(p.root);
  }
});

test("parity: the kit and reference/hardgate-commit-size-gate.py agree on the staged-size cases", { skip: !(hasPython && hasGit) && "python or git not available" }, async () => {
  const root = stagedRepo();
  try {
    const cases = [
      ['git commit -m "big drop"', 2],
      ['git commit -m "[REFACTOR] big drop"', 0],
      ['git commit -m "fixed the MVP flow"', 2],
      ['git commit --amend -m "big"', 0],
      ["git commit -F msg.txt", 0],
      ["git commit", 0],
      ["git status", 0],
    ];
    for (const [c, expected] of cases) {
      const kit = await runHook(HOOK, ev(c, root), { cwd: root });
      const ref = await runPy(SIZE_REF, ev(c, root), { CLAUDE_PROJECT_DIR: root }, root);
      assert.equal(kit.code, expected, "kit: " + c + "\n" + kit.stderr);
      assert.equal(ref.code, expected, "reference: " + c + "\n" + ref.stderr);
    }
  } finally {
    rimraf(root);
  }
});
