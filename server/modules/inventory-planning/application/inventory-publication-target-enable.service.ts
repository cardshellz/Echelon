import { createHash } from "node:crypto";

import {
  inventoryPublicationTargetEnableResultSchema,
  enableInventoryPublicationTargetRequestSchema,
  type InventoryPublicationTargetEnableResult,
  type EnableInventoryPublicationTargetRequest,
} from "@shared/types/inventory-publication-target-enable";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";

const actorSchema = z.string().trim().min(1).max(100);

export interface InventoryPublicationTargetEnableCommand
extends z.output<typeof enableInventoryPublicationTargetRequestSchema> {
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

export interface InventoryPublicationTargetEnableStore {
  enable(
    command: InventoryPublicationTargetEnableCommand,
  ): Promise<InventoryPublicationTargetEnableResult>;
}

export interface InventoryPublicationTargetEnableClock { now(): Date }

const systemClock: InventoryPublicationTargetEnableClock = { now: () => new Date() };

export class InventoryPublicationTargetEnableService {
  constructor(
    private readonly store: InventoryPublicationTargetEnableStore,
    private readonly clock: InventoryPublicationTargetEnableClock = systemClock,
  ) {}

  async enable(
    input: EnableInventoryPublicationTargetRequest,
    actorInput: string,
  ): Promise<InventoryPublicationTargetEnableResult> {
    const request = enableInventoryPublicationTargetRequestSchema.safeParse(input);
    if (!request.success) {
      throw new InventoryAvailabilityMasterDataError(
        400,
        "INVENTORY_PUBLICATION_TARGET_ENABLE_INVALID_REQUEST",
        "Review the publication-target enable request fields.",
        request.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      );
    }
    const actor = actorSchema.safeParse(actorInput);
    if (!actor.success) {
      throw new InventoryAvailabilityMasterDataError(
        401,
        "INVENTORY_PUBLICATION_TARGET_ENABLE_ACTOR_REQUIRED",
        "An authenticated operator is required.",
      );
    }
    const occurredAt = this.clock.now();
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
      throw new InventoryAvailabilityMasterDataError(
        500,
        "INVENTORY_PUBLICATION_TARGET_ENABLE_CLOCK_INVALID",
        "The target-enable clock returned an invalid timestamp.",
      );
    }
    const requestHash = createHash("sha256").update(canonicalJson({
      commandType: "inventory_publication_target_enable",
      actorId: actor.data,
      request: request.data,
    }), "utf8").digest("hex");
    return inventoryPublicationTargetEnableResultSchema.parse(await this.store.enable({
      ...request.data,
      actorId: actor.data,
      requestHash,
      occurredAt,
    }));
  }
}
