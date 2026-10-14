// PreToolUse hook (Bash|PowerShell): blocks a production deploy until the gate file for the
// exact origin/main sha exists and is complete. Exit 2 = blocked.
// Port of reference/tr-gate-deploy.mjs with the TownReporter values moved into config.
// Config section "deploy-gate":
//   commandPattern  regex string matching a deploy command
//   skipPatterns    regex strings; if any matches, this is a note/edit/rollback, not a deploy
//   repoDir         git repo the sha comes from
//   shaFrom         "origin/main" (git fetch origin --quiet, then rev-parse origin/main) or "HEAD"
//   gatesDir        folder of <sha>.json gate files
//   requiredKeys    [{ key, test, expected, message }] simple field checks
//   mustEqual       [{ key, other }] this key must equal another key (e.g. testServerCommit == commit)
//   reportKey       gate field holding the path of a walk report
//   reportMustContain regex string the walk report must match ("^PUBLISH-WALK:\\s*PASS\\s*$")
//   findingsFile    optional findings list; rows still OPEN block a deploy
//   openPattern     optional regex string matching an OPEN finding row
//   textOnlyKey     optional (default "textOnly") gate flag for a text-only push
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadFromStdin, resolveIn, rx } from "../lib/config.mjs";

const { input, section } = loadFromStdin("deploy-gate");
if (!section) process.exit(0);

const s = section;
const cmd = String(input?.tool_input?.command ?? "");
const cmdRx = rx(s.commandPattern, "i");
if (!cmdRx) process.exit(0);
if (!cmdRx.test(cmd)) process.exit(0);
// Writing notes, logs or briefs that merely MENTION the script is not running it.
const skip = (Array.isArray(s.skipPatterns) ? s.skipPatterns : []).map((p) => rx(p, "i")).filter(Boolean);
if (skip.some((r) => r.test(cmd))) process.exit(0);

const repo = resolveIn(section.cfg, s.repoDir);
const gates = resolveIn(section.cfg, s.gatesDir);
const skill = String(s.skillName || "");
const label = String(s.label || "this project");
const pathLine = String(s.pathLine || "");
const nextStep = String(s.nextStep || "Do the missing tier, then write the gate file.");

const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
let sha = "";
const shaFrom = String(s.shaFrom || "origin/main");
try {
  if (shaFrom === "HEAD") sha = git("rev-parse", "HEAD");
  else {
    git("fetch", "origin", "--quiet");
    sha = git("rev-parse", shaFrom);
  }
} catch (e) {
  console.error(label + " gate: cannot read " + shaFrom + " (" + String(e.message).slice(0, 120) + "). Deploy blocked.");
  process.exit(2);
}

const fail = (lines) => {
  console.error(
    "BLOCKED by " + (skill ? skill + ". " : "") + "Production deploy of " + shaFrom + " " + sha.slice(0, 8) + " needs gate file:\n  " + gates + "/" + sha + ".json\n" +
      "Missing or wrong:\n  - " + lines.join("\n  - ") +
      (pathLine ? "\n" + pathLine : "") +
      "\n" + nextStep,
  );
  process.exit(2);
};

const file = path.join(gates, sha + ".json");
if (!fs.existsSync(file)) fail(["gate file does not exist (no full Test walk recorded for this commit)"]);
let g = {};
try {
  g = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  fail(["gate file is not valid JSON"]);
}

// Run the configured checks against the gate object. `miss` is the list sent to fail().
function requiredFailures(obj) {
  const miss = [];
  for (const k of Array.isArray(s.requiredKeys) ? s.requiredKeys : []) {
    const got = obj[k.key];
    const mode = String(k.test || "truthy");
    let ok = false;
    if (mode === "eq") ok = got === k.expected;
    else if (mode === "neq") ok = got !== k.expected;
    else if (mode === "ieq") ok = String(got).toUpperCase() === String(k.expected).toUpperCase();
    else if (mode === "length") ok = String(got ?? "").length >= Number(k.min ?? 1);
    else if (mode === "match") ok = rx(k.pattern) ? rx(k.pattern).test(String(got ?? "")) : false;
    else ok = Boolean(got);
    if (!ok) miss.push(String(k.message || k.key));
  }
  for (const m of Array.isArray(s.mustEqual) ? s.mustEqual : []) {
    if (obj[m.key] !== obj[m.other]) {
      miss.push(String(m.message || m.key + " must equal " + m.other));
    }
  }
  return miss;
}

// A text-only push needs its own smaller set: only textOnly, commit, the go, the file list,
// and a diff from the live build that touches nothing else.
const textOnlyKey = String(s.textOnlyKey || "textOnly");
if (s.textOnly && g[textOnlyKey] === true) {
  const tmiss = [];
  for (const k of Array.isArray(s.textOnly.requiredKeys) ? s.textOnly.requiredKeys : []) {
    const got = g[k.key];
    const mode = String(k.test || "truthy");
    let ok = mode === "eq" ? got === k.expected : Boolean(got);
    if (!ok) tmiss.push(String(k.message || k.key));
  }
  const allowed = Array.isArray(g[s.textOnly.filesKey || "textFiles"]) ? g[s.textOnly.filesKey || "textFiles"] : [];
  if (!allowed.length) tmiss.push(String(s.textOnly.filesMessage || "textFiles: the files this text change touches"));
  try {
    const changed = git("diff", "--name-only", git("rev-parse", "HEAD"), sha).split(/\r?\n/).filter(Boolean);
    const extra = changed.filter((f) => !allowed.includes(f));
    if (extra.length) tmiss.push(String(s.textOnly.extraMessage || "not text-only; these files also changed: ") + extra.slice(0, 8).join(", "));
  } catch {
    tmiss.push("cannot diff live HEAD to " + sha.slice(0, 8));
  }
  if (tmiss.length) fail(tmiss);
  process.exit(0);
}

const miss = requiredFailures(g);

if (s.reportKey) {
  let rep = String(g[s.reportKey] ?? "");
  if (!rep || !fs.existsSync(rep)) miss.push(String(s.reportMessage || s.reportKey + ": path to an existing walk report"));
  else {
    const mustRx = rx(s.reportMustContain, "m");
    const t = fs.readFileSync(rep, "utf8");
    if (mustRx && !mustRx.test(t)) miss.push(String(s.reportMustContainMessage || "walk report must contain the line " + JSON.stringify(s.reportMustContain)));
  }
}

if (s.findingsFile) {
  const findings = resolveIn(section.cfg, s.findingsFile);
  if (!fs.existsSync(findings)) miss.push("findings list missing: " + findings);
  else {
    const openRx = rx(s.openPattern, "gm");
    const open = openRx
      ? [...fs.readFileSync(findings, "utf8").matchAll(openRx)].map((m) => (m[1] || "") + " " + String(m[2] || "").trim().slice(0, 70))
      : [];
    if (open.length) miss.push(open.length + " OPEN finding(s) in " + findings + " (fix and prove, or mark them later):\n      " + open.join("\n      "));
  }
}

if (miss.length) fail(miss);
process.exit(0);
