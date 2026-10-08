# Network for one environment: a VNet with a node subnet (Azure CNI Overlay,
# so pods don't consume VNet addresses) and a private endpoint subnet, a
# zone-redundant NAT gateway for egress, the private DNS zones the private
# endpoints register in, and the static public IP of the Gateway API gateway
# (k8s/gateway.yaml). Everything lives in the environment's network resource
# group, on which the AKS control plane identity gets Network Contributor.

resource "azurerm_virtual_network" "this" {
  name                = "vnet-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  address_space       = [var.address_space]
  tags                = var.tags
}

resource "azurerm_subnet" "aks_nodes" {
  name                 = "snet-aks-nodes"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.address_space, 6, 0)] # /22 of a /16
  # Egress goes through the NAT gateway, never Azure's implicit default.
  default_outbound_access_enabled = false
}

resource "azurerm_subnet" "private_endpoints" {
  name                            = "snet-private-endpoints"
  resource_group_name             = var.resource_group_name
  virtual_network_name            = azurerm_virtual_network.this.name
  address_prefixes                = [cidrsubnet(var.address_space, 8, 4)] # /24 of a /16
  default_outbound_access_enabled = false
}

# StandardV2 NAT gateways are zone-redundant (Standard is pinned to one zone).
resource "azurerm_public_ip" "nat" {
  name                = "pip-${var.name}-nat"
  location            = var.location
  resource_group_name = var.resource_group_name
  allocation_method   = "Static"
  sku                 = "StandardV2"
  tags                = var.tags
}

resource "azurerm_nat_gateway" "this" {
  name                    = "ng-${var.name}"
  location                = var.location
  resource_group_name     = var.resource_group_name
  sku_name                = "StandardV2"
  idle_timeout_in_minutes = 4
  tags                    = var.tags
}

resource "azurerm_nat_gateway_public_ip_association" "this" {
  nat_gateway_id       = azurerm_nat_gateway.this.id
  public_ip_address_id = azurerm_public_ip.nat.id
}

resource "azurerm_subnet_nat_gateway_association" "aks_nodes" {
  subnet_id      = azurerm_subnet.aks_nodes.id
  nat_gateway_id = azurerm_nat_gateway.this.id
}

# Ingress address of the public Gateway. The add-on's LoadBalancer Service
# binds it by name (service.beta.kubernetes.io/azure-pip-name), and because
# AKS doesn't own it, it survives the Gateway being recreated.
resource "azurerm_public_ip" "gateway" {
  name                = "pip-${var.name}-gateway"
  location            = var.location
  resource_group_name = var.resource_group_name
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = ["1", "2", "3"]
  tags                = var.tags
}

resource "azurerm_private_dns_zone" "this" {
  for_each            = toset(var.private_dns_zones)
  name                = each.value
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "this" {
  for_each            = azurerm_private_dns_zone.this
  name                = "link-${var.name}"
  private_dns_zone_id = each.value.id
  virtual_network_id  = azurerm_virtual_network.this.id
  tags                = var.tags
}
