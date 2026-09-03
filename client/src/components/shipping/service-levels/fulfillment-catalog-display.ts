import type {
  ShippingFulfillmentCatalogMethod,
} from "@shared/types/shipping-fulfillment-routing";

export type FulfillmentCatalogDestinationScope = "domestic" | "international";

export interface FulfillmentCatalogScopeGroup {
  scope: FulfillmentCatalogDestinationScope;
  label: "Domestic" | "International";
  methods: ShippingFulfillmentCatalogMethod[];
}

const DESTINATION_SCOPE_GROUPS: ReadonlyArray<{
  scope: FulfillmentCatalogDestinationScope;
  label: FulfillmentCatalogScopeGroup["label"];
}> = [
  { scope: "domestic", label: "Domestic" },
  { scope: "international", label: "International" },
];

/**
 * Presentation-only grouping. A provider method that supports both scopes is
 * intentionally visible in both sections while retaining one exact identity.
 */
export function groupFulfillmentCatalogMethodsByScope(
  methods: readonly ShippingFulfillmentCatalogMethod[],
): FulfillmentCatalogScopeGroup[] {
  return DESTINATION_SCOPE_GROUPS.flatMap(({ scope, label }) => {
    const scopedMethods = methods.filter((method) => method[scope]);
    return scopedMethods.length > 0 ? [{ scope, label, methods: scopedMethods }] : [];
  });
}
