# This file sets the dev inputs of the gateway root. Apply ../../mcp first.
# project_id, region and service_name must match the values in ../../mcp.

project_id   = "REPLACE_ME"
region       = "us-central1"
service_name = "mcp-server"

# The gateway serves this hostname. Create its DNS record after the first apply.
gateway_domain = "REPLACE_ME"

# Cloud Armor allows these source IPs. List Claude and your users' VPN.
allowed_caller_ip_ranges = [
  "160.79.104.0/21", # https://platform.claude.com/docs/en/api/ip-addresses
  "REPLACE_ME",      # your users' VPN egress IPs, see infra/gateway/README.md
]

# gateway_rate_limit_per_minute = 120
# waf_excluded_paths            = ["/mcp"]
