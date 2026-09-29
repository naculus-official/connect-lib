#!/usr/bin/env node
/**
 * Public API surface snapshot.
 *
 *   node scripts/api-surface.mjs           # write api-surface/<package>.txt
 *   node scripts/api-surface.mjs --check   # fail if the built packages differ
 *
 * For each publishable package, reads the type declarations of every entry
 * point in its `exports` (after `pnpm build`) and lists the names it exports.
 * The lists are committed. A change to what a package exports — a new export,
 * a removed one, a helper that leaked through `export *` — then shows up as a
 * diff in review instead of shipping unnoticed. Run it without --check and
 * commit the result when the change is intended.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "api-surface");

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Exported names of one declaration file, sorted; `type ` marks type-only. */
export function exportedNames(source) {
  const text = stripComments(source);
  const names = new Set();
  for (const m of text.matchAll(
    /export\s+(type\s+)?\{([^}]*)\}(\s*from\s*["']([^"']+)["'])?/g,
  )) {
    const typeOnly = Boolean(m[1]);
    for (const raw of m[2].split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const isType = typeOnly || part.startsWith("type ");
      const name = part
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        .trim();
      names.add(`${isType ? "type " : ""}${name}`);
    }
  }
  for (const m of text.matchAll(
    /export\s+(?:declare\s+)?(?:abstract\s+)?(function|const|let|var|class|enum|namespace|interface|type)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    const isType = m[1] === "interface" || m[1] === "type";
    names.add(`${isType ? "type " : ""}${m[2]}`);
  }
  for (const m of text.matchAll(
    /export\s+\*\s+(as\s+([\w$]+)\s+)?from\s*["']([^"']+)["']/g,
  )) {
    names.add(m[2] ? `${m[2]} (* from ${m[3]})` : `* from ${m[3]}`);
  }
  if (/export\s+default\b/.test(text)) names.add("default");
  return [...names].sort((a, b) =>
    a.replace(/^type /, "").localeCompare(b.replace(/^type /, "")),
  );
}

function typesOf(entry) {
  if (typeof entry === "string") return entry.endsWith(".d.ts") ? entry : null;
  if (!entry || typeof entry !== "object") return null;
  return (
    entry.types ??
    typesOf(entry.import) ??
    typesOf(entry.require) ??
    typesOf(entry.default) ??
    null
  );
}

function packages() {
  const found = [];
  for (const dir of readdirSync(join(root, "packages")).sort()) {
    const manifestPath = join(root, "packages", dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private) continue;
    found.push({ dir: join(root, "packages", dir), manifest });
  }
  return found;
}

function surface({ dir, manifest }) {
  const entries =
    manifest.exports && typeof manifest.exports === "object"
      ? Object.entries(manifest.exports)
      : [[".", manifest.types]];
  const lines = [];
  for (const [entry, target] of entries) {
    const types = typesOf(target);
    if (!types) continue;
    if (entry.includes("*")) {
      lines.push(`${entry}: ${types} (pattern)`);
      continue;
    }
    const file = join(dir, types);
    if (!existsSync(file)) {
      throw new Error(
        `${manifest.name}: ${types} is missing; run pnpm build first.`,
      );
    }
    lines.push(`${entry}:`);
    for (const name of exportedNames(readFileSync(file, "utf8"))) {
      lines.push(`  ${name}`);
    }
  }
  return `${manifest.name}\n${lines.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let failed = false;
  if (!check) mkdirSync(outDir, { recursive: true });
  for (const pkg of packages()) {
    const file = join(outDir, `${pkg.manifest.name.replace("/", "__")}.txt`);
    const current = surface(pkg);
    if (!check) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, current);
      continue;
    }
    const committed = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (committed === current) continue;
    failed = true;
    const before = new Set(committed.split("\n"));
    const after = new Set(current.split("\n"));
    console.error(`${pkg.manifest.name}: public API changed`);
    for (const line of after)
      if (!before.has(line)) console.error(`  + ${line.trim()}`);
    for (const line of before)
      if (!after.has(line)) console.error(`  - ${line.trim()}`);
  }
  if (failed) {
    console.error(
      "\nIf intended, run `node scripts/api-surface.mjs` and commit api-surface/.",
    );
    process.exit(1);
  }
  console.log(check ? "API surface unchanged." : `Wrote ${outDir}`);
}
