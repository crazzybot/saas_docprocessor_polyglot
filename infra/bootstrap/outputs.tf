output "state_storage_account_name" {
  value = azurerm_storage_account.tfstate.name
}

output "tenant_id" {
  value = data.azurerm_client_config.current.tenant_id
}

output "ci_client_ids" {
  description = "Per environment: set as the AZURE_CLIENT_ID variable of the matching GitHub environment."
  value       = { for env, id in azurerm_user_assigned_identity.ci : env => id.client_id }
}
