# Service Bus namespace and the entities both services use (same topology as
# local/servicebus-emulator-config.json, minus the local-debug subscriptions):
#
#   topic document-events          <- document-service outbox relay
#     sub extraction               (event_type = document.uploaded) --ForwardTo--> queue extraction-jobs
#   queue extraction-jobs          -> worker
#   topic extraction-results       <- worker
#     sub document-service         -> document-service
#
# Shared access keys are disabled: everything authenticates with Entra ID.
# Premium namespaces are reached only through a private endpoint; Standard
# has no private endpoints, so it stays public (still Entra ID only).

locals {
  premium = var.sku == "Premium"
}

resource "azurerm_servicebus_namespace" "this" {
  name                          = var.name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  sku                           = var.sku
  capacity                      = local.premium ? var.premium_capacity : 0
  premium_messaging_partitions  = local.premium ? 1 : 0
  local_auth_enabled            = false
  minimum_tls_version           = "1.2"
  public_network_access_enabled = !local.premium
  tags                          = var.tags
}

resource "azurerm_private_endpoint" "servicebus" {
  count               = local.premium ? 1 : 0
  name                = "pe-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.private_endpoint_subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "psc-${var.name}"
    private_connection_resource_id = azurerm_servicebus_namespace.this.id
    subresource_names              = ["namespace"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "default"
    private_dns_zone_ids = [var.private_dns_zone_id]
  }
}

resource "azurerm_servicebus_queue" "extraction_jobs" {
  name         = "extraction-jobs"
  namespace_id = azurerm_servicebus_namespace.this.id
  # The worker renews the lock for up to MAX_LOCK_RENEWAL_SECONDS and
  # dead-letters after MAX_DELIVERY_ATTEMPTS itself; this is the backstop.
  lock_duration                        = "PT1M"
  max_delivery_count                   = 10
  default_message_ttl                  = var.message_ttl
  dead_lettering_on_message_expiration = true
}

resource "azurerm_servicebus_topic" "document_events" {
  name         = "document-events"
  namespace_id = azurerm_servicebus_namespace.this.id
  # The outbox relay delivers at least once; the message ID dedupes resends.
  requires_duplicate_detection            = true
  duplicate_detection_history_time_window = "PT5M"
  default_message_ttl                     = var.message_ttl
}

resource "azurerm_servicebus_subscription" "extraction" {
  name                                 = "extraction"
  topic_id                             = azurerm_servicebus_topic.document_events.id
  forward_to                           = azurerm_servicebus_queue.extraction_jobs.name
  lock_duration                        = "PT1M"
  max_delivery_count                   = 10
  default_message_ttl                  = var.message_ttl
  dead_lettering_on_message_expiration = true
}

resource "azurerm_servicebus_subscription_rule" "extraction_uploaded_only" {
  name            = "uploaded-only"
  subscription_id = azurerm_servicebus_subscription.extraction.id
  filter_type     = "CorrelationFilter"

  correlation_filter {
    properties = {
      event_type = "document.uploaded"
    }
  }
}

# Azure gives every new subscription a `$Default` rule with a TrueFilter.
# Rules are OR-ed, so left in place it would forward updates and deletes to
# the worker too. Delete it once the filter above exists.
resource "azapi_resource_action" "extraction_remove_default_rule" {
  type             = "Microsoft.ServiceBus/namespaces/topics/subscriptions/rules@2024-01-01"
  resource_id      = "${azurerm_servicebus_subscription.extraction.id}/rules/$Default"
  method           = "DELETE"
  ignore_not_found = true
  depends_on       = [azurerm_servicebus_subscription_rule.extraction_uploaded_only]
}

resource "azurerm_servicebus_topic" "extraction_results" {
  name                                    = "extraction-results"
  namespace_id                            = azurerm_servicebus_namespace.this.id
  requires_duplicate_detection            = true
  duplicate_detection_history_time_window = "PT5M"
  default_message_ttl                     = var.message_ttl
}

resource "azurerm_servicebus_subscription" "document_service" {
  name          = "document-service"
  topic_id      = azurerm_servicebus_topic.extraction_results.id
  lock_duration = "PT1M"
  # Must stay above document-service's CONSUMER_MAX_DELIVERY_ATTEMPTS
  # (default 5), which dead-letters on its own.
  max_delivery_count                   = 10
  default_message_ttl                  = var.message_ttl
  dead_lettering_on_message_expiration = true
}
