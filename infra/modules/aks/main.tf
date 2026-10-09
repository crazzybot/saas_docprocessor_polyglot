# AKS cluster for one environment, configured for what the manifests in k8s/
# rely on:
#   * OIDC issuer + Workload Identity      (serviceaccount.yaml)
#   * KEDA add-on                          (keda_scaledobject.yaml)
#   * Managed Prometheus (ama-metrics)     (pod_monitor.yaml)
#   * Cilium network policy                (network_policy.yaml)
#   * Managed Gateway API CRDs + app routing Istio implementation, AKS 1.36+
#                                          (gateway.yaml, httproute.yaml)
#   * Nodes spread over var.zones          (topologySpreadConstraints)
# and the AKS baseline: Entra ID + Azure RBAC with local accounts disabled,
# Standard tier (uptime SLA), automatic patch and node-image upgrades inside
# maintenance windows, Azure Policy, NAT gateway egress, and a system pool
# reserved for critical add-ons.

resource "azurerm_user_assigned_identity" "control_plane" {
  name                = "id-${var.name}-aks"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

# Lets the cluster join the node subnet and bind the gateway's public IP,
# both in the network resource group. Must exist before the cluster.
resource "azurerm_role_assignment" "control_plane_network" {
  scope                = var.network_resource_group_id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_user_assigned_identity.control_plane.principal_id
  principal_type       = "ServicePrincipal"
}

# Kubelet identity created up front so AcrPull is granted before the first
# node pulls an image; the control plane needs Managed Identity Operator on
# it to assign it to the nodes.
resource "azurerm_user_assigned_identity" "kubelet" {
  name                = "id-${var.name}-kubelet"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_role_assignment" "control_plane_kubelet" {
  scope                = azurerm_user_assigned_identity.kubelet.id
  role_definition_name = "Managed Identity Operator"
  principal_id         = azurerm_user_assigned_identity.control_plane.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "kubelet_acr_pull" {
  scope                = var.acr_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.kubelet.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_kubernetes_cluster" "this" {
  name                = "aks-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  node_resource_group = "${var.resource_group_name}-aks-nodes"
  dns_prefix          = "aks-${var.name}"
  kubernetes_version  = var.kubernetes_version
  sku_tier            = "Standard"
  tags                = var.tags

  automatic_upgrade_channel = "patch"
  node_os_upgrade_channel   = "NodeImage"

  oidc_issuer_enabled          = true
  workload_identity_enabled    = true
  local_account_disabled       = true
  azure_policy_enabled         = true
  image_cleaner_enabled        = true
  image_cleaner_interval_hours = 48

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.control_plane.id]
  }

  kubelet_identity {
    client_id                 = azurerm_user_assigned_identity.kubelet.client_id
    object_id                 = azurerm_user_assigned_identity.kubelet.principal_id
    user_assigned_identity_id = azurerm_user_assigned_identity.kubelet.id
  }

  azure_active_directory_role_based_access_control {
    azure_rbac_enabled     = true
    tenant_id              = var.tenant_id
    admin_group_object_ids = var.admin_group_object_ids
  }

  dynamic "api_server_access_profile" {
    for_each = length(var.api_server_authorized_ip_ranges) > 0 ? [1] : []
    content {
      authorized_ip_ranges = var.api_server_authorized_ip_ranges
    }
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_data_plane  = "cilium"
    network_policy      = "cilium"
    outbound_type       = "userAssignedNATGateway"
    load_balancer_sku   = "standard"
    pod_cidr            = var.pod_cidr
    service_cidr        = var.service_cidr
    dns_service_ip      = cidrhost(var.service_cidr, 10)
  }

  # System pool: only critical add-ons (CriticalAddonsOnly taint); the
  # workloads run on the user pool below.
  default_node_pool {
    name                         = "system"
    vm_size                      = var.system_node_vm_size
    os_sku                       = "AzureLinux"
    zones                        = var.zones
    vnet_subnet_id               = var.node_subnet_id
    only_critical_addons_enabled = true
    auto_scaling_enabled         = true
    min_count                    = var.system_node_min_count
    max_count                    = var.system_node_max_count
    max_pods                     = 110
    temporary_name_for_rotation  = "systemtmp"

    # System pools must surge (Azure rejects max_unavailable on them), so a
    # system pool upgrade needs one node's worth of spare vCPU quota.
    upgrade_settings {
      max_surge = "33%"
    }
  }

  # Node pools are declared here and scaled by the cluster autoscaler, not
  # created by Node Auto-Provisioning (Karpenter).
  node_provisioning_profile {
    mode = "Manual"
  }

  workload_autoscaler_profile {
    keda_enabled = true
  }

  monitor_metrics {}

  oms_agent {
    log_analytics_workspace_id      = var.log_analytics_workspace_id
    msi_auth_for_monitoring_enabled = true
  }

  dynamic "microsoft_defender" {
    for_each = var.defender_enabled ? [1] : []
    content {
      log_analytics_workspace_id = var.log_analytics_workspace_id
    }
  }

  # Kubernetes patch upgrades, then node images, early Sunday (UTC).
  maintenance_window_auto_upgrade {
    frequency   = "Weekly"
    interval    = 1
    day_of_week = "Sunday"
    start_time  = "01:00"
    utc_offset  = "+00:00"
    duration    = 4
  }

  maintenance_window_node_os {
    frequency   = "Weekly"
    interval    = 1
    day_of_week = "Sunday"
    start_time  = "05:00"
    utc_offset  = "+00:00"
    duration    = 4
  }

  lifecycle {
    # The patch channel moves the version; the autoscaler moves node counts.
    ignore_changes = [
      kubernetes_version,
      default_node_pool[0].orchestrator_version,
      default_node_pool[0].node_count,
    ]
  }

  depends_on = [
    azurerm_role_assignment.control_plane_network,
    azurerm_role_assignment.control_plane_kubelet,
    azurerm_role_assignment.kubelet_acr_pull,
  ]
}

resource "azurerm_kubernetes_cluster_node_pool" "apps" {
  name                        = "apps"
  kubernetes_cluster_id       = azurerm_kubernetes_cluster.this.id
  mode                        = "User"
  vm_size                     = var.apps_node_vm_size
  os_sku                      = "AzureLinux"
  zones                       = var.zones
  vnet_subnet_id              = var.node_subnet_id
  auto_scaling_enabled        = true
  min_count                   = var.apps_node_min_count
  max_count                   = var.apps_node_max_count
  max_pods                    = 110
  temporary_name_for_rotation = "appstmp"
  tags                        = var.tags

  # azurerm takes one or the other.
  upgrade_settings {
    max_surge       = var.apps_node_max_unavailable == null ? var.apps_node_max_surge : null
    max_unavailable = var.apps_node_max_unavailable
  }

  lifecycle {
    ignore_changes = [orchestrator_version, node_count]
  }
}

# The Gateway API settings have no azurerm attribute yet, so they're applied
# with azapi, as in Microsoft's Terraform sample for app routing Istio.
resource "azapi_update_resource" "gateway_api" {
  type        = "Microsoft.ContainerService/managedClusters@2026-03-01"
  resource_id = azurerm_kubernetes_cluster.this.id

  body = {
    properties = {
      ingressProfile = {
        gatewayAPI = {
          installation = "Standard"
        }
        webAppRouting = {
          gatewayAPIImplementations = {
            appRoutingIstio = {
              mode = "Enabled"
            }
          }
        }
      }
    }
  }

  depends_on = [azurerm_kubernetes_cluster_node_pool.apps]
}

resource "azurerm_monitor_data_collection_rule_association" "prometheus" {
  name                    = "dcra-${var.name}-prometheus"
  target_resource_id      = azurerm_kubernetes_cluster.this.id
  data_collection_rule_id = var.prometheus_data_collection_rule_id
}

# The Prometheus agents fetch their configuration from this endpoint; the
# association must carry exactly this name.
resource "azurerm_monitor_data_collection_rule_association" "prometheus_endpoint" {
  name                        = "configurationAccessEndpoint"
  target_resource_id          = azurerm_kubernetes_cluster.this.id
  data_collection_endpoint_id = var.prometheus_data_collection_endpoint_id
}

resource "azurerm_monitor_data_collection_rule_association" "container_insights" {
  name                    = "ContainerInsightsExtension"
  target_resource_id      = azurerm_kubernetes_cluster.this.id
  data_collection_rule_id = var.container_insights_data_collection_rule_id
}

# Control plane audit and guard logs (who did what through the API server).
resource "azurerm_monitor_diagnostic_setting" "control_plane" {
  name                           = "control-plane"
  target_resource_id             = azurerm_kubernetes_cluster.this.id
  log_analytics_workspace_id     = var.log_analytics_workspace_id
  log_analytics_destination_type = "Dedicated"

  enabled_log {
    category = "kube-audit-admin"
  }

  enabled_log {
    category = "guard"
  }
}
