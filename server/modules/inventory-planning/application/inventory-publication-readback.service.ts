import { createHash } from "node:crypto";
import { z } from "zod";

import {
  captureInventoryPublicationReadbacksRequestSchema,
  inventoryPublicationReadbackRunSchema,
  type InventoryPublicationReadbackRun,
} from "@shared/types/inventory-availability-phase4";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  InventoryPublicationTransportError,
  type InventoryPublicationDestination,
  type InventoryPublicationTransportRegistry,
} from "./inventory-publication-transport";

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
    private readonly adapters: Pick<InventoryPublicationTransportRegistry, "get">,
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
      const adapter = this.adapters.get(target.destinationKind, target.providerKey);
      if (!adapter) {
        throw classified(
          "PUBLICATION_READBACK_UNSUPPORTED",
          `No authoritative inventory readback is registered for ${target.destinationKind}:${target.providerKey}.`,
        );
      }
      if (!adapter.supportedScopeTypes.includes(target.providerScopeType)) {
        throw classified(
          "PUBLICATION_READBACK_SCOPE_UNSUPPORTED",
          `The ${target.providerKey} adapter cannot read ${target.providerScopeType}-scoped inventory without inference.`,
        );
      }
      const result = await adapter.readAbsolute({
        destination: publicationDestination(target),
        channelId: target.channelId,
        providerScopeType: target.providerScopeType,
        externalScopeId: target.externalScopeId,
        productVariantId: target.productVariantId,
        externalInventoryItemId: target.externalInventoryItemId,
        externalSku: target.externalSku,
      });
      if (!Number.isSafeInteger(result.observedQuantity) || result.observedQuantity < 0) {
        throw classified("PROVIDER_READBACK_QUANTITY_INVALID", "Provider returned an invalid inventory quantity.");
      }
      observedQuantity = result.observedQuantity;
    } catch (error) {
      const failure: PublicationReadbackFailure = {
        publicationTargetId: target.publicationTargetId,
        productVariantId: target.productVariantId,
        code: error instanceof ClassifiedReadbackError || error instanceof InventoryPublicationTransportError
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

function publicationDestination(
  target: PublicationReadbackTarget,
): InventoryPublicationDestination {
  if (target.destinationKind === "channel_connection") {
    if (target.channelConnectionId === null || target.dropshipStoreConnectionId !== null) {
      throw classified(
        "PUBLICATION_READBACK_DESTINATION_INVALID",
        "A channel readback target must contain exactly one channel connection owner.",
      );
    }
    return {
      kind: "channel_connection",
      channelConnectionId: target.channelConnectionId,
      dropshipStoreConnectionId: null,
    };
  }
  if (target.channelConnectionId !== null || target.dropshipStoreConnectionId === null) {
    throw classified(
      "PUBLICATION_READBACK_DESTINATION_INVALID",
      "A Dropship readback target must contain exactly one Dropship store connection owner.",
    );
  }
  return {
    kind: "dropship_store_connection",
    channelConnectionId: null,
    dropshipStoreConnectionId: target.dropshipStoreConnectionId,
  };
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
