variable "name" {
  description = "Globally unique namespace name."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "sku" {
  description = "Standard (public endpoint) or Premium (private endpoint, zone redundant)."
  type        = string

  validation {
    condition     = contains(["Standard", "Premium"], var.sku)
    error_message = "sku must be Standard or Premium (Basic has no topics)."
  }
}

variable "premium_capacity" {
  description = "Messaging units for Premium."
  type        = number
  default     = 1
}

variable "message_ttl" {
  description = "ISO 8601 time-to-live for messages on every entity."
  type        = string
}

variable "private_endpoint_subnet_id" {
  type = string
}

variable "private_dns_zone_id" {
  description = "privatelink.servicebus.windows.net (used with Premium only)."
  type        = string
}

variable "tags" {
  type = map(string)
}
