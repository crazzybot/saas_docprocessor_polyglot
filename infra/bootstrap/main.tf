# One-time setup, applied by a subscription Owner from a workstation (local
# state; see infra/README.md):
#   * registers the resource providers the stack uses;
#   * the Terraform state account (Entra ID only, versioned, locked);
#   * per environment: the workload and network resource groups, and a CI
#     identity that GitHub Actions signs in as through OIDC (no secrets),
#     with rights on those two groups and on the state container only.

terraform {
  required_version = ">= 1.14"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.8"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id                 = var.subscription_id
  storage_use_azuread             = true
  resource_provider_registrations = "core"
  resource_providers_to_register = [
    "Microsoft.ContainerService",
    "Microsoft.ContainerRegistry",
    "Microsoft.ServiceBus",
    "Microsoft.DBforPostgreSQL",
    "Microsoft.Monitor",
    "Microsoft.Insights",
    "Microsoft.OperationalInsights",
    "Microsoft.AlertsManagement",
    "Microsoft.PolicyInsights",
    "Microsoft.Security",
  ]
}

locals {
  tags = {
    app        = "saas-docprocessor"
    managed-by = "terraform-bootstrap"
  }
}

# --- Terraform state ---------------------------------------------------------

resource "azurerm_resource_group" "tfstate" {
  name     = "rg-docprocessor-tfstate"
  location = var.location
  tags     = local.tags
}

resource "azurerm_storage_account" "tfstate" {
  name                            = var.state_storage_account_name
  location                        = var.location
  resource_group_name             = azurerm_resource_group.tfstate.name
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "ZRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  allow_nested_items_to_be_public = false
  tags                            = local.tags

  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = 30
    }

    container_delete_retention_policy {
      days = 30
    }
  }
}

resource "azurerm_storage_container" "tfstate" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.tfstate.id
  container_access_type = "private"
}

resource "azurerm_management_lock" "tfstate" {
  name       = "cannot-delete"
  scope      = azurerm_storage_account.tfstate.id
  lock_level = "CanNotDelete"
  notes      = "Terraform state for every environment."
}

# --- Per environment ---------------------------------------------------------

resource "azurerm_resource_group" "workload" {
  for_each = toset(var.environments)
  name     = "rg-docprocessor-${each.value}"
  location = var.location
  tags     = merge(local.tags, { environment = each.value })
}

resource "azurerm_resource_group" "network" {
  for_each = toset(var.environments)
  name     = "rg-docprocessor-${each.value}-network"
  location = var.location
  tags     = merge(local.tags, { environment = each.value })
}

resource "azurerm_user_assigned_identity" "ci" {
  for_each            = toset(var.environments)
  name                = "id-docprocessor-${each.value}-github"
  location            = var.location
  resource_group_name = azurerm_resource_group.tfstate.name
  tags                = merge(local.tags, { environment = each.value })
}

# Only jobs that run in the matching GitHub environment (with its protection
# rules, e.g. required reviewers for prod) can sign in as this identity.
resource "azurerm_federated_identity_credential" "ci" {
  for_each                  = toset(var.environments)
  name                      = "github-${each.value}"
  user_assigned_identity_id = azurerm_user_assigned_identity.ci[each.value].id
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "repo:${var.github_repository}:environment:${each.value}"
  audience                  = ["api://AzureADTokenExchange"]
}

locals {
  # The stack creates resources and role assignments inside both groups.
  ci_scopes = merge([
    for env in var.environments : {
      "${env}/workload" = { env = env, scope = azurerm_resource_group.workload[env].id }
      "${env}/network"  = { env = env, scope = azurerm_resource_group.network[env].id }
    }
  ]...)

  # The only roles the stack assigns (modules/aks, modules/identities).
  # Anything else, Owner included, is refused to the CI identity.
  assignable_role_ids = join(", ", [
    "7f951dda-4ed3-4680-a7ca-43fe172d538d", # AcrPull
    "4d97b98b-1d4f-4787-a291-c67834d212e7", # Network Contributor
    "ba92f5b4-2d11-453d-a403-e96b0029c9fe", # Storage Blob Data Contributor
    "69a216fc-b8fb-44d8-bc22-1f3c2cd27a39", # Azure Service Bus Data Sender
    "4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0", # Azure Service Bus Data Receiver
    "090c5cfd-751d-490a-894a-3ce6f1109419", # Azure Service Bus Data Owner
    "f1a07417-d97a-45cb-824c-7a7467783830", # Managed Identity Operator
  ])
}

resource "azurerm_role_assignment" "ci_contributor" {
  for_each             = local.ci_scopes
  scope                = each.value.scope
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.ci[each.value.env].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "ci_rbac_admin" {
  for_each             = local.ci_scopes
  scope                = each.value.scope
  role_definition_name = "Role Based Access Control Administrator"
  principal_id         = azurerm_user_assigned_identity.ci[each.value.env].principal_id
  principal_type       = "ServicePrincipal"
  condition_version    = "2.0"
  condition            = <<-EOT
    (
      (
        !(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})
      )
      OR
      (
        @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.assignable_role_ids}}
      )
    )
    AND
    (
      (
        !(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})
      )
      OR
      (
        @Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.assignable_role_ids}}
      )
    )
  EOT
}

# Contributor can't manage resource locks; the stack puts CanNotDelete locks
# on the stateful resources (delete_locks_enabled).
resource "azurerm_role_definition" "lock_operator" {
  name        = "docprocessor-lock-operator"
  scope       = "/subscriptions/${var.subscription_id}"
  description = "Manage management locks (Terraform CI for saas-docprocessor)."

  permissions {
    actions = ["Microsoft.Authorization/locks/*"]
  }

  assignable_scopes = [for rg in azurerm_resource_group.workload : rg.id]
}

# A new custom role takes a while to replicate; assigning it straight away
# fails with RoleDefinitionDoesNotExist.
resource "time_sleep" "lock_operator_propagation" {
  create_duration = "60s"

  triggers = {
    role_definition_id = azurerm_role_definition.lock_operator.role_definition_resource_id
  }
}

resource "azurerm_role_assignment" "ci_locks" {
  for_each           = toset(var.environments)
  scope              = azurerm_resource_group.workload[each.value].id
  role_definition_id = time_sleep.lock_operator_propagation.triggers["role_definition_id"]
  principal_id       = azurerm_user_assigned_identity.ci[each.value].principal_id
  principal_type     = "ServicePrincipal"
}

# State is one blob per environment in a shared container; scoping to the
# container is as narrow as Azure RBAC allows for blobs.
resource "azurerm_role_assignment" "ci_state" {
  for_each             = toset(var.environments)
  scope                = azurerm_storage_container.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.ci[each.value].principal_id
  principal_type       = "ServicePrincipal"
}

# The person running bootstrap also plans/applies locally at first.
data "azurerm_client_config" "current" {}

resource "azurerm_role_assignment" "operator_state" {
  scope                = azurerm_storage_container.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}
