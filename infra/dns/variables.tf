variable "subscription_id" {
  type        = string
  description = "Azure subscription ID that contains the DNS zone. Auth is GitHub OIDC federation in CI (ARM_USE_OIDC, no client secret); `az login` locally for a break-glass apply."

  validation {
    condition     = var.subscription_id != ""
    error_message = "subscription_id must not be empty."
  }
}

variable "resource_group_name" {
  type        = string
  description = "Azure resource group holding the DNS zone."

  validation {
    condition     = var.resource_group_name != ""
    error_message = "resource_group_name must not be empty."
  }
}

variable "zone_name" {
  type        = string
  description = "Azure DNS zone that hosts this root's records by default, e.g. example.com. A record in a delegated child zone sets its own zone_name. See var.records."

  validation {
    condition     = var.zone_name != ""
    error_message = "zone_name must not be empty."
  }
}

variable "records" {
  type = map(object({
    record_name = string
    target_ip   = string
    ttl         = optional(number, 300)
    zone_name   = optional(string)
  }))
  description = "One entry per A record this root manages, keyed by a short label naming the consumer (e.g. \"mcp\"). record_name is the name within the record's zone, not the FQDN (\"my-mcp-server\" in zone example.com for my-mcp-server.example.com). target_ip must match ../gateway's gateway_ip output. zone_name defaults to var.zone_name and is set only where the hostname falls inside a **delegated child zone**, which is authoritative for its own subtree: a record written into the parent is shadowed by the delegation and never resolves. Empty until the gateway's first apply gives you an IP."
  default     = {}

  validation {
    condition     = alltrue([for r in var.records : r.record_name != "" && r.target_ip != ""])
    error_message = "Every record must have a non-empty record_name and target_ip."
  }

  # An empty override would otherwise reach the provider as an empty zone name,
  # which fails as a malformed resource id rather than as a bad input.
  validation {
    condition     = alltrue([for r in var.records : r.zone_name != ""])
    error_message = "A record's zone_name override must not be empty; omit it to use var.zone_name."
  }
}
