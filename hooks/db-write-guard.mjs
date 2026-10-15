// PreToolUse hook (Bash|PowerShell): a project's live database is READ-ONLY for Claude unless
// a go is recorded in a fresh ok file. Reads are always allowed. Exit 2 = blocked.
// Port of reference/tr-guard-live-db.mjs.
// Config section "db-write-guard":
//   port           the live database's port (e.g. 5433)
//   databases      database names that mean "the live one" (e.g. ["townreporter"])
//   clientPattern  regex string matching the client/tool commands (psql, pg_restore, ...)
//   okFile         file whose mtime is the go; missing or old = no go
//   okMinutes      how long the go lasts
//   ownerName      the owner's name in the block message, e.g. "Scott" (default "the owner")
import fs from "node:fs";
import { loadFromStdin, resolveIn, rx } from "../lib/config.mjs";

const { input, section } = loadFromStdin("db-write-guard");
if (!section) process.exit(0);

const s = section;
let cmd = String((input.tool_input || {}).command ?? "");
// Text inside a shell here-document is data being written to a file, not a command: ignore it.
cmd = cmd.replace(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, "<<HEREDOC");

const clientRx = rx(s.clientPattern, "i");
if (!clientRx || !clientRx.test(cmd)) process.exit(0);
const skipRx = rx(s.skipPattern, "i") || /<<|Set-Content|Add-Content|Out-File|\bgrep\b|Select-String/i;
const sqlArgRx = rx(s.sqlArgPattern, "i") || /-c\s|-f\s|--command|--file/i;
if (skipRx.test(cmd) && !sqlArgRx.test(cmd)) process.exit(0);

const port = Number(s.port);
const portRx = rx(s.portPattern, "i") || new RegExp("(-p|--port)[\\s=]+" + port + "\\b|:" + port + "\\b|PGPORT=" + port, "i");
if (!portRx.test(cmd)) process.exit(0);

// A different database on the same cluster (a test or dev copy) is not "the live one".
// No database named at all counts as aimed at the live one, like the reference.
const dbNames = [...cmd.matchAll(/(?:-d|--dbname)[\s=]+["']?([A-Za-z0-9_.-]+)/gi)].map((m) => m[1]);
const urlDb = [...cmd.matchAll(new RegExp(":" + port + "\\/([A-Za-z0-9_.-]+)", "g"))].map((m) => m[1]);
const names = [...dbNames, ...urlDb];
const wanted = (Array.isArray(s.databases) ? s.databases : []).map((d) => String(d).toLowerCase());
const touchesLive = names.length === 0 || names.some((n) => wanted.includes(n.toLowerCase()));
if (!touchesLive) process.exit(0);

// Only the SQL counts: the text given to -c/--command, or the whole line when SQL is piped in.
const sqlArgs = [...cmd.matchAll(/(?:\s-c|--command)[\s=]+("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/gi)].map((m) => m[1]).join(" ; ");
const piped = /\|\s*&?\s*\S*psql|psql\S*\s[^\n]*<\s*\S|<<\s*['"]?\w+/i.test(cmd) && !/<<HEREDOC/.test(cmd);
const sqlText = sqlArgs || (piped ? cmd : "");
const writeRx = rx(s.writePattern, "i") || /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|vacuum|reindex|cluster|copy)\b/i;
const writes = writeRx.test(sqlText);
const fileRx = rx(s.filePattern, "i") || /(^|\s)(-f|--file)[\s=]/i;
const usesFile = fileRx.test(cmd) || /<\s*\S+\.sql/i.test(cmd);
const restoreRx = rx(s.restorePattern, "i");
const restore = restoreRx ? restoreRx.test(cmd) : false;
if (!(writes || usesFile || restore)) process.exit(0); // plain SELECT / \d / count: allowed

const ok = resolveIn(section.cfg, s.okFile);
// Show it the way the reference did: forward slashes, so the message is the same
// string a TownReporter-era reader recognises.
const okShown = ok.replace(/\\/g, "/");
const okMinutes = Number(s.okMinutes ?? 30);
const owner = String(s.ownerName || "the owner");
let fresh = false;
try {
  fresh = Date.now() - fs.statSync(ok).mtimeMs < okMinutes * 60 * 1000;
} catch {}
if (fresh) process.exit(0);

console.error(
  "BLOCKED by " + (s.skillName ? s.skillName + ": " : "") + "this command can WRITE to " + String(s.label || "the live database") + " (port " + s.port + (wanted.length ? ", database " + wanted.join("/") : "") + ").\n" +
    String(s.explanation || "The live database is read-only for me.") + "\n" +
    "If " + owner + " has said go in chat for this exact change: take a backup, announce the time, then create " + okShown + " with the script name and the time in it (valid " + okMinutes + " minutes), and run the command again.",
);
process.exit(2);
