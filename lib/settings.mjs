// Read, merge and write ~/.claude/settings.json for the kit's hook entries.
//
// Used by install.mjs and uninstall.mjs. Nothing here touches the real settings
// file on its own: callers pass the path (tests pass temp dirs).
import fs from "node:fs";
import path from "node:path";
import { isKitCommand } from "./hook-entries.mjs";

// Read settings.json. A missing file is an empty object, not an error. A file
// that is not valid JSON is an error the caller must surface, never overwrite.
export function readSettings(file) {
  if (!fs.existsSync(file)) return { exists: false, settings: {} };
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return { exists: true, settings: {} };
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    throw new Error("settings.json is not valid JSON (" + file + "): " + err.message);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("settings.json is not a JSON object (" + file + ")");
  }
  return { exists: true, settings };
}

// A timestamp like 20261014-131205, for the backup name.
export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) + "-" +
    p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds())
  );
}

// Copy settings.json to a .bak-hookkit-<stamp> file beside it. Returns the
// backup path, or null when there is no settings file to back up.
//
// The name is unique: install and uninstall stamp to the second, so two runs
// inside the same second would otherwise collide. If the name is taken, a
// -2, -3 ... suffix is added, so no run ever overwrites an earlier backup.
export function backupSettings(file, date = new Date()) {
  if (!fs.existsSync(file)) return null;
  const base = file + ".bak-hookkit-" + stamp(date);
  let bak = base;
  for (let n = 2; fs.existsSync(bak); n++) bak = base + "-" + n;
  fs.copyFileSync(file, bak);
  return bak;
}

// Count the command strings in a settings.hooks block that the kit owns.
function countKitCommands(hooks) {
  let n = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const h of group.hooks) if (h && isKitCommand(h.command)) n++;
    }
  }
  return n;
}

// Merge `entries` (the shape from buildHookEntries) into `settings`, in place.
//
// Rules, so a re-install never duplicates and never disturbs another hook:
//  - Drop any group/entry command the kit owns (installed or old-local path).
//  - Drop groups left empty by that removal.
//  - Append the kit's own groups, one per (event, matcher) pair, each new entry
//    flagged so a stale copy of the same event does not linger.
// Returns { added, removed } counts.
export function mergeHookEntries(settings, entries) {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  const hooks = settings.hooks;

  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const survivors = group.hooks.filter((h) => !(h && isKitCommand(h.command)));
      removed += group.hooks.length - survivors.length;
      if (survivors.length > 0) kept.push({ ...group, hooks: survivors });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }

  let added = 0;
  for (const [event, groups] of Object.entries(entries)) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    for (const group of groups) {
      // Reuse a group with the same matcher, else append a new one.
      const existing = hooks[event].find((g) => (g.matcher || "") === (group.matcher || ""));
      if (existing) existing.hooks.push(...group.hooks);
      else hooks[event].push(group);
      added += group.hooks.length;
    }
  }

  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return { added, removed };
}

// Remove every command the kit owns from settings.hooks, in place.
// Emptied groups and emptied events are dropped. Everything else stays.
// Returns { removed }.
export function removeHookEntries(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return { removed: 0 };
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const survivors = group.hooks.filter((h) => !(h && isKitCommand(h.command)));
      removed += group.hooks.length - survivors.length;
      if (survivors.length > 0) kept.push({ ...group, hooks: survivors });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return { removed };
}

// Write settings.json with two-space indent and a trailing newline.
export function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

export { countKitCommands };
