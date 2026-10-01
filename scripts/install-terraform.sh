#!/usr/bin/env bash
# Installs the pinned Terraform CLI onto PATH for the rest of the job. Many org
# allowlists block hashicorp/setup-terraform, so this script verifies a pinned download.

# The pin keeps the provider lock and plan output stable. Prod must not follow "latest".
set -euo pipefail

TERRAFORM_VERSION="1.15.9"
TERRAFORM_SHA256="76edd0b22d2f27d3d2e097cd793209646f719cf60f02ff3af626b07361137da1"
TERRAFORM_ZIP="terraform_${TERRAFORM_VERSION}_linux_amd64.zip"

# RUNNER_TEMP sits outside the workspace and needs no sudo, unlike /usr/local/bin.
dest="${RUNNER_TEMP:-/tmp}"
zip="$dest/$TERRAFORM_ZIP"

curl -fsSLo "$zip" \
  "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/${TERRAFORM_ZIP}"
echo "$TERRAFORM_SHA256  $zip" | sha256sum --check --strict
unzip -o -q "$zip" terraform -d "$dest"
rm -f "$zip"

# The PATH change must outlive this step, so it goes to GITHUB_PATH.
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$dest" >> "$GITHUB_PATH"
fi

"$dest/terraform" version
