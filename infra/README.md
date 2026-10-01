# Infrastructure

This directory runs the server on Google Cloud Run. It contains:

- Terraform.
- The scripts that prepare a project for Terraform.
- The GitHub workflows that plan, apply, deploy and promote.

All of it is optional. The server builds, tests and runs without it. The
README's "Choose how much you take" section shows how to delete it cleanly.

You provide the projects:

| Project | Holds | How many |
|---|---|---|
| **Tools** | State buckets, the two GitHub Workload Identity pools, the Terraform identities | One, shared by every environment |
| **Environment** | Cloud Run, Artifact Registry, the deploy and runtime identities, the gateway, monitoring | One per environment, dev before prod |

You bring up dev completely and use it before you create prod. You then repeat
steps 3 to 7 for prod. Last, you connect the two environments for promotion.

## The roots

Each directory with a `main.tf` is a separate Terraform root. Each root has its
own state object. Apply the roots in this order:

| Root | Provisions | Without it |
|---|---|---|
| [`mcp/`](mcp) | Artifact Registry, deployer and runtime SAs, the deployer's WIF binding, the Cloud Run service | Required |
| [`gateway/`](gateway) | HTTPS load balancer with Cloud Armor (IP allowlist, rate limit, OWASP rules) | Set `cloud_run_ingress = "INGRESS_TRAFFIC_ALL"` in `mcp/`. The `run.app` URL is then the address |
| [`monitoring/`](monitoring) | Alert policies, email channels, a dashboard | No alerts |
| [`dns/`](dns) | The gateway's A record in **Azure DNS** | Create the A record by hand |

Rules for inputs:

- A root passes a value to another root as a plain variable.
- No root reads another root's state.
- Each root commits its inputs per environment in `<root>/env/<env>.tfvars`.
- These inputs are public identifiers. Reviewers see them next to the change
  that applies them.

## Two switches

| Switch | Decides |
|---|---|
| The `ENABLED_ENVIRONMENTS` repository variable, e.g. `dev` or `dev prod` | Which environments CI plans, applies and deploys. CI runs for no environment if the variable is unset, and a repository with nothing set up stays green. CI **fails** and names the missing value if an environment is listed and a value is missing |
| Whether `infra/<root>/main.tf` exists | Which roots CI manages. Delete a root's directory to stop managing it. CI, the bootstrap scripts and the role check all follow that change |

The source repository of this template is marked as a GitHub template. It plans
and deploys nothing. A repository created from the template is not marked. The
workflows in that repository run as soon as you enable an environment.

## Before you start

- Install `gcloud`, `terraform`, `az`, `jq`, `uuidgen`, `curl` and `gh`.
- Hold `roles/owner` on the tools project and on the environment's project.
  The narrower set in [`bootstrap/operator-permissions.txt`](bootstrap/operator-permissions.txt)
  also works. The scripts test every permission before they change anything.
  A run with a missing permission changes nothing.
- Create the Entra app registrations. See [../docs/entra-apps.md](../docs/entra-apps.md).

## Bringing up dev

### 1. Describe your setup

Fill in [`bootstrap/bootstrap.env`](bootstrap/bootstrap.env) with these values:

- A `PREFIX`. State bucket names are global across GCP, so choose a unique prefix.
- The tools project.
- This repository's `owner/name`.

Commit the file.

### 2. Bootstrap the tools project once

```sh
scripts/bootstrap-tools.sh
```

The script creates the Terraform pool, the deploy pool and the read-only plan
identity. It prints three repository secrets to set. It also prints the
`wif_pool` value for every `infra/mcp/env/<env>.tfvars`.

The setup uses two pools for these reasons:

- The deploy pool maps the GitHub Environment. The plan job runs on every pull
  request and declares no environment, so it can never reach a deployer.
- The Terraform pool maps the ref. Only `main` can reach an apply identity.

### 3. Fill in dev's inputs

Replace every `REPLACE_ME` in `infra/*/env/dev.tfvars`. The scripts read
`project_id` in `mcp/env/dev.tfvars` as dev's project.

### 4. Bootstrap the environment

```sh
scripts/bootstrap-env.sh dev
scripts/bootstrap-dns.sh dev    # only if you kept infra/dns
```

`bootstrap-env.sh` does the following:

- Enables the APIs that Terraform needs before it can enable its own APIs.
- Creates the state bucket, with versioning and a lifecycle rule.
- Creates `<prefix>-tf-apply-dev`.
- Grants that identity every role in
  [`bootstrap/apply-roles.txt`](bootstrap/apply-roles.txt) that your roots need.
- Gives the plan identity read access.
- Seeds an empty state object for each root. The read-only plan identity cannot
  create a state object, so CI cannot create one either.

Each script prints the next values to set:

- A repository variable.
- The `dev` GitHub Environment and its `TF_APPLY_SERVICE_ACCOUNT` secret.

Give the `dev` environment a deployment-branch rule of `main` only.

### 5. Turn dev on, and apply

```sh
gh variable set ENABLED_ENVIRONMENTS --body dev
```

Open a pull request that changes `infra/` and read the plans. Each plan first
checks that the apply identity holds every role its root needs. A missing grant
turns the pull request red and prints the fix command. You see the problem
before approval instead of as a 403 after it.

Follow these steps after the merge:

1. Dispatch **Terraform** for `dev` and each root in order. Run `mcp`, then
   `gateway`, then `monitoring`, then `dns`. The apply runs the plan from the same run.
   It does not re-read any variables.
2. The first apply for `dns` creates no records. Add the gateway's record from
   its `gateway_ip` and `gateway_domain` outputs. Apply again.
3. Wait for the managed certificate to reach `ACTIVE`.

### 6. Set the deploy variables

Set these values on the `dev` GitHub Environment. The values come from the
outputs of `mcp` and `gateway`:

| Name | Kind | Value |
|---|---|---|
| `GCP_SERVICE_ACCOUNT` | secret | `mcp` output `deploy_service_account` |
| `GCP_PROJECT_ID` | variable | dev's project |
| `GCP_REGION` | variable | `mcp`'s `region` |
| `GCP_ARTIFACT_REGISTRY_REPO` | variable | `mcp` output `artifact_registry_repo` |
| `CLOUD_RUN_SERVICE` | variable | `mcp` output `cloud_run_service` |
| `ENTRA_TENANT_ID` | variable | your tenant id |
| `RESOURCE_AUDIENCE` | variable | the resource app's client id GUID (not its App ID URI) |
| `RESOURCE_BASE_URL` | variable | `https://<gateway_domain>` |
| `SCOPES_SUPPORTED` | variable | the scopes **actually exposed** on the resource app, space-separated |
| `OAUTH_PROXY_ENABLED` | variable | `true` to connect Claude |
| `ENTRA_CLIENT_ID` | variable | the client app's id, when the proxy is on |
| `OAUTH_PROXY_ALLOWED_REDIRECT_URIS` | variable | Optional. Defaults to Claude's callback |
| `CLOUD_RUN_INVOKER_FLAG` | variable | `--allow-unauthenticated` to open the service (below) |

`SCOPES_SUPPORTED` is required and has no default. Entra refuses the whole
authorization request if it names a scope that Entra does not expose. One extra
scope therefore breaks sign-in for every tool. Register a scope in Entra first.
Then add it to the variable.

Every value is a public identifier. The deploy checks all the values before it
authenticates. It names each missing value.

### 7. Deploy, and prove auth is live

Merge a change to `main`, or run **Deploy** manually on `main`. The workflow
builds the image, pushes it and deploys it to Cloud Run.

The deploy uses `--no-allow-unauthenticated` if `CLOUD_RUN_INVOKER_FLAG` is not
set. Cloud Run IAM then answers 403 before the server sees a request. This
state is correct while nothing uses the service. Set `CLOUD_RUN_INVOKER_FLAG`
to open the service.

Cloud Run IAM requires a Google identity token. An MCP client does not have one.
The server's OAuth layer enforces access after you open the service:

- A request without a token gets 401.
- A request with a wrong scope or role gets 403.

Run this command with the service open:

```sh
curl -i -X POST https://<gateway_domain>/mcp
```

Expect **401** with `WWW-Authenticate: Bearer … resource_metadata="…"`. Other
results mean the following:

- A 403 from Google Frontend means the service is still closed, or the gateway
  refused your address.
- A connection error means DNS or the certificate is not ready.

## Adding prod

1. Fill in `infra/*/env/prod.tfvars`.
2. Run `scripts/bootstrap-env.sh prod`. Run `scripts/bootstrap-dns.sh prod` if
   you kept `infra/dns`. Create the `prod` GitHub Environment with **required
   reviewers** and a `main`-only deployment-branch rule.
3. Run `gh variable set ENABLED_ENVIRONMENTS --body "dev prod"`.
4. Apply prod's roots in order, as in step 5. Prod's applies wait for a reviewer.
   Create the prod DNS record and wait for the prod certificate.
5. **Connect promotion.** Prod never builds an image. It copies the exact image
   that dev ran, by digest. Put prod's `deploy_service_account` output into
   dev's `infra/mcp/env/dev.tfvars` as `image_reader_service_accounts`. Apply
   dev's `mcp`. Dev's state holds the grant, so a plan shows the removal if
   someone removes it.
6. Set prod's deploy variables as in step 6. Also set `PROMOTE_SOURCE_IMAGE` to
   dev's `mcp` output `image_repository`.
7. Dispatch **Verify promotion access**, then **Deploy to prod**, with the SHA
   of the last successful dev deployment. A blank SHA selects the tip of `main`.
   That commit has no image if **Deploy** skipped it.

Dispatch **Deploy to prod** with the last good SHA to roll back.

## What deploy expects

The README's "What deploy expects" section defines the full contract between
the deploy workflows and the infrastructure. It lives in the README so it
survives if you delete `infra/`. The steps above satisfy it.

## When something is refused

Run the read-only checks first. They compare the current state with the
expected state. They change nothing.

```sh
scripts/bootstrap-tools.sh --check
scripts/bootstrap-env.sh dev --check
scripts/bootstrap-dns.sh dev --check
scripts/check-apply-roles.sh dev
```

| Symptom | Likely cause |
|---|---|
| The plan's "Does the apply identity hold…" step fails | A role in `apply-roles.txt` is not granted. Run `bootstrap-env.sh <env>` |
| An apply 403s although that step passed | A resource type whose role is not in `apply-roles.txt`. Add it, re-run `bootstrap-env.sh`, re-dispatch |
| `Permission 'iam.serviceAccounts.getAccessToken' denied` at authentication | The WIF binding. Either an apply ran from a branch other than `main`, or a deploy job has no `environment:` |
| A grant fails with "do not belong to a permitted customer" | The org policy `iam.allowedPolicyMemberDomains`. The scripts warn when it is set |
| `SERVICE_DISABLED` / "API has not been used in project" | An API missing from `bootstrap/env-apis.txt` or a root's `google_project_service` |
| dns plan fails with `AADSTS700213` | The plan app is missing a federated subject. `bootstrap-dns.sh <env>` adds it |
| A first run failed and a second passed | IAM propagation. The scripts retry for about 90 seconds. Re-run after that |

The apply roles are predefined roles, not a custom role. A custom role needs a
new audit on every provider upgrade. A custom role often lets a change pass in
dev and fail with 403 in prod. These controls limit the apply identities instead:

- Each environment has its own apply identity.
- Only `main` can reach an apply identity.
- Prod's apply waits for a reviewer.

## Break-glass

An apply from a laptop bypasses review. Use it only when CI cannot run. The
backend blocks name no bucket. An `init` without a bucket fails. It cannot
reach the wrong environment.

```sh
cd infra/<root>
terraform init -reconfigure -backend-config="bucket=<prefix>-<env>-tfstate"
terraform plan -var-file=env/<env>.tfvars -out=tfplan
terraform apply tfplan
```

Never copy one environment's state into another environment to seed it. State
records the resources it manages. The copy would claim the other environment's
resources.
