#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# AntiStallClaude — operator helper (v0.3.0).
#
# AUTHORITY MODEL (the v0.3.0 hardening)
# --------------------------------------
# The AGENT can ARM a sprint but can NEVER disarm it. Turning the gate OFF requires a
# human-held RELEASE SECRET that is never stored in plaintext and is never placed in the
# agent's context. This closes the v0.2.x hole where an agent could write a "DONE" ticket
# to disarm itself and quit early (e.g. declaring a project "done" with tests/features
# still unbuilt). There is intentionally NO agent-usable disarm command.
#
# HUMAN, ONCE (run in your OWN terminal, NOT through the agent):
#   python3 antistall.py set-release-secret      # prompts (hidden) for your passphrase
#
# HUMAN, to stop a sprint (out of band, your own terminal):
#   cd <project> && python3 antistall.py release         # prompts for the passphrase
#   cd <project> && python3 antistall.py release --all   # disarm every gate in the project
#
# AGENT or human:
#   python3 antistall.py arm "<goal>"     # start a sprint (a release secret must exist)
#   python3 antistall.py status
#   python3 antistall.py request "<why>"  # ask the human to stop; notifies them; does NOT disarm

from __future__ import annotations

import base64
import getpass
import hashlib
import hmac
import json
import os
import pathlib
import re
import subprocess
import sys
import time

PBKDF2_ITERS = 240_000


def _resolve_claude() -> pathlib.Path:
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env and (pathlib.Path(env) / ".claude").is_dir():
        return pathlib.Path(env) / ".claude"
    cwd_claude = pathlib.Path.cwd() / ".claude"
    if cwd_claude.is_dir():
        return cwd_claude
    return pathlib.Path(__file__).resolve().parents[1]


def _user_claude() -> pathlib.Path:
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    return pathlib.Path(cfg) if cfg else pathlib.Path.home() / ".claude"


CLAUDE = _resolve_claude()
# The release secret is USER-level (one human key for all projects), never per-project.
SECRET_FILE = _user_claude() / "antistall-release.hash"


def _safe_sid(sid: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", sid)[:80]


def _session_id():
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID")
    return sid if sid and sid.strip() else None


SID = _session_id()
FLAG = CLAUDE / (f"sprint-gate-{_safe_sid(SID)}.json" if SID else "sprint-gate.json")


# --------------------------------------------------------------- release secret (human key)
def _hash(passphrase: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, PBKDF2_ITERS).hex()


def _store_secret(passphrase: str) -> None:
    salt = os.urandom(16)
    rec = {"algo": "pbkdf2_sha256", "iters": PBKDF2_ITERS,
           "salt": salt.hex(), "hash": _hash(passphrase, salt)}
    SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    SECRET_FILE.write_text(json.dumps(rec), encoding="utf-8")
    try:
        os.chmod(SECRET_FILE, 0o600)
    except OSError:
        pass


def _verify_secret(passphrase: str) -> bool:
    try:
        rec = json.loads(SECRET_FILE.read_text(encoding="utf-8"))
        return hmac.compare_digest(_hash(passphrase, bytes.fromhex(rec["salt"])), rec["hash"])
    except Exception:
        return False


def _secret_exists() -> bool:
    return SECRET_FILE.is_file()


def _ps_str(s: str) -> str:
    # Single-quoted PowerShell string literal (escape embedded single quotes).
    return "'" + str(s).replace("'", "''") + "'"


def _run_ps_capture(ps: str):
    # Run a PowerShell snippet via -EncodedCommand (no quoting hell) and capture stdout.
    # The captured stdout is consumed INTERNALLY and never re-emitted, so a secret typed
    # into a GUI dialog here never reaches this process's own stdout (what an agent sees).
    enc = base64.b64encode(ps.encode("utf-16-le")).decode("ascii")
    try:
        p = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
            capture_output=True, text=True,
        )
    except Exception:
        return None
    if p.returncode != 0:
        return None
    return p.stdout


def _gui_password(title: str, prompt: str):
    # Masked Windows dialog. Returns the typed text, or None on cancel / unavailable.
    # COWORK PATH: the agent can launch this window but cannot see what is typed into it.
    if os.name != "nt":
        return None
    ps = f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.Text = {_ps_str(title)}
$f.Size = New-Object System.Drawing.Size(460,190)
$f.StartPosition = 'CenterScreen'; $f.TopMost = $true
$f.FormBorderStyle = 'FixedDialog'; $f.MinimizeBox = $false; $f.MaximizeBox = $false
$l = New-Object System.Windows.Forms.Label
$l.Text = {_ps_str(prompt)}; $l.SetBounds(14,14,420,44)
$t = New-Object System.Windows.Forms.TextBox
$t.UseSystemPasswordChar = $true; $t.SetBounds(14,62,420,26)
$ok = New-Object System.Windows.Forms.Button
$ok.Text='OK'; $ok.DialogResult=[System.Windows.Forms.DialogResult]::OK; $ok.SetBounds(260,104,80,30)
$c = New-Object System.Windows.Forms.Button
$c.Text='Cancel'; $c.DialogResult=[System.Windows.Forms.DialogResult]::Cancel; $c.SetBounds(350,104,80,30)
$f.AcceptButton=$ok; $f.CancelButton=$c
$f.Controls.AddRange(@($l,$t,$ok,$c))
$f.Add_Shown({{ $f.Activate(); $t.Focus() }})
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ [Console]::Out.Write($t.Text) }} else {{ exit 2 }}
"""
    return _run_ps_capture(ps)


def _gui_pick_folder(prompt: str):
    # Native folder picker. Returns the selected path or None.
    if os.name != "nt":
        return None
    ps = f"""
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = {_ps_str(prompt)}; $d.ShowNewFolderButton = $false
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ [Console]::Out.Write($d.SelectedPath) }} else {{ exit 2 }}
"""
    r = _run_ps_capture(ps)
    return r.strip() if r else None


def _read_passphrase(prompt: str, title: str = "AntiStall") -> str:
    # ANTISTALL_RELEASE env (non-interactive human/CI) always wins.
    env = os.environ.get("ANTISTALL_RELEASE")
    if env:
        return env
    # On Windows ALWAYS prefer the masked GUI dialog — it works whether or not a console
    # is attached, so a desktop/Cowork user is never dropped into a terminal getpass prompt
    # (the bug: launching via a console made isatty() true and used the text prompt).
    if os.name == "nt":
        gui = _gui_password(title, prompt)
        if gui is not None:
            return gui
    # Non-Windows, or GUI unavailable: hidden console input.
    if getattr(sys.stdin, "isatty", lambda: False)():
        try:
            return getpass.getpass(prompt)
        except Exception:
            pass
    return ""


def _notify(msg: str) -> None:
    # Best-effort desktop toast so a HUMAN is summoned — without the agent disarming.
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


def _clear_counts() -> None:
    pat = f".antistall-block-count-{_safe_sid(SID)}*" if SID else ".antistall-block-count*"
    for p in CLAUDE.glob(pat):
        try:
            p.unlink()
        except Exception:
            pass


def main(argv: list[str]) -> int:
    cmd = argv[1].lower() if len(argv) > 1 else "status"
    detail = " ".join(a for a in argv[2:] if not a.startswith("--")) if len(argv) > 2 else ""

    # ---- set-release-secret (human) -------------------------------------------------
    if cmd in ("set-release-secret", "set-secret"):
        if _secret_exists():
            cur = _read_passphrase("Enter your CURRENT release passphrase (required to change it):",
                                   "AntiStall - change passphrase")
            if not _verify_secret(cur):
                print("wrong current passphrase — refusing to change the release secret.",
                      file=sys.stderr)
                return 4
        p1 = _read_passphrase("Choose a NEW AntiStall release passphrase. Only you will know it; "
                              "you will need it to stop a sprint.", "AntiStall - set passphrase")
        if not p1:
            print("no passphrase entered — aborted.", file=sys.stderr)
            return 4
        p2 = _read_passphrase("Re-enter the same passphrase to confirm:",
                              "AntiStall - confirm passphrase")
        if p1 != p2:
            print("passphrases did not match — aborted. Run it again.", file=sys.stderr)
            return 4
        _store_secret(p1)
        print("release secret stored. Only this passphrase can disarm a sprint now — "
              "the agent never saw what you typed.")
        return 0

    # ---- arm (agent or human) -------------------------------------------------------
    if cmd == "arm":
        if not _secret_exists():
            print("REFUSING TO ARM: no release secret is set, so the sprint could only be "
                  "disarmed by the agent — which defeats the gate. Set one first: tell the agent "
                  "\"set the antistall passphrase\" and it pops a PASSWORD BOX for you to type into "
                  "(the agent never sees it). No file to find, no terminal.",
                  file=sys.stderr)
            return 5
        FLAG.write_text(
            json.dumps({"active": True, "note": detail, "owner": SID, "armed_ts": time.time()}),
            encoding="utf-8",
        )
        _clear_counts()
        who = f"session {SID[:8]}…" if SID else "project-wide"
        print(f"armed: sprint gate ACTIVE [{who}] — {detail or '(no note)'}\n"
              "  TO STOP: just tell the agent \"disarm\" (or \"stop\"/\"that's enough\"). It will "
              "pop a PASSWORD BOX on your screen — type your passphrase there and it ends. "
              "No file to find, no terminal. The agent can pop the box but can never fill it.")
        return 0

    # ---- release (human only; the ONLY disarm) --------------------------------------
    if cmd == "release":
        if not _secret_exists():
            print("no release secret is set — nothing to verify against. Set one with "
                  "set-release-secret. (Refusing to disarm without proof of human authority.)",
                  file=sys.stderr)
            return 5
        # Resolve which project's gate to clear. Agent-triggered release has
        # CLAUDE_PROJECT_DIR (or a project cwd); a context-less double-click pops a
        # folder picker so the human chooses — no CLI/path typing needed.
        env = os.environ.get("CLAUDE_PROJECT_DIR")
        if env and (pathlib.Path(env) / ".claude").is_dir():
            claude_dir = pathlib.Path(env) / ".claude"
        elif (pathlib.Path.cwd() / ".claude").is_dir():
            claude_dir = pathlib.Path.cwd() / ".claude"
        else:
            picked = _gui_pick_folder("Select the project folder whose AntiStall sprint to disarm")
            claude_dir = (pathlib.Path(picked) / ".claude") if picked else None
            if not claude_dir or not claude_dir.is_dir():
                print("no project selected (or it has no .claude) — nothing disarmed.", file=sys.stderr)
                return 5
        if not _verify_secret(_read_passphrase("Enter your AntiStall release passphrase to STOP the sprint:",
                                               "AntiStall - release / disarm")):
            print("WRONG passphrase — sprint NOT disarmed.", file=sys.stderr)
            return 6
        # Clear this session's gate, or all gates in the project (--all, or when there's
        # no session id — e.g. a human double-click disarming the whole project).
        if "--all" in argv or not SID:
            targets = list(claude_dir.glob("sprint-gate*.json"))
        else:
            targets = [claude_dir / f"sprint-gate-{_safe_sid(SID)}.json"]
            if (claude_dir / "sprint-gate.json").exists():
                targets.append(claude_dir / "sprint-gate.json")
        n = 0
        for t in targets:
            try:
                t.unlink(); n += 1
            except Exception:
                pass
        for c in claude_dir.glob(".antistall-block-count*"):
            try:
                c.unlink()
            except Exception:
                pass
        try:
            (claude_dir / "sprint-stop-request.json").unlink()
        except Exception:
            pass
        print(f"RELEASED by human — disarmed {n} sprint-gate file(s) in {claude_dir}.")
        return 0

    # ---- request (agent voice; notifies human, does NOT disarm) ----------------------
    if cmd in ("request", "ask"):
        try:
            (CLAUDE / "sprint-stop-request.json").write_text(
                json.dumps({"detail": detail, "ts": time.time(), "session": SID}),
                encoding="utf-8",
            )
        except Exception:
            pass
        _notify(f"Agent wants to STOP: {detail[:160]} — review and 'release' if you agree.")
        print("stop-request recorded and the human was notified. The gate stays ARMED — keep "
              "working until a human runs 'release'. You cannot end the sprint yourself.")
        return 0

    # ---- status ---------------------------------------------------------------------
    if cmd == "status":
        try:
            flag = json.loads(FLAG.read_text(encoding="utf-8"))
            armed, note = bool(flag.get("active")), flag.get("note", "")
        except Exception:
            armed, note = False, ""
        scope = f"session {SID[:8]}…" if SID else "project-wide (no session id)"
        line = f"Sprint gate [{scope}]: {'ARMED' if armed else 'disarmed'}."
        if note:
            line += f" Note: {note}."
        if not armed:
            legacy = CLAUDE / "sprint-gate.json"
            try:
                lg = json.loads(legacy.read_text(encoding="utf-8"))
                if lg.get("active"):
                    owner = lg.get("owner")
                    who = ("unowned/all sessions" if owner is None else
                           ("this session" if owner == SID else f"another session ({str(owner)[:8]}…)"))
                    line += f" [legacy {legacy.name} ARMED, owner: {who}]"
            except Exception:
                pass
        line += f" Release secret set: {'yes' if _secret_exists() else 'NO (arm is blocked until set)'}."
        line += " Disarm is human-only ('release' + passphrase)."
        print(line)
        return 0

    # ---- removed / unknown ----------------------------------------------------------
    if cmd in ("done", "blocked", "question"):
        print(f"'{cmd}' was REMOVED in v0.3.0: an agent can no longer disarm or self-authorize a "
              "stop. If you genuinely should stop, run 'request \"<why>\"' to summon the human; "
              "only a human 'release' (with the passphrase) ends a sprint.", file=sys.stderr)
        return 7
    print(f"unknown command: {cmd!r} "
          "(use arm | status | request | release | set-release-secret)", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
