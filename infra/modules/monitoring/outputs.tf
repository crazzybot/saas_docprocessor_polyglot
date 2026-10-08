output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.this.id
}

output "monitor_workspace_id" {
  value = azurerm_monitor_workspace.this.id
}

output "prometheus_data_collection_endpoint_id" {
  value = azurerm_monitor_data_collection_endpoint.prometheus.id
}

output "prometheus_data_collection_rule_id" {
  value = azurerm_monitor_data_collection_rule.prometheus.id
}

output "container_insights_data_collection_rule_id" {
  value = azurerm_monitor_data_collection_rule.container_insights.id
}
