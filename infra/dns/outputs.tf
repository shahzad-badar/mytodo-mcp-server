output "fqdns" {
  description = "Map of consumer label to the full hostname each record answers for. Cross-check \"mcp\" against ../gateway's gateway_domain output."
  # The output reads fqdn from the provider because a record may use its own zone.
  value = { for k, v in azurerm_dns_a_record.records : k => trimsuffix(v.fqdn, ".") }
}
