import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, mkTemp, rimraf, runHook, writeJson, writeText } from "./helpers.mjs";
import { buildHookEntries, KIT_SCRIPTS } from "../lib/hook-entries.mjs";

const DOCTOR = path.join(ROOT, "doctor.mjs");

// A settings folder with the kit installed the way install.mjs lays it out.
function installed() {
  const cfg = mkTemp("hook-kit-doctor-cfg-");
  const kit = path.join(cfg, "hook-kit");
  fs.cpSync(path.join(ROOT, "hooks"), path.join(kit, "hooks"), { recursive: true });
  fs.cpSync(path.join(ROOT, "lib"), path.join(kit, "lib"), { recursive: true });
  writeJson(path.join(cfg, "settings.json"), { hooks: buildHookEntries(kit) });
  return { cfg, kit, settings: path.join(cfg, "settings.json") };
}
const run = (args) => runHook(DOCTOR, "", { args: [...args, "--json"] });
const byCheck = (rows, check) => rows.filter((r) => r.check === check);

test("doctor: a full install passes every row and exits 0", async () => {
  const i = installed();
  try {
    const got = await run(["--config-dir", i.cfg]);
    const out = JSON.parse(got.stdout);
    assert.equal(got.code, 0, got.stdout + got.stderr);
    assert.equal(out.fails, 0);
    assert.equal(byCheck(out.rows, "registered").length, KIT_SCRIPTS.length);
    assert.ok(byCheck(out.rows, "registered").every((r) => r.status === "PASS"), JSON.stringify(byCheck(out.rows, "registered")));
    const live = byCheck(out.rows, "liveness");
    // Either every hook was probed, or the temp folder sits under a tree with a config and the doctor said so.
    assert.ok(live.length === KIT_SCRIPTS.length || (live.length === 1 && live[0].status === "PARTIAL"), JSON.stringify(live));
    assert.ok(live.every((r) => r.status !== "FAIL"), JSON.stringify(live.filter((r) => r.status === "FAIL")));
    assert.ok(byCheck(out.rows, "script").every((r) => r.status === "PASS"));
  } finally {
    rimraf(i.cfg);
  }
});

test("doctor: a kit hook dropped from settings is a registered FAIL; one registered under the wrong event too", async () => {
  const i = installed();
  try {
    const s = JSON.parse(fs.readFileSync(i.settings, "utf8"));
    s.hooks.Stop = s.hooks.Stop.map((g) => ({ ...g, hooks: g.hooks.filter((h) => !/sprint-gate/.test(h.command)) }));
    s.hooks.PostToolUse = [];
    writeJson(i.settings, s);
    const got = await run(["--config-dir", i.cfg]);
    const out = JSON.parse(got.stdout);
    assert.equal(got.code, 1);
    const reg = byCheck(out.rows, "registered");
    assert.match(reg.find((r) => /sprint-gate/.test(r.detail)).detail, /not registered/);
    const rbd = reg.find((r) => /ran-before-done/.test(r.detail));
    assert.equal(rbd.status, "FAIL");
    assert.match(rbd.detail, /registered under Stop but not PostToolUse/);
  } finally {
    rimraf(i.cfg);
  }
});

test("doctor: a registered command whose script is gone is a script FAIL; a missing settings file is a FAIL", async () => {
  const i = installed();
  try {
    const s = JSON.parse(fs.readFileSync(i.settings, "utf8"));
    s.hooks.Stop.push({ hooks: [{ type: "command", command: 'powershell -NoProfile -File "' + path.join(i.cfg, "gone.ps1").replace(/\\/g, "/") + '"', timeout: 5 }] });
    writeJson(i.settings, s);
    let got = await run(["--config-dir", i.cfg]);
    let out = JSON.parse(got.stdout);
    assert.equal(got.code, 1);
    assert.ok(byCheck(out.rows, "script").some((r) => r.status === "FAIL" && /gone\.ps1/.test(r.detail)), JSON.stringify(byCheck(out.rows, "script")));
    fs.unlinkSync(i.settings);
    got = await run(["--config-dir", i.cfg]);
    out = JSON.parse(got.stdout);
    assert.equal(got.code, 1);
    assert.equal(byCheck(out.rows, "settings")[0].status, "FAIL");
    assert.match(byCheck(out.rows, "settings")[0].detail, /missing/);
  } finally {
    rimraf(i.cfg);
  }
});

test("doctor: --project validates the project config: absent, typo section, missing rules file, disabled", async () => {
  const i = installed();
  const proj = mkTemp("hook-kit-doctor-proj-");
  try {
    let got = await run(["--config-dir", i.cfg, "--project", proj]);
    let rows = byCheck(JSON.parse(got.stdout).rows, "project");
    assert.equal(got.code, 0);
    assert.equal(rows[0].status, "PARTIAL");
    assert.match(rows[0].detail, /absent/);

    writeJson(path.join(proj, ".claude", "hook-kit.json"), { "read-ledger-gate": { rulesFile: ".claude/RULES.md", ledgerFile: ".claude/READ-LEDGER.md" }, "comand-gate": {}, "sprint-gate": { enabled: false }, "ran-before-done": { stateDir: ".claude/state" } });
    got = await run(["--config-dir", i.cfg, "--project", proj]);
    rows = byCheck(JSON.parse(got.stdout).rows, "project");
    assert.equal(got.code, 1);
    assert.ok(rows.some((r) => r.status === "FAIL" && /read-ledger-gate: rulesFile ->/.test(r.detail) && /ledgerFile ->/.test(r.detail)), JSON.stringify(rows));
    assert.ok(rows.some((r) => r.status === "PARTIAL" && /`comand-gate` matches no kit hook/.test(r.detail)));
    assert.ok(rows.some((r) => r.status === "PASS" && /sprint-gate: present, enabled: false/.test(r.detail)));
    assert.ok(rows.some((r) => r.status === "PASS" && /ran-before-done: on \(stateDir not created yet\)/.test(r.detail)));

    writeText(path.join(proj, ".claude", "RULES.md"), "# rules\n");
    writeText(path.join(proj, ".claude", "READ-LEDGER.md"), "# ledger\n");
    writeJson(path.join(proj, ".claude", "hook-kit.json"), { "read-ledger-gate": { rulesFile: ".claude/RULES.md", ledgerFile: ".claude/READ-LEDGER.md" } });
    got = await run(["--config-dir", i.cfg, "--project", proj]);
    assert.equal(got.code, 0, got.stdout);
    rows = byCheck(JSON.parse(got.stdout).rows, "project");
    assert.ok(rows.some((r) => r.status === "PASS" && /read-ledger-gate: on$/.test(r.detail)), JSON.stringify(rows));

    writeJson(path.join(proj, ".claude", "hook-kit.json"), { enabled: false, "read-ledger-gate": {} });
    got = await run(["--config-dir", i.cfg, "--project", proj]);
    rows = byCheck(JSON.parse(got.stdout).rows, "project");
    assert.ok(rows.some((r) => r.status === "PARTIAL" && /enabled: false/.test(r.detail)));
  } finally {
    rimraf(i.cfg);
    rimraf(proj);
  }
});

test("doctor: the plain-text report lists one line per row and a summary line", async () => {
  const i = installed();
  try {
    const got = await runHook(DOCTOR, "", { args: ["--config-dir", i.cfg] });
    assert.equal(got.code, 0, got.stdout + got.stderr);
    assert.match(got.stdout, /^PASS {4}settings {3}/m);
    assert.match(got.stdout, /\n\d+ PASS, 0 FAIL, \d+ PARTIAL\n$/);
  } finally {
    rimraf(i.cfg);
  }
});
