#!/usr/bin/env bash
# Checks without changes that the apply identity holds every role its roots need in
# infra/bootstrap/apply-roles.txt. It prints a fix per missing role and exits non-zero.

#   scripts/check-apply-roles.sh dev            # every root present under infra/
#   scripts/check-apply-roles.sh dev gateway    # just what the gateway root needs

# terraform.yml runs this in every plan. A missing role then fails the pull request
# and not a later apply that someone already approved.
# shellcheck source=SCRIPTDIR/bootstrap-lib.sh
source "$(dirname "$0")/bootstrap-lib.sh"
[[ $# -ge 1 ]] || die "usage: $0 <env> [root...]"
load_config
env_names "$1"
shift
require gcloud
env_project

roots=${*:-$(present_roots)}
# shellcheck disable=SC2086 # one root per word
wanted=$(required_roles $roots)
held=$(gcloud projects get-iam-policy "$ENV_PROJECT" --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:$APPLY_SA" --format='value(bindings.role)' | sort -u)
absent=$(comm -23 <(printf '%s\n' "$wanted") <(printf '%s\n' "$held"))

if [[ -z $absent ]]; then
  ok "$APPLY_SA holds every role $(words "$roots") needs on $ENV_PROJECT"
  exit 0
fi

{
  say "$APPLY_SA is missing roles on $ENV_PROJECT that $(words "$roots") needs:"
  for role in $absent; do say "  $role"; done
  say ""
  say "Fix all of them (as a project IAM admin):  scripts/bootstrap-env.sh $ENV_NAME"
  say "Or one at a time:"
  for role in $absent; do
    say "  gcloud projects add-iam-policy-binding $ENV_PROJECT --member=serviceAccount:$APPLY_SA --role=$role --condition=None"
  done
} >&2
[[ -n ${GITHUB_ACTIONS:-} ]] && printf '::error title=Apply identity is missing roles::%s\n' "$(words "$absent")"
exit 1
