// PreToolUse hook (Write|Edit|Bash|PowerShell): a TownReporter WALK brief must tell the walker to press Publish
// and must end with a PUBLISH-WALK line. Blocks a brief that bans publishing. Exit 2 = blocked.
import fs from "node:fs";

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
const ti = input.tool_input || {};
const tool = String(input.tool_name || "");
const target = String(ti.file_path || ti.path || "");
const text = String(ti.content ?? ti.new_string ?? ti.command ?? "");

const isWalkBriefPath = (s) => /briefs[\\/]+walk-[^\\/\s"']+\.md/i.test(s);
let isWalkBrief = false;
if (tool === "Write" || tool === "Edit") isWalkBrief = isWalkBriefPath(target);
else isWalkBrief = isWalkBriefPath(text); // Bash / PowerShell heredoc writes
if (!isWalkBrief) process.exit(0);

const problems = [];
if (/do not (press )?publish|never (press )?publish|no publishing|do not publish, delete|don't (press )?publish/i.test(text)) {
  problems.push('it bans publishing ("do not publish"). The Test server is a disposable copy: publishing there is the point.');
}
// Only a full file body (Write, or a shell heredoc) can be checked for the closing line.
if ((tool === "Write" || /<</.test(text)) && !/PUBLISH-WALK/.test(text)) {
  problems.push('it has no "PUBLISH-WALK: PASS or FAIL" closing line and no publish path.');
}
// Scott, Oct 11 ("1"): a walk is written from the editor's jobs, not from the code change. A full brief must
// name every door: each place on the desk where each job it tests can be done (Kill from the Queue button, the
// X key, the bulk strip, Today and the Story page, not just one of them).
if ((tool === "Write" || /<</.test(text)) && !/^EVERY DOOR:/m.test(text)) {
  problems.push('it has no "EVERY DOOR:" section listing every place on the desk where each tested job can be done (for example Kill: Queue row button, X key, bulk strip, Today, Story page).');
}
if (problems.length) {
  console.error(
    "BLOCKED by Scott's release path (skill townreporter-release-path): this walk brief is not allowed:\n  - " +
      problems.join("\n  - ") +
      "\nEvery walk brief must have the walker press Publish for real on the Test server (draft -> Publish -> bar words -> Published list -> public page -> gone from Drafts) and end with the exact line PUBLISH-WALK: PASS or PUBLISH-WALK: FAIL.",
  );
  process.exit(2);
}
process.exit(0);
