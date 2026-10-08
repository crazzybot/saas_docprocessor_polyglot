# Observability backends for one environment: Log Analytics (Container
# Insights logs, AKS control plane diagnostics) and an Azure Monitor
# workspace (managed Prometheus, which scrapes k8s/pod_monitor.yaml), plus the
# data collection endpoint and rules the AKS module associates with the
# cluster. The OTLP traces the services emit go to the in-cluster collector,
# which is deployed with the workloads, not here.

resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  # Entra ID only: no workspace shared keys.
  local_authentication_enabled = false
  tags                         = var.tags
}

resource "azurerm_monitor_workspace" "this" {
  name                = "amw-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_monitor_data_collection_endpoint" "prometheus" {
  name                = "dce-${var.name}-prometheus"
  location            = var.location
  resource_group_name = var.resource_group_name
  kind                = "Linux"
  tags                = var.tags
}

# Managed Prometheus: the ama-metrics agents forward what they scrape into
# the Azure Monitor workspace.
resource "azurerm_monitor_data_collection_rule" "prometheus" {
  name                        = "dcr-${var.name}-prometheus"
  location                    = var.location
  resource_group_name         = var.resource_group_name
  data_collection_endpoint_id = azurerm_monitor_data_collection_endpoint.prometheus.id
  kind                        = "Linux"
  tags                        = var.tags

  data_sources {
    prometheus_forwarder {
      name    = "PrometheusDataSource"
      streams = ["Microsoft-PrometheusMetrics"]
    }
  }

  destinations {
    monitor_account {
      name               = "MonitoringAccount"
      monitor_account_id = azurerm_monitor_workspace.this.id
    }
  }

  data_flow {
    streams      = ["Microsoft-PrometheusMetrics"]
    destinations = ["MonitoringAccount"]
  }
}

# Container Insights: container logs (ContainerLogV2), Kubernetes inventory
# and events into Log Analytics.
resource "azurerm_monitor_data_collection_rule" "container_insights" {
  name                = "dcr-${var.name}-container-insights"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags

  data_sources {
    extension {
      name           = "ContainerInsightsExtension"
      extension_name = "ContainerInsights"
      streams        = ["Microsoft-ContainerInsights-Group-Default"]
      extension_json = jsonencode({
        dataCollectionSettings = {
          interval               = "1m"
          namespaceFilteringMode = "Off"
          enableContainerLogV2   = true
        }
      })
    }
  }

  destinations {
    log_analytics {
      name                  = "LogAnalytics"
      workspace_resource_id = azurerm_log_analytics_workspace.this.id
    }
  }

  data_flow {
    streams      = ["Microsoft-ContainerInsights-Group-Default"]
    destinations = ["LogAnalytics"]
  }
}
