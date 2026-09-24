#!/usr/bin/env node
/**
 * Release preflight — refuse to bump or publish from an incoherent state.
 *
 *   node scripts/release-preflight.mjs --pre-bump
 *   node scripts/release-preflight.mjs --expect <version>
 *
 * This repository releases every public package in lockstep. That is not a
 * convention someone wrote down — it is what `scripts/publish.sh` enforces with
 * a literal `sed` keyed on `packages/core`'s version, and it is what every
 * published release has done: the packages share one version set, and the 14
 * that existed then all skipped 0.1.4 together.
 *
 * Nothing checked that, so one package drifting out of step would be silent,
 * and the drift would compound:
 *
 *   - the `sed` stops matching the drifted package, so the next bump skips it;
 *   - the publish loop derives one version from `packages/core` and skips any
 *     package already at it — which is exactly the package that changed;
 *   - `pnpm pack` rewrites the umbrella's `workspace:*` deps to EXACT versions,
 *     so an unbumped umbrella pins the old copy of whatever did change;
 *   - the release tag comes from `packages/core` too, so it can name a version
 *     that was never published.
 *
 * There is no override flag. A failure here means the release is not safe, and
 * an escape hatch would be reached for at exactly the wrong moment.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/**
 * The immutability check always asks the public registry, never a local one.
 *
 * publish.sh can target verdaccio, but "has this version already been
 * published" has one authoritative answer, and pointing the check at an empty
 * local registry would turn it into the bypass this script exists to refuse.
 */
const REGISTRY = "https://registry.npmjs.org";

const INTERNAL_SCOPE = "@naculus/";
const WORKSPACE_SPEC = "workspace:*";
const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/** Paths whose state decides whether a version bump is safe to start. */
const RELEASE_SCOPE = [
  /^packages\/[^/]+\/package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
];

// ── Reading ──────────────────────────────────────────────────────────────

/** Every publishable workspace manifest, with its directory. */
export function readManifests(root = ROOT) {
  const pkgRoot = join(root, "packages");
  const out = [];
  for (const entry of readdirSync(pkgRoot)) {
    const dir = join(pkgRoot, entry);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private) continue;
    out.push({ dir, entry, manifest });
  }
  return out;
}

// ── Pure classifiers, exported so a harness can drive them without a repo ──

/** All publishable packages must sit on one version. */
export function classifyVersions(manifests, expected) {
  const byVersion = new Map();
  for (const { manifest } of manifests) {
    const list = byVersion.get(manifest.version) ?? [];
    list.push(manifest.name);
    byVersion.set(manifest.version, list);
  }

  if (byVersion.size !== 1) {
    const groups = [...byVersion].sort((a, b) => b[1].length - a[1].length);
    const minority = groups
      .slice(1)
      .flatMap(([v, names]) => names.map((n) => `minority: ${n} @ ${v}`));
    return {
      ok: false,
      reason: "partial bump",
      detail: [
        ...groups.map(([v, names]) => `${names.length} package(s) at ${v}`),
        ...minority,
        "A literal sed keyed on packages/core will not match the minority on",
        "the next bump, and the drift becomes permanent.",
      ],
    };
  }

  const [version] = [...byVersion.keys()];
  if (expected !== undefined && version !== expected) {
    return {
      ok: false,
      reason: "version mismatch",
      detail: [`all packages are at ${version}, expected ${expected}`],
    };
  }
  return { ok: true, version, count: manifests.length };
}

/** Internal deps must stay on the workspace protocol so pack can rewrite them. */
export function classifyInternalSpecs(manifests) {
  const offenders = [];
  let checked = 0;
  for (const { manifest } of manifests) {
    for (const field of DEP_FIELDS) {
      for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
        if (!dep.startsWith(INTERNAL_SCOPE)) continue;
        checked++;
        if (spec !== WORKSPACE_SPEC) {
          offenders.push(
            `${manifest.name} → ${dep}: "${spec}" (${field}), expected "${WORKSPACE_SPEC}"`,
          );
        }
      }
    }
  }
  return offenders.length ? { ok: false, reason: "pinned internal dep", detail: offenders, checked } : { ok: true, checked };
}

/**
 * Registry immutability.
 *
 * `states` is one `{ name, published }` per package. A mixed result is the
 * worst case: it is the exact state in which publish.sh's loop prints
 * "skipping" for the ones that exist and exits 0, leaving the changed package
 * unpublished.
 */
export function classifyRegistryState(states) {
  const yes = states.filter((s) => s.published);
  if (yes.length === 0) return { ok: true, kind: "none-published" };
  if (yes.length === states.length) {
    return {
      ok: false,
      reason: "version already fully published",
      kind: "fully-published",
      detail: [
        "all packages are already on the registry at this version",
        "npm versions are immutable — choose a new version",
      ],
    };
  }
  return {
    ok: false,
    reason: "partial publish incident",
    kind: "partial-publish",
    detail: [
      `${yes.length}/${states.length} already on the registry at this version`,
      ...yes.map((s) => `published: ${s.name}`),
      ...states.filter((s) => !s.published).map((s) => `missing:   ${s.name}`),
      'publish.sh would print "skipping" for the published ones and exit 0.',
    ],
  };
}

/** The release tag must not exist yet, whatever the registry says. */
export function classifyTag(exists, version) {
  return exists
    ? {
        ok: false,
        reason: "tag already exists",
        detail: [
          `v${version} is already a tag in this repository`,
          "Reusing a tag detaches it from what is actually published.",
        ],
      }
    : { ok: true, version };
}

/** Working tree cleanliness, restricted to paths that decide a bump. */
export function classifyWorkingTree(porcelainLines) {
  const dirty = porcelainLines
    .map((l) => l.slice(3).trim())
    .filter((p) => p && RELEASE_SCOPE.some((re) => re.test(p.replaceAll("\\", "/"))));
  return dirty.length
    ? {
        ok: false,
        reason: "release-relevant files are modified",
        detail: dirty,
      }
    : { ok: true };
}

// ── Repository snapshots (used only by --pack-check) ─────────────────────

/**
 * Every file under a package's `dist/`, recursively.
 *
 * `dist/` is gitignored, so git is blind to anything written there. A
 * top-level listing is not enough either: tsup emits into subdirectories, and
 * a worker asset appearing two levels down would go unnoticed. Symlinks are
 * recorded as links rather than followed, so a swapped target still shows up.
 */
function distEntries(root, dir, prefix, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = `${prefix}/${name}`;
    const st = lstatSync(full);
    if (st.isDirectory()) {
      out.push(`${rel}/ dir`);
      distEntries(root, full, rel, out);
    } else if (st.isSymbolicLink()) {
      out.push(`${rel} symlink ${st.size}`);
    } else {
      const hash = createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16);
      out.push(`${rel} file ${st.size} ${hash}`);
    }
  }
}

/** A content fingerprint of every package's `dist/` tree. */
function distFingerprint(root) {
  const out = [];
  for (const { dir, manifest } of readManifests(root)) {
    const distDir = join(dir, "dist");
    if (!existsSync(distDir)) {
      out.push(`${manifest.name}: (no dist)`);
      continue;
    }
    distEntries(root, distDir, relative(root, distDir).replaceAll("\\", "/"), out);
  }
  return out.join("\n");
}

/**
 * Everything needed to prove the repository is unchanged afterwards.
 *
 * Deliberately comparative, not absolute: the working tree is usually dirty
 * when this runs, and "clean" is not the property being asserted. "Unchanged"
 * is. Four views, because no one of them sees everything:
 *
 *   porcelain — new untracked files, e.g. a stray .tgz if --pack-destination
 *               were ignored
 *   worktree  — exact patch text of tracked files against the index
 *   index     — exact patch text of the index against HEAD
 *   inventory — `git ls-files -s`: mode and blob id of every tracked file,
 *               which catches a permission change that produces no diff text
 *   dist      — the one place git cannot see, hashed recursively
 */
function snapshotRepo(root) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  return {
    porcelain: git(["status", "--porcelain"]),
    worktree: git(["diff"]),
    index: git(["diff", "--cached"]),
    inventory: git(["ls-files", "-s"]),
    dist: distFingerprint(root),
  };
}

/**
 * Which parts of the snapshot moved, and which paths they name.
 *
 * Reports and stops. It never restores, stashes, resets, checks out or cleans:
 * an automatic repair here would be undoing something it does not understand,
 * and the evidence is worth more than the tidiness.
 */
export function diffSnapshots(before, after) {
  const views = ["porcelain", "worktree", "index", "inventory", "dist"];
  const changed = views.filter((v) => before[v] !== after[v]);
  if (changed.length === 0) return { ok: true };

  const paths = new Set();
  const added = (key, transform = (l) => l.trim()) => {
    const seen = new Set(before[key].split("\n"));
    for (const line of after[key].split("\n")) {
      if (line && !seen.has(line)) paths.add(transform(line));
    }
  };
  added("porcelain");
  added("inventory", (l) => l.split("\t").pop() ?? l);
  added("dist");

  return {
    ok: false,
    reason: "packing mutated the repository",
    detail: [
      `changed view(s): ${changed.join(", ")}`,
      ...[...paths].slice(0, 20),
      ...(paths.size > 20 ? [`… and ${paths.size - 20} more`] : []),
      "Left in place deliberately. Inspect it rather than trusting an",
      "automatic restore to have undone the right thing.",
    ],
  };
}

// ── Effectful probes ─────────────────────────────────────────────────────

function gitPorcelain(root) {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function tagExists(root, version) {
  const out = execFileSync("git", ["tag", "--list", `v${version}`], {
    cwd: root,
    encoding: "utf8",
  });
  return out.trim() !== "";
}

async function isPublished(name, version) {
  const url = `${REGISTRY}/${name.replace("/", "%2F")}/${version}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  // Anything else is unknown, and unknown must not read as "safe".
  throw new Error(`${name}: registry returned ${res.status} for ${url}`);
}

/** Minimal gzip+tar reader: pull package/package.json out of a tarball. */
function readPackedManifest(tgzPath) {
  const buf = gunzipSync(readFileSync(tgzPath));
  for (let off = 0; off + 512 <= buf.length; ) {
    const name = buf.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (!name) break;
    const raw = buf
      .toString("utf8", off + 124, off + 136)
      .replace(/\0.*$/, "")
      .trim();
    const size = Number.parseInt(raw || "0", 8);
    const body = off + 512;
    if (name === "package/package.json") {
      return JSON.parse(buf.toString("utf8", body, body + size));
    }
    off = body + Math.ceil(size / 512) * 512;
  }
  throw new Error(`no package.json inside ${tgzPath}`);
}

/**
 * Pack every package into an OS temp directory and read what pnpm actually
 * wrote. This is the only way to see the umbrella's `workspace:*` deps after
 * they are rewritten to exact versions — the source manifest never shows them.
 *
 * Requires an installed workspace: pnpm resolves `workspace:*` through the
 * node_modules links, and without them it refuses to pack at all. CI installs
 * before this runs. No package here declares a prepack/prepare hook, so this
 * does not build.
 */
function packAndInspect(root, expected) {
  const tmp = mkdtempSync(join(tmpdir(), "naculus-preflight-"));
  const problems = [];
  let count = 0;
  try {
    for (const { dir, manifest } of readManifests(root)) {
      try {
        execFileSync("pnpm", ["pack", "--pack-destination", tmp], {
          cwd: dir,
          encoding: "utf8",
          shell: process.platform === "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        // pnpm reports pack errors on stdout, not stderr.
        const output = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}`.trim();
        const hint = output.includes("CANNOT_RESOLVE_WORKSPACE_PROTOCOL")
          ? " — workspace not installed, so pnpm cannot resolve workspace:*; run pnpm install first"
          : "";
        const head = output
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 2)
          .join(" / ");
        throw new Error(`${manifest.name}: pnpm pack failed${hint}\n        ${head}`);
      }
    }

    for (const file of readdirSync(tmp).filter((f) => f.endsWith(".tgz"))) {
      const manifest = readPackedManifest(join(tmp, file));
      count++;

      if (manifest.version !== expected) {
        problems.push(`${file}: manifest version ${manifest.version}, expected ${expected}`);
      }
      const flat = manifest.name.replace("@", "").replace("/", "-");
      const wanted = `${flat}-${expected}.tgz`;
      if (file !== wanted) problems.push(`${file}: filename does not match ${wanted}`);

      for (const field of DEP_FIELDS) {
        for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
          if (!dep.startsWith(INTERNAL_SCOPE)) continue;
          if (spec !== expected) {
            problems.push(
              `${manifest.name} packs "${dep}": "${spec}" — an exact pin to a version that is not this release`,
            );
          }
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { problems, count };
}

// ── Reporting ────────────────────────────────────────────────────────────

const failed = [];
let checkCount = 0;

function report(label, result, okDetail) {
  checkCount++;
  if (result.ok) {
    console.log(`  ${"ok".padEnd(6)}${label.padEnd(24)}${okDetail}`);
    return;
  }
  console.log(`  ${"FAIL".padEnd(6)}${label.padEnd(24)}${result.reason ?? ""}`);
  for (const line of result.detail ?? []) console.log(`        ${line}`);
  failed.push(label);
}

// ── Modes ────────────────────────────────────────────────────────────────

/**
 * Cheap, offline, side-effect free. Answers one question: is this repository in
 * a fit state to start a bump? It deliberately does not consult the registry —
 * the current version being published is normal and must not block the bump
 * that moves off it.
 */
function preBump() {
  console.log("\nrelease-preflight --pre-bump\n");
  const manifests = readManifests();

  const versions = classifyVersions(manifests);
  report(
    "version consistency",
    versions,
    `${versions.count ?? "?"} package(s) at ${versions.version ?? "(mixed)"}`,
  );

  const specs = classifyInternalSpecs(manifests);
  report(
    "internal dep protocol",
    specs,
    `${specs.checked} internal specifier(s), all ${WORKSPACE_SPEC}`,
  );

  const tree = classifyWorkingTree(gitPorcelain(ROOT));
  report("release scope clean", tree, "no pending version, lockfile or workspace change");
}

/**
 * Does packing this repository produce coherent tarballs, and does it leave
 * the repository alone?
 *
 * No registry, no tags, no target version. The reference is whatever single
 * version the workspace is already on, so this can run at any point without
 * inventing a release that does not exist yet.
 *
 * Packing is the only part of `--expect` with side effects, which is why it is
 * also the only part worth being able to run — and prove — on its own.
 */
function packCheck() {
  console.log("\nrelease-preflight --pack-check\n");
  const manifests = readManifests();

  const versions = classifyVersions(manifests);
  report(
    "version consistency",
    versions,
    `${versions.count ?? "?"} package(s) at ${versions.version ?? "(mixed)"}`,
  );
  if (!versions.ok) {
    // Without one version there is no reference for the packed pins, and
    // packing anyway would only produce noise derived from that failure.
    console.log("        skipping pack: no single version to check pins against");
    return;
  }

  const before = snapshotRepo(ROOT);
  let packed = null;
  let packError = null;
  try {
    packed = packAndInspect(ROOT, versions.version);
  } catch (err) {
    packError = String(err?.message ?? err);
  }

  // Taken whether or not the pack succeeded: a pack that failed halfway can
  // still have written something, and that is exactly when it matters.
  const mutation = diffSnapshots(before, snapshotRepo(ROOT));

  if (packError !== null) {
    report("packed manifests", { ok: false, reason: "pack failed", detail: [packError] });
  } else {
    report(
      "packed manifests",
      packed.problems.length
        ? { ok: false, reason: "pin or naming drift", detail: packed.problems }
        : { ok: true },
      `${packed.count} tarball(s): readable, filename and internal pins all ${versions.version}`,
    );
  }

  report("repository unchanged", mutation, "no tracked, untracked or dist/ change");
}

/** Everything --pre-bump checks, plus what only a real pack and the registry can answer. */
async function expectVersion(expected) {
  console.log(`\nrelease-preflight --expect ${expected}\n`);
  const manifests = readManifests();

  const versions = classifyVersions(manifests, expected);
  report("version consistency", versions, `${versions.count ?? "?"} package(s) at ${expected}`);

  const specs = classifyInternalSpecs(manifests);
  report(
    "internal dep protocol",
    specs,
    `${specs.checked} internal specifier(s), all ${WORKSPACE_SPEC}`,
  );

  // Packing a mixed set only reports noise derived from the first failure.
  if (versions.ok) {
    let packed = null;
    try {
      packed = packAndInspect(ROOT, expected);
    } catch (err) {
      report("packed manifests", {
        ok: false,
        reason: "pack failed",
        detail: [String(err?.message ?? err)],
      });
    }
    if (packed) {
      report(
        "packed manifests",
        packed.problems.length
          ? { ok: false, reason: "pin or naming drift", detail: packed.problems }
          : { ok: true },
        `${packed.count} tarball(s): version, filename and internal pins all ${expected}`,
      );
    }
  }

  let states = null;
  try {
    states = await Promise.all(
      manifests.map(async ({ manifest }) => ({
        name: manifest.name,
        published: await isPublished(manifest.name, expected),
      })),
    );
  } catch (err) {
    report("registry immutability", {
      ok: false,
      reason: "registry unreachable",
      detail: [String(err?.message ?? err), "An unknown registry state is not a safe one."],
    });
  }
  if (states) {
    report(
      "registry immutability",
      classifyRegistryState(states),
      `0/${states.length} already published at ${expected}`,
    );
  }

  report(
    "tag coherence",
    classifyTag(tagExists(ROOT, expected), expected),
    `v${expected} does not exist yet`,
  );
}

// ── Entry ────────────────────────────────────────────────────────────────

async function main(argv) {
  const preBumpMode = argv.includes("--pre-bump");
  const packCheckMode = argv.includes("--pack-check");
  const expectIndex = argv.indexOf("--expect");
  const expectMode = expectIndex !== -1;

  if ([preBumpMode, packCheckMode, expectMode].filter(Boolean).length !== 1) {
    console.error(
      "usage: release-preflight.mjs (--pre-bump | --pack-check | --expect <version>)",
    );
    process.exit(2);
  }

  if (preBumpMode) {
    preBump();
  } else if (packCheckMode) {
    packCheck();
  } else {
    const expected = argv[expectIndex + 1];
    if (!expected || expected.startsWith("-")) {
      console.error("--expect requires a version, e.g. --expect 0.1.7");
      process.exit(2);
    }
    await expectVersion(expected);
  }

  console.log();
  if (failed.length) {
    console.log(`  BLOCKED — ${failed.length}/${checkCount} check(s) failed: ${failed.join(", ")}\n`);
    process.exit(1);
  }
  console.log(`  ${checkCount}/${checkCount} checks passed\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
