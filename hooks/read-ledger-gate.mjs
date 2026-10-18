// PreToolUse hook (Write|Edit|Bash|PowerShell): no code until the read ledger exists.
// Scott, Oct 15 2026, after Siftwing: three agents were told "read the upstream repos first"
// and none did. A rule in a prompt did not hold. This hook holds it: a write to a code file is
// blocked until .claude/READ-LEDGER.md lists the upstream files that were read, with line
// counts, and each listed file really exists with that many lines. Exit 2 = blocked.
//
// Config section "read-ledger-gate":
//   ledgerFile      path of the ledger (default ".claude/READ-LEDGER.md")
//   codePattern     regex string; a target path matching it is code and is gated
//                   (default: common source extensions, see DEFAULT_CODE)
//   exemptPattern   regex string; a matching path is never gated (default: .claude/, *.md, *.txt, *.json)
//   shellWritePattern regex string; a Bash/PowerShell command must match it before its write
//                   destinations are extracted (running or naming a code file is not a write)
//   rowPattern      regex string with two capture groups, path then line count, matched per ledger line
//   upstreamRoots   list of folders a relative ledger path may live in (default: the project folder)
//   requireExisting boolean (default true): every ledger row must resolve to a real file
//   verifyLines     boolean (default true): the stated line count must equal the file's real count
//   minEntries      number (default 1): rows needed before any code may be written
//   minLines        number (default 0): total lines read across all rows
//   mustMention     list of words; each must appear in some row path (e.g. ["wagalo", "wigolo"])
//   label, skillName, nextStep   the project's own words in the block message
import fs from "node:fs";
import path from "node:path";
import { block, loadFromStdin, resolveIn, rx } from "../lib/config.mjs";

const { input, section } = loadFromStdin("read-ledger-gate");
if (!section) process.exit(0);

const s = section;
const DEFAULT_CODE = "\\.(c|cc|cpp|cs|css|go|h|html|java|js|jsx|kt|mjs|cjs|php|ps1|psm1|py|rb|rs|scss|sh|sql|swift|ts|tsx|vue)$";
const DEFAULT_EXEMPT = "(^|[\\\\/])\\.claude[\\\\/]|\\.(md|txt|json|ya?ml|toml|lock|csv)$";
const DEFAULT_SHELL_WRITE = "<<|>>?\\s*[^&|\\s]|\\bSet-Content\\b|\\bAdd-Content\\b|\\bOut-File\\b|\\btee\\b|\\bcp\\b|\\bmv\\b|\\bCopy-Item\\b|\\bMove-Item\\b|\\bsed\\s+-i|\\bgit\\s+(apply|am|checkout|restore|revert|cherry-pick|merge|rebase|pull)\\b";
// "- path/to/file.ts — 312 lines", "* path 312", "| path | 312 |", "path, 312"
const DEFAULT_ROW = "^\\s*(?:[-*]\\s+|\\|\\s*)?`?([^\\s|`]+\\.[A-Za-z0-9]+)`?\\s*(?:\\||,|—|–|-|:|\\s)+\\s*(\\d+)\\b";

const codeRx = rx(s.codePattern || DEFAULT_CODE, "i");
const exemptRx = rx(s.exemptPattern || DEFAULT_EXEMPT, "i");
const shellRx = rx(s.shellWritePattern || DEFAULT_SHELL_WRITE, "");
const rowRx = rx(s.rowPattern || DEFAULT_ROW, "");
if (!codeRx || !rowRx) process.exit(0);

const ti = input.tool_input || {};
const tool = String(input.tool_name || "");
const ledger = resolveIn(s.cfg, s.ledgerFile || ".claude/READ-LEDGER.md");

// Shell commands: only the paths a command WRITES are targets. Running a script (`node x.mjs`),
// reading one (`cat x.py`) or naming one in a string is not a write. Oct 17, 2026: the old rule
// took every code-looking token, which blocked `node doctor.mjs` and an issue body that quoted a
// path, and pushed the operator to switch the gate off. Writes seen: `>` / `>>` redirection,
// `tee`, the destination of cp/mv/Copy-Item/Move-Item, the path of Set-Content/Add-Content/
// Out-File, the files after `sed -i`, and the files named after a git verb that rewrites the
// tree. A write hidden inside an interpreter (`python -c "open(...)"`) is not seen; command-gate's
// blockInlineCode covers that surface.
function splitSegments(c) {
  const parts = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (q) {
      cur += ch;
      if (ch === "\\" && q === '"' && i + 1 < c.length) cur += c[++i];
      else if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if ((ch === "&" && c[i + 1] === "&") || (ch === "|" && c[i + 1] === "|")) { parts.push(cur); cur = ""; i++; continue; }
    if (ch === ";" || ch === "|" || ch === "\n") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}
const tokensOf = (seg) => [...seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
const looksLikeFile = (t) => /\.[A-Za-z0-9]+$/.test(t) && !t.startsWith("-");
function shellWriteTargets(cmd) {
  const out = [];
  for (const seg of splitSegments(cmd)) {
    const toks = tokensOf(seg);
    if (!toks.length) continue;
    for (let i = 0; i < toks.length; i++) {
      const m = /^(?:\d?>>?|&>)(.*)$/.exec(toks[i]);
      if (!m) continue;
      if (m[1]) out.push(m[1]);
      else if (toks[i + 1]) out.push(toks[i + 1]);
    }
    const verb = toks[0].toLowerCase().replace(/^.*[\\/]/, "").replace(/\.exe$/, "");
    const args = toks.slice(1);
    const positional = args.filter((a) => !a.startsWith("-") && !/^(?:\d?>>?|&>)/.test(a));
    const after = (re) => { const i = args.findIndex((a) => re.test(a)); return i >= 0 ? args[i + 1] : undefined; };
    if (verb === "tee") out.push(...positional);
    else if (["cp", "mv", "copy", "move", "copy-item", "move-item"].includes(verb)) out.push(after(/^-(Destination|LiteralPath)$/i) || positional[positional.length - 1] || "");
    else if (["set-content", "add-content", "out-file"].includes(verb)) out.push(after(/^-(Path|LiteralPath|FilePath)$/i) || positional[0] || "");
    else if (verb === "sed" && args.some((a) => /^-i/.test(a))) out.push(...positional.filter(looksLikeFile));
    else if (verb === "git" && /^(apply|am|checkout|restore|revert|cherry-pick|merge|rebase|pull)$/.test((args[0] || "").toLowerCase())) out.push(...positional.slice(1).filter(looksLikeFile));
  }
  return out.filter(Boolean);
}

// Is this tool call a write to code?
let targets = [];
if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
  targets = [String(ti.file_path || ti.notebook_path || ti.path || "")];
} else {
  const cmd = String(ti.command || "");
  if (!shellRx || !shellRx.test(cmd)) process.exit(0);
  targets = shellWriteTargets(cmd);
}
const isLedgerItself = (p) => path.resolve(String(p).split("\\").join("/")) === path.resolve(ledger);
const codeTargets = targets.filter((p) => p && codeRx.test(p) && !(exemptRx && exemptRx.test(p)) && !isLedgerItself(p));
if (!codeTargets.length) process.exit(0);

const label = String(s.label || path.basename(s.cfg.dir));
const skill = s.skillName ? String(s.skillName) + ": " : "";
const nextStep = String(
  s.nextStep ||
    "Read the upstream code first. Then write the ledger: one row per file, `- <path> — <lines> lines`. Then write code.",
);
const fail = (lines) =>
  block(
    "BLOCKED by " + skill + "read-ledger-gate (" + label + "). No code until the read ledger is complete.\n" +
      "  ledger: " + ledger + "\n" +
      "  target: " + codeTargets[0] + (codeTargets.length > 1 ? " (+" + (codeTargets.length - 1) + " more)" : "") + "\n" +
      "Missing or wrong:\n  - " + lines.join("\n  - ") + "\n" + nextStep,
  );

let text = "";
try {
  text = fs.readFileSync(ledger, "utf8");
} catch {
  fail(["the ledger file does not exist"]);
}

const roots = (Array.isArray(s.upstreamRoots) && s.upstreamRoots.length ? s.upstreamRoots : ["."]).map((r) => resolveIn(s.cfg, r));
const requireExisting = s.requireExisting !== false;
const verifyLines = s.verifyLines !== false;
const minEntries = Number(s.minEntries ?? 1);
const minLines = Number(s.minLines ?? 0);
const mustMention = Array.isArray(s.mustMention) ? s.mustMention.map(String) : [];

const countLines = (file) => {
  const buf = fs.readFileSync(file);
  if (!buf.length) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  if (buf[buf.length - 1] !== 10) n++; // last line without a newline still counts
  return n;
};
const resolveRow = (p) => {
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) return fs.existsSync(p) ? p : "";
  for (const r of roots) {
    const f = path.resolve(r, p);
    if (fs.existsSync(f)) return f;
  }
  return "";
};

const problems = [];
const rows = [];
for (const line of text.split(/\r?\n/)) {
  const m = rowRx.exec(line);
  if (!m) continue;
  const p = m[1];
  const stated = Number(m[2]);
  const file = resolveRow(p);
  if (!file) {
    if (requireExisting) problems.push("row names a file that does not exist under any upstream root: " + p);
    rows.push({ p, stated, actual: null });
    continue;
  }
  let actual = null;
  try {
    actual = fs.statSync(file).isFile() ? countLines(file) : null;
  } catch {}
  if (actual === null) {
    if (requireExisting) problems.push("row is not a readable file: " + p);
  } else if (verifyLines && actual !== stated) {
    problems.push("row says " + stated + " lines but " + p + " has " + actual);
  }
  rows.push({ p, stated, actual });
}

if (rows.length < minEntries) problems.unshift("ledger has " + rows.length + " row(s); at least " + minEntries + " needed (format: `- <path> — <lines> lines`)");
const total = rows.reduce((n, r) => n + (r.actual ?? 0), 0);
if (minLines > 0 && total < minLines) problems.push("rows account for " + total + " real lines read; at least " + minLines + " needed");
for (const w of mustMention) {
  const needle = w.toLowerCase();
  if (!rows.some((r) => r.p.toLowerCase().includes(needle))) problems.push("no row mentions \"" + w + "\"");
}

if (problems.length) fail(problems);
process.exit(0);
