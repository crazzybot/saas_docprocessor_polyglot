variable "subscription_id" {
  type = string
}

variable "environment" {
  description = "dev, prod, ..."
  type        = string
}

variable "location" {
  description = "Azure region; needs availability zones."
  type        = string
}

# --- Globally unique names (the manifests in k8s/ reference the prod ones) ---

variable "acr_name" {
  type = string
}

variable "storage_account_name" {
  type = string
}

variable "servicebus_namespace_name" {
  type = string
}

variable "postgres_server_name" {
  type = string
}

# --- Access ---------------------------------------------------------------

variable "aks_admin_group_object_ids" {
  description = "Entra ID groups that get cluster-admin on AKS."
  type        = list(string)
}

variable "postgres_admin_group_object_id" {
  type = string
}

variable "postgres_admin_group_name" {
  type = string
}

variable "api_server_authorized_ip_ranges" {
  description = "CIDRs allowed to reach the AKS API server; empty means unrestricted."
  type        = list(string)
  default     = []
}

# --- Network --------------------------------------------------------------

variable "vnet_address_space" {
  type = string
}

variable "pod_cidr" {
  type    = string
  default = "10.244.0.0/16"
}

variable "service_cidr" {
  type    = string
  default = "172.16.0.0/16"
}

# --- Sizing and resilience -------------------------------------------------

variable "kubernetes_version" {
  description = "AKS minor version. 1.36+ installs Gateway API v1.5.1, the first with the HTTPRoute CORS filter k8s/httproute.yaml uses."
  type        = string
  default     = "1.36"

  validation {
    condition     = can(regex("^1\\.\\d+$", var.kubernetes_version)) && tonumber(split(".", var.kubernetes_version)[1]) >= 36
    error_message = "kubernetes_version must be a minor version, 1.36 or later (see k8s/gateway.yaml)."
  }
}

variable "system_node_vm_size" {
  type    = string
  default = "Standard_D2ds_v5"
}

variable "apps_node_vm_size" {
  type    = string
  default = "Standard_D4ds_v5"
}

variable "apps_node_min_count" {
  type = number
}

variable "apps_node_max_count" {
  type = number
}

variable "defender_enabled" {
  type    = bool
  default = false
}

variable "acr_sku" {
  type = string
}

variable "servicebus_sku" {
  type = string
}

variable "message_ttl" {
  type    = string
  default = "P7D"
}

variable "storage_replication_type" {
  type = string
}

variable "blob_soft_delete_retention_days" {
  type    = number
  default = 14
}

variable "postgres_sku_name" {
  type = string
}

variable "postgres_storage_mb" {
  type    = number
  default = 32768
}

variable "postgres_backup_retention_days" {
  type = number
}

variable "postgres_geo_redundant_backup" {
  type    = bool
  default = false
}

variable "postgres_zone_redundant_ha" {
  type = bool
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "delete_locks_enabled" {
  description = "CanNotDelete locks on the stateful resources (storage, Service Bus, PostgreSQL). Must be removed by hand before destroying."
  type        = bool
}

variable "tags" {
  type    = map(string)
  default = {}
}
