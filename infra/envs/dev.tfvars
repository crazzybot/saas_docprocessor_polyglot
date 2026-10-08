environment     = "dev"
subscription_id = "00000000-0000-0000-0000-000000000000"
location        = "westeurope"

acr_name                  = "acrdocprocessordev"
storage_account_name      = "stdocprocessordev"
servicebus_namespace_name = "sb-docprocessor-dev"
postgres_server_name      = "psql-docprocessor-dev"

aks_admin_group_object_ids     = ["33333333-3333-3333-3333-333333333333"]
postgres_admin_group_object_id = "33333333-3333-3333-3333-333333333333"
postgres_admin_group_name      = "docprocessor-dev-admins"

vnet_address_space = "10.30.0.0/16"

system_node_vm_size = "Standard_D2ds_v5"
apps_node_vm_size   = "Standard_D2ds_v5"
apps_node_min_count = 1
apps_node_max_count = 4

# Cheaper tiers: Service Bus Standard has no private endpoint, so in dev it
# stays on its public endpoint (Entra ID only).
acr_sku                  = "Standard"
servicebus_sku           = "Standard"
storage_replication_type = "LRS"

postgres_sku_name              = "B_Standard_B1ms"
postgres_backup_retention_days = 7
postgres_zone_redundant_ha     = false

delete_locks_enabled = false
