import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOOKS, REFERENCE, makeProject, mkTemp, rimraf, runHook, writeJson, writeText } from "./helpers.mjs";

const HOOK = path.join(HOOKS, "sprint-gate.mjs");
const REF_GATE = path.join(REFERENCE, "antistall-gate.py");
const python = (() => {
  for (const exe of ["python3", "python"]) {
    try {
      execFileSync(exe, ["--version"], { stdio: "ignore", windowsHide: true });
      return exe;
    } catch {}
  }
  return null;
})();

const stop = (cwd, extra = {}) => JSON.stringify({ hook_event_name: "Stop", cwd, session_id: "sess-1", ...extra });
// A fake user config dir so the secret file never touches the real ~/.claude.
const userDir = () => mkTemp("hook-kit-sprint-home-");
const cli = (p, home, args, env = {}) => runHook(HOOK, "", { args, cwd: p.root, env: { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: "sess-1", ...env } });

test("sprint-gate: silent with no armed gate; blocks while armed; counter climbs", async () => {
  const p = makeProject({ "sprint-gate": { label: "Demo", cap: 25 } });
  try {
    let got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0);
    assert.equal(got.stderr, "");
    writeJson(path.join(p.root, ".claude", "sprint", "gate-sess-1.json"), { active: true, note: "ship it", owner: "sess-1" });
    got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 2);
    assert.match(got.stderr, /^SPRINT-GATE \(Demo\): a sprint is ARMED/);
    assert.match(got.stderr, /Block 1\/25/);
    got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.match(got.stderr, /Block 2\/25/);
    assert.equal(fs.readFileSync(path.join(p.root, ".claude", "sprint", "count-sess-1"), "utf8"), "2");
  } finally {
    rimraf(p.root);
  }
});

test("sprint-gate: a project-wide gate applies to every session unless it names an owner", async () => {
  const p = makeProject({ "sprint-gate": {} });
  try {
    writeJson(path.join(p.root, ".claude", "sprint", "gate.json"), { active: true, owner: null });
    assert.equal((await runHook(HOOK, stop(p.cwd, { session_id: "other" }), { cwd: p.cwd })).code, 2);
    writeJson(path.join(p.root, ".claude", "sprint", "gate.json"), { active: true, owner: "sess-1" });
    assert.equal((await runHook(HOOK, stop(p.cwd, { session_id: "other" }), { cwd: p.cwd })).code, 0, "owned by another session: silent");
    assert.equal((await runHook(HOOK, stop(p.cwd), { cwd: p.cwd })).code, 2, "owner's session: blocked");
  } finally {
    rimraf(p.root);
  }
});

test("sprint-gate: at the cap it PAUSES (allows one stop), resets the counter, and keeps the gate armed", async () => {
  const p = makeProject({ "sprint-gate": { cap: 3 } });
  try {
    const gate = path.join(p.root, ".claude", "sprint", "gate-sess-1.json");
    writeJson(gate, { active: true });
    assert.equal((await runHook(HOOK, stop(p.cwd), { cwd: p.cwd })).code, 2);
    assert.equal((await runHook(HOOK, stop(p.cwd), { cwd: p.cwd })).code, 2);
    const third = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(third.code, 0);
    assert.match(third.stdout, /stop PAUSED \(token-burn cap 3 reached/);
    assert.ok(fs.existsSync(gate), "gate still armed");
    assert.ok(!fs.existsSync(path.join(p.root, ".claude", "sprint", "count-sess-1")), "counter reset");
    assert.equal((await runHook(HOOK, stop(p.cwd), { cwd: p.cwd })).code, 2, "re-enforces next turn");
  } finally {
    rimraf(p.root);
  }
});

test("sprint-gate: a corrupt counter fails open (pause), never disarms; stop_hook_active is ignored unless configured", async () => {
  const p = makeProject({ "sprint-gate": {} });
  try {
    writeJson(path.join(p.root, ".claude", "sprint", "gate-sess-1.json"), { active: true });
    writeText(path.join(p.root, ".claude", "sprint", "count-sess-1"), "garbage");
    const got = await runHook(HOOK, stop(p.cwd), { cwd: p.cwd });
    assert.equal(got.code, 0);
    assert.match(got.stdout, /counter corrupt/);
    assert.equal((await runHook(HOOK, stop(p.cwd, { stop_hook_active: true }), { cwd: p.cwd })).code, 2, "default: still blocks");
    fs.writeFileSync(p.configFile, JSON.stringify({ "sprint-gate": { honorStopHookActive: true } }));
    assert.equal((await runHook(HOOK, stop(p.cwd, { stop_hook_active: true }), { cwd: p.cwd })).code, 0, "configured: lets the continuation through");
  } finally {
    rimraf(p.root);
  }
});

test("sprint-gate CLI: arm refuses without a secret; set-release-secret; arm; status; request; wrong and right release", async () => {
  const p = makeProject({ "sprint-gate": {} });
  const home = userDir();
  try {
    let r = await cli(p, home, ["arm", "build the thing"]);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /REFUSING TO ARM/);

    r = await cli(p, home, ["set-release-secret"], { SPRINT_RELEASE: "hunter2" });
    assert.equal(r.code, 0, r.stderr);
    const secret = path.join(home, "sprint-release.hash");
    const rec = JSON.parse(fs.readFileSync(secret, "utf8"));
    assert.equal(rec.algo, "pbkdf2_sha256");
    assert.equal(rec.iters, 240000);

    r = await cli(p, home, ["arm", "build the thing"]);
    assert.equal(r.code, 0, r.stderr);
    const gate = path.join(p.root, ".claude", "sprint", "gate-sess-1.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(gate, "utf8")).active, true);
    assert.equal((await runHook(HOOK, stop(p.cwd), { cwd: p.cwd })).code, 2, "hook now blocks");

    r = await cli(p, home, ["status"]);
    assert.match(r.stdout, /ARMED\. Note: build the thing\. Release secret set: yes/);

    r = await cli(p, home, ["request", "need a decision"]);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(p.root, ".claude", "sprint", "stop-request.json")));
    assert.ok(fs.existsSync(gate), "request does not disarm");

    for (const bad of ["done", "disarm", "off"]) assert.equal((await cli(p, home, [bad])).code, 7, bad);

    r = await cli(p, home, ["release"], { SPRINT_RELEASE: "wrong" });
    assert.equal(r.code, 6);
    assert.ok(fs.existsSync(gate), "wrong passphrase: still armed");

    r = await cli(p, home, ["release"], { SPRINT_RELEASE: "hunter2" });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!fs.existsSync(gate), "released");
    assert.equal((await runHook(HOOK, stop(p.cwd), { cwd: p.cwd })).code, 0, "hook silent again");
  } finally {
    rimraf(p.root);
    rimraf(home);
  }
});

test("sprint-gate: the kit reads a secret written by the original AntiStall tool (same PBKDF2 record)", { skip: !python && "no python" }, async () => {
  const p = makeProject({ "sprint-gate": {} });
  const home = userDir();
  try {
    // The reference stores {algo, iters, salt, hash}; write one with its own code path.
    const script = "import sys,json,os,hashlib;" +
      "salt=os.urandom(16);h=hashlib.pbkdf2_hmac('sha256',b'hunter2',salt,240000).hex();" +
      "open(sys.argv[1],'w').write(json.dumps({'algo':'pbkdf2_sha256','iters':240000,'salt':salt.hex(),'hash':h}))";
    execFileSync(python, ["-I", "-c", script, path.join(home, "antistall-release.hash")], { windowsHide: true });
    let r = await cli(p, home, ["arm", "x"]);
    assert.equal(r.code, 0, r.stderr);
    r = await cli(p, home, ["release"], { SPRINT_RELEASE: "hunter2" });
    assert.equal(r.code, 0, r.stderr);
  } finally {
    rimraf(p.root);
    rimraf(home);
  }
});

test("parity: kit and reference/antistall-gate.py agree on block vs allow and on the cap pause", { skip: !python && "no python" }, async () => {
  // The reference keys its gate on <project>/.claude/sprint-gate-<sid>.json and signals a block
  // with {"decision":"block"} on stdout (exit 0); the kit uses .claude/sprint/gate-<sid>.json and exit 2.
  const p = makeProject({ "sprint-gate": { cap: 3 } });
  try {
    const refClaude = path.join(p.root, ".claude");
    const runRef = () => new Promise((resolve) => {
      import("node:child_process").then(({ execFile }) => {
        const child = execFile(python, ["-I", REF_GATE], { cwd: p.root, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: p.root, ANTISTALL_BLOCK_CAP: "3" } }, (err, stdout, stderr) => resolve({ blocked: String(stdout).includes('"decision": "block"'), stdout, stderr }));
        child.stdin.end(stop(p.cwd));
      });
    });
    // Not armed: both allow.
    assert.equal((await runRef()).blocked, false);
    assert.equal((await runHook(HOOK, stop(p.cwd), { cwd: p.cwd })).code, 0);
    // Armed: both block twice, then both pause on the third (cap 3), then both block again.
    writeJson(path.join(refClaude, "sprint-gate-sess-1.json"), { active: true, owner: "sess-1" });
    writeJson(path.join(refClaude, "sprint", "gate-sess-1.json"), { active: true, owner: "sess-1" });
    const seq = [];
    for (let i = 0; i < 4; i++) {
      const ref = (await runRef()).blocked;
      const kit = (await runHook(HOOK, stop(p.cwd), { cwd: p.cwd })).code === 2;
      seq.push([ref, kit]);
    }
    assert.deepEqual(seq, [[true, true], [true, true], [false, false], [true, true]]);
  } finally {
    rimraf(p.root);
  }
});
