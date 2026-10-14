// PreToolUse hook (Bash|PowerShell): the live paper's database (Postgres 5433, database "townreporter") is
// READ-ONLY for Claude unless Scott's go is recorded. Blocks write SQL and SQL files aimed at it. Exit 2 = blocked.
import fs from "node:fs";

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
let cmd = String((input.tool_input || {}).command ?? "");
// Text inside a shell here-document is data being written to a file, not a command: ignore it.
cmd = cmd.replace(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, "<<HEREDOC");

if (!/\bpsql(\.exe)?\b|\bpg_restore\b|\bdropdb\b|\bcreatedb\b|\bpg_ctl\b/i.test(cmd)) process.exit(0);
if (/<<|Set-Content|Add-Content|Out-File|\bgrep\b|Select-String/i.test(cmd) && !/-c\s|-f\s|--command|--file/i.test(cmd)) process.exit(0);

const aimedAtLive = /(-p|--port)[\s=]+5433\b|:5433\b|PGPORT=5433/i.test(cmd);
if (!aimedAtLive) process.exit(0);
// A different database on the same cluster (townreporter_test_*, townreporter_dev, ...) is not "the paper".
const dbNames = [...cmd.matchAll(/(?:-d|--dbname)[\s=]+["']?([A-Za-z0-9_.-]+)/gi)].map((m) => m[1]);
const urlDb = [...cmd.matchAll(/:5433\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
const names = [...dbNames, ...urlDb];
const touchesPaper = names.length === 0 || names.some((n) => n.toLowerCase() === "townreporter");
if (!touchesPaper) process.exit(0);

// Only the SQL counts: the text given to -c/--command, or the whole line when SQL is piped in.
const sqlArgs = [...cmd.matchAll(/(?:\s-c|--command)[\s=]+("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/gi)].map((m) => m[1]).join(" ; ");
const piped = /\|\s*&?\s*\S*psql|psql\S*\s[^\n]*<\s*\S|<<\s*['"]?\w+/i.test(cmd) && !/<<HEREDOC/.test(cmd);
const sqlText = sqlArgs || (piped ? cmd : "");
const writes = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|vacuum|reindex|cluster|copy)\b/i.test(sqlText);
const usesFile = /(^|\s)(-f|--file)[\s=]/i.test(cmd) || /<\s*\S+\.sql/i.test(cmd);
const restore = /\bpg_restore\b|\bdropdb\b|\bcreatedb\b/i.test(cmd);
if (!(writes || usesFile || restore)) process.exit(0); // plain SELECT / \d / count: allowed

const ok = "C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/gates/live-db-write-ok.txt";
let fresh = false;
try { fresh = Date.now() - fs.statSync(ok).mtimeMs < 30 * 60 * 1000; } catch {}
if (fresh) process.exit(0);
console.error(
  "BLOCKED by Scott's release path (skill townreporter-release-path): this command can WRITE to the live paper's database (port 5433, database townreporter).\n" +
    "The live paper is read-only for me. Data changes go through the tested path (dev server -> Test server -> announced, backed-up deploy).\n" +
    "If Scott has said go in chat for this exact change: take a backup, announce the time, then create " + ok +
    " with the script name and the time in it (valid 30 minutes), and run the command again.",
);
process.exit(2);
