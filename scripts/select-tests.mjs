#!/usr/bin/env node
// Decide which tests CI runs for the files changed since a git ref.
//
// Prints one of:
//   ALL           shared files changed (deps, configs, fixtures, this script, CI) → full suite
//   NONE          nothing that affects tests changed (docs only)
//   <files...>    changed src/ and tests/ files, for `vitest related --run <files>`, which runs
//                 every test that imports them (directly or not) plus changed test files
//
// Usage: node scripts/select-tests.mjs <base-ref>
import { execFileSync } from "node:child_process";

const SHARED = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig.*\.json$/,
  /^vitest\.config\.ts$/,
  /^eslint\.config\.js$/,
  /^\.github\/workflows\//,
  /^scripts\/select-tests\.mjs$/,
  /^tests\/fixtures\//,
];

/** @param {string[]} files */
export function select(files) {
  if (files.some((f) => SHARED.some((re) => re.test(f)))) return "ALL";
  const relevant = files.filter((f) => /^(src|tests)\/.*\.ts$/.test(f));
  return relevant.length ? relevant.join(" ") : "NONE";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2];
  if (!base || /^0+$/.test(base)) {
    console.log("ALL"); // first push of a branch: no usable base
  } else {
    try {
      const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=d", base, "HEAD"], {
        encoding: "utf8",
      });
      console.log(
        select(
          out
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        ),
      );
    } catch {
      console.log("ALL"); // unknown base (force push, shallow clone)
    }
  }
}
