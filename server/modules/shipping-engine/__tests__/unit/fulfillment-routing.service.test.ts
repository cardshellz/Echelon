import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ShippingFulfillmentCatalog,
  ShippingFulfillmentCatalogMethod,
  ShippingFulfillmentRoutingServiceLevel,
} from "@shared/types/shipping-fulfillment-routing";
import {
  commandHash,
  FulfillmentRoutingError,
  FulfillmentRoutingService,
  type FulfillmentRoutingProfileState,
  type FulfillmentRoutingStore,
  type FulfillmentRoutingTransaction,
} from "../../application/fulfillment-routing.service";

const serviceLevel: ShippingFulfillmentRoutingServiceLevel = {
  id: 7,
  code: "standard",
  displayName: "Standard Shipping",
  fulfillmentMode: "parcel",
  isActive: true,
};

const METHOD_CAPABILITIES = {
  supportsMultiPackage: true,
  supportsReturns: true,
  supportsPrepaidDutiesTaxes: false,
  sendRates: true,
  displaySchemes: ["label"],
};

const fedexGround: ShippingFulfillmentCatalogMethod = {
  providerConnectionId: 11,
  providerConnectionName: "Primary ShipStation",
  provider: "shipstation_v2",
  providerAccountId: "se-fedex-1",
  providerAccountName: "Card Shellz FedEx",
  carrierCode: "fedex",
  carrierName: "FedEx",
  serviceCode: "fedex_ground",
  serviceName: "FedEx Ground",
  domestic: true,
  international: false,
  capabilities: METHOD_CAPABILITIES,
};

const uspsGround: ShippingFulfillmentCatalogMethod = {
  providerConnectionId: 11,
  providerConnectionName: "Primary ShipStation",
  provider: "shipstation_v2",
  providerAccountId: "se-usps-1",
  providerAccountName: "Card Shellz USPS",
  carrierCode: "stamps_com",
  carrierName: "USPS",
  serviceCode: "usps_ground_advantage",
  serviceName: "USPS Ground Advantage",
  domestic: true,
  international: false,
  capabilities: METHOD_CAPABILITIES,
};

afterEach(() => vi.restoreAllMocks());

describe("FulfillmentRoutingService", () => {
  it("includes destination scope in the idempotency hash", () => {
    const domestic = identity(fedexGround);
    const international = { ...domestic, domestic: false, international: true };

    expect(commandHash(7, [domestic])).not.toBe(commandHash(7, [international]));
  });

  it("rejects a selected identity with no destination scope", async () => {
    const { store } = fakeStore(profile());
    const service = new FulfillmentRoutingService({
      store,
      catalogProvider: provider(availableCatalog()),
    });

    await expect(service.replaceProfile({
      serviceLevelId: 7,
      actorUserId: "operator-1",
      command: {
        expectedRevision: 0,
        idempotencyKey: "routing-command-invalid-scope",
        methods: [{ ...identity(fedexGround), domestic: false, international: false }],
      },
    })).rejects.toMatchObject({
      status: 400,
      code: "SHIPPING_FULFILLMENT_ROUTING_INVALID_INPUT",
    });
    expect(store.transaction).not.toHaveBeenCalled();
  });

  it("resolves exact provider methods, preserves preference order, and writes one audited revision", async () => {
    const { store, tx } = fakeStore(profile());
    const audit = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const service = new FulfillmentRoutingService({
      store,
      catalogProvider: provider(availableCatalog()),
      clock: { now: () => new Date("2026-09-01T12:00:00.000Z") },
    });

    const result = await service.replaceProfile({
      serviceLevelId: 7,
      actorUserId: "operator-1",
      command: {
        expectedRevision: 0,
        idempotencyKey: "routing-command-00000001",
        methods: [
          identity(uspsGround),
          identity(fedexGround),
        ],
      },
    });

    expect(result).toMatchObject({
      commandRevision: 1,
      idempotentReplay: false,
      profile: { revision: 1, updatedBy: "operator-1" },
    });
    expect(result.profile.methods.map((method) => ({
      serviceCode: method.serviceCode,
      priority: method.priority,
    }))).toEqual([
      { serviceCode: "usps_ground_advantage", priority: 1 },
      { serviceCode: "fedex_ground", priority: 2 },
    ]);
    expect(tx.createRevision).toHaveBeenCalledWith(expect.objectContaining({
      revision: 1,
      supersedesRevisionId: null,
      actorUserId: "operator-1",
      catalogHash: "a".repeat(64),
    }));
    expect(tx.lockProviderConnections).toHaveBeenCalledWith([{
      connectionId: 11,
      expectedRevision: 1,
      provider: "shipstation_v2",
    }]);
    expect(tx.replaceMethods).toHaveBeenCalledWith(expect.objectContaining({
      serviceLevelId: 7,
      revisionId: 91,
      methods: result.profile.methods,
    }));
    expect(tx.advanceProfile).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 0,
      nextRevision: 1,
      revisionId: 91,
    }));
    expect(audit).toHaveBeenCalledWith(expect.stringContaining(
      '"action":"shipping.fulfillment_routing.replaced"',
    ));
  });

  it("fails closed when a requested method is absent from the fresh provider catalog", async () => {
    const { store } = fakeStore(profile());
    const service = new FulfillmentRoutingService({
      store,
      catalogProvider: provider(availableCatalog([fedexGround])),
    });

    await expect(service.replaceProfile({
      serviceLevelId: 7,
      actorUserId: "operator-1",
      command: {
        expectedRevision: 0,
        idempotencyKey: "routing-command-00000002",
        methods: [identity(uspsGround)],
      },
    })).rejects.toMatchObject({
      status: 409,
      code: "SHIPPING_FULFILLMENT_ROUTING_METHOD_NOT_AVAILABLE",
    });
    expect(store.transaction).not.toHaveBeenCalled();
  });

  it("saves domestic and international variants sharing one provider service code", async () => {
    const domestic = { ...fedexGround, serviceCode: "shared_service" };
    const international = {
      ...domestic,
      domestic: false,
      international: true,
      capabilities: { ...METHOD_CAPABILITIES, supportsReturns: false },
    };
    const { store, tx } = fakeStore(profile());
    const service = new FulfillmentRoutingService({
      store,
      catalogProvider: provider(availableCatalog([domestic, international])),
    });

    const result = await service.replaceProfile({
      serviceLevelId: 7,
      actorUserId: "operator-1",
      command: {
        expectedRevision: 0,
        idempotencyKey: "routing-command-scoped-variants",
        methods: [identity(domestic), identity(international)],
      },
    });

    expect(result.profile.methods).toMatchObject([
      { serviceCode: "shared_service", domestic: true, international: false, priority: 1 },
      { serviceCode: "shared_service", domestic: false, international: true, priority: 2 },
    ]);
    expect(tx.replaceMethods).toHaveBeenCalledOnce();
  });

  it("rejects a stale optimistic revision after locking the service level", async () => {
    const { store, tx } = fakeStore(profile({ revision: 3, currentRevisionId: 89 }));
    const service = new FulfillmentRoutingService({
      store,
      catalogProvider: provider(availableCatalog()),
    });

    await expect(service.replaceProfile({
      serviceLevelId: 7,
      actorUserId: "operator-1",
      command: {
        expectedRevision: 2,
        idempotencyKey: "routing-command-00000003",
        methods: [identity(fedexGround)],
      },
    })).rejects.toMatchObject({
      status: 409,
      code: "SHIPPING_FULFILLMENT_ROUTING_REVISION_CONFLICT",
    });
    expect(tx.createRevision).not.toHaveBeenCalled();
  });

  it("replays an identical command before checking its now-stale expected revision", async () => {
    const current = profile({
      revision: 2,
      currentRevisionId: 92,
      methods: [{ ...fedexGround, priority: 1 }],
    });
    const { store, tx } = fakeStore(current);
    const service = new FulfillmentRoutingService({
      store,
      catalogProvider: provider(availableCatalog()),
    });
    const command = {
      expectedRevision: 0,
      idempotencyKey: "routing-command-00000004",
      methods: [identity(fedexGround)],
    };
    const requestHash = commandHash(7, command.methods);
    tx.findRevisionByIdempotencyKey.mockResolvedValue({
      id: 91,
      serviceLevelId: 7,
      revision: 1,
      requestHash,
    });

    const result = await service.replaceProfile({
      serviceLevelId: 7,
      actorUserId: "operator-1",
      command,
    });

    expect(result).toMatchObject({
      commandRevision: 1,
      idempotentReplay: true,
      profile: { revision: 2 },
    });
    expect(tx.createRevision).not.toHaveBeenCalled();
  });

  it("does not write a routing revision when a provider connection changes after catalog load", async () => {
    const { store, tx } = fakeStore(profile());
    tx.lockProviderConnections.mockRejectedValue(new FulfillmentRoutingError(
      409,
      "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_CONNECTION_UNAVAILABLE",
      "Provider connection changed.",
    ));
    const service = new FulfillmentRoutingService({
      store,
      catalogProvider: provider(availableCatalog()),
    });

    await expect(service.replaceProfile({
      serviceLevelId: 7,
      actorUserId: "operator-1",
      command: {
        expectedRevision: 0,
        idempotencyKey: "routing-command-00000006",
        methods: [identity(fedexGround)],
      },
    })).rejects.toMatchObject({
      code: "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_CONNECTION_UNAVAILABLE",
    });
    expect(tx.createRevision).not.toHaveBeenCalled();
    expect(tx.replaceMethods).not.toHaveBeenCalled();
  });

  it("returns the saved routing profile even when the provider catalog is unavailable", async () => {
    const current = profile({
      revision: 1,
      currentRevisionId: 91,
      methods: [{ ...fedexGround, priority: 1 }],
    });
    const { store } = fakeStore(current);
    const service = new FulfillmentRoutingService({
      store,
      catalogProvider: provider({
        status: "unavailable",
        code: "SHIPPING_FULFILLMENT_ROUTING_SHIPSTATION_UNAVAILABLE",
        message: "Provider is unavailable.",
        retryable: true,
        methods: [],
        connections: [],
      }),
    });

    await expect(service.getAdminView(7)).resolves.toMatchObject({
      profile: {
        revision: 1,
        methods: [{ serviceCode: "fedex_ground" }],
      },
      catalog: { status: "unavailable" },
    });
  });

  it("classifies a reused idempotency key with different methods as a conflict", async () => {
    const { store, tx } = fakeStore(profile({ revision: 1, currentRevisionId: 91 }));
    tx.findRevisionByIdempotencyKey.mockResolvedValue({
      id: 91,
      serviceLevelId: 7,
      revision: 1,
      requestHash: "f".repeat(64),
    });
    const service = new FulfillmentRoutingService({
      store,
      catalogProvider: provider(availableCatalog()),
    });

    await expect(service.replaceProfile({
      serviceLevelId: 7,
      actorUserId: "operator-1",
      command: {
        expectedRevision: 1,
        idempotencyKey: "routing-command-00000005",
        methods: [identity(fedexGround)],
      },
    })).rejects.toBeInstanceOf(FulfillmentRoutingError);
    await expect(service.replaceProfile({
      serviceLevelId: 7,
      actorUserId: "operator-1",
      command: {
        expectedRevision: 1,
        idempotencyKey: "routing-command-00000005",
        methods: [identity(fedexGround)],
      },
    })).rejects.toMatchObject({
      code: "SHIPPING_FULFILLMENT_ROUTING_IDEMPOTENCY_CONFLICT",
    });
  });
});

function fakeStore(current: FulfillmentRoutingProfileState): {
  store: FulfillmentRoutingStore & { transaction: ReturnType<typeof vi.fn> };
  tx: Record<keyof FulfillmentRoutingTransaction, ReturnType<typeof vi.fn>>;
} {
  const tx = {
    getServiceLevelForUpdate: vi.fn().mockResolvedValue(serviceLevel),
    lockProviderConnections: vi.fn().mockResolvedValue(undefined),
    ensureProfile: vi.fn().mockResolvedValue(undefined),
    getProfileForUpdate: vi.fn().mockResolvedValue(current),
    findRevisionByIdempotencyKey: vi.fn().mockResolvedValue(null),
    createRevision: vi.fn().mockResolvedValue(91),
    replaceMethods: vi.fn().mockResolvedValue(undefined),
    advanceProfile: vi.fn().mockResolvedValue(undefined),
  };
  const transaction = vi.fn(async (work: (value: FulfillmentRoutingTransaction) => Promise<unknown>) => work(tx));
  return {
    tx,
    store: {
      getServiceLevel: vi.fn().mockResolvedValue(serviceLevel),
      getProfile: vi.fn().mockResolvedValue(current),
      transaction,
    },
  };
}

function profile(
  overrides: Partial<FulfillmentRoutingProfileState> = {},
): FulfillmentRoutingProfileState {
  return {
    serviceLevelId: 7,
    revision: 0,
    currentRevisionId: null,
    methods: [],
    legacyUnscopedMethodCount: 0,
    updatedBy: null,
    updatedAt: null,
    ...overrides,
  };
}

function provider(catalog: ShippingFulfillmentCatalog) {
  return { loadCatalog: vi.fn().mockResolvedValue(catalog) };
}

function availableCatalog(
  methods: ShippingFulfillmentCatalogMethod[] = [fedexGround, uspsGround],
): ShippingFulfillmentCatalog {
  const connections = [...new Map(methods.map((method) => [method.providerConnectionId, {
    connectionId: method.providerConnectionId,
    connectionRevision: 1,
    connectionName: method.providerConnectionName,
    provider: method.provider,
    providerDisplayName: "ShipStation",
    status: "available" as const,
    methodCount: methods.filter((candidate) => (
      candidate.providerConnectionId === method.providerConnectionId
    )).length,
    code: null,
    message: null,
    retryable: false,
  }])).values()];
  return {
    status: "available",
    catalogHash: "a".repeat(64),
    fetchedAt: "2026-09-01T11:59:00.000Z",
    methods,
    connections,
  };
}

function identity(method: ShippingFulfillmentCatalogMethod) {
  return {
    providerConnectionId: method.providerConnectionId,
    provider: method.provider,
    providerAccountId: method.providerAccountId,
    serviceCode: method.serviceCode,
    domestic: method.domestic,
    international: method.international,
  };
}
