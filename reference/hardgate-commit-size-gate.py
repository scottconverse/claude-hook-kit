#!/usr/bin/env python3
"""
Commit-Size Acknowledgment Gate — Hard Rule 11

Blocks `git commit` when:
  (a) the staged diff exceeds THRESHOLD lines (insertions + deletions,
      ignoring binary files as reported by `git diff --cached --numstat`), AND
  (b) the commit message parsed from `-m` / `--message` does NOT contain
      one of the allowed literal bracketed tag tokens.

Allowed tokens (literal bracketed match, NOT substring):
    [MVP]  [LARGE-CHANGE]  [REFACTOR]  [INITIAL]  [MERGE]  [REVERT]
    [SCOPE-EXPANSION: <reason>]

So "fixed a bug with the MVP flow" does NOT satisfy the gate.
Only "[MVP] ..." or "[SCOPE-EXPANSION: why] ..." do.

BYPASS SURFACES (gate is FAIL-OPEN for all of these):
  - `git commit --amend`    — final message not parseable at PreToolUse
  - `git commit -F <file>`  — message lives in a file the hook can't read reliably
  - editor commits (no -m)  — message comes from $EDITOR post-hook
  - any exception in this script — fail-open by design (never lock the user out)
  - `override rule 11` marker file (60-second one-shot, deleted on use)

If you amend into a large commit, self-police with the tag on the next
real -m commit. The gate intentionally does not chase --amend/-F/editor
commits because parsing them reliably would require a post-commit hook,
which is a different enforcement surface.

THRESHOLD is tunable — see constant at the top of main() below.
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

# --- TUNABLES ---------------------------------------------------------------

THRESHOLD = 800  # staged insertions + deletions (non-binary files)
OVERRIDE_WINDOW_SECONDS = 60  # `override rule 11` one-shot bypass window

# --- MATCHING ---------------------------------------------------------------

# Literal bracketed tokens. NOT substring matches.
TAG_RE = re.compile(r"\[(MVP|LARGE-CHANGE|REFACTOR|INITIAL|MERGE|REVERT)\]")
SCOPE_EXPANSION_RE = re.compile(r"\[SCOPE-EXPANSION:\s*[^\]]+\]")

# -m / --message parsing. Matches:  -m "msg" | -m 'msg' | --message="msg" | -m msg_no_quotes
MSG_RE_QUOTED = re.compile(r"""(?:-m|--message)[=\s]+(["'])(.+?)\1""", re.DOTALL)
MSG_RE_BARE = re.compile(r"""(?:-m|--message)[=\s]+(\S+)""")

# Bypass-surface detection (fail-open for these)
AMEND_RE = re.compile(r"(?<!\S)--amend(?!\S)")
FILE_MSG_RE = re.compile(r"(?<!\S)(?:-F|--file)(?:=|\s+)")


def has_allowed_tag(msg: str) -> bool:
    return bool(TAG_RE.search(msg) or SCOPE_EXPANSION_RE.search(msg))


def extract_message(cmd: str) -> str | None:
    """Return the -m / --message value, or None if absent."""
    m = MSG_RE_QUOTED.search(cmd)
    if m:
        return m.group(2)
    m = MSG_RE_BARE.search(cmd)
    if m:
        return m.group(1)
    return None


def staged_line_count(project_dir: Path) -> int | None:
    """Sum insertions + deletions from git diff --cached --numstat.
    Binary files show '-' for both columns and are ignored.
    Returns None on any parse / subprocess error (caller should fail-open).
    """
    try:
        out = subprocess.check_output(
            ["git", "diff", "--cached", "--numstat"],
            cwd=project_dir,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
    except Exception:
        return None

    total = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        ins, dels = parts[0], parts[1]
        if ins == "-" or dels == "-":
            continue  # binary file
        try:
            total += int(ins) + int(dels)
        except ValueError:
            continue
    return total


def check_override(project_dir: Path) -> bool:
    """Check for one-shot override marker. Delete on use. Returns True if overridden."""
    for candidate in (
        project_dir / ".claude" / "hardgate-override-rule-11",
        Path.home() / ".claude" / "hardgate-override-rule-11",
    ):
        if not candidate.exists():
            continue
        try:
            age = time.time() - candidate.stat().st_mtime
            if age <= OVERRIDE_WINDOW_SECONDS:
                candidate.unlink(missing_ok=True)
                return True
        except Exception:
            continue
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # fail-open

    if data.get("tool_name") != "Bash":
        sys.exit(0)

    cmd = (data.get("tool_input") or {}).get("command", "").strip()
    if not cmd or "git commit" not in cmd:
        sys.exit(0)

    # Bypass surfaces — fail-open by design (documented above)
    if AMEND_RE.search(cmd) or FILE_MSG_RE.search(cmd):
        sys.exit(0)

    msg = extract_message(cmd)
    if msg is None:
        # Editor commit — not parseable at PreToolUse time; fail-open
        sys.exit(0)

    # If an allowed tag is already present, allow through regardless of size
    if has_allowed_tag(msg):
        sys.exit(0)

    project_dir = Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())

    # Override pressure valve — one-shot, 60 second window
    if check_override(project_dir):
        print("[HARD-RULE-11] override rule 11 accepted — bypassing once.", file=sys.stderr)
        sys.exit(0)

    total = staged_line_count(project_dir)
    if total is None or total <= THRESHOLD:
        sys.exit(0)  # under threshold, or parse error (fail-open)

    # BLOCKED
    print(f"[HARD-RULE-11] BLOCKED — Commit-Size Acknowledgment Gate.", file=sys.stderr)
    print("", file=sys.stderr)
    print(f"Staged diff is {total} lines (threshold: {THRESHOLD}) and the commit", file=sys.stderr)
    print("message contains no explicit size-acknowledgment tag.", file=sys.stderr)
    print("", file=sys.stderr)
    print("Add one of these literal bracketed tokens to the commit message:", file=sys.stderr)
    print("    [MVP]  [LARGE-CHANGE]  [REFACTOR]  [INITIAL]  [MERGE]  [REVERT]", file=sys.stderr)
    print("    [SCOPE-EXPANSION: <reason>]", file=sys.stderr)
    print("", file=sys.stderr)
    print("Example:", file=sys.stderr)
    print('    git commit -m "[LARGE-CHANGE] service extraction + schema split"', file=sys.stderr)
    print("", file=sys.stderr)
    print("Or split the commit into smaller reviewable pieces.", file=sys.stderr)
    print("", file=sys.stderr)
    print("Pressure valve (user-only): say `override rule 11` to arm a", file=sys.stderr)
    print(f"{OVERRIDE_WINDOW_SECONDS}-second one-shot bypass.", file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
