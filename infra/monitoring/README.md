# Monitoring

This root provides alert policies, email channels and a dashboard for the MCP
server. It has its own state (`monitoring/` in the environment's state bucket).
It is a separate root. Every service it watches shares its notification channels.

Apply it after [`../mcp`](../mcp). It reads the service's metrics and logs by name.
`service_name` must match the service.

## What it provisions

| Policy | Fires when |
|---|---|
| Server errors | more than `server_error_threshold` 5xx in five minutes |
| Callers refused | more than `client_error_threshold` 4xx in five minutes. This means the service is up and refuses everyone. Causes include a scope, a role or an expired grant. |
| Slow responses | p95 latency above `latency_threshold_seconds` for five minutes |
| Application error | the server logs an ERROR line of kind `mcp-request-error` (`src/server.ts`). A failed MCP request and an unexpected Express error both log this kind. |
| Denied at the edge | Cloud Armor refuses a caller that `allowed_caller_ip_ranges` admits. This is a log-based metric. It stays silent if `../gateway` is not applied. |

It also provisions:

- one email channel per `alert_email_addresses` entry
- a dashboard of request rate, p95 latency, 5xx, 4xx, edge denials and instance count

It has no uptime check. The gateway's IP allowlist does not admit Google's probes.
The policies read Cloud Run's own metrics instead. Those metrics need no
reachability.

Add a second Cloud Run service to `local.services` and
`local.application_error_kinds` in `main.tf` to watch it too.

## Prerequisites

- The alert address must exist before the first apply. Terraform creates a channel
  for an address that does not resolve. That channel delivers nothing.
- The apply identity needs these roles:
  - `roles/monitoring.editor`
  - `roles/logging.configWriter` (for the log-based metric)
  - `roles/logging.viewer`

  They are in [`../bootstrap/apply-roles.txt`](../bootstrap/apply-roles.txt).
  `scripts/bootstrap-env.sh` grants them with everything else.

Delete this directory to run without monitoring. Nothing else reads it.
