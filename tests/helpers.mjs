// Shared test helpers: run a hook as a child process with JSON on stdin,
// and build temp-dir fixtures for the parity tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOOKS = path.join(ROOT, "hooks");
export const REFERENCE = path.join(ROOT, "reference");

// Run `node <script> <args>` with `stdin` and resolve { code, stdout, stderr }.
// `cwd` sets the child's working directory, which is what the kit falls back to
// when the hook event's stdin carries no cwd.
export function runHook(script, stdin = "", { args = [], env = {}, cwd, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [script, ...args],
      { timeout, env: { ...process.env, ...env }, cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      },
    );
    child.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
  });
}

export function mkTemp(prefix = "hook-kit-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rimraf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

// Write a JSON file, making its parent folders first.
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// A project tree with a config at tree/.claude/hook-kit.json and a cwd inside it.
export function makeProject(config) {
  const root = mkTemp();
  writeJson(path.join(root, ".claude", "hook-kit.json"), config);
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd, { recursive: true });
  return { root, cwd, configFile: path.join(root, ".claude", "hook-kit.json") };
}

// Copy a reference hook into a temp dir and swap its hard-coded paths for temp ones.
// reference/ is never modified.
export function portReference(name, replacements, dir = mkTemp("hook-kit-ref-")) {
  const src = path.join(REFERENCE, name);
  let text = fs.readFileSync(src, "utf8");
  for (const [from, to] of replacements) {
    if (!text.includes(from)) throw new Error("reference " + name + " does not contain " + from);
    text = text.split(from).join(to);
  }
  const out = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, text);
  return out;
}

// Words that must appear in either stream, for a blocked case.
export function has(stderr, ...words) {
  return words.every((w) => stderr.includes(w));
}
