import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOOKS, makeProject, mkTemp, portReference, rimraf, runHook, writeText, writeJson } from "./helpers.mjs";

const KIT = path.join(HOOKS, "deploy-gate.mjs");
const REF_REPO = "C:/Users/scott/Desktop/Code/townreporter-web";
const REF_GATES = "C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/gates";
const REF_FINDINGS = "C:/Users/scott/Desktop/Goals/TownReporter-OPEN-FINDINGS.md";

// A throwaway git repo with one commit on main. origin/main is faked with a remote-tracking
// ref, because `git fetch origin --quiet` has nowhere to go in a temp repo; the reference reads
// origin/main by name, and so does the kit.
function makeRepo(dir) {
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  writeText(path.join(repo, "page.html"), "<h1>one</h1>\n");
  git("add", "page.html");
  git("commit", "-q", "-m", "first");
  const sha = git("rev-parse", "HEAD");
  // A real local "origin" so the hook's `git fetch origin --quiet` succeeds and resolves
  // origin/main. The bare repo is seeded by fetching *into* it; `git push` is blocked here.
  const bare = path.join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", bare], { encoding: "utf8" });
  execFileSync("git", ["-C", bare, "fetch", repo.split(path.sep).join("/"), "main:refs/heads/main"], { encoding: "utf8" });
  git("remote", "add", "origin", bare.split(path.sep).join("/"));
  git("fetch", "origin", "--quiet");
  return { repo, sha, git };
}

function fixture(findingsText) {
  const dir = mkTemp("hook-kit-deploy-");
  const { repo, sha, git } = makeRepo(dir);
  const gates = path.join(dir, "gates");
  const findings = writeText(path.join(dir, "OPEN-FINDINGS.md"), findingsText ?? "");
  const fwd = (p) => p.split(path.sep).join("/");
  const ref = portReference("tr-gate-deploy.mjs", [
    [REF_REPO, fwd(repo)],
    [REF_GATES, fwd(gates)],
    [REF_FINDINGS, fwd(findings)],
  ], dir);
  const proj = makeProject({
    "deploy-gate": {
      commandPattern: "deploy-production[.]ps1|promote[.]ps1",
      skipPatterns: [
        "<<|Set-Content|Add-Content|Out-File|\\becho\\b|\\bprintf\\b|\\bgrep\\b|\\bcat\\b\\s*>|Select-String",
        "-Rollback\\b|\\brollback\\b|-WhatIf\\b",
      ],
      repoDir: repo,
      shaFrom: "origin/main",
      gatesDir: gates,
      requiredKeys: [
        { key: "devServerRun", test: "length", min: 8, message: "devServerRun: what ran on :3100 and the result" },
        { key: "ci", test: "ieq", expected: "PASS", message: 'ci must be "PASS"' },
        { key: "announcedAt", message: "announcedAt: the time announced to Scott" },
      ],
      mustEqual: [
        { key: "commit", other: "originSha", message: "commit must equal the origin/main sha" },
        { key: "testServerCommit", other: "commit", message: "testServerCommit must equal the sha (Test server must run this exact build)" },
      ],
      reportKey: "publishWalkReport",
      reportMustContain: "^PUBLISH-WALK:\\s*PASS\\s*$",
      reportMustContainMessage: 'walk report must contain the line "PUBLISH-WALK: PASS"',
      findingsFile: findings,
      openPattern: "^\\|\\s*([A-Z][A-Z0-9-]*\\d)\\s*\\|\\s*OPEN\\b[^|]*\\|\\s*([^|]*)\\|",
      textOnlyKey: "textOnly",
      textOnly: {
        filesKey: "textFiles",
        filesMessage: "textFiles: the page files this text change touches",
        extraMessage: "not text-only; these files also changed: ",
      },
      skillName: "Scott's release path (skill townreporter-release-path)",
      label: "TownReporter",
      pathLine: "Path: branch -> dev server :3100 -> Test server :3400 FULL walk incl. Publish -> production.",
      nextStep: "Do the missing tier, then write the gate file.",
    },
  });
  return { dir, repo, sha, git, gates, findings, ref, proj };
}

const DEPLOY = "pwsh -File deploy-production.ps1";

// Both hooks pin the sha from origin/main and compare `commit` to the origin sha. The
// reference hard-codes `g.commit !== sha`, which my config spells as two mustEqual entries
// (commit == originSha is a name the gate file must also carry). To keep the comparison
// like-for-like the fixtures always write commit == originSha == sha.
function gate(sha, extra = {}) {
  return { commit: sha, originSha: sha, devServerRun: "ran on :3100, all steps passed", ci: "PASS", announcedAt: "2:15 PM", ...extra };
}

function writeGate(f, value) {
  writeJson(path.join(f.gates, f.sha + ".json"), value);
}

const WALK_OK = writeText; // placeholder so the helper name reads right in cases below

const CASES = [
  {
    name: "a non-deploy command is ignored",
    cmd: "npm test",
    setup: () => {},
    blocked: false,
  },
  {
    name: "a rollback is not a deploy",
    cmd: "pwsh -File deploy-production.ps1 -Rollback",
    setup: () => {},
    blocked: false,
  },
  {
    name: "a note that mentions the deploy script is ignored",
    cmd: 'Set-Content -Path notes.md -Value "deploy-production.ps1"',
    setup: () => {},
    blocked: false,
  },
  {
    name: "a deploy with no gate file is blocked",
    cmd: DEPLOY,
    setup: () => {},
    blocked: true,
    words: ["BLOCKED", "gate file does not exist"],
  },
  {
    name: "a deploy whose gate file is not JSON is blocked",
    cmd: DEPLOY,
    setup: (f) => {
      fs.mkdirSync(f.gates, { recursive: true });
      fs.writeFileSync(path.join(f.gates, f.sha + ".json"), "{not json");
    },
    blocked: true,
    words: ["BLOCKED", "not valid JSON"],
  },
  {
    name: "a complete gate with a passing walk report is allowed",
    cmd: DEPLOY,
    setup: (f) => {
      const rep = writeText(path.join(f.dir, "walk.md"), "PUBLISH-WALK: PASS\n");
      writeGate(f, gate(f.sha, { testServerCommit: f.sha, publishWalkReport: rep }));
    },
    blocked: false,
  },
  {
    name: "a gate whose Test server ran a different build is blocked",
    cmd: DEPLOY,
    setup: (f) => {
      const rep = writeText(path.join(f.dir, "walk.md"), "PUBLISH-WALK: PASS\n");
      writeGate(f, gate(f.sha, { testServerCommit: "0".repeat(40), publishWalkReport: rep }));
    },
    blocked: true,
    words: ["BLOCKED", "testServerCommit"],
  },
  {
    name: "a gate with ci not PASS is blocked",
    cmd: DEPLOY,
    setup: (f) => {
      const rep = writeText(path.join(f.dir, "walk.md"), "PUBLISH-WALK: PASS\n");
      writeGate(f, gate(f.sha, { testServerCommit: f.sha, ci: "FAIL", publishWalkReport: rep }));
    },
    blocked: true,
    words: ["BLOCKED", "ci must be"],
  },
  {
    name: "a walk report without PUBLISH-WALK: PASS is blocked",
    cmd: DEPLOY,
    setup: (f) => {
      const rep = writeText(path.join(f.dir, "walk.md"), "walk went fine, no publish step\n");
      writeGate(f, gate(f.sha, { testServerCommit: f.sha, publishWalkReport: rep }));
    },
    blocked: true,
    words: ["BLOCKED", "PUBLISH-WALK: PASS"],
  },
  {
    name: "an OPEN finding blocks the deploy",
    cmd: DEPLOY,
    setup: (f) => {
      const rep = writeText(path.join(f.dir, "walk.md"), "PUBLISH-WALK: PASS\n");
      writeGate(f, gate(f.sha, { testServerCommit: f.sha, publishWalkReport: rep }));
      writeText(f.findings, "| THT-8 | OPEN | bar wraps on Story page |\n");
    },
    blocked: true,
    words: ["BLOCKED", "OPEN finding"],
  },
  {
    name: "a FIXED finding does not block the deploy",
    cmd: DEPLOY,
    setup: (f) => {
      const rep = writeText(path.join(f.dir, "walk.md"), "PUBLISH-WALK: PASS\n");
      writeGate(f, gate(f.sha, { testServerCommit: f.sha, publishWalkReport: rep }));
      writeText(f.findings, "| THT-8 | FIXED abc1234 | bar wraps on Story page |\n");
    },
    blocked: false,
  },
  {
    name: "a text-only push with a clean diff is allowed",
    cmd: DEPLOY,
    setup: (f) => {
      writeGate(f, { commit: f.sha, originSha: f.sha, textOnly: true, announcedAt: "2:15 PM", textFiles: ["page.html"] });
    },
    blocked: false,
  },
];

for (const c of CASES) {
  test("deploy-gate parity: " + c.name, async () => {
    const f = fixture();
    try {
      c.setup(f);
      const stdin = JSON.stringify({ tool_name: "Bash", cwd: f.proj.cwd, tool_input: { command: c.cmd } });
      const [got, want] = await Promise.all([runHook(KIT, stdin), runHook(f.ref, stdin)]);
      assert.equal(got.code, want.code, "exit code matches the reference");
      assert.equal(got.code, c.blocked ? 2 : 0);
      // The sha differs between runs only if the fixture drifted; both must name the same one.
      if (c.blocked) assert.ok(got.stderr.includes(f.sha.slice(0, 8)), "block names the commit");
      if (c.words) for (const w of c.words) assert.ok(got.stderr.includes(w), "stderr mentions " + w);
    } finally {
      rimraf(f.dir);
      rimraf(f.proj.root);
    }
  });
}
