# MCP gateway (optional edge)

This root puts an external HTTPS load balancer with **Cloud Armor** in front of the
Cloud Run service from [`../mcp`](../mcp). Cloud Armor applies:

- a source-IP allowlist
- a per-IP rate limit
- the OWASP rulesets at sensitivity 1

The root has its own state (`gateway/` in the environment's state bucket). Apply it
**after** `../mcp`.

## Why it is the default

`../mcp` ships with `cloud_run_ingress = INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`.
The `run.app` URL therefore does not serve the internet. This load balancer is the
only way in. The service is unreachable until you apply this root. The service fails closed.

You can run without the gateway:

1. Delete this directory.
2. Set `cloud_run_ingress = "INGRESS_TRAFFIC_ALL"` in `../mcp/env/<env>.tfvars`.

Callers then reach the service at its `run.app` URL. The application's OAuth layer is
its only protection. CI refuses to plan the internal-only ingress without a gateway
root. That combination deploys a service that nothing can reach.

## Cloud Armor rules

| Priority | Rule |
|---|---|
| 900 | OWASP signatures (SQLi, XSS, LFI, RFI, JSON-SQLi, CVE, RCE), deny 403, on every path not in `waf_excluded_paths` |
| 1000+ | Admit `allowed_caller_ip_ranges`, throttled to `gateway_rate_limit_per_minute` per IP (429 over it), one rule per 10 ranges |
| default | Deny 403 |

**Who to allow.** Two callers reach this edge.

- The MCP client's backend. Claude uses the range `160.79.104.0/21`.
- The user's browser. It calls `/authorize` from the user's IP address when the OAuth proxy is on.

Replace `REPLACE_ME` in `env/*.tfvars` and `../monitoring/env/*.tfvars` with
your users' egress IPs. Users outside these ranges cannot sign in.

Terraform refuses an empty list. Write `0.0.0.0/0` to allow everyone.

The Bentley VPN (GlobalProtect) uses the IPs below.

```
64.90.224.37/32
8.245.134.74/32
131.203.190.66/32
195.35.229.210/32
64.90.233.10/32
34.145.45.12/32
64.90.237.1/32
64.90.234.10/32
210.57.65.90/32
72.15.52.106/32
82.135.155.59/32
```

**WAF false positives.** The rules are enforced, not previewed.

- A JSON-RPC body can carry markup or shell-like text in its tool arguments. That
  text can match a signature.
- The caller then gets a 403 from Google Frontend, not from your server.
- Add `/mcp` to `waf_excluded_paths` if your tools receive such text. The
  allowlist, the rate limit and every application check still apply.
- Read the load balancer's logs for `enforcedSecurityPolicy.outcome="DENY"` to
  diagnose. Each entry names the signature that matched.

## DNS

This root does not write DNS. Do these steps after the first apply:

1. Read the `gateway_ip` output.
2. Create an A record for `gateway_domain` that points at that IP. Use
   [`../dns`](../dns) if your zone is in Azure DNS. Create the record by hand for
   a zone hosted anywhere else.
3. Wait for the managed certificate to reach `ACTIVE`. It needs the record to
   resolve first. This can take a while.
4. Set the environment's `RESOURCE_BASE_URL` variable to `https://<gateway_domain>`.
5. Set the client's connector URL to `https://<gateway_domain>/mcp`.
