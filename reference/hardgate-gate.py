#!/usr/bin/env python3
"""
Reference implementation of the hardgate gate.py template (SKILL.md Artifact 1).

Instantiated as a context-mode style PLUGIN gate for testing.
Forbidden set: cat, head, tail, grep, rg, find — the read-command verbs the
context-mode plugin replaces.

This module is imported directly by gate_test.py for unit tests and also run
as a subprocess for stdin/exit-code integration tests.
"""
import json
import os
import pathlib
import re
import shlex
import sys
import time

RULE_NUMBER = 99  # Test sentinel — real gates use the next available Hard Rule number

# ── interpreter sets (from SKILL.md reference constants) ─────────────────────

SHELL_INTERPRETERS = {"sh", "bash", "zsh", "dash", "ash", "ksh"}

SCRIPT_INTERPRETERS = {
    "python":  ("-c",),
    "python2": ("-c",),
    "python3": ("-c",),
    "perl":    ("-e",),
    "ruby":    ("-e",),
    "node":    ("-e", "--eval"),
    "deno":    ("eval",),
    "php":     ("-r",),
}

MAX_SHELL_C_DEPTH = 2

# ── forbidden set (context-mode style) ───────────────────────────────────────

FORBIDDEN = {"cat", "head", "tail", "grep", "rg", "find"}

WRAPPERS = {"sudo", "env", "command", "exec", "time", "nohup"}

# ── X4: time-limited single-use override marker ───────────────────────────────


def check_override_marker(rule_num: int) -> None:
    """
    Check for a one-time bypass marker created when the human types
    'override rule N'. Valid markers (< 60 s old) grant a single bypass
    and are immediately deleted. Stale or corrupt markers are deleted
    silently without granting a bypass.
    """
    marker = (
        pathlib.Path(os.environ.get("CLAUDE_PROJECT_DIR", "."))
        / ".claude"
        / f"hardgate-override-rule-{rule_num}"
    )
    if not marker.exists():
        return
    try:
        age = time.time() - float(marker.read_text().strip())
        marker.unlink()
        if age < 60:
            sys.stderr.write(
                f"[HARD-RULE-{rule_num}] Override marker valid "
                f"(age={age:.1f}s < 60s). One-time bypass granted.\n"
            )
            sys.exit(0)
        sys.stderr.write(
            f"[HARD-RULE-{rule_num}] Override marker EXPIRED "
            f"(age={age:.1f}s >= 60s). Marker deleted. "
            f"Type 'override rule {rule_num}' again to re-arm.\n"
        )
    except Exception:
        try:
            marker.unlink()
        except Exception:
            pass


# ── tokenizer ─────────────────────────────────────────────────────────────────


def strip_wrappers(tokens: list) -> list:
    """
    Strip leading env-var assignments (KEY=VALUE), wrapper commands
    (sudo, env, command, exec, time, nohup), and path prefixes (/usr/bin/cat
    → cat) from a token list. Loops until no further stripping is possible so
    that combinations like /usr/bin/sudo cat README.md are handled correctly.
    """
    changed = True
    while tokens and changed:
        changed = False
        tok = tokens[0]
        # env-var assignment: KEY=VALUE or KEY=
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
            tokens = tokens[1:]
            changed = True
            continue
        # wrapper verb
        if tok in WRAPPERS:
            tokens = tokens[1:]
            changed = True
            continue
        # path prefix: /usr/bin/cat → cat
        base = os.path.basename(tok)
        if base and base != tok:
            tokens = [base] + tokens[1:]
            changed = True
            continue
    return tokens


def split_pipeline(cmd: str) -> list:
    """Split a command string on &&, ||, ;, | into individual sub-commands."""
    parts = re.split(r"&&|\|\||[;|]", cmd)
    return [p.strip() for p in parts if p.strip()]


def check_tokens(tokens: list, depth: int = 0) -> bool:
    """
    Return True if the token list contains a forbidden verb.

    Handles:
    - Wrapper/env-var stripping
    - Shell -c recursion up to MAX_SHELL_C_DEPTH; fail-closed at depth cap
    - Inline-code interpreter blocking (python -c, node -e, deno eval, etc.)
    - ENG-001: fail-closed on shlex.split() failure inside -c arguments
    """
    if not tokens:
        return False

    tokens = strip_wrappers(tokens)
    if not tokens:
        return False

    verb = tokens[0]

    # ── shell -c recursion ────────────────────────────────────────────────
    if verb in SHELL_INTERPRETERS and len(tokens) >= 2 and tokens[1] == "-c":
        if depth >= MAX_SHELL_C_DEPTH:
            # At depth cap — fail-closed (block rather than let through)
            return True
        if len(tokens) < 3:
            return False
        inner_arg = tokens[2]
        try:
            inner_flat = shlex.split(inner_arg)
        except ValueError:
            # Unparseable inner -c argument — fail-closed (ENG-001)
            return True
        for sub in split_pipeline(" ".join(inner_flat)):
            try:
                sub_tokens = shlex.split(sub)
            except ValueError:
                return True  # fail-closed
            if check_tokens(sub_tokens, depth + 1):
                return True
        return False

    # ── inline-code interpreter blocking ─────────────────────────────────
    if verb in SCRIPT_INTERPRETERS:
        flags = SCRIPT_INTERPRETERS[verb]
        for tok in tokens[1:]:
            if tok in flags:
                return True  # block any inline-code invocation outright
        return False

    # ── forbidden verb ────────────────────────────────────────────────────
    return verb in FORBIDDEN


def is_forbidden(cmd: str) -> bool:
    """Return True if any sub-command in cmd contains a forbidden verb."""
    for sub_cmd in split_pipeline(cmd):
        try:
            tokens = shlex.split(sub_cmd)
        except ValueError:
            continue  # outer parse error — fail-open per SKILL.md spec
        if check_tokens(tokens):
            return True
    return False


# ── main ──────────────────────────────────────────────────────────────────────


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        # Fail-open on outer JSON parse errors (SKILL.md Artifact 1 spec)
        sys.exit(0)

    if payload.get("tool_name") != "Bash":
        sys.exit(0)

    check_override_marker(RULE_NUMBER)  # X4: time-limited override bypass

    tool_input = payload.get("tool_input") or {}
    cmd = tool_input.get("command") or ""

    if is_forbidden(cmd):
        sys.stderr.write(
            f"[HARD-RULE-{RULE_NUMBER}] BLOCKED by hardgate-reference: "
            f"forbidden command in: {cmd!r}\n"
        )
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
