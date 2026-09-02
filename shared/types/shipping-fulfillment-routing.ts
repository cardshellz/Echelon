/**
 * Provider keys are application-registry identifiers, not database enums.
 * Adding a provider still requires an audited adapter, but must not require a
 * routing-schema migration.
 */
export type ShippingFulfillmentProvider = string;

export type ShippingFulfillmentProviderConnectionStatus =
  | "active"
  | "disabled"
  | "error";

export type ShippingFulfillmentCredentialSource = "environment" | "vault";

export interface ShippingFulfillmentProviderDescriptor {
  provider: ShippingFulfillmentProvider;
  displayName: string;
  credentialLabel: string;
  supportsManagedConnections: boolean;
}

export interface ShippingFulfillmentProviderConnection {
  id: number;
  provider: ShippingFulfillmentProvider;
  providerDisplayName: string;
  name: string;
  status: ShippingFulfillmentProviderConnectionStatus;
  credentialSource: ShippingFulfillmentCredentialSource;
  credentialConfigured: boolean;
  systemManaged: boolean;
  revision: number;
  routedMethodCount: number;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ShippingFulfillmentProviderConnectionsAdminView {
  providers: ShippingFulfillmentProviderDescriptor[];
  connections: ShippingFulfillmentProviderConnection[];
  credentialVaultConfigured: boolean;
}

export interface ShippingFulfillmentMethodIdentity {
  providerConnectionId: number;
  provider: ShippingFulfillmentProvider;
  providerAccountId: string;
  serviceCode: string;
}

export interface ShippingFulfillmentCatalogMethod
extends ShippingFulfillmentMethodIdentity {
  providerConnectionName: string;
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
      catalogHash: string;
      fetchedAt: string;
      methods: ShippingFulfillmentCatalogMethod[];
      connections: ShippingFulfillmentCatalogConnectionResult[];
    }
  | {
      status: "not_configured" | "unavailable";
      code: string;
      message: string;
      retryable: boolean;
      methods: [];
      connections: ShippingFulfillmentCatalogConnectionResult[];
    };

export interface ShippingFulfillmentCatalogConnectionResult {
  connectionId: number;
  connectionRevision: number;
  connectionName: string;
  provider: ShippingFulfillmentProvider;
  providerDisplayName: string;
  status: "available" | "not_configured" | "unavailable";
  methodCount: number;
  code: string | null;
  message: string | null;
  retryable: boolean;
}

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

export interface CreateShippingFulfillmentProviderConnectionInput {
  provider: ShippingFulfillmentProvider;
  name: string;
  credential: string;
  idempotencyKey: string;
}

export interface ReplaceShippingFulfillmentProviderCredentialInput {
  credential: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface ChangeShippingFulfillmentProviderConnectionStatusInput {
  expectedRevision: number;
  idempotencyKey: string;
}

export interface VerifyShippingFulfillmentProviderConnectionInput {
  expectedRevision: number;
  idempotencyKey: string;
}

export interface ShippingFulfillmentProviderConnectionMutationResult {
  connection: ShippingFulfillmentProviderConnection;
  idempotentReplay: boolean;
}
