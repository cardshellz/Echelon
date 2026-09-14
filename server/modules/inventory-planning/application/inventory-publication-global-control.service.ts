import { createHash } from "node:crypto";

import {
  inventoryPublicationGlobalControlRequestSchema,
  inventoryPublicationGlobalControlResultSchema,
  type InventoryPublicationGlobalControlRequest,
  type InventoryPublicationGlobalControlResult,
} from "@shared/types/inventory-publication-global-control";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";

const actorSchema = z.string().trim().min(1).max(100);

export interface InventoryPublicationGlobalControlCommand
extends InventoryPublicationGlobalControlRequest {
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

export interface InventoryPublicationGlobalControlStore {
  change(
    command: InventoryPublicationGlobalControlCommand,
  ): Promise<InventoryPublicationGlobalControlResult>;
}

export interface InventoryPublicationGlobalControlClock {
  now(): Date;
}

const systemClock: InventoryPublicationGlobalControlClock = { now: () => new Date() };

export class InventoryPublicationGlobalControlService {
  constructor(
    private readonly store: InventoryPublicationGlobalControlStore,
    private readonly clock: InventoryPublicationGlobalControlClock = systemClock,
  ) {}

  async change(
    input: InventoryPublicationGlobalControlRequest,
    actorInput: string,
    store: InventoryPublicationGlobalControlStore = this.store,
  ): Promise<InventoryPublicationGlobalControlResult> {
    const parsed = inventoryPublicationGlobalControlRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new InventoryAvailabilityMasterDataError(
        400,
        "INVENTORY_PUBLICATION_GLOBAL_CONTROL_INVALID_REQUEST",
        "Review the global publication-control request fields.",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      );
    }
    const actor = actorSchema.safeParse(actorInput);
    if (!actor.success) {
      throw new InventoryAvailabilityMasterDataError(
        401,
        "INVENTORY_PUBLICATION_GLOBAL_CONTROL_ACTOR_REQUIRED",
        "An authenticated operator is required.",
      );
    }
    const occurredAt = this.clock.now();
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
      throw new InventoryAvailabilityMasterDataError(
        500,
        "INVENTORY_PUBLICATION_GLOBAL_CONTROL_CLOCK_INVALID",
        "The publication-control clock returned an invalid timestamp.",
      );
    }
    const requestHash = createHash("sha256").update(canonicalJson({
      commandType: "inventory_publication_global_control_change",
      actorId: actor.data,
      request: parsed.data,
    }), "utf8").digest("hex");
    return inventoryPublicationGlobalControlResultSchema.parse(await store.change({
      ...parsed.data,
      actorId: actor.data,
      requestHash,
      occurredAt,
    }));
  }
}
