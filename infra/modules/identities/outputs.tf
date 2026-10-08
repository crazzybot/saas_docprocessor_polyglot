output "workload_client_id" {
  value = azurerm_user_assigned_identity.workload.client_id
}

output "workload_name" {
  description = "Also the PostgreSQL role name (pgaadauth_create_principal resolves it by name)."
  value       = azurerm_user_assigned_identity.workload.name
}

output "keda_client_id" {
  value = azurerm_user_assigned_identity.keda.client_id
}
