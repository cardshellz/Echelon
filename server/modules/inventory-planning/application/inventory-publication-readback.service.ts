import { createHash } from "node:crypto";
import { z } from "zod";

import {
  captureInventoryPublicationReadbacksRequestSchema,
  inventoryPublicationReadbackRunSchema,
  type InventoryPublicationReadbackRun,
} from "@shared/types/inventory-availability-phase4";
import { canonicalJson } from "@shared/utils/canonical-json";
import type {
  ChannelAdapterRegistry,
  InventoryPublicationContext,
  InventoryReadItem,
} from "../../channels/channel-adapter.interface";
import { InventoryPublicationConfigurationError } from "../../channels/channel-adapter.interface";

const actorSchema = z.string().trim().min(1).max(100);

export interface PublicationReadbackTarget {
  publicationTargetId: number;
  publicationTargetRevision: string;
  productVariantId: number;
  destinationKind: "channel_connection" | "dropship_store_connection";
  channelId: number;
  channelConnectionId: number | null;
  dropshipStoreConnectionId: number | null;
  providerKey: string;
  providerScopeType: "account" | "location";
  externalScopeId: string;
  externalInventoryItemId: string;
  externalSku: string | null;
}

export interface PublicationReadbackFailure {
  publicationTargetId: number;
  productVariantId: number;
  code: string;
  message: string;
}

export type BeginPublicationReadbackResult =
  | { kind: "replay"; result: InventoryPublicationReadbackRun }
  | { kind: "started"; readbackRunId: string; targets: PublicationReadbackTarget[] };

export interface InventoryPublicationReadbackStore {
  begin(input: {
    idempotencyKey: string;
    requestHash: string;
    requestedBy: string;
    reason: string;
    startedAt: Date;
  }): Promise<BeginPublicationReadbackResult>;
  recordObserved(
    readbackRunId: string,
    target: PublicationReadbackTarget,
    observedQuantity: number,
    observedAt: Date,
  ): Promise<void>;
  recordFailure(
    readbackRunId: string,
    target: PublicationReadbackTarget,
    failure: PublicationReadbackFailure,
  ): Promise<void>;
  complete(input: {
    readbackRunId: string;
    requestedBy: string;
    reason: string;
    startedAt: Date;
    completedAt: Date;
    targetRows: number;
    failures: PublicationReadbackFailure[];
  }): Promise<InventoryPublicationReadbackRun>;
}

export interface InventoryPublicationReadbackClock {
  now(): Date;
}

const systemClock: InventoryPublicationReadbackClock = { now: () => new Date() };

export class InventoryPublicationReadbackServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "InventoryPublicationReadbackServiceError";
  }
}

export class InventoryPublicationReadbackService {
  constructor(
    private readonly store: InventoryPublicationReadbackStore,
    private readonly adapters: Pick<ChannelAdapterRegistry, "get">,
    private readonly clock: InventoryPublicationReadbackClock = systemClock,
  ) {}

  async capture(input: unknown, actorInput: string): Promise<InventoryPublicationReadbackRun> {
    const parsed = captureInventoryPublicationReadbacksRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new InventoryPublicationReadbackServiceError(
        400,
        "INVENTORY_PUBLICATION_READBACK_REQUEST_INVALID",
        "Review the provider-readback request fields.",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      );
    }
    const actor = actorSchema.safeParse(actorInput);
    if (!actor.success) {
      throw new InventoryPublicationReadbackServiceError(
        401,
        "INVENTORY_PUBLICATION_READBACK_ACTOR_REQUIRED",
        "An authenticated inventory activation actor is required.",
      );
    }
    const startedAt = validNow(this.clock);
    const requestHash = hash({
      contractVersion: "inventory_publication_readback_v1",
      actor: actor.data,
      ...parsed.data,
    });
    const begin = await this.store.begin({
      ...parsed.data,
      requestedBy: actor.data,
      requestHash,
      startedAt,
    });
    if (begin.kind === "replay") return begin.result;

    const failures: PublicationReadbackFailure[] = [];
    for (const target of begin.targets) {
      const failure = await this.captureTarget(begin.readbackRunId, target);
      if (failure) failures.push(failure);
    }
    return inventoryPublicationReadbackRunSchema.parse(await this.store.complete({
      readbackRunId: begin.readbackRunId,
      requestedBy: actor.data,
      reason: parsed.data.reason,
      startedAt,
      completedAt: validNow(this.clock),
      targetRows: begin.targets.length,
      failures,
    }));
  }

  private async captureTarget(
    readbackRunId: string,
    target: PublicationReadbackTarget,
  ): Promise<PublicationReadbackFailure | null> {
    let observedQuantity: number;
    try {
      if (target.destinationKind !== "channel_connection" || target.channelConnectionId === null) {
        throw classified(
          "PUBLICATION_READBACK_DESTINATION_UNSUPPORTED",
          "Authoritative Dropship storefront inventory readback is not registered yet.",
        );
      }
      const adapter = this.adapters.get(target.providerKey);
      if (!adapter?.readInventory) {
        throw classified(
          "PUBLICATION_READBACK_UNSUPPORTED",
          `No authoritative inventory readback is registered for ${target.providerKey}.`,
        );
      }
      if (!adapter.inventoryPublicationScopeTypes?.includes(target.providerScopeType)) {
        throw classified(
          "PUBLICATION_READBACK_SCOPE_UNSUPPORTED",
          `The ${target.providerKey} adapter cannot read ${target.providerScopeType}-scoped inventory without inference.`,
        );
      }
      const context: InventoryPublicationContext = {
        authority: "canonical_outbox",
        channelConnectionId: target.channelConnectionId,
        providerScopeType: target.providerScopeType,
        externalScopeId: target.externalScopeId,
      };
      const item: InventoryReadItem = {
        variantId: target.productVariantId,
        sku: target.externalSku,
        externalInventoryItemId: target.externalInventoryItemId,
        providerScopeType: target.providerScopeType,
        externalScopeId: target.externalScopeId,
      };
      const results = await adapter.readInventory(target.channelId, [item], context);
      if (results.length !== 1 || results[0]?.variantId !== target.productVariantId) {
        throw classified("PROVIDER_READBACK_RESPONSE_INVALID", "Provider returned no exact matching readback row.");
      }
      const result = results[0];
      if (result.status !== "success") {
        throw classified(
          result.errorCode ?? "PROVIDER_READBACK_FAILED",
          result.error ?? "Provider inventory readback failed.",
        );
      }
      if (!Number.isSafeInteger(result.observedQty) || result.observedQty < 0) {
        throw classified("PROVIDER_READBACK_QUANTITY_INVALID", "Provider returned an invalid inventory quantity.");
      }
      observedQuantity = result.observedQty;
    } catch (error) {
      const failure: PublicationReadbackFailure = {
        publicationTargetId: target.publicationTargetId,
        productVariantId: target.productVariantId,
        code: error instanceof ClassifiedReadbackError || error instanceof InventoryPublicationConfigurationError
          ? error.code
          : "PROVIDER_READBACK_ERROR",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      };
      await this.store.recordFailure(readbackRunId, target, failure);
      return failure;
    }
    await this.store.recordObserved(
      readbackRunId,
      target,
      observedQuantity,
      validNow(this.clock),
    );
    return null;
  }
}

class ClassifiedReadbackError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ClassifiedReadbackError";
  }
}

function classified(code: string, message: string): ClassifiedReadbackError {
  return new ClassifiedReadbackError(code, message);
}

function validNow(clock: InventoryPublicationReadbackClock): Date {
  const value = clock.now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InventoryPublicationReadbackServiceError(
      500,
      "INVENTORY_PUBLICATION_READBACK_CLOCK_INVALID",
      "The provider-readback clock returned an invalid time.",
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
