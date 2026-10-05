// node --test scripts/release-notes.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSection, releaseNotes } from "./release-notes.mjs";

const CHANGELOG = `# Changelog

## [Unreleased]

## 0.5.0 — 2026-09-28

### Added

- **Server** (\`@naculus/payments-x402/server\`, new entry point) — text.
- **Keys** (\`@naculus/connect-core\`) — text.

## 0.4.0 — 2026-09-26

- Older (\`@naculus/siwx\`).
`;

const PACKAGES = [
  "@naculus/connect-core",
  "@naculus/payments-x402",
  "@naculus/siwx",
];

test("takes only the requested version's section", () => {
  const body = extractSection(CHANGELOG, "0.5.0");
  assert.match(body, /^### Added/);
  assert.doesNotMatch(body, /Older/);
});

test("lists the packages the section never names as version bump only", () => {
  const notes = releaseNotes(CHANGELOG, PACKAGES, "0.5.0");
  assert.match(notes, /### Version bump only\n\n- `@naculus\/siwx`\n$/);
  // A subpath (`…/server`) names its package.
  assert.doesNotMatch(notes, /- `@naculus\/payments-x402`/);
});

test("does not match a version by prefix", () => {
  assert.equal(extractSection(CHANGELOG, "0.5"), null);
  assert.equal(extractSection("## 0.5.10\n\n- x\n", "0.5.1"), null);
});

test("treats every metacharacter in a version literally", () => {
  const changelog = `## 1.0.0+build(1)\n\n- Exact\n\n## 1x0x0build1\n\n- Different\n`;
  assert.equal(extractSection(changelog, "1.0.0+build(1)"), "- Exact");
  assert.equal(
    extractSection("## 1x0x0build1\n\n- Different\n", "1.0.0+build(1)"),
    null,
  );
});

test("refuses a missing or empty section", () => {
  assert.throws(() => releaseNotes(CHANGELOG, PACKAGES, "0.6.0"), /0\.6\.0/);
  assert.throws(
    () => releaseNotes("## 0.6.0\n\n## 0.5.0\n\n- x\n", PACKAGES, "0.6.0"),
    /no "## 0\.6\.0" section/,
  );
});
