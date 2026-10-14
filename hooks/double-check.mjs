// Stop hook: make Claude check its work a second time before a turn ends.
// Scott, Oct 14 2026: "Check everything twice, read everything, do not skim, check the code."
//
// The first time a turn tries to end, this exits 2 with a checklist, so Claude
// gets one more pass. Claude Code then sends the next Stop with
// stop_hook_active = true; this hook lets that one through, so it can never loop.
//
// Config section "double-check":
//   quote          the owner's own words, shown first (optional)
//   checklist      list of lines; default is the list below
//   minToolCalls   only ask when the turn made at least this many tool calls
//                  (default 0 = ask after every turn, even a plain answer)
//   label          project name used in the message (optional)
import fs from "node:fs";
import { block, loadFromStdin } from "../lib/config.mjs";

const { input, section } = loadFromStdin("double-check");
if (!section) process.exit(0);
// The second stop of the same turn: the check already ran. Let it end.
if (input.stop_hook_active === true) process.exit(0);

const DEFAULT_CHECKLIST = [
  "Re-read every file you wrote or changed in this turn, end to end. Not a grep, not your memory of it.",
  "Read the code every claim depends on. A worker's report, a commit message or a test name is not the code.",
  "Read every diff and every tool output in full. Do not skim, do not stop at the first line that looks right.",
  "For each fact in your answer, name the tool output that proves it. Anything you did not check: check it now, or call it unverified.",
  "Re-run the narrowest check for anything that changed (test, typecheck, the screen itself).",
  "Fix what is wrong, then end the turn. Start your reply with \"Checked twice:\" and say what you re-checked.",
];

const minTools = Number(section.minToolCalls ?? 0);
if (minTools > 0) {
  // Count tool calls since the last real user message in the transcript.
  // If the transcript cannot be read, ask anyway: a skipped check is the failure this hook exists for.
  let count = minTools;
  try {
    const lines = fs.readFileSync(String(input.transcript_path || ""), "utf8").trim().split("\n");
    count = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      let m;
      try {
        m = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const content = m?.message?.content;
      if (m?.type === "user") {
        const isToolResult = Array.isArray(content) && content.some((c) => c?.type === "tool_result");
        if (!isToolResult) break;
      }
      if (m?.type === "assistant" && Array.isArray(content)) count += content.filter((c) => c?.type === "tool_use").length;
    }
  } catch {}
  if (count < minTools) process.exit(0);
}

const list = Array.isArray(section.checklist) && section.checklist.length ? section.checklist : DEFAULT_CHECKLIST;
const head = `DOUBLE-CHECK${section.label ? ` (${section.label})` : ""}, hook double-check.mjs. Before this turn ends, check everything a second time.`;
const quote = section.quote ? `\n${section.quote}` : "";
block(`${head}${quote}\n${list.map((l, i) => `${i + 1}. ${l}`).join("\n")}`);
