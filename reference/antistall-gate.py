#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# AntiStallClaude — anti-stall Stop hook.
#
# Blocks the agent from ending a turn while an autonomous sprint is ACTIVE
# unless a fresh, single-use stop-ticket declares why the stop is legitimate
# (DONE / BLOCKED / QUESTION). This is the harness-enforced cure for the
# "announce-then-halt" / silent drift-stop failure: a CLAUDE.md or memory note
# is advice the model can rationalize past; this hook is a separate process the
# harness runs on EVERY Stop event regardless of what the model "remembers".
#
# State files (all in <project>/.claude/):
#   sprint-gate.json               {"active": true, "note": "..."}  gate armed when active
#   sprint-stop-ticket.json        {"reason":"DONE|BLOCKED|QUESTION","detail":"...","ts":<epoch>}
#   .antistall-block-count-<sid>   integer, consecutive blocks (anti-loop counter; per-session)
#
# Behavior:
#   - sprint NOT active            -> exit 0 (silent; normal conversation ungated)
#   - stop_hook_active == true     -> exit 0 (LOOP GUARD; see below) — ALWAYS allow
#   - active + fresh valid ticket  -> consume ticket, reset counter, exit 0 (allow stop)
#   - active + no/stale ticket     -> {"decision":"block", reason:...}, exit 0 (forced to continue)
#   - any counter anomaly          -> exit 0 (FAIL OPEN — a loop guard must never loop)
#
# ---------------------------------------------------------------------------
# TERMINATION SAFETY (why this hook can NEVER burn tokens in an endless loop)
# ---------------------------------------------------------------------------
# A Stop hook that emits {"decision":"block"} to force the agent to keep going
# can, if it re-blocks while the agent is ALREADY continuing because of a prior
# block, create an unbounded `block -> continue -> block` loop: the session
# never goes idle and tokens burn without limit. This is the single most
# dangerous failure mode of any blocking Stop hook, and earlier versions of this
# file had it (the only brake was a consecutive-block counter that reset to 0 on
# any read error, AND was shared by every agent in the project, so two agents —
# or any mid-write race — kept it pinned below the cap and the gate looped).
#
# Two INDEPENDENT guarantees now prevent it:
#   (1) PRIMARY — honor `stop_hook_active`. The agent harness sets this field to
#       true on a Stop that is itself the result of a previous Stop-hook block.
#       When true, ALWAYS allow the stop. This bound depends on NO shared file,
#       so it is immune to any counter race. It caps the gate at one nudge per
#       continuation chain — the gate still stops a drift-stop, it just cannot
#       loop on it.
#   (2) SECONDARY — a PER-SESSION consecutive-block counter that FAILS OPEN. The
#       counter file name is keyed on the Stop payload's `session_id`, so two
#       agents NEVER share it (closing the cross-agent race for real, not just in
#       docs). For a harness that doesn't surface `stop_hook_active`, the counter
#       still caps the loop; and ANY uncertainty about it (missing parses as 0;
#       unreadable / empty / corrupt / unwritable all ALLOW the stop). A loop
#       guard that can itself loop is worse than no guard.
#
# Stop hooks signal "keep going" via a JSON {"decision":"block"} on stdout,
# NOT via exit code 2 (that is the PreToolUse convention). Exit 0 either way.
#
# Env overrides (optional):
#   ANTISTALL_BLOCK_CAP            consecutive-block escape hatch (default 6)
#   ANTISTALL_TICKET_MAX_AGE_S     a stop-ticket older than this is stale (default 300)

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import time
from typing import NoReturn

TAG = "[ANTI-STALL]"


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default


def _claude_dir() -> pathlib.Path:
    # Robust whether or not CLAUDE_PROJECT_DIR is set at hook runtime: this file
    # lives at <project>/.claude/hooks/antistall-gate.py, so parents[1] == .claude.
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        d = pathlib.Path(env) / ".claude"
        if d.is_dir():
            return d
    return pathlib.Path(__file__).resolve().parents[1]


def _count_path(claude_dir: pathlib.Path, payload: dict) -> pathlib.Path:
    # PER-SESSION counter: keying the file name on session_id means two agents
    # working in the same project never share the counter, so the consecutive-
    # block count cannot be corrupted by a concurrent read-modify-write race.
    # Fall back to a shared name only when the harness gives us no session id.
    sid = payload.get("session_id")
    if isinstance(sid, str) and sid.strip():
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", sid)[:80]
        return claude_dir / f".antistall-block-count-{safe}"
    return claude_dir / ".antistall-block-count"


def _read_json(p: pathlib.Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _safe_sid(sid: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", sid)[:80]


def _session_id(payload: dict):
    sid = payload.get("session_id")
    return sid if isinstance(sid, str) and sid.strip() else None


def _resolve_active_gate(claude_dir: pathlib.Path, sid):
    # Returns (gate_path, ticket_path) for the active sprint that applies to THIS
    # session, or (None, None) if none does. SESSION-SCOPED first
    # (sprint-gate-<sid>.json), so two sessions in one project never gate each other.
    # Then a legacy project-wide sprint-gate.json, honored only if it is unowned
    # (pre-0.2.1 — applies to all sessions, preserving old behavior) or explicitly
    # owned by this session ("owner": "<session_id>").
    if sid:
        gp = claude_dir / f"sprint-gate-{_safe_sid(sid)}.json"
        g = _read_json(gp)
        if isinstance(g, dict) and g.get("active"):
            return gp, claude_dir / f"sprint-stop-ticket-{_safe_sid(sid)}.json"
    legacy = _read_json(claude_dir / "sprint-gate.json")
    if isinstance(legacy, dict) and legacy.get("active"):
        owner = legacy.get("owner")
        if owner is None or owner == sid:
            return (claude_dir / "sprint-gate.json",
                    claude_dir / "sprint-stop-ticket.json")
    return None, None


def _safe_unlink(p: pathlib.Path) -> None:
    try:
        p.unlink()
    except Exception:
        pass


def _allow(msg: str) -> NoReturn:
    """Permit the stop: write a one-line stderr note and exit 0 (no block).

    IMPORTANT: allowing a stop is NOT disarming. This function NEVER clears the
    sprint-gate file — the gate stays ARMED and re-enforces on the next turn.
    Only a human `release` (passphrase-verified) ever turns the switch off.
    """
    sys.stderr.write(f"{TAG} {msg}\n")
    sys.exit(0)


def _notify(msg: str) -> None:
    # Best-effort desktop toast so a HUMAN is summoned to review — the gate never
    # disarms itself, so this is how a paused/at-cap sprint reaches the operator.
    if os.name != "nt":
        return
    try:
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "Add-Type -AssemblyName System.Drawing;"
            "$n=New-Object System.Windows.Forms.NotifyIcon;"
            "$n.Icon=[System.Drawing.SystemIcons]::Warning;$n.Visible=$true;"
            "$n.BalloonTipTitle='AntiStall';$n.BalloonTipText=$env:ANTISTALL_MSG;"
            "$n.ShowBalloonTip(7000);Start-Sleep -Milliseconds 7500;$n.Dispose()"
        )
        subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
            env={**os.environ, "ANTISTALL_MSG": msg[:240]},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


def main() -> None:
    # Drain stdin and parse the Stop payload. We need `stop_hook_active` and
    # `session_id` from it, but a framing change must never wedge the session:
    # an unparseable payload yields {} and we fall through (fail-open).
    raw = ""
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""
    try:
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            payload = {}
    except Exception:
        payload = {}

    claude_dir = _claude_dir()
    sid = _session_id(payload)
    gate_path, ticket_path = _resolve_active_gate(claude_dir, sid)
    if gate_path is None:
        sys.exit(0)  # no active sprint for this session -> the gate is silent

    # cap = consecutive Stop-hook blocks after which we PAUSE (allow this one stop) so a
    # runaway / genuinely-stuck agent can't burn tokens forever. A pause NEVER disarms —
    # the gate stays armed and re-enforces next turn; only a human `release` turns it off.
    # ANTISTALL_BLOCK_CAP=0 disables the pause entirely (hold until a human releases).
    cap = _int_env("ANTISTALL_BLOCK_CAP", 25)
    count_path = _count_path(claude_dir, payload)

    # NOTE: there is intentionally NO agent stop path here. v0.2.x honored a DONE/BLOCKED/
    # QUESTION ticket written by the agent (and `done` cleared the gate), which let the
    # agent disarm itself and quit early. That is removed: the agent cannot end a sprint.
    # The ONLY exits are (a) a human `release` (passphrase) and (b) the token-burn pause
    # below — and neither (a)'s agent-side nor (b) ever clears the gate except `release`.

    # Per-session consecutive-block counter. Every fail-open path here yields at most a
    # PAUSE (the gate is never cleared), so failing open can never turn the switch off.
    try:
        current = count_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        current = "0"
    except Exception:
        _allow("stop PAUSED (counter unreadable). Sprint STILL ARMED — re-enforces next turn.")
    try:
        n = int(current) + 1
    except Exception:
        _safe_unlink(count_path)
        _allow("stop PAUSED (counter corrupt; reset). Sprint STILL ARMED — re-enforces next turn.")
    if cap > 0 and n >= cap:
        _safe_unlink(count_path)  # reset the counter only; the gate file is left ARMED
        _notify(f"AntiStall: paused at block cap ({cap}); sprint STILL ARMED. Review and "
                "'release' if it's truly done, or it keeps enforcing.")
        _allow(
            f"token-burn cap ({cap}) reached — PAUSING this stop, but the sprint is STILL "
            f"ARMED ({gate_path}). A human was notified. It re-enforces next turn; only "
            f"'python3 antistall.py release' (human passphrase) ends it."
        )
    try:
        count_path.write_text(str(n), encoding="utf-8")
    except Exception:
        _allow("stop PAUSED (cannot persist counter). Sprint STILL ARMED — re-enforces next turn.")

    antistall_py = pathlib.Path(__file__).resolve().with_name("antistall.py")
    reason_msg = (
        f"{TAG} A sprint is ACTIVE — do NOT end the turn. Keep working until the goal is genuinely "
        f"done. You cannot stop or disarm yourself (no DONE, no ticket). "
        f"IF THE HUMAN ASKS YOU TO STOP / DISARM / CANCEL / \"that's enough\": immediately run "
        f"`python3 \"{antistall_py}\" release` — that pops a PASSWORD BOX on their screen for THEM to "
        f"type into (you can't supply the passphrase, and that's fine; the box appears, you just can't "
        f"fill it). Do NOT tell them to open a terminal, do NOT point them at a .cmd or any file to "
        f"find, and do NOT claim they released you. Just run release; the box appears. "
        f"If you're genuinely blocked on a human-only decision, run "
        f"`python3 \"{antistall_py}\" request \"<why>\"` to ping them, then keep working on anything "
        f"else still buildable. Block {n}"
        + (f"/{cap}" if cap > 0 else " (no cap; held until human release)") + "."
    )
    print(json.dumps({"decision": "block", "reason": reason_msg}))
    sys.exit(0)


if __name__ == "__main__":
    main()
