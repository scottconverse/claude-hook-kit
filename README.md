# claude-hook-kit

Six Claude Code hooks, made per-project.

The hooks Scott runs today live in `~/.claude/settings.json`, so they fire in **every** project.
Several of them are wired to one project: the rules injector reads one fixed `RULES.md`, the
watchdog hooks read one fixed `runs` folder, and the guards match TownReporter commands, paths
and port 5433 by name. This kit keeps the same behavior but moves every project-specific value
into a small config file, so a hook is active only where a project asks for it.

Read `reference/` for the six original hooks this was ported from. They are the spec.

## How a hook finds its project

Every hook reads the JSON Claude Code sends on stdin, takes `cwd` from it, and walks **up** the
folder tree to the nearest `.claude/hook-kit.json`. The nearest one wins.

- **No config file anywhere up the tree → the hook does nothing** (exit 0, no output).
- **`"enabled": false` at the top of a config → the whole kit is off for that folder tree.**
- **A hook with no section in the config → that one hook is off.**
- A relative path inside a config is relative to the config file's own folder.

So the kit is off everywhere by default. Nothing runs until a project opts in.

## The hooks

| Script | Event | What it does |
| --- | --- | --- |
| `hooks/inject-rules.mjs` | SessionStart, UserPromptSubmit | Adds a rules file to every prompt as context. |
| `hooks/deploy-gate.mjs` | PreToolUse Bash/PowerShell | Blocks a production deploy until a complete gate file exists for the exact commit. |
| `hooks/walk-brief-guard.mjs` | PreToolUse Write/Edit/Bash/PowerShell | Blocks a walk brief that bans publishing or is missing its required lines and sections. |
| `hooks/db-write-guard.mjs` | PreToolUse Bash/PowerShell | Keeps a live database read-only: reads pass, writes need a fresh go file. |
| `hooks/no-idle.mjs` | Stop | Won't let a turn end with finished-but-unhandled workers, a stalled worker, or a running worker and no waiter. |
| `hooks/wake.mjs` | Stop (asyncRewake) | Sleeps, then exits 2 so Claude wakes up with a worker status report. |

## Config keys

One example per key. Full working files are in `examples/`.

### `inject-rules`

```json
"inject-rules": {
  "rulesFile": ".claude/RULES.md",
  "heading": "PROJECT RULES (obey every line, no exceptions):"
}
```

- `rulesFile` — the rules text. If it is missing, nothing is injected.
- `heading` — the line put in front of the text.

### `deploy-gate`

```json
"deploy-gate": {
  "commandPattern": "deploy-production[.]ps1|promote[.]ps1",
  "skipPatterns": ["<<|Set-Content|Add-Content|Out-File|\\becho\\b|Select-String", "-Rollback\\b|\\brollback\\b|-WhatIf\\b"],
  "repoDir": "C:/dev/mysite",
  "shaFrom": "origin/main",
  "gatesDir": "C:/dev/notes/gates",
  "requiredKeys": [
    { "key": "devServerRun", "test": "length", "min": 8, "message": "devServerRun: what ran on :3100 and the result" },
    { "key": "ci", "test": "ieq", "expected": "PASS", "message": "ci must be \"PASS\"" }
  ],
  "mustEqual": [
    { "key": "testServerCommit", "other": "commit", "message": "testServerCommit must equal the sha" }
  ],
  "reportKey": "publishWalkReport",
  "reportMustContain": "^PUBLISH-WALK:\\s*PASS\\s*$",
  "findingsFile": "C:/dev/notes/OPEN-FINDINGS.md",
  "openPattern": "^\\|\\s*([A-Z][A-Z0-9-]*\\d)\\s*\\|\\s*OPEN\\b[^|]*\\|\\s*([^|]*)\\|"
}
```

- `commandPattern` — regex string for a deploy command. No match, the hook stays out of the way.
- `skipPatterns` — regex strings; a match means this is a note, a rollback, or a read-only call, not a deploy.
- `repoDir` — the git repo the commit comes from.
- `shaFrom` — `"origin/main"` (fetch `origin`, then read `origin/main`, the same method as today) or `"HEAD"`.
- `gatesDir` — folder of `<sha>.json` gate files.
- `requiredKeys` — field checks on the gate file. `test` is one of `truthy` (the default), `eq`, `neq`, `ieq`, `length` (with `min`), `match` (with `pattern`). `message` is what the block says.
- `mustEqual` — this key must equal another key, e.g. the Test server ran the same build.
- `reportKey` — the gate field holding the path to a walk report.
- `reportMustContain` — regex string that report must match.
- `findingsFile` / `openPattern` — optional findings list; a row still `OPEN` blocks the deploy.
- `textOnly` — optional smaller rule set for a text-only push. Set `textOnlyKey` if the flag is named something else.
- `skillName`, `label`, `pathLine`, `nextStep` — the project's own words in the block message.

### `walk-brief-guard`

```json
"walk-brief-guard": {
  "pathPattern": "briefs[\\\\/]+walk-[^\\\\/\\s\"']+\\.md",
  "heredocPattern": "<<",
  "bannedPatterns": [{ "pattern": "do not publish", "message": "it bans publishing." }],
  "requiredLines": [{ "pattern": "PUBLISH-WALK", "onlyFullBody": true, "message": "no closing line." }],
  "requiredSections": [{ "pattern": "^EVERY DOOR:", "onlyFullBody": true, "message": "no EVERY DOOR: section." }]
}
```

- `pathPattern` — regex string matching a walk brief path. Matched against the file path for Write/Edit, and against the command text for shell writes.
- `heredocPattern` — regex string that marks a shell command as writing a whole file, so its body can be checked.
- `bannedPatterns` — regex strings that block, each with its own `message`.
- `requiredLines` — regex strings the text must contain.
- `requiredSections` — the same, checked line by line, for things like a heading.
- `onlyFullBody` — check this one only when the whole file body is visible (a Write or a heredoc), never on a small Edit.
- `skillName`, `footer` — the project's own words in the block message.

### `db-write-guard`

```json
"db-write-guard": {
  "port": 5433,
  "databases": ["townreporter"],
  "okFile": "C:/dev/notes/live-db-write-ok.txt",
  "okMinutes": 30
}
```

- `port` — the live database's port. A different port is left alone.
- `databases` — names that mean "the live one". A test or dev database on the same port is left alone. No database named at all counts as aimed at the live one.
- `okFile` — a file whose modification time is the go-ahead. Missing or older than `okMinutes` means no go.
- `okMinutes` — how long a go lasts.
- `clientPattern`, `writePattern`, `filePattern`, `restorePattern`, `skipPattern`, `sqlArgPattern`, `portPattern` — optional overrides for the matching rules; the defaults match the current hook.
- `skillName`, `label`, `explanation` — the project's own words in the block message.

### `no-idle`

```json
"no-idle": {
  "runsDir": "C:/dev/notes/runs",
  "logNames": ["run.jsonl"],
  "quietMinutes": 15,
  "handledFile": "handled.txt",
  "waiterHeartbeat": "C:/dev/notes/runs/.waiter-heartbeat",
  "waiterFreshMinutes": 3
}
```

- `runsDir` — the folder of worker folders. Missing folder means nothing to check.
- `logNames` — log file names, tried in order; the first one that exists is the worker's log. The current hook reads only `run.jsonl`.
- `quietMinutes` — a running worker whose log has been quiet this long counts as stuck.
- `handledFile` / `finishedFile` — the marker file names inside each worker folder.
- `lookbackHours` — ignore workers whose log is older than this. Default 48.
- `waiterHeartbeat` / `waiterFreshMinutes` — the file a live waiter keeps touching. If no waiter is alive while workers run, the turn is blocked.
- `waiterCheck` / `waiterCheckArgs` — optional alternative: a command that exits 0 when a waiter is alive. It is spawned directly, with no shell, so it fails closed if it cannot run.
- `handledHint`, `stuckHint`, `waiterHint`, `header`, `hookName` — the project's own words in the block message.

### `wake`

```json
"wake": {
  "minutes": 20,
  "runsDir": "C:/dev/notes/runs",
  "logNames": ["run.jsonl", "stream.jsonl"],
  "label": "mysite"
}
```

- `minutes` — how long to sleep before waking Claude.
- `runsDir` — the same worker folder the no-idle hook reads.
- `logNames` — like no-idle, but the default here is both `run.jsonl` and `stream.jsonl`, matching the current wake hook.
- `lockFile` — only one sleeper at a time. Default `.rewake-lock.json` inside `runsDir`.
- `minutesFile` — a file holding a seconds value that overrides `minutes`, useful for tests. Default `.rewake-seconds` inside `runsDir`.
- `quietMinutes`, `handledFile`, `finishedFile`, `lookbackHours` — as in no-idle.
- `timeZone`, `timeZoneName`, `label`, `hookName`, `footer` — the project's own words in the wake message.
- `tokenModule` — optional path to a module exporting `tokenInfo(name)` and `tokenLine(info)`, for a per-worker token line.

## Turning the kit on or off

**On, for one project.** Put a `.claude/hook-kit.json` in the project's root. Start from
`examples/minimal.hook-kit.json`. Only the hooks you write a section for will run.

**Off, for one folder tree.**

```json
{ "enabled": false }
```

**Off, for one hook.** Delete that hook's section, or set `"enabled": false` inside it.

**Off everywhere.** Remove the `hooks` block from `~/.claude/settings.json`. With no hook
registered nothing runs, and `reference/` still holds the originals.

## Install

1. Keep the kit where it is, or move it, and note the real path — the commands below are
   absolute.
2. Copy the values from `examples/townreporter.hook-kit.json` into a config. To reproduce
   today's behavior exactly, put it at `C:/Users/scott/Desktop/Code/.claude/hook-kit.json`,
   which covers both TownReporter repos and the oversight repo.
3. **Back up the settings first:**

   ```
   copy "%USERPROFILE%\.claude\settings.json" "%USERPROFILE%\.claude\settings.json.bak"
   ```

4. Replace the `hooks` block in `~/.claude/settings.json` with the contents of
   `install/settings-snippet.json`. That file has the same events, matchers, `asyncRewake` flag
   and timeouts as today, pointed at this kit's scripts. Merge it into whatever else is already
   in that file rather than replacing the whole file.
5. Restart Claude Code, or run `/hooks` to reload.

## Roll back

```
copy "%USERPROFILE%\.claude\settings.json.bak" "%USERPROFILE%\.claude\settings.json"
```

That restores the settings exactly as they were before the install. The kit's own files are
untouched by an install, so a rollback needs nothing else.

## Tests

```
node --test "tests/**/*.test.mjs"
```

61 tests. Each hook has a parity suite that runs the reference hook and the kit hook on the
same input and compares the exit code and the message, using temp folders for the gate files,
walk reports, findings list and runs folders. There are also scope tests: with no config every
hook exits 0 and says nothing, `"enabled": false` switches the kit off, a missing section
switches one hook off, the nearest config wins, and the event's `cwd` drives the lookup.

`npm test` runs the same command.

**Note on the runner.** The kit was checked with `node --test "tests/**/*.test.mjs"`. The
shorter `node --test tests/` does not work on this Node build (v24.21.0 on Windows): Node
resolves a bare directory argument as a module path and fails with `MODULE_NOT_FOUND` before
any test loads. Passing the glob, or running `node --test` from inside `tests/`, works.

## What is not a full port

- `lib/config.mjs` reads `cwd` from the hook event and falls back to the process working
  directory. That every event's stdin carries `cwd` is unverified; the fallback covers it.
- The deploy gate compares the gate file's `commit` to the origin sha through two `mustEqual`
  entries (`commit == originSha`, `testServerCommit == commit`) rather than one direct compare
  against the sha. The example config writes `originSha` alongside `commit`; a gate file that
  omits `originSha` is blocked where the original would have passed.
- The original gate file's `ci` and `commit` checks are named in the messages, not hard-coded,
  so a project can rename them and still read a sensible block message.
