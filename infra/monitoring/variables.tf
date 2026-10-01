variable "project_id" {
  type        = string
  description = "GCP project the Cloud Run service runs in; the policies read its metrics and logs."
}

variable "region" {
  type        = string
  description = "Region of the Cloud Run service. Shapes the provider only; policies match on service name."
  default     = "us-central1"
}

variable "service_name" {
  type        = string
  description = "Cloud Run service name of the MCP server. Must match ../mcp's service_name."
  default     = "mcp-server"
}

variable "display_name" {
  type        = string
  description = "Human name for the server, prefixed to every policy, the channels and the dashboard."
  default     = "MCP server"
}

variable "alert_email_addresses" {
  type        = list(string)
  description = "Addresses every policy notifies, one channel per address. A group, never a person: who is on call is then a membership change rather than an apply."

  validation {
    condition     = length(var.alert_email_addresses) > 0
    error_message = "At least one address is required; a policy with no channel fires silently, which is worse than no policy."
  }
}

variable "server_error_threshold" {
  type        = number
  description = "5xx responses in five minutes above which the server-error policy fires. Not zero: one failure during a revision switch is normal, a run of them is not."
  default     = 5
}

variable "client_error_threshold" {
  type        = number
  description = "4xx responses in five minutes above which the refusal policy fires. Well above the routine 401 that opens every MCP handshake, low enough that a broken scope or role shows within one window."
  default     = 50
}

variable "latency_threshold_seconds" {
  type        = number
  description = "95th-percentile request latency, in seconds, above which the latency policy fires."
  default     = 10
}

variable "allowed_caller_ip_ranges" {
  type        = list(string)
  description = "The same ranges as ../gateway. The edge-denial alert counts only refused callers from these ranges. Must not be empty. Use 0.0.0.0/0 to count every refusal."

  validation {
    condition     = length(var.allowed_caller_ip_ranges) > 0
    error_message = "allowed_caller_ip_ranges must not be empty. Use 0.0.0.0/0 to count every refusal."
  }

  validation {
    condition     = alltrue([for cidr in var.allowed_caller_ip_ranges : can(cidrhost(cidr, 0))])
    error_message = "Each entry must be a CIDR range, e.g. 203.0.113.7/32."
  }
}
