# This file sets the dev inputs of the DNS root.

subscription_id     = "REPLACE_ME"
resource_group_name = "REPLACE_ME"
zone_name           = "REPLACE_ME"

# Leave records empty for the first apply. Add the gateway record after the gateway apply.
records = {
  # mcp = {
  #   record_name = "my-mcp-server"
  #   target_ip   = "203.0.113.10"
  # }
}
