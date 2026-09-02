import { StaticFulfillmentProviderRegistry } from "../application/connected-fulfillment-method-catalog.service";
import { ShipStationFulfillmentMethodCatalogProvider } from "./shipstation-fulfillment-method-catalog.provider";

/**
 * Composition root for installed fulfillment providers. Shipping domain and
 * persistence code depend only on the registry port; adding a provider means
 * registering a new adapter here, not changing routing tables or contracts.
 */
export function createFulfillmentProviderRegistry(): StaticFulfillmentProviderRegistry {
  return new StaticFulfillmentProviderRegistry([
    new ShipStationFulfillmentMethodCatalogProvider(),
  ]);
}
