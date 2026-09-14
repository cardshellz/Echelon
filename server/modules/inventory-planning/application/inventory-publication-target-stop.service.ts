import { createHash } from "node:crypto";

import {
  inventoryPublicationTargetCommandResultSchema,
  stopInventoryPublicationTargetRequestSchema,
  type InventoryPublicationTargetCommandResult,
  type StopInventoryPublicationTargetRequest,
} from "@shared/types/inventory-channel-exposure";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";

const actorSchema = z.string().trim().min(1).max(100);

export interface InventoryPublicationTargetStopCommand
extends StopInventoryPublicationTargetRequest {
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

export interface InventoryPublicationTargetStopStore {
  stop(
    command: InventoryPublicationTargetStopCommand,
  ): Promise<InventoryPublicationTargetCommandResult>;
}

export interface InventoryPublicationTargetStopClock { now(): Date }

const systemClock: InventoryPublicationTargetStopClock = { now: () => new Date() };

export class InventoryPublicationTargetStopService {
  constructor(
    private readonly store: InventoryPublicationTargetStopStore,
    private readonly clock: InventoryPublicationTargetStopClock = systemClock,
  ) {}

  async stop(
    input: StopInventoryPublicationTargetRequest,
    actorInput: string,
  ): Promise<InventoryPublicationTargetCommandResult> {
    const request = stopInventoryPublicationTargetRequestSchema.safeParse(input);
    if (!request.success) {
      throw new InventoryAvailabilityMasterDataError(
        400,
        "INVENTORY_PUBLICATION_TARGET_STOP_INVALID_REQUEST",
        "Review the publication-target stop request fields.",
        request.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      );
    }
    const actor = actorSchema.safeParse(actorInput);
    if (!actor.success) {
      throw new InventoryAvailabilityMasterDataError(
        401,
        "INVENTORY_PUBLICATION_TARGET_STOP_ACTOR_REQUIRED",
        "An authenticated operator is required.",
      );
    }
    const occurredAt = this.clock.now();
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
      throw new InventoryAvailabilityMasterDataError(
        500,
        "INVENTORY_PUBLICATION_TARGET_STOP_CLOCK_INVALID",
        "The target-stop clock returned an invalid timestamp.",
      );
    }
    const requestHash = createHash("sha256").update(canonicalJson({
      commandType: "inventory_publication_target_stop",
      actorId: actor.data,
      request: request.data,
    }), "utf8").digest("hex");
    return inventoryPublicationTargetCommandResultSchema.parse(await this.store.stop({
      ...request.data,
      actorId: actor.data,
      requestHash,
      occurredAt,
    }));
  }
}
