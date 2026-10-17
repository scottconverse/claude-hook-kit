#!/usr/bin/env node
// Is the kit actually live on this machine, and on this project?
//
//   node doctor.mjs [--config-dir <dir>] [--project <dir>] [--json]
//
// Port of the hook-liveness idea from scottconverse/fleet-smoke (reference/fleet-smoke-hook_liveness.py),
// extended with what this kit knows about itself. Read-only: it never fires a hook against a real
// project, never writes settings, never notifies. Exit 1 when any row is FAIL.
//
// Rows:
//   settings   <settings folder>/settings.json parses
//   registered every kit script is registered under its event (missing = FAIL)
//   script     every registered hook command (kit or not) points at a file that exists
//   liveness   each installed kit hook, run with a no-config event in an empty temp folder, exits 0 silently
//   project    (with --project) .claude/hook-kit.json parses; which sections are on; path keys resolve
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildHookEntries, isKitCommand, KIT_SCRIPTS } from "./lib/hook-entries.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const asJson = args.includes("--json");
const configDir = opt("--config-dir") || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const project = opt("--project");
const rows = [];
const add = (check, status, detail) => rows.push({ check, status, detail });

// ---- settings.json ---------------------------------------------------------------------
const settingsPath = path.join(configDir, "settings.json");
let settings = null;
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8").replace(/^﻿/, ""));
  add("settings", "PASS", settingsPath + " parses");
} catch (e) {
  add("settings", "FAIL", settingsPath + ": " + (e.code === "ENOENT" ? "missing" : e.message));
}

// ---- every registered command -> script exists (fleet-smoke tier 1) ------------------------
const WRAPPERS = new Set(["powershell", "powershell.exe", "pwsh", "python", "python3", "python.exe", "py", "cmd", "cmd.exe", "bash", "sh", "node", "node.exe"]);
const tokens = (command) => [...String(command).matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
const looksLikePath = (t) => (t.includes("/") || t.includes("\\")) && !t.startsWith("-");
function scriptOf(command) {
  const t = tokens(command);
  if (!t.length) return null;
  const first = path.basename(t[0]).toLowerCase();
  if (!WRAPPERS.has(first) && looksLikePath(t[0])) return t[0];
  if (WRAPPERS.has(first)) for (const tok of t.slice(1)) if (looksLikePath(tok)) return tok;
  return null;
}
const registered = new Map(); // script name -> [events]
if (settings) {
  const events = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of g.hooks || []) {
      if (h.type !== "command" || !h.command) continue;
      const script = scriptOf(h.command);
      const name = script ? path.basename(script) : null;
      if (isKitCommand(h.command) && name) registered.set(name, [...(registered.get(name) || []), event]);
      if (!script) add("script", "PARTIAL", event + ": no script path recognized in `" + h.command + "`");
      else if (fs.existsSync(script)) add("script", "PASS", event + ": " + script);
      else add("script", "FAIL", event + ": script MISSING: " + script);
    }
  }
  // Which kit scripts are registered, and under the right events?
  const expected = buildHookEntries("<KIT>");
  const want = new Map();
  for (const [event, groups] of Object.entries(expected)) for (const g of groups) for (const h of g.hooks) {
    const name = path.basename(tokens(h.command)[1] || "");
    want.set(name, [...(want.get(name) || []), event]);
  }
  for (const [name, events] of want) {
    const got = registered.get(name) || [];
    const missing = events.filter((e) => !got.includes(e));
    if (!got.length) add("registered", "FAIL", name + " is not registered (expected under " + events.join(", ") + "). Run `node install.mjs`.");
    else if (missing.length) add("registered", "FAIL", name + " registered under " + got.join(", ") + " but not " + missing.join(", ") + ". Re-run `node install.mjs`.");
    else add("registered", "PASS", name + " under " + events.join(", "));
  }
}

// ---- liveness: each installed kit hook exits 0 with no config -------------------------------
const kitDir = path.join(configDir, "hook-kit", "hooks");
if (fs.existsSync(kitDir)) {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "hook-kit-doctor-"));
  try {
    // A temp folder may still sit under a tree that has a config; say so instead of lying.
    let d = empty, found = null;
    for (;;) {
      if (fs.existsSync(path.join(d, ".claude", "hook-kit.json"))) { found = d; break; }
      const p = path.dirname(d);
      if (p === d) break;
      d = p;
    }
    if (found) add("liveness", "PARTIAL", "temp folder " + empty + " has a config above it at " + found + "; liveness not checkable here");
    else {
      for (const name of KIT_SCRIPTS) {
        const file = path.join(kitDir, name);
        if (!fs.existsSync(file)) { add("liveness", "FAIL", name + " missing from " + kitDir); continue; }
        const event = JSON.stringify({ hook_event_name: "Stop", tool_name: "Bash", tool_input: { command: "echo" }, cwd: empty, session_id: "doctor" });
        try {
          const out = execFileSync(process.execPath, [file], { input: event, cwd: empty, encoding: "utf8", timeout: 20000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
          if (String(out).trim()) add("liveness", "FAIL", name + " printed with no config: " + String(out).trim().slice(0, 120));
          else add("liveness", "PASS", name + " exits 0 silently with no config");
        } catch (e) {
          add("liveness", "FAIL", name + " exit " + (e.status ?? "?") + " with no config: " + String(e.stderr || e.message).trim().slice(0, 160));
        }
      }
    }
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
} else add("liveness", "FAIL", kitDir + " does not exist. Run `node install.mjs`.");

// ---- project config --------------------------------------------------------------------
if (project) {
  const root = path.resolve(project);
  const cfgPath = path.join(root, ".claude", "hook-kit.json");
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^﻿/, ""));
    add("project", "PASS", cfgPath + " parses");
  } catch (e) {
    add("project", e.code === "ENOENT" ? "PARTIAL" : "FAIL", cfgPath + ": " + (e.code === "ENOENT" ? "absent (kit is off for this project)" : "bad JSON: " + e.message));
  }
  if (cfg) {
    if (cfg.enabled === false) add("project", "PARTIAL", "enabled: false — the whole kit is off for this tree");
    const known = new Set(KIT_SCRIPTS.map((n) => n.replace(/\.mjs$/, "")));
    for (const [key, val] of Object.entries(cfg)) {
      if (key === "enabled") continue;
      if (!known.has(key)) { add("project", "PARTIAL", "section `" + key + "` matches no kit hook (typo?)"); continue; }
      if (!val || typeof val !== "object") { add("project", "FAIL", "section `" + key + "` is not an object"); continue; }
      if (val.enabled === false) { add("project", "PASS", key + ": present, enabled: false"); continue; }
      const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));
      const pathKeys = ["rulesFile", "ledgerFile", "receiptDir", "receiptFile", "gatesDir", "findingsFile", "okFile", "runsDir", "gateDir", "stateDir", "overrideFile"];
      const optional = new Set(["receiptDir", "receiptFile", "gateDir", "stateDir", "overrideFile", "okFile", "runsDir"]);
      const missing = pathKeys.filter((k) => typeof val[k] === "string").map((k) => [k, resolve(val[k])]).filter(([, p]) => !fs.existsSync(p));
      const optionalMissing = missing.filter(([k]) => optional.has(k));
      const hardMissing = missing.filter(([k]) => !optional.has(k));
      if (hardMissing.length) add("project", "FAIL", key + ": " + hardMissing.map(([k, p]) => k + " -> " + p + " (missing)").join("; "));
      else add("project", "PASS", key + ": on" + (optionalMissing.length ? " (" + optionalMissing.map(([k]) => k).join(", ") + " not created yet)" : ""));
      if (Array.isArray(val.upstreamRoots)) for (const r of val.upstreamRoots) if (!fs.existsSync(resolve(r))) add("project", "FAIL", key + ": upstreamRoots entry missing: " + r);
    }
    if (!registered.size && settings) add("project", "FAIL", "project opts in but no kit hook is registered in " + settingsPath);
  }
}

const fails = rows.filter((r) => r.status === "FAIL").length;
if (asJson) process.stdout.write(JSON.stringify({ configDir, project: project ? path.resolve(project) : null, rows, fails }, null, 2) + "\n");
else {
  for (const r of rows) process.stdout.write(r.status.padEnd(8) + r.check.padEnd(11) + r.detail + "\n");
  process.stdout.write("\n" + rows.filter((r) => r.status === "PASS").length + " PASS, " + fails + " FAIL, " + rows.filter((r) => r.status === "PARTIAL").length + " PARTIAL\n");
}
process.exit(fails ? 1 : 0);
