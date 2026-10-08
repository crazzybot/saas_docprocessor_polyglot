variable "name" {
  type = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "log_retention_days" {
  type = number
}

variable "tags" {
  type = map(string)
}
