import { createHash } from "node:crypto";
import type {
  ReplaceShippingFulfillmentRoutingInput,
  ReplaceShippingFulfillmentRoutingResult,
  ShippingFulfillmentCatalog,
  ShippingFulfillmentCatalogConnectionResult,
  ShippingFulfillmentCatalogMethod,
  ShippingFulfillmentMethodIdentity,
  ShippingFulfillmentRouteMethod,
  ShippingFulfillmentRoutingAdminView,
  ShippingFulfillmentRoutingProfile,
  ShippingFulfillmentRoutingServiceLevel,
} from "@shared/types/shipping-fulfillment-routing";
import {
  resolveFulfillmentRouteCandidates,
  type FulfillmentRouteResolution,
  type FulfillmentRouteScope,
} from "../domain/fulfillment-routing";

const MAX_ROUTING_METHODS = 200;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;

export class FulfillmentRoutingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "FulfillmentRoutingError";
  }
}

export interface FulfillmentMethodCatalogProvider {
  loadCatalog(): Promise<ShippingFulfillmentCatalog>;
}

export interface FulfillmentRoutingProfileState {
  serviceLevelId: number;
  revision: number;
  currentRevisionId: number | null;
  methods: ShippingFulfillmentRouteMethod[];
  legacyUnscopedMethodCount: number;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface FulfillmentRoutingRevisionIdentity {
  id: number;
  serviceLevelId: number;
  revision: number;
  requestHash: string;
}

export interface CreateFulfillmentRoutingRevisionInput {
  serviceLevelId: number;
  revision: number;
  idempotencyKey: string;
  requestHash: string;
  catalogHash: string;
  catalogFetchedAt: Date;
  supersedesRevisionId: number | null;
  methods: ShippingFulfillmentRouteMethod[];
  actorUserId: string;
  now: Date;
}

export interface FulfillmentRoutingProviderConnectionExpectation {
  connectionId: number;
  expectedRevision: number;
  provider: string;
}

export interface FulfillmentRoutingTransaction {
  getServiceLevelForUpdate(serviceLevelId: number): Promise<ShippingFulfillmentRoutingServiceLevel | null>;
  lockProviderConnections(
    connections: readonly FulfillmentRoutingProviderConnectionExpectation[],
  ): Promise<void>;
  ensureProfile(serviceLevelId: number, now: Date): Promise<void>;
  getProfileForUpdate(serviceLevelId: number): Promise<FulfillmentRoutingProfileState>;
  findRevisionByIdempotencyKey(
    serviceLevelId: number,
    idempotencyKey: string,
  ): Promise<FulfillmentRoutingRevisionIdentity | null>;
  createRevision(input: CreateFulfillmentRoutingRevisionInput): Promise<number>;
  replaceMethods(input: {
    serviceLevelId: number;
    revisionId: number;
    methods: ShippingFulfillmentRouteMethod[];
    now: Date;
  }): Promise<void>;
  advanceProfile(input: {
    serviceLevelId: number;
    expectedRevision: number;
    nextRevision: number;
    revisionId: number;
    actorUserId: string;
    now: Date;
  }): Promise<void>;
}

export interface FulfillmentRoutingStore {
  getServiceLevel(serviceLevelId: number): Promise<ShippingFulfillmentRoutingServiceLevel | null>;
  getProfile(serviceLevelId: number): Promise<FulfillmentRoutingProfileState>;
  transaction<T>(work: (tx: FulfillmentRoutingTransaction) => Promise<T>): Promise<T>;
}

interface Clock {
  now(): Date;
}

/** Runtime reader used by fulfillment/channel integrations without provider I/O. */
export class FulfillmentRoutingResolver {
  constructor(private readonly store: Pick<
    FulfillmentRoutingStore,
    "getServiceLevel" | "getProfile"
  >) {}

  async resolve(input: {
    serviceLevelId: number;
    scope: FulfillmentRouteScope;
  }): Promise<FulfillmentRouteResolution> {
    const serviceLevelId = positiveInteger(input.serviceLevelId, "serviceLevelId");
    if (input.scope !== "domestic" && input.scope !== "international") {
      invalidInput("scope", "must be domestic or international");
    }
    const serviceLevel = await this.store.getServiceLevel(serviceLevelId);
    if (!serviceLevel) throw serviceLevelNotFound(serviceLevelId);
    return resolveFulfillmentRouteCandidates(
      profileView(await this.store.getProfile(serviceLevelId)),
      input.scope,
    );
  }
}

export class FulfillmentRoutingService {
  constructor(private readonly deps: {
    store: FulfillmentRoutingStore;
    catalogProvider: FulfillmentMethodCatalogProvider;
    clock?: Clock;
  }) {}

  /**
   * Read contract for future fulfillment consumers. Only exact, scoped current
   * methods are returned; legacy unscoped rows are evidence, never routes.
   */
  async getProfile(serviceLevelId: number): Promise<ShippingFulfillmentRoutingProfile> {
    const id = positiveInteger(serviceLevelId, "serviceLevelId");
    const serviceLevel = await this.deps.store.getServiceLevel(id);
    if (!serviceLevel) throw serviceLevelNotFound(id);
    return profileView(await this.deps.store.getProfile(id));
  }

  async getAdminView(serviceLevelId: number): Promise<ShippingFulfillmentRoutingAdminView> {
    const id = positiveInteger(serviceLevelId, "serviceLevelId");
    const serviceLevel = await this.deps.store.getServiceLevel(id);
    if (!serviceLevel) throw serviceLevelNotFound(id);
    const [profile, catalog] = await Promise.all([
      this.deps.store.getProfile(id),
      this.deps.catalogProvider.loadCatalog(),
    ]);
    return { serviceLevel, profile: profileView(profile), catalog };
  }

  async replaceProfile(input: {
    serviceLevelId: number;
    command: ReplaceShippingFulfillmentRoutingInput;
    actorUserId: string;
  }): Promise<ReplaceShippingFulfillmentRoutingResult> {
    const serviceLevelId = positiveInteger(input.serviceLevelId, "serviceLevelId");
    const command = normalizeCommand(input.command);
    const actorUserId = requiredString(input.actorUserId, "actorUserId", 120);

    // Reject an invalid service-level id before making an external provider call.
    const existingServiceLevel = await this.deps.store.getServiceLevel(serviceLevelId);
    if (!existingServiceLevel) throw serviceLevelNotFound(serviceLevelId);

    const catalog = await this.deps.catalogProvider.loadCatalog();
    if (catalog.status !== "available") {
      throw new FulfillmentRoutingError(
        catalog.status === "not_configured" ? 409 : 503,
        catalog.code,
        catalog.message,
      );
    }
    const methods = resolveRequestedMethods(command.methods, catalog.methods);
    const providerConnections = selectedConnectionExpectations(methods, catalog.connections);
    const requestHash = commandHash(serviceLevelId, command.methods);
    const catalogFetchedAt = parseCatalogTimestamp(catalog.fetchedAt);
    const now = cloneDate((this.deps.clock ?? systemClock).now());

    const result = await this.deps.store.transaction(async (tx) => {
      const lockedServiceLevel = await tx.getServiceLevelForUpdate(serviceLevelId);
      if (!lockedServiceLevel) throw serviceLevelNotFound(serviceLevelId);

      const replay = await tx.findRevisionByIdempotencyKey(
        serviceLevelId,
        command.idempotencyKey,
      );
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new FulfillmentRoutingError(
            409,
            "SHIPPING_FULFILLMENT_ROUTING_IDEMPOTENCY_CONFLICT",
            "That idempotency key was already used for a different routing profile.",
          );
        }
        await tx.ensureProfile(serviceLevelId, now);
        const current = await tx.getProfileForUpdate(serviceLevelId);
        return {
          commandRevision: replay.revision,
          idempotentReplay: true,
          profile: profileView(current),
        };
      }

      await tx.ensureProfile(serviceLevelId, now);
      const before = await tx.getProfileForUpdate(serviceLevelId);
      if (before.revision !== command.expectedRevision) {
        throw new FulfillmentRoutingError(
          409,
          "SHIPPING_FULFILLMENT_ROUTING_REVISION_CONFLICT",
          "The fulfillment routing profile changed. Refresh it before saving.",
          [`Expected revision ${command.expectedRevision}; current revision is ${before.revision}.`],
        );
      }
      await tx.lockProviderConnections(providerConnections);

      const nextRevision = before.revision + 1;
      const revisionId = await tx.createRevision({
        serviceLevelId,
        revision: nextRevision,
        idempotencyKey: command.idempotencyKey,
        requestHash,
        catalogHash: catalog.catalogHash,
        catalogFetchedAt,
        supersedesRevisionId: before.currentRevisionId,
        methods,
        actorUserId,
        now,
      });
      await tx.replaceMethods({ serviceLevelId, revisionId, methods, now });
      await tx.advanceProfile({
        serviceLevelId,
        expectedRevision: before.revision,
        nextRevision,
        revisionId,
        actorUserId,
        now,
      });

      return {
        commandRevision: nextRevision,
        idempotentReplay: false,
        profile: profileView({
          serviceLevelId,
          revision: nextRevision,
          currentRevisionId: revisionId,
          methods,
          legacyUnscopedMethodCount: 0,
          updatedBy: actorUserId,
          updatedAt: now,
        }),
        audit: {
          beforeRevision: before.revision,
          beforeMethods: before.methods,
          afterMethods: methods,
        },
      };
    });

    const audit = "audit" in result ? result.audit : undefined;
    if (!result.idempotentReplay && audit) {
      console.log(JSON.stringify({
        timestamp: now.toISOString(),
        level: "AUDIT",
        actor: actorUserId,
        action: "shipping.fulfillment_routing.replaced",
        target: `shipping.service_levels:${serviceLevelId}`,
        changes: {
          before: {
            revision: audit.beforeRevision,
            methods: audit.beforeMethods,
          },
          after: {
            revision: result.commandRevision,
            methods: audit.afterMethods,
          },
        },
        context: {
          catalogHash: catalog.catalogHash,
          idempotencyKey: command.idempotencyKey,
        },
      }));
    }

    return {
      commandRevision: result.commandRevision,
      idempotentReplay: result.idempotentReplay,
      profile: result.profile,
    };
  }
}

function normalizeCommand(
  command: ReplaceShippingFulfillmentRoutingInput,
): ReplaceShippingFulfillmentRoutingInput {
  if (!command || typeof command !== "object") invalidInput("request", "is required");
  if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) {
    invalidInput("expectedRevision", "must be a non-negative integer");
  }
  const idempotencyKey = requiredString(command.idempotencyKey, "idempotencyKey", 200);
  if (idempotencyKey.length < 16) {
    invalidInput("idempotencyKey", "must contain at least 16 characters");
  }
  if (!Array.isArray(command.methods) || command.methods.length > MAX_ROUTING_METHODS) {
    invalidInput("methods", `must contain at most ${MAX_ROUTING_METHODS} methods`);
  }

  const seen = new Set<string>();
  const methods = command.methods.map((method, index) => {
    if (!method || typeof method !== "object") invalidInput(`methods.${index}`, "is required");
    const provider = requiredString(method.provider, `methods.${index}.provider`, 80);
    if (!PROVIDER_PATTERN.test(provider)) {
      invalidInput(`methods.${index}.provider`, "has an invalid format");
    }
    const normalized: ShippingFulfillmentMethodIdentity = {
      providerConnectionId: positiveInteger(
        method.providerConnectionId,
        `methods.${index}.providerConnectionId`,
      ),
      provider,
      providerAccountId: requiredString(
        method.providerAccountId,
        `methods.${index}.providerAccountId`,
        120,
      ),
      serviceCode: requiredString(method.serviceCode, `methods.${index}.serviceCode`, 80),
    };
    const key = methodKey(normalized);
    if (seen.has(key)) invalidInput(`methods.${index}`, "duplicates another method");
    seen.add(key);
    return normalized;
  });

  return { expectedRevision: command.expectedRevision, idempotencyKey, methods };
}

function resolveRequestedMethods(
  requested: readonly ShippingFulfillmentMethodIdentity[],
  catalog: readonly ShippingFulfillmentCatalogMethod[],
): ShippingFulfillmentRouteMethod[] {
  const catalogByKey = new Map(catalog.map((method) => [methodKey(method), method]));
  return requested.map((identity, index) => {
    const method = catalogByKey.get(methodKey(identity));
    if (!method) {
      throw new FulfillmentRoutingError(
        409,
        "SHIPPING_FULFILLMENT_ROUTING_METHOD_NOT_AVAILABLE",
        "A selected fulfillment method is no longer available in the connected provider account.",
        [`${identity.providerAccountId} / ${identity.serviceCode}`],
      );
    }
    return { ...method, priority: index + 1 };
  });
}

function profileView(state: FulfillmentRoutingProfileState): ShippingFulfillmentRoutingProfile {
  return {
    serviceLevelId: state.serviceLevelId,
    revision: state.revision,
    methods: state.methods.map((method) => ({ ...method })),
    legacyUnscopedMethodCount: state.legacyUnscopedMethodCount,
    updatedBy: state.updatedBy,
    updatedAt: state.updatedAt?.toISOString() ?? null,
  };
}

export function commandHash(
  serviceLevelId: number,
  methods: readonly ShippingFulfillmentMethodIdentity[],
): string {
  return createHash("sha256").update(JSON.stringify({
    serviceLevelId,
    methods: methods.map((method) => ({
      providerConnectionId: method.providerConnectionId,
      provider: method.provider,
      providerAccountId: method.providerAccountId,
      serviceCode: method.serviceCode,
    })),
  })).digest("hex");
}

function methodKey(method: ShippingFulfillmentMethodIdentity): string {
  return `${method.providerConnectionId}\u0000${method.provider}\u0000${method.providerAccountId}\u0000${method.serviceCode}`;
}

function selectedConnectionExpectations(
  methods: readonly ShippingFulfillmentRouteMethod[],
  connections: readonly ShippingFulfillmentCatalogConnectionResult[],
): FulfillmentRoutingProviderConnectionExpectation[] {
  const catalogConnections = new Map(
    connections.map((connection) => [connection.connectionId, connection]),
  );
  const selected = new Map<number, FulfillmentRoutingProviderConnectionExpectation>();
  for (const method of methods) {
    const connection = catalogConnections.get(method.providerConnectionId);
    if (!connection || connection.status !== "available" || connection.provider !== method.provider) {
      throw new FulfillmentRoutingError(
        503,
        "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_INVALID_RESPONSE",
        "The provider catalog omitted connection revision evidence for a selected method.",
      );
    }
    selected.set(connection.connectionId, {
      connectionId: connection.connectionId,
      expectedRevision: positiveInteger(
        connection.connectionRevision,
        `connections.${connection.connectionId}.connectionRevision`,
      ),
      provider: connection.provider,
    });
  }
  return [...selected.values()].sort((left, right) => left.connectionId - right.connectionId);
}

function parseCatalogTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new FulfillmentRoutingError(
      503,
      "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_INVALID_RESPONSE",
      "The fulfillment provider returned an invalid catalog timestamp.",
    );
  }
  return parsed;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) invalidInput(field, "must be a positive integer");
  return value;
}

function requiredString(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string") invalidInput(field, "must be a string");
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    invalidInput(field, `must contain between 1 and ${maxLength} characters`);
  }
  return normalized;
}

function invalidInput(field: string, reason: string): never {
  throw new FulfillmentRoutingError(
    400,
    "SHIPPING_FULFILLMENT_ROUTING_INVALID_INPUT",
    "Review the fulfillment routing fields.",
    [`${field}: ${reason}`],
  );
}

function serviceLevelNotFound(serviceLevelId: number): FulfillmentRoutingError {
  return new FulfillmentRoutingError(
    404,
    "SHIPPING_FULFILLMENT_ROUTING_SERVICE_LEVEL_NOT_FOUND",
    "The shipping service level was not found.",
    [`serviceLevelId: ${serviceLevelId}`],
  );
}

function cloneDate(value: Date): Date {
  const cloned = new Date(value.getTime());
  if (Number.isNaN(cloned.getTime())) {
    throw new Error("Fulfillment routing clock returned an invalid date.");
  }
  return cloned;
}

const systemClock: Clock = { now: () => new Date() };
