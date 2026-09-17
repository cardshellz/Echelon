import { createHash } from "node:crypto";

import {
  holdInventoryPublicationTargetsRequestSchema,
  inventoryPublicationTargetHoldResultSchema,
  type HoldInventoryPublicationTargetsRequest,
  type InventoryPublicationTargetHoldResult,
} from "@shared/types/inventory-channel-exposure";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";

/**
 * Hold and release commands for the live publication targets of one
 * destination (a channel connection or a Dropship store connection).
 *
 * A hold does not stop publication. The target stays live and the planner
 * keeps running; it just publishes zero for every SKU while the hold stands,
 * and the command republishes the target's products so the marketplace sees
 * the zeros promptly. A release clears the hold and republishes the real
 * quantities the same way. Both are idempotent by key and keyed by
 * destination rather than target id, because the first caller (Dropship
 * vendor standing) knows which store it is pausing, not which targets
 * inventory planning created for it.
 */

const actorSchema = z.string().trim().min(1).max(100);

export type InventoryPublicationTargetHoldCommandKind = "hold" | "release";

export interface InventoryPublicationTargetHoldCommand extends HoldInventoryPublicationTargetsRequest {
  command: InventoryPublicationTargetHoldCommandKind;
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

export interface InventoryPublicationTargetHoldStore {
  apply(command: InventoryPublicationTargetHoldCommand): Promise<InventoryPublicationTargetHoldResult>;
}

export interface InventoryPublicationTargetHoldClock { now(): Date }

const systemClock: InventoryPublicationTargetHoldClock = { now: () => new Date() };

export class InventoryPublicationTargetHoldService {
  constructor(
    private readonly store: InventoryPublicationTargetHoldStore,
    private readonly clock: InventoryPublicationTargetHoldClock = systemClock,
  ) {}

  hold(input: unknown, actorInput: string): Promise<InventoryPublicationTargetHoldResult> {
    return this.apply("hold", input, actorInput);
  }

  release(input: unknown, actorInput: string): Promise<InventoryPublicationTargetHoldResult> {
    return this.apply("release", input, actorInput);
  }

  private async apply(
    command: InventoryPublicationTargetHoldCommandKind,
    input: unknown,
    actorInput: string,
  ): Promise<InventoryPublicationTargetHoldResult> {
    const request = holdInventoryPublicationTargetsRequestSchema.safeParse(input);
    if (!request.success) {
      throw new InventoryAvailabilityMasterDataError(
        400,
        "INVENTORY_PUBLICATION_TARGET_HOLD_INVALID_REQUEST",
        `Review the publication-target ${command} request fields.`,
        request.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      );
    }
    const actor = actorSchema.safeParse(actorInput);
    if (!actor.success) {
      throw new InventoryAvailabilityMasterDataError(
        401,
        "INVENTORY_PUBLICATION_TARGET_HOLD_ACTOR_REQUIRED",
        "An authenticated operator or system actor is required.",
      );
    }
    const occurredAt = this.clock.now();
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
      throw new InventoryAvailabilityMasterDataError(
        500,
        "INVENTORY_PUBLICATION_TARGET_HOLD_CLOCK_INVALID",
        `The publication-target ${command} clock returned an invalid timestamp.`,
      );
    }
    // The command kind is part of the hash: reusing a hold key for a release
    // is a different request and must be refused as an idempotency conflict.
    const requestHash = createHash("sha256").update(canonicalJson({
      commandType: `inventory_publication_target_${command}`,
      actorId: actor.data,
      request: request.data,
    }), "utf8").digest("hex");
    return inventoryPublicationTargetHoldResultSchema.parse(await this.store.apply({
      ...request.data,
      command,
      actorId: actor.data,
      requestHash,
      occurredAt,
    }));
  }
}
