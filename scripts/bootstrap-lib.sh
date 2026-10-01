# shellcheck shell=bash
# Shared helpers for scripts/bootstrap-*.sh and scripts/check-apply-roles.sh.
# Scripts source this file and never run it directly.

# Every ensure_* function is idempotent. MODE=apply creates what is missing, and
# MODE=check changes nothing and counts each difference in DRIFT.

# shellcheck disable=SC2034 # globals set here are read by the sourcing script

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BOOTSTRAP_DIR="$REPO_ROOT/infra/bootstrap"
MODE=apply
DRIFT=0

say() { printf '%s\n' "$*"; }
ok() { printf '  \342\234\223 %s\n' "$*"; }
act() { printf '  + %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}

# Check mode counts a missing item as drift and returns 1, so the caller skips the fix.
missing() {
  if [[ $MODE == check ]]; then
    printf '  \342\234\226 %s\n' "$*"
    DRIFT=$((DRIFT + 1))
    return 1
  fi
  act "$*"
}

parse_mode() {
  for arg in "$@"; do
    [[ $arg == --check ]] && MODE=check
  done
  return 0
}

require() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null || die "$tool is required and not on PATH."
  done
}

load_config() {
  # shellcheck source=/dev/null
  source "$BOOTSTRAP_DIR/bootstrap.env"
  local name
  for name in PREFIX TOOLS_PROJECT GITHUB_REPO STATE_BUCKET_LOCATION; do
    [[ -n ${!name:-} && ${!name} != REPLACE_ME ]] ||
      die "$name is not set in infra/bootstrap/bootstrap.env."
  done
  [[ $PREFIX =~ ^[a-z][a-z0-9-]{3,19}$ ]] ||
    die "PREFIX must be 4-20 lowercase letters, digits or hyphens, starting with a letter."
  [[ $GITHUB_REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
    die "GITHUB_REPO must be owner/name."

  PLAN_SA="$PREFIX-tf-plan@$TOOLS_PROJECT.iam.gserviceaccount.com"
  TF_POOL_ID="$PREFIX-tf-github"
  DEPLOY_POOL_ID="$PREFIX-deploy-github"
}

# All per-environment names derive from the environment name. This stops a step from
# pairing one environment's bucket with another environment's identity.
env_names() {
  local env=$1
  [[ $env =~ ^[a-z][a-z0-9-]*$ ]] || die "environment must be a lowercase GitHub Environment name, e.g. dev."
  ENV_NAME=$env
  ENV_SUFFIX=$(printf '%s' "$env" | tr 'a-z-' 'A-Z_')
  STATE_BUCKET="$PREFIX-$env-tfstate"
  APPLY_SA_ID="$PREFIX-tf-apply-$env"
  APPLY_SA="$APPLY_SA_ID@$TOOLS_PROJECT.iam.gserviceaccount.com"
}

# This reads only flat `key = "value"` lines. It is not a general HCL parser.
tfvar() {
  local file=$1 key=$2
  sed -n -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\"([^\"]*)\".*/\1/p" "$file" | head -n1
}

env_project() {
  local file="$REPO_ROOT/infra/mcp/env/$ENV_NAME.tfvars"
  [[ -f $file ]] || die "$file does not exist. Copy infra/mcp/env/dev.tfvars for a new environment."
  ENV_PROJECT=$(tfvar "$file" project_id)
  [[ -n $ENV_PROJECT && $ENV_PROJECT != REPLACE_ME ]] ||
    die "set project_id in infra/mcp/env/$ENV_NAME.tfvars first."
}

# ROOT_ORDER sets the apply order. Deleting a root directory removes that root from
# bootstrap, CI and the role check.
ROOT_ORDER=(mcp gateway monitoring dns)
present_roots() {
  local root
  for root in "${ROOT_ORDER[@]}"; do
    [[ -f "$REPO_ROOT/infra/$root/main.tf" ]] && printf '%s\n' "$root"
  done
  for dir in "$REPO_ROOT"/infra/*/; do
    root=$(basename "$dir")
    [[ -f "$dir/main.tf" && " ${ROOT_ORDER[*]} " != *" $root "* ]] && printf '%s\n' "$root"
  done
  return 0
}

required_roles() {
  local roots=" $* "
  grep -v -E '^[[:space:]]*(#|$)' "$BOOTSTRAP_DIR/apply-roles.txt" |
    while read -r role root _; do
      [[ $root == "*" || $roots == *" $root "* ]] && printf '%s\n' "$role"
    done | sort -u
}

words() { xargs <<<"$1"; }

strip_comments() { grep -v -E '^[[:space:]]*(#|$)' "$1"; }

project_number() {
  gcloud projects describe "$1" --format='value(projectNumber)'
}

# IAM grants can take a minute or more to propagate. The retry stops a first run
# from failing on a grant it has just made.
with_iam_retry() {
  local what=$1
  shift
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9; do
    if "$@"; then return 0; fi
    [[ $attempt == 9 ]] && break
    warn "$what failed; waiting 10s for IAM to propagate (attempt $attempt/9)"
    sleep 10
  done
  die "$what still failing after ~90s. Run this script again with --check to see what is missing."
}

# The preflight tests every permission before any change. A run therefore holds
# all permissions or changes nothing.
preflight_permissions() {
  local project=$1 scope=$2
  local wanted
  wanted=$(strip_comments "$BOOTSTRAP_DIR/operator-permissions.txt" | awk -v s="$scope" '$1 == s { print $2 }')
  [[ -n $wanted ]] || return 0
  local body granted missing_perms
  body=$(printf '%s\n' "$wanted" | jq -R . | jq -s '{permissions: .}')
  granted=$(curl -sS -X POST \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "https://cloudresourcemanager.googleapis.com/v1/projects/$project:testIamPermissions" |
    jq -r '.permissions // [] | .[]')
  missing_perms=$(comm -23 <(printf '%s\n' "$wanted" | sort -u) <(printf '%s\n' "$granted" | sort -u))
  if [[ -n $missing_perms ]]; then
    printf '\nThe account running this (%s) is missing, on %s:\n' "$(gcloud config get-value account 2>/dev/null)" "$project" >&2
    # shellcheck disable=SC2086 # one permission per word
    printf '  %s\n' $missing_perms >&2
    die "nothing was changed. See infra/bootstrap/operator-permissions.txt for roles that grant these."
  fi
  ok "operator holds every permission needed on $project"
}

# Domain-restricted sharing rejects members with an error that names no policy.
# This function only warns because many orgs allow the members we add.
warn_org_policy() {
  local project=$1 policy
  policy=$(gcloud resource-manager org-policies describe iam.allowedPolicyMemberDomains \
    --project="$project" --effective --format=json 2>/dev/null || true)
  if [[ -n $policy ]] && printf '%s' "$policy" | jq -e '.listPolicy.allowedValues | length > 0' >/dev/null 2>&1; then
    warn "$project enforces iam.allowedPolicyMemberDomains (domain-restricted sharing)."
    warn "If a grant below fails with 'do not belong to a permitted customer', that policy is"
    warn "why: ask your org admin to allow Workload Identity principals on this project."
  fi
}

ensure_apis() {
  local project=$1 list=$2
  local absent api todo=()
  absent=$(comm -23 \
    <(strip_comments "$list" | sort -u) \
    <(gcloud services list --enabled --project="$project" --format='value(config.name)' | sort -u))
  if [[ -z $absent ]]; then
    ok "APIs enabled on $project"
    return 0
  fi
  for api in $absent; do
    missing "API $api on $project" && todo+=("$api")
  done
  if ((${#todo[@]})); then
    gcloud services enable "${todo[@]}" --project="$project" --quiet
  fi
  return 0
}

ensure_sa() {
  local project=$1 id=$2 display=$3
  if gcloud iam service-accounts describe "$id@$project.iam.gserviceaccount.com" --project="$project" >/dev/null 2>&1; then
    ok "service account $id"
  elif missing "service account $id"; then
    gcloud iam service-accounts create "$id" --project="$project" --display-name="$display" --quiet
  fi
  return 0
}

has_project_role() {
  local project=$1 member=$2 role=$3
  gcloud projects get-iam-policy "$project" --flatten='bindings[].members' \
    --filter="bindings.members:$member AND bindings.role:$role" \
    --format='value(bindings.role)' | grep -qx "$role"
}

ensure_project_role() {
  local project=$1 member=$2 role=$3
  if has_project_role "$project" "$member" "$role"; then
    ok "$role for ${member#*:} on $project"
  elif missing "$role for ${member#*:} on $project"; then
    with_iam_retry "granting $role" gcloud projects add-iam-policy-binding "$project" \
      --member="$member" --role="$role" --condition=None --quiet >/dev/null
  fi
  return 0
}

ensure_sa_binding() {
  local project=$1 sa=$2 member=$3 role=$4
  if gcloud iam service-accounts get-iam-policy "$sa" --project="$project" --format=json |
    jq -e --arg m "$member" --arg r "$role" '.bindings // [] | any(.role == $r and (.members | index($m)))' >/dev/null; then
    ok "$role on ${sa%%@*} for ${member##*/}"
  elif missing "$role on ${sa%%@*} for ${member##*/}"; then
    with_iam_retry "binding $role on $sa" gcloud iam service-accounts add-iam-policy-binding "$sa" \
      --project="$project" --member="$member" --role="$role" --quiet >/dev/null
  fi
  return 0
}

ensure_bucket_binding() {
  local bucket=$1 member=$2 role=$3
  if gcloud storage buckets get-iam-policy "gs://$bucket" --format=json |
    jq -e --arg m "$member" --arg r "$role" '.bindings // [] | any(.role == $r and (.members | index($m)))' >/dev/null; then
    ok "$role on $bucket for ${member#*:}"
  elif missing "$role on $bucket for ${member#*:}"; then
    with_iam_retry "granting $role on $bucket" gcloud storage buckets add-iam-policy-binding "gs://$bucket" \
      --member="$member" --role="$role" --quiet >/dev/null
  fi
  return 0
}

# The attribute condition pins trust to this repository. A provider with a
# different condition counts as drift.
ensure_pool() {
  local pool=$1 display=$2 mapping=$3
  local condition="assertion.repository == \"$GITHUB_REPO\""
  if gcloud iam workload-identity-pools describe "$pool" --project="$TOOLS_PROJECT" --location=global >/dev/null 2>&1; then
    ok "workload identity pool $pool"
  elif missing "workload identity pool $pool"; then
    gcloud iam workload-identity-pools create "$pool" --project="$TOOLS_PROJECT" \
      --location=global --display-name="$display" --quiet
  fi

  local current
  if current=$(gcloud iam workload-identity-pools providers describe github-oidc \
    --project="$TOOLS_PROJECT" --location=global --workload-identity-pool="$pool" \
    --format='value(attributeCondition)' 2>/dev/null); then
    if [[ $current == "$condition" ]]; then
      ok "provider $pool/github-oidc pinned to $GITHUB_REPO"
    elif missing "provider $pool/github-oidc condition is '$current', want '$condition'"; then
      gcloud iam workload-identity-pools providers update-oidc github-oidc \
        --project="$TOOLS_PROJECT" --location=global --workload-identity-pool="$pool" \
        --attribute-mapping="$mapping" --attribute-condition="$condition" --quiet
    fi
  elif missing "provider $pool/github-oidc"; then
    gcloud iam workload-identity-pools providers create-oidc github-oidc \
      --project="$TOOLS_PROJECT" --location=global --workload-identity-pool="$pool" \
      --issuer-uri="https://token.actions.githubusercontent.com" \
      --attribute-mapping="$mapping" --attribute-condition="$condition" --quiet
  fi
  return 0
}

pool_name() {
  printf 'projects/%s/locations/global/workloadIdentityPools/%s' "$(project_number "$TOOLS_PROJECT")" "$1"
}

finish() {
  if [[ $MODE == check ]]; then
    if ((DRIFT > 0)); then
      say ""
      say "$DRIFT difference(s). Run without --check to fix them."
      exit 1
    fi
    say ""
    say "No drift."
  fi
}
