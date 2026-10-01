# Deployment checklist

This checklist deploys the server to dev, then to prod. Follow the steps in order. [infra/README.md](../infra/README.md) gives the details of each infrastructure step.

## Before you start

- [ ] A GCP project for the tools. Terraform identities and state live there.
- [ ] A GCP project per environment (dev, prod).
- [ ] `roles/owner` on these projects, or the permissions in `infra/bootstrap/operator-permissions.txt`.
- [ ] The Application Administrator role in Entra ID, or a tenant admin for the consent step.
- [ ] A domain you control. You choose one hostname per environment, for example `my-mcp-dev.example.com`.
- [ ] Write access to the DNS zone of this domain.
- [ ] `gcloud`, `terraform`, `az`, `jq`, `uuidgen`, `curl`, `gh`.

## Dev

### 1. Entra ID

- [ ] Create the resource app and the client app. See [entra-apps.md](entra-apps.md).
- [ ] Assign your group to a role on the resource app.
- [ ] Note the tenant id, the resource app id and the client app id.

### 2. Repository configuration

- [ ] Fill in `PREFIX`, `TOOLS_PROJECT` and `GITHUB_REPO` in `infra/bootstrap/bootstrap.env`. Commit the file.
- [ ] Run `scripts/bootstrap-tools.sh`. It runs once for all environments.
- [ ] Set the repository secrets that the script prints.

### 3. Dev inputs

Replace every `REPLACE_ME` in `infra/*/env/dev.tfvars`.

| File | Values |
|---|---|
| `infra/mcp/env/dev.tfvars` | `project_id`, `wif_pool` (printed by `bootstrap-tools.sh`) |
| `infra/gateway/env/dev.tfvars` | `project_id`, `gateway_domain` (the dev hostname), `allowed_caller_ip_ranges` |
| `infra/monitoring/env/dev.tfvars` | `project_id`, `alert_email_addresses`, `allowed_caller_ip_ranges` |
| `infra/dns/env/dev.tfvars` | Azure subscription, resource group and zone. Delete `infra/dns` if the zone is not in Azure DNS. |

`allowed_caller_ip_ranges` contains Claude's range and your users' IPs. Terraform refuses an empty list.

### 4. Dev bootstrap

- [ ] Run `scripts/bootstrap-env.sh dev`.
- [ ] Run `scripts/bootstrap-dns.sh dev` if you kept `infra/dns`.
- [ ] Set the variables and secrets that the scripts print.
- [ ] Create the `dev` GitHub Environment. Restrict its deployment branches to `main`.
- [ ] Run `gh variable set ENABLED_ENVIRONMENTS --body dev`.

### 5. Infrastructure

- [ ] Open a pull request with the changes in `infra/`. Read the plans. Merge.
- [ ] Run the **Terraform** workflow for `dev` on `mcp`, then `gateway`, then `monitoring`, then `dns`.
- [ ] Create the DNS A record. The name is `gateway_domain`. The target is the `gateway_ip` output of `gateway`. Add the record to `dns/env/dev.tfvars` and apply `dns` again if you use `infra/dns`.
- [ ] Wait for the managed certificate to be `ACTIVE`. Google issues it after the DNS record resolves.

### 6. Deploy variables

Set these values on the `dev` GitHub Environment.

| Name | Type | Value |
|---|---|---|
| `GCP_SERVICE_ACCOUNT` | secret | `mcp` output `deploy_service_account` |
| `GCP_PROJECT_ID` | variable | dev project id |
| `GCP_REGION` | variable | `mcp` region |
| `GCP_ARTIFACT_REGISTRY_REPO` | variable | `mcp` output `artifact_registry_repo` |
| `CLOUD_RUN_SERVICE` | variable | `mcp` output `cloud_run_service` |
| `CLOUD_RUN_INVOKER_FLAG` | variable | `--allow-unauthenticated` |
| `ENTRA_TENANT_ID` | variable | tenant id |
| `RESOURCE_AUDIENCE` | variable | resource app id |
| `RESOURCE_BASE_URL` | variable | `https://<dev hostname>` |
| `SCOPES_SUPPORTED` | variable | scopes registered on the resource app |
| `OAUTH_PROXY_ENABLED` | variable | `true` |
| `ENTRA_CLIENT_ID` | variable | client app id |

`CLOUD_RUN_INVOKER_FLAG` removes the Google IAM check on Cloud Run. Cloud Run still accepts traffic from the gateway only. The server checks the Entra token on every request.

### 7. Deploy and check

- [ ] Merge a change to `main`. The **Deploy** workflow builds the image and deploys it. It skips commits that only change the paths in `paths-ignore` of `.github/workflows/deploy.yml`. These paths are `*.md`, `infra/`, `scripts/bootstrap-*.sh`, `scripts/check-*.sh` and `terraform.yml`. Run **Deploy** manually on `main` to deploy without a code change.
- [ ] Run `curl -i -X POST https://<dev hostname>/mcp`. The answer must be `401` with a `WWW-Authenticate` header.
- [ ] Add a custom connector in Claude with `https://<dev hostname>/mcp`. Sign in. Call the `ping` tool.

| Result | Cause |
|---|---|
| Connection error | The DNS record or the certificate is not ready. |
| `403` HTML page from Google | Cloud Run is closed, or Cloud Armor refused your IP. |
| `200` without a token | Stop. The server does not check tokens. |

## Prod

Prod never builds an image. It deploys the image that dev built for a given commit SHA.

### 1. Entra ID and inputs

- [ ] Create a new resource app and a new client app for prod. See [entra-apps.md](entra-apps.md).
- [ ] Replace every `REPLACE_ME` in `infra/*/env/prod.tfvars`, as in dev step 3.

### 2. Bootstrap

- [ ] Run `scripts/bootstrap-env.sh prod`, and `scripts/bootstrap-dns.sh prod` if you kept `infra/dns`.
- [ ] Set the variables and secrets that the scripts print.
- [ ] Create the `prod` GitHub Environment. Add required reviewers. Restrict its deployment branches to `main`.
- [ ] Run `gh variable set ENABLED_ENVIRONMENTS --body "dev prod"`.

### 3. Infrastructure

- [ ] Open a pull request with the prod tfvars. Read the plans. Merge.
- [ ] Run the **Terraform** workflow for `prod` on `mcp`, then `gateway`, then `monitoring`, then `dns`. A reviewer approves each apply.
- [ ] Create the DNS A record for the prod hostname, as in dev step 5.
- [ ] Wait for the prod certificate to be `ACTIVE`.

### 4. Promotion access

- [ ] Add the prod `mcp` output `deploy_service_account` to `image_reader_service_accounts` in `infra/mcp/env/dev.tfvars`. Open a pull request. Merge.
- [ ] Run the **Terraform** workflow for `dev`, root `mcp`. Prod can then read dev images.

### 5. Deploy

- [ ] Set the prod deploy variables, as in dev step 6. Add `PROMOTE_SOURCE_IMAGE` with the dev `mcp` output `image_repository`.
- [ ] Find the SHA of the last successful dev deployment:

  ```sh
  gh run list --workflow deploy.yml --status success --limit 1 --json headSha --jq '.[0].headSha'
  ```

- [ ] Run **Verify promotion access** with this SHA.
- [ ] Run **Deploy to prod** with this SHA.
- [ ] Run the checks of dev step 7 on the prod hostname.

Always give the SHA. A blank SHA selects the last commit on `main`. That commit has no image if **Deploy** skipped it.

## Rollback

Run **Deploy to prod** with the SHA of an earlier successful dev deployment.

## Add a user

Assign the user or their group to a role on the resource app. No deployment is needed.
