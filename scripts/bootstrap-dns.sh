#!/usr/bin/env bash
# Gives Terraform CI an Azure DNS credential for infra/dns. Skip it if you deleted
# that root. Run it once per environment after bootstrap-env.sh.

#   scripts/bootstrap-dns.sh dev           # create what is missing
#   scripts/bootstrap-dns.sh dev --check   # change nothing, report drift

# The operator needs `az login` with rights to create app registrations and role
# assignments on the zone's resource group. The zone owner usually holds the latter.

# One read-only plan app trusts the pull_request and main subjects. Each environment's
# apply app trusts only environment:<env>, which no pull request can present.
# shellcheck source=SCRIPTDIR/bootstrap-lib.sh
source "$(dirname "$0")/bootstrap-lib.sh"
[[ $# -ge 1 && $1 != --* ]] || die "usage: $0 <env> [--check]"
load_config
env_names "$1"
shift
parse_mode "$@"
require az jq

DNS_VARS="$REPO_ROOT/infra/dns/env/$ENV_NAME.tfvars"
[[ -f $DNS_VARS ]] || die "$DNS_VARS does not exist. Is infra/dns deleted? Then you do not need this."
SUBSCRIPTION=$(tfvar "$DNS_VARS" subscription_id)
RESOURCE_GROUP=$(tfvar "$DNS_VARS" resource_group_name)
for value in "$SUBSCRIPTION" "$RESOURCE_GROUP"; do
  [[ -n $value && $value != REPLACE_ME ]] || die "set subscription_id and resource_group_name in $DNS_VARS first."
done
SCOPE="/subscriptions/$SUBSCRIPTION/resourceGroups/$RESOURCE_GROUP"
TENANT=$(az account show --subscription "$SUBSCRIPTION" --query tenantId -o tsv) ||
  die "az cannot see subscription $SUBSCRIPTION. Run az login as someone who can."

# This sets APP_ID instead of printing it, because a subshell would lose DRIFT.
ensure_app() {
  local display=$1
  APP_ID=$(az ad app list --display-name "$display" --query '[0].appId' -o tsv)
  if [[ -n $APP_ID ]]; then
    ok "app registration '$display'"
  elif missing "app registration '$display'"; then
    APP_ID=$(az ad app create --display-name "$display" --sign-in-audience AzureADMyOrg --query appId -o tsv)
  fi
  if [[ -n $APP_ID ]] && ! az ad sp show --id "$APP_ID" >/dev/null 2>&1; then
    if missing "service principal for '$display'"; then
      az ad sp create --id "$APP_ID" >/dev/null
    fi
  fi
  return 0
}

ensure_federated() {
  local app=$1 name=$2 subject=$3
  [[ -n $app ]] || return 0
  if az ad app federated-credential list --id "$app" --query "[?subject=='$subject'] | length(@)" -o tsv | grep -qx '[1-9][0-9]*'; then
    ok "federated credential $subject"
  elif missing "federated credential $subject"; then
    az ad app federated-credential create --id "$app" --parameters "$(jq -n --arg n "$name" --arg s "$subject" \
      '{name: $n, issuer: "https://token.actions.githubusercontent.com", subject: $s, audiences: ["api://AzureADTokenExchange"]}')" >/dev/null
  fi
}

ensure_role_assignment() {
  local app=$1 role=$2
  [[ -n $app ]] || return 0
  if [[ $(az role assignment list --assignee "$app" --role "$role" --scope "$SCOPE" --query 'length(@)' -o tsv 2>/dev/null) -gt 0 ]]; then
    ok "$role on $RESOURCE_GROUP"
  elif missing "$role on $RESOURCE_GROUP"; then
    with_iam_retry "assigning $role (needs roleAssignments/write on $SCOPE — ask whoever runs the zone)" \
      az role assignment create --assignee "$app" --role "$role" --scope "$SCOPE" --output none
  fi
}

say "Azure DNS for $ENV_NAME: $SCOPE ($MODE)"

say "Plan app (every environment)"
ensure_app "$PREFIX Terraform DNS (plan)"
PLAN_APP=$APP_ID
ensure_federated "$PLAN_APP" github-pull-request "repo:$GITHUB_REPO:pull_request"
# A plan dispatched from main presents this subject. The first dispatched plan fails
# with AADSTS700213 if the subject is missing.
ensure_federated "$PLAN_APP" github-main-ref "repo:$GITHUB_REPO:ref:refs/heads/main"
ensure_role_assignment "$PLAN_APP" "DNS Zone Reader"

say "Apply app ($ENV_NAME)"
ensure_app "$PREFIX Terraform DNS ($ENV_NAME)"
APPLY_APP=$APP_ID
ensure_federated "$APPLY_APP" "github-environment-$ENV_NAME" "repo:$GITHUB_REPO:environment:$ENV_NAME"
ensure_role_assignment "$APPLY_APP" "DNS Zone Contributor"

finish

cat <<NEXT

Set these on the repository — repository variables, not environment ones: the
plan job declares no environment and would read those as empty. No secret: the
credential is GitHub's OIDC token.

  gh variable set TF_ARM_CLIENT_ID_PLAN --body "$PLAN_APP"
  gh variable set TF_ARM_CLIENT_ID_$ENV_SUFFIX --body "$APPLY_APP"
  gh variable set TF_ARM_TENANT_ID_$ENV_SUFFIX --body "$TENANT"
  gh variable set TF_ARM_SUBSCRIPTION_ID_$ENV_SUFFIX --body "$SUBSCRIPTION"
NEXT
