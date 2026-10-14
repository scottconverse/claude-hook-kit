// PreToolUse hook (Bash|PowerShell): blocks a TownReporter production deploy until the gate file for the
// exact origin/main sha exists and is complete. Exit 2 = blocked, message goes back to Claude.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
const cmd = String(input?.tool_input?.command ?? "");
const deploys = /deploy-production[.]ps1|promote[.]ps1/i;
if (!deploys.test(cmd)) process.exit(0);
// Writing notes, logs or briefs that merely MENTION the script is not running it.
if (/<<|Set-Content|Add-Content|Out-File|\becho\b|\bprintf\b|\bgrep\b|\bcat\b\s*>|Select-String/i.test(cmd)) process.exit(0);
// A rollback or a read-only status call is not a new release.
if (/-Rollback\b|\brollback\b|-WhatIf\b/i.test(cmd)) process.exit(0);

const repo = "C:/Users/scott/Desktop/Code/townreporter-web";
const gates = "C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/gates";
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
let sha = "";
try { git("fetch", "origin", "--quiet"); sha = git("rev-parse", "origin/main"); } catch (e) {
  console.error("TownReporter gate: cannot read origin/main (" + String(e.message).slice(0, 120) + "). Deploy blocked.");
  process.exit(2);
}
const fail = (lines) => {
  console.error(
    "BLOCKED by Scott's release path (skill townreporter-release-path).\n" +
      "Production deploy of origin/main " + sha.slice(0, 8) + " needs gate file:\n  " + gates + "/" + sha + ".json\n" +
      "Missing or wrong:\n  - " + lines.join("\n  - ") +
      "\nPath: branch -> dev server :3100 -> Test server :3400 FULL walk incl. Publish -> production. Do the missing tier, then write the gate file.",
  );
  process.exit(2);
};
const file = gates + "/" + sha + ".json";
if (!fs.existsSync(file)) fail(["gate file does not exist (no full Test walk recorded for this commit)"]);
let g = {};
try { g = JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail(["gate file is not valid JSON"]); }
// Scott, Oct 13 2026: "text changes are pushed. not merged and tested. you can check them for
// spelling". A text-only push needs: textOnly true, the files it may touch (textFiles), Scott's
// go (announcedAt), and a diff from the live build that touches nothing else. No CI, dev or Test.
if (g.textOnly === true) {
  const tmiss = [];
  if (g.commit !== sha) tmiss.push("commit must equal " + sha);
  if (!g.announcedAt) tmiss.push("announcedAt: Scott's go and the time");
  const allowed = Array.isArray(g.textFiles) ? g.textFiles : [];
  if (!allowed.length) tmiss.push("textFiles: the page files this text change touches");
  let changed = [];
  try { changed = git("diff", "--name-only", git("rev-parse", "HEAD"), sha).split(/\r?\n/).filter(Boolean); }
  catch (e) { tmiss.push("cannot diff live HEAD to " + sha.slice(0, 8)); }
  const extra = changed.filter((f) => !allowed.includes(f));
  if (extra.length) tmiss.push("not text-only; these files also changed: " + extra.slice(0, 8).join(", "));
  if (tmiss.length) fail(tmiss);
  process.exit(0);
}
const miss = [];
if (g.commit !== sha) miss.push("commit must equal " + sha);
if (!g.devServerRun || String(g.devServerRun).length < 8) miss.push("devServerRun: what ran on :3100 and the result");
if (g.testServerCommit !== sha) miss.push("testServerCommit must equal " + sha + " (Test server must run this exact build)");
if (String(g.ci).toUpperCase() !== "PASS") miss.push('ci must be "PASS"');
if (!g.announcedAt) miss.push("announcedAt: the time announced to Scott");
let rep = String(g.publishWalkReport ?? "");
if (!rep || !fs.existsSync(rep)) miss.push("publishWalkReport: path to an existing walk report");
else {
  const t = fs.readFileSync(rep, "utf8");
  if (!/^PUBLISH-WALK:\s*PASS\s*$/m.test(t)) miss.push('walk report must contain the line "PUBLISH-WALK: PASS"');
}
// Scott, Oct 11 ("1"): no deploy while a finding on the one findings list is OPEN.
// A row leaves OPEN only as FIXED <sha>, NOT-A-BUG <why>, LATER-SCOTT <date> (Scott's own "later"),
// or BACKLOG (Scott, Oct 12 "Option 1", good-enough bar: [confusing]/[looks bad]/desk-only wording;
// the row stays on the list for later work and never blocks a deploy).
// Oct 12: IDs with a dash (THT-8, DHI-1) were missed by the old [A-Z]+\d+ pattern.
const findings = "C:/Users/scott/Desktop/Goals/TownReporter-OPEN-FINDINGS.md";
if (!fs.existsSync(findings)) miss.push("findings list missing: " + findings);
else {
  const open = [...fs.readFileSync(findings, "utf8").matchAll(/^\|\s*([A-Z][A-Z0-9-]*\d)\s*\|\s*OPEN\b[^|]*\|\s*([^|]*)\|/gm)]
    .map((m) => m[1] + " " + m[2].trim().slice(0, 70));
  if (open.length) miss.push(open.length + " OPEN finding(s) in " + findings + " (fix and prove, or Scott says later):\n      " + open.join("\n      "));
}
if (miss.length) fail(miss);
process.exit(0);
