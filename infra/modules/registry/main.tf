# Container registry for the service images. It keeps its public endpoint so
# GitHub-hosted runners can push; access is Entra ID only (no admin user, no
# anonymous pull). AKS pulls with its kubelet identity (AcrPull, see the aks
# module).

resource "azurerm_container_registry" "this" {
  name                   = var.name
  location               = var.location
  resource_group_name    = var.resource_group_name
  sku                    = var.sku
  admin_enabled          = false
  anonymous_pull_enabled = false
  # Premium only: replicate across availability zones, and purge untagged
  # manifests after a week.
  zone_redundancy_enabled  = var.sku == "Premium"
  retention_policy_in_days = var.sku == "Premium" ? 7 : null
  tags                     = var.tags
}
