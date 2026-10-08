environment     = "prod"
subscription_id = "00000000-0000-0000-0000-000000000000"
location        = "westeurope"

# The names the manifests in k8s/ reference.
acr_name                  = "acrdocprocessor"
storage_account_name      = "stdocprocessorprod"
servicebus_namespace_name = "sb-docprocessor-prod"
postgres_server_name      = "psql-docprocessor-prod"

aks_admin_group_object_ids     = ["22222222-2222-2222-2222-222222222222"]
postgres_admin_group_object_id = "22222222-2222-2222-2222-222222222222"
postgres_admin_group_name      = "docprocessor-prod-admins"
# Restrict to the office/VPN egress once known, e.g. ["203.0.113.0/24"].
api_server_authorized_ip_ranges = []

vnet_address_space = "10.20.0.0/16"

apps_node_min_count = 3
apps_node_max_count = 12
defender_enabled    = true

acr_sku                  = "Premium"
servicebus_sku           = "Premium"
storage_replication_type = "ZRS"

postgres_sku_name              = "GP_Standard_D2ds_v5"
postgres_backup_retention_days = 35
postgres_zone_redundant_ha     = true

log_retention_days   = 90
delete_locks_enabled = true
