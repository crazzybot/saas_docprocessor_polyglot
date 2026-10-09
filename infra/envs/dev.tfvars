environment     = "dev"
subscription_id = "35d27919-098f-4249-b3d4-a463646b0542"
location        = "canadacentral"

acr_name                  = "acrdocprocessordev"
storage_account_name      = "stdocprocessordev"
servicebus_namespace_name = "sb-docprocessor-dev-ap"
postgres_server_name      = "psql-docprocessor-dev"

aks_admin_group_object_ids     = ["21f79ecf-df5c-445c-a83d-97269cbfddcd"]
postgres_admin_group_object_id = "21f79ecf-df5c-445c-a83d-97269cbfddcd"
postgres_admin_group_name      = "docprocessor-dev-admins"

vnet_address_space = "10.30.0.0/16"

# The subscription's regional quota is 4 vCPUs: one 2-vCPU node per pool,
# and apps pool upgrades drain in place instead of adding a surge node. The
# system pool can't (Azure requires it to surge), so its upgrades need the
# quota raised to at least 6.
system_node_vm_size       = "Standard_D2pds_v5"
system_node_min_count     = 1
system_node_max_count     = 1
apps_node_vm_size         = "Standard_D2pds_v5"
apps_node_min_count       = 1
apps_node_max_count       = 1
apps_node_max_unavailable = "1"

# Cheaper tiers: Service Bus Standard has no private endpoint, so in dev it
# stays on its public endpoint (Entra ID only).
acr_sku                  = "Standard"
servicebus_sku           = "Standard"
storage_replication_type = "LRS"

postgres_sku_name              = "B_Standard_B1ms"
postgres_backup_retention_days = 7
postgres_zone_redundant_ha     = false

delete_locks_enabled = false
