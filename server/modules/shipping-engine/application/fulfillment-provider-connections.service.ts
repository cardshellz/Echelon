import { createHash } from "node:crypto";
import type {
  ChangeShippingFulfillmentProviderConnectionStatusInput,
  CreateShippingFulfillmentProviderConnectionInput,
  ReplaceShippingFulfillmentProviderCredentialInput,
  ShippingFulfillmentCatalogMethod,
  ShippingFulfillmentProviderConnection,
  ShippingFulfillmentProviderConnectionMutationResult,
  ShippingFulfillmentProviderConnectionsAdminView,
  VerifyShippingFulfillmentProviderConnectionInput,
} from "@shared/types/shipping-fulfillment-routing";
import type {
  FulfillmentProviderConnectionCatalog,
  FulfillmentProviderConnectionCatalogState,
  FulfillmentProviderCredentialCipher,
  FulfillmentProviderCredentialRecord,
  FulfillmentProviderRegistry,
} from "./connected-fulfillment-method-catalog.service";

const PROVIDER_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;
const MAX_CREDENTIAL_LENGTH = 4_096;

export class FulfillmentProviderConnectionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "FulfillmentProviderConnectionError";
  }
}

export interface FulfillmentProviderConnectionState
  extends FulfillmentProviderConnectionCatalogState {
  credentialPresent: boolean;
  systemManaged: boolean;
  routedMethodCount: number;
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}

export interface FulfillmentProviderConnectionCommand {
  connectionId: number;
  requestHash: string;
}

export interface FulfillmentProviderRoutedMethodIdentity {
  provider: string;
  providerAccountId: string;
  serviceCode: string;
}

export interface CreateFulfillmentProviderConnectionRecordInput {
  provider: string;
  name: string;
  actorUserId: string;
  now: Date;
}

export interface UpdateFulfillmentProviderConnectionRecordInput {
  connectionId: number;
  expectedRevision: number;
  status: "active" | "disabled" | "error";
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  actorUserId: string;
  now: Date;
}

export interface AppendFulfillmentProviderConnectionEventInput {
  connectionId: number;
  action:
    | "created"
    | "credential_replaced"
    | "verified"
    | "verification_failed"
    | "enabled"
    | "disabled";
  connectionRevision: number;
  idempotencyKey: string;
  requestHash: string;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown>;
  actorUserId: string;
  now: Date;
}

export interface FulfillmentProviderConnectionTransaction {
  lockIdempotencyKey(idempotencyKey: string): Promise<void>;
  findCommand(idempotencyKey: string): Promise<FulfillmentProviderConnectionCommand | null>;
  createConnection(input: CreateFulfillmentProviderConnectionRecordInput): Promise<number>;
  getConnectionForUpdate(connectionId: number): Promise<FulfillmentProviderConnectionState | null>;
  listActiveRouteMethods(
    connectionId: number,
  ): Promise<FulfillmentProviderRoutedMethodIdentity[]>;
  saveCredential(input: {
    credential: FulfillmentProviderCredentialRecord;
    actorUserId: string;
    now: Date;
  }): Promise<void>;
  updateConnection(input: UpdateFulfillmentProviderConnectionRecordInput): Promise<void>;
  appendEvent(input: AppendFulfillmentProviderConnectionEventInput): Promise<void>;
}

export interface FulfillmentProviderConnectionStore {
  listConnections(): Promise<FulfillmentProviderConnectionState[]>;
  getConnection(connectionId: number): Promise<FulfillmentProviderConnectionState | null>;
  getCredential(connectionId: number): Promise<FulfillmentProviderCredentialRecord | null>;
  findCommand(idempotencyKey: string): Promise<FulfillmentProviderConnectionCommand | null>;
  transaction<T>(work: (tx: FulfillmentProviderConnectionTransaction) => Promise<T>): Promise<T>;
}

interface Clock {
  now(): Date;
}

export class FulfillmentProviderConnectionService {
  constructor(private readonly deps: {
    store: FulfillmentProviderConnectionStore;
    registry: FulfillmentProviderRegistry;
    credentialCipher: FulfillmentProviderCredentialCipher | null;
    environment?: Readonly<Record<string, string | undefined>>;
    clock?: Clock;
  }) {}

  async getAdminView(): Promise<ShippingFulfillmentProviderConnectionsAdminView> {
    const connections = await this.deps.store.listConnections();
    return {
      providers: this.deps.registry.list(),
      connections: connections.map((connection) => this.toView(connection)),
      credentialVaultConfigured: this.deps.credentialCipher !== null,
    };
  }

  async createConnection(input: {
    command: CreateShippingFulfillmentProviderConnectionInput;
    actorUserId: string;
  }): Promise<ShippingFulfillmentProviderConnectionMutationResult> {
    const command = normalizeCreateCommand(input.command);
    const actorUserId = requiredString(input.actorUserId, "actorUserId", 120);
    const requestHash = hashCommand("create", command);
    const replay = await this.replay(command.idempotencyKey, requestHash);
    if (replay) return replay;
    const adapter = this.requireAdapter(command.provider);
    const cipher = this.requireCipher();

    const verification = await adapter.verifyCredential(command.credential);
    if (verification.status !== "available") {
      throw verificationError(verification, command.credential);
    }
    const now = validDate((this.deps.clock ?? systemClock).now());

    const outcome = await this.deps.store.transaction(async (tx) => {
      await tx.lockIdempotencyKey(command.idempotencyKey);
      const concurrentReplay = await tx.findCommand(command.idempotencyKey);
      if (concurrentReplay) return { connectionId: assertReplay(concurrentReplay, requestHash), replay: true };

      const connectionId = await tx.createConnection({
        provider: command.provider,
        name: command.name,
        actorUserId,
        now,
      });
      const credential = cipher.seal({
        connectionId,
        provider: command.provider,
        credential: command.credential,
      });
      await tx.saveCredential({ credential, actorUserId, now });
      const created = await tx.getConnectionForUpdate(connectionId);
      if (!created) throw dataIntegrityError("Created provider connection could not be reloaded.");
      await tx.appendEvent({
        connectionId,
        action: "created",
        connectionRevision: created.revision,
        idempotencyKey: command.idempotencyKey,
        requestHash,
        beforeSnapshot: null,
        afterSnapshot: connectionSnapshot({ ...created, credentialPresent: true }),
        actorUserId,
        now,
      });
      return { connectionId, replay: false };
    });
    return this.result(outcome.connectionId, outcome.replay);
  }

  async replaceCredential(input: {
    connectionId: number;
    command: ReplaceShippingFulfillmentProviderCredentialInput;
    actorUserId: string;
  }): Promise<ShippingFulfillmentProviderConnectionMutationResult> {
    const connectionId = positiveInteger(input.connectionId, "connectionId");
    const command = normalizeCredentialCommand(input.command);
    const actorUserId = requiredString(input.actorUserId, "actorUserId", 120);
    const requestHash = hashCommand("replace_credential", {
      connectionId,
      expectedRevision: command.expectedRevision,
      credential: command.credential,
    });
    const replay = await this.replay(command.idempotencyKey, requestHash);
    if (replay) return replay;
    const existing = await this.requireConnection(connectionId);
    if (existing.systemManaged || existing.credentialSource !== "vault") {
      throw new FulfillmentProviderConnectionError(
        409,
        "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_SYSTEM_MANAGED",
        "This connection is managed by deployment configuration and cannot accept a stored credential.",
      );
    }
    requireExpectedRevision(existing, command.expectedRevision);
    const adapter = this.requireAdapter(existing.provider);
    const cipher = this.requireCipher();
    const verification = await adapter.verifyCredential(command.credential);
    if (verification.status !== "available") {
      throw verificationError(verification, command.credential);
    }
    const verifiedMethods = verification.methods;
    const now = validDate((this.deps.clock ?? systemClock).now());

    const outcome = await this.deps.store.transaction(async (tx) => {
      await tx.lockIdempotencyKey(command.idempotencyKey);
      const concurrentReplay = await tx.findCommand(command.idempotencyKey);
      if (concurrentReplay) return { connectionId: assertReplay(concurrentReplay, requestHash), replay: true };
      const before = await requireLockedConnection(tx, connectionId);
      requireExpectedRevision(before, command.expectedRevision);
      if (before.systemManaged || before.credentialSource !== "vault") {
        throw new FulfillmentProviderConnectionError(
          409,
          "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_SYSTEM_MANAGED",
          "This connection is managed by deployment configuration.",
        );
      }
      assertRoutedMethodsRemainAvailable(
        await tx.listActiveRouteMethods(connectionId),
        verifiedMethods,
      );
      const nextStatus: FulfillmentProviderConnectionState["status"] = before.status === "disabled"
        ? "disabled"
        : "active";
      await tx.saveCredential({
        credential: cipher.seal({
          connectionId,
          provider: before.provider,
          credential: command.credential,
        }),
        actorUserId,
        now,
      });
      await tx.updateConnection({
        connectionId,
        expectedRevision: before.revision,
        status: nextStatus,
        lastVerifiedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        actorUserId,
        now,
      });
      const after: FulfillmentProviderConnectionState = {
        ...before,
        status: nextStatus,
        revision: before.revision + 1,
        credentialPresent: true,
        lastVerifiedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedBy: actorUserId,
        updatedAt: now,
      };
      await tx.appendEvent({
        connectionId,
        action: "credential_replaced",
        connectionRevision: after.revision,
        idempotencyKey: command.idempotencyKey,
        requestHash,
        beforeSnapshot: connectionSnapshot(before),
        afterSnapshot: connectionSnapshot(after),
        actorUserId,
        now,
      });
      return { connectionId, replay: false };
    });
    return this.result(outcome.connectionId, outcome.replay);
  }

  async verifyConnection(input: {
    connectionId: number;
    command: VerifyShippingFulfillmentProviderConnectionInput;
    actorUserId: string;
  }): Promise<ShippingFulfillmentProviderConnectionMutationResult> {
    const connectionId = positiveInteger(input.connectionId, "connectionId");
    const command = normalizeStateCommand(input.command);
    const actorUserId = requiredString(input.actorUserId, "actorUserId", 120);
    const requestHash = hashCommand("verify", { connectionId, expectedRevision: command.expectedRevision });
    const replay = await this.replay(command.idempotencyKey, requestHash);
    if (replay) return replay;
    const existing = await this.requireConnection(connectionId);
    requireExpectedRevision(existing, command.expectedRevision);
    if (existing.status === "disabled") {
      throw new FulfillmentProviderConnectionError(
        409,
        "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_DISABLED",
        "Enable this provider connection before verifying it.",
      );
    }
    const adapter = this.requireAdapter(existing.provider);
    const credential = await this.resolveCredential(existing);
    if (!credential) {
      throw new FulfillmentProviderConnectionError(
        409,
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_NOT_CONFIGURED",
        "Credentials are not configured for this fulfillment provider connection.",
      );
    }
    const verification = await adapter.verifyCredential(credential);
    const now = validDate((this.deps.clock ?? systemClock).now());
    const verified = verification.status === "available";
    const failure = verified ? null : normalizedVerificationFailure(verification, credential);
    const status: FulfillmentProviderConnectionState["status"] = verified ? "active" : "error";
    const errorCode = failure?.code ?? null;
    const errorMessage = failure?.message ?? null;

    const outcome = await this.deps.store.transaction(async (tx) => {
      await tx.lockIdempotencyKey(command.idempotencyKey);
      const concurrentReplay = await tx.findCommand(command.idempotencyKey);
      if (concurrentReplay) return { connectionId: assertReplay(concurrentReplay, requestHash), replay: true };
      const before = await requireLockedConnection(tx, connectionId);
      requireExpectedRevision(before, command.expectedRevision);
      await tx.updateConnection({
        connectionId,
        expectedRevision: before.revision,
        status,
        lastVerifiedAt: now,
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
        actorUserId,
        now,
      });
      const after: FulfillmentProviderConnectionState = { ...before, status, revision: before.revision + 1,
        lastVerifiedAt: now, lastErrorCode: errorCode, lastErrorMessage: errorMessage,
        updatedBy: actorUserId, updatedAt: now };
      await tx.appendEvent({
        connectionId,
        action: verified ? "verified" : "verification_failed",
        connectionRevision: after.revision,
        idempotencyKey: command.idempotencyKey,
        requestHash,
        beforeSnapshot: connectionSnapshot(before),
        afterSnapshot: connectionSnapshot(after),
        actorUserId,
        now,
      });
      return { connectionId, replay: false };
    });
    return this.result(outcome.connectionId, outcome.replay);
  }

  async setConnectionEnabled(input: {
    connectionId: number;
    enabled: boolean;
    command: ChangeShippingFulfillmentProviderConnectionStatusInput;
    actorUserId: string;
  }): Promise<ShippingFulfillmentProviderConnectionMutationResult> {
    const connectionId = positiveInteger(input.connectionId, "connectionId");
    const command = normalizeStateCommand(input.command);
    const actorUserId = requiredString(input.actorUserId, "actorUserId", 120);
    const requestHash = hashCommand(input.enabled ? "enable" : "disable", {
      connectionId,
      expectedRevision: command.expectedRevision,
    });
    const replay = await this.replay(command.idempotencyKey, requestHash);
    if (replay) return replay;
    const existing = await this.requireConnection(connectionId);
    requireExpectedRevision(existing, command.expectedRevision);
    if (input.enabled === (existing.status !== "disabled")) {
      throw new FulfillmentProviderConnectionError(
        409,
        input.enabled
          ? "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_ALREADY_ENABLED"
          : "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_ALREADY_DISABLED",
        `This fulfillment provider connection is already ${input.enabled ? "enabled" : "disabled"}.`,
      );
    }
    if (!input.enabled && existing.routedMethodCount > 0) {
      throw new FulfillmentProviderConnectionError(
        409,
        "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_IN_USE",
        "Remove this connection from every service-level route before disabling it.",
        [`${existing.routedMethodCount} active routing method(s) reference this connection.`],
      );
    }
    let lastVerifiedAt = existing.lastVerifiedAt;
    if (input.enabled) {
      const credential = await this.resolveCredential(existing);
      if (!credential) {
        throw new FulfillmentProviderConnectionError(
          409,
          "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_NOT_CONFIGURED",
          "Credentials are not configured for this fulfillment provider connection.",
        );
      }
      const verification = await this.requireAdapter(existing.provider).verifyCredential(credential);
      if (verification.status !== "available") throw verificationError(verification, credential);
    }
    const now = validDate((this.deps.clock ?? systemClock).now());
    if (input.enabled) lastVerifiedAt = now;
    const nextStatus: FulfillmentProviderConnectionState["status"] = input.enabled ? "active" : "disabled";
    const outcome = await this.deps.store.transaction(async (tx) => {
      await tx.lockIdempotencyKey(command.idempotencyKey);
      const concurrentReplay = await tx.findCommand(command.idempotencyKey);
      if (concurrentReplay) return { connectionId: assertReplay(concurrentReplay, requestHash), replay: true };
      const before = await requireLockedConnection(tx, connectionId);
      requireExpectedRevision(before, command.expectedRevision);
      if (!input.enabled && before.routedMethodCount > 0) {
        throw new FulfillmentProviderConnectionError(
          409,
          "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_IN_USE",
          "Remove this connection from every service-level route before disabling it.",
        );
      }
      await tx.updateConnection({
        connectionId,
        expectedRevision: before.revision,
        status: nextStatus,
        lastVerifiedAt,
        lastErrorCode: null,
        lastErrorMessage: null,
        actorUserId,
        now,
      });
      const after: FulfillmentProviderConnectionState = { ...before, status: nextStatus, revision: before.revision + 1,
        lastVerifiedAt, lastErrorCode: null, lastErrorMessage: null,
        updatedBy: actorUserId, updatedAt: now };
      await tx.appendEvent({
        connectionId,
        action: input.enabled ? "enabled" : "disabled",
        connectionRevision: after.revision,
        idempotencyKey: command.idempotencyKey,
        requestHash,
        beforeSnapshot: connectionSnapshot(before),
        afterSnapshot: connectionSnapshot(after),
        actorUserId,
        now,
      });
      return { connectionId, replay: false };
    });
    return this.result(outcome.connectionId, outcome.replay);
  }

  private async replay(
    idempotencyKey: string,
    requestHash: string,
  ): Promise<ShippingFulfillmentProviderConnectionMutationResult | null> {
    const replay = await this.deps.store.findCommand(idempotencyKey);
    return replay ? this.result(assertReplay(replay, requestHash), true) : null;
  }

  private async result(
    connectionId: number,
    idempotentReplay: boolean,
  ): Promise<ShippingFulfillmentProviderConnectionMutationResult> {
    const connection = await this.requireConnection(connectionId);
    return { connection: this.toView(connection), idempotentReplay };
  }

  private async requireConnection(connectionId: number): Promise<FulfillmentProviderConnectionState> {
    const connection = await this.deps.store.getConnection(connectionId);
    if (!connection) {
      throw new FulfillmentProviderConnectionError(
        404,
        "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_NOT_FOUND",
        "The fulfillment provider connection was not found.",
      );
    }
    return connection;
  }

  private requireAdapter(provider: string) {
    const adapter = this.deps.registry.get(provider);
    if (!adapter) {
      throw new FulfillmentProviderConnectionError(
        400,
        "SHIPPING_FULFILLMENT_PROVIDER_NOT_SUPPORTED",
        "The requested fulfillment provider is not supported by this application build.",
        [`provider: ${provider}`],
      );
    }
    return adapter;
  }

  private requireCipher(): FulfillmentProviderCredentialCipher {
    if (!this.deps.credentialCipher) {
      throw new FulfillmentProviderConnectionError(
        409,
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_VAULT_NOT_CONFIGURED",
        "Configure SHIPPING_PROVIDER_CREDENTIAL_ENCRYPTION_KEY before storing provider credentials.",
      );
    }
    return this.deps.credentialCipher;
  }

  private async resolveCredential(connection: FulfillmentProviderConnectionState): Promise<string | null> {
    if (connection.credentialSource === "environment") {
      if (!connection.credentialRef) return null;
      return (this.deps.environment ?? process.env)[connection.credentialRef]?.trim() || null;
    }
    if (!this.deps.credentialCipher) return null;
    const credential = await this.deps.store.getCredential(connection.id);
    if (!credential) return null;
    try {
      return this.deps.credentialCipher.open({ connection, credential }).trim() || null;
    } catch {
      throw new FulfillmentProviderConnectionError(
        409,
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_UNREADABLE",
        "The stored provider credential cannot be decrypted with the active key.",
      );
    }
  }

  private toView(connection: FulfillmentProviderConnectionState): ShippingFulfillmentProviderConnection {
    const descriptor = this.deps.registry.get(connection.provider)?.descriptor;
    const credentialConfigured = connection.credentialSource === "environment"
      ? Boolean(connection.credentialRef
        && (this.deps.environment ?? process.env)[connection.credentialRef]?.trim())
      : connection.credentialPresent && this.deps.credentialCipher !== null;
    return {
      id: connection.id,
      provider: connection.provider,
      providerDisplayName: descriptor?.displayName ?? connection.provider,
      name: connection.name,
      status: connection.status,
      credentialSource: connection.credentialSource,
      credentialConfigured,
      systemManaged: connection.systemManaged,
      revision: connection.revision,
      routedMethodCount: connection.routedMethodCount,
      lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
      lastErrorCode: connection.lastErrorCode,
      lastErrorMessage: connection.lastErrorMessage,
      createdBy: connection.createdBy,
      createdAt: connection.createdAt.toISOString(),
      updatedBy: connection.updatedBy,
      updatedAt: connection.updatedAt.toISOString(),
    };
  }
}

function normalizeCreateCommand(
  command: CreateShippingFulfillmentProviderConnectionInput,
): CreateShippingFulfillmentProviderConnectionInput {
  if (!command || typeof command !== "object") invalidInput("request", "is required");
  const provider = requiredString(command.provider, "provider", 80);
  if (!PROVIDER_PATTERN.test(provider)) invalidInput("provider", "has an invalid format");
  return {
    provider,
    name: requiredString(command.name, "name", 160),
    credential: credentialString(command.credential),
    idempotencyKey: idempotencyKey(command.idempotencyKey),
  };
}

function normalizeCredentialCommand(
  command: ReplaceShippingFulfillmentProviderCredentialInput,
): ReplaceShippingFulfillmentProviderCredentialInput {
  if (!command || typeof command !== "object") invalidInput("request", "is required");
  return {
    credential: credentialString(command.credential),
    expectedRevision: revision(command.expectedRevision),
    idempotencyKey: idempotencyKey(command.idempotencyKey),
  };
}

function normalizeStateCommand<T extends {
  expectedRevision: number;
  idempotencyKey: string;
}>(command: T): T {
  if (!command || typeof command !== "object") invalidInput("request", "is required");
  return {
    ...command,
    expectedRevision: revision(command.expectedRevision),
    idempotencyKey: idempotencyKey(command.idempotencyKey),
  };
}

function credentialString(value: string): string {
  return requiredString(value, "credential", MAX_CREDENTIAL_LENGTH);
}

function idempotencyKey(value: string): string {
  const normalized = requiredString(value, "idempotencyKey", 200);
  if (normalized.length < 16) invalidInput("idempotencyKey", "must contain at least 16 characters");
  return normalized;
}

function revision(value: number): number {
  if (!Number.isInteger(value) || value < 1) invalidInput("expectedRevision", "must be a positive integer");
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) invalidInput(field, "must be a positive integer");
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
  throw new FulfillmentProviderConnectionError(
    400,
    "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_INVALID_INPUT",
    "Review the fulfillment provider connection fields.",
    [`${field}: ${reason}`],
  );
}

function requireExpectedRevision(
  connection: FulfillmentProviderConnectionState,
  expectedRevision: number,
): void {
  if (connection.revision !== expectedRevision) {
    throw new FulfillmentProviderConnectionError(
      409,
      "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_REVISION_CONFLICT",
      "The provider connection changed. Refresh it before trying again.",
      [`Expected revision ${expectedRevision}; current revision is ${connection.revision}.`],
    );
  }
}

async function requireLockedConnection(
  tx: FulfillmentProviderConnectionTransaction,
  connectionId: number,
): Promise<FulfillmentProviderConnectionState> {
  const connection = await tx.getConnectionForUpdate(connectionId);
  if (!connection) {
    throw new FulfillmentProviderConnectionError(
      404,
      "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_NOT_FOUND",
      "The fulfillment provider connection was not found.",
    );
  }
  return connection;
}

function assertReplay(command: FulfillmentProviderConnectionCommand, requestHash: string): number {
  if (command.requestHash !== requestHash) {
    throw new FulfillmentProviderConnectionError(
      409,
      "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_IDEMPOTENCY_CONFLICT",
      "That idempotency key was already used for a different provider-connection command.",
    );
  }
  return command.connectionId;
}

function verificationError(
  verification: FulfillmentProviderConnectionCatalog,
  credential: string,
): FulfillmentProviderConnectionError {
  if (verification.status === "available") {
    return dataIntegrityError("A successful verification was passed to the failure mapper.");
  }
  const failure = normalizedVerificationFailure(verification, credential);
  return new FulfillmentProviderConnectionError(
    failure.retryable ? 503 : 409,
    failure.code,
    failure.message,
  );
}

function assertRoutedMethodsRemainAvailable(
  routedMethods: readonly FulfillmentProviderRoutedMethodIdentity[],
  verifiedMethods: readonly ShippingFulfillmentCatalogMethod[],
): void {
  const available = new Set(verifiedMethods.map((method) => [
    method.provider,
    method.providerAccountId,
    method.serviceCode,
  ].join("\u0000")));
  const missing = routedMethods.filter((method) => !available.has([
    method.provider,
    method.providerAccountId,
    method.serviceCode,
  ].join("\u0000")));
  if (missing.length === 0) return;
  throw new FulfillmentProviderConnectionError(
    409,
    "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_BREAKS_ACTIVE_ROUTES",
    "The replacement credential does not expose every method currently used by fulfillment routing.",
    missing.slice(0, 20).map((method) => (
      `${method.providerAccountId} / ${method.serviceCode}`
    )),
  );
}

function normalizedVerificationFailure(
  verification: Exclude<FulfillmentProviderConnectionCatalog, { status: "available" }>,
  credential: string,
): { code: string; message: string; retryable: boolean } {
  if (
    typeof verification.code !== "string"
    || !verification.code.trim()
    || verification.code.length > 120
    || !/^[A-Z][A-Z0-9_]{1,119}$/.test(verification.code)
    || typeof verification.message !== "string"
    || !verification.message.trim()
    || verification.message.length > 500
    || typeof verification.retryable !== "boolean"
  ) {
    return {
      code: "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_INVALID_RESPONSE",
      message: "The fulfillment provider adapter returned an invalid verification response.",
      retryable: false,
    };
  }
  return {
    code: verification.code.trim(),
    message: redactCredential(verification.message.trim(), credential),
    retryable: verification.retryable,
  };
}

function redactCredential(message: string, credential: string): string {
  return credential ? message.split(credential).join("[REDACTED]") : message;
}

function hashCommand(action: string, input: unknown): string {
  return createHash("sha256").update(JSON.stringify({ action, input })).digest("hex");
}

function connectionSnapshot(
  connection: FulfillmentProviderConnectionState,
): Record<string, unknown> {
  return {
    id: connection.id,
    provider: connection.provider,
    name: connection.name,
    status: connection.status,
    credentialSource: connection.credentialSource,
    credentialStored: connection.credentialPresent,
    systemManaged: connection.systemManaged,
    revision: connection.revision,
    routedMethodCount: connection.routedMethodCount,
    lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
    lastErrorCode: connection.lastErrorCode,
    lastErrorMessage: connection.lastErrorMessage,
  };
}

function validDate(value: Date): Date {
  const cloned = new Date(value.getTime());
  if (Number.isNaN(cloned.getTime())) throw new Error("Fulfillment provider connection clock returned an invalid date.");
  return cloned;
}

function dataIntegrityError(detail: string): FulfillmentProviderConnectionError {
  return new FulfillmentProviderConnectionError(
    500,
    "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_DATA_INTEGRITY_ERROR",
    "Fulfillment provider connection data is inconsistent.",
    [detail],
  );
}

const systemClock: Clock = { now: () => new Date() };
