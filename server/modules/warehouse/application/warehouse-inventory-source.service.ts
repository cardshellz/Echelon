import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  prepareWarehouseInventorySourceRequestSchema,
  prepareWarehouseInventorySourceResultSchema,
  warehouseInventorySourceViewSchema,
  type PrepareWarehouseInventorySourceRequest,
  type PrepareWarehouseInventorySourceResult,
  type WarehouseInventorySourceView,
} from "@shared/types/warehouse-inventory-source";
import { WarehouseInventorySourceError } from "../domain/warehouse-inventory-source";

export interface PrepareWarehouseInventorySourceCommand extends PrepareWarehouseInventorySourceRequest {
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}
export interface WarehouseInventorySourceStore {
  getView(): Promise<WarehouseInventorySourceView>;
  prepareDraft(command: PrepareWarehouseInventorySourceCommand): Promise<PrepareWarehouseInventorySourceResult>;
}

export class WarehouseInventorySourceService {
  constructor(
    private readonly store: WarehouseInventorySourceStore,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  async getView(): Promise<WarehouseInventorySourceView> {
    return warehouseInventorySourceViewSchema.parse(await this.store.getView());
  }

  async prepareDraft(input: unknown, actorInput: unknown): Promise<PrepareWarehouseInventorySourceResult> {
    const parsed = prepareWarehouseInventorySourceRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new WarehouseInventorySourceError(400, "WAREHOUSE_INVENTORY_SOURCE_INVALID_REQUEST",
        "Select saved warehouse settings or both explicit authorities, and supply a reason using current warehouse data.");
    }
    const actor = z.string().trim().min(1).max(100).safeParse(actorInput);
    if (!actor.success) {
      throw new WarehouseInventorySourceError(401, "WAREHOUSE_INVENTORY_SOURCE_ACTOR_REQUIRED",
        "An authenticated operator is required.");
    }
    const occurredAt = this.clock.now();
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      throw new WarehouseInventorySourceError(500, "WAREHOUSE_INVENTORY_SOURCE_INVALID_CLOCK",
        "The warehouse source command clock is invalid.", "fatal");
    }
    const requestHash = createHash("sha256").update(canonicalJson({
      command: "warehouse_inventory_source_prepare_v1",
      actorId: actor.data,
      request: parsed.data,
    })).digest("hex");
    return prepareWarehouseInventorySourceResultSchema.parse(await this.store.prepareDraft({
      ...parsed.data, actorId: actor.data, requestHash, occurredAt,
    }));
  }
}
