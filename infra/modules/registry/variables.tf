variable "name" {
  description = "Globally unique, alphanumeric registry name."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "sku" {
  type = string

  validation {
    condition     = contains(["Basic", "Standard", "Premium"], var.sku)
    error_message = "sku must be Basic, Standard or Premium."
  }
}

variable "tags" {
  type = map(string)
}
