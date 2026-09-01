import { randomUUID } from "node:crypto";

import type {
  ChannelAdapterRegistry,
  InventoryPublicationContext,
  InventoryPushItem,
  InventoryReadItem,
} from "../../channels/channel-adapter.interface";
import { InventoryPublicationConfigurationError } from "../../channels/channel-adapter.interface";
import type {
  ClaimedInventoryPublication,
  PublicationAttemptFailure,
} from "../infrastructure/inventory-publication-outbox.repository";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_SECONDS = 120;

export interface InventoryPublicationOutboxStore {
  claimDue(input: {
    batchSize: number;
    leaseSeconds: number;
    leaseToken: string;
    now: Date;
  }): Promise<ClaimedInventoryPublication[]>;
  recordVerified(
    claim: ClaimedInventoryPublication,
    input: { observedQuantity: number; providerResponse: unknown; completedAt: Date },
  ): Promise<"verified" | "drifted" | null>;
  recordFailure(
    claim: ClaimedInventoryPublication,
    input: PublicationAttemptFailure & { completedAt: Date },
  ): Promise<boolean>;
}

export interface InventoryPublicationClock {
  now(): Date;
}

export interface InventoryPublicationBatchResult {
  claimed: number;
  verified: number;
  failed: number;
}

const systemClock: InventoryPublicationClock = { now: () => new Date() };

export class InventoryPublicationOutboxService {
  constructor(
    private readonly store: InventoryPublicationOutboxStore,
    private readonly adapters: Pick<ChannelAdapterRegistry, "get">,
    private readonly clock: InventoryPublicationClock = systemClock,
    private readonly leaseTokenFactory: () => string = randomUUID,
  ) {}

  async processDue(input: { batchSize?: number; leaseSeconds?: number } = {}): Promise<InventoryPublicationBatchResult> {
    const batchSize = positiveInteger(input.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
    const leaseSeconds = positiveInteger(input.leaseSeconds ?? DEFAULT_LEASE_SECONDS, "leaseSeconds");
    const claims = await this.store.claimDue({
      batchSize,
      leaseSeconds,
      leaseToken: this.leaseTokenFactory(),
      now: validNow(this.clock),
    });
    const result: InventoryPublicationBatchResult = { claimed: claims.length, verified: 0, failed: 0 };
    for (const claim of claims) {
      try {
        const outcome = await this.publishAndVerify(claim);
        if (outcome === "verified") result.verified += 1;
        else result.failed += 1;
      } catch (error) {
        const failure = classifyFailure(error);
        await this.store.recordFailure(claim, { ...failure, completedAt: validNow(this.clock) });
        result.failed += 1;
      }
    }
    return result;
  }

  private async publishAndVerify(claim: ClaimedInventoryPublication): Promise<"verified" | "drifted"> {
    const adapter = this.adapters.get(claim.providerKey);
    if (!adapter) {
      throw permanent("PUBLICATION_ADAPTER_MISSING", `No inventory adapter is registered for ${claim.providerKey}.`);
    }
    if (!adapter.readInventory) {
      throw permanent(
        "PUBLICATION_READBACK_UNSUPPORTED",
        `The ${claim.providerKey} adapter cannot verify provider inventory readback.`,
      );
    }
    if (!adapter.inventoryPublicationScopeTypes?.includes(claim.providerScopeType)) {
      throw permanent(
        "PUBLICATION_SCOPE_UNSUPPORTED",
        `The ${claim.providerKey} adapter cannot address ${claim.providerScopeType}-scoped inventory without inference.`,
      );
    }
    const desiredQuantity = safeQuantity(claim.desiredQuantity);
    const context: InventoryPublicationContext = {
      authority: "canonical_outbox",
      channelConnectionId: claim.channelConnectionId,
      providerScopeType: claim.providerScopeType,
      externalScopeId: claim.externalScopeId,
    };
    const pushItem: InventoryPushItem = {
      variantId: claim.productVariantId,
      sku: claim.externalSku,
      externalVariantId: null,
      externalInventoryItemId: claim.externalInventoryItemId,
      allocatedQty: desiredQuantity,
    };
    const pushResults = await adapter.pushInventory(claim.channelId, [pushItem], context);
    const pushed = singleResult(pushResults, claim.productVariantId, "publication");
    if (pushed.status !== "success" || pushed.pushedQty !== desiredQuantity) {
      const message = pushed.error ?? `Provider reported ${pushed.status} for inventory publication.`;
      throw pushed.retryable === false
        ? permanent(pushed.errorCode ?? "PROVIDER_PUBLICATION_CONFIGURATION_INVALID", message)
        : retryable(pushed.errorCode ?? "PROVIDER_PUBLICATION_REJECTED", message);
    }
    const readItem: InventoryReadItem = {
      variantId: claim.productVariantId,
      sku: claim.externalSku,
      externalInventoryItemId: claim.externalInventoryItemId,
      providerScopeType: claim.providerScopeType,
      externalScopeId: claim.externalScopeId,
    };
    const readResults = await adapter.readInventory(claim.channelId, [readItem], context);
    const readback = singleResult(readResults, claim.productVariantId, "readback");
    if (readback.status !== "success") {
      throw retryable(
        "PROVIDER_READBACK_FAILED",
        readback.error ?? "Provider inventory readback failed.",
      );
    }
    if (!Number.isSafeInteger(readback.observedQty) || readback.observedQty < 0) {
      throw retryable("PROVIDER_READBACK_INVALID", "Provider returned an invalid inventory quantity.");
    }
    const recorded = await this.store.recordVerified(claim, {
      observedQuantity: readback.observedQty,
      providerResponse: { push: pushed, readback },
      completedAt: validNow(this.clock),
    });
    if (recorded === null) {
      throw permanent("PUBLICATION_LEASE_LOST", "The inventory publication lease was no longer owned by this worker.");
    }
    return recorded;
  }
}

class ClassifiedPublicationError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ClassifiedPublicationError";
  }
}

function permanent(code: string, message: string): ClassifiedPublicationError {
  return new ClassifiedPublicationError(code, message, false);
}

function retryable(code: string, message: string): ClassifiedPublicationError {
  return new ClassifiedPublicationError(code, message, true);
}

function classifyFailure(error: unknown): PublicationAttemptFailure {
  if (error instanceof ClassifiedPublicationError) {
    return { errorClass: error.code, errorMessage: error.message, retryable: error.retryable };
  }
  if (error instanceof InventoryPublicationConfigurationError) {
    return { errorClass: error.code, errorMessage: error.message, retryable: false };
  }
  return {
    errorClass: "PROVIDER_PUBLICATION_ERROR",
    errorMessage: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function safeQuantity(value: string): number {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw permanent("PUBLICATION_QUANTITY_INVALID", "Desired inventory quantity is not an integer.");
  }
  if (parsed < BigInt(0) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw permanent("PUBLICATION_QUANTITY_INVALID", "Desired inventory quantity exceeds the provider-safe range.");
  }
  return Number(parsed);
}

function singleResult<T extends { variantId: number }>(
  results: T[],
  variantId: number,
  operation: string,
): T {
  if (results.length !== 1 || results[0]?.variantId !== variantId) {
    throw retryable(
      "PROVIDER_RESPONSE_INVALID",
      `Provider ${operation} did not return exactly one matching variant result.`,
    );
  }
  return results[0];
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}

function validNow(clock: InventoryPublicationClock): Date {
  const value = clock.now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Inventory publication clock returned an invalid time.");
  }
  return value;
}
