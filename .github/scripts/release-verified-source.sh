#!/usr/bin/env bash
# Release the commit a Release run verified even when main moved during the run.
#
# Homeboy releases the tip of the remote default branch: before it writes the
# release commit it fetches and fast-forwards. A Release run verifies one
# commit for about 20 minutes, so when merges land faster than that, the
# verified commit is never main's tip when the run finishes. The run used to
# stand down and hand off to the next queued run, which then lost the same race.
#
# This script lets the run finish the release for the commit it verified:
#
#   stage   Point `origin` at a local bare repository whose main is the verified
#           bundle commit, so `homeboy release` versions and tags exactly that
#           commit. Nothing reaches GitHub in this phase.
#   merge   Restore the GitHub remote, merge the release commit into the current
#           main, and push the merge and the release tag atomically. A rejected
#           push (main moved again) refetches and re-merges; it never forces.
#
# After `merge`, HEAD is the tagged release commit and it is reachable from
# main, so `homeboy release --head` packages and publishes it.
set -euo pipefail

bot_git() {
  git -c user.name='github-actions[bot]' \
    -c user.email='41898282+github-actions[bot]@users.noreply.github.com' "$@"
}

output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1=$2" >> "$GITHUB_OUTPUT"
  fi
}

stage() {
  local stage_dir="${RELEASE_STAGE_DIR:-${RUNNER_TEMP:-/tmp}/release-stage.git}"
  local origin_url
  origin_url="$(git remote get-url origin)"

  rm -rf "$stage_dir"
  git init --quiet --bare "$stage_dir"
  # Every release tag comes along so Homeboy derives the version and changelog
  # from the same history it would read on GitHub.
  git push --quiet "$stage_dir" HEAD:refs/heads/main 'refs/tags/*:refs/tags/*'
  git remote set-url origin "$stage_dir"
  git fetch --quiet origin
  test "$(git rev-parse origin/main)" = "$(git rev-parse HEAD)"

  output origin-url "$origin_url"
  echo "Staged $(git rev-parse --short HEAD) as main of ${stage_dir} for the release commit."
}

merge() {
  : "${ORIGIN_URL:?ORIGIN_URL is the GitHub remote URL recorded by stage}"
  : "${SOURCE_SHA:?SOURCE_SHA is the commit this run verified}"
  : "${RELEASE_TAG:?RELEASE_TAG is the tag Homeboy created on the staged commit}"
  local attempts="${MERGE_ATTEMPTS:-5}"
  local release_sha attempt

  git remote set-url origin "$ORIGIN_URL"
  release_sha="$(git rev-parse HEAD)"

  # The tag must name the release commit, and that commit must descend from the
  # verified source: the published tree is the verified tree plus version,
  # changelog and bundle files.
  test "$(git rev-parse "refs/tags/${RELEASE_TAG}^{commit}")" = "$release_sha"
  git merge-base --is-ancestor "$SOURCE_SHA" "$release_sha"

  for attempt in $(seq 1 "$attempts"); do
    git fetch --quiet origin main
    if ! git merge-base --is-ancestor "$SOURCE_SHA" origin/main; then
      echo "::error::origin/main no longer contains the verified commit ${SOURCE_SHA}; refusing to merge ${RELEASE_TAG}."
      exit 1
    fi
    git checkout --quiet --detach origin/main
    # Pull requests never touch dist/ (CI enforces it) and Homeboy owns the
    # version files and CHANGELOG.md, so the release commit's files merge
    # cleanly. A conflict means someone edited release-owned files by hand.
    if ! bot_git merge --quiet --no-ff --no-edit \
      -m "release: merge ${RELEASE_TAG} into main" "$release_sha"; then
      git merge --abort || true
      echo "::error::${RELEASE_TAG} conflicts with main. Nothing was pushed; the next Release run releases main."
      exit 1
    fi
    if git push --atomic origin HEAD:refs/heads/main "refs/tags/${RELEASE_TAG}:refs/tags/${RELEASE_TAG}"; then
      echo "::notice::Released ${RELEASE_TAG} from verified commit ${SOURCE_SHA:0:8} and merged it into main at $(git rev-parse --short HEAD)."
      git checkout --quiet --detach "$release_sha"
      return 0
    fi
    echo "main moved again (attempt ${attempt}/${attempts}); re-merging ${RELEASE_TAG}."
    sleep $((attempt * 3))
  done

  echo "::error::Could not merge ${RELEASE_TAG} into main after ${attempts} attempts."
  exit 1
}

case "${1:-}" in
  stage) stage ;;
  merge) merge ;;
  *)
    echo "usage: $0 stage|merge" >&2
    exit 2
    ;;
esac
