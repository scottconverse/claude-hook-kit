// PostToolUse + Stop hook: you edited runnable code this session and never ran anything.
// Port of scottconverse/dev-rigor-stack plugin/hooks/dev-rigor-ground.js (reference/).
//
// PostToolUse (Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell): append one line to a
// per-session ledger: "E<ext>" for an edit to a runnable file, "X" for any other tool call
// that reached this hook (the matcher decides what counts as execution, not a list here).
// Stop: if the ledger has edits and zero executions, block ONCE per session (exit 2) and
// record "B". A continuation stop (stop_hook_active) is let through. No session_id = no
// trustworthy ledger = do nothing.
//
// Deliberate floor: it catches the provable-theater case (nothing ever ran). It does not
// demand a re-run after every trailing edit; measure-gate covers "is the receipt fresh".
//
// Config section "ran-before-done":
//   stateDir          folder for the ledgers (default ".claude/state", relative to the project)
//   runnablePattern   regex string on the edited path (default: source and view file extensions)
//   label             project name in the message
import fs from "node:fs";
import path from "node:path";
import { block, loadFromStdin, resolveIn, rx } from "../lib/config.mjs";

const { input, section } = loadFromStdin("ran-before-done");
if (!section) process.exit(0);
const s = section;
const sid = typeof input.session_id === "string" && input.session_id.trim() ? input.session_id.replace(/[^A-Za-z0-9_-]/g, "") : "";
if (!sid) process.exit(0);

const stateDir = resolveIn(s.cfg, s.stateDir || ".claude/state");
const ledger = path.join(stateDir, "ran-" + sid + ".log");
const runnable = rx(s.runnablePattern || "\\.(html?|svg|m?[jt]sx?|cjs|py|ps1|sh|bash|css|scss|vue|svelte|rs|go|c|cc|cpp|h|hpp|java|rb|php|swift|kt|cs)$", "i");
const label = String(s.label || path.basename(s.cfg.dir));
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

const append = (line) => {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(ledger, line + "\n");
  } catch {}
};
const read = () => {
  let lines = [];
  try {
    lines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
  } catch {}
  return {
    edits: [...new Set(lines.filter((l) => l[0] === "E").map((l) => l.slice(1)))],
    execs: lines.filter((l) => l === "X").length,
    blocked: lines.includes("B"),
  };
};

const event = String(input.hook_event_name || "");
if (event === "PostToolUse") {
  const tool = String(input.tool_name || "");
  if (EDIT_TOOLS.test(tool)) {
    const file = String(input.tool_input?.file_path || input.tool_input?.path || "");
    if (runnable && runnable.test(file)) append("E" + (file.match(/\.[^.]+$/) || ["?"])[0]);
  } else if (tool) {
    append("X");
  }
  process.exit(0);
}
if (event === "Stop") {
  if (input.stop_hook_active === true) process.exit(0);
  const l = read();
  if (l.blocked || !l.edits.length || l.execs > 0) process.exit(0);
  append("B");
  block(
    "RAN-BEFORE-DONE (" + label + "): you edited runnable file(s) (" + l.edits.join(", ") + ") this session but never executed or rendered ANYTHING: no test, script or preview ran. " +
      "Run the narrowest real check that exercises your change and read the result, or state in one line why it cannot be run here, then finish.",
  );
}
process.exit(0);
