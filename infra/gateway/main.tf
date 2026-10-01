# ../mcp admits only load balancer traffic, so these Cloud Armor rules guard the service.
# The service stays unreachable until this root is applied.

# This root does not write the DNS record, so its plan needs no DNS credential.

terraform {
  required_version = ">= 1.5"
  # The bucket comes from -backend-config at init, as in ../mcp/main.tf.
  backend "gcs" {
    prefix = "gateway"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  # Each excluded path adds a guard that skips the OWASP signatures for that path.
  waf_path_guard = join("", [for path in var.waf_excluded_paths : "request.path != '${path}' && "])
}

resource "google_project_service" "compute" {
  project            = var.project_id
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_compute_region_network_endpoint_group" "mcp" {
  name                  = "${var.service_name}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = var.service_name
  }
  depends_on = [google_project_service.compute]
}

resource "google_compute_security_policy" "mcp" {
  name        = "${var.service_name}-waf"
  description = "Rate limiting and WAF for the MCP gateway."
  depends_on  = [google_project_service.compute]

  # Cloud Armor accepts at most 10 ranges per rule, so the list is split into chunks.
  dynamic "rule" {
    for_each = chunklist(var.allowed_caller_ip_ranges, 10)
    content {
      action      = "throttle"
      priority    = 1000 + rule.key
      description = "Admit the allowed ranges, rate limited per IP"
      preview     = false
      match {
        versioned_expr = "SRC_IPS_V1"
        config {
          src_ip_ranges = rule.value
        }
      }
      rate_limit_options {
        conform_action = "allow"
        exceed_action  = "deny(429)"
        enforce_on_key = "IP"
        rate_limit_threshold {
          count        = var.gateway_rate_limit_per_minute
          interval_sec = 60
        }
      }
    }
  }

  # JSON-RPC bodies with markup or shell-like text can trip these signatures.
  # Add /mcp to waf_excluded_paths instead of disabling the rule.

  # One combined rule uses less SECURITY_POLICY_CEVAL_RULES quota than seven rules.
  rule {
    action      = "deny(403)"
    priority    = 900
    description = "OWASP signatures, on every path not in waf_excluded_paths"
    preview     = false
    match {
      expr {
        expression = "${local.waf_path_guard}(${join(" || ", [
          "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})",
          "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})",
          "evaluatePreconfiguredWaf('lfi-v33-stable', {'sensitivity': 1})",
          "evaluatePreconfiguredWaf('rfi-v33-stable', {'sensitivity': 1})",
          "evaluatePreconfiguredWaf('json-sqli-canary', {'sensitivity': 1})",
          "evaluatePreconfiguredWaf('cve-canary', {'sensitivity': 1})",
          "evaluatePreconfiguredWaf('rce-v33-stable', {'sensitivity': 1})",
        ])})"
      }
    }
  }

  rule {
    action      = "deny(403)"
    priority    = 2147483647
    description = "Refuse a caller no rule admitted"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

resource "google_compute_backend_service" "mcp" {
  name                  = "${var.service_name}-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  security_policy       = google_compute_security_policy.mcp.id
  backend {
    group = google_compute_region_network_endpoint_group.mcp.id
  }


  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "mcp" {
  name            = "${var.service_name}-urlmap"
  default_service = google_compute_backend_service.mcp.id
}

resource "google_compute_managed_ssl_certificate" "mcp" {
  name = "${var.service_name}-cert"
  managed {
    domains = [var.gateway_domain]
  }
  depends_on = [google_project_service.compute]
}

resource "google_compute_ssl_policy" "mcp" {
  name            = "${var.service_name}-ssl-policy"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_target_https_proxy" "mcp" {
  name             = "${var.service_name}-https-proxy"
  url_map          = google_compute_url_map.mcp.id
  ssl_certificates = [google_compute_managed_ssl_certificate.mcp.id]
  ssl_policy       = google_compute_ssl_policy.mcp.id
}

resource "google_compute_global_address" "mcp" {
  name       = "${var.service_name}-ip"
  depends_on = [google_project_service.compute]
}

resource "google_compute_global_forwarding_rule" "mcp" {
  name                  = "${var.service_name}-fwd"
  target                = google_compute_target_https_proxy.mcp.id
  ip_address            = google_compute_global_address.mcp.address
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
