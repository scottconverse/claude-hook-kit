import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HOOKS, makeProject, mkTemp, portReference, rimraf, runHook, writeText } from "./helpers.mjs";

const KIT = path.join(HOOKS, "db-write-guard.mjs");
const REF_PATH = "C:/Users/scott/Desktop/Code/townreporter-deepseek-oversight/gates/live-db-write-ok.txt";

function fixture() {
  const dir = mkTemp("hook-kit-db-");
  const ok = path.join(dir, "live-db-write-ok.txt");
  const ref = portReference("tr-guard-live-db.mjs", [[REF_PATH, ok.replace(/\\/g, "/")]], dir);
  const proj = makeProject({
    "db-write-guard": {
      port: 5433,
      databases: ["townreporter"],
      clientPattern: "\\bpsql(\\.exe)?\\b|\\bpg_restore\\b|\\bdropdb\\b|\\bcreatedb\\b|\\bpg_ctl\\b",
      skipPattern: "<<|Set-Content|Add-Content|Out-File|\\bgrep\\b|Select-String",
      sqlArgPattern: "-c\\s|-f\\s|--command|--file",
      writePattern: "\\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|vacuum|reindex|cluster|copy)\\b",
      filePattern: "(^|\\s)(-f|--file)[\\s=]",
      restorePattern: "\\bpg_restore\\b|\\bdropdb\\b|\\bcreatedb\\b",
      okFile: ok,
      okMinutes: 30,
      ownerName: "Scott",
      skillName: "Scott's release path (skill townreporter-release-path)",
      label: "the live paper's database",
      explanation: "The live paper is read-only for me. Data changes go through the tested path (dev server -> Test server -> announced, backed-up deploy).",
    },
  });
  return { dir, ok, ref, proj };
}

function clean(f, okFresh) {
  if (okFresh) fs.writeFileSync(f.ok, "go\n");
  else fs.rmSync(f.ok, { force: true });
  if (okFresh === "old") {
    const past = Date.now() / 1000 - 3600;
    fs.utimesSync(f.ok, past, past);
  }
}

const CASES = [
  { name: "SELECT on the live port is allowed", cmd: 'psql -p 5433 -d townreporter -c "SELECT count(*) FROM posts"', ok: false, blocked: false },
  { name: "\\d on the live port is allowed", cmd: 'psql -p 5433 -U postgres -d townreporter -c "\\d posts"', ok: false, blocked: false },
  { name: "INSERT on the live port is blocked", cmd: 'psql -p 5433 -d townreporter -c "INSERT INTO posts (t) VALUES (1)"', ok: false, blocked: true, words: ["BLOCKED", "5433", "townreporter", "read-only"] },
  { name: "UPDATE on the live port is blocked", cmd: "psql --port 5433 -d townreporter -c 'UPDATE posts SET t=1'", ok: false, blocked: true, words: ["BLOCKED", "5433"] },
  { name: "DROP via a URL is blocked", cmd: 'psql "postgres://localhost:5433/townreporter" -c "DROP TABLE posts"', ok: false, blocked: true, words: ["BLOCKED", "5433"] },
  { name: "pg_restore onto the live port is blocked", cmd: "pg_restore -p 5433 -d townreporter dump.sql", ok: false, blocked: true, words: ["BLOCKED", "5433"] },
  { name: "dropdb on the live port is blocked", cmd: "dropdb -p 5433 townreporter", ok: false, blocked: true, words: ["BLOCKED"] },
  { name: "INSERT is allowed with a fresh ok file", cmd: 'psql -p 5433 -d townreporter -c "INSERT INTO posts (t) VALUES (1)"', ok: true, blocked: false },
  { name: "INSERT is blocked when the ok file is stale", cmd: 'psql -p 5433 -d townreporter -c "INSERT INTO posts (t) VALUES (1)"', ok: "old", blocked: true, words: ["BLOCKED"] },
  { name: "write to a test database on the same port is allowed", cmd: 'psql -p 5433 -d townreporter_test_7 -c "INSERT INTO posts (t) VALUES (1)"', ok: false, blocked: false },
  { name: "a different port is not ours", cmd: 'psql -p 5432 -d townreporter -c "DROP TABLE posts"', ok: false, blocked: false },
  // The reference's skip guard exempts anything carrying -c/-f/--command/--file, and this
  // command carries -c, so it reaches the write check and is blocked. Both hooks agree.
  { name: "a note that embeds psql -c is blocked by both", cmd: 'Set-Content -Path note.md -Value "psql -p 5433 -d townreporter -c DROP"', ok: false, blocked: true, words: ["BLOCKED"] },
  { name: "writing a note that mentions psql without -c is allowed", cmd: 'Set-Content -Path note.md -Value "run psql -p 5433 -d townreporter"', ok: false, blocked: false },
];

for (const c of CASES) {
  test("db-write-guard parity: " + c.name, async () => {
    const f = fixture();
    try {
      clean(f, c.ok);
      const stdin = JSON.stringify({ tool_name: "Bash", cwd: f.proj.cwd, tool_input: { command: c.cmd } });
      const [got, want] = await Promise.all([runHook(KIT, stdin), runHook(f.ref, stdin)]);
      assert.equal(got.code, want.code, "exit code matches the reference");
      assert.equal(got.code, c.blocked ? 2 : 0);
      assert.equal(got.stderr.replace(/\s+/g, " ").trim(), want.stderr.replace(/\s+/g, " ").trim(), "stderr matches the reference");
      if (c.words) for (const w of c.words) assert.ok(got.stderr.includes(w), "stderr mentions " + w);
    } finally {
      rimraf(f.dir);
      rimraf(f.proj.root);
    }
  });
}
