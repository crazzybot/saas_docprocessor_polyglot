# Blob storage for raw uploads and extraction results. Entra ID only (shared
# keys and SAS disabled) and reachable only through a private endpoint.
# Containers are created through the management plane, so Terraform never
# needs data-plane access to the account.

resource "azurerm_storage_account" "this" {
  name                             = var.name
  location                         = var.location
  resource_group_name              = var.resource_group_name
  account_kind                     = "StorageV2"
  account_tier                     = "Standard"
  account_replication_type         = var.replication_type
  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  shared_access_key_enabled        = false
  default_to_oauth_authentication  = true
  allow_nested_items_to_be_public  = false
  cross_tenant_replication_enabled = false
  public_network_access            = "Disabled"
  tags                             = var.tags

  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = var.soft_delete_retention_days
    }

    container_delete_retention_policy {
      days = var.soft_delete_retention_days
    }
  }
}

resource "azurerm_storage_container" "this" {
  for_each              = toset(["raw-documents", "extraction-results"])
  name                  = each.value
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"
}

# Versioning keeps every overwrite; drop old versions after the retention
# window so deleted documents don't linger.
resource "azurerm_storage_management_policy" "this" {
  storage_account_id = azurerm_storage_account.this.id

  rule {
    name    = "expire-old-versions"
    enabled = true

    filters {
      blob_types = ["blockBlob"]
    }

    actions {
      version {
        delete_after_days_since_creation = var.soft_delete_retention_days
      }
    }
  }
}

resource "azurerm_private_endpoint" "blob" {
  name                = "pe-${var.name}-blob"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.private_endpoint_subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "psc-${var.name}-blob"
    private_connection_resource_id = azurerm_storage_account.this.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "default"
    private_dns_zone_ids = [var.private_dns_zone_id]
  }
}
