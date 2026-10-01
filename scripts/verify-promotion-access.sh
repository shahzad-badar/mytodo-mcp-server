#!/usr/bin/env bash
# Checks without changes that this environment's deployer can read the source image.
# It validates the image_reader_service_accounts grant in infra/mcp before a promotion.

# Requires SOURCE_IMAGE (an untagged registry path) and SHA (the tag).
set -euo pipefail

for var in SOURCE_IMAGE SHA; do
  if [ -z "${!var:-}" ]; then
    echo "::error::$var is not set. This check needs SOURCE_IMAGE (a registry path with no tag) and SHA." >&2
    exit 1
  fi
done

src="$SOURCE_IMAGE:$SHA"
echo "Checking read access to $src ..."

if ! digest="$(gcloud artifacts docker images describe "$src" --format='value(image_summary.digest)' 2>&1)"; then
  echo "::error::Cannot read $src. The deployer SA is missing (or lost) artifactregistry.reader on the source registry: add it to the source environment's image_reader_service_accounts in infra/mcp and apply." >&2
  echo "$digest" >&2
  exit 1
fi

echo "OK: $src resolves to $digest"
