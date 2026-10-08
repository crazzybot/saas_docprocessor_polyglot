variable "subscription_id" {
  type = string
}

variable "location" {
  type    = string
  default = "westeurope"
}

variable "environments" {
  type    = list(string)
  default = ["dev", "prod"]
}

variable "state_storage_account_name" {
  description = "Globally unique; must match storage_account_name in envs/*.backend.hcl."
  type        = string
  default     = "stdocprocessortfstate"
}

variable "github_repository" {
  description = "owner/repo whose workflows deploy the stack."
  type        = string
}
