#!/usr/bin/env bash
# Copies an image between environments' Artifact Registries with its digest unchanged.
# It exports the promoted reference as IMAGE for the deploy step.

# Requires SOURCE_IMAGE and DEST_IMAGE (untagged registry paths) and SHA (the tag).

# crane copies the manifest bytes unchanged. docker push and imagetools re-serialise
# the manifest, which can change the digest of the tested image.
set -euo pipefail

# The crane download is pinned and checksum-verified, so a deploy never follows "latest".
CRANE_VERSION="v0.21.9"
CRANE_SHA256="5c16d8ddb971cb1d5e6ed8b1e743da8224414eeba2c2762d8f1a61b2f095699e"
CRANE_TARBALL="go-containerregistry_Linux_x86_64.tar.gz"

for var in SOURCE_IMAGE DEST_IMAGE SHA; do
  if [ -z "${!var:-}" ]; then
    echo "::error::$var is not set. Promotion needs SOURCE_IMAGE, DEST_IMAGE (registry paths with no tag) and SHA." >&2
    exit 1
  fi
done

src="$SOURCE_IMAGE:$SHA"
dest="$DEST_IMAGE:$SHA"

# crane uses the Docker credential helpers from gcloud, so one call covers both registries.
gcloud auth configure-docker "${SOURCE_IMAGE%%/*},${DEST_IMAGE%%/*}" --quiet

tarball="$RUNNER_TEMP/$CRANE_TARBALL"
curl -fsSLo "$tarball" \
  "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/${CRANE_TARBALL}"
echo "$CRANE_SHA256  $tarball" | sha256sum --check --strict
tar -xzf "$tarball" -C "$RUNNER_TEMP" crane
crane="$RUNNER_TEMP/crane"

# deploy.yml builds no image for commits that touch only docs or infra/. The error of
# crane hides that cause, so this check names it.
if ! source_digest="$("$crane" digest "$src" 2>/dev/null)"; then
  echo "::error::No image tagged $SHA in $SOURCE_IMAGE." >&2
  echo "::error::That commit was never deployed to the source environment. If it changed only a path deploy.yml ignores, no image was ever built for it — promote the last commit that did deploy." >&2
  exit 1
fi

echo "Promoting $src ($source_digest) -> $dest"
"$crane" copy "$src" "$dest"
dest_digest="$("$crane" digest "$dest")"

if [ "$source_digest" != "$dest_digest" ]; then
  echo "::error::Digest changed during promotion ($source_digest -> $dest_digest): the promoted image is not the image that was tested." >&2
  exit 1
fi

# Deploy by digest because a tag can move after this check. The digest proves that
# prod runs the image dev tested.
echo "IMAGE=$DEST_IMAGE@$dest_digest" >> "$GITHUB_ENV"
