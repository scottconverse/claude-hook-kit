// Stop hook: no "done" without a fresh measurement.
// Scott, Oct 15 2026, after Siftwing: two days of work ended with reports that said "done" and
// a product that measured 0 of 33. This hook holds the rule "every step ends with a number":
// a turn may not end while the newest code file is newer than the newest receipt file.
// Exit 2 = the turn may not end yet.
//
// A Stop hook that blocks forever would burn tokens forever, so this one gives up after
// maxBlocks blocks in the same turn and lets the turn end with a note on stdout.
//
// Config section "measure-gate":
//   receiptFile     one receipt path; or
//   receiptDir + receiptPattern   a folder and a regex string for receipt file names; the newest wins
//   requireMatch    regex string the newest receipt must contain (e.g. "\"found\":\\s*\\d+")
//   codeDirs        folders scanned for code (default: the project folder)
//   codePattern     regex string for code file paths (default: common source extensions)
//   ignorePattern   regex string for paths never scanned (default: .git, node_modules, vendor, .claude, dist, build)
//   maxDepth        folder depth scanned (default 8)
//   maxBlocks       blocks per turn before giving up (default 3)
//   measureCommand  the command that makes a receipt, shown in the message
//   label, hookName the project's own words in the block message
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { block, loadFromStdin, resolveIn, rx } from "../lib/config.mjs";

const { input, section } = loadFromStdin("measure-gate");
if (!section) process.exit(0);

const s = section;
const DEFAULT_CODE = "\\.(c|cc|cpp|cs|css|go|h|html|java|js|jsx|kt|mjs|cjs|php|ps1|psm1|py|rb|rs|scss|sh|sql|swift|ts|tsx|vue)$";
const DEFAULT_IGNORE = "(^|[\\\\/])(\\.git|node_modules|vendor|third-party|\\.claude|dist|build|coverage|__pycache__|\\.venv|venv)([\\\\/]|$)";
const codeRx = rx(s.codePattern || DEFAULT_CODE, "i");
const ignoreRx = rx(s.ignorePattern || DEFAULT_IGNORE, "i");
if (!codeRx) process.exit(0);

const label = String(s.label || path.basename(s.cfg.dir));
const hookName = String(s.hookName || "measure-gate");
const maxBlocks = Math.max(1, Number(s.maxBlocks ?? 3));
const maxDepth = Math.max(1, Number(s.maxDepth ?? 8));

// --- newest receipt ---------------------------------------------------------
let receipt = "";
let receiptTime = 0;
if (s.receiptFile) {
  receipt = resolveIn(s.cfg, s.receiptFile);
  try {
    receiptTime = fs.statSync(receipt).mtimeMs;
  } catch {
    receiptTime = 0;
  }
} else if (s.receiptDir) {
  const dir = resolveIn(s.cfg, s.receiptDir);
  const pat = rx(s.receiptPattern || ".", "i");
  try {
    for (const name of fs.readdirSync(dir)) {
      if (pat && !pat.test(name)) continue;
      const f = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      if (st.isFile() && st.mtimeMs > receiptTime) {
        receiptTime = st.mtimeMs;
        receipt = f;
      }
    }
  } catch {}
} else {
  // No receipt location at all: nothing to compare against. Off, not a silent block.
  process.exit(0);
}

// --- newest code file -------------------------------------------------------
const dirs = (Array.isArray(s.codeDirs) && s.codeDirs.length ? s.codeDirs : ["."]).map((d) => resolveIn(s.cfg, d));
let codeTime = 0;
let codeFile = "";
const walk = (dir, depth) => {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const f = path.join(dir, e.name);
    if (ignoreRx && ignoreRx.test(f)) continue;
    if (e.isDirectory()) walk(f, depth + 1);
    else if (e.isFile() && codeRx.test(e.name)) {
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      if (st.mtimeMs > codeTime) {
        codeTime = st.mtimeMs;
        codeFile = f;
      }
    }
  }
};
for (const d of dirs) walk(d, 0);
if (!codeFile) process.exit(0); // no code at all: nothing to measure

// --- receipt content check -------------------------------------------------
let contentProblem = "";
if (receipt && receiptTime && s.requireMatch) {
  const need = rx(s.requireMatch, "m");
  try {
    if (need && !need.test(fs.readFileSync(receipt, "utf8"))) contentProblem = "the receipt does not match requireMatch " + s.requireMatch;
  } catch {
    contentProblem = "the receipt cannot be read";
  }
}

const stale = codeTime > receiptTime;
if (!stale && !contentProblem) process.exit(0);

// --- give-up counter, per session and turn ---------------------------------
// The turn key is the line number of the last real user message in the transcript.
// Same key as last time: this is another block in the same turn.
const turnKey = (() => {
  try {
    const lines = fs.readFileSync(String(input.transcript_path || ""), "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let m;
      try {
        m = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (m?.type !== "user") continue;
      const c = m?.message?.content;
      if (Array.isArray(c) && c.some((x) => x?.type === "tool_result")) continue;
      return "L" + i;
    }
  } catch {}
  return "unknown";
})();
const stateFile = path.join(os.tmpdir(), "hook-kit-measure-gate-" + String(input.session_id || "nosession").replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
let state = { turnKey: "", blocks: 0 };
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch {}
if (state.turnKey !== turnKey) state = { turnKey, blocks: 0 };
state.blocks += 1;
try {
  fs.writeFileSync(stateFile, JSON.stringify(state));
} catch {}

const fmt = (ms) => (ms ? new Date(ms).toISOString() : "never");
const why = [];
if (stale) why.push("newest code file " + codeFile + " changed at " + fmt(codeTime) + "; newest receipt " + (receipt || "(none)") + " is from " + fmt(receiptTime));
if (contentProblem) why.push(contentProblem);
const cmd = s.measureCommand ? "\nRun the measurement:\n  " + String(s.measureCommand) : "";

if (state.blocks > maxBlocks) {
  process.stdout.write(hookName + " (" + label + "): gave up after " + maxBlocks + " blocks this turn. The receipt is still stale. Say so in the reply; do not say \"done\".\n  - " + why.join("\n  - ") + "\n");
  process.exit(0);
}

block(
  hookName.toUpperCase() + " (" + label + "): you may not end this turn as done. Code changed and no newer measurement exists.\n  - " +
    why.join("\n  - ") + cmd +
    "\nThen end the turn with the numbers from the receipt. If the measurement cannot run, say that plainly and do not say \"done\". (" + state.blocks + "/" + maxBlocks + ")",
);
