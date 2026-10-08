output "vnet_id" {
  value = azurerm_virtual_network.this.id
}

output "aks_nodes_subnet_id" {
  value = azurerm_subnet.aks_nodes.id
}

output "private_endpoints_subnet_id" {
  value = azurerm_subnet.private_endpoints.id
}

output "private_endpoints_subnet_cidr" {
  value = one(azurerm_subnet.private_endpoints.address_prefixes)
}

output "nat_public_ip" {
  value = azurerm_public_ip.nat.ip_address
}

output "gateway_public_ip_name" {
  value = azurerm_public_ip.gateway.name
}

output "gateway_public_ip" {
  value = azurerm_public_ip.gateway.ip_address
}

output "private_dns_zone_ids" {
  description = "Zone name => zone ID."
  value       = { for name, zone in azurerm_private_dns_zone.this : name => zone.id }
}
