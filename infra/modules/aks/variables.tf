variable "name" {
  type = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "network_resource_group_id" {
  description = "Resource group holding the VNet and the gateway's public IP."
  type        = string
}

variable "tenant_id" {
  type = string
}

variable "kubernetes_version" {
  type = string
}

variable "admin_group_object_ids" {
  description = "Entra ID groups that get cluster-admin."
  type        = list(string)
}

variable "api_server_authorized_ip_ranges" {
  description = "CIDRs allowed to reach the API server. Empty leaves it open to the internet (still Entra ID authenticated)."
  type        = list(string)
}

variable "node_subnet_id" {
  type = string
}

variable "pod_cidr" {
  description = "Overlay pod CIDR; must not overlap the VNet or service CIDR."
  type        = string
}

variable "service_cidr" {
  type = string
}

variable "system_node_vm_size" {
  type = string
}

variable "apps_node_vm_size" {
  type = string
}

variable "apps_node_min_count" {
  type = number
}

variable "apps_node_max_count" {
  type = number
}

variable "defender_enabled" {
  type = bool
}

variable "acr_id" {
  type = string
}

variable "log_analytics_workspace_id" {
  type = string
}

variable "prometheus_data_collection_rule_id" {
  type = string
}

variable "prometheus_data_collection_endpoint_id" {
  type = string
}

variable "container_insights_data_collection_rule_id" {
  type = string
}

variable "tags" {
  type = map(string)
}
