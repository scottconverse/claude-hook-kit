// Inject a project's rules file into every prompt (UserPromptSubmit / SessionStart).
// Port of reference/tr-inject-rules.mjs: same JSON output shape, rules file from config.
// Config section "inject-rules": { rulesFile, heading }
//   rulesFile: path to the rules text (absolute, or relative to the project folder that holds .claude/)
//   heading:   the line put in front of it
import fs from "node:fs";
import { loadFromStdin, resolveIn } from "../lib/config.mjs";

const { input, section } = loadFromStdin("inject-rules");
if (!section) process.exit(0); // no config, kit off, or no inject-rules section

const file = resolveIn(section.cfg, section.rulesFile);
if (!file) process.exit(0);
let text = "";
try {
  text = fs.readFileSync(file, "utf8");
} catch {
  process.exit(0); // missing rules file: nothing to inject, same as the reference
}

let event = "UserPromptSubmit";
try {
  if (input.hook_event_name) event = input.hook_event_name;
} catch {}

const heading = String(section.heading || "PROJECT RULES (obey every line, no exceptions):");
const out = {
  hookSpecificOutput: {
    hookEventName: event,
    additionalContext: heading + "\n" + text,
  },
};
process.stdout.write(JSON.stringify(out));
