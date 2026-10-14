#!/usr/bin/env node
// Give a project a hook-kit config.
//
//   node init-project.mjs <projectDir> [--example minimal|townreporter] [--force]
//
// Writes <projectDir>/.claude/hook-kit.json from an example in examples/. Refuses
// to overwrite an existing file unless --force is passed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.join(REPO, "examples");

function fail(message) {
  process.stderr.write("init-project: " + message + "\n");
  process.exit(1);
}

function parseArgs(argv) {
  const out = { projectDir: "", example: "minimal", force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--example") {
      out.example = argv[++i];
      if (!out.example) fail("--example needs a name");
    } else if (a.startsWith("--example=")) out.example = a.slice("--example=".length);
    else if (a === "--force") out.force = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: node init-project.mjs <projectDir> [--example minimal|townreporter] [--force]");
      process.exit(0);
    } else if (a.startsWith("-")) fail("unknown argument: " + a);
    else if (!out.projectDir) out.projectDir = a;
    else fail("only one project folder is expected, got a second: " + a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectDir) fail("usage: node init-project.mjs <projectDir> [--example minimal|townreporter] [--force]");

  const src = path.join(EXAMPLES, args.example + ".hook-kit.json");
  if (!fs.existsSync(src)) {
    const have = fs.existsSync(EXAMPLES)
      ? fs.readdirSync(EXAMPLES).filter((f) => f.endsWith(".hook-kit.json")).map((f) => f.replace(".hook-kit.json", ""))
      : [];
    fail("no example named \"" + args.example + "\" (have: " + (have.join(", ") || "none") + ")");
  }

  const projectDir = path.resolve(args.projectDir);
  const dest = path.join(projectDir, ".claude", "hook-kit.json");
  const fwd = (p) => p.split(path.sep).join("/");

  if (fs.existsSync(dest) && !args.force) {
    fail(fwd(dest) + " already exists; pass --force to overwrite it");
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log("init-project: wrote " + fwd(dest) + " from examples/" + args.example + ".hook-kit.json");
  if (args.example === "townreporter") {
    console.log("  note: the townreporter example names Scott's own paths; edit them for another machine.");
  }
}

main();
