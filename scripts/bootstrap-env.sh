#!/usr/bin/env bash
# Prepares one environment for Terraform CI after bootstrap-tools.sh has run.
# Run it once per environment, dev first. Re-running changes nothing.

#   scripts/bootstrap-env.sh dev           # create what is missing
#   scripts/bootstrap-env.sh dev --check   # change nothing, report drift
# shellcheck source=SCRIPTDIR/bootstrap-lib.sh
source "$(dirname "$0")/bootstrap-lib.sh"
[[ $# -ge 1 && $1 != --* ]] || die "usage: $0 <env> [--check]"
load_config
env_names "$1"
shift
parse_mode "$@"
require gcloud jq curl terraform
env_project

ROOTS=$(present_roots)
say "Environment $ENV_NAME → project $ENV_PROJECT, state in $TOOLS_PROJECT ($MODE)"
say "Roots: $(words "$ROOTS")"

preflight_permissions "$TOOLS_PROJECT" tools
preflight_permissions "$ENV_PROJECT" env
warn_org_policy "$ENV_PROJECT"
ensure_apis "$ENV_PROJECT" "$BOOTSTRAP_DIR/env-apis.txt"

say "State bucket"
if gcloud storage buckets describe "gs://$STATE_BUCKET" >/dev/null 2>&1; then
  ok "bucket $STATE_BUCKET"
elif missing "bucket $STATE_BUCKET"; then
  # This script creates the bucket because the bucket holds Terraform's own state.
  gcloud storage buckets create "gs://$STATE_BUCKET" --project="$TOOLS_PROJECT" \
    --location="$STATE_BUCKET_LOCATION" --uniform-bucket-level-access \
    --public-access-prevention --lifecycle-file="$REPO_ROOT/infra/tfstate-bucket-lifecycle.json" --quiet
fi
if [[ $MODE == apply ]] || gcloud storage buckets describe "gs://$STATE_BUCKET" >/dev/null 2>&1; then
  # Versioning makes a bad apply recoverable, and the lifecycle rule bounds its growth.
  # The create command has no versioning flag, so a separate call sets it.
  if [[ $(gcloud storage buckets describe "gs://$STATE_BUCKET" --format='value(versioning_enabled)') == True ]]; then
    ok "versioning on $STATE_BUCKET"
  elif missing "versioning on $STATE_BUCKET"; then
    gcloud storage buckets update "gs://$STATE_BUCKET" --versioning --quiet
  fi
fi

say "Terraform identities"
ensure_sa "$TOOLS_PROJECT" "$APPLY_SA_ID" "Terraform apply, $ENV_NAME"
# shellcheck disable=SC2086 # one root per word
for role in $(required_roles $ROOTS); do
  ensure_project_role "$ENV_PROJECT" "serviceAccount:$APPLY_SA" "$role"
done
ensure_project_role "$ENV_PROJECT" "serviceAccount:$PLAN_SA" roles/viewer
if [[ $MODE == apply ]] || gcloud storage buckets describe "gs://$STATE_BUCKET" >/dev/null 2>&1; then
  ensure_bucket_binding "$STATE_BUCKET" "serviceAccount:$APPLY_SA" roles/storage.objectAdmin
  # The plan identity only reads state, so plan runs with -lock=false.
  ensure_bucket_binding "$STATE_BUCKET" "serviceAccount:$PLAN_SA" roles/storage.objectViewer
fi
# Only main reaches a writing identity. A pull request presents refs/pull/<n>/merge
# and reaches only the plan identity.
ensure_sa_binding "$TOOLS_PROJECT" "$APPLY_SA" \
  "principalSet://iam.googleapis.com/$(pool_name "$TF_POOL_ID")/attribute.ref/refs/heads/main" \
  roles/iam.workloadIdentityUser

# CI cannot create the first empty state, so this script seeds it for every root.
# Never seed state from another environment because the copy claims its resources.
say "State objects"
for root in $ROOTS; do
  object="gs://$STATE_BUCKET/$root/default.tfstate"
  if gcloud storage objects describe "$object" >/dev/null 2>&1; then
    ok "state for $root"
  elif missing "state for $root"; then
    # A throwaway data dir keeps this from repointing a working copy's .terraform.
    seed_dir=$(mktemp -d)
    with_iam_retry "seeding $root" env TF_DATA_DIR="$seed_dir" terraform -chdir="$REPO_ROOT/infra/$root" \
      init -reconfigure -input=false -no-color -backend-config="bucket=$STATE_BUCKET" >/dev/null
    rm -rf "$seed_dir"
  fi
done

finish

enabled=$(gh variable get ENABLED_ENVIRONMENTS 2>/dev/null || true)
if [[ " $enabled " != *" $ENV_NAME "* ]]; then
  enabled=$(printf '%s %s' "$enabled" "$ENV_NAME" | xargs)
fi
cat <<NEXT

Set these for $ENV_NAME:

  gh variable set TF_STATE_BUCKET_$ENV_SUFFIX --body "$STATE_BUCKET"
  gh api -X PUT repos/$GITHUB_REPO/environments/$ENV_NAME >/dev/null   # creates the GitHub Environment
  gh secret set TF_APPLY_SERVICE_ACCOUNT --env "$ENV_NAME" --body "$APPLY_SA"

Fill in every REPLACE_ME in infra/*/env/$ENV_NAME.tfvars, then turn the
environment on — nothing plans or deploys for it until you do:

  gh variable set ENABLED_ENVIRONMENTS --body "$enabled"

Then: open a pull request and read the plans; apply each root by dispatching
Terraform (mcp, then gateway, monitoring, dns). infra/README.md, step 5.
NEXT
