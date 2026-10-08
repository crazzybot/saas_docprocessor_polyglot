output "id" {
  value = azurerm_storage_account.this.id
}

output "blob_endpoint" {
  description = "STORAGE_ACCOUNT_URL for the services."
  value       = trimsuffix(azurerm_storage_account.this.primary_blob_endpoint, "/")
}
