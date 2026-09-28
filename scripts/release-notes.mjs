#!/usr/bin/env node
/**
 * Release notes for one version, from CHANGELOG.md.
 *
 *   node scripts/release-notes.mjs <version>
 *
 * Prints the `## <version>` section of the root CHANGELOG, then a
 * "Version bump only" list of every publishable package the section never
 * names. All packages release in lockstep, so a package with no entry
 * still gets a new version, and the notes must say so rather than leave
 * the reader to guess.
 *
 * Fails (exit 1) when the section is missing or empty: the Publish
 * workflow runs this before anything reaches npm, including on a dry run,
 * so a release without notes stops there instead of after publishing.
 *
 * The Publish workflow passes the output to `gh release create
 * --notes-file`, ahead of GitHub's generated PR list.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The body of `## <version>` (heading suffixes like "— date" allowed). */
export function extractSection(changelog, version) {
  const lines = changelog.split("\n");
  const heading = new RegExp(
    `^## \\[?${version.replace(/\./g, "\\.")}\\]?(\\s|$)`,
  );
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return body === "" ? null : body;
}

/** Publishable package names under `packages/`, sorted. */
export function publishablePackages(root) {
  const names = [];
  for (const dir of readdirSync(join(root, "packages"))) {
    let manifest;
    try {
      manifest = JSON.parse(
        readFileSync(join(root, "packages", dir, "package.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (!manifest.private) names.push(manifest.name);
  }
  return names.sort();
}

/** A package counts as named when it appears in backticks, or a subpath of it does. */
export function mentions(body, name) {
  return body.includes(`\`${name}\``) || body.includes(`\`${name}/`);
}

export function releaseNotes(changelog, packages, version) {
  const body = extractSection(changelog, version);
  if (body === null) {
    throw new Error(
      `CHANGELOG.md has no "## ${version}" section with content; write it before releasing.`,
    );
  }
  const bumpOnly = packages.filter((name) => !mentions(body, name));
  if (bumpOnly.length === 0) return `${body}\n`;
  return `${body}\n\n### Version bump only\n\n${bumpOnly
    .map((name) => `- \`${name}\``)
    .join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/release-notes.mjs <version>");
    process.exit(2);
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  try {
    process.stdout.write(
      releaseNotes(
        readFileSync(join(root, "CHANGELOG.md"), "utf8"),
        publishablePackages(root),
        version,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
