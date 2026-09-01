export const SHIPPING_FULFILLMENT_PROVIDERS = ["shipstation_v2"] as const;

export type ShippingFulfillmentProvider =
  (typeof SHIPPING_FULFILLMENT_PROVIDERS)[number];

export interface ShippingFulfillmentMethodIdentity {
  provider: ShippingFulfillmentProvider;
  providerAccountId: string;
  serviceCode: string;
}

export interface ShippingFulfillmentCatalogMethod
extends ShippingFulfillmentMethodIdentity {
  providerAccountName: string;
  carrierCode: string;
  carrierName: string;
  serviceName: string;
  domestic: boolean;
  international: boolean;
}

export interface ShippingFulfillmentRouteMethod
extends ShippingFulfillmentCatalogMethod {
  priority: number;
}

export interface ShippingFulfillmentRoutingProfile {
  serviceLevelId: number;
  revision: number;
  methods: ShippingFulfillmentRouteMethod[];
  legacyUnscopedMethodCount: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export type ShippingFulfillmentCatalog =
  | {
      status: "available";
      provider: ShippingFulfillmentProvider;
      catalogHash: string;
      fetchedAt: string;
      methods: ShippingFulfillmentCatalogMethod[];
    }
  | {
      status: "not_configured" | "unavailable";
      provider: ShippingFulfillmentProvider;
      code: string;
      message: string;
      retryable: boolean;
      methods: [];
    };

export interface ShippingFulfillmentRoutingServiceLevel {
  id: number;
  code: string;
  displayName: string;
  fulfillmentMode: string;
  isActive: boolean;
}

export interface ShippingFulfillmentRoutingAdminView {
  serviceLevel: ShippingFulfillmentRoutingServiceLevel;
  profile: ShippingFulfillmentRoutingProfile;
  catalog: ShippingFulfillmentCatalog;
}

export interface ReplaceShippingFulfillmentRoutingInput {
  expectedRevision: number;
  idempotencyKey: string;
  methods: ShippingFulfillmentMethodIdentity[];
}

export interface ReplaceShippingFulfillmentRoutingResult {
  commandRevision: number;
  idempotentReplay: boolean;
  profile: ShippingFulfillmentRoutingProfile;
}
