# Contributing

0. **File an issue** or pick one with `help wanted` label.
1. **Fork → branch** — short-lived feature branches, one concern per branch.
2. **PR against main** — title prefixed with the package scope, e.g. `core: fix session expiry`.
3. **Add a changeset** — `pnpm changeset` before pushing, describe what changed and the bump level (`patch`/`minor`/`major`). CI checks it.
4. **Review** — automated checks must pass. Manual review by a maintainer.
5. **Merge** — squash merge.

## Code conventions

- Follow Biome rules (`pnpm lint` passes clean).
- New code needs a test if it would break under unexpected input.
- Hardcoded RPC URLs, chain IDs, or address strings → move to the relevant `constants.ts`.
- Abstractions need at least two consumers or a clear isolation boundary.

## Releasing

### Every PR with API/behavior changes

```sh
pnpm changeset          # pick packages, describe change, choose patch/minor/major
```

This creates a `patch/my-description.md` in `.changeset/`. Commit it with the PR.

### When cutting a release (maintainer)

```sh
pnpm changeset version          # consume all pending changesets, bump package versions
git add -A && git commit -m "vX.Y.Z"
git tag vX.Y.Z
git push origin vX.Y.Z
pnpm build                      # build all packages
pnpm publish -r                 # publish to npm (each package in topological order)
```

A changeset per PR → `pnpm changeset version` only bumps packages that actually changed. The `publish.sh` script auto-detects changeset files and runs the flow above, falling back to manual sed-based bumping if no changesets exist.
