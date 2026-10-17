#!/usr/bin/env bash
# `omarchy plugin update` fast-forwards to the plugin repo's default branch,
# so that branch must only move on a release.
set -euo pipefail

REPO="${PLUGIN_REPO:-git@github.com:mark-omarov/omanow-plugin.git}"
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')

node scripts/build.mjs
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [[ -n ${PLUGIN_DEPLOY_KEY:-} ]]; then
  printf '%s\n' "$PLUGIN_DEPLOY_KEY" >"$work/key"
  chmod 600 "$work/key"
  export GIT_SSH_COMMAND="ssh -i $work/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
fi

git clone --quiet "$REPO" "$work/repo"
find "$work/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R dist/. "$work/repo/"

cd "$work/repo"
git add -A
if git diff --cached --quiet; then
  echo "plugin repo already at $version"
  exit 0
fi
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet -m "release: v$version"
git tag -a "v$version" -m "v$version"
git push --quiet origin HEAD "v$version"
echo "published plugin v$version"
