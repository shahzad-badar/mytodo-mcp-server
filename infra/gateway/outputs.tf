output "gateway_ip" {
  description = "Gateway load-balancer IP. Point an A record for `gateway_domain` at this (../dns, or by hand). Nothing serves and the managed certificate cannot go ACTIVE until that record resolves."
  value       = google_compute_global_address.mcp.address
}

output "gateway_domain" {
  description = "FQDN served by the gateway. Set RESOURCE_BASE_URL and the client's connector URL to https://<this>/mcp."
  value       = var.gateway_domain
}
