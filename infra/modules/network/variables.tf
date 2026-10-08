variable "name" {
  description = "Base name, e.g. docprocessor-prod."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  description = "The environment's network resource group."
  type        = string
}

variable "address_space" {
  description = "VNet address space; a /16 is carved into a /22 node subnet and a /24 private endpoint subnet."
  type        = string

  validation {
    condition     = endswith(var.address_space, "/16")
    error_message = "address_space must be a /16."
  }
}

variable "private_dns_zones" {
  description = "privatelink zones to create and link to the VNet."
  type        = list(string)
}

variable "tags" {
  type = map(string)
}
