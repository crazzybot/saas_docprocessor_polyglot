# Plans each environment against mocked providers: catches wiring, CIDR and
# variable-validation mistakes without Azure credentials (`just infra-test`).

mock_provider "azurerm" {
  # Computed values (IDs, the cluster's identity) are needed at plan time.
  override_during = plan

  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id = "11111111-1111-1111-1111-111111111111"
      object_id = "44444444-4444-4444-4444-444444444444"
    }
  }

  mock_resource "azurerm_kubernetes_cluster" {
    defaults = {
      id              = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ContainerService/managedClusters/aks-mock"
      oidc_issuer_url = "https://westeurope.oic.prod-aks.azure.com/11111111-1111-1111-1111-111111111111/mock/"
    }
  }

  mock_resource "azurerm_virtual_network" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Network/virtualNetworks/vnet-mock"
    }
  }

  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Network/virtualNetworks/vnet-mock/subnets/snet-mock"
    }
  }

  mock_resource "azurerm_public_ip" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Network/publicIPAddresses/pip-mock"
    }
  }

  mock_resource "azurerm_nat_gateway" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Network/natGateways/ng-mock"
    }
  }

  mock_resource "azurerm_private_dns_zone" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Network/privateDnsZones/privatelink.mock.net"
    }
  }

  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.OperationalInsights/workspaces/log-mock"
    }
  }

  mock_resource "azurerm_monitor_workspace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Monitor/accounts/amw-mock"
    }
  }

  mock_resource "azurerm_monitor_data_collection_endpoint" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Insights/dataCollectionEndpoints/dce-mock"
    }
  }

  mock_resource "azurerm_monitor_data_collection_rule" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Insights/dataCollectionRules/dcr-mock"
    }
  }

  mock_resource "azurerm_container_registry" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ContainerRegistry/registries/acrmock"
    }
  }

  mock_resource "azurerm_servicebus_namespace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ServiceBus/namespaces/sb-mock"
    }
  }

  mock_resource "azurerm_servicebus_queue" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ServiceBus/namespaces/sb-mock/queues/q-mock"
    }
  }

  mock_resource "azurerm_servicebus_topic" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ServiceBus/namespaces/sb-mock/topics/t-mock"
    }
  }

  mock_resource "azurerm_servicebus_subscription" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ServiceBus/namespaces/sb-mock/topics/t-mock/subscriptions/s-mock"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Storage/storageAccounts/stmock"
    }
  }

  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-mock"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-mock"
      principal_id = "77777777-7777-7777-7777-777777777777"
      client_id    = "88888888-8888-8888-8888-888888888888"
    }
  }

  mock_data "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock"
    }
  }
}

mock_provider "azapi" {}

run "prod" {
  command = plan
  variables {
    environment                    = "prod"
    subscription_id                = "00000000-0000-0000-0000-000000000000"
    location                       = "westeurope"
    acr_name                       = "acrdocprocessor"
    storage_account_name           = "stdocprocessorprod"
    servicebus_namespace_name      = "sb-docprocessor-prod"
    postgres_server_name           = "psql-docprocessor-prod"
    aks_admin_group_object_ids     = ["22222222-2222-2222-2222-222222222222"]
    postgres_admin_group_object_id = "22222222-2222-2222-2222-222222222222"
    postgres_admin_group_name      = "docprocessor-prod-admins"
    vnet_address_space             = "10.20.0.0/16"
    apps_node_min_count            = 3
    apps_node_max_count            = 12
    acr_sku                        = "Premium"
    servicebus_sku                 = "Premium"
    storage_replication_type       = "ZRS"
    postgres_sku_name              = "GP_Standard_D2ds_v5"
    postgres_backup_retention_days = 35
    postgres_zone_redundant_ha     = true
    delete_locks_enabled           = true
  }

  assert {
    condition     = output.k8s_values.private_endpoints_cidr == "10.20.4.0/24"
    error_message = "Private endpoint subnet must be 10.20.4.0/24 (network_policy.yaml allows it)."
  }

  assert {
    condition     = output.k8s_values["service.beta.kubernetes.io/azure-pip-name"] == "pip-docprocessor-prod-gateway"
    error_message = "Gateway public IP name must match k8s/gateway.yaml."
  }

  assert {
    condition     = length(module.messaging.extraction_jobs_queue_id) > 0
    error_message = "Queue missing."
  }

  assert {
    condition     = length(azurerm_management_lock.stateful) == 3
    error_message = "Prod must lock storage, Service Bus and PostgreSQL."
  }
}

run "dev" {
  command = plan
  variables {
    environment                    = "dev"
    subscription_id                = "00000000-0000-0000-0000-000000000000"
    location                       = "westeurope"
    acr_name                       = "acrdocprocessordev"
    storage_account_name           = "stdocprocessordev"
    servicebus_namespace_name      = "sb-docprocessor-dev"
    postgres_server_name           = "psql-docprocessor-dev"
    aks_admin_group_object_ids     = ["33333333-3333-3333-3333-333333333333"]
    postgres_admin_group_object_id = "33333333-3333-3333-3333-333333333333"
    postgres_admin_group_name      = "docprocessor-dev-admins"
    vnet_address_space             = "10.30.0.0/16"
    apps_node_min_count            = 1
    apps_node_max_count            = 4
    acr_sku                        = "Standard"
    servicebus_sku                 = "Standard"
    storage_replication_type       = "LRS"
    postgres_sku_name              = "B_Standard_B1ms"
    postgres_backup_retention_days = 7
    postgres_zone_redundant_ha     = false
    delete_locks_enabled           = false
  }

  assert {
    condition     = length(azurerm_management_lock.stateful) == 0
    error_message = "Dev has no delete locks."
  }
}

run "rejects_kubernetes_before_1_36" {
  command = plan
  variables {
    environment                    = "dev"
    subscription_id                = "00000000-0000-0000-0000-000000000000"
    location                       = "westeurope"
    acr_name                       = "acrdocprocessordev"
    storage_account_name           = "stdocprocessordev"
    servicebus_namespace_name      = "sb-docprocessor-dev"
    postgres_server_name           = "psql-docprocessor-dev"
    aks_admin_group_object_ids     = ["33333333-3333-3333-3333-333333333333"]
    postgres_admin_group_object_id = "33333333-3333-3333-3333-333333333333"
    postgres_admin_group_name      = "docprocessor-dev-admins"
    vnet_address_space             = "10.30.0.0/16"
    apps_node_min_count            = 1
    apps_node_max_count            = 4
    acr_sku                        = "Standard"
    servicebus_sku                 = "Standard"
    storage_replication_type       = "LRS"
    postgres_sku_name              = "B_Standard_B1ms"
    postgres_backup_retention_days = 7
    postgres_zone_redundant_ha     = false
    delete_locks_enabled           = false
    kubernetes_version             = "1.35"
  }

  expect_failures = [var.kubernetes_version]
}
