#!/usr/bin/env node
// Regenerate install/settings-snippet.json from lib/hook-entries.mjs.
//
//   node tools/write-snippet.mjs
//
// The snippet uses the literal placeholder "<HOOK_KIT_DIR>" instead of a real
// install path, so anyone can read it and see the shape. install.mjs builds the
// same entries with a real path from the same module, so the two cannot drift.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHookEntries, HOOK_KIT_DIR_TOKEN } from "../lib/hook-entries.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(REPO, "install", "settings-snippet.json");

const snippet = { hooks: buildHookEntries(HOOK_KIT_DIR_TOKEN) };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(snippet, null, 2) + "\n");
console.log("wrote " + out.split(path.sep).join("/"));
