# claude-hook-kit

Manual: [docs/MANUAL.md](docs/MANUAL.md) · Landing page: [docs/index.html](docs/index.html)

Nine Claude Code hooks, made per-project: six ported from the hooks Scott ran before the kit, plus `double-check` (added Oct 14, 2026) and the two agent-build gates `read-ledger-gate` and `measure-gate` (added Oct 15, 2026).

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
- A relative path inside a config is relative to the project folder: the folder that holds `.claude/`.

So the kit is off everywhere by default. Nothing runs until a project opts in.

## The hooks

| Script | Event | What it does |
| --- | --- | --- |
| `hooks/inject-rules.mjs` | SessionStart, UserPromptSubmit | Adds a rules file to every prompt as context. |
| `hooks/deploy-gate.mjs` | PreToolUse Bash/PowerShell | Blocks a production deploy until a complete gate file exists for the exact commit. |
| `hooks/walk-brief-guard.mjs` | PreToolUse Write/Edit/Bash/PowerShell | Blocks a walk brief that bans publishing or is missing its required lines and sections. |
| `hooks/read-ledger-gate.mjs` | PreToolUse Write/Edit/Bash/PowerShell | Blocks any write to a code file until `.claude/READ-LEDGER.md` lists the upstream files that were read, with true line counts. |
| `hooks/db-write-guard.mjs` | PreToolUse Bash/PowerShell | Keeps a live database read-only: reads pass, writes need a fresh go file. |
| `hooks/no-idle.mjs` | Stop | Won't let a turn end with finished-but-unhandled workers, a stalled worker, or a running worker and no waiter. |
| `hooks/double-check.mjs` | Stop | Blocks the first stop of every turn with a check-it-twice list; the second stop goes through, so it never loops. |
| `hooks/measure-gate.mjs` | Stop | Won't let a turn end while the newest code file is newer than the newest measurement receipt. Gives up after `maxBlocks`, with a note. |
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
- `ownerName` — the owner's name in the go line of the block message, e.g. `"Scott"`. Default: `the owner`.
- `clientPattern`, `writePattern`, `filePattern`, `restorePattern`, `skipPattern`, `sqlArgPattern`, `portPattern` — optional overrides for the matching rules; the defaults match the current hook.
- `skillName`, `label`, `explanation` — the project's own words in the block message.

### `read-ledger-gate`

Scott, Oct 15 2026, after Siftwing: three agents in a row were told "read the upstream repos
first" and none did. The rule lived in a prompt. This hook makes it a gate.

```json
"read-ledger-gate": {
  "ledgerFile": ".claude/READ-LEDGER.md",
  "upstreamRoots": ["C:/Users/me/upstream/wagalo", "C:/Users/me/upstream/wigolo"],
  "mustMention": ["wagalo", "wigolo"],
  "minEntries": 10,
  "minLines": 2000,
  "label": "mysite"
}
```

- A `Write` or `Edit` to a code file, or a shell command that writes one (`>`, heredoc, `Set-Content`,
  `cp`, `git apply` ...), is blocked until the ledger passes. Docs, `.md`, `.txt`, `.json`, and anything
  under `.claude/` are never gated.
- `ledgerFile` - the ledger. One row per file read: `- <path> - <lines> lines`. A table row
  `| path | 312 |` or `path, 312` also works. Default `.claude/READ-LEDGER.md`.
- `upstreamRoots` - folders a relative row path is looked up in. Default: the project folder.
- `requireExisting` (default true) - every row must name a real file. `verifyLines` (default
  true) - the stated count must equal the file's real line count. A made-up row or a wrong count
  blocks, and the message names the row.
- `minEntries` (default 1), `minLines` (default 0) - how much must be read before code is written.
- `mustMention` - words that must appear in some row path, one per upstream project.
- `codePattern`, `exemptPattern`, `shellWritePattern`, `rowPattern` - regex overrides; the
  defaults are in the hook's header comment.
- `label`, `skillName`, `nextStep` - the project's own words in the block message.

### `measure-gate`

Scott, Oct 15 2026: "every step ends with a number you can read yourself." A turn may not end as
done while code is newer than the newest measurement receipt.

```json
"measure-gate": {
  "receiptDir": "work/receipts",
  "receiptPattern": "^receipt-.*\\.json$",
  "requireMatch": "\"found\":\\s*\\d+",
  "codeDirs": ["apps", "packages"],
  "measureCommand": "node work/measure/run.mjs",
  "maxBlocks": 3,
  "label": "mysite"
}
```

- `receiptFile`, or `receiptDir` + `receiptPattern` - where receipts live; the newest one counts.
  No location set means the hook is off.
- `requireMatch` - a regex the newest receipt must contain, so an empty file is not a receipt.
- `codeDirs` (default: the project folder), `codePattern`, `ignorePattern` (default skips
  `.git`, `node_modules`, `vendor`, `third-party`, `.claude`, `dist`, `build`), `maxDepth` (8).
- `maxBlocks` (default 3) - a Stop hook that blocks forever would burn tokens forever. After this
  many blocks in one turn it lets the turn end and prints a note that the receipt is still stale.
  The turn is identified by the last real user message in the transcript.
- `measureCommand` - shown in the message so the agent knows what to run.
- `label`, `hookName` - the project's own words in the block message.

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
- `logNames` — log file names, tried in order; the first one that exists is the worker's log. Default: `run.jsonl`, then `stream.jsonl`. (The original TownReporter hook read only `run.jsonl`; its example config sets that.)
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
- `logNames` — as in no-idle; the default is also `run.jsonl`, then `stream.jsonl`, matching the original wake hook.
- `lockFile` — only one sleeper at a time. Default `.rewake-lock.json` inside `runsDir`.
- `minutesFile` — a file holding a seconds value that overrides `minutes`, useful for tests. Default `.rewake-seconds` inside `runsDir`.
- `quietMinutes`, `handledFile`, `finishedFile`, `lookbackHours` — as in no-idle.
- `timeZone`, `timeZoneName`, `label`, `hookName`, `footer` — the project's own words in the wake message.
- `tokenModule` — optional path to a module exporting `tokenInfo(name)` and `tokenLine(info)`, for a per-worker token line.

### `double-check`

Scott, Oct 14 2026: "Check everything twice, read everything, do not skim, check the code."

```json
"double-check": {
  "quote": "Owner: \"Check everything twice, read everything, do not skim, check the code.\"",
  "label": "mysite"
}
```

- The first time a turn tries to end, the hook exits 2 with a checklist, so Claude makes one more pass. Claude Code marks the next stop with `stop_hook_active`, and the hook lets that one end the turn.
- `quote` — the owner's own words, shown above the list (optional).
- `checklist` — your own list of lines; the default is: re-read every changed file end to end, read the code each claim depends on, read every diff and output in full, name the proof for each fact, re-run the narrowest check, then start the reply with "Checked twice:".
- `minToolCalls` — only ask after a turn with at least this many tool calls (default 0 = every turn). If the transcript cannot be read, it asks anyway.
- `label` — the project name in the message.

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

## Install on a new machine

Node 18 or newer, and no npm packages — the installers use only Node's built-ins.

```
git clone <this repo> claude-hook-kit
cd claude-hook-kit
node install.mjs
```

That is the whole install. It:

1. Copies `hooks/` and `lib/` into `<settings folder>/hook-kit/`, so the clone can be moved or
   deleted afterward.
2. Merges the kit's hook entries into `<settings folder>/settings.json` — creating the file if
   it is missing — with the same events, matchers, timeouts and `asyncRewake` flag as the rest
   of this README describes. Every other hook and every other setting in that file is left
   alone.
3. Writes a backup first: `settings.json.bak-hookkit-<yyyyMMdd-HHmmss>` beside the settings
   file. It prints the path it used.

Re-running it is safe: it replaces its own entries rather than adding them again, so there are
never duplicates. It also recognizes entries left by an older local clone
(`claude-hook-kit/hooks/`) and replaces those.

The **settings folder** is, in order of precedence: `--config-dir <dir>`, the
`CLAUDE_CONFIG_DIR` environment variable, then `<home>/.claude`. On Windows that last one is
`%USERPROFILE%\.claude`.

```
node install.mjs --dry-run      # print the settings it would write, change nothing
node install.mjs --config-dir "D:/claude-config"
```

Then give a project its config:

```
node init-project.mjs <projectDir>                    # writes <projectDir>/.claude/hook-kit.json
node init-project.mjs <projectDir> --example townreporter
```

It copies one of the files in `examples/`, and refuses to overwrite an existing config unless
you pass `--force`.

### Turning a hook on or off

Edit that project's `.claude/hook-kit.json`. The keys are described above under **Config keys**;
`examples/minimal.hook-kit.json` is a small file to copy from. A hook with no section in the
config stays off. To switch the whole kit off for a folder tree, set `"enabled": false` at the
top of the file.

**The hooks do nothing in a folder with no `.claude/hook-kit.json`.** The kit is off
everywhere until a project asks for it.

### Uninstall

```
node uninstall.mjs                    # removes the kit's hook entries, keeps every other hook and setting
node uninstall.mjs --remove-files     # also deletes <settings folder>/hook-kit/
node uninstall.mjs --dry-run
```

It backs up first and removes only the entries the kit owns.

### Roll back

Restore the backup the installer printed:

```
copy "%USERPROFILE%\.claude\settings.json.bak-hookkit-20261014-131205" "%USERPROFILE%\.claude\settings.json"
```

(or `cp` on macOS and Linux.) That puts the settings back exactly as they were. Or run
`node uninstall.mjs`, which removes the kit's entries and leaves the rest.

### The snippet file

`install/settings-snippet.json` is the `hooks` block the installer merges, shown for reading.
It uses the placeholder `<HOOK_KIT_DIR>` where the installer puts the real path, so it names no
machine. It is generated from `lib/hook-entries.mjs` by `node tools/write-snippet.mjs`, the
same module `install.mjs` builds from, so the two cannot drift.

### About the examples

`examples/townreporter.hook-kit.json` is a real, working config from Scott's own machine, so it
names Scott's paths (`C:/Users/scott/...`) and Scott's project folders. That is fine: it is an
example to read and adapt, not something the installer copies by default.
`node init-project.mjs` uses `examples/minimal.hook-kit.json` unless you ask for the other one.

## Tests

```
node --test "tests/**/*.test.mjs"
```

94 tests. Each ported hook has a parity suite that runs the reference hook and the kit hook on the
same input and compares the exit code and the message, using temp folders for the gate files,
walk reports, findings list and runs folders. There are also scope tests: with no config every
hook exits 0 and says nothing, `"enabled": false` switches the kit off, a missing section
switches one hook off, the nearest config wins, and the event's `cwd` drives the lookup.

`tests/install.test.mjs` covers the installers — a fresh install writes the kit hooks, an
unrelated hook (`notify.ps1`) and unrelated settings survive, a second install adds no
duplicates, the old local-clone path is replaced, backups are written and never clobbered,
`--dry-run` writes nothing, uninstall removes only kit entries, and `init-project` writes and
refuses to overwrite. Every case uses a temp settings folder and never touches the real
`~/.claude`:

`npm test` runs the same command.

**Note on the runner.** The kit was checked with `node --test "tests/**/*.test.mjs"`. The
shorter `node --test tests/` does not work on this Node build (v24.21.0 on Windows): Node
resolves a bare directory argument as a module path and fails with `MODULE_NOT_FOUND` before
any test loads. Passing the glob, or running `node --test` from inside `tests/`, works.

## What is not a full port

- `lib/config.mjs` reads `cwd` from the hook event and falls back to the process working
  directory. That every event's stdin carries `cwd` is unverified; the fallback covers it.
- The original gate file's `ci` and `commit` checks are named in the messages, not hard-coded,
  so a project can rename them and still read a sensible block message.
