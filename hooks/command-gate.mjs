// PreToolUse hook (Bash|PowerShell): block shell commands the project forbids, even when they
// hide behind wrappers, path prefixes, pipelines or `sh -c`; and block an oversized `git commit`
// that carries no size-acknowledgment tag. Port of two pieces of scottconverse/hardgate:
// tests/fixtures/gate.py (the tokenizer and nested-shell walk) and
// templates/commit-size-gate/commit-size-gate.py. Originals in reference/. Exit 2 = blocked.
// Stricter than the original in one place: it splits on ; | && || outside quotes only and walks a
// -c argument as a command string, so `bash -c 'ls; tail x'`, `sh -c 'cat x | grep y'` and a
// third nesting level are caught (the original let all three through; tests/command-gate.test.mjs).
//
// Scott, Oct 12 2026: a Stop-Process filter on a command-line pattern killed 31 node services.
// The default rule set below is that rule: never kill a process by name or pattern.
//
// Config section "command-gate":
//   forbidden        list of rules. Each is one of:
//                      { "verbs": ["pkill"], "flags": ["-f"], "message": "..." }   verb (after wrapper/path
//                          stripping) matches, and, when flags are given, any flag token is present
//                      { "pattern": "<regex on the whole command>", "message": "..." }
//                    Default: the kill-by-name rules (pkill -f, killall, taskkill /IM|/FI,
//                    Stop-Process -Name, Get-Process | Stop-Process). An empty list turns verb rules off.
//   blockInlineCode  boolean (default false): also block `python -c`, `node -e`, `perl -e`, … outright,
//                    as the hardgate original does (its forbidden set was read-only verbs).
//   maxShellDepth    nested `sh -c` levels walked before failing closed (default 2)
//   commitSize       { "maxLines": 800, "tagPattern": "<regex>" } blocks `git commit -m` when the staged
//                    diff exceeds maxLines and the message has no tag. --amend, -F and editor commits
//                    are not parseable here and pass (as in the original). Absent = off.
//   overrideFile     a file whose modification time within overrideSeconds grants ONE bypass and is
//                    deleted (default ".claude/command-gate-override"; overrideSeconds default 60)
//   label, skillName the project's own words in the block message
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { block, loadFromStdin, resolveIn, rx } from "../lib/config.mjs";

const { input, section } = loadFromStdin("command-gate");
if (!section) process.exit(0);
const s = section;
const tool = String(input.tool_name || "");
if (tool !== "Bash" && tool !== "PowerShell") process.exit(0);
const cmd = String(input.tool_input?.command || "");
if (!cmd.trim()) process.exit(0);

const label = String(s.label || path.basename(s.cfg.dir));
const skill = s.skillName ? String(s.skillName) + ": " : "";
const cwd = String(input.cwd || process.cwd());

const DEFAULT_RULES = [
  { verbs: ["pkill", "pgrep"], flags: ["-f"], message: "pkill/pgrep -f matches by command-line pattern. List PIDs first and kill one PID you own." },
  { verbs: ["killall"], message: "killall kills by name. List PIDs first and kill one PID you own." },
  { verbs: ["taskkill", "taskkill.exe"], flags: ["/im", "/IM", "/fi", "/FI"], message: "taskkill /IM or /FI kills by name or filter. Use /PID <pid> on a PID you own." },
  { verbs: ["stop-process", "spps", "kill"], flags: ["-name", "-Name", "-processname", "-ProcessName"], message: "Stop-Process -Name kills by name. Use -Id <pid> on a PID you own." },
  { pattern: "Get-Process\\b[^|]*\\|[^|]*\\b(Stop-Process|kill|spps)\\b", message: "Get-Process | Stop-Process kills by filter. List PIDs first and kill one PID you own." },
  { pattern: "\\bWhere-Object\\b[^|]*\\|[^|]*\\b(Stop-Process|kill|spps)\\b", message: "A Where-Object filter piped into Stop-Process kills by pattern. List PIDs first and kill one PID you own." },
];
const rules = Array.isArray(s.forbidden) ? s.forbidden : DEFAULT_RULES;

// ---- one-shot human override --------------------------------------------------------
const overrideFile = resolveIn(s.cfg, s.overrideFile || ".claude/command-gate-override");
const overrideSeconds = Number(s.overrideSeconds ?? 60);
try {
  const age = (Date.now() - fs.statSync(overrideFile).mtimeMs) / 1000;
  fs.unlinkSync(overrideFile);
  if (age <= overrideSeconds) {
    process.stderr.write("command-gate (" + label + "): override marker accepted (" + age.toFixed(1) + "s old). One-time bypass.\n");
    process.exit(0);
  }
} catch {}

// ---- tokenizer (port of gate.py) -----------------------------------------------------
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh"]);
const INLINE = { python: ["-c"], python2: ["-c"], python3: ["-c"], perl: ["-e"], ruby: ["-e"], node: ["-e", "--eval"], deno: ["eval"], php: ["-r"] };
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nohup"]);
const maxDepth = Math.max(1, Number(s.maxShellDepth ?? 2));
const blockInline = s.blockInlineCode === true;

// shlex.split equivalent, POSIX rules; throws on an unterminated quote.
function shlex(str) {
  const out = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === "'") {
      const j = str.indexOf("'", i + 1);
      if (j < 0) throw new Error("unterminated quote");
      cur += str.slice(i + 1, j);
      has = true;
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let buf = "";
      for (; j < str.length && str[j] !== '"'; j++) {
        if (str[j] === "\\" && j + 1 < str.length && '"\\$`'.includes(str[j + 1])) buf += str[++j];
        else buf += str[j];
      }
      if (j >= str.length) throw new Error("unterminated quote");
      cur += buf;
      has = true;
      i = j + 1;
    } else if (c === "\\" && i + 1 < str.length) {
      cur += str[i + 1];
      has = true;
      i += 2;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}
// Split on &&, ||, ; and | OUTSIDE quotes. The original split before tokenizing, so a `;` or
// `|` inside a quoted `-c` string cut the quote in half and the parse error failed open
// (`bash -c 'ls; tail x'` passed). Quote-aware splitting closes that.
function splitPipeline(c) {
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
    if (ch === "\\" && i + 1 < c.length) { cur += ch + c[++i]; continue; }
    if ((ch === "&" && c[i + 1] === "&") || (ch === "|" && c[i + 1] === "|")) { parts.push(cur); cur = ""; i++; continue; }
    if (ch === ";" || ch === "|") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}
function stripWrappers(tokens) {
  let t = tokens.slice();
  for (;;) {
    if (!t.length) return t;
    const tok = t[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) { t = t.slice(1); continue; }
    if (WRAPPERS.has(tok.toLowerCase())) { t = t.slice(1); continue; }
    const base = path.basename(tok);
    if (base && base !== tok) { t = [base, ...t.slice(1)]; continue; }
    return t;
  }
}
// Returns a message when the token list hits a verb rule, else null.
function checkTokens(tokens, depth = 0) {
  tokens = stripWrappers(tokens);
  if (!tokens.length) return null;
  const verb = tokens[0];
  const lv = verb.toLowerCase().replace(/\.exe$/, "");
  if (SHELLS.has(lv) && tokens.length >= 2 && tokens[1] === "-c") {
    if (depth >= maxDepth) return "nested shell deeper than " + maxDepth + " levels; refusing to guess what runs inside";
    if (tokens.length < 3) return null;
    // The -c argument IS a command string: walk it as one. (The original tokenized it, joined
    // the tokens with spaces and re-split, which erased the inner quoting and let a third
    // nesting level through.) Any parse failure inside -c fails closed.
    return checkCommand(tokens[2], depth + 1);
  }
  if (blockInline && INLINE[lv]) {
    if (tokens.slice(1).some((t) => INLINE[lv].includes(t))) return "inline code (" + verb + " " + INLINE[lv][0] + ") is not allowed";
    return null;
  }
  for (const r of rules) {
    if (!Array.isArray(r.verbs)) continue;
    if (!r.verbs.some((v) => String(v).toLowerCase().replace(/\.exe$/, "") === lv)) continue;
    if (Array.isArray(r.flags) && r.flags.length) {
      const flags = new Set(r.flags.map((f) => String(f).toLowerCase()));
      if (!tokens.slice(1).some((t) => flags.has(t.toLowerCase()) || flags.has(t.toLowerCase().split("=")[0]))) continue;
    }
    return String(r.message || "forbidden command: " + verb);
  }
  return null;
}
// Walk one command string: split into sub-commands, tokenize each, check each.
// depth 0 is the command the model typed: a parse error there fails open, as the original
// (the shell would reject it anyway). depth > 0 is text inside a -c argument: fail closed.
function checkCommand(c, depth = 0) {
  for (const sub of splitPipeline(c)) {
    let tokens;
    try {
      tokens = shlex(sub);
    } catch {
      if (depth > 0) return "unparseable `-c` argument; refusing to guess what runs inside";
      continue;
    }
    const hit = checkTokens(tokens, depth);
    if (hit) return hit;
  }
  return null;
}
function forbiddenReason(c) {
  for (const r of rules) {
    if (r.pattern) {
      const re = rx(r.pattern, "i");
      if (re && re.test(c)) return String(r.message || "forbidden pattern: " + r.pattern);
    }
  }
  return checkCommand(c, 0);
}

const reason = forbiddenReason(cmd);
if (reason) {
  block(
    "BLOCKED by " + skill + "command-gate (" + label + "): " + reason + "\n  command: " + cmd.slice(0, 300) +
      "\nIf the human wants this exact command anyway, they touch " + overrideFile + " and you run it once within " + overrideSeconds + " seconds.",
  );
}

// ---- commit size (port of commit-size-gate.py) ----------------------------------------
if (s.commitSize && /\bgit\s+commit\b/.test(cmd)) {
  const maxLines = Number(s.commitSize.maxLines ?? 800);
  const tagRe = rx(s.commitSize.tagPattern || "\\[(MVP|LARGE-CHANGE|REFACTOR|INITIAL|MERGE|REVERT)\\]|\\[SCOPE-EXPANSION:\\s*[^\\]]+\\]", "");
  const amend = /(?<!\S)--amend(?!\S)/.test(cmd);
  const fileMsg = /(?<!\S)(?:-F|--file)(?:=|\s+)/.test(cmd);
  let msg = null;
  const q = /(?:-m|--message)[=\s]+(["'])([\s\S]+?)\1/.exec(cmd);
  const b = /(?:-m|--message)[=\s]+(\S+)/.exec(cmd);
  if (q) msg = q[2];
  else if (b) msg = b[1];
  if (!amend && !fileMsg && msg !== null && !(tagRe && tagRe.test(msg))) {
    let total = null;
    try {
      const out = execFileSync("git", ["diff", "--cached", "--numstat"], { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      total = 0;
      for (const line of out.split("\n")) {
        const parts = line.split("\t");
        if (parts.length < 2 || parts[0] === "-" || parts[1] === "-") continue;
        const a = Number(parts[0]), d = Number(parts[1]);
        if (Number.isFinite(a) && Number.isFinite(d)) total += a + d;
      }
    } catch {
      total = null; // not a repo or git failed: fail open, as the original
    }
    if (total !== null && total > maxLines) {
      block(
        "BLOCKED by " + skill + "command-gate (" + label + "): commit-size gate.\n" +
          "Staged diff is " + total + " lines (threshold " + maxLines + ") and the commit message carries no size tag.\n" +
          "Add a literal tag such as [LARGE-CHANGE], [REFACTOR], [INITIAL], [MERGE], [REVERT], [MVP] or [SCOPE-EXPANSION: <reason>], or split the commit.\n" +
          "Human override: touch " + overrideFile + " and commit once within " + overrideSeconds + " seconds.",
      );
    }
  }
}
process.exit(0);
