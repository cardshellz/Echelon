import { describe, expect, it, vi } from "vitest";
import {
  StaticFulfillmentProviderRegistry,
  type FulfillmentProviderAdapter,
  type FulfillmentProviderCredentialRecord,
} from "../../application/connected-fulfillment-method-catalog.service";
import {
  FulfillmentProviderConnectionService,
  type AppendFulfillmentProviderConnectionEventInput,
  type FulfillmentProviderConnectionState,
  type FulfillmentProviderConnectionStore,
  type FulfillmentProviderConnectionTransaction,
} from "../../application/fulfillment-provider-connections.service";

describe("FulfillmentProviderConnectionService", () => {
  it("verifies, encrypts, persists, and audits a new connection without recording the secret", async () => {
    const adapter = fakeAdapter({ status: "available", methods: [] });
    const memory = memoryStore(null);
    const service = buildService(memory.store, adapter);
    const command = {
      provider: "shipstation_v2",
      name: "Primary ShipStation",
      credential: "high-entropy-secret",
      idempotencyKey: "provider-create-00000001",
    };

    const result = await service.createConnection({ command, actorUserId: "operator-1" });

    expect(result).toMatchObject({
      idempotentReplay: false,
      connection: {
        id: 11,
        name: "Primary ShipStation",
        status: "active",
        credentialConfigured: true,
        revision: 1,
      },
    });
    expect(adapter.verifyCredential).toHaveBeenCalledWith("high-entropy-secret");
    expect(memory.credential).toMatchObject({ ciphertext: "encrypted", connectionId: 11 });
    expect(JSON.stringify(memory.events)).not.toContain("high-entropy-secret");
    expect(memory.events[0]).toMatchObject({
      action: "created",
      connectionRevision: 1,
      actorUserId: "operator-1",
    });

    const replay = await service.createConnection({ command, actorUserId: "operator-1" });
    expect(replay.idempotentReplay).toBe(true);
    expect(adapter.verifyCredential).toHaveBeenCalledOnce();
    expect(memory.events).toHaveLength(1);
  });

  it("refuses to disable a connection referenced by active routes", async () => {
    const adapter = fakeAdapter({ status: "available", methods: [] });
    const memory = memoryStore(connection({ routedMethodCount: 2 }));
    const service = buildService(memory.store, adapter);

    await expect(service.setConnectionEnabled({
      connectionId: 11,
      enabled: false,
      command: { expectedRevision: 1, idempotencyKey: "provider-disable-000001" },
      actorUserId: "operator-1",
    })).rejects.toMatchObject({
      code: "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_IN_USE",
      status: 409,
    });
    expect(memory.store.transaction).not.toHaveBeenCalled();
  });

  it("records a classified verification failure and keeps it visible to administrators", async () => {
    const adapter = fakeAdapter({
      status: "unavailable",
      code: "SHIPSTATION_AUTH_REJECTED",
      message: "ShipStation rejected stored-secret.",
      retryable: false,
      methods: [],
    });
    const memory = memoryStore(connection());
    memory.credential = encryptedCredential();
    const service = buildService(memory.store, adapter);

    const result = await service.verifyConnection({
      connectionId: 11,
      command: { expectedRevision: 1, idempotencyKey: "provider-verify-0000001" },
      actorUserId: "operator-1",
    });

    expect(result.connection).toMatchObject({
      status: "error",
      revision: 2,
      lastErrorCode: "SHIPSTATION_AUTH_REJECTED",
      lastErrorMessage: "ShipStation rejected [REDACTED].",
    });
    expect(memory.events.at(-1)).toMatchObject({
      action: "verification_failed",
      connectionRevision: 2,
    });
    expect(JSON.stringify(memory.events)).not.toContain("stored-secret");
  });

  it("requires the dedicated vault before accepting a managed credential", async () => {
    const adapter = fakeAdapter({ status: "available", methods: [] });
    const memory = memoryStore(null);
    const service = new FulfillmentProviderConnectionService({
      store: memory.store,
      registry: new StaticFulfillmentProviderRegistry([adapter]),
      credentialCipher: null,
    });

    await expect(service.createConnection({
      command: {
        provider: "shipstation_v2",
        name: "Primary ShipStation",
        credential: "secret",
        idempotencyKey: "provider-create-00000002",
      },
      actorUserId: "operator-1",
    })).rejects.toMatchObject({
      code: "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_VAULT_NOT_CONFIGURED",
    });
    expect(adapter.verifyCredential).not.toHaveBeenCalled();
  });

  it("refuses a credential replacement that would invalidate an active route", async () => {
    const adapter = fakeAdapter({ status: "available", methods: [] });
    const memory = memoryStore(connection({ routedMethodCount: 1 }), [{
      provider: "shipstation_v2",
      providerAccountId: "se-ups",
      serviceCode: "ups_ground",
      domestic: true,
      international: false,
    }]);
    memory.credential = encryptedCredential();
    const service = buildService(memory.store, adapter);

    await expect(service.replaceCredential({
      connectionId: 11,
      command: {
        credential: "replacement-secret",
        expectedRevision: 1,
        idempotencyKey: "provider-credential-00001",
      },
      actorUserId: "operator-1",
    })).rejects.toMatchObject({
      code: "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_BREAKS_ACTIVE_ROUTES",
      status: 409,
      details: ["se-ups / ups_ground / domestic=true / international=false"],
    });
    expect(memory.credential).toEqual(encryptedCredential());
    expect(memory.events).toHaveLength(0);
  });

  it("rotates a credential when the replacement still exposes every active route", async () => {
    const adapter = fakeAdapter({
      status: "available",
      methods: [{
        providerConnectionId: 1,
        providerConnectionName: "Credential verification",
        provider: "shipstation_v2",
        providerAccountId: "se-ups",
        providerAccountName: "UPS account",
        carrierCode: "ups",
        carrierName: "UPS",
        serviceCode: "ups_ground",
        serviceName: "UPS Ground",
        domestic: true,
        international: false,
        capabilities: {
          supportsMultiPackage: true,
          supportsReturns: true,
          supportsPrepaidDutiesTaxes: false,
          sendRates: true,
          displaySchemes: ["label"],
        },
      }],
    });
    const memory = memoryStore(connection({ routedMethodCount: 1 }), [{
      provider: "shipstation_v2",
      providerAccountId: "se-ups",
      serviceCode: "ups_ground",
      domestic: true,
      international: false,
    }]);
    memory.credential = encryptedCredential();
    const service = buildService(memory.store, adapter);

    await expect(service.replaceCredential({
      connectionId: 11,
      command: {
        credential: "replacement-secret",
        expectedRevision: 1,
        idempotencyKey: "provider-credential-00002",
      },
      actorUserId: "operator-2",
    })).resolves.toMatchObject({
      idempotentReplay: false,
      connection: { status: "active", revision: 2 },
    });
    expect(memory.events.at(-1)).toMatchObject({
      action: "credential_replaced",
      connectionRevision: 2,
      actorUserId: "operator-2",
    });
  });

  it("does not substitute a domestic same-code method for an international active route", async () => {
    const adapter = fakeAdapter({
      status: "available",
      methods: [{
        providerConnectionId: 1,
        providerConnectionName: "Credential verification",
        provider: "shipstation_v2",
        providerAccountId: "se-ups",
        providerAccountName: "UPS account",
        carrierCode: "ups",
        carrierName: "UPS",
        serviceCode: "ups_worldwide_saver",
        serviceName: "UPS Worldwide Saver®",
        domestic: true,
        international: false,
        capabilities: {
          supportsMultiPackage: true,
          supportsReturns: true,
          supportsPrepaidDutiesTaxes: true,
          sendRates: true,
          displaySchemes: ["label"],
        },
      }],
    });
    const memory = memoryStore(connection({ routedMethodCount: 1 }), [{
      provider: "shipstation_v2",
      providerAccountId: "se-ups",
      serviceCode: "ups_worldwide_saver",
      domestic: false,
      international: true,
    }]);
    memory.credential = encryptedCredential();
    const service = buildService(memory.store, adapter);

    await expect(service.replaceCredential({
      connectionId: 11,
      command: {
        credential: "replacement-secret",
        expectedRevision: 1,
        idempotencyKey: "provider-credential-scoped-variant",
      },
      actorUserId: "operator-2",
    })).rejects.toMatchObject({
      code: "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_BREAKS_ACTIVE_ROUTES",
      details: [
        "se-ups / ups_worldwide_saver / domestic=false / international=true",
      ],
    });
  });
});

function buildService(
  store: FulfillmentProviderConnectionStore,
  adapter: FulfillmentProviderAdapter,
) {
  return new FulfillmentProviderConnectionService({
    store,
    registry: new StaticFulfillmentProviderRegistry([adapter]),
    credentialCipher: {
      seal: (input) => ({
        connectionId: input.connectionId,
        keyId: "key-1",
        ciphertext: "encrypted",
        iv: "iv",
        authTag: "tag",
      }),
      open: () => "stored-secret",
    },
    environment: { SHIPSTATION_V2_API_KEY: "environment-secret" },
    clock: { now: () => new Date("2026-09-02T12:00:00.000Z") },
  });
}

function fakeAdapter(result: Awaited<ReturnType<FulfillmentProviderAdapter["verifyCredential"]>>) {
  return {
    descriptor: {
      provider: "shipstation_v2",
      displayName: "ShipStation",
      credentialLabel: "API key",
      supportsManagedConnections: true,
    },
    verifyCredential: vi.fn().mockResolvedValue(result),
    loadCatalog: vi.fn(),
  } satisfies FulfillmentProviderAdapter;
}

function memoryStore(
  initial: FulfillmentProviderConnectionState | null,
  activeRouteMethods: Array<{
    provider: string;
    providerAccountId: string;
    serviceCode: string;
    domestic: boolean;
    international: boolean;
  }> = [],
): {
  store: FulfillmentProviderConnectionStore & { transaction: ReturnType<typeof vi.fn> };
  events: AppendFulfillmentProviderConnectionEventInput[];
  credential: FulfillmentProviderCredentialRecord | null;
} {
  let state = initial ? { ...initial } : null;
  const events: AppendFulfillmentProviderConnectionEventInput[] = [];
  const holder = {
    credential: null as FulfillmentProviderCredentialRecord | null,
  };
  const commands = new Map<string, { connectionId: number; requestHash: string }>();
  const tx: FulfillmentProviderConnectionTransaction = {
    lockIdempotencyKey: vi.fn().mockResolvedValue(undefined),
    findCommand: vi.fn(async (key: string) => commands.get(key) ?? null),
    createConnection: vi.fn(async (input) => {
      state = connection({
        provider: input.provider,
        name: input.name,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
        createdAt: input.now,
        updatedAt: input.now,
        lastVerifiedAt: input.now,
      });
      return 11;
    }),
    getConnectionForUpdate: vi.fn(async () => state ? {
      ...state,
      credentialPresent: holder.credential !== null,
    } : null),
    listActiveRouteMethods: vi.fn(async () => activeRouteMethods.map((method) => ({ ...method }))),
    saveCredential: vi.fn(async (input) => {
      holder.credential = { ...input.credential };
      if (state) state = { ...state, credentialPresent: true };
    }),
    updateConnection: vi.fn(async (input) => {
      if (!state || state.revision !== input.expectedRevision) throw new Error("revision conflict");
      state = {
        ...state,
        status: input.status,
        revision: state.revision + 1,
        lastVerifiedAt: input.lastVerifiedAt,
        lastErrorCode: input.lastErrorCode,
        lastErrorMessage: input.lastErrorMessage,
        updatedBy: input.actorUserId,
        updatedAt: input.now,
      };
    }),
    appendEvent: vi.fn(async (event) => {
      events.push(event);
      commands.set(event.idempotencyKey, {
        connectionId: event.connectionId,
        requestHash: event.requestHash,
      });
    }),
  };
  const transaction = vi.fn(async <T>(work: (value: FulfillmentProviderConnectionTransaction) => Promise<T>) => work(tx));
  const store: FulfillmentProviderConnectionStore & { transaction: ReturnType<typeof vi.fn> } = {
    listConnections: vi.fn(async () => state ? [{ ...state, credentialPresent: holder.credential !== null }] : []),
    getConnection: vi.fn(async () => state ? { ...state, credentialPresent: holder.credential !== null } : null),
    getCredential: vi.fn(async () => holder.credential),
    findCommand: vi.fn(async (key: string) => commands.get(key) ?? null),
    transaction,
  };
  const result = { store, events } as {
    store: typeof store;
    events: typeof events;
    credential: FulfillmentProviderCredentialRecord | null;
  };
  Object.defineProperty(result, "credential", {
    get: () => holder.credential,
    set: (value: FulfillmentProviderCredentialRecord | null) => { holder.credential = value; },
  });
  return result;
}

function connection(
  overrides: Partial<FulfillmentProviderConnectionState> = {},
): FulfillmentProviderConnectionState {
  return {
    id: 11,
    provider: "shipstation_v2",
    name: "Primary ShipStation",
    status: "active",
    credentialSource: "vault",
    credentialRef: null,
    credentialPresent: true,
    systemManaged: false,
    revision: 1,
    routedMethodCount: 0,
    lastVerifiedAt: new Date("2026-09-01T12:00:00.000Z"),
    lastErrorCode: null,
    lastErrorMessage: null,
    createdBy: "operator-1",
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    updatedBy: "operator-1",
    updatedAt: new Date("2026-09-01T12:00:00.000Z"),
    ...overrides,
  };
}

function encryptedCredential(): FulfillmentProviderCredentialRecord {
  return {
    connectionId: 11,
    keyId: "key-1",
    ciphertext: "encrypted",
    iv: "iv",
    authTag: "tag",
  };
}
