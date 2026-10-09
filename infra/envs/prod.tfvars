environment     = "prod"
subscription_id = "35d27919-098f-4249-b3d4-a463646b0542"
location        = "canadacentral"

# The names the manifests in k8s/ reference.
acr_name                  = "acrdocprocessorap"
storage_account_name      = "stdocprocessorprodap"
servicebus_namespace_name = "sb-docprocessor-prod-ap"
postgres_server_name      = "psql-docprocessor-prod-ap"

aks_admin_group_object_ids     = ["17baddf4-40dc-4042-bfd6-929685704425"]
postgres_admin_group_object_id = "17baddf4-40dc-4042-bfd6-929685704425"
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
