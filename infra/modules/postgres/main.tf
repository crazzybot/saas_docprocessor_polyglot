# Document catalog: Azure Database for PostgreSQL Flexible Server 16 (the
# version CI and docker-compose test against), Entra ID authentication only,
# reachable only through a private endpoint.
#
# The managed identity's database role can't be created from here: it's made
# with pgaadauth_create_principal by an Entra admin connected to the server,
# which is only reachable from inside the VNet. See
# infra/scripts/create-postgres-role.sh.

resource "azurerm_postgresql_flexible_server" "this" {
  name                          = var.name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  version                       = "16"
  sku_name                      = var.sku_name
  storage_mb                    = var.storage_mb
  auto_grow_enabled             = true
  backup_retention_days         = var.backup_retention_days
  geo_redundant_backup_enabled  = var.geo_redundant_backup_enabled
  public_network_access_enabled = false
  zone                          = "1"
  tags                          = var.tags

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = false
    tenant_id                     = var.tenant_id
  }

  dynamic "high_availability" {
    for_each = var.zone_redundant_ha ? [1] : []
    content {
      mode                      = "ZoneRedundant"
      standby_availability_zone = "2"
    }
  }

  # Sunday 03:00 UTC, aligned with the AKS maintenance windows.
  maintenance_window {
    day_of_week  = 0
    start_hour   = 3
    start_minute = 0
  }

  # An HA failover swaps the primary and standby zones; don't fight it.
  lifecycle {
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }
}

resource "azurerm_postgresql_flexible_server_active_directory_administrator" "this" {
  server_name         = azurerm_postgresql_flexible_server.this.name
  resource_group_name = var.resource_group_name
  tenant_id           = var.tenant_id
  object_id           = var.admin_group_object_id
  principal_name      = var.admin_group_name
  principal_type      = "Group"
}

resource "azurerm_postgresql_flexible_server_database" "docprocessor" {
  name      = "docprocessor"
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_private_endpoint" "postgres" {
  name                = "pe-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.private_endpoint_subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "psc-${var.name}"
    private_connection_resource_id = azurerm_postgresql_flexible_server.this.id
    subresource_names              = ["postgresqlServer"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "default"
    private_dns_zone_ids = [var.private_dns_zone_id]
  }
}
