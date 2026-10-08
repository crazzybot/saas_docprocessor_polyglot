output "aks_cluster_name" {
  value = module.aks.name
}

output "aks_get_credentials" {
  value = "az aks get-credentials --resource-group ${data.azurerm_resource_group.workload.name} --name ${module.aks.name} && kubelogin convert-kubeconfig -l azurecli"
}

output "acr_login_server" {
  value = module.registry.login_server
}

output "gateway_public_ip" {
  description = "Point the API host's DNS A record here."
  value       = module.network.gateway_public_ip
}

output "egress_public_ip" {
  description = "Source address of all traffic leaving the cluster (for partner allow-lists)."
  value       = module.network.nat_public_ip
}

output "postgres_role_command" {
  description = "Creates the workload identity's database role (run once, as a member of the PostgreSQL admin group)."
  value       = "infra/scripts/create-postgres-role.sh ${module.postgres.fqdn} ${module.identities.workload_name}"
}

# Values the manifests in k8s/ need. Placeholders in those files today; an
# overlay per environment will take them from here.
output "k8s_values" {
  value = {
    # serviceaccount.yaml
    "azure.workload.identity/client-id" = module.identities.workload_client_id
    "azure.workload.identity/tenant-id" = data.azurerm_client_config.current.tenant_id
    # keda_scaledobject.yaml (TriggerAuthentication identityId)
    keda_identity_id = module.identities.keda_client_id
    # configmap.yaml
    SERVICE_BUS_NAMESPACE = module.messaging.fqdn
    STORAGE_ACCOUNT_URL   = module.storage.blob_endpoint
    DATABASE_URL          = "postgresql://${module.identities.workload_name}@${module.postgres.fqdn}:5432/${module.postgres.database_name}?sslmode=require"
    # gateway.yaml
    "service.beta.kubernetes.io/azure-pip-name"                     = module.network.gateway_public_ip_name
    "service.beta.kubernetes.io/azure-load-balancer-resource-group" = data.azurerm_resource_group.network.name
    # network_policy.yaml (egress to private endpoints)
    private_endpoints_cidr = module.network.private_endpoints_subnet_cidr
  }
}
