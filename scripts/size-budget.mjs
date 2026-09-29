#!/usr/bin/env node
/**
 * Bundle size budget.
 *
 *   node scripts/size-budget.mjs            # fail if a built file is over budget
 *   node scripts/size-budget.mjs --update   # reset budgets to current size + 10%
 *
 * Measures the gzip size of every publishable package's ESM entry points
 * (after `pnpm build`) plus the extra files listed in
 * scripts/size-budget.json (the wallet-engine worker bundle, which runs with
 * the private key in scope and should stay small). A file over its budget
 * fails: either the growth is intended — run --update and say why in the
 * commit — or something was bundled that should not have been.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const budgetFile = join(root, "scripts", "size-budget.json");
const HEADROOM = 1.1;

function esmOf(entry) {
  if (typeof entry === "string") return /\.m?js$/.test(entry) ? entry : null;
  if (!entry || typeof entry !== "object") return null;
  return esmOf(entry.import) ?? esmOf(entry.default) ?? null;
}

function measuredFiles(extra) {
  const files = new Set(extra);
  for (const dir of readdirSync(join(root, "packages")).sort()) {
    const manifestPath = join(root, "packages", dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private || !manifest.exports) continue;
    const entries =
      typeof manifest.exports === "object"
        ? Object.entries(manifest.exports)
        : [[".", manifest.exports]];
    for (const [entry, target] of entries) {
      const file = esmOf(target);
      if (!file || entry.includes("*")) continue;
      files.add(relative(root, join(root, "packages", dir, file)));
    }
  }
  return [...files].sort();
}

function gzipBytes(file) {
  const path = join(root, file);
  if (!existsSync(path)) {
    throw new Error(`${file} is missing; run pnpm build first.`);
  }
  return gzipSync(readFileSync(path), { level: 9 }).length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = existsSync(budgetFile)
    ? JSON.parse(readFileSync(budgetFile, "utf8"))
    : { extra: [], budgets: {} };
  const files = measuredFiles(config.extra ?? []);
  if (process.argv.includes("--update")) {
    const budgets = {};
    for (const file of files) {
      budgets[file] = Math.ceil((gzipBytes(file) * HEADROOM) / 1024) * 1024;
    }
    writeFileSync(
      budgetFile,
      `${JSON.stringify({ ...config, budgets }, null, 2)}\n`,
    );
    console.log(`Budgets reset for ${files.length} files.`);
  } else {
    const over = [];
    for (const file of files) {
      const size = gzipBytes(file);
      const budget = config.budgets?.[file];
      if (budget === undefined) {
        over.push(`${file}: no budget (${size} B gzip); run --update.`);
      } else if (size > budget) {
        over.push(`${file}: ${size} B gzip, budget ${budget} B.`);
      }
    }
    if (over.length > 0) {
      console.error(over.join("\n"));
      process.exit(1);
    }
    console.log(`Size budget: ${files.length} files within budget.`);
  }
}
