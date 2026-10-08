variable "name" {
  description = "Globally unique server name."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "tenant_id" {
  type = string
}

variable "sku_name" {
  description = "e.g. B_Standard_B1ms (dev), GP_Standard_D2ds_v5 (prod). Zone-redundant HA needs General Purpose or above."
  type        = string
}

variable "storage_mb" {
  type = number
}

variable "backup_retention_days" {
  type = number
}

variable "geo_redundant_backup_enabled" {
  type = bool
}

variable "zone_redundant_ha" {
  type = bool
}

variable "admin_group_object_id" {
  description = "Entra ID group whose members administer the server (and run create-postgres-role.sh)."
  type        = string
}

variable "admin_group_name" {
  type = string
}

variable "private_endpoint_subnet_id" {
  type = string
}

variable "private_dns_zone_id" {
  description = "privatelink.postgres.database.azure.com"
  type        = string
}

variable "tags" {
  type = map(string)
}
