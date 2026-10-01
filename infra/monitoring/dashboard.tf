# The thresholds in variables.tf were set without a baseline.
# This dashboard shows normal traffic so they can be tightened.

locals {
  # Each chart shows every service so a divergence between them stands out.
  run_filter = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_count\""

  service_names = join(" OR ", [for name in values(local.services) : "resource.labels.service_name = \"${name}\""])
}

resource "google_monitoring_dashboard" "service" {
  project = var.project_id

  dashboard_json = jsonencode({
    displayName = var.display_name
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          xPos = 0, yPos = 0, width = 6, height = 4
          widget = {
            title = "Requests per second"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "${local.run_filter} AND (${local.service_names})"
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.labels.service_name"]
                    }
                  }
                }
              }]
              yAxis = { label = "req/s", scale = "LINEAR" }
            }
          }
        },
        {
          xPos = 6, yPos = 0, width = 6, height = 4
          widget = {
            title = "95th percentile latency"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_latencies\" AND (${local.service_names})"
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_PERCENTILE_95"
                      crossSeriesReducer = "REDUCE_MAX"
                      groupByFields      = ["resource.labels.service_name"]
                    }
                  }
                }
              }]
              yAxis = { label = "s", scale = "LINEAR" }
            }
          }
        },
        {
          xPos = 0, yPos = 4, width = 6, height = 4
          widget = {
            title = "Server errors (5xx)"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "${local.run_filter} AND metric.labels.response_code_class = \"5xx\" AND (${local.service_names})"
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_DELTA"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.labels.service_name"]
                    }
                  }
                }
              }]
              yAxis = { label = "responses per 5 min", scale = "LINEAR" }
            }
          }
        },
        {
          xPos = 6, yPos = 4, width = 6, height = 4
          widget = {
            title = "Callers refused (4xx)"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "${local.run_filter} AND metric.labels.response_code_class = \"4xx\" AND (${local.service_names})"
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_DELTA"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.labels.service_name"]
                    }
                  }
                }
              }]
              yAxis = { label = "responses per 5 min", scale = "LINEAR" }
            }
          }
        },
        {
          xPos = 0, yPos = 8, width = 6, height = 4
          widget = {
            title = "Denied at the edge (Cloud Armor)"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    # l7_lb_rule is the monitoring resource type for this metric.
                    # The metric's own filter matches the logging type http_load_balancer.
                    filter = "resource.type = \"l7_lb_rule\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.edge_denials.name}\""
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_DELTA"
                      crossSeriesReducer = "REDUCE_SUM"
                    }
                  }
                }
              }]
              yAxis = { label = "denials per 5 min", scale = "LINEAR" }
            }
          }
        },
        {
          xPos = 6, yPos = 8, width = 6, height = 4
          widget = {
            title = "Container instances"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/container/instance_count\" AND (${local.service_names})"
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_MEAN"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.labels.service_name"]
                    }
                  }
                }
              }]
              yAxis = { label = "instances", scale = "LINEAR" }
            }
          }
        },
      ]
    }
  })

  depends_on = [google_project_service.monitoring]
}
