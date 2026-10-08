terraform {
  required_version = ">= 1.14"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.8"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.13"
    }
  }

  # Settings per environment: terraform init -backend-config=envs/<env>.backend.hcl
  backend "azurerm" {
    use_azuread_auth = true
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
  # The state and CI identities have no shared keys to use.
  storage_use_azuread = true
  # Providers are registered once by bootstrap/; the CI identity only has
  # rights on the environment's resource groups.
  resource_provider_registrations = "none"
}

provider "azapi" {}
