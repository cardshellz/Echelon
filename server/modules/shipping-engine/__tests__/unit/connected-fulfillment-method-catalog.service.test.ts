import { describe, expect, it, vi } from "vitest";
import {
  ConnectedFulfillmentMethodCatalogService,
  StaticFulfillmentProviderRegistry,
  type FulfillmentProviderAdapter,
  type FulfillmentProviderConnectionCatalogState,
  type FulfillmentProviderCredentialRecord,
} from "../../application/connected-fulfillment-method-catalog.service";

describe("ConnectedFulfillmentMethodCatalogService", () => {
  it("rejects invalid or duplicate adapter registrations at composition time", () => {
    const adapter = fakeAdapter(async () => ({ status: "available", methods: [] }));
    expect(() => new StaticFulfillmentProviderRegistry([
      adapter,
      adapter,
    ])).toThrow("Duplicate or invalid fulfillment provider registration");
    expect(() => new StaticFulfillmentProviderRegistry([{
      ...adapter,
      descriptor: { ...adapter.descriptor, provider: "Invalid Provider" },
    }])).toThrow("Duplicate or invalid fulfillment provider registration");
  });

  it("loads a newly registered provider without a core catalog code change", async () => {
    const adapter = {
      descriptor: {
        provider: "direct_carrier",
        displayName: "Direct Carrier",
        credentialLabel: "API key",
        supportsManagedConnections: true,
      },
      verifyCredential: vi.fn(),
      loadCatalog: vi.fn(async (input) => ({
        status: "available" as const,
        methods: [{
          providerConnectionId: input.connectionId,
          providerConnectionName: input.connectionName,
          provider: "direct_carrier",
          providerAccountId: "direct-account",
          providerAccountName: "Direct account",
          carrierCode: "direct",
          carrierName: "Direct Carrier",
          serviceCode: "ground",
          serviceName: "Ground",
          domestic: true,
          international: false,
        }],
      })),
    } satisfies FulfillmentProviderAdapter;
    const service = new ConnectedFulfillmentMethodCatalogService({
      store: {
        listCatalogConnections: vi.fn().mockResolvedValue([{
          ...connection(),
          provider: "direct_carrier",
          name: "Direct account",
          credentialRef: "DIRECT_CARRIER_KEY",
        }]),
        getCredential: vi.fn().mockResolvedValue(null),
      },
      registry: new StaticFulfillmentProviderRegistry([adapter]),
      credentialCipher: null,
      environment: { DIRECT_CARRIER_KEY: "direct-secret" },
      clock: { now: () => new Date("2026-09-02T12:00:00.000Z") },
    });

    await expect(service.loadCatalog()).resolves.toMatchObject({
      status: "available",
      methods: [{ provider: "direct_carrier", providerConnectionId: 11 }],
    });
  });

  it("loads active environment connections and stamps exact connection identity", async () => {
    const adapter = fakeAdapter(async (input) => ({
      status: "available",
      methods: [method(input.connectionId, input.connectionName)],
    }));
    const service = catalogService({
      connections: [connection(), { ...connection(), id: 12, name: "Disabled", status: "disabled" }],
      adapter,
      environment: { SHIPSTATION_V2_API_KEY: " secret " },
    });

    const result = await service.loadCatalog();

    expect(adapter.loadCatalog).toHaveBeenCalledOnce();
    expect(adapter.loadCatalog).toHaveBeenCalledWith({
      connectionId: 11,
      connectionName: "Primary ShipStation",
      credential: "secret",
    });
    expect(result).toMatchObject({
      status: "available",
      fetchedAt: "2026-09-02T12:00:00.000Z",
      methods: [{ providerConnectionId: 11, providerConnectionName: "Primary ShipStation" }],
      connections: [{ connectionId: 11, status: "available", methodCount: 1 }],
    });
    if (result.status !== "available") throw new Error("Expected catalog.");
    expect(result.catalogHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps healthy connection methods available when another connection fails", async () => {
    const adapter = fakeAdapter(async (input) => input.credential === "good"
      ? { status: "available", methods: [method(input.connectionId, input.connectionName)] }
      : {
          status: "unavailable",
          code: "PROVIDER_TEMPORARY_FAILURE",
          message: "Provider is temporarily unavailable.",
          retryable: true,
          methods: [],
        });
    const service = catalogService({
      connections: [
        connection(),
        { ...connection(), id: 12, name: "Backup ShipStation", credentialRef: "BACKUP_KEY" },
      ],
      adapter,
      environment: { SHIPSTATION_V2_API_KEY: "bad", BACKUP_KEY: "good" },
    });

    await expect(service.loadCatalog()).resolves.toMatchObject({
      status: "available",
      methods: [{ providerConnectionId: 12 }],
      connections: [
        { connectionId: 11, status: "unavailable", code: "PROVIDER_TEMPORARY_FAILURE" },
        { connectionId: 12, status: "available" },
      ],
    });
  });

  it("redacts a connection credential from adapter failure messages", async () => {
    const adapter = fakeAdapter(async (input) => ({
      status: "unavailable",
      code: "PROVIDER_AUTH_REJECTED",
      message: `Provider rejected ${input.credential}.`,
      retryable: false,
      methods: [],
    }));
    const service = catalogService({
      connections: [connection()],
      adapter,
      environment: { SHIPSTATION_V2_API_KEY: "sensitive-secret" },
    });

    const result = await service.loadCatalog();

    expect(JSON.stringify(result)).not.toContain("sensitive-secret");
    expect(result).toMatchObject({
      status: "unavailable",
      message: "Provider rejected [REDACTED].",
    });
  });

  it("contains an unexpected adapter exception to the affected connection", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapter = fakeAdapter(async (input) => {
      if (input.credential === "bad") throw new Error("unexpected sensitive bad");
      return { status: "available", methods: [method(input.connectionId, input.connectionName)] };
    });
    const service = catalogService({
      connections: [
        connection(),
        { ...connection(), id: 12, name: "Backup ShipStation", credentialRef: "BACKUP_KEY" },
      ],
      adapter,
      environment: { SHIPSTATION_V2_API_KEY: "bad", BACKUP_KEY: "good" },
    });

    const result = await service.loadCatalog();

    expect(result).toMatchObject({
      status: "available",
      methods: [{ providerConnectionId: 12 }],
      connections: [
        { connectionId: 11, code: "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_ADAPTER_FAILED" },
        { connectionId: 12, status: "available" },
      ],
    });
    expect(log).toHaveBeenCalledWith(expect.not.stringContaining("sensitive"));
    log.mockRestore();
  });

  it("classifies an unreadable vault credential without calling the provider", async () => {
    const adapter = fakeAdapter(async () => ({ status: "available", methods: [] }));
    const encrypted: FulfillmentProviderCredentialRecord = {
      connectionId: 11,
      keyId: "key-1",
      ciphertext: "ciphertext",
      iv: "iv",
      authTag: "tag",
    };
    const service = new ConnectedFulfillmentMethodCatalogService({
      store: {
        listCatalogConnections: vi.fn().mockResolvedValue([
          { ...connection(), credentialSource: "vault", credentialRef: null },
        ]),
        getCredential: vi.fn().mockResolvedValue(encrypted),
      },
      registry: new StaticFulfillmentProviderRegistry([adapter]),
      credentialCipher: {
        seal: vi.fn(),
        open: vi.fn(() => { throw new Error("bad key"); }),
      },
    });

    await expect(service.loadCatalog()).resolves.toMatchObject({
      status: "unavailable",
      code: "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_UNREADABLE",
      connections: [{ code: "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_UNREADABLE" }],
    });
    expect(adapter.loadCatalog).not.toHaveBeenCalled();
  });

  it("rejects a provider adapter that returns methods for a different connection", async () => {
    const adapter = fakeAdapter(async () => ({
      status: "available",
      methods: [method(99, "Wrong connection")],
    }));
    const service = catalogService({
      connections: [connection()],
      adapter,
      environment: { SHIPSTATION_V2_API_KEY: "secret" },
    });

    await expect(service.loadCatalog()).resolves.toMatchObject({
      status: "unavailable",
      code: "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_INVALID_RESPONSE",
      connections: [{
        connectionId: 11,
        status: "unavailable",
        code: "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_INVALID_RESPONSE",
      }],
    });
  });

  it("requires at least one enabled connection", async () => {
    const adapter = fakeAdapter(async () => ({ status: "available", methods: [] }));
    const service = catalogService({ connections: [], adapter, environment: {} });

    await expect(service.loadCatalog()).resolves.toMatchObject({
      status: "not_configured",
      code: "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_REQUIRED",
    });
  });
});

function catalogService(input: {
  connections: FulfillmentProviderConnectionCatalogState[];
  adapter: FulfillmentProviderAdapter & { loadCatalog: ReturnType<typeof vi.fn> };
  environment: Record<string, string | undefined>;
}) {
  return new ConnectedFulfillmentMethodCatalogService({
    store: {
      listCatalogConnections: vi.fn().mockResolvedValue(input.connections),
      getCredential: vi.fn().mockResolvedValue(null),
    },
    registry: new StaticFulfillmentProviderRegistry([input.adapter]),
    credentialCipher: null,
    environment: input.environment,
    clock: { now: () => new Date("2026-09-02T12:00:00.000Z") },
  });
}

function fakeAdapter(load: FulfillmentProviderAdapter["loadCatalog"]): FulfillmentProviderAdapter & {
  loadCatalog: ReturnType<typeof vi.fn>;
} {
  return {
    descriptor: {
      provider: "shipstation_v2",
      displayName: "ShipStation",
      credentialLabel: "API key",
      supportsManagedConnections: true,
    },
    verifyCredential: vi.fn(),
    loadCatalog: vi.fn(load),
  };
}

function connection(): FulfillmentProviderConnectionCatalogState {
  return {
    id: 11,
    provider: "shipstation_v2",
    name: "Primary ShipStation",
    status: "active",
    credentialSource: "environment",
    credentialRef: "SHIPSTATION_V2_API_KEY",
    revision: 1,
  };
}

function method(connectionId: number, connectionName: string) {
  return {
    providerConnectionId: connectionId,
    providerConnectionName: connectionName,
    provider: "shipstation_v2",
    providerAccountId: "se-ups",
    providerAccountName: "Warehouse UPS",
    carrierCode: "ups",
    carrierName: "UPS",
    serviceCode: "ups_ground",
    serviceName: "UPS Ground",
    domestic: true,
    international: false,
  };
}
