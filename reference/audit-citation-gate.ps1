# audit-citation-gate.ps1 — Stop hook.
#
# PURPOSE
#   Claude cannot end a turn after writing an audit/verdict/review/handoff
#   document unless every behavioural claim in it is either
#     (a) cited to a real file:line that the session transcript proves was read, or
#     (b) explicitly marked UNVERIFIED.
#
#   This exists because a promise to "always check the source" failed. A gate
#   the model cannot disable replaces the promise.
#
# CONTRACT (verified against code.claude.com/docs/en/hooks, 2026-08-27)
#   stdin JSON: session_id, transcript_path, cwd, permission_mode,
#               hook_event_name, last_assistant_message, stop_reason
#   exit 2  -> blocks the stop, stderr is fed back to Claude
#   exit 0  -> allow
#   any other exit -> non-blocking; action proceeds
#
# FAIL-OPEN POLICY: only for hook infrastructure faults (no stdin, unreadable
# transcript). Never for a failed citation check — those exit 2.

$ErrorActionPreference = 'Stop'

function Allow([string]$why) { if ($why) { Write-Host $why }; exit 0 }
function Block([string]$msg) { [Console]::Error.WriteLine($msg); exit 2 }

# ---------- read hook input ----------
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { Allow "audit-citation-gate: no stdin; allowing." }
    $hook = $raw | ConvertFrom-Json
} catch {
    Allow "audit-citation-gate: unreadable stdin; allowing."
}

$transcript = [string]$hook.transcript_path
$cwd        = [string]$hook.cwd
if ([string]::IsNullOrWhiteSpace($cwd)) { $cwd = (Get-Location).Path }

if ([string]::IsNullOrWhiteSpace($transcript) -or -not (Test-Path -LiteralPath $transcript)) {
    Allow "audit-citation-gate: no transcript; allowing."
}

# ---------- gather transcript ----------
try {
    $lines = Get-Content -LiteralPath $transcript -ErrorAction Stop
} catch {
    Allow "audit-citation-gate: transcript unreadable; allowing."
}

# Text of every tool_use input in the session. A path counts as READ only if it
# appears inside a tool invocation, not merely in prose Claude wrote.
$toolText = New-Object System.Text.StringBuilder
# Files Claude created or edited this session (Write/Edit/NotebookEdit file_path).
$written = New-Object System.Collections.Generic.HashSet[string]

foreach ($line in $lines) {
    if ($line -notmatch '"type"\s*:\s*"tool_use"') { continue }
    try { $rec = $line | ConvertFrom-Json } catch { continue }
    $content = $rec.message.content
    if ($null -eq $content) { continue }
    foreach ($block in @($content)) {
        if ($block.type -ne 'tool_use') { continue }
        $inputJson = ''
        try { $inputJson = ($block.input | ConvertTo-Json -Depth 12 -Compress) } catch { $inputJson = '' }
        [void]$toolText.Append($inputJson).Append("`n")
        if ($block.name -in @('Write','Edit','NotebookEdit')) {
            $fp = [string]$block.input.file_path
            if ($fp) { [void]$written.Add($fp) }
        }
    }
}
$toolBlob = $toolText.ToString().Replace('\\','/').Replace('\','/').ToLowerInvariant()

# ---------- which documents are governed ----------
$governed = @()
foreach ($f in $written) {
    $name = Split-Path $f -Leaf
    if ($name -notmatch '\.md$') { continue }
    # Memory notes are Claude's own context, not deliverables handed to the
    # operator, and they have a fixed frontmatter format a ledger would break.
    # Narrow exclusion by PATH only — a file with the same name anywhere else
    # is still governed. (Found live: memory/audit-citation-gate.md blocked.)
    if ($f -match '(?i)[\\/]memory[\\/]') { continue }
    if ($name -match '(?i)audit|verdict|review|handoff|evidence|assessment|findings') {
        if (Test-Path -LiteralPath $f) { $governed += $f }
    }
}
if ($governed.Count -eq 0) { Allow "audit-citation-gate: no governed documents this session; allowing." }

# ---------- helpers ----------
function Resolve-Cited([string]$p, [string]$cwd) {
    $c = $p.Trim().Trim('`').Trim('"')
    $cands = @()
    $cands += $c
    if (-not [System.IO.Path]::IsPathRooted($c)) { $cands += (Join-Path $cwd $c) }
    foreach ($cand in $cands) {
        try { if (Test-Path -LiteralPath $cand -PathType Leaf) { return (Resolve-Path -LiteralPath $cand).Path } } catch {}
    }
    return $null
}

function Was-Read([string]$resolved, [string]$blob) {
    $norm = $resolved.Replace('\','/').ToLowerInvariant()
    if ($blob.Contains($norm)) { return $true }
    # Tolerate absolute-vs-relative citation styles: require the last two
    # path segments to appear together, which a bare filename cannot fake.
    $seg = $norm.Split('/')
    if ($seg.Length -ge 2) {
        $tail = ($seg[-2] + '/' + $seg[-1])
        if ($blob.Contains($tail)) { return $true }
    }
    return $false
}

# ---------- enforce ----------
$problems = New-Object System.Collections.Generic.List[string]

foreach ($doc in $governed) {
    $text = Get-Content -LiteralPath $doc -Raw
    $docName = Split-Path $doc -Leaf

    # Strip fenced code blocks before parsing. An audit document legitimately
    # shows the ledger FORMAT as an example; those lines are documentation, not
    # claims. Found live: this gate's own evidence file was blocked by its own
    # syntax example. Note this is not a bypass — a document that hides all its
    # claims inside fences then has zero ledger entries, which the
    # verdict-without-entries rule below blocks anyway.
    $text = [regex]::Replace($text, '(?s)```.*?```', '')

    # Allow an optional section number, e.g. "## 4. Verification ledger".
    $hasLedger = $text -match '(?im)^\s*##+\s*(\d+[\.\)]\s*)?Verification ledger\s*$'
    $verified   = [regex]::Matches($text, '(?im)^\s*VERIFIED:\s*(.+?)\s*\|\s*(.+?)\s*$')
    $unverified = [regex]::Matches($text, '(?im)^\s*UNVERIFIED:\s*(.+?)\s*$')
    $hasVerdict = $text -match '(?im)\b(PASS|FAIL|APPROVE[D]?|I recommend|My recommendation|VERDICT)\b'

    if (-not $hasLedger) {
        $problems.Add("$docName : missing a '## Verification ledger' section. Every audit/review/handoff document must carry one.")
        continue
    }
    if ($hasVerdict -and $verified.Count -eq 0 -and $unverified.Count -eq 0) {
        $problems.Add("$docName : states a verdict or recommendation but the ledger has no VERIFIED: or UNVERIFIED: entries.")
        continue
    }

    foreach ($m in $verified) {
        $claim = $m.Groups[1].Value
        $cite  = $m.Groups[2].Value.Trim()
        if ($cite -notmatch '^(.*?):(\d+)(-\d+)?$') {
            $problems.Add("$docName : VERIFIED entry has no file:line citation -> '$claim' | '$cite'")
            continue
        }
        $path = $matches[1]
        $lineNo = [int]$matches[2]
        $resolved = Resolve-Cited $path $cwd
        if ($null -eq $resolved) {
            $problems.Add("$docName : cited file does not exist -> '$cite' (claim: $claim)")
            continue
        }
        # NOTE: do NOT use `Measure-Object -Line` here — it counts lines WITHIN
        # each string and returns 0 for an empty one, so any file containing
        # blank lines is under-counted and valid citations are falsely blocked.
        # (Found live: a 102-line settings.yaml with 4 blank lines counted 98.)
        $count = @(Get-Content -LiteralPath $resolved).Count
        if ($lineNo -lt 1 -or $lineNo -gt $count) {
            $problems.Add("$docName : cited line $lineNo is out of range (file has $count lines) -> '$cite'")
            continue
        }
        if (-not (Was-Read $resolved $toolBlob)) {
            $problems.Add("$docName : you cited '$cite' but this session's transcript contains no tool call that read that file. Read it, or downgrade the claim to UNVERIFIED.")
        }
    }
}

if ($problems.Count -eq 0) {
    Allow "audit-citation-gate: $($governed.Count) document(s) passed the citation check."
}

$msg = @()
$msg += "BLOCKED by audit-citation-gate. You may not end this turn yet."
$msg += ""
foreach ($p in $problems) { $msg += "  - $p" }
$msg += ""
$msg += "Fix by doing ONE of these for each item, then finish the turn:"
$msg += "  1. Actually read the source (Read/Bash), then cite it as: VERIFIED: <claim> | <path>:<line>"
$msg += "  2. Downgrade the sentence to: UNVERIFIED: <claim> - not checked"
$msg += ""
$msg += "An UNVERIFIED line is always accepted. Silence is not."
Block ($msg -join "`n")
