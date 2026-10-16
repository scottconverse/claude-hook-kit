// One source for the hook entries the kit registers in settings.json.
//
// install.mjs and the generator for install/settings-snippet.json both build from
// this list, so the installed settings and the committed snippet cannot drift.
//
// Placeholder: every command path is written with the token "<HOOK_KIT_DIR>".
// install.mjs replaces it with the real installed folder; the generator replaces
// it with the literal "<HOOK_KIT_DIR>" that ships in the repo snippet.

export const HOOK_KIT_DIR_TOKEN = "<HOOK_KIT_DIR>";

// The nine hooks as Claude Code settings entries: event, matcher, script, timeout,
// and (for the one sleeper) the asyncRewake flag. This is the same shape that was
// in install/settings-snippet.json before the installer existed.
const FILES = [
  { script: "inject-rules.mjs", events: ["SessionStart", "UserPromptSubmit"], timeout: 10 },
  { script: "deploy-gate.mjs", events: ["PreToolUse"], matcher: "Bash|PowerShell", timeout: 30 },
  { script: "walk-brief-guard.mjs", events: ["PreToolUse"], matcher: "Write|Edit|Bash|PowerShell", timeout: 10 },
  { script: "read-ledger-gate.mjs", events: ["PreToolUse"], matcher: "Write|Edit|Bash|PowerShell", timeout: 15 },
  { script: "db-write-guard.mjs", events: ["PreToolUse"], matcher: "Bash|PowerShell", timeout: 10 },
  { script: "no-idle.mjs", events: ["Stop"], timeout: 30 },
  { script: "double-check.mjs", events: ["Stop"], timeout: 10 },
  { script: "measure-gate.mjs", events: ["Stop"], timeout: 30 },
  { script: "wake.mjs", events: ["Stop"], timeout: 1800, asyncRewake: true },
];

// Build the entries with command paths pointing at `kitDir` (or the placeholder).
// Always forward slashes and quoted, so the same string works on Windows, macOS
// and Linux. Returns the shape written into settings.json under "hooks".
export function buildHookEntries(kitDir = HOOK_KIT_DIR_TOKEN) {
  const base = String(kitDir).split("\\").join("/").replace(/\/+$/, "");
  const cmd = (script) => 'node "' + base + "/hooks/" + script + '"';

  // Group by event, preserving the order above. The PreToolUse event ends up with
  // two matcher groups (Bash|PowerShell, then Write|Edit|Bash|PowerShell); the
  // others each get one unmatcher group.
  const order = [];
  const byEvent = new Map();
  for (const h of FILES) {
    for (const event of h.events) {
      if (!byEvent.has(event)) {
        byEvent.set(event, []);
        order.push(event);
      }
      let group = byEvent.get(event).find((g) => (g.matcher || "") === (h.matcher || ""));
      if (!group) {
        group = h.matcher ? { matcher: h.matcher, hooks: [] } : { hooks: [] };
        byEvent.get(event).push(group);
      }
      const entry = { type: "command", command: cmd(h.script), timeout: h.timeout };
      if (h.asyncRewake) entry.asyncRewake = true;
      group.hooks.push(entry);
    }
  }

  const hooks = {};
  for (const event of order) hooks[event] = byEvent.get(event);
  return hooks;
}

// The token as it appears at the start of an installed command path.
export const HOOK_KIT_TOKEN_RE = /<HOOK_KIT_DIR>\/hooks\//;

// Does a command string point at a kit hook? True for the installed copy
// ("/hook-kit/hooks/") and the old local clone ("claude-hook-kit/hooks/"), so a
// re-install or an uninstall can replace exactly the entries this kit owns and
// leave every other hook in the file alone.
export function isKitCommand(command) {
  if (typeof command !== "string") return false;
  const c = command.split("\\").join("/");
  return (
    HOOK_KIT_TOKEN_RE.test(c) ||
    /\/hook-kit\/hooks\//.test(c) ||
    /claude-hook-kit\/hooks\//.test(c)
  );
}
