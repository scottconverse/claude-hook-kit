#!/usr/bin/env node
// dev-rigor grounding — mechanical run-before-done check.
// Two modes, one append-only ledger per session:
//   node dev-rigor-ground.js record   (PostToolUse) — note edits to runnable/viewable
//                                     files and any execution-tool call
//   node dev-rigor-ground.js check    (Stop) — if runnable artifacts were edited but
//                                     NOTHING was ever executed/rendered this session,
//                                     block the stop ONCE with a pointed reason
// Deliberate floor: it only catches the provable-theater case (zero executions ever).
// It does not demand a re-run after every trailing edit — that judgment stays with
// the model; the router's grounding discipline covers it.
//
// Concept credit: fivetaku/fablize (MIT) proved verification grounding transferable
// in a Fable-vs-Opus comparison. Clean-room implementation — no fablize code used.

const fs = require('fs');
const os = require('os');
const path = require('path');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const stateDir = path.join(claudeDir, 'dev-rigor-plugin', 'state');

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const RUNNABLE_EXT = /\.(html?|svg|m?[jt]sx?|cjs|py|ps1|sh|bash|css|scss|vue|svelte|rs|go|c|cc|cpp|h|hpp|java|rb|php|swift|kt|cs)$/i;
// Which tools reach this hook at all is decided by the PostToolUse matcher in
// settings.json (edit tools + execution/observation tools). So: any non-edit tool
// that got here counts as execution — enumerating exec tools here would just
// recreate the false-block on tools we didn't foresee (mcp__ide__executeCode etc.).

// Ledger = append-only log, one event per line ('E<ext>' edit, 'X' exec, 'B' blocked),
// reduced at read time. Appends are atomic enough at these sizes that concurrent
// hook invocations can't lose each other's writes the way read-modify-write JSON did.
function ledgerPath(session) {
  const s = String(session).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(stateDir, `ground-${s}.log`);
}

function readLedger(session) {
  let lines = [];
  try {
    lines = fs.readFileSync(ledgerPath(session), 'utf8').split('\n').filter(Boolean);
  } catch (e) { /* no ledger yet */ }
  return {
    edits: [...new Set(lines.filter((l) => l[0] === 'E').map((l) => l.slice(1)))],
    execs: lines.filter((l) => l === 'X').length,
    blocked: lines.includes('B'),
  };
}

function append(session, line) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(ledgerPath(session), line + '\n', 'utf8');
  } catch (e) { /* never fail the hook over state */ }
}

function main() {
  const mode = process.argv[2];
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    return; // garbage stdin -> silence
  }
  // No session_id -> no trustworthy ledger. Fail open (record nothing, block
  // nothing) rather than coalescing unrelated invocations into a shared bucket.
  const session = payload.session_id;
  if (!session) return;

  if (mode === 'record') {
    const tool = String(payload.tool_name || '');
    if (EDIT_TOOLS.test(tool)) {
      const file = String((payload.tool_input && payload.tool_input.file_path) || '');
      if (RUNNABLE_EXT.test(file)) {
        append(session, 'E' + (file.match(/\.[^.]+$/) || ['?'])[0]);
      }
    } else if (tool) {
      append(session, 'X');
    }
    return;
  }

  if (mode === 'check') {
    if (payload.stop_hook_active) return; // already in a blocked continuation — let it end
    const ledger = readLedger(session);
    if (ledger.blocked || ledger.edits.length === 0 || ledger.execs > 0) return;
    append(session, 'B'); // one block per session, ever
    try {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason:
          'Grounding check: you edited runnable/viewable artifact(s) (' + ledger.edits.join(', ') +
          ') this session but never executed or rendered ANYTHING — no test, script, or preview ran. ' +
          'Run the narrowest real check that exercises your change and observe the result, ' +
          'or state in one line why it cannot be run here, then finish.',
      }));
    } catch (e) { /* EPIPE at hook exit is not a failure */ }
  }
}

main();
process.exit(0);
