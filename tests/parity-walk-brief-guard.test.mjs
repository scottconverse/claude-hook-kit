import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { HOOKS, makeProject, mkTemp, portReference, rimraf, runHook } from "./helpers.mjs";

const KIT = path.join(HOOKS, "walk-brief-guard.mjs");

const HEADING = "Brief: Test the Kill button.\n";
const GOOD = HEADING + "EVERY DOOR:\n- Kill: Queue row button, X key, bulk strip, Today, Story page\n\nPUBLISH-WALK: PASS or FAIL\n";

function fixture() {
  const dir = mkTemp("hook-kit-walk-");
  // The reference has only a TownReporter-shaped path pattern and no temp paths to swap,
  // so its copy is used as-is.
  const ref = portReference("tr-guard-walk-briefs.mjs", [], dir);
  const briefsDir = path.join(dir, "briefs");
  const proj = makeProject({
    "walk-brief-guard": {
      pathPattern: "briefs[\\\\/]+walk-[^\\\\/\\s\"']+\\.md",
      heredocPattern: "<<",
      bannedPatterns: [
        {
          pattern: "do not (press )?publish|never (press )?publish|no publishing|do not publish, delete|don't (press )?publish",
          message: 'it bans publishing ("do not publish"). The Test server is a disposable copy: publishing there is the point.',
        },
      ],
      requiredLines: [
        { pattern: "PUBLISH-WALK", onlyFullBody: true, message: 'it has no "PUBLISH-WALK: PASS or FAIL" closing line and no publish path.' },
      ],
      requiredSections: [
        { pattern: "^EVERY DOOR:", onlyFullBody: true, message: 'it has no "EVERY DOOR:" section listing every place on the desk where each tested job can be done (for example Kill: Queue row button, X key, bulk strip, Today, Story page).' },
      ],
      skillName: "Scott's release path (skill townreporter-release-path)",
      footer: "Every walk brief must have the walker press Publish for real on the Test server (draft -> Publish -> bar words -> Published list -> public page -> gone from Drafts) and end with the exact line PUBLISH-WALK: PASS or PUBLISH-WALK: FAIL.",
    },
  });
  return { dir, briefsDir, ref, proj };
}

// Both hooks must see the same path shape: the reference matches briefs/walk-*.md anywhere
// in the string, so a plain project-relative path works for both.
const CASES = [
  {
    name: "Write of a complete walk brief is allowed",
    stdin: { tool_name: "Write", tool_input: { file_path: "briefs/walk-kill.md", content: GOOD } },
    blocked: false,
  },
  {
    name: "Write with no EVERY DOOR line is blocked",
    stdin: { tool_name: "Write", tool_input: { file_path: "briefs/walk-kill.md", content: HEADING + "PUBLISH-WALK: PASS or FAIL\n" } },
    blocked: true,
    words: ["BLOCKED", "EVERY DOOR"],
  },
  {
    name: "Write with no PUBLISH-WALK line is blocked",
    stdin: { tool_name: "Write", tool_input: { file_path: "briefs/walk-kill.md", content: HEADING + "EVERY DOOR:\n- Kill: Queue row button\n" } },
    blocked: true,
    words: ["BLOCKED", "PUBLISH-WALK"],
  },
  {
    name: "a brief that bans publishing is blocked",
    stdin: { tool_name: "Write", tool_input: { file_path: "briefs/walk-kill.md", content: "EVERY DOOR:\n- Kill\nPUBLISH-WALK: PASS or FAIL\nDo not publish until Scott says so.\n" } },
    blocked: true,
    words: ["BLOCKED", "bans publishing"],
  },
  {
    name: "an Edit of a walk brief body is blocked (no full body to check)",
    stdin: { tool_name: "Edit", tool_input: { file_path: "briefs/walk-kill.md", old_string: "Kill", new_string: "Kill: do not publish this" } },
    blocked: true,
    words: ["BLOCKED", "bans publishing"],
  },
  {
    name: "a shell heredoc write of a good brief is allowed",
    stdin: { tool_name: "Bash", tool_input: { command: "cat > briefs/walk-kill.md <<'EOF'\n" + GOOD + "EOF\n" } },
    blocked: false,
  },
  {
    name: "a shell heredoc write with no EVERY DOOR is blocked",
    stdin: { tool_name: "Bash", tool_input: { command: "cat > briefs/walk-kill.md <<'EOF'\n" + HEADING + "PUBLISH-WALK: PASS\nEOF\n" } },
    blocked: true,
    words: ["BLOCKED", "EVERY DOOR"],
  },
  {
    name: "a file that is not a walk brief is ignored",
    stdin: { tool_name: "Write", tool_input: { file_path: "briefs/bug-report.md", content: "Do not publish anything." } },
    blocked: false,
  },
  {
    name: "a path that is not under briefs is ignored",
    stdin: { tool_name: "Write", tool_input: { file_path: "walk-kill.md", content: "Do not publish." } },
    blocked: false,
  },
];

for (const c of CASES) {
  test("walk-brief-guard parity: " + c.name, async () => {
    const f = fixture();
    try {
      const stdin = JSON.stringify({ ...c.stdin, cwd: f.proj.cwd });
      const [got, want] = await Promise.all([runHook(KIT, stdin), runHook(f.ref, stdin)]);
      assert.equal(got.code, want.code, "exit code matches the reference");
      assert.equal(got.code, c.blocked ? 2 : 0);
      assert.equal(got.stderr.replace(/\s+/g, " ").trim(), want.stderr.replace(/\s+/g, " ").trim(), "stderr matches the reference");
      if (c.words) for (const w of c.words) assert.ok(got.stderr.includes(w), "stderr mentions " + w);
    } finally {
      rimraf(f.dir);
      rimraf(f.proj.root);
    }
  });
}
