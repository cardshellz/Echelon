import { createHash } from "node:crypto";

import {
  holdInventoryPublicationTargetVariantsRequestSchema,
  inventoryPublicationTargetVariantHoldResultSchema,
  type HoldInventoryPublicationTargetVariantsRequest,
  type InventoryPublicationTargetVariantHoldResult,
} from "@shared/types/inventory-channel-exposure";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";

/**
 * SKU-level hold and release commands for the live publication targets of one
 * destination (a channel connection or a Dropship store connection).
 *
 * The destination hold (`inventory-publication-target-hold.service.ts`) zeroes
 * everything a target publishes. This command zeroes only the named SKUs: the
 * target stays live, the planner keeps running, the rest of the catalog keeps
 * its real quantities, and the command republishes the affected products so
 * the marketplace sees the zeros (or the restored quantities) promptly. Both
 * commands are idempotent by key and keyed by destination rather than target
 * id, because the caller (Dropship listing tiers) knows which store and which
 * SKUs it is gating, not which targets inventory planning created for it.
 */

const actorSchema = z.string().trim().min(1).max(100);

export type InventoryPublicationTargetVariantHoldCommandKind = "hold" | "release";

export interface InventoryPublicationTargetVariantHoldCommand
extends HoldInventoryPublicationTargetVariantsRequest {
  command: InventoryPublicationTargetVariantHoldCommandKind;
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

export interface InventoryPublicationTargetVariantHoldStore {
  apply(
    command: InventoryPublicationTargetVariantHoldCommand,
  ): Promise<InventoryPublicationTargetVariantHoldResult>;
}

export interface InventoryPublicationTargetVariantHoldClock { now(): Date }

const systemClock: InventoryPublicationTargetVariantHoldClock = { now: () => new Date() };

export class InventoryPublicationTargetVariantHoldService {
  constructor(
    private readonly store: InventoryPublicationTargetVariantHoldStore,
    private readonly clock: InventoryPublicationTargetVariantHoldClock = systemClock,
  ) {}

  holdVariants(input: unknown, actorInput: string): Promise<InventoryPublicationTargetVariantHoldResult> {
    return this.apply("hold", input, actorInput);
  }

  releaseVariants(input: unknown, actorInput: string): Promise<InventoryPublicationTargetVariantHoldResult> {
    return this.apply("release", input, actorInput);
  }

  private async apply(
    command: InventoryPublicationTargetVariantHoldCommandKind,
    input: unknown,
    actorInput: string,
  ): Promise<InventoryPublicationTargetVariantHoldResult> {
    const request = holdInventoryPublicationTargetVariantsRequestSchema.safeParse(input);
    if (!request.success) {
      throw new InventoryAvailabilityMasterDataError(
        400,
        "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_INVALID_REQUEST",
        `Review the publication-target SKU ${command} request fields.`,
        request.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      );
    }
    const actor = actorSchema.safeParse(actorInput);
    if (!actor.success) {
      throw new InventoryAvailabilityMasterDataError(
        401,
        "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_ACTOR_REQUIRED",
        "An authenticated operator or system actor is required.",
      );
    }
    const occurredAt = this.clock.now();
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
      throw new InventoryAvailabilityMasterDataError(
        500,
        "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_CLOCK_INVALID",
        `The publication-target SKU ${command} clock returned an invalid timestamp.`,
      );
    }
    // The command kind and the SKU list are part of the hash: reusing a hold
    // key for a release, or for a different SKU set, is a different request
    // and must be refused as an idempotency conflict.
    const requestHash = createHash("sha256").update(canonicalJson({
      commandType: `inventory_publication_target_variant_${command}`,
      actorId: actor.data,
      request: request.data,
    }), "utf8").digest("hex");
    return inventoryPublicationTargetVariantHoldResultSchema.parse(await this.store.apply({
      ...request.data,
      command,
      actorId: actor.data,
      requestHash,
      occurredAt,
    }));
  }
}
