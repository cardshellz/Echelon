import { randomUUID } from "node:crypto";

import type {
  ClaimedInventoryPublication,
  PublicationAttemptFailure,
} from "../infrastructure/inventory-publication-outbox.repository";
import {
  InventoryPublicationTransportError,
  type InventoryPublicationDestination,
  type InventoryPublicationTransportRegistry,
} from "./inventory-publication-transport";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_SECONDS = 120;

export interface InventoryPublicationOutboxStore {
  claimDue(input: {
    batchSize: number;
    leaseSeconds: number;
    leaseToken: string;
    now: Date;
  }): Promise<ClaimedInventoryPublication[]>;
  runIfCurrent<T>(
    claim: ClaimedInventoryPublication,
    work: () => Promise<T>,
  ): Promise<{ status: "current"; value: T } | { status: "superseded" }>;
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
  superseded: number;
}

const systemClock: InventoryPublicationClock = { now: () => new Date() };

export class InventoryPublicationOutboxService {
  constructor(
    private readonly store: InventoryPublicationOutboxStore,
    private readonly adapters: Pick<InventoryPublicationTransportRegistry, "get">,
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
    const result: InventoryPublicationBatchResult = {
      claimed: claims.length,
      verified: 0,
      failed: 0,
      superseded: 0,
    };
    for (const claim of claims) {
      try {
        const outcome = await this.publishAndVerify(claim);
        if (outcome === "verified") result.verified += 1;
        else if (outcome === "drifted" || outcome === "failed") result.failed += 1;
        else result.superseded += 1;
      } catch (error) {
        const failure = classifyFailure(error);
        await this.store.recordFailure(claim, { ...failure, completedAt: validNow(this.clock) });
        result.failed += 1;
      }
    }
    return result;
  }

  private async publishAndVerify(
    claim: ClaimedInventoryPublication,
  ): Promise<"verified" | "drifted" | "failed" | "superseded"> {
    const adapter = this.adapters.get(claim.destinationKind, claim.providerKey);
    if (!adapter) {
      throw permanent(
        "PUBLICATION_ADAPTER_MISSING",
        `No inventory adapter is registered for ${claim.destinationKind}:${claim.providerKey}.`,
      );
    }
    if (!adapter.supportedScopeTypes.includes(claim.providerScopeType)) {
      throw permanent(
        "PUBLICATION_SCOPE_UNSUPPORTED",
        `The ${claim.providerKey} adapter cannot address ${claim.providerScopeType}-scoped inventory without inference.`,
      );
    }
    const desiredQuantity = safeQuantity(claim.desiredQuantity);
    const request = {
      destination: publicationDestination(claim),
      channelId: claim.channelId,
      providerScopeType: claim.providerScopeType,
      externalScopeId: claim.externalScopeId,
      productVariantId: claim.productVariantId,
      externalInventoryItemId: claim.externalInventoryItemId,
      externalSku: claim.externalSku,
    };
    const operation = await this.store.runIfCurrent(claim, async () => {
      try {
        const push = await adapter.publishAbsolute({ ...request, desiredQuantity });
        if (push.publishedQuantity !== desiredQuantity) {
          throw retryable(
            "PROVIDER_RESPONSE_INVALID",
            "Provider publication did not confirm the exact desired quantity.",
          );
        }
        const readback = await adapter.readAbsolute(request);
        if (!Number.isSafeInteger(readback.observedQuantity) || readback.observedQuantity < 0) {
          throw retryable("PROVIDER_READBACK_INVALID", "Provider returned an invalid inventory quantity.");
        }
        const recorded = await this.store.recordVerified(claim, {
          observedQuantity: readback.observedQuantity,
          providerResponse: {
            push: push.providerResponse,
            readback: readback.providerResponse,
          },
          completedAt: validNow(this.clock),
        });
        if (recorded === null) {
          throw permanent("PUBLICATION_LEASE_LOST", "The inventory publication lease was no longer owned by this worker.");
        }
        return recorded;
      } catch (error) {
        const failure = classifyFailure(error);
        await this.store.recordFailure(claim, { ...failure, completedAt: validNow(this.clock) });
        return "failed" as const;
      }
    });
    if (operation.status === "superseded") return "superseded";
    return operation.value;
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
  if (error instanceof InventoryPublicationTransportError) {
    return { errorClass: error.code, errorMessage: error.message, retryable: error.retryable };
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

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}

function publicationDestination(claim: ClaimedInventoryPublication): InventoryPublicationDestination {
  if (claim.destinationKind === "channel_connection") {
    if (claim.channelConnectionId === null || claim.dropshipStoreConnectionId !== null) {
      throw permanent(
        "PUBLICATION_DESTINATION_INVALID",
        "A channel publication must contain exactly one channel connection owner.",
      );
    }
    return {
      kind: "channel_connection",
      channelConnectionId: claim.channelConnectionId,
      dropshipStoreConnectionId: null,
    };
  }
  if (claim.channelConnectionId !== null || claim.dropshipStoreConnectionId === null) {
    throw permanent(
      "PUBLICATION_DESTINATION_INVALID",
      "A Dropship publication must contain exactly one Dropship store connection owner.",
    );
  }
  return {
    kind: "dropship_store_connection",
    channelConnectionId: null,
    dropshipStoreConnectionId: claim.dropshipStoreConnectionId,
  };
}

function validNow(clock: InventoryPublicationClock): Date {
  const value = clock.now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Inventory publication clock returned an invalid time.");
  }
  return value;
}
