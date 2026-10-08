output "namespace_id" {
  value = azurerm_servicebus_namespace.this.id
}

output "fqdn" {
  description = "SERVICE_BUS_NAMESPACE for the services."
  value       = "${azurerm_servicebus_namespace.this.name}.servicebus.windows.net"
}

output "extraction_jobs_queue_id" {
  value = azurerm_servicebus_queue.extraction_jobs.id
}

output "document_service_subscription_id" {
  value = azurerm_servicebus_subscription.document_service.id
}
