#!/usr/bin/env python3
"""Tier-1 hook liveness: for every hook registered in a settings/hooks JSON file,
verify the config parses and the script the command points at exists on disk.

Never fires hooks (tier 2 is the skill's job, per-hook opt-in) — a smoke check
must not send notifications or mutate state.

Usage: hook_liveness.py SOURCE.json [SOURCE2.json ...]   (JSON output, exit 1 on FAIL)
"""
import argparse
import json
import re
import sys
from pathlib import Path

# Wrappers whose first path-looking argument is the real script.
_WRAPPERS = {"powershell", "powershell.exe", "pwsh", "python", "python3",
             "python.exe", "py", "cmd", "cmd.exe", "bash", "sh", "node"}
_PATH_RE = re.compile(r'"([^"]+)"|(\S+)')


def _tokens(command):
    return [a or b for a, b in _PATH_RE.findall(command)]


def _looks_like_path(tok):
    return ("/" in tok or "\\" in tok) and not tok.startswith("-")


def extract_script_path(command):
    """Best-effort: the script a hook command actually runs, or None."""
    toks = _tokens(command)
    if not toks:
        return None
    first = Path(toks[0]).name.lower()
    if first not in _WRAPPERS and _looks_like_path(toks[0]):
        return toks[0]
    if first in _WRAPPERS:
        for tok in toks[1:]:
            if _looks_like_path(tok):
                return tok
    return None


def _iter_hook_commands(data):
    """Yield (event, command) from either settings.json ({"hooks": {...}})
    or a plugin hooks.json (events at top level)."""
    events = data.get("hooks", data)
    if not isinstance(events, dict):
        return
    for event, entries in events.items():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            for hook in entry.get("hooks", []):
                if hook.get("type") == "command" and hook.get("command"):
                    yield event, hook["command"]


def check_hook_source(source):
    """One result row per registered hook command in the source file."""
    source = Path(source)
    if not source.exists():
        return [{"source": str(source), "event": "-", "status": "FAIL",
                 "detail": "hook source file missing"}]
    try:
        data = json.loads(source.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return [{"source": str(source), "event": "-", "status": "FAIL",
                 "detail": f"unparseable JSON: {e}"}]

    # ${CLAUDE_PLUGIN_ROOT} in a plugin's hooks.json = the plugin root; a
    # plugin hooks file lives at <plugin>/hooks/hooks.json.
    plugin_root = str(source.parent.parent)

    results = []
    for event, command in _iter_hook_commands(data):
        script = extract_script_path(command)
        if script and "${CLAUDE_PLUGIN_ROOT}" in script:
            script = script.replace("${CLAUDE_PLUGIN_ROOT}", plugin_root)
        row = {"source": source.name, "event": event, "command": command}
        if script is None:
            row.update(status="PARTIAL",
                       detail="no script path recognized in command; "
                              "existence not checkable")
        elif Path(script).exists():
            row.update(status="PASS", detail=f"script present: {script}")
        else:
            row.update(status="FAIL", detail=f"script MISSING: {script}")
        results.append(row)
    return results


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("sources", nargs="+")
    args = ap.parse_args(argv)
    results = []
    for src in args.sources:
        results.extend(check_hook_source(src))
    print(json.dumps(results, indent=2))
    return 1 if any(r["status"] == "FAIL" for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
