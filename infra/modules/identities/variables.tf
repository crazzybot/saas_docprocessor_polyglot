variable "name" {
  type = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "oidc_issuer_url" {
  type = string
}

variable "storage_account_id" {
  type = string
}

variable "servicebus_namespace_id" {
  type = string
}

variable "extraction_jobs_queue_id" {
  type = string
}

variable "document_service_subscription_id" {
  type = string
}

variable "tags" {
  type = map(string)
}
