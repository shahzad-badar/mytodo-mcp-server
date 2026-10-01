variable "project_id" {
  type        = string
  description = "GCP project ID hosting the Cloud Run service; the gateway lands in the same project."
}

variable "region" {
  type        = string
  description = "Region of the Cloud Run service the NEG points at. Must match ../mcp's region."
  default     = "us-central1"
}

variable "service_name" {
  type        = string
  description = "Name of the Cloud Run service created by ../mcp; also prefixes every gateway resource name. Must match ../mcp's service_name."
  default     = "mcp-server"
}

variable "gateway_domain" {
  type        = string
  description = "Hostname the gateway serves, e.g. mcp.example.com: the managed certificate's domain, and the name the A record must be created under. This root does not write DNS — see the `gateway_ip` output."

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.gateway_domain))
    error_message = "gateway_domain must be a lowercase hostname such as mcp.example.com."
  }
}

variable "gateway_rate_limit_per_minute" {
  type        = number
  description = "Cloud Armor per-IP request rate limit per minute."
  default     = 120
}

# The variable has no default, so each environment must choose its callers.
variable "allowed_caller_ip_ranges" {
  type        = list(string)
  description = "Source CIDR ranges Cloud Armor admits. Include your MCP client's egress (Claude: 160.79.104.0/21, https://platform.claude.com/docs/en/api/ip-addresses) and your users' egress (VPN/office) if the OAuth proxy is on. Must not be empty. Use 0.0.0.0/0 to allow everyone."

  validation {
    condition     = length(var.allowed_caller_ip_ranges) > 0
    error_message = "allowed_caller_ip_ranges must not be empty. Use 0.0.0.0/0 to allow everyone."
  }

  validation {
    condition     = alltrue([for r in var.allowed_caller_ip_ranges : can(cidrhost(r, 0))])
    error_message = "Each entry must be a CIDR range, e.g. 203.0.113.7/32."
  }
}

variable "waf_excluded_paths" {
  type        = list(string)
  description = "Request paths the OWASP signatures are not evaluated on. Empty (the default) enforces them everywhere; add \"/mcp\" if your tools' arguments legitimately carry markup or shell-like text. The allowlist and rate limit still apply."
  default     = []

  validation {
    condition     = alltrue([for p in var.waf_excluded_paths : can(regex("^/[A-Za-z0-9/_.-]*$", p))])
    error_message = "Each entry must be a path starting with / and containing only letters, digits, / _ . and -."
  }
}
