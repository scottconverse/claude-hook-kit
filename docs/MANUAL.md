# claude-hook-kit manual

This manual is for a developer who uses Claude Code and has not seen this kit before. It
covers what the kit does, how to install it, how to turn on a hook in a project, what each of
the thirteen hooks checks, and how to roll back.

Contents: [What the kit is](#1-what-the-kit-is) · [Requirements](#2-requirements) ·
[Install](#3-install) · [Quick start](#4-quick-start-turn-on-double-check) ·
[How a hook finds its config](#5-how-a-hook-finds-its-config) · [The thirteen hooks](#6-the-thirteen-hooks) ·
[Exit codes](#7-exit-codes) · [Uninstall and roll back](#8-uninstall-and-roll-back) ·
[Testing](#9-testing) · [Troubleshooting](#10-troubleshooting) ·
[Config key reference](#11-config-key-reference)

## 1. What the kit is

The kit is thirteen hook scripts for Claude Code, plus an installer, a doctor that checks the install, and a per-project config file.
The hooks block a few common mistakes: a deploy with no gate, a write to a live database, a walk
brief that skips a required step, a turn that ends too early, code written before the upstream code
was read, and a turn that ends "done" with no fresh measurement. The kit is off everywhere until
a project opts in. A project opts in by adding `.claude/hook-kit.json`, and the hooks do nothing
in a folder that has no such file.

## 2. Requirements

- Node.js 18 or newer, as the README states. The kit was run and tested on Node v24.21.0 on
  Windows. It has not been run on Node 18 here.
- No npm packages. The installers and the hooks use only Node's built-in modules.
- Claude Code, with its hook system.

## 3. Install

Clone the repo, then run the installer from the repo folder:

```
git clone <this repo> claude-hook-kit
cd claude-hook-kit
node install.mjs
```

The installer does four things:

1. Copies `hooks/` and `lib/` into `<settings folder>/hook-kit/`. It overwrites older copies.
2. Backs up `settings.json` to `settings.json.bak-hookkit-<yyyyMMdd-HHmmss>` beside it, if the
   file exists. If that name is taken, it adds `-2`, `-3` and so on, so a backup is never
   overwritten. It prints the path it used.
3. Merges the kit's fifteen hook entries (thirteen hooks; `inject-rules` and `ran-before-done` each have two events) into `settings.json`, creating the file if it is missing.
   Every other hook and every other setting in the file stays as it was.
4. Prints what it changed.

If `settings.json` is not valid JSON, the installer stops with an error before it writes
anything.

Re-running the installer is safe. It replaces the kit's own entries, so there are no duplicates.
It also replaces entries left by an older local clone (`claude-hook-kit/hooks/`).

The **settings folder** is chosen in this order:

1. `--config-dir <dir>`
2. the `CLAUDE_CONFIG_DIR` environment variable
3. `<home>/.claude`. On Windows, that is `%USERPROFILE%\.claude`.

Options:

- `--dry-run` prints the new `settings.json` and the counts. It writes nothing and copies nothing.
- `--config-dir <dir>` (or `--config-dir=<dir>`) uses that folder as the settings folder.
- `-h` or `--help` prints the usage line.

```
node install.mjs --dry-run
node install.mjs --config-dir "D:/claude-config"
```

### 3.1 Check the install

```
node doctor.mjs
node doctor.mjs --project <folder>
node doctor.mjs --json
```

`doctor.mjs` is read-only. It is a port of the hook-liveness check from `scottconverse/fleet-smoke`
(`reference/fleet-smoke-hook_liveness.py`), extended with what the kit knows about itself. Rows:

- `settings`: `<settings folder>/settings.json` exists and parses.
- `script`: every registered hook command, kit or not, names a script file that exists. A command whose
  script path cannot be recognized is `PARTIAL`.
- `registered`: every kit hook is registered under every event `lib/hook-entries.mjs` says it needs.
- `liveness`: each installed kit hook is run once with a no-config event in an empty temp folder and must
  exit 0 and print nothing. If the temp folder sits under a tree that has a config, the row is `PARTIAL`.
- `project` (with `--project <folder>`): `.claude/hook-kit.json` parses; a section that matches no hook is
  named; path keys such as `rulesFile`, `ledgerFile`, `gatesDir`, `findingsFile` and `upstreamRoots` must
  resolve (keys the hooks create themselves, such as `receiptDir`, `stateDir` and `gateDir`, are noted,
  not failed); `enabled: false` is reported.

Exit 1 when any row is `FAIL`. `--config-dir` chooses the settings folder as for the installer.

## 4. Quick start: turn on double-check

This walk-through turns on one hook, `double-check`, in one project.

1. Install the kit (section 3). Skip this step if it is already installed.
2. Write a config file for the project:

   ```
   node init-project.mjs <projectDir>
   ```

   This writes `<projectDir>/.claude/hook-kit.json`. It copies `examples/minimal.hook-kit.json`,
   which has four hook sections: `inject-rules`, `db-write-guard`, `double-check` and `wake`.
   The script refuses to overwrite an existing file unless you pass `--force`. Use
   `--example townreporter` to copy the other example, `examples/townreporter.hook-kit.json`,
   instead of the minimal one.

3. Open `<projectDir>/.claude/hook-kit.json`. Delete the `inject-rules`, `db-write-guard` and
   `wake` sections. Delete the `quote` line in the `double-check` section too. The file should
   now look like this:

   ```json
   {
     "enabled": true,

     "double-check": {
       "label": "my project"
     }
   }
   ```

4. Start Claude Code in that project and let a turn run. When Claude tries to end the turn, the
   hook blocks the end once and sends Claude this message:

   ```
   DOUBLE-CHECK (my project), hook double-check.mjs. Before this turn ends, check everything a second time.
   1. Re-read every file you wrote or changed in this turn, end to end. Not a grep, not your memory of it.
   2. Read the code every claim depends on. A worker's report, a commit message or a test name is not the code.
   3. Read every diff and every tool output in full. Do not skim, do not stop at the first line that looks right.
   4. For each fact in your answer, name the tool output that proves it. Anything you did not check: check it now, or call it unverified.
   5. Re-run the narrowest check for anything that changed (test, typecheck, the screen itself).
   6. Fix what is wrong, then end the turn. Start your reply with "Checked twice:" and say what you re-checked.
   ```

   Claude gets one more pass. When the turn tries to end again, the hook lets it through, so the
   check cannot loop.

## 5. How a hook finds its config

- The hook reads `cwd` from the event's input. If the input has no `cwd`, the hook uses the
  folder it was started in. The code notes that it has not verified that every event sends `cwd`.
- The hook walks up from that folder, one parent at a time, looking for
  `.claude/hook-kit.json`. The first file it finds is used. The nearest config wins.
- If the nearest file is not valid JSON, the kit is off for that folder tree. The hook does not
  look at the parent folders.
- If no config is found, every hook exits 0 and prints nothing.
- `"enabled": false` at the top of the file switches the whole kit off for that tree.
- A hook with no section in the file is off. A section with `"enabled": false` is off too.
- Relative paths in the config resolve from the project folder. That is the folder that holds
  the `.claude` folder. Absolute paths are used as written.
- A regex string that does not compile turns off the check it belongs to. The hook gives no
  message.

## 6. The thirteen hooks

| Hook | Event | Matcher | Timeout | What it can do |
|---|---|---|---|---|
| `inject-rules` | `SessionStart`, `UserPromptSubmit` | none | 10 | Adds a rules file to Claude's context. Never blocks. |
| `deploy-gate` | `PreToolUse` | `Bash\|PowerShell` | 30 | Blocks a tool call that deploys until a gate file passes. |
| `walk-brief-guard` | `PreToolUse` | `Write\|Edit\|Bash\|PowerShell` | 10 | Blocks a walk brief that breaks a required rule. |
| `read-ledger-gate` | `PreToolUse` | `Write\|Edit\|Bash\|PowerShell` | 15 | Blocks a write to code until the read ledger is complete and true. |
| `db-write-guard` | `PreToolUse` | `Bash\|PowerShell` | 10 | Blocks a command that can write to a live database. |
| `command-gate` | `PreToolUse` | `Bash\|PowerShell` | 10 | Blocks a forbidden shell verb (default: kill by name or pattern) and an untagged oversized commit. |
| `ran-before-done` | `PostToolUse`, `Stop` | `Write\|Edit\|MultiEdit\|NotebookEdit\|Bash\|PowerShell` (PostToolUse) | 10 | Blocks the end of a turn once if runnable code was edited and nothing ever ran. |
| `no-idle` | `Stop` | none | 30 | Blocks the end of a turn while workers are unattended. |
| `double-check` | `Stop` | none | 10 | Blocks the end of a turn once, so Claude checks its work. |
| `measure-gate` | `Stop` | none | 30 | Blocks the end of a turn while code is newer than the newest receipt. |
| `citation-gate` | `Stop` | none | 30 | Blocks the end of a turn while an audit/review/handoff document cites files the session never read. |
| `sprint-gate` | `Stop` | none | 15 | Blocks the end of a turn while a sprint is armed; only a human passphrase disarms. |
| `wake` | `Stop` (`asyncRewake: true`) | none | 1800 | After a delay, wakes Claude with worker status. |

The events, matchers and timeouts come from `lib/hook-entries.mjs`. The matcher is the list of
tool names the hook runs on.

Each section below lists the config keys with their defaults. Every default comes from the hook
code. Each section also has a small example. The examples are for reading and adapting, not
complete configs.

### 6.1 inject-rules

Puts a project's rules file into Claude's context at the start of a session and on every prompt.

- Events: `SessionStart` and `UserPromptSubmit`. Matcher: none. Timeout: 10.
- `rulesFile`: path to the rules text. No default. If the file is missing or cannot be read, the
  hook injects nothing.
- `heading`: the line placed before the rules text. Default:
  `PROJECT RULES (obey every line, no exceptions):`

```json
"inject-rules": {
  "rulesFile": ".claude/RULES.md",
  "heading": "PROJECT RULES (obey every line, no exceptions):"
}
```

The hook prints JSON that adds the heading and the file text as extra context. It never blocks.
Turn it off by deleting the section or adding `"enabled": false` inside it.

### 6.2 deploy-gate

Blocks a deploy command until a gate file for the exact commit exists and passes its checks.

- Events: `PreToolUse`. Matcher: `Bash|PowerShell`. Timeout: 30.
- The hook runs only when the command matches `commandPattern` and no `skipPatterns` entry
  matches. A skip pattern marks a note, an edit or a rollback, which is not a deploy.
- It reads the commit. With `shaFrom` set to `origin/main` (the default), it runs
  `git fetch origin --quiet` and then reads `origin/main`. With `"HEAD"`, it reads the local
  HEAD. If it cannot read the commit, it blocks the deploy.
- It reads the gate file `<gatesDir>/<full commit sha>.json`. A missing file, or a file that is
  not valid JSON, blocks the deploy.
- If the gate file sets `textOnly` to `true` (the key is set by `textOnlyKey`), and a `textOnly`
  block is configured, only the text-only checks run. They are: the `textOnly.requiredKeys`
  checks, a non-empty list of files (`textOnly.filesKey`), and a check that the diff from the
  live HEAD commit to `<sha>` touches only files in that list.
- Otherwise the hook runs `requiredKeys`, `mustEqual`, the report check and the findings check.

Config keys:

- `commandPattern`: regex, case-insensitive. No default. Missing or bad, the hook does nothing.
- `skipPatterns`: list of regex, case-insensitive. Default: none. A match means "not a deploy".
- `repoDir`: path to the git repo that holds the commit. No default.
- `shaFrom`: `"origin/main"` or `"HEAD"`. Default: `"origin/main"`.
- `gatesDir`: path to the folder of `<sha>.json` files. No default.
- `skillName`: text. Default: none. Shown first in the block message.
- `label`: text. Default: `this project`. Used when the commit cannot be read.
- `pathLine`: text. Default: none. An extra line in the block message.
- `nextStep`: text. Default: `Do the missing tier, then write the gate file.`
- `requiredKeys`: list. Each entry has `key`, and optionally `test`, `expected`, `min`,
  `pattern` and `message`. `test` defaults to `truthy`. The other modes are `eq`, `neq`, `ieq`,
  `length` (uses `min`, default 1) and `match` (uses `pattern`). `message` defaults to the key name.
- `mustEqual`: list. Each entry has `key` and `other`, and optionally `message`. The default
  message is `<key> must equal <other>`.
- `reportKey`: the gate field that holds the path to a walk report. Default: none. The report
  file must exist.
- `reportMessage`: default `<reportKey>: path to an existing walk report`.
- `reportMustContain`: regex, multiline flag. Default: none, so the content is not checked.
- `reportMustContainMessage`: default `walk report must contain the line` followed by the regex
  as a JSON string.
- `findingsFile`: path to a findings list. Default: none. A missing file blocks the deploy.
- `openPattern`: regex with the global and multiline flags. Matches an OPEN finding row. Groups 1
  and 2 appear in the message. Default: none, so only the file's existence is checked.
- `textOnlyKey`: the gate field that turns on text-only mode. Default: `textOnly`.
- `textOnly`: object. Default: none. Keys: `requiredKeys` (same shape as above, with `test` set
  to `eq` or truthy), `filesKey` (default `textFiles`), `filesMessage` (default
  `textFiles: the files this text change touches`) and `extraMessage` (default
  `not text-only; these files also changed: `).

```json
"deploy-gate": {
  "skillName": "my-release-skill",
  "commandPattern": "\\bdeploy\\b",
  "repoDir": ".",
  "gatesDir": ".claude/gates",
  "label": "my app",
  "requiredKeys": [
    { "key": "tested", "message": "tested: a full test run for this commit" }
  ]
}
```

A matching gate file is `.claude/gates/<full commit sha>.json`:

```json
{ "tested": true }
```

The block message looks like this:

```
BLOCKED by my-release-skill. Production deploy of origin/main 3f9c2a1b needs gate file:
  C:/work/my-app/.claude/gates/<full commit sha>.json
Missing or wrong:
  - tested: a full test run for this commit
Do the missing tier, then write the gate file.
```

Turn it off by deleting the section.

### 6.3 walk-brief-guard

Blocks writing a walk brief that breaks a required rule. A walk brief is a file whose path matches
`pathPattern`.

- Events: `PreToolUse`. Matcher: `Write|Edit|Bash|PowerShell`. Timeout: 10.
- For `Write` and `Edit`, the hook matches `pathPattern` against the file path. For `Bash` and
  `PowerShell`, it matches the command text.
- The text it checks is the file `content` for `Write`, `new_string` for `Edit`, and the command
  for `Bash` and `PowerShell`.
- A `Write`, or a command that matches `heredocPattern`, counts as a full file body. Checks with
  `onlyFullBody` run only on a full file body.

Config keys:

- `pathPattern`: regex, case-insensitive. No default. Missing or bad, the hook does nothing.
- `heredocPattern`: regex. Default: none.
- `bannedPatterns`: list of `{ pattern, message }`. Regex, case-insensitive. A match blocks.
  `message` defaults to `banned pattern: <pattern>`.
- `requiredLines`: list of `{ pattern, message, onlyFullBody }`. Regex with no flags. The text
  must match it. `message` defaults to `missing <pattern>`. `onlyFullBody` defaults to false.
- `requiredSections`: same shape as `requiredLines`. Its `message` defaults to
  `missing section <pattern>`. The regex uses the multiline flag, so `^` matches the start of a
  line. The hook does not add the `^`, so write it in the pattern yourself.
- `skillName`: text. Default: none. Prefix on the block message.
- `footer`: text. Default: `Every walk brief must tell the walker how to finish the walk.`

```json
"walk-brief-guard": {
  "pathPattern": "walk-brief",
  "heredocPattern": "cat\\s*>|Set-Content",
  "skillName": "my-release-skill",
  "bannedPatterns": [
    { "pattern": "do not publish", "message": "the brief must not say do not publish" }
  ],
  "requiredLines": [
    { "pattern": "Publish", "message": "the brief must tell the walker to press Publish", "onlyFullBody": true }
  ]
}
```

The block message looks like this:

```
BLOCKED by my-release-skill: this walk brief is not allowed:
  - the brief must tell the walker to press Publish
Every walk brief must tell the walker how to finish the walk.
```

Turn it off by deleting the section.

### 6.4 db-write-guard

Treats the live database as read-only for Claude. A command that can write to it is blocked
unless a fresh go file exists. Reads are always allowed.

- Events: `PreToolUse`. Matcher: `Bash|PowerShell`. Timeout: 10.
- The hook checks these steps in order. A command that fails any step is allowed.
  1. The command matches `clientPattern`.
  2. The command does not match `skipPattern`. A skip match is allowed unless `sqlArgPattern`
     also matches.
  3. The command names the live port, by `portPattern`.
  4. If the command names a database (with `-d`, `--dbname`, or a URL path), one of the names is
     in `databases`. A command that names no database counts as the live one.
  5. The command writes. That means the SQL text (from `-c`, `--command`, or piped in) contains a
     write word, or the command reads a SQL file (`-f`, `--file`, or `< file.sql`), or it matches
     `restorePattern`. A plain `SELECT` is allowed.
  6. The go file `okFile` was modified within `okMinutes`. If it was, the command is allowed.

Config keys:

- `port`: number, the live database's port. No default. Without it, the port check never matches.
- `databases`: list of names, compared without case. Default: none.
- `clientPattern`: regex, case-insensitive. No default. Missing or bad, the hook does nothing.
- `skipPattern`: regex, case-insensitive. Default: `<<|Set-Content|Add-Content|Out-File|\bgrep\b|Select-String`
- `sqlArgPattern`: regex, case-insensitive. Default: `-c\s|-f\s|--command|--file`
- `portPattern`: regex, case-insensitive. Default: `(-p|--port)[\s=]+<port>\b|:<port>\b|PGPORT=<port>`, with
  `<port>` replaced by the `port` value.
- `writePattern`: regex, case-insensitive. Default:
  `\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|vacuum|reindex|cluster|copy)\b`
- `filePattern`: regex, case-insensitive. Default: `(^|\s)(-f|--file)[\s=]`
- `restorePattern`: regex, case-insensitive. No default. A match counts as a write.
- `okFile`: path to the go file. No default. Only the file's modified time is checked, not its
  contents. A missing file means there is no go.
- `okMinutes`: number. Default: 30.
- `label`: text. Default: `the live database`.
- `explanation`: text. Default: `The live database is read-only for me.`
- `ownerName`: text. Default: `the owner`. The name in the go line, for example `Scott`. Without it, the line says `If the owner has said go in chat`.
- `skillName`: text. Default: none. Prefix on the block message.

```json
"db-write-guard": {
  "port": 5432,
  "databases": ["myapp"],
  "clientPattern": "\\bpsql(\\.exe)?\\b|\\bpg_restore\\b|\\bdropdb\\b|\\bcreatedb\\b",
  "restorePattern": "\\bpg_restore\\b|\\bdropdb\\b|\\bcreatedb\\b",
  "okFile": ".claude/live-db-write-ok.txt",
  "okMinutes": 30,
  "label": "the live database",
  "explanation": "The live database is read-only for me; go through the tested path."
}
```

The block message looks like this:

```
BLOCKED by my-release-skill: this command can WRITE to the live database (port 5432, database myapp).
The live database is read-only for me; go through the tested path.
If the owner has said go in chat for this exact change: take a backup, announce the time, then create .claude/live-db-write-ok.txt with the script name and the time in it (valid 30 minutes), and run the command again.
```

The wording of the last line is fixed in the hook, except the owner's name. The config fills in the
`okFile` path, `okMinutes`, and `ownerName` (set `"ownerName": "Scott"` and the line says
`If Scott has said go`).

Turn it off by deleting the section.

### 6.5 no-idle

Stops Claude from ending a turn while the project's workers are unattended. A worker is a folder
inside `runsDir`. The hook blocks the end of the turn when:

1. A worker has finished, and nothing was recorded for it. "Finished" means the `finishedFile`
   exists, or the last line of the worker's log is a `"type":"turn.completed"` event. "Recorded"
   means the `handledFile` exists.
2. A worker looks stuck. Its log has not changed for `quietMinutes` or more.
3. A worker is running, and no waiter is alive. This check runs only when `waiterHeartbeat` or
   `waiterCheck` is set.

Only logs changed within `lookbackHours` are checked. A worker's log is the first file from
`logNames` that exists in its folder.

- Events: `Stop`. Matcher: none. Timeout: 30.

Config keys:

- `runsDir`: path to the folder of worker folders. No default. Without it, the hook does nothing.
- `logNames`: list. Default: `["run.jsonl", "stream.jsonl"]`.
- `handledFile`: default `handled.txt`.
- `finishedFile`: default `finished.txt`.
- `quietMinutes`: number. Default: 15.
- `lookbackHours`: number. Default: 48.
- `handledHint`: text. Default: none. When it is unset, the hook uses this line: `Act now: START the
  next step, then write <handledFile> in the worker's folder with one line: the time, and the next
  step you started.`
- `stuckHint`: text. Default: `Diagnose and relaunch, or mark it handled on purpose.`
- `waiterHeartbeat`: path to a file that a live waiter keeps touching. Default: none. A waiter is
  alive when this file changed within `waiterFreshMinutes`.
- `waiterFreshMinutes`: number. Default: 3.
- `waiterCheck`: a command that exits 0 when a waiter is alive. Default: none. It runs directly,
  with no shell. A command that fails counts as no waiter.
- `waiterCheckArgs`: list of strings passed to `waiterCheck`. Default: none.
- `waiterHint`: text. Default: none.
- `header`: text. Default: `you may not end this turn yet.`
- `hookName`: text. Default: `no-idle`.

```json
"no-idle": {
  "runsDir": ".claude/runs",
  "logNames": ["run.jsonl"],
  "quietMinutes": 15
}
```

The block message looks like this:

```
BLOCKED by the no-idle hook (no-idle): you may not end this turn yet.
- These workers FINISHED and nothing was done with them: worker-a.
  Act now: START the next step, then write handled.txt in the worker's folder with one line: the time, and the next step you started.
```

Turn it off by deleting the section.

### 6.6 double-check

Makes Claude check its work a second time before a turn ends.

- Events: `Stop`. Matcher: none. Timeout: 10.
- The first time a turn tries to end, the hook blocks the end and sends the checklist (section 4).
- When the next `Stop` arrives with `stop_hook_active` set to true, the hook lets the turn end.
- If `minToolCalls` is above 0, the hook counts the tool calls since the last real user message,
  read from the transcript. If the count is below the minimum, the turn ends. If the transcript
  cannot be read, the hook asks anyway.

Config keys:

- `quote`: text. Default: none. Shown first, before the checklist.
- `checklist`: list of lines. Default: the six lines below. An empty list also uses the default.
- `minToolCalls`: number. Default: 0. The hook asks after every turn, even a plain answer.
- `label`: text. Default: none. Adds `(label)` to the header.

The default checklist:

1. Re-read every file you wrote or changed in this turn, end to end. Not a grep, not your memory of it.
2. Read the code every claim depends on. A worker's report, a commit message or a test name is not the code.
3. Read every diff and every tool output in full. Do not skim, do not stop at the first line that looks right.
4. For each fact in your answer, name the tool output that proves it. Anything you did not check: check it now, or call it unverified.
5. Re-run the narrowest check for anything that changed (test, typecheck, the screen itself).
6. Fix what is wrong, then end the turn. Start your reply with "Checked twice:" and say what you re-checked.

```json
"double-check": {
  "label": "my project",
  "minToolCalls": 3
}
```

Turn it off by deleting the section.

### 6.7 wake

Starts a timer each time a turn ends. After the delay, the timer wakes Claude with the status of
each worker.

- Events: `Stop`, with `asyncRewake: true`, so the timer runs in the background and an exit 2
  wakes Claude. Matcher: none. Timeout: 1800.
- After the delay, the hook always wakes Claude. It does this even when no worker needs attention.
  The message then says `No unhandled workers.`
- Only one timer runs at a time. A lock file in `runsDir` (`lockFile`) records the timer's process
  ID and start time. A new timer exits at once while an older timer is alive and started less
  than the delay plus 2 minutes ago.
- The delay is `minutes`. A positive number in `minutesFile` replaces it. That number is in
  seconds, not minutes. The message header still prints the `minutes` value.
- Each worker gets a status line: `FINISHED-NOT-HANDLED` (finished, with no `handledFile`),
  `STALLED` (quiet for `quietMinutes` or more), or `RUNNING`. A worker counts as finished when its
  `finishedFile` exists, or its log ends with a `turn.completed` or `result` entry. Workers with a
  `handledFile`, with no log file, or with no change within `lookbackHours`, are left out.

Config keys:

- `minutes`: number. Default: 20.
- `runsDir`: path to the folder of worker folders. No default. Without it, the hook does nothing.
- `minutesFile`: path. Default: `<runsDir>/.rewake-seconds`.
- `lockFile`: file name inside `runsDir`. Default: `.rewake-lock.json`.
- `logNames`: list. Default: `["run.jsonl", "stream.jsonl"]`.
- `handledFile`: default `handled.txt`.
- `finishedFile`: default `finished.txt`.
- `quietMinutes`: number. Default: 15.
- `lookbackHours`: number. Default: 48.
- `label`: text. Default: the name of the project folder.
- `hookName`: text. Default: `wake`.
- `timeZone`: an IANA time zone name, used to print the time. Default: `America/Denver`.
- `timeZoneName`: text printed after the time. Default: `Mountain`.
- `footer`: text. Default: `Check every worker and server; start the next step for anything finished; relaunch anything stalled.`
- `tokenModule`: path to a JavaScript module that exports `tokenInfo(name)` and `tokenLine(info)`.
  Default: none. When set, each worker gets an extra `tokens:` line.

```json
"wake": {
  "minutes": 20,
  "runsDir": ".claude/runs",
  "logNames": ["run.jsonl"],
  "label": "my-app"
}
```

The message looks like this:

```
20-MINUTE WAKE-UP (2:05 PM Mountain, hook wake, project my-app). Check now.
RUNNING worker-a (quiet 3 min)
Check every worker and server; start the next step for anything finished; relaunch anything stalled.
```

Turn it off by deleting the section. A timer that is already running is not stopped by this.

### 6.8 read-ledger-gate

No code until the upstream code was read. Added Oct 15, 2026, after three agents in a row skipped
that step on one project.

- Events: `PreToolUse`. Matcher: `Write|Edit|Bash|PowerShell`. Timeout: 15.
- A `Write` or `Edit` whose path matches `codePattern` is gated. A shell command is gated when it
  matches `shellWritePattern` and names a code path. Paths matching `exemptPattern`, and the ledger
  itself, are never gated.
- The ledger is read line by line. Each line matching `rowPattern` is a row: a path and a line
  count. A relative path is looked up in each of `upstreamRoots`.
- The hook blocks when: the ledger is missing; a row names a file that does not exist
  (`requireExisting`); a row's count is not the file's real count (`verifyLines`); fewer than
  `minEntries` rows; fewer than `minLines` real lines in total; or a word in `mustMention` appears
  in no row path. The message lists every problem.

Config keys:

- `ledgerFile`: path. Default: `.claude/READ-LEDGER.md`.
- `upstreamRoots`: list of paths. Default: the project folder.
- `requireExisting`: boolean. Default: `true`.
- `verifyLines`: boolean. Default: `true`.
- `minEntries`: number. Default: `1`.
- `minLines`: number. Default: `0`.
- `mustMention`: list of text. Default: none.
- `codePattern`: regex. Default: common source extensions (`.ts .js .mjs .py .ps1 .rs .go .cs .java .html .css` and more).
- `exemptPattern`: regex. Default: anything under `.claude/`, and `.md .txt .json .yml .yaml .toml .lock .csv`.
- `shellWritePattern`: regex. Default: `>` and `>>`, heredocs, `Set-Content`, `Add-Content`, `Out-File`, `tee`, `cp`, `mv`, `Copy-Item`, `Move-Item`, `sed -i`, and `git apply/am/checkout/restore/revert/cherry-pick/merge/rebase/pull`.
- `rowPattern`: regex with two groups (path, count). Default accepts `- path - 312 lines`, `| path | 312 |`, `path, 312`.
- `label`: text. Default: the project folder name. `skillName`: text. `nextStep`: text.

```json
"read-ledger-gate": {
  "upstreamRoots": ["C:/upstream/wagalo", "C:/upstream/wigolo"],
  "mustMention": ["wagalo", "wigolo"],
  "minEntries": 10,
  "minLines": 2000
}
```

A ledger that passes it:

```markdown
# Read ledger
- src/lib/wagalo/engines.ts - 1180 lines
- src/lib/wagalo/ladder.ts - 412 lines
- wigolo/src/search/core/orchestrator.ts - 1695 lines
```

### 6.9 measure-gate

No "done" without a fresh number. Added Oct 15, 2026.

- Events: `Stop`. Matcher: none. Timeout: 30.
- The hook finds the newest receipt (`receiptFile`, or the newest file in `receiptDir` whose name
  matches `receiptPattern`) and the newest code file under `codeDirs`. If the code is newer, or
  the receipt does not match `requireMatch`, the turn may not end. The message names both files
  and their times, and shows `measureCommand`.
- It gives up after `maxBlocks` blocks in one turn, lets the turn end, and prints a note on stdout
  saying the receipt is still stale. The turn is the last real user message in the transcript; the
  count is kept in a small file in the OS temp folder, per session.
- With no receipt location, or no code files at all, the hook does nothing.

Config keys:

- `receiptFile`: path. Default: none.
- `receiptDir`: path, with `receiptPattern`: regex (default `.`, every file). Default: none.
- `requireMatch`: regex. Default: none.
- `codeDirs`: list of paths. Default: the project folder.
- `codePattern`: regex. Default: as in 6.8.
- `ignorePattern`: regex. Default: `.git`, `node_modules`, `vendor`, `third-party`, `.claude`, `dist`, `build`, `coverage`, `__pycache__`, `.venv`, `venv`.
- `maxDepth`: number. Default: `8`.
- `maxBlocks`: number. Default: `3`.
- `measureCommand`: text. Default: none.
- `label`: text. Default: the project folder name. `hookName`: text. Default: `measure-gate`.

```json
"measure-gate": {
  "receiptDir": "work/receipts",
  "receiptPattern": "^receipt-.*\\.json$",
  "requireMatch": "\"found\":\\s*\\d+",
  "codeDirs": ["apps", "packages"],
  "measureCommand": "node work/measure/run.mjs"
}
```

### 6.10 citation-gate

An audit, review or handoff document may not claim what the session never read. Port of
`audit-citation-gate.ps1` (Aug 27, 2026), kept in `reference/`.

- Events: `Stop`. Matcher: none. Timeout: 30.
- The hook reads the session transcript (`transcript_path`), collects every tool call's input, and
  the files that `Write`, `Edit` or `NotebookEdit` touched. A `.md` among them whose name matches
  `docPattern` and whose path does not match `excludePattern` is governed.
- For each governed document, fenced code is removed, then: a `## <ledgerHeading>` heading must
  exist; if the text states a verdict and the ledger has no `VERIFIED:`/`UNVERIFIED:` rows, block;
  each `VERIFIED: <claim> | <path>:<line>` must resolve to a real file (as given, or relative to the
  event's `cwd`), the line must be within the file, and the file's path (or its last two segments)
  must appear in some tool call input. Each failure is one line in the block message.
- No transcript, or no governed document: exit 0.

Config keys:

- `docPattern`: regex. Default: `audit|verdict|review|handoff|evidence|assessment|findings` (case-insensitive, on the file name).
- `excludePattern`: regex. Default: a `memory/` folder anywhere in the path.
- `ledgerHeading`: text. Default: `Verification ledger`.
- `label`: text. Default: the project folder name. `skillName`: text.

```json
"citation-gate": { "label": "my project" }
```

### 6.11 sprint-gate

While a sprint is armed, the agent cannot end the turn, and only a human can disarm. Port of
AntiStallClaude v0.3.2 (`reference/antistall-gate.py`, `reference/antistall.py`).

- Events: `Stop`. Matcher: none. Timeout: 15.
- Gate files live in `gateDir`: `gate-<session id>.json` for one session, or `gate.json` for the
  whole project (honored when it has no `owner` or its owner is this session). A gate is armed when
  its JSON has `"active": true`.
- Armed: the hook increments `count-<session id>` and exits 2 with a message that tells the agent to
  keep working, how to run `release` for the human, and `request` for a human-only decision. At
  `cap` it pauses: that one stop is allowed, a desktop toast is shown (Windows), the counter is
  reset, and the gate stays armed. An unreadable or corrupt counter also pauses. `cap: 0` never
  pauses.
- The same file is the CLI. `node hooks/sprint-gate.mjs <command>` from the project folder:
  `set-release-secret`, `arm "<goal>"`, `status`, `request "<why>"`, `release [--all]`. The
  passphrase is read from `SPRINT_RELEASE` (or `ANTISTALL_RELEASE`), else a masked Windows dialog.
  The secret is stored as PBKDF2-SHA256 (240,000 iterations, 16-byte salt) in `secretFile`; the
  record format is the original's, so an existing `antistall-release.hash` works.

Config keys:

- `gateDir`: path. Default: `.claude/sprint`.
- `cap`: number. Default: `25`.
- `honorStopHookActive`: boolean. Default: `false`.
- `secretFile`: path. Default: `~/.claude/antistall-release.hash` if present, else `~/.claude/sprint-release.hash`.
- `label`: text. Default: the project folder name.

```json
"sprint-gate": { "cap": 25, "label": "my project" }
```

### 6.12 command-gate

A forbidden shell command is blocked even when it hides behind a wrapper, a path prefix, a pipeline or
`sh -c`; an oversized `git commit` without a size tag is blocked. Port of two pieces of
`scottconverse/hardgate`: `reference/hardgate-gate.py` (tokenizer and nested-shell walk) and
`reference/hardgate-commit-size-gate.py`.

- Events: `PreToolUse`. Matcher: `Bash|PowerShell`. Timeout: 10.
- The command is split on `;`, `|`, `&&`, `||` outside quotes. Each part is tokenized with POSIX
  quoting rules; `sudo`, `env`, `command`, `exec`, `time`, `nohup`, `KEY=value` and path prefixes are
  stripped; the first token is the verb. A verb rule matches when the verb is listed and, if the rule has
  `flags`, one of them appears. A pattern rule is a regex on the whole command.
- `sh`, `bash`, `zsh`, `dash`, `ash`, `ksh` followed by `-c <string>`: the string is walked as a command,
  one level deeper. Past `maxShellDepth`, or when the inner string cannot be tokenized, the hook blocks
  (fail closed). An outer command that cannot be tokenized passes, as in the original.
- Stricter than the original in one place: the original split on operators before tokenizing, so a `;`
  or `|` inside a quoted `-c` string cut the quote and the parse error passed; and it re-joined nested
  tokens with spaces, which erased the inner quoting at the third level. The kit blocks all three. The
  test file records both behaviors.
- A fresh override marker (modified within `overrideSeconds`) is deleted and grants one pass. A stale
  marker is deleted and grants nothing.
- With `commitSize`, a `git commit` with `-m`/`--message` and no `--amend`/`-F` is checked: staged
  insertions plus deletions from `git diff --cached --numstat` in the event's `cwd`, binary files
  skipped. Over `maxLines` with no tag matching `tagPattern`: block. Not a git repo: pass.

Config keys:

- `forbidden`: list of rules. Default: the kill-by-name set (`pkill -f`, `pgrep -f`, `killall`, `taskkill /IM|/FI`, `Stop-Process -Name|-ProcessName`, `Get-Process ... | Stop-Process`, `Where-Object ... | Stop-Process`). Setting it replaces the defaults; `[]` turns verb rules off.
- `blockInlineCode`: boolean. Default: `false`. `true` blocks `python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, `deno eval`.
- `maxShellDepth`: number. Default: `2`.
- `overrideFile`: path. Default: `.claude/command-gate-override`. `overrideSeconds`: number. Default: `60`.
- `commitSize`: object or absent. `maxLines` (default `800`), `tagPattern` (default the seven literal tags).
- `label`: text. Default: the project folder name. `skillName`: text.

```json
"command-gate": { "label": "my project", "commitSize": { "maxLines": 800 } }
```

### 6.13 ran-before-done

Runnable code was edited this session and nothing was ever run. Port of
`plugin/hooks/dev-rigor-ground.js` from `scottconverse/dev-rigor-stack` (`reference/`).

- Events: `PostToolUse` (matcher `Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell`) and `Stop`.
  Timeout: 10.
- `PostToolUse`: an `Edit`, `Write`, `MultiEdit` or `NotebookEdit` whose `file_path` matches
  `runnablePattern` appends `E<ext>` to `<stateDir>/ran-<session id>.log`. Any other tool that reached the
  hook appends `X`. Which tools reach the hook is the matcher's decision, so a new execution tool counts
  without a code change.
- `Stop`: edits present, no `X`, not yet blocked: append `B`, exit 2. Otherwise exit 0. A stop with
  `stop_hook_active` exits 0. An event without `session_id` does nothing in either mode.
- The original kept its ledgers under `CLAUDE_CONFIG_DIR/dev-rigor-plugin/state` and blocked with a JSON
  `decision` on stdout; the kit keeps them in the project and blocks with exit 2. The parity test compares
  the decisions.

Config keys:

- `stateDir`: path. Default: `.claude/state`.
- `runnablePattern`: regex on the edited path. Default: `\.(html?|svg|m?[jt]sx?|cjs|py|ps1|sh|bash|css|scss|vue|svelte|rs|go|c|cc|cpp|h|hpp|java|rb|php|swift|kt|cs)$`, case-insensitive.
- `label`: text. Default: the project folder name.

```json
"ran-before-done": { "label": "my project" }
```

## 7. Exit codes

The kit's hooks use only two exit codes.

- **Exit 0** lets the action go ahead. The hook prints nothing, except `inject-rules`, which prints
  JSON that adds context.
- **Exit 2** blocks, and the message on stderr goes to Claude.

What exit 2 does, by hook type:

- **PreToolUse** (`deploy-gate`, `walk-brief-guard`, `read-ledger-gate`, `db-write-guard`): blocks the tool call. The
  tool does not run, and Claude sees the message.
- **Stop** (`no-idle`, `double-check`, `measure-gate`, `citation-gate`, `sprint-gate`): blocks the end of the turn. Claude gets one more pass with
  the message. `measure-gate` stops blocking after `maxBlocks` in one turn and prints a note instead.
- **asyncRewake** (`wake`): wakes Claude with the message. The timer runs in the background, so
  Claude is woken only after the delay.
- **SessionStart and UserPromptSubmit** (`inject-rules`): the hook never exits 2.

Some hooks fail closed and some fail open. `deploy-gate` blocks when it cannot read the commit.
`db-write-guard` treats an unreadable go file as no go. A config file with bad JSON makes the hook
do nothing, with no message, and the search for a config stops at that file. A missing section
turns off only that hook. A regex that does not compile is ignored. Section 10 says what that
means for each key.

## 8. Uninstall and roll back

```
node uninstall.mjs                    # removes the kit's hook entries; keeps every other hook and setting
node uninstall.mjs --remove-files     # also deletes <settings folder>/hook-kit/
node uninstall.mjs --dry-run          # shows the result, writes nothing
```

`--config-dir <dir>` works here too. The uninstaller:

- backs up `settings.json` first, to `settings.json.bak-hookkit-<yyyyMMdd-HHmmss>`. If that name is
  taken, it adds `-2`, `-3` and so on, so no backup is overwritten;
- removes only the entries whose command points at a kit hook, whether from the installed copy or
  an old local clone;
- keeps the copied files in `<settings folder>/hook-kit/` unless you pass `--remove-files`.

If `settings.json` does not exist, it prints a message and stops. With `--remove-files`, it still
deletes the copied folder.

**Roll back to the backup.** Copy the backup that the installer printed over `settings.json`.
On Windows:

```
copy "%USERPROFILE%\.claude\settings.json.bak-hookkit-20261014-131205" "%USERPROFILE%\.claude\settings.json"
```

On macOS and Linux, use `cp` with the same paths.

**Turn off one project.** Delete its `.claude/hook-kit.json`, or add `"enabled": false` at the top.

**Turn off everywhere.** Run `node uninstall.mjs`. Do not delete the whole `hooks` block by hand.
That block can hold hooks that the kit did not add.

## 9. Testing

```
npm test
node --test "tests/**/*.test.mjs"
```

`npm test` runs the second command. The suite has 128 tests. On Node v24.21.0 on Windows, all 128 pass.

Six hooks have a parity test. It runs the kit hook and the matching script in `reference/` on the
same input, then compares the exit code and the message. `no-idle` compares only the status words,
because its hint text comes from config and the reference's is fixed. `double-check`, `read-ledger-gate` and `measure-gate` have no
reference script, so their own test files check them. `citation-gate` and `sprint-gate` have parity tests
against `reference/audit-citation-gate.ps1` (needs PowerShell) and `reference/antistall-gate.py` (needs Python).
`command-gate` has parity tests against `reference/hardgate-gate.py` and `reference/hardgate-commit-size-gate.py`
(Python; the second also needs git) plus one test that pins the three inputs where the kit is stricter than the
original. `ran-before-done` replays one tool sequence through `reference/dev-rigor-ground.js` and the kit. The
doctor has its own tests in a temp settings folder. The scope tests check the config lookup. The
installer tests use temp folders and never touch the real `~/.claude`.

**Windows note.** Do not run `node --test tests/` with a folder name. On Node v24.21.0 on Windows,
that fails with `MODULE_NOT_FOUND` before any test runs. Use the quoted glob shown above, or run
`node --test` from inside `tests/`.

## 10. Troubleshooting

Run `node doctor.mjs --project <folder>` first (section 3.1). It names the missing registration, the missing script, or the config key that does not resolve.

**A hook does nothing.** Check these, in order. Each one turns a hook off with no message.

- A `.claude/hook-kit.json` exists in the project folder, or in a folder above it. The nearest
  one is the one you meant.
- That file is valid JSON. If it is not, the kit treats the file as absent and does not search
  any higher folder.
- The hook has its own section in the file.
- Neither the top level nor the section says `"enabled": false`.

**A check never fires, and no error appears.** The kit ignores a regex that does not compile. What
follows depends on the key:

- `commandPattern` (deploy-gate), `pathPattern` (walk-brief-guard) and `clientPattern`
  (db-write-guard): the whole hook does nothing. For example, a bad `clientPattern` means
  `db-write-guard` never blocks.
- Keys with a built-in default, such as `db-write-guard`'s `portPattern`: the default is used.
- `requiredKeys` with `"test": "match"` (deploy-gate): the check fails, so the deploy is blocked.
- Other keys: that one pattern is ignored.

Test the pattern in the same form the config uses. Remember that the config value is a JSON string,
so backslashes must be doubled.

**`db-write-guard` never blocks a write.** Check that `port` is set and that `clientPattern`
matches the command. The default `portPattern` accepts `-p PORT`, `--port PORT`, `--port=PORT`,
`:PORT` (as in `localhost:5433`) and `PGPORT=PORT`. A command that does not match it is not checked.
A command with a `-d` or `--dbname` naming a database not in `databases` is not checked either.

If a write is blocked when it should go through, check `okFile`. With no `okFile` set, every write
is blocked.

**`deploy-gate` blocks with "cannot read origin/main".** The hook runs `git fetch origin --quiet`
first. If the fetch fails (no network, or no `origin` remote), or `repoDir` points at the wrong
folder, the deploy is blocked. Fix the remote or the path. You can also set `"shaFrom": "HEAD"`
to gate the local commit.

**`deploy-gate` blocks with "gate file does not exist".** Write `<gatesDir>/<full commit sha>.json`.
Get the sha with `git rev-parse origin/main` (or `git rev-parse HEAD` if `shaFrom` is `"HEAD"`).
A gate file that is not valid JSON blocks the same way.

**`double-check` asks even on a short turn.** With `minToolCalls` set, an unreadable transcript makes
the hook ask anyway. A turn ends without the check only when the transcript can be read and has
fewer tool calls than `minToolCalls`.

**`no-idle` says "NO waiter is alive".** That message appears only when `waiterHeartbeat` or
`waiterCheck` is set. If the heartbeat file is older than `waiterFreshMinutes`, or the
`waiterCheck` command exits non-zero, the hook counts no waiter.

**`wake` does not start a new timer.** A live timer that started less than the delay plus 2 minutes
ago holds the lock, so the new timer exits at once. A lock whose process has ended does not block.

**`inject-rules` adds nothing.** The `rulesFile` path is missing, or the file cannot be read. A
relative path resolves from the project folder.

**`walk-brief-guard` finds a required section in the wrong place.** `requiredSections` patterns are used
as written, with the `m` flag. The hook adds no `^`, so put `^` in the pattern when the heading must
start a line.

## 11. Config key reference

| Hook | Key | Type | Default | Meaning |
|---|---|---|---|---|
| (top level) | `enabled` | boolean | `true` | `false` turns the kit off for this folder tree. |
| `inject-rules` | `rulesFile` | path | none | The rules text file. A missing file injects nothing. |
| `inject-rules` | `heading` | text | `PROJECT RULES (obey every line, no exceptions):` | Line placed before the rules. |
| `deploy-gate` | `commandPattern` | regex | none | Matches a deploy command. |
| `deploy-gate` | `skipPatterns` | list of regex | none | A match means the command is not a deploy. |
| `deploy-gate` | `repoDir` | path | none | Git repo that holds the commit. |
| `deploy-gate` | `shaFrom` | `origin/main` or `HEAD` | `origin/main` | Which commit is gated. |
| `deploy-gate` | `gatesDir` | path | none | Folder of `<sha>.json` gate files. |
| `deploy-gate` | `skillName` | text | none | Prefix on the block message. |
| `deploy-gate` | `label` | text | `this project` | Name used when the commit cannot be read. |
| `deploy-gate` | `pathLine` | text | none | Extra line in the block message. |
| `deploy-gate` | `nextStep` | text | `Do the missing tier, then write the gate file.` | Last line of the block message. |
| `deploy-gate` | `requiredKeys` | list | none | Field checks: `key`, `test`, `expected`, `min`, `pattern`, `message`. |
| `deploy-gate` | `mustEqual` | list | none | Field pairs that must match: `key`, `other`, `message`. |
| `deploy-gate` | `reportKey` | text | none | Gate field holding the walk report path. |
| `deploy-gate` | `reportMessage` | text | `<reportKey>: path to an existing walk report` | Message when the report is missing. |
| `deploy-gate` | `reportMustContain` | regex | none | Text the walk report must match. |
| `deploy-gate` | `reportMustContainMessage` | text | `walk report must contain the line` plus the regex | Message when the report does not match. |
| `deploy-gate` | `findingsFile` | path | none | Findings list. A missing file blocks. |
| `deploy-gate` | `openPattern` | regex | none | Matches an OPEN finding row. |
| `deploy-gate` | `textOnlyKey` | text | `textOnly` | Gate field that turns on text-only mode. |
| `deploy-gate` | `textOnly` | object | none | Text-only checks: `requiredKeys`, `filesKey` (`textFiles`), `filesMessage`, `extraMessage`. |
| `walk-brief-guard` | `pathPattern` | regex | none | Matches a walk brief path or command. |
| `walk-brief-guard` | `heredocPattern` | regex | none | A matching command counts as a full file body. |
| `walk-brief-guard` | `bannedPatterns` | list | none | `{ pattern, message }`. A match blocks. |
| `walk-brief-guard` | `requiredLines` | list | none | `{ pattern, message, onlyFullBody }`. Must match. |
| `walk-brief-guard` | `requiredSections` | list | none | Same shape. Multiline flag. |
| `walk-brief-guard` | `skillName` | text | none | Prefix on the block message. |
| `walk-brief-guard` | `footer` | text | `Every walk brief must tell the walker how to finish the walk.` | Last line of the block message. |
| `db-write-guard` | `port` | number | none | The live database port. |
| `db-write-guard` | `databases` | list | none | Names that mean the live database. |
| `db-write-guard` | `clientPattern` | regex | none | Matches client and tool commands. |
| `db-write-guard` | `skipPattern` | regex | built-in (section 6.4) | Notes and edits that are allowed. |
| `db-write-guard` | `sqlArgPattern` | regex | built-in (section 6.4) | Overrides a skip match. |
| `db-write-guard` | `portPattern` | regex | built-in, from `port` (section 6.4) | Matches the live port. |
| `db-write-guard` | `writePattern` | regex | built-in (section 6.4) | SQL write words. |
| `db-write-guard` | `filePattern` | regex | built-in (section 6.4) | SQL file arguments. |
| `db-write-guard` | `restorePattern` | regex | none | Restore, create or drop commands. |
| `db-write-guard` | `okFile` | path | none | The go file. Its modified time is checked. |
| `db-write-guard` | `okMinutes` | number | `30` | How long a go lasts. |
| `db-write-guard` | `label` | text | `the live database` | Name used in the block message. |
| `db-write-guard` | `explanation` | text | `The live database is read-only for me.` | Second line of the block message. |
| `db-write-guard` | `ownerName` | text | `the owner` | The owner's name in the go line of the block message. |
| `db-write-guard` | `skillName` | text | none | Prefix on the block message. |
| `no-idle` | `runsDir` | path | none | Folder of worker folders. |
| `no-idle` | `logNames` | list | `["run.jsonl", "stream.jsonl"]` | Log file names, first one found wins. |
| `no-idle` | `handledFile` | text | `handled.txt` | Recorded-action file in a worker folder. |
| `no-idle` | `finishedFile` | text | `finished.txt` | File that marks a worker as finished. |
| `no-idle` | `quietMinutes` | number | `15` | Minutes of silence before a worker is stuck. |
| `no-idle` | `lookbackHours` | number | `48` | Only logs changed this recently are checked. |
| `no-idle` | `handledHint` | text | none (the built-in `Act now` line, section 6.5) | Hint for a finished worker. |
| `no-idle` | `stuckHint` | text | `Diagnose and relaunch, or mark it handled on purpose.` | Hint for a stuck worker. |
| `no-idle` | `waiterHeartbeat` | path | none | File a live waiter keeps touching. |
| `no-idle` | `waiterFreshMinutes` | number | `3` | How recent the heartbeat must be. |
| `no-idle` | `waiterCheck` | command | none | Exits 0 when a waiter is alive. |
| `no-idle` | `waiterCheckArgs` | list of text | none | Arguments for `waiterCheck`. |
| `no-idle` | `waiterHint` | text | none | Hint shown with the waiter message. |
| `no-idle` | `header` | text | `you may not end this turn yet.` | First line of the block message. |
| `no-idle` | `hookName` | text | `no-idle` | Name shown in the block message. |
| `double-check` | `quote` | text | none | Shown before the checklist. |
| `double-check` | `checklist` | list of text | six built-in lines (section 6.6) | The checklist. |
| `double-check` | `minToolCalls` | number | `0` | Ask only after this many tool calls. |
| `double-check` | `label` | text | none | Name in the header. |
| `read-ledger-gate` | `ledgerFile` | path | `.claude/READ-LEDGER.md` | The read ledger. |
| `read-ledger-gate` | `upstreamRoots` | list of paths | the project folder | Where relative row paths are looked up. |
| `read-ledger-gate` | `requireExisting` | boolean | `true` | Every row must name a real file. |
| `read-ledger-gate` | `verifyLines` | boolean | `true` | The stated count must equal the real line count. |
| `read-ledger-gate` | `minEntries` | number | `1` | Rows needed before code may be written. |
| `read-ledger-gate` | `minLines` | number | `0` | Real lines read, in total. |
| `read-ledger-gate` | `mustMention` | list of text | none | Each word must appear in some row path. |
| `read-ledger-gate` | `codePattern` | regex | built-in (section 6.8) | Paths that count as code. |
| `read-ledger-gate` | `exemptPattern` | regex | built-in (section 6.8) | Paths never gated. |
| `read-ledger-gate` | `shellWritePattern` | regex | built-in (section 6.8) | Shell commands that write files. |
| `read-ledger-gate` | `rowPattern` | regex | built-in (section 6.8) | A ledger row: path, then count. |
| `read-ledger-gate` | `label` | text | project folder name | Name in the block message. |
| `read-ledger-gate` | `skillName` | text | none | Prefix on the block message. |
| `read-ledger-gate` | `nextStep` | text | built-in (section 6.8) | Last line of the block message. |
| `measure-gate` | `receiptFile` | path | none | One receipt file. |
| `measure-gate` | `receiptDir` | path | none | Folder of receipts; the newest counts. |
| `measure-gate` | `receiptPattern` | regex | `.` | Receipt file names. |
| `measure-gate` | `requireMatch` | regex | none | Text the newest receipt must contain. |
| `measure-gate` | `codeDirs` | list of paths | the project folder | Folders scanned for code. |
| `measure-gate` | `codePattern` | regex | built-in (section 6.8) | Paths that count as code. |
| `measure-gate` | `ignorePattern` | regex | built-in (section 6.9) | Folders never scanned. |
| `measure-gate` | `maxDepth` | number | `8` | Folder depth scanned. |
| `measure-gate` | `maxBlocks` | number | `3` | Blocks per turn before giving up. |
| `measure-gate` | `measureCommand` | text | none | Shown in the block message. |
| `measure-gate` | `label` | text | project folder name | Name in the block message. |
| `measure-gate` | `hookName` | text | `measure-gate` | Name in the block message. |
| `citation-gate` | `docPattern` | regex | built-in (section 6.10) | Governed document names. |
| `citation-gate` | `excludePattern` | regex | a `memory/` folder | Paths never governed. |
| `citation-gate` | `ledgerHeading` | text | `Verification ledger` | Required heading. |
| `citation-gate` | `label` | text | project folder name | Name in the block message. |
| `citation-gate` | `skillName` | text | none | Prefix on the block message. |
| `sprint-gate` | `gateDir` | path | `.claude/sprint` | Gate and counter files. |
| `sprint-gate` | `cap` | number | `25` | Blocks before a pause; 0 = never pause. |
| `sprint-gate` | `honorStopHookActive` | boolean | `false` | Let a continuation stop through. |
| `sprint-gate` | `secretFile` | path | see section 6.11 | PBKDF2 record of the release passphrase. |
| `sprint-gate` | `label` | text | project folder name | Name in messages. |
| `command-gate` | `forbidden` | list | kill-by-name rules (section 6.12) | `{ verbs, flags, message }` or `{ pattern, message }`. Replaces the defaults. |
| `command-gate` | `blockInlineCode` | boolean | `false` | Also block `python -c`, `node -e` and the like. |
| `command-gate` | `maxShellDepth` | number | `2` | Nested `sh -c` levels walked before failing closed. |
| `command-gate` | `overrideFile` | path | `.claude/command-gate-override` | One-shot human bypass marker. |
| `command-gate` | `overrideSeconds` | number | `60` | How fresh the marker must be. |
| `command-gate` | `commitSize` | object | none (off) | `maxLines` (`800`), `tagPattern` (seven literal tags). |
| `command-gate` | `label` | text | project folder name | Name in messages. |
| `command-gate` | `skillName` | text | none | Prefix on the block message. |
| `ran-before-done` | `stateDir` | path | `.claude/state` | Folder of per-session ledgers. |
| `ran-before-done` | `runnablePattern` | regex | source and view extensions (section 6.13) | Which edited paths count. |
| `ran-before-done` | `label` | text | project folder name | Name in messages. |
| `wake` | `minutes` | number | `20` | Delay before the wake-up. |
| `wake` | `runsDir` | path | none | Folder of worker folders. |
| `wake` | `minutesFile` | path | `<runsDir>/.rewake-seconds` | Seconds that replace `minutes`. |
| `wake` | `lockFile` | file name | `.rewake-lock.json` | Lock file in `runsDir`. |
| `wake` | `logNames` | list | `["run.jsonl", "stream.jsonl"]` | Log file names, first one found wins. |
| `wake` | `handledFile` | text | `handled.txt` | Recorded-action file in a worker folder. |
| `wake` | `finishedFile` | text | `finished.txt` | File that marks a worker as finished. |
| `wake` | `quietMinutes` | number | `15` | Minutes of silence before a worker is stalled. |
| `wake` | `lookbackHours` | number | `48` | Only logs changed this recently are listed. |
| `wake` | `label` | text | the project folder name | Project name in the header. |
| `wake` | `hookName` | text | `wake` | Name in the header. |
| `wake` | `timeZone` | IANA name | `America/Denver` | Time zone used for the printed time. |
| `wake` | `timeZoneName` | text | `Mountain` | Zone name printed after the time. |
| `wake` | `footer` | text | built-in (section 6.7) | Last line of the wake-up message. |
| `wake` | `tokenModule` | path | none | Module that adds a `tokens:` line per worker. |
