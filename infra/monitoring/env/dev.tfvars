# This file sets the dev inputs of the monitoring root.

project_id   = "REPLACE_ME"
service_name = "mcp-server"
display_name = "MCP server (dev)"

# Use a group address. The address must exist before the first apply.
alert_email_addresses = ["REPLACE_ME"]

# Use the same list as ../../gateway/env/dev.tfvars.
allowed_caller_ip_ranges = [
  "160.79.104.0/21", # https://platform.claude.com/docs/en/api/ip-addresses
  "REPLACE_ME",      # your users' VPN egress IPs, see infra/gateway/README.md
]
