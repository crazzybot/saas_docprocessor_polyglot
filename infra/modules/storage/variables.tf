variable "name" {
  description = "Globally unique, lowercase alphanumeric account name."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "replication_type" {
  description = "ZRS keeps a zone outage from losing documents; GZRS adds a paired region."
  type        = string
}

variable "soft_delete_retention_days" {
  type = number
}

variable "private_endpoint_subnet_id" {
  type = string
}

variable "private_dns_zone_id" {
  description = "privatelink.blob.core.windows.net"
  type        = string
}

variable "tags" {
  type = map(string)
}
