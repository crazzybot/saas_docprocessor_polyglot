# One environment of the document processing platform. Run per environment:
#
#   terraform init -backend-config=envs/prod.backend.hcl
#   terraform plan -var-file=envs/prod.tfvars
#
# The two resource groups come from bootstrap/, which also grants the
# environment's CI identity its rights on exactly those groups.

data "azurerm_client_config" "current" {}

data "azurerm_resource_group" "workload" {
  name = "rg-docprocessor-${var.environment}"
}

data "azurerm_resource_group" "network" {
  name = "rg-docprocessor-${var.environment}-network"
}

locals {
  name     = "docprocessor-${var.environment}"
  location = var.location
  tags = merge(var.tags, {
    app         = "saas-docprocessor"
    environment = var.environment
    managed-by  = "terraform"
  })

  private_dns_zones = {
    blob       = "privatelink.blob.core.windows.net"
    servicebus = "privatelink.servicebus.windows.net"
    postgres   = "privatelink.postgres.database.azure.com"
  }
}

module "network" {
  source              = "./modules/network"
  name                = local.name
  location            = local.location
  resource_group_name = data.azurerm_resource_group.network.name
  address_space       = var.vnet_address_space
  private_dns_zones   = values(local.private_dns_zones)
  tags                = local.tags
}

module "monitoring" {
  source              = "./modules/monitoring"
  name                = local.name
  location            = local.location
  resource_group_name = data.azurerm_resource_group.workload.name
  log_retention_days  = var.log_retention_days
  tags                = local.tags
}

module "registry" {
  source              = "./modules/registry"
  name                = var.acr_name
  location            = local.location
  resource_group_name = data.azurerm_resource_group.workload.name
  sku                 = var.acr_sku
  tags                = local.tags
}

module "messaging" {
  source                     = "./modules/messaging"
  name                       = var.servicebus_namespace_name
  location                   = local.location
  resource_group_name        = data.azurerm_resource_group.workload.name
  sku                        = var.servicebus_sku
  message_ttl                = var.message_ttl
  private_endpoint_subnet_id = module.network.private_endpoints_subnet_id
  private_dns_zone_id        = module.network.private_dns_zone_ids[local.private_dns_zones.servicebus]
  tags                       = local.tags
}

module "storage" {
  source                     = "./modules/storage"
  name                       = var.storage_account_name
  location                   = local.location
  resource_group_name        = data.azurerm_resource_group.workload.name
  replication_type           = var.storage_replication_type
  soft_delete_retention_days = var.blob_soft_delete_retention_days
  private_endpoint_subnet_id = module.network.private_endpoints_subnet_id
  private_dns_zone_id        = module.network.private_dns_zone_ids[local.private_dns_zones.blob]
  tags                       = local.tags
}

module "postgres" {
  source                       = "./modules/postgres"
  name                         = var.postgres_server_name
  location                     = local.location
  resource_group_name          = data.azurerm_resource_group.workload.name
  tenant_id                    = data.azurerm_client_config.current.tenant_id
  sku_name                     = var.postgres_sku_name
  storage_mb                   = var.postgres_storage_mb
  backup_retention_days        = var.postgres_backup_retention_days
  geo_redundant_backup_enabled = var.postgres_geo_redundant_backup
  zone_redundant_ha            = var.postgres_zone_redundant_ha
  admin_group_object_id        = var.postgres_admin_group_object_id
  admin_group_name             = var.postgres_admin_group_name
  private_endpoint_subnet_id   = module.network.private_endpoints_subnet_id
  private_dns_zone_id          = module.network.private_dns_zone_ids[local.private_dns_zones.postgres]
  tags                         = local.tags
}

module "aks" {
  source                                     = "./modules/aks"
  name                                       = local.name
  location                                   = local.location
  resource_group_name                        = data.azurerm_resource_group.workload.name
  network_resource_group_id                  = data.azurerm_resource_group.network.id
  tenant_id                                  = data.azurerm_client_config.current.tenant_id
  kubernetes_version                         = var.kubernetes_version
  admin_group_object_ids                     = var.aks_admin_group_object_ids
  api_server_authorized_ip_ranges            = var.api_server_authorized_ip_ranges
  node_subnet_id                             = module.network.aks_nodes_subnet_id
  pod_cidr                                   = var.pod_cidr
  service_cidr                               = var.service_cidr
  system_node_vm_size                        = var.system_node_vm_size
  apps_node_vm_size                          = var.apps_node_vm_size
  apps_node_min_count                        = var.apps_node_min_count
  apps_node_max_count                        = var.apps_node_max_count
  defender_enabled                           = var.defender_enabled
  acr_id                                     = module.registry.id
  log_analytics_workspace_id                 = module.monitoring.log_analytics_workspace_id
  prometheus_data_collection_rule_id         = module.monitoring.prometheus_data_collection_rule_id
  prometheus_data_collection_endpoint_id     = module.monitoring.prometheus_data_collection_endpoint_id
  container_insights_data_collection_rule_id = module.monitoring.container_insights_data_collection_rule_id
  tags                                       = local.tags
}

module "identities" {
  source                           = "./modules/identities"
  name                             = local.name
  location                         = local.location
  resource_group_name              = data.azurerm_resource_group.workload.name
  oidc_issuer_url                  = module.aks.oidc_issuer_url
  storage_account_id               = module.storage.id
  servicebus_namespace_id          = module.messaging.namespace_id
  extraction_jobs_queue_id         = module.messaging.extraction_jobs_queue_id
  document_service_subscription_id = module.messaging.document_service_subscription_id
  tags                             = local.tags
}

# Guard the data against an accidental destroy (or a replace forced by a
# changed immutable attribute).
resource "azurerm_management_lock" "stateful" {
  for_each = var.delete_locks_enabled ? {
    storage    = module.storage.id
    servicebus = module.messaging.namespace_id
    postgres   = module.postgres.id
  } : {}
  name       = "cannot-delete"
  scope      = each.value
  lock_level = "CanNotDelete"
  notes      = "Holds customer documents or in-flight work. Remove deliberately before deleting."
}
