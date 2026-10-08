# Workload Identity for the pods and for KEDA, with least-privilege RBAC.
#
#   workload  <- system:serviceaccount:docprocessor:docprocessor-workload-identity
#                (both services; client ID goes in k8s/serviceaccount.yaml)
#   keda      <- system:serviceaccount:kube-system:keda-operator
#                (the AKS KEDA add-on reads the queue length; client ID goes
#                in the TriggerAuthentication in k8s/keda_scaledobject.yaml)
#
# KEDA has its own identity so the app identity never holds Data Owner.

locals {
  token_audience = "api://AzureADTokenExchange"
}

resource "azurerm_user_assigned_identity" "workload" {
  name                = "id-${var.name}-workload"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_federated_identity_credential" "workload" {
  name                      = "aks-docprocessor-workload-identity"
  user_assigned_identity_id = azurerm_user_assigned_identity.workload.id
  issuer                    = var.oidc_issuer_url
  subject                   = "system:serviceaccount:docprocessor:docprocessor-workload-identity"
  audience                  = [local.token_audience]
}

resource "azurerm_user_assigned_identity" "keda" {
  name                = "id-${var.name}-keda"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_federated_identity_credential" "keda" {
  name                      = "aks-keda-operator"
  user_assigned_identity_id = azurerm_user_assigned_identity.keda.id
  issuer                    = var.oidc_issuer_url
  subject                   = "system:serviceaccount:kube-system:keda-operator"
  audience                  = [local.token_audience]
}

locals {
  workload_roles = {
    # Both services read and write blobs; document-service also deletes them.
    blob = {
      scope = var.storage_account_id
      role  = "Storage Blob Data Contributor"
    }
    # document-service publishes lifecycle events; the worker publishes results.
    sb_send = {
      scope = var.servicebus_namespace_id
      role  = "Azure Service Bus Data Sender"
    }
    # The worker receives jobs.
    sb_receive_jobs = {
      scope = var.extraction_jobs_queue_id
      role  = "Azure Service Bus Data Receiver"
    }
    # document-service receives extraction results.
    sb_receive_results = {
      scope = var.document_service_subscription_id
      role  = "Azure Service Bus Data Receiver"
    }
  }
}

resource "azurerm_role_assignment" "workload" {
  for_each             = local.workload_roles
  scope                = each.value.scope
  role_definition_name = each.value.role
  principal_id         = azurerm_user_assigned_identity.workload.principal_id
  principal_type       = "ServicePrincipal"
}

# KEDA's azure-servicebus scaler reads the queue's runtime properties.
resource "azurerm_role_assignment" "keda_queue" {
  scope                = var.extraction_jobs_queue_id
  role_definition_name = "Azure Service Bus Data Owner"
  principal_id         = azurerm_user_assigned_identity.keda.principal_id
  principal_type       = "ServicePrincipal"
}
