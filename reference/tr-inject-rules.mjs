// Injects Scott's never-forget TownReporter rules into every prompt (UserPromptSubmit / SessionStart).
import fs from "node:fs";
const file = "C:/Users/scott/.claude/skills/townreporter-release-path/RULES.md";
let text = "";
try { text = fs.readFileSync(file, "utf8"); } catch { process.exit(0); }
let event = "UserPromptSubmit";
try { const raw = fs.readFileSync(0, "utf8"); if (raw) event = JSON.parse(raw).hook_event_name || event; } catch {}
const out = {
  hookSpecificOutput: {
    hookEventName: event,
    additionalContext:
      "SCOTT'S NEVER-FORGET RULES (from skill townreporter-release-path; obey every line, no exceptions):\n" + text,
  },
};
process.stdout.write(JSON.stringify(out));
