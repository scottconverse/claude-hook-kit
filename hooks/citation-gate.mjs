// Stop hook: an audit, review or handoff document may not claim what the session never read.
// Port of ~/.claude/hooks/audit-citation-gate.ps1 (Scott, Aug 27 2026; reference/ holds the original).
// Scott, Oct 17 2026: this is the "7 of 28" failure, solved in August and never registered.
//
// If this session wrote a governed document (a .md whose name matches docPattern), the turn may
// not end until that document carries a "## Verification ledger" and every
//     VERIFIED: <claim> | <path>:<line>
// row names a real file, a real line, and a file some tool call in this session's transcript
// actually read. Anything else must be written as
//     UNVERIFIED: <claim> - not checked
// An UNVERIFIED line is always accepted. Silence is not. Exit 2 = blocked.
//
// Fail-open only for hook infrastructure faults (no stdin, no transcript). Never for a failed
// citation check.
//
// Config section "citation-gate":
//   docPattern      regex string on the document's file name (default: audit|verdict|review|handoff|evidence|assessment|findings)
//   excludePattern  regex string on the document's path; a match is never governed (default: a /memory/ folder)
//   ledgerHeading   text of the required heading (default "Verification ledger")
//   label, skillName   the project's own words in the block message
import fs from "node:fs";
import path from "node:path";
import { block, loadFromStdin, rx } from "../lib/config.mjs";

const { input, section } = loadFromStdin("citation-gate");
if (!section) process.exit(0);

const s = section;
const docRx = rx(s.docPattern || "audit|verdict|review|handoff|evidence|assessment|findings", "i");
const exclRx = rx(s.excludePattern || "(^|[\\\\/])memory[\\\\/]", "i");
const heading = String(s.ledgerHeading || "Verification ledger");
const label = String(s.label || path.basename(s.cfg.dir));
const skill = s.skillName ? String(s.skillName) + ": " : "";
if (!docRx) process.exit(0);

const transcript = String(input.transcript_path || "");
const cwd = String(input.cwd || process.cwd());
let lines;
try {
  lines = fs.readFileSync(transcript, "utf8").split("\n");
} catch {
  process.exit(0); // no transcript: infrastructure fault, allow
}

// Text of every tool_use input in the session, and every file Write/Edit touched.
// A path counts as READ only if it appears inside a tool invocation, not in prose.
const norm = (p) => String(p).split("\\").join("/").toLowerCase();
let blob = "";
const written = new Set();
for (const line of lines) {
  if (!line.includes('"tool_use"')) continue;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }
  const content = rec?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const b of content) {
    if (b?.type !== "tool_use") continue;
    try {
      blob += JSON.stringify(b.input ?? {}) + "\n";
    } catch {}
    if (["Write", "Edit", "NotebookEdit"].includes(b.name)) {
      const fp = b.input?.file_path;
      if (fp) written.add(String(fp));
    }
  }
}
// JSON doubles every backslash; collapse the pair first, then any single one, as the original did.
blob = blob.replace(/\\\\/g, "/").replace(/\\/g, "/").toLowerCase();

const governed = [];
for (const f of written) {
  const name = path.basename(f);
  if (!/\.md$/i.test(name)) continue;
  if (exclRx && exclRx.test(f)) continue;
  if (!docRx.test(name)) continue;
  if (fs.existsSync(f)) governed.push(f);
}
if (!governed.length) process.exit(0);

const resolveCited = (p) => {
  const c = p.trim().replace(/^[`"']+|[`"']+$/g, "");
  for (const cand of [c, path.resolve(cwd, c)]) {
    try {
      if (fs.statSync(cand).isFile()) return path.resolve(cand);
    } catch {}
  }
  return null;
};
const wasRead = (resolved) => {
  const n = norm(resolved);
  if (blob.includes(n)) return true;
  // Tolerate absolute-vs-relative citation styles: the last two path segments together,
  // which a bare file name cannot fake.
  const seg = n.split("/");
  return seg.length >= 2 && blob.includes(seg[seg.length - 2] + "/" + seg[seg.length - 1]);
};
const lineCount = (file) => {
  const t = fs.readFileSync(file, "utf8");
  if (!t.length) return 0;
  const parts = t.split(/\r?\n/);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
};

const problems = [];
const headingRx = new RegExp("^\\s*##+\\s*(\\d+[.)]\\s*)?" + heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "im");
for (const doc of governed) {
  const docName = path.basename(doc);
  let text = fs.readFileSync(doc, "utf8");
  // Fenced code is documentation (a format example), not a claim.
  text = text.replace(/```[\s\S]*?```/g, "");
  const hasLedger = headingRx.test(text);
  const verified = [...text.matchAll(/^\s*VERIFIED:\s*(.+?)\s*\|\s*(.+?)\s*$/gim)];
  const unverified = [...text.matchAll(/^\s*UNVERIFIED:\s*(.+?)\s*$/gim)];
  const hasVerdict = /\b(PASS|FAIL|APPROVE[D]?|I recommend|My recommendation|VERDICT)\b/im.test(text);
  if (!hasLedger) {
    problems.push(docName + " : missing a '## " + heading + "' section. Every audit/review/handoff document must carry one.");
    continue;
  }
  if (hasVerdict && !verified.length && !unverified.length) {
    problems.push(docName + " : states a verdict or recommendation but the ledger has no VERIFIED: or UNVERIFIED: entries.");
    continue;
  }
  for (const m of verified) {
    const claim = m[1];
    const cite = m[2].trim();
    const cm = /^(.*?):(\d+)(-\d+)?$/.exec(cite);
    if (!cm) {
      problems.push(docName + " : VERIFIED entry has no file:line citation -> '" + claim + "' | '" + cite + "'");
      continue;
    }
    const resolved = resolveCited(cm[1]);
    if (!resolved) {
      problems.push(docName + " : cited file does not exist -> '" + cite + "' (claim: " + claim + ")");
      continue;
    }
    const n = Number(cm[2]);
    const count = lineCount(resolved);
    if (n < 1 || n > count) {
      problems.push(docName + " : cited line " + n + " is out of range (file has " + count + " lines) -> '" + cite + "'");
      continue;
    }
    if (!wasRead(resolved)) {
      problems.push(docName + " : you cited '" + cite + "' but this session's transcript contains no tool call that read that file. Read it, or downgrade the claim to UNVERIFIED.");
    }
  }
}

if (!problems.length) process.exit(0);
block(
  "BLOCKED by " + skill + "citation-gate (" + label + "). You may not end this turn yet.\n\n  - " +
    problems.join("\n  - ") +
    "\n\nFix by doing ONE of these for each item, then finish the turn:\n" +
    "  1. Actually read the source (Read/Bash), then cite it as: VERIFIED: <claim> | <path>:<line>\n" +
    "  2. Downgrade the sentence to: UNVERIFIED: <claim> - not checked\n\n" +
    "An UNVERIFIED line is always accepted. Silence is not.",
);
