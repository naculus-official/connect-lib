#!/bin/bash
# publish.sh — Bump version → Build (parallel) → Publish (sequential)
#
# Usage:
#   pnpm publish:local                  # verdaccio (local dev)
#   pnpm publish:github                 # GitHub Packages (CI/deploy)
#   pnpm bump:patch                     # patch bump + publish to verdaccio
#   pnpm bump:minor                     # minor bump + publish to verdaccio
#   pnpm version:show                   # show current version
#
# Env overrides:
#   VERSION=1.2.3 REGISTRY=https://npm.pkg.github.com ./scripts/publish.sh
#
# GitHub Packages auto-detects GITHUB_TOKEN from env or gh CLI.

set -e
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="${REGISTRY:-http://localhost:4873}"

# Auto-detect GITHUB_TOKEN for GitHub Packages if not set
if [[ "$REGISTRY" == *"npm.pkg.github.com"* ]] && [ -z "$GITHUB_TOKEN" ]; then
  GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "")
  [ -n "$GITHUB_TOKEN" ] && echo "🔑 Using GitHub token from gh CLI" || echo "⚠️  No GITHUB_TOKEN set"
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
                "skip (dry-run)" "cancel"; do
    case $BUMP in
      patch*) VERSION=patch; break;;
      minor*) VERSION=minor; break;;
      major*) VERSION=major; break;;
      "skip (dry-run)") VERSION=""; break;;
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
      ;;
    *) VERSION="$CURRENT" ;;
  esac
else
  VERSION="$CURRENT"
  echo "⏭️  Skipping bump (publishing $CURRENT as-is)"
fi

# Check for uncommitted changes
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "⚠️  Uncommitted changes — tag won't be created"
  UNCOMMITTED=1
else
  UNCOMMITTED=0
fi

echo "🚀 Target: $REGISTRY · Version: $VERSION"
echo ""

# Pre-publish security scan (trivy installed system-wide)
echo "=== Security scan ==="
trivy fs --scanners vuln,secret --quiet "$ROOT_DIR/packages" 2>&1 | head -5 || echo "⚠️  trivy scan skipped (install trivy for full checks)"
echo ""

# Step 1: Build everything in parallel (pnpm -r handles topological order)
echo "=== Building all packages (parallel) ==="
cd "$ROOT_DIR"
pnpm -r build 2>&1 || { echo "❌ Build failed"; exit 1; }
echo "✅ Build complete"
echo ""

# Step 2: Auto-discover packages from filesystem — no hardcoded map
# Replaces old manual mapping that breaks when packages are added
echo "=== Publishing packages (sequential) ==="
for pkg in "$ROOT_DIR"/packages/*/package.json; do
  dir=$(basename "$(dirname "$pkg")")
  PKG_NAME=$(node -p "require('$pkg').name")
  PKG_DIR="$(dirname "$pkg")"
  [[ "$PKG_NAME" == @naculus/* ]] || continue

  echo "=== Publishing $PKG_NAME ==="
  cd "$PKG_DIR"

  # Check if version already exists on registry
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$REGISTRY/$PKG_NAME/$VERSION" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "⏭️  $PKG_NAME@$VERSION already exists, skipping"
  else
    pnpm publish --no-git-checks${PROVENANCE:+ --provenance} --registry "$REGISTRY" 2>&1 && echo "✅ $PKG_NAME published" || echo "⚠️  $PKG_NAME publish failed"
  fi
  echo ""
done

echo "🎉 All done! Packages available at $REGISTRY"
echo "Test: curl -s $REGISTRY/@naculus/connect-core | jq .version"

# Git tag only if clean and version bumped
if [ "$UNCOMMITTED" = "0" ] && [ -n "$VERSION" ]; then
  git tag "v$VERSION" 2>/dev/null && echo "🏷️  Tagged v$VERSION (push manually: git push origin v$VERSION)" || echo "⏭️  Tag v$VERSION already exists"
fi