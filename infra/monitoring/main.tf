# Every service in local.services shares the notification channels in this root.

# Google's uptime probes cannot pass the Cloud Armor allowlist.
# The alerts therefore read Cloud Run metrics and logs instead.

terraform {
  required_version = ">= 1.5"
  # The bucket comes from -backend-config at init. See ../README.md.
  backend "gcs" {
    prefix = "monitoring"
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

resource "google_project_service" "monitoring" {
  project            = var.project_id
  service            = "monitoring.googleapis.com"
  disable_on_destroy = false
}

locals {
  # A second service needs an entry here and in application_error_kinds.
  services = {
    mcp = var.service_name
  }

  # Each service logs unexpected request failures under this kind (src/server.ts, emitError).
  application_error_kinds = {
    mcp = "mcp-request-error"
  }

  channels = [for channel in google_monitoring_notification_channel.email : channel.id]

  # A log filter has no CIDR operator, so each range uses an exact ip_in_net match.
  # Substring matching on an address would admit unrelated strings.
  edge_denial_clauses = [
    for cidr in var.allowed_caller_ip_ranges : "ip_in_net(httpRequest.remoteIp, \"${cidr}\")"
  ]

  edge_denial_filter = join(" AND ", concat([
    "resource.type=\"http_load_balancer\"",
    "jsonPayload.enforcedSecurityPolicy.outcome=\"DENY\"",
    "resource.labels.backend_service_name=\"${var.service_name}-backend\"",
    ], length(local.edge_denial_clauses) > 0
    ? ["(${join(" OR ", local.edge_denial_clauses)})"]
    : []
  ))
}

resource "google_logging_metric" "edge_denials" {
  project = var.project_id
  name    = "${replace(var.service_name, "-", "_")}_edge_denials"
  filter  = local.edge_denial_filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.alert_email_addresses)

  project      = var.project_id
  display_name = "${var.display_name} alerts (${each.value})"
  type         = "email"
  labels = {
    email_address = each.value
  }

  depends_on = [google_project_service.monitoring]
}

resource "google_monitoring_alert_policy" "server_errors" {
  for_each = local.services

  project      = var.project_id
  display_name = "${var.display_name} ${each.key}: server errors"
  combiner     = "OR"

  conditions {
    display_name = "5xx responses from ${each.value}"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${each.value}\"",
        "metric.type = \"run.googleapis.com/request_count\"",
        "metric.labels.response_code_class = \"5xx\""
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = var.server_error_threshold
      # The alignment period already sets the window, so a duration would only add delay.
      duration = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.labels.service_name"]
      }
    }
  }

  notification_channels = local.channels

  documentation {
    content   = "The server returned a 5xx. A 504 means a tool call exceeded REQUEST_TIMEOUT_MS. For any other 5xx, find the error line in the logs with the request id."
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "1800s"
  }

  depends_on = [google_project_service.monitoring]
}

resource "google_monitoring_alert_policy" "client_errors" {
  for_each = local.services

  project      = var.project_id
  display_name = "${var.display_name} ${each.key}: callers refused"
  combiner     = "OR"

  conditions {
    display_name = "4xx responses from ${each.value}"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${each.value}\"",
        "metric.type = \"run.googleapis.com/request_count\"",
        "metric.labels.response_code_class = \"4xx\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = var.client_error_threshold
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.labels.service_name"]
      }
    }
  }

  notification_channels = local.channels

  documentation {
    content   = "The server refuses many requests. Common causes are a missing scope, a missing role or an expired grant. The audit log names the tool and the reason."
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "1800s"
  }

  depends_on = [google_project_service.monitoring]
}

resource "google_monitoring_alert_policy" "latency" {
  for_each = local.services

  project      = var.project_id
  display_name = "${var.display_name} ${each.key}: slow responses"
  combiner     = "OR"

  conditions {
    display_name = "95th percentile latency from ${each.value}"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${each.value}\"",
        "metric.type = \"run.googleapis.com/request_latencies\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = var.latency_threshold_seconds
      # The duration ignores single slow requests because a cold start is slow.
      duration = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["resource.labels.service_name"]
      }
    }
  }

  notification_channels = local.channels

  documentation {
    content   = "The server responds slowly. Claude reports a timeout as an unreachable server. Users then see a broken connector."
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "1800s"
  }

  depends_on = [google_project_service.monitoring]
}

resource "google_monitoring_alert_policy" "application_errors" {
  for_each = local.services

  project      = var.project_id
  display_name = "${var.display_name} ${each.key}: application error"
  combiner     = "OR"

  conditions {
    display_name = "Error line logged by ${each.value}"
    condition_matched_log {
      filter = join(" AND ", [
        "resource.type=\"cloud_run_revision\"",
        "resource.labels.service_name=\"${each.value}\"",
        "severity>=ERROR",
        "jsonPayload.kind=\"${local.application_error_kinds[each.key]}\"",
      ])
    }
  }

  notification_channels = local.channels

  documentation {
    content   = "The server logged an ERROR line. The line contains the request id and the reason. It never contains a token or user data. See src/observability/log.ts."
    mime_type = "text/markdown"
  }

  # A log-match condition requires this limit, and it also stops bursts from flooding the mailbox.
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
  }

  depends_on = [google_project_service.monitoring]
}

resource "google_monitoring_alert_policy" "edge_denials" {
  project      = var.project_id
  display_name = "${var.display_name}: requests denied at the edge"
  combiner     = "OR"

  conditions {
    display_name = "Cloud Armor denied a request"
    condition_matched_log {
      filter = local.edge_denial_filter
    }
  }

  notification_channels = local.channels

  documentation {
    content   = "Cloud Armor refused a caller from the allowlist. The request never reached Cloud Run. The log entry gives the rule priority. Priority 900 is a WAF signature. Priority 1000 and above is the rate limit. This alert ignores IPs outside the allowlist. It is silent without ../gateway."
    mime_type = "text/markdown"
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
  }

  depends_on = [google_project_service.monitoring]
}
