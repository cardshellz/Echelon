import { createHash } from "node:crypto";
import type {
  ShippingFulfillmentCatalog,
  ShippingFulfillmentCatalogConnectionResult,
  ShippingFulfillmentCatalogMethod,
  ShippingFulfillmentProviderDescriptor,
} from "@shared/types/shipping-fulfillment-routing";

const PROVIDER_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,119}$/;
const MAX_DESCRIPTOR_LABEL_LENGTH = 160;
const MAX_METHODS_PER_CONNECTION = 5_000;
const CONNECTION_FETCH_CONCURRENCY = 4;

export interface FulfillmentProviderConnectionCatalogState {
  id: number;
  provider: string;
  name: string;
  status: "active" | "disabled" | "error";
  credentialSource: "environment" | "vault";
  credentialRef: string | null;
  revision: number;
}

export interface FulfillmentProviderCredentialRecord {
  connectionId: number;
  keyId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface FulfillmentProviderCatalogConnectionStore {
  listCatalogConnections(): Promise<FulfillmentProviderConnectionCatalogState[]>;
  getCredential(connectionId: number): Promise<FulfillmentProviderCredentialRecord | null>;
}

export interface FulfillmentProviderCredentialCipher {
  seal(input: {
    connectionId: number;
    provider: string;
    credential: string;
  }): FulfillmentProviderCredentialRecord;
  open(input: {
    connection: FulfillmentProviderConnectionCatalogState;
    credential: FulfillmentProviderCredentialRecord;
  }): string;
}

export type FulfillmentProviderConnectionCatalog =
  | {
      status: "available";
      methods: ShippingFulfillmentCatalogMethod[];
    }
  | {
      status: "not_configured" | "unavailable";
      code: string;
      message: string;
      retryable: boolean;
      methods: [];
    };

export interface FulfillmentProviderAdapter {
  readonly descriptor: ShippingFulfillmentProviderDescriptor;
  verifyCredential(credential: string): Promise<FulfillmentProviderConnectionCatalog>;
  loadCatalog(input: {
    connectionId: number;
    connectionName: string;
    credential: string;
  }): Promise<FulfillmentProviderConnectionCatalog>;
}

export interface FulfillmentProviderRegistry {
  list(): ShippingFulfillmentProviderDescriptor[];
  get(provider: string): FulfillmentProviderAdapter | null;
}

export class StaticFulfillmentProviderRegistry implements FulfillmentProviderRegistry {
  private readonly adapters: ReadonlyMap<string, FulfillmentProviderAdapter>;

  constructor(adapters: readonly FulfillmentProviderAdapter[]) {
    const byProvider = new Map<string, FulfillmentProviderAdapter>();
    for (const adapter of adapters) {
      const provider = adapter.descriptor.provider.trim();
      if (!PROVIDER_PATTERN.test(provider) || byProvider.has(provider)) {
        throw new Error(`Duplicate or invalid fulfillment provider registration: ${provider || "<empty>"}.`);
      }
      validateDescriptorLabel(adapter.descriptor.displayName, "displayName", provider);
      validateDescriptorLabel(adapter.descriptor.credentialLabel, "credentialLabel", provider);
      if (typeof adapter.descriptor.supportsManagedConnections !== "boolean") {
        throw new Error(`Fulfillment provider ${provider} has an invalid supportsManagedConnections value.`);
      }
      byProvider.set(provider, adapter);
    }
    this.adapters = byProvider;
  }

  list(): ShippingFulfillmentProviderDescriptor[] {
    return [...this.adapters.values()]
      .map((adapter) => ({ ...adapter.descriptor }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  get(provider: string): FulfillmentProviderAdapter | null {
    return this.adapters.get(provider) ?? null;
  }
}

function validateDescriptorLabel(value: string, field: string, provider: string): void {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > MAX_DESCRIPTOR_LABEL_LENGTH
  ) {
    throw new Error(`Fulfillment provider ${provider} has an invalid ${field}.`);
  }
}

interface Clock {
  now(): Date;
}

export class ConnectedFulfillmentMethodCatalogService {
  constructor(private readonly deps: {
    store: FulfillmentProviderCatalogConnectionStore;
    registry: FulfillmentProviderRegistry;
    credentialCipher: FulfillmentProviderCredentialCipher | null;
    environment?: Readonly<Record<string, string | undefined>>;
    clock?: Clock;
  }) {}

  async loadCatalog(): Promise<ShippingFulfillmentCatalog> {
    const connections = (await this.deps.store.listCatalogConnections())
      .filter((connection) => connection.status !== "disabled");
    if (connections.length === 0) {
      return {
        status: "not_configured",
        code: "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_REQUIRED",
        message: "Connect and enable at least one fulfillment provider before configuring routing.",
        retryable: false,
        methods: [],
        connections: [],
      };
    }

    const loaded = await mapWithConcurrency(
      connections,
      CONNECTION_FETCH_CONCURRENCY,
      (connection) => this.loadConnection(connection),
    );
    const methods = loaded.flatMap((entry) => entry.catalog.methods);
    const connectionResults = loaded.map((entry) => entry.result);
    if (methods.length === 0 && !loaded.some((entry) => entry.catalog.status === "available")) {
      const first = loaded[0].catalog;
      return {
        status: loaded.every((entry) => entry.catalog.status === "not_configured")
          ? "not_configured"
          : "unavailable",
        code: first.status === "available"
          ? "SHIPPING_FULFILLMENT_PROVIDER_CATALOG_EMPTY"
          : first.code,
        message: first.status === "available"
          ? "Connected fulfillment providers returned no methods."
          : first.message,
        retryable: loaded.some((entry) => (
          entry.catalog.status !== "available" && entry.catalog.retryable
        )),
        methods: [],
        connections: connectionResults,
      };
    }

    const fetchedAt = validDate((this.deps.clock ?? systemClock).now());
    const ordered = [...methods].sort(compareMethods);
    return {
      status: "available",
      catalogHash: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
      fetchedAt: fetchedAt.toISOString(),
      methods: ordered,
      connections: connectionResults,
    };
  }

  private async loadConnection(connection: FulfillmentProviderConnectionCatalogState): Promise<{
    catalog: FulfillmentProviderConnectionCatalog;
    result: ShippingFulfillmentCatalogConnectionResult;
  }> {
    const adapter = this.deps.registry.get(connection.provider);
    if (!adapter) {
      return unavailableConnection(
        connection,
        connection.provider,
        "SHIPPING_FULFILLMENT_PROVIDER_NOT_SUPPORTED",
        "This connection uses a fulfillment provider that is not installed in this application build.",
        false,
      );
    }

    let credential: string | null;
    try {
      credential = await this.resolveCredential(connection);
    } catch {
      return unavailableConnection(
        connection,
        adapter.descriptor.displayName,
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_UNREADABLE",
        `The stored credential for ${connection.name} could not be decrypted with the active key.`,
        false,
      );
    }
    if (!credential) {
      return unavailableConnection(
        connection,
        adapter.descriptor.displayName,
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_NOT_CONFIGURED",
        `Credentials are not configured for ${connection.name}.`,
        false,
        "not_configured",
      );
    }

    let catalog: FulfillmentProviderConnectionCatalog;
    try {
      catalog = normalizeConnectionCatalog(await adapter.loadCatalog({
        connectionId: connection.id,
        connectionName: connection.name,
        credential,
      }), credential);
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: validDate((this.deps.clock ?? systemClock).now()).toISOString(),
        level: "error",
        event: "shipping.fulfillment_provider.catalog_adapter_failed",
        connectionId: connection.id,
        provider: connection.provider,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      return unavailableConnection(
        connection,
        adapter.descriptor.displayName,
        "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_ADAPTER_FAILED",
        `The ${adapter.descriptor.displayName} connection failed while loading fulfillment methods.`,
        true,
      );
    }
    if (catalog.status === "available") {
      const invalidReason = validateAvailableCatalog(connection, catalog.methods);
      if (invalidReason) {
        return unavailableConnection(
          connection,
          adapter.descriptor.displayName,
          "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_INVALID_RESPONSE",
          `The ${adapter.descriptor.displayName} adapter returned an invalid method catalog: ${invalidReason}`,
          false,
        );
      }
    }
    return {
      catalog,
      result: {
        connectionId: connection.id,
        connectionRevision: connection.revision,
        connectionName: connection.name,
        provider: connection.provider,
        providerDisplayName: adapter.descriptor.displayName,
        status: catalog.status,
        methodCount: catalog.methods.length,
        code: catalog.status === "available" ? null : catalog.code,
        message: catalog.status === "available" ? null : catalog.message,
        retryable: catalog.status === "available" ? false : catalog.retryable,
      },
    };
  }

  private async resolveCredential(
    connection: FulfillmentProviderConnectionCatalogState,
  ): Promise<string | null> {
    if (connection.credentialSource === "environment") {
      if (!connection.credentialRef) return null;
      return (this.deps.environment ?? process.env)[connection.credentialRef]?.trim() || null;
    }
    const encrypted = await this.deps.store.getCredential(connection.id);
    if (!encrypted || !this.deps.credentialCipher) return null;
    return this.deps.credentialCipher.open({ connection, credential: encrypted }).trim() || null;
  }
}

function normalizeConnectionCatalog(
  catalog: FulfillmentProviderConnectionCatalog,
  credential: string,
): FulfillmentProviderConnectionCatalog {
  if (catalog.status === "available") return catalog;
  if (
    typeof catalog.code !== "string"
    || !ERROR_CODE_PATTERN.test(catalog.code)
    || typeof catalog.message !== "string"
    || !catalog.message.trim()
    || catalog.message.length > 500
    || typeof catalog.retryable !== "boolean"
  ) {
    return {
      status: "unavailable",
      code: "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_INVALID_RESPONSE",
      message: "The fulfillment provider adapter returned an invalid catalog response.",
      retryable: false,
      methods: [],
    };
  }
  return {
    status: catalog.status,
    code: catalog.code,
    message: redactCredential(catalog.message.trim(), credential),
    retryable: catalog.retryable,
    methods: [],
  };
}

function redactCredential(message: string, credential: string): string {
  return credential ? message.split(credential).join("[REDACTED]") : message;
}

function validateAvailableCatalog(
  connection: FulfillmentProviderConnectionCatalogState,
  methods: readonly ShippingFulfillmentCatalogMethod[],
): string | null {
  if (!Array.isArray(methods)) return "methods is not an array.";
  if (methods.length > MAX_METHODS_PER_CONNECTION) {
    return `method count exceeds ${MAX_METHODS_PER_CONNECTION}.`;
  }
  const seen = new Set<string>();
  for (const [index, method] of methods.entries()) {
    if (!method || typeof method !== "object") return `method ${index} is invalid.`;
    if (method.providerConnectionId !== connection.id) {
      return `method ${index} has the wrong connection id.`;
    }
    if (method.providerConnectionName !== connection.name) {
      return `method ${index} has the wrong connection name.`;
    }
    if (method.provider !== connection.provider) {
      return `method ${index} has the wrong provider key.`;
    }
    const stringFields: Array<[string, unknown, number]> = [
      ["providerAccountId", method.providerAccountId, 120],
      ["providerAccountName", method.providerAccountName, 160],
      ["carrierCode", method.carrierCode, 50],
      ["carrierName", method.carrierName, 160],
      ["serviceCode", method.serviceCode, 80],
      ["serviceName", method.serviceName, 160],
    ];
    for (const [field, value, maxLength] of stringFields) {
      if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
        return `method ${index} has an invalid ${field}.`;
      }
    }
    if (typeof method.domestic !== "boolean" || typeof method.international !== "boolean") {
      return `method ${index} has invalid destination flags.`;
    }
    const identity = [
      method.providerConnectionId,
      method.provider,
      method.providerAccountId,
      method.serviceCode,
    ].join("\u0000");
    if (seen.has(identity)) return `method ${index} duplicates another method identity.`;
    seen.add(identity);
  }
  return null;
}

function unavailableConnection(
  connection: FulfillmentProviderConnectionCatalogState,
  providerDisplayName: string,
  code: string,
  message: string,
  retryable: boolean,
  status: "not_configured" | "unavailable" = "unavailable",
): {
  catalog: FulfillmentProviderConnectionCatalog;
  result: ShippingFulfillmentCatalogConnectionResult;
} {
  const catalog: FulfillmentProviderConnectionCatalog = {
    status,
    code,
    message,
    retryable,
    methods: [],
  };
  return {
    catalog,
    result: {
      connectionId: connection.id,
      connectionRevision: connection.revision,
      connectionName: connection.name,
      provider: connection.provider,
      providerDisplayName,
      status,
      methodCount: 0,
      code,
      message,
      retryable,
    },
  };
}

function compareMethods(
  left: ShippingFulfillmentCatalogMethod,
  right: ShippingFulfillmentCatalogMethod,
): number {
  return left.providerConnectionName.localeCompare(right.providerConnectionName)
    || left.providerConnectionId - right.providerConnectionId
    || left.providerAccountName.localeCompare(right.providerAccountName)
    || left.providerAccountId.localeCompare(right.providerAccountId)
    || left.carrierName.localeCompare(right.carrierName)
    || left.serviceName.localeCompare(right.serviceName)
    || left.serviceCode.localeCompare(right.serviceCode);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function validDate(value: Date): Date {
  const cloned = new Date(value.getTime());
  if (Number.isNaN(cloned.getTime())) {
    throw new Error("Fulfillment provider catalog clock returned an invalid date.");
  }
  return cloned;
}

const systemClock: Clock = { now: () => new Date() };
