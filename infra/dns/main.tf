# Every plan needs the provider credential, so Azure DNS gets a root of its own.
# A missing Azure credential then blocks only this root.

terraform {
  required_version = ">= 1.5"
  # State stays in GCS like the other roots, although the records live in Azure.
  # The bucket comes from -backend-config at init, as in ../mcp/main.tf.
  backend "gcs" {
    prefix = "dns"
  }

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id                 = var.subscription_id
  resource_provider_registrations = "none"
}

# RESOURCE_BASE_URL, the certificate and the Entra redirect URIs depend on these names.
# prevent_destroy makes a destroy or a replace fail instead of taking a hostname offline.
resource "azurerm_dns_a_record" "records" {
  for_each = var.records

  name = each.value.record_name
  # A delegated child zone shadows the same name in its parent.
  # A hostname inside a child zone must therefore be written into that zone.
  zone_name           = coalesce(each.value.zone_name, var.zone_name)
  resource_group_name = var.resource_group_name
  ttl                 = each.value.ttl
  records             = [each.value.target_ip]

  lifecycle {
    prevent_destroy = true
  }
}
