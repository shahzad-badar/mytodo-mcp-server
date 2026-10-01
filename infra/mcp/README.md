# MCP server infrastructure

This directory holds the Terraform for the MCP server. It is a **separate Terraform
root** with its own state and its own apply. The other roots are:

- the optional edge gateway in [`../gateway`](../gateway)
- alerting in [`../monitoring`](../monitoring)
- DNS in [`../dns`](../dns)

Roots pass values to each other as plain variables. They never share state.

The state is an object at the `mcp/` prefix of the environment's state bucket.
The bucket is `<prefix>-<env>-tfstate` in your tools project. The backend block
names no bucket, so every `init` must supply one. See [`../README.md`](../README.md).

## What it provisions

- The GCP APIs it uses.
- An Artifact Registry Docker repository.
- A **deployer** service account with least privilege. It holds
  `artifactregistry.writer` on the repository, `run.admin` on the service, and
  `serviceAccountUser` on the runtime SA only.
- A **runtime** service account. The service runs as this account. It holds nothing.
- The deployer's Workload Identity binding. This root does **not** create the pool.
  One shared pool in the tools project serves every environment. Its provider is
  pinned to your repository. This root binds the deployer to that pool's
  `attribute.environment/<github_environment>` principalSet. No other repository
  and no other environment can impersonate the deployer.
- Read access on the repository for `image_reader_service_accounts`. Dev sets
  this list to prod's deployer. A promotion to prod can then copy the image that
  dev already ran.
- The Cloud Run service. The deploy workflow owns its image and environment.
  Terraform ignores them.

## Reaching the service

`cloud_run_ingress` defaults to `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`. This
setting lets only a load balancer reach the service.

- Apply [`../gateway`](../gateway) after this root. The service is unreachable
  without the gateway. The service fails closed. It never becomes public by accident.
- Set `INGRESS_TRAFFIC_ALL` if you delete `../gateway`.
- CI refuses to plan the internal-only setting without a gateway root.

## Adding a data store

The template's tools store nothing. A data store for your tools belongs in
**this** root. Add these items:

- the data store resources
- the API it needs
- a grant to the runtime SA scoped to that one resource (an IAM condition, not a
  project-wide role)

Add the role that your apply SA needs to create the store to
[`../bootstrap/apply-roles.txt`](../bootstrap/apply-roles.txt). Then re-run
`scripts/bootstrap-env.sh`. The plan's apply-identity check fails if the role is
missing.

Step 4 of the template README covers the server side of the same change.

## Usage

[`terraform.yml`](../../.github/workflows/terraform.yml) plans this root on every
pull request. It applies the root on dispatch. You normally do not run it yourself.
Run these commands for a break-glass apply by hand:

```sh
terraform init -backend-config="bucket=<prefix>-<env>-tfstate"
terraform plan -var-file=env/<env>.tfvars -out=tfplan
terraform apply tfplan
```

Then publish the outputs into the environment's GitHub variables. See
[`../README.md`](../README.md).

```sh
terraform output
```
