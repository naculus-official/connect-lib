#!/bin/bash
# publish.sh — prepare a lockstep release locally. It does not publish.
#
# The name is kept for muscle memory; `pnpm release:prepare` is the honest one.
# What this does:
#
#   1. refuse to run from a dirty working tree
#   2. refuse to bump unless all 14 packages already agree on one version
#   3. bump all 14 (changesets if any exist, otherwise a literal sed)
#   4. verify the bump landed on every package
#   5. tell you what to do next
#
# What it deliberately no longer does: publish, tag, or talk to a registry.
#
# It used to do all three, in the worst possible order. It bumped versions in
# the working tree, published from that uncommitted state, and then tagged —
# which tagged the commit the bump sat on top of, not the bump itself. The tag
# named a tree that did not contain the versions that had just been published.
#
# Publishing now happens in one place only: the Publish workflow, dispatched
# manually, which installs, builds, tests, runs the preflight, publishes, and
# only then tags. See CONTRIBUTING.md.

set -e
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# A literal sed keyed on packages/core's version silently skips any package
# that has already drifted, so drift compounds instead of surfacing. Refuse to
# touch versions unless all 14 currently agree.
node "$ROOT_DIR/scripts/release-preflight.mjs" --pre-bump || {
  echo "❌ release-preflight --pre-bump failed — refusing to bump"
  exit 1
}

# Refuse to run from a dirty tree at all, before anything is changed.
#
# This used to be checked after the bump and downgraded to "tag won't be
# created", which published the packages and then quietly declined to record
# what had been published.
DIRTY="$(cd "$ROOT_DIR" && git status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "❌ Working tree is not clean. Refusing to bump."
  echo ""
  echo "$DIRTY" | head -40
  LINES=$(echo "$DIRTY" | wc -l)
  [ "$LINES" -gt 40 ] && echo "   … and $((LINES - 40)) more"
  echo ""
  echo "   Commit or remove these first. Nothing is stashed, reset or cleaned"
  echo "   for you — that would be deciding on your behalf what to throw away."
  exit 1
fi

CURRENT="$(node -p "require('$ROOT_DIR/packages/core/package.json').version")"

# ── Step 0: Pick version bump ────────────────────────────────────
if [ -z "$VERSION" ]; then
  echo ""
  echo "📦 Current version: $CURRENT"
  echo "Select bump type:"
  select BUMP in "patch ($(echo $CURRENT | awk -F. '{print $1"."$2"."$3+1}'))" \
                "minor ($(echo $CURRENT | awk -F. '{print $1"."$2+1".0"}'))" \
                "major ($(echo $CURRENT | awk -F. '{print $1+1".0.0"}'))" \
                "cancel"; do
    case $BUMP in
      patch*) VERSION=patch; break;;
      minor*) VERSION=minor; break;;
      major*) VERSION=major; break;;
      cancel) echo "❌ Cancelled"; exit 0;;
    esac
  done
fi

# ── Step 1: Version bump via changesets or manual ────────────────
if ls "$ROOT_DIR"/.changeset/*.md >/dev/null 2>&1; then
  echo "📦 Detected changeset files — running pnpm changeset version"
  cd "$ROOT_DIR" && pnpm changeset version
  VERSION=$(node -p "require('$ROOT_DIR/packages/core/package.json').version")
  echo "🔼 Changesets bumped to $VERSION"
  # .changeset/config.json has "fixed": [], so changesets bumps only the
  # packages a changeset names, while the release model assumes all 14 move
  # together. Verify that rather than trusting it.
  node "$ROOT_DIR/scripts/release-preflight.mjs" --expect "$VERSION" || {
    echo "❌ changesets produced a partial bump — stopping"
    exit 1
  }
elif [ -n "$VERSION" ]; then
  # Manual bump (VERSION env set by interactive select, or CLI flag)
  case "$VERSION" in
    patch|minor|major)
      IFS='.' read -r MAJ MIN PAT <<< "$CURRENT"
      case "$VERSION" in
        patch) NEW="$MAJ.$MIN.$((PAT + 1))" ;;
        minor) NEW="$MAJ.$((MIN + 1)).0" ;;
        major) NEW="$((MAJ + 1)).0.0" ;;
      esac
      echo "🔼 Bumping $CURRENT → $NEW"
      find "$ROOT_DIR/packages" -name package.json -not -path "*/node_modules/*" \
        -exec sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/g" {} +
      VERSION="$NEW"
      # sed reports nothing when a pattern does not match, so exit 0 says only
      # that sed ran. Confirm the bump landed on every package.
      node "$ROOT_DIR/scripts/release-preflight.mjs" --expect "$NEW" || {
        echo "❌ bump did not land coherently — stopping"
        exit 1
      }
      ;;
    *)
      echo "❌ VERSION must be patch, minor or major (got \"$VERSION\")"
      exit 1
      ;;
  esac
else
  echo "❌ Nothing to prepare: no changesets present and no bump selected."
  exit 1
fi

echo ""
echo "✅ Release $VERSION has been prepared locally. Nothing has been published."
echo ""
echo "   Next:"
echo "     1. Inspect the changes:  git diff"
echo "     2. Commit and push the version bump."
echo "     3. Run the Publish workflow (Actions → Publish) with dry_run: false."
echo ""
echo "   That workflow is the only entrypoint that publishes to npm, creates the"
echo "   tag, or cuts a GitHub release — in that order, after the preflight."
