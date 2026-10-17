import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkTemp, rimraf, writeJson, writeText } from "./helpers.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(REPO, "install.mjs");
const UNINSTALL = path.join(REPO, "uninstall.mjs");
const INIT = path.join(REPO, "init-project.mjs");
const OLD = "C:/Users/scott/Desktop/Code/claude-hook-kit/hooks";

// Run a node script with args and resolve { code, stdout, stderr }.
function run(script, args, { cwd = REPO } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// A fresh temp settings folder. Nothing here touches the real ~/.claude.
function tempDir() {
  return mkTemp("hook-kit-install-");
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Every command string in a hooks block, as one array, so tests can count and match.
function commands(hooks) {
  const out = [];
  for (const groups of Object.values(hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const h of group.hooks || []) out.push(h.command);
    }
  }
  return out;
}

// A settings.json that already holds one unrelated hook (a Stop hook running
// notify.ps1) and one unrelated setting, to prove install keeps them.
function seedSettings(file) {
  writeJson(file, {
    model: "opus",
    permissions: { allow: ["Bash(git status)"] },
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: 'powershell -File "C:/tools/notify.ps1"', timeout: 5 }] },
      ],
    },
  });
}

test("install: a fresh install creates settings with the kit hooks and copies the files", async () => {
  const dir = tempDir();
  try {
    const r = await run(INSTALL, ["--config-dir", dir]);
    assert.equal(r.code, 0, r.stderr);
    const settingsFile = path.join(dir, "settings.json");
    assert.ok(fs.existsSync(settingsFile), "settings.json was created");
    const settings = read(settingsFile);
    const cmds = commands(settings.hooks);
    assert.equal(cmds.length, 15, "fifteen entries: inject-rules and ran-before-done twice each + the eleven other hooks");
    for (const c of cmds) assert.ok(c.includes("/hook-kit/hooks/"), "commands point at the installed copy: " + c);
    // The copied files really exist.
    for (const f of ["hooks/inject-rules.mjs", "hooks/wake.mjs", "lib/config.mjs", "lib/hook-entries.mjs"]) {
      assert.ok(fs.existsSync(path.join(dir, "hook-kit", f)), "copied " + f);
    }
    // Events, matchers, timeouts and asyncRewake match the shipped snippet shape.
    assert.equal(settings.hooks.SessionStart[0].hooks[0].timeout, 10);
    assert.equal(settings.hooks.PreToolUse[0].matcher, "Bash|PowerShell");
    const wake = settings.hooks.Stop[0].hooks.find((h) => h.command.includes("wake.mjs"));
    assert.equal(wake.asyncRewake, true);
    assert.equal(wake.timeout, 1800);
  } finally {
    rimraf(dir);
  }
});

test("install: keeps an unrelated hook and unrelated settings", async () => {
  const dir = tempDir();
  try {
    const settingsFile = path.join(dir, "settings.json");
    seedSettings(settingsFile);
    const r = await run(INSTALL, ["--config-dir", dir]);
    assert.equal(r.code, 0, r.stderr);
    const settings = read(settingsFile);
    assert.equal(settings.model, "opus", "unrelated top-level setting kept");
    assert.deepEqual(settings.permissions, { allow: ["Bash(git status)"] }, "unrelated permissions kept");
    assert.ok(commands(settings.hooks).includes('powershell -File "C:/tools/notify.ps1"'), "the unrelated Stop hook is kept");
    // The kit's no-idle hook joined the same Stop event without disturbing the other.
    const stop = commands({ Stop: settings.hooks.Stop });
    assert.ok(stop.some((c) => c.includes("no-idle.mjs")), "no-idle was added");
    assert.ok(stop.some((c) => c.includes("notify.ps1")), "notify.ps1 is still there");
  } finally {
    rimraf(dir);
  }
});

test("install: running twice does not add duplicates", async () => {
  const dir = tempDir();
  try {
    await run(INSTALL, ["--config-dir", dir]);
    const settingsFile = path.join(dir, "settings.json");
    const first = commands(read(settingsFile).hooks);
    const r2 = await run(INSTALL, ["--config-dir", dir]);
    assert.equal(r2.code, 0, r2.stderr);
    const second = commands(read(settingsFile).hooks);
    assert.deepEqual(second, first, "the second install changed nothing");
    assert.equal(second.length, 15, "still exactly fifteen entries");
  } finally {
    rimraf(dir);
  }
});

test("install: replaces the old local clone path without duplicating", async () => {
  const dir = tempDir();
  try {
    const settingsFile = path.join(dir, "settings.json");
    writeJson(settingsFile, {
      hooks: {
        Stop: [
          { hooks: [
            { type: "command", command: 'node "' + OLD + '/no-idle.mjs"', timeout: 30 },
            { type: "command", command: 'node "' + OLD + '/wake.mjs"', asyncRewake: true, timeout: 1800 },
            { type: "command", command: 'powershell -File "C:/tools/notify.ps1"', timeout: 5 },
          ] },
        ],
      },
    });
    const r = await run(INSTALL, ["--config-dir", dir]);
    assert.equal(r.code, 0, r.stderr);
    const settings = read(settingsFile);
    const cmds = commands(settings.hooks);
    assert.equal(cmds.filter((c) => c.includes("no-idle.mjs")).length, 1, "no duplicate no-idle");
    assert.equal(cmds.filter((c) => c.includes("wake.mjs")).length, 1, "no duplicate wake");
    assert.ok(!cmds.some((c) => c.includes("C:/Users/scott/Desktop/Code/claude-hook-kit/hooks/")), "the old path is gone");
    assert.ok(cmds.some((c) => c.includes("notify.ps1")), "the unrelated hook survived");
    assert.ok(cmds.some((c) => c.includes("/hook-kit/hooks/no-idle.mjs")), "the installed path is used");
  } finally {
    rimraf(dir);
  }
});

test("install: writes a backup with the timestamped name", async () => {
  const dir = tempDir();
  try {
    const settingsFile = path.join(dir, "settings.json");
    seedSettings(settingsFile);
    const r = await run(INSTALL, ["--config-dir", dir]);
    assert.equal(r.code, 0, r.stderr);
    const baks = fs.readdirSync(dir).filter((f) => /^settings\.json\.bak-hookkit-\d{8}-\d{6}$/.test(f));
    assert.equal(baks.length, 1, "one timestamped backup, got: " + fs.readdirSync(dir).join(", "));
    assert.deepEqual(read(path.join(dir, baks[0])).model, "opus", "the backup is the pre-install file");
  } finally {
    rimraf(dir);
  }
});

test("install: two runs in the same second do not clobber one backup", async () => {
  const dir = tempDir();
  try {
    const settingsFile = path.join(dir, "settings.json");
    seedSettings(settingsFile);
    // Back to back, so both runs stamp the same second. The second run must not
    // overwrite the first run's backup: the pre-install file must survive.
    const a = await run(INSTALL, ["--config-dir", dir]);
    const b = await run(INSTALL, ["--config-dir", dir]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const baks = fs.readdirSync(dir).filter((f) => /^settings\.json\.bak-hookkit-/.test(f));
    assert.equal(baks.length, 2, "two runs left two backups, got: " + baks.join(", "));
    // The first backup still holds the original seeded settings.
    assert.ok(baks.some((f) => read(path.join(dir, f)).model === "opus"), "the first backup survives intact");
  } finally {
    rimraf(dir);
  }
});

test("install: --dry-run writes nothing", async () => {
  const dir = tempDir();
  try {
    const r = await run(INSTALL, ["--dry-run", "--config-dir", dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readdirSync(dir).length, 0, "the temp folder is untouched");
    assert.ok(r.stdout.includes("DRY RUN"), "says it is a dry run");
    assert.ok(r.stdout.includes("/hook-kit/hooks/"), "prints the settings it would write");
  } finally {
    rimraf(dir);
  }
});

test("uninstall: removes only kit entries, keeps the rest, and backs up", async () => {
  const dir = tempDir();
  try {
    const settingsFile = path.join(dir, "settings.json");
    seedSettings(settingsFile);
    await run(INSTALL, ["--config-dir", dir]);
    const r = await run(UNINSTALL, ["--config-dir", dir]);
    assert.equal(r.code, 0, r.stderr);
    const settings = read(settingsFile);
    const cmds = commands(settings.hooks);
    assert.equal(cmds.filter((c) => c.includes("/hook-kit/hooks/")).length, 0, "no kit hooks remain");
    assert.ok(cmds.includes('powershell -File "C:/tools/notify.ps1"'), "the unrelated hook survived");
    assert.equal(settings.model, "opus", "the unrelated setting survived");
    const baks = fs.readdirSync(dir).filter((f) => /^settings\.json\.bak-hookkit-/.test(f));
    assert.equal(baks.length, 2, "install backed up, then uninstall backed up the file it was about to change");
    // The copied files stay by default.
    assert.ok(fs.existsSync(path.join(dir, "hook-kit")), "the copied files are kept by default");
    // --remove-files deletes them.
    const r2 = await run(UNINSTALL, ["--config-dir", dir, "--remove-files"]);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(fs.existsSync(path.join(dir, "hook-kit")), false, "--remove-files deleted the copied files");
  } finally {
    rimraf(dir);
  }
});

test("init-project: writes the config and refuses to overwrite", async () => {
  const dir = tempDir();
  try {
    const r = await run(INIT, [dir]);
    assert.equal(r.code, 0, r.stderr);
    const dest = path.join(dir, ".claude", "hook-kit.json");
    assert.ok(fs.existsSync(dest), "the config was written");
    const cfg = read(dest);
    assert.equal(cfg.enabled, true);
    assert.ok(cfg["db-write-guard"], "the minimal example content landed");
    // Refuses a second write.
    const r2 = await run(INIT, [dir]);
    assert.equal(r2.code, 1, "a second init is refused");
    assert.ok(/already exists/.test(r2.stderr), "says the file exists: " + r2.stderr);
    // --force overwrites.
    const r3 = await run(INIT, [dir, "--force"]);
    assert.equal(r3.code, 0, r3.stderr);
    // --example townreporter writes the other example.
    const dir2 = tempDir();
    try {
      const r4 = await run(INIT, [dir2, "--example", "townreporter"]);
      assert.equal(r4.code, 0, r4.stderr);
      assert.ok(read(path.join(dir2, ".claude", "hook-kit.json"))["deploy-gate"], "townreporter example landed");
    } finally {
      rimraf(dir2);
    }
  } finally {
    rimraf(dir);
  }
});

test("snippet: the committed snippet matches the shared source", async () => {
  const dir = tempDir();
  try {
    // The snippet in the repo must be exactly buildHookEntries with the placeholder.
    const gen = await new Promise((resolve) => {
      execFile(process.execPath, [path.join(REPO, "tools", "write-snippet.mjs")], { cwd: REPO, windowsHide: true }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stderr: String(stderr || "") }));
    });
    assert.equal(gen.code, 0, gen.stderr);
    const snippet = read(path.join(REPO, "install", "settings-snippet.json"));
    assert.ok(commands(snippet.hooks).every((c) => c.includes("<HOOK_KIT_DIR>")), "the snippet uses the placeholder, not a real path");
    assert.ok(!JSON.stringify(snippet).includes("C:/Users/scott"), "the snippet names no machine-specific path");
    assert.equal(commands(snippet.hooks).length, 15, "fifteen entries in the snippet");
  } finally {
    rimraf(dir);
  }
});
