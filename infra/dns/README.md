# DNS (Azure DNS, optional)

This root writes the gateway's A record into an **Azure DNS** zone. It has its own
state (`dns/` in the environment's GCS state bucket). Only this root needs an
Azure credential. `mcp`, `gateway` and `monitoring` stay GCP-only.

**Other DNS providers.** Delete this directory if your zone is not in Azure DNS.
Create the record by hand in your provider. The record is an A record for the gateway's `gateway_domain`
output. It points at the gateway's `gateway_ip` output. Nothing else reads this
root.

## Order

The record's target is the gateway's IP. That IP exists only after
[`../gateway`](../gateway) is applied. Follow this order:

1. Apply first with `records = {}`. `env/*.tfvars` ships with this value. The
   apply provisions nothing. It proves that the Azure credentials work.
2. Apply `../gateway`. Read `gateway_ip` and `gateway_domain`.
3. Add the `mcp` record to `env/<env>.tfvars`. Apply again.

Every record has `prevent_destroy`. The connector URL, the managed certificate and
the Entra redirect URIs depend on the hostname once it is live.

**Delegated child zones.** A hostname can be inside a child zone delegated from
`zone_name`. Set `zone_name` on that record to the child zone. A record in the
parent zone does not resolve. Google then never issues the certificate. Run
`dig +short <child>.<zone> NS` to check for a delegation.

## Credentials

A GCP service account cannot authenticate to Azure. This root uses GitHub OIDC
federated credentials on Entra app registrations instead. It needs no client
secret. [`scripts/bootstrap-dns.sh`](../../scripts/bootstrap-dns.sh) creates these
apps:

| App | Count | Role | Federated on |
|---|---|---|---|
| **plan** | one, shared by every environment | `DNS Zone Reader` | the pull-request subject and the `refs/heads/main` subject |
| **apply** | one per environment | `DNS Zone Contributor` | `environment:<env>` only |

- The plan job has no `environment:`. Its subject is never environment-shaped.
- A dispatched plan fails with `AADSTS700213` if the `main` subject is missing.
- No pull request can present the apply app's `environment:<env>` subject.

The role assignments need `Microsoft.Authorization/roleAssignments/write` on the
zone's resource group. Request it from the owner of the zone.

The `azurerm` provider is configured before any refresh. This root cannot even
**plan** without a credential. Every plan and apply needs Azure for the life of
the environment.

| GitHub repository variable | Value |
|---|---|
| `TF_ARM_CLIENT_ID_PLAN` | the plan app's client id |
| `TF_ARM_CLIENT_ID_<ENV>` | that environment's apply app's client id |
| `TF_ARM_TENANT_ID_<ENV>` | the tenant owning the DNS subscription |
| `TF_ARM_SUBSCRIPTION_ID_<ENV>` | the subscription holding the zone |

These are repository variables, not environment variables. The plan job declares
no `environment:`. It would read environment-scoped values as empty.
