# Contributing

0. **File an issue** or pick one with `help wanted` label.
1. **Fork → branch** — short-lived feature branches, one concern per branch.
2. **PR against main** — title prefixed with the package scope, e.g. `core: fix session expiry`.
3. **Describe the change in the PR** — what changed, and whether it is a patch,
   an additive minor, or breaking. There is a `pnpm changeset` step configured,
   but it is **not** wired up: `.changeset/config.json` sets `baseBranch: dev`
   while CI runs `changeset status --since=main` and the default branch is
   `master`, and the CI step ends in `|| echo` so it can never fail. Treat a
   changeset as optional documentation until that is resolved.
4. **Review** — automated checks must pass. Manual review by a maintainer.
5. **Merge** — squash merge.

## Code conventions

- Follow Biome rules (`pnpm lint` passes clean).
- New code needs a test if it would break under unexpected input.
- Hardcoded RPC URLs, chain IDs, or address strings → move to the relevant `constants.ts`.
- Abstractions need at least two consumers or a clear isolation boundary.

## Releasing

**All 14 packages release in lockstep.** They share one version, they move
together, and they are tagged once. Every published release has worked this way
— all 14 share the same version set, and all 14 skipped 0.1.4 together.

This is not free. A package with no changes still gets a new version, so the
version number tells you when a release happened, not what changed in any one
package. **The release notes have to carry that detail**, per package, including
"version bump only" for the ones that did not change. Under lockstep that is a
requirement, not a courtesy.

### Why lockstep, and why a partial bump is worse than it looks

`pnpm pack` rewrites the umbrella's `workspace:*` dependencies to **exact**
versions. If `@naculus/connect` is not bumped alongside a package it depends
on, it pins the old copy, and anyone installing the umbrella silently gets the
version you thought you had replaced.

Three more things assume a single version: `publish.sh`'s literal `sed` (keyed
on `packages/core`), its publish loop, and the release tag. A package that
drifts out of step stops matching the `sed`, so the next bump skips it too.

### Cutting a release (maintainer)

The whole sequence, end to end:

```
local prepare  ->  review  ->  commit + push  ->  Actions: Publish (workflow_dispatch)
                                                    -> preflight
                                                      -> npm publish
                                                        -> git tag
                                                          -> GitHub release
```

**1 — prepare, locally.** Nothing in this step publishes anything.

```sh
pnpm release:prepare            # interactive: pick patch / minor / major
# or, non-interactive:
pnpm bump:patch                 # also bump:minor, bump:major
```

`scripts/publish.sh` is a **prepare** script despite its name. It refuses to
start from a dirty working tree, runs `preflight --pre-bump`, bumps all 14
packages, runs `preflight --expect` to confirm the bump landed on every one of
them, and stops. It does not talk to a registry, does not publish, and does not
tag — the commands for all three were removed.

It used to do all of them, in the worst possible order: it bumped versions in
the working tree, published from that uncommitted state, then tagged, so the tag
named a commit that did not contain the versions just published.

**2 — review, then commit and push the bump.** Do not tag. Nothing should be
tagged until the packages are actually on the registry.

**3 — publish.** Run the **Publish** workflow from the Actions tab with
`dry_run: false`. `workflow_dispatch` is the only entrypoint that publishes,
tags, or cuts a release.

> **Creating a GitHub Release does not publish anything.** It used to: the
> workflow ran on `release: published`, which meant GitHub had already created
> the tag before a single package reached npm. A tag that says "someone clicked
> publish" is worse than no tag. The workflow now runs in this order and every
> step is fail-closed:
>
> ```
> release preflight  (all 14 agree · nothing published at this version · tag absent)
>   -> pnpm -r publish --provenance
>     -> git tag -a vX.Y.Z
>       -> git push origin vX.Y.Z
>         -> gh release create vX.Y.Z --generate-notes --verify-tag
> ```
>
> If the tag or the release already exists, those commands fail and the run goes
> red. There is no `|| echo "already exists"` anywhere in the path, and no flag
> to skip past one.

### `dry_run: true` checks the publish command, not the release

A dry run answers one question: **would the publish command run at all?** It
installs, builds, tests, runs `preflight --pre-bump`, and calls
`pnpm -r publish --dry-run`. It does not tag, push or cut a release.

`--pre-bump` is offline and does not pack, so a green dry run leaves these
questions unanswered:

| not checked on a dry run | which mode would check it |
| --- | --- |
| is this version already on the registry? | `--expect` |
| is the registry even reachable? | `--expect` |
| is `vX.Y.Z` still free as a tag? | `--expect` |
| do the packed manifests pin each other at this version? | `--expect`, `--pack-check` |
| does packing leave the repository unchanged? | `--pack-check` |

So a green dry run means "the workflow would get as far as calling publish". It
does **not** mean the release is safe. The full check runs only on
`dry_run: false`, before anything reaches npm.

> **There is no local publish command, and adding one would defeat the point.**
> `publish:local`, `publish:npm`, `release:patch` and `release:minor` were
> removed: they all ran `publish.sh`, which no longer publishes, so every one of
> those names described something the script could not do.

**There is no override flag on the preflight, deliberately.** A failure means
the release is not safe, and a bypass would be reached for at exactly the
moment it should not be.

### Version numbers under lockstep

| change | version | release note must contain |
| --- | --- | --- |
| patch | `X.Y.Z → X.Y.(Z+1)` | per-package sections; "version bump only" where nothing changed |
| additive API | `X.Y.Z → X.(Y+1).0` before 1.0; `X.Y.Z → X.Y.(Z+1)` after 1.0 | every new export, and which package it belongs to |
| breaking | `X.Y.Z → X.(Y+1).0` before 1.0; `X.Y.Z → (X+1).0.0` after 1.0 | a BREAKING block at the top naming the affected exports and the migration |
