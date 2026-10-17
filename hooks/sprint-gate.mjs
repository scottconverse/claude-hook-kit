// Stop hook + CLI: while a sprint is armed, the agent cannot end the turn, and only a human
// with the release passphrase can disarm. Port of scottconverse/AntiStallClaude v0.3.2
// (hooks/antistall-gate.py and hooks/antistall.py; reference/ holds the originals).
//
// Hook mode (no arguments, event on stdin):
//   - no armed gate for this session      -> exit 0, silent
//   - armed                               -> exit 2 with a "keep working" message; a per-session
//                                            block counter is kept
//   - counter reaches cap                 -> PAUSE: this one stop is allowed (exit 0, note on stdout),
//                                            a desktop toast summons the human, the gate STAYS ARMED
//   - counter unreadable/corrupt          -> PAUSE (fail open); the gate stays armed
// Pausing never disarms. Only `release` with the passphrase clears a gate.
//
// CLI mode (node sprint-gate.mjs <command> [text] [--all]), run from inside the project:
//   set-release-secret   human, once: store a PBKDF2 hash of a passphrase (user-level file)
//   arm "<goal>"         agent or human: arm the gate (refused until a secret exists)
//   status
//   request "<why>"      agent: ask the human to stop; notifies; does NOT disarm
//   release [--all]      human: masked passphrase prompt; disarms this session's gate (or all)
//
// Config section "sprint-gate":
//   gateDir              folder for gate and counter files (default ".claude/sprint", relative to the project)
//   cap                  consecutive blocks before a pause (default 25; 0 = never pause)
//   honorStopHookActive  boolean (default false). The original ignores it on purpose: the only brake is the cap.
//   secretFile           path of the release hash (default: ~/.claude/antistall-release.hash if it exists, else ~/.claude/sprint-release.hash)
//   label                project name in messages
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { block, findConfig, load, readStdin, resolveIn, sectionFor } from "../lib/config.mjs";

const PBKDF2_ITERS = 240000;
const safeSid = (sid) => String(sid).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const unlink = (p) => {
  try {
    fs.unlinkSync(p);
  } catch {}
};
const userClaude = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const defaultSecretFile = () => {
  const legacy = path.join(userClaude(), "antistall-release.hash");
  return fs.existsSync(legacy) ? legacy : path.join(userClaude(), "sprint-release.hash");
};

// Settings for this project: the config section if present, defaults otherwise.
function settings(cfg) {
  const s = (cfg && sectionFor(cfg, "sprint-gate")) || {};
  const projectDir = cfg ? cfg.dir : process.cwd();
  const gateDir = s.gateDir ? (path.isAbsolute(s.gateDir) ? s.gateDir : path.resolve(projectDir, s.gateDir)) : path.join(projectDir, ".claude", "sprint");
  return {
    gateDir,
    cap: Math.max(0, Number(s.cap ?? 25)),
    honorStopHookActive: s.honorStopHookActive === true,
    secretFile: s.secretFile ? resolveIn({ dir: projectDir }, s.secretFile) : defaultSecretFile(),
    label: String(s.label || path.basename(projectDir)),
    enabled: !!(cfg && sectionFor(cfg, "sprint-gate")),
  };
}

// Which armed gate applies to this session: the session-scoped file first, then a
// project-wide gate.json that is unowned or owned by this session.
function activeGate(gateDir, sid) {
  if (sid) {
    const gp = path.join(gateDir, "gate-" + safeSid(sid) + ".json");
    const g = readJson(gp);
    if (g && typeof g === "object" && g.active) return gp;
  }
  const legacyPath = path.join(gateDir, "gate.json");
  const legacy = readJson(legacyPath);
  if (legacy && typeof legacy === "object" && legacy.active) {
    if (legacy.owner == null || legacy.owner === sid) return legacyPath;
  }
  return null;
}

function notify(msg) {
  if (process.platform !== "win32") return;
  try {
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;" +
      "$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Warning;$n.Visible=$true;" +
      "$n.BalloonTipTitle='Sprint gate';$n.BalloonTipText=$env:SPRINT_MSG;$n.ShowBalloonTip(7000);Start-Sleep -Milliseconds 7500;$n.Dispose()";
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      env: { ...process.env, SPRINT_MSG: msg.slice(0, 240) },
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

// ------------------------------------------------------------------ hook mode
function hook() {
  const input = readStdin();
  const { cfg, section } = load("sprint-gate", input);
  if (!section) process.exit(0);
  const st = settings(cfg);
  const sid = typeof input.session_id === "string" && input.session_id.trim() ? input.session_id : null;
  const gatePath = activeGate(st.gateDir, sid);
  if (!gatePath) process.exit(0);
  if (st.honorStopHookActive && input.stop_hook_active === true) process.exit(0);

  const countPath = path.join(st.gateDir, "count-" + (sid ? safeSid(sid) : "shared"));
  const pause = (why) => {
    process.stdout.write("sprint-gate (" + st.label + "): stop PAUSED (" + why + "). The sprint is STILL ARMED and re-enforces next turn; only `release` with the passphrase ends it.\n");
    process.exit(0);
  };
  let n;
  try {
    n = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8").trim()) + 1 : 1;
  } catch {
    pause("counter unreadable");
  }
  if (!Number.isFinite(n)) {
    unlink(countPath);
    pause("counter corrupt; reset");
  }
  if (st.cap > 0 && n >= st.cap) {
    unlink(countPath); // reset the counter only; the gate file stays armed
    notify("Sprint gate paused at block cap (" + st.cap + "); sprint STILL ARMED. Review and run release if it is truly done.");
    pause("token-burn cap " + st.cap + " reached; a human was notified");
  }
  try {
    fs.mkdirSync(st.gateDir, { recursive: true });
    fs.writeFileSync(countPath, String(n));
  } catch {
    pause("cannot persist counter");
  }
  const me = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  block(
    "SPRINT-GATE (" + st.label + "): a sprint is ARMED. Do NOT end the turn. Keep working until the goal is genuinely done. " +
      "You cannot stop or disarm yourself. " +
      "IF THE HUMAN ASKS YOU TO STOP / DISARM / CANCEL: immediately run `node \"" + me + "\" release` from the project folder. " +
      "That pops a PASSWORD BOX on their screen for THEM to type into; you cannot fill it, and that is fine. " +
      "Do not tell them to open a terminal and do not claim they released you. " +
      "If you are genuinely blocked on a human-only decision, run `node \"" + me + "\" request \"<why>\"` to ping them, then keep working on anything else still buildable. " +
      "Block " + n + (st.cap > 0 ? "/" + st.cap : " (no cap; held until human release)") + ". Gate: " + gatePath,
  );
}

// ------------------------------------------------------------------ CLI mode
const hashPass = (pass, salt) => crypto.pbkdf2Sync(pass, salt, PBKDF2_ITERS, 32, "sha256").toString("hex");
function storeSecret(file, pass) {
  const salt = crypto.randomBytes(16);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ algo: "pbkdf2_sha256", iters: PBKDF2_ITERS, salt: salt.toString("hex"), hash: hashPass(pass, salt) }));
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}
function verifySecret(file, pass) {
  try {
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    const a = Buffer.from(hashPass(pass, Buffer.from(rec.salt, "hex")), "hex");
    const b = Buffer.from(rec.hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
const psStr = (t) => "'" + String(t).replace(/'/g, "''") + "'";
function guiPassword(title, prompt) {
  // Masked Windows dialog. The agent can launch it but cannot see what is typed into it;
  // stdout of the child is consumed here and never re-emitted.
  if (process.platform !== "win32") return null;
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.Text = ${psStr(title)}
$f.Size = New-Object System.Drawing.Size(460,190)
$f.StartPosition = 'CenterScreen'; $f.TopMost = $true
$f.FormBorderStyle = 'FixedDialog'; $f.MinimizeBox = $false; $f.MaximizeBox = $false
$l = New-Object System.Windows.Forms.Label
$l.Text = ${psStr(prompt)}; $l.SetBounds(14,14,420,44)
$t = New-Object System.Windows.Forms.TextBox
$t.UseSystemPasswordChar = $true; $t.SetBounds(14,62,420,26)
$ok = New-Object System.Windows.Forms.Button
$ok.Text='OK'; $ok.DialogResult=[System.Windows.Forms.DialogResult]::OK; $ok.SetBounds(260,104,80,30)
$c = New-Object System.Windows.Forms.Button
$c.Text='Cancel'; $c.DialogResult=[System.Windows.Forms.DialogResult]::Cancel; $c.SetBounds(350,104,80,30)
$f.AcceptButton=$ok; $f.CancelButton=$c
$f.Controls.AddRange(@($l,$t,$ok,$c))
$f.Add_Shown({ $f.Activate(); $t.Focus() })
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($t.Text) } else { exit 2 }
`;
  const enc = Buffer.from(ps, "utf16le").toString("base64");
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? String(r.stdout) : null;
}
function readPassphrase(prompt, title) {
  const env = process.env.SPRINT_RELEASE || process.env.ANTISTALL_RELEASE;
  if (env) return env;
  const gui = guiPassword(title, prompt);
  if (gui !== null) return gui;
  return "";
}

function cli(argv) {
  const cmd = String(argv[0] || "status").toLowerCase();
  const detail = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  const cfg = findConfig(process.cwd());
  const st = settings(cfg);
  const sid = process.env.CLAUDE_CODE_SESSION_ID && process.env.CLAUDE_CODE_SESSION_ID.trim() ? process.env.CLAUDE_CODE_SESSION_ID : null;
  const flag = path.join(st.gateDir, sid ? "gate-" + safeSid(sid) + ".json" : "gate.json");
  const secretExists = fs.existsSync(st.secretFile);
  const out = (t) => process.stdout.write(t + "\n");
  const err = (t) => process.stderr.write(t + "\n");
  const clearCounts = () => {
    try {
      for (const f of fs.readdirSync(st.gateDir)) if (f.startsWith("count-")) unlink(path.join(st.gateDir, f));
    } catch {}
  };

  if (cmd === "set-release-secret" || cmd === "set-secret") {
    if (secretExists && !verifySecret(st.secretFile, readPassphrase("Enter your CURRENT release passphrase (required to change it):", "Sprint gate - change passphrase"))) {
      err("wrong current passphrase - refusing to change the release secret.");
      return 4;
    }
    const p1 = readPassphrase("Choose a NEW release passphrase. Only you will know it; you will need it to stop a sprint.", "Sprint gate - set passphrase");
    if (!p1) {
      err("no passphrase entered - aborted.");
      return 4;
    }
    const p2 = readPassphrase("Re-enter the same passphrase to confirm:", "Sprint gate - confirm passphrase");
    if (p1 !== p2) {
      err("passphrases did not match - aborted. Run it again.");
      return 4;
    }
    storeSecret(st.secretFile, p1);
    out("release secret stored at " + st.secretFile + ". Only this passphrase can disarm a sprint now; the agent never saw what you typed.");
    return 0;
  }
  if (cmd === "arm") {
    if (!secretExists) {
      err("REFUSING TO ARM: no release secret is set, so the sprint could only be disarmed by the agent, which defeats the gate. Run `set-release-secret` first (a password box appears for the human).");
      return 5;
    }
    if (!st.enabled) err("note: this project has no \"sprint-gate\" section in .claude/hook-kit.json, so the hook will not enforce this gate until one is added.");
    fs.mkdirSync(st.gateDir, { recursive: true });
    fs.writeFileSync(flag, JSON.stringify({ active: true, note: detail, owner: sid, armedAt: new Date().toISOString() }));
    clearCounts();
    out("armed: sprint gate ACTIVE [" + (sid ? "session " + sid.slice(0, 8) : "project-wide") + "] - " + (detail || "(no note)") + "\n  TO STOP: tell the agent \"disarm\". It pops a PASSWORD BOX; type your passphrase there. The agent can open the box but can never fill it.");
    return 0;
  }
  if (cmd === "release") {
    if (!secretExists) {
      err("no release secret is set - nothing to verify against. Refusing to disarm without proof of human authority.");
      return 5;
    }
    if (!verifySecret(st.secretFile, readPassphrase("Enter your release passphrase to STOP the sprint:", "Sprint gate - release / disarm"))) {
      err("WRONG passphrase - sprint NOT disarmed.");
      return 6;
    }
    let targets = [];
    try {
      const all = fs.readdirSync(st.gateDir).filter((f) => f.startsWith("gate") && f.endsWith(".json")).map((f) => path.join(st.gateDir, f));
      targets = argv.includes("--all") || !sid ? all : all.filter((f) => f === flag || path.basename(f) === "gate.json");
    } catch {}
    let n = 0;
    for (const t of targets) {
      try {
        fs.unlinkSync(t);
        n++;
      } catch {}
    }
    clearCounts();
    unlink(path.join(st.gateDir, "stop-request.json"));
    out("RELEASED by human - disarmed " + n + " gate file(s) in " + st.gateDir + ".");
    return 0;
  }
  if (cmd === "request" || cmd === "ask") {
    try {
      fs.mkdirSync(st.gateDir, { recursive: true });
      fs.writeFileSync(path.join(st.gateDir, "stop-request.json"), JSON.stringify({ detail, at: new Date().toISOString(), session: sid }));
    } catch {}
    notify("Agent wants to STOP: " + detail.slice(0, 160) + " - review and run release if you agree.");
    out("stop-request recorded and the human was notified. The gate stays ARMED; keep working until a human runs `release`.");
    return 0;
  }
  if (cmd === "status") {
    const g = readJson(flag);
    const armed = !!(g && g.active);
    let line = "Sprint gate [" + (sid ? "session " + sid.slice(0, 8) : "project-wide") + "]: " + (armed ? "ARMED" : "disarmed") + ".";
    if (armed && g.note) line += " Note: " + g.note + ".";
    line += " Release secret set: " + (secretExists ? "yes" : "NO (arm is blocked until set)") + ".";
    line += " Hook " + (st.enabled ? "enabled" : "NOT enabled (no sprint-gate section in hook-kit.json)") + ". Disarm is human-only (release + passphrase).";
    out(line);
    return 0;
  }
  if (["done", "blocked", "question", "disarm", "off"].includes(cmd)) {
    err("'" + cmd + "' does not exist: an agent cannot disarm or self-authorize a stop. Use `request \"<why>\"` to summon the human; only a human `release` ends a sprint.");
    return 7;
  }
  err("unknown command: " + cmd + " (use arm | status | request | release | set-release-secret)");
  return 2;
}

if (process.argv.length > 2) process.exit(cli(process.argv.slice(2)));
else hook();
