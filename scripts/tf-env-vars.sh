#!/usr/bin/env bash
# Copies TF_<NAME>_<ENV> repository variables to unsuffixed names for later steps.
# The plan job declares no environment, so it cannot read environment-scoped variables.

# The service accounts stay secrets so a fork cannot read them. This script leaves them alone.
set -euo pipefail

: "${ENV:?ENV must be set to the environment name (dev, prod)}"
: "${TF_ROLE:?TF_ROLE must be set to plan or apply}"
: "${GITHUB_ENV:?this script only makes sense inside GitHub Actions}"

case "$TF_ROLE" in
plan | apply) ;;
*)
  echo "TF_ROLE must be plan or apply, not '$TF_ROLE'" >&2
  exit 1
  ;;
esac

# The azurerm provider reads ARM_* itself, so those names also drop the TF_ prefix.
NAMES=(
  "TF_STATE_BUCKET:STATE_BUCKET"
  "TF_ARM_TENANT_ID:ARM_TENANT_ID"
  "TF_ARM_SUBSCRIPTION_ID:ARM_SUBSCRIPTION_ID"
)

suffix=$(echo "$ENV" | tr '[:lower:]-' '[:upper:]_')

for pair in "${NAMES[@]}"; do
  source_name="${pair%%:*}_${suffix}"
  target_name="${pair##*:}"
  # An unset repository variable renders as an empty string. The caller's preflight
  # decides what is fatal.
  echo "${target_name}=${!source_name-}" >> "$GITHUB_ENV"
done

# Plan and apply use different Azure identities. TF_ARM_CLIENT_ID_PLAN names the plan app.
# An unset TF_ARM_CLIENT_ID_PLAN falls back to the per-environment app id.
client_id_name="TF_ARM_CLIENT_ID_${suffix}"
if [ "$TF_ROLE" = plan ] && [ -n "${TF_ARM_CLIENT_ID_PLAN-}" ]; then
  client_id_name="TF_ARM_CLIENT_ID_PLAN"
fi
echo "ARM_CLIENT_ID=${!client_id_name-}" >> "$GITHUB_ENV"
