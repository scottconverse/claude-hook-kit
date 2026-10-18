// Per-project config for the hook kit.
// Finds the nearest .claude/hook-kit.json walking up from the hook event's cwd.
// No config file anywhere up the tree = every hook does nothing (exit 0).
import fs from "node:fs";
import path from "node:path";

export const CONFIG_NAME = "hook-kit.json";

// Read the hook's JSON stdin. Returns {} when stdin is empty or not JSON.
// Never throws: a hook with no stdin is a hook that does nothing, not a crash.
export function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw || !raw.trim()) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// The directory the hook should treat as the project. Claude Code sends cwd on
// the events we use; process.cwd() is the fallback when it is absent.
// UNVERIFIED: that every event's stdin actually carries cwd. Hence the fallback.
export function cwdFrom(input) {
  const c = input && typeof input.cwd === "string" ? input.cwd : "";
  return c || process.cwd();
}

// Where the config walk starts. For a tool that names the file it will write (Write, Edit,
// MultiEdit, NotebookEdit) that is the file's own folder, so a write into project B from a
// session sitting in project A is judged by B's config (Oct 17, 2026: it was judged by A's,
// which let a subagent bypass B's read-ledger-gate). For everything else it is the event cwd.
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export function startDirFrom(input) {
  const cwd = cwdFrom(input);
  const tool = input && typeof input.tool_name === "string" ? input.tool_name : "";
  const ti = input && input.tool_input && typeof input.tool_input === "object" ? input.tool_input : null;
  const fp = ti ? [ti.file_path, ti.notebook_path, ti.path].find((v) => typeof v === "string" && v.trim()) : "";
  if (FILE_TOOLS.has(tool) && fp) return path.dirname(path.resolve(cwd, fp));
  return cwd;
}

// Walk up from startDir to the filesystem root, nearest ancestor wins.
// Returns { dir, file, config } or null.
export function findConfig(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    const file = path.join(dir, ".claude", CONFIG_NAME);
    if (fs.existsSync(file)) {
      let config = null;
      try {
        config = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        config = null; // unreadable config: treat as absent, hook does nothing
      }
      if (config && typeof config === "object") return { dir, file, config };
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Resolve a path found in config. Relative paths are relative to cfg.dir, the
// project folder that holds .claude/, so a config can use short project-relative paths.
export function resolveIn(cfg, p) {
  if (!p) return "";
  return path.isAbsolute(p) ? p : path.resolve(cfg.dir, p);
}

// The section for one hook, or null when the section is missing (hook off).
export function sectionFor(cfg, name) {
  if (!cfg || !cfg.config) return null;
  if (cfg.config.enabled === false) return null;
  const s = cfg.config[name];
  if (!s || typeof s !== "object") return null;
  if (s.enabled === false) return null;
  return s;
}

// Stop and SubagentStop hooks are for a person's session. A background run (claude -p from a
// script: workers, test runs) has CLAUDE_CODE_SESSION_ATTENDED=0, measured Oct 18 2026 (an
// attended desktop session has 1). Their Stop hooks blocked a claude -p run 9 times until
// Claude Code ended it with no answer. Unset = attended, so the hook still runs.
// Tool gates (PreToolUse, PostToolUse) still run in background runs.
const STOP_EVENTS = new Set(["Stop", "SubagentStop"]);
export function unattendedStop(input) {
  const ev = input && typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  return STOP_EVENTS.has(ev) && process.env.CLAUDE_CODE_SESSION_ATTENDED === "0";
}

// One call that does the whole lookup: read stdin, find the config, return
// { input, cfg, section }. section is null when the kit or this hook is off.
export function load(hookName, input) {
  const cfg = findConfig(startDirFrom(input));
  const section = unattendedStop(input) ? null : sectionFor(cfg, hookName);
  // Every hook resolves its paths with resolveIn(section.cfg, ...). Carry the
  // config's location on the section (not enumerable, so it never shows up in
  // a JSON dump of the section) so relative paths resolve against the project
  // folder (cfg.dir) instead of crashing on an undefined cfg.
  if (section) Object.defineProperty(section, "cfg", { value: cfg, enumerable: false });
  return { input, cfg, section };
}

// Convenience: load from stdin in one line.
export function loadFromStdin(hookName) {
  return load(hookName, readStdin());
}

// Compile a regex string from config. Bad pattern = hook does nothing.
export function rx(pattern, flags) {
  try {
    return pattern ? new RegExp(pattern, flags) : null;
  } catch {
    return null;
  }
}

// An "exit 2 with a message on stderr" block, or nothing at all.
export function block(message) {
  process.stderr.write(message.replace(/\s*$/, "") + "\n");
  process.exit(2);
}
