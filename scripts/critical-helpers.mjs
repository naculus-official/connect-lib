#!/usr/bin/env node
/**
 * One definition per money-, key-, chain- or signing-critical helper.
 *
 *   node scripts/critical-helpers.mjs
 *
 * scripts/critical-helpers.json maps each helper name to the source files
 * allowed to define it. A definition of that name anywhere else under
 * packages/*\/src (tests excluded) fails: import the existing one instead.
 *
 * Copies drift. appkit's copy of the EIP-155 chain-ID reader lost the check
 * that refuses chain 0 while the original kept it, and nothing noticed until
 * a review compared them by hand. A listed file that no longer defines its
 * helper fails too, so the list cannot silently go stale.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (
      name === "node_modules" ||
      name === "dist" ||
      name === "__tests__" ||
      name === "wc-generated"
    ) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.(test|spec|stories)\.tsx?$/.test(name) &&
      !name.endsWith(".d.ts")
    ) {
      out.push(path);
    }
  }
  return out;
}

/** Top-level function / const definitions of `name`, as 1-based lines. */
export function definitions(source, name) {
  const re = new RegExp(
    `^(?:export\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*${name}\\b|(?:const|let)\\s+${name}\\s*[=:])`,
    "gm",
  );
  const lines = [];
  for (const m of source.matchAll(re)) {
    lines.push(source.slice(0, m.index).split("\n").length);
  }
  return lines;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(
    readFileSync(join(root, "scripts", "critical-helpers.json"), "utf8"),
  );
  const files = [];
  for (const pkg of readdirSync(join(root, "packages"))) {
    const src = join(root, "packages", pkg, "src");
    if (existsSync(src)) sources(src, files);
  }
  const problems = [];
  for (const [name, allowed] of Object.entries(config.helpers)) {
    const found = new Set();
    for (const file of files) {
      const rel = relative(root, file);
      const lines = definitions(readFileSync(file, "utf8"), name);
      if (lines.length === 0) continue;
      found.add(rel);
      if (!allowed.includes(rel)) {
        problems.push(
          `${rel}:${lines[0]} defines ${name}; import it from ${allowed.join(" or ") || "the package that owns it"} instead.`,
        );
      }
    }
    for (const rel of allowed) {
      if (!found.has(rel)) {
        problems.push(
          `${rel} no longer defines ${name}; update scripts/critical-helpers.json.`,
        );
      }
    }
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(
    `Critical helpers: ${Object.keys(config.helpers).length} names, one owner each (plus listed exceptions).`,
  );
}
