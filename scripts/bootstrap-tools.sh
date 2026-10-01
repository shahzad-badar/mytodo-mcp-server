#!/usr/bin/env bash
# Creates the shared GitHub Workload Identity pools and the read-only plan identity
# in the tools project. Run it once before the first environment.

#   scripts/bootstrap-tools.sh           # create what is missing
#   scripts/bootstrap-tools.sh --check   # change nothing, report drift

# The deploy pool maps the GitHub Environment, so a job without one never reaches a
# deployer. The Terraform pool maps the ref, so only main reaches an apply identity.
# shellcheck source=SCRIPTDIR/bootstrap-lib.sh
source "$(dirname "$0")/bootstrap-lib.sh"
parse_mode "$@"
require gcloud jq curl
load_config

say "Tools project $TOOLS_PROJECT ($MODE)"
preflight_permissions "$TOOLS_PROJECT" tools
warn_org_policy "$TOOLS_PROJECT"
ensure_apis "$TOOLS_PROJECT" "$BOOTSTRAP_DIR/tools-apis.txt"

say "Terraform CI"
ensure_pool "$TF_POOL_ID" "Terraform CI" \
  "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref"
ensure_sa "$TOOLS_PROJECT" "$PREFIX-tf-plan" "Terraform plan (read-only), every environment"
TF_POOL=$(pool_name "$TF_POOL_ID")
# Any ref in the repository reaches the plan identity, so a pull request can plan.
# The roles/viewer grant from bootstrap-env.sh limits what that identity can do.
ensure_sa_binding "$TOOLS_PROJECT" "$PLAN_SA" \
  "principalSet://iam.googleapis.com/$TF_POOL/attribute.repository/$GITHUB_REPO" \
  roles/iam.workloadIdentityUser

say "Deploys"
ensure_pool "$DEPLOY_POOL_ID" "Deploys" \
  "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment"
DEPLOY_POOL=$(pool_name "$DEPLOY_POOL_ID")

finish

TOOLS_NUMBER=$(project_number "$TOOLS_PROJECT")
cat <<NEXT

Set these on the repository (Settings → Secrets and variables → Actions):

  gh secret set TF_WORKLOAD_IDENTITY_PROVIDER --body "projects/$TOOLS_NUMBER/locations/global/workloadIdentityPools/$TF_POOL_ID/providers/github-oidc"
  gh secret set TF_PLAN_SERVICE_ACCOUNT --body "$PLAN_SA"
  gh secret set DEPLOY_WORKLOAD_IDENTITY_PROVIDER --body "projects/$TOOLS_NUMBER/locations/global/workloadIdentityPools/$DEPLOY_POOL_ID/providers/github-oidc"

And in every infra/mcp/env/<env>.tfvars:

  wif_pool = "$DEPLOY_POOL"

Next: scripts/bootstrap-env.sh dev
NEXT
