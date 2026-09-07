import { z } from "zod";
import { inventoryCutoverPreflightSchema, type InventoryCutoverPreflight } from "@shared/types/inventory-cutover-preflight";
import { buildInventoryCutoverPreflight, type InventoryCutoverPreflightFacts } from "../domain/inventory-cutover-preflight";

export interface InventoryCutoverPreflightStore {
  capture(): Promise<InventoryCutoverPreflightFacts>;
}

export class InventoryCutoverPreflightError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "InventoryCutoverPreflightError";
  }
}

export class InventoryCutoverPreflightService {
  constructor(private readonly store: InventoryCutoverPreflightStore) {}

  async preview(actorInput: unknown): Promise<InventoryCutoverPreflight> {
    if (!z.string().trim().min(1).max(100).safeParse(actorInput).success) {
      throw new InventoryCutoverPreflightError(401, "INVENTORY_CUTOVER_ACTOR_REQUIRED", "An authenticated operator is required.");
    }
    const facts = await this.store.capture();
    try {
      return inventoryCutoverPreflightSchema.parse(buildInventoryCutoverPreflight(facts));
    } catch (error) {
      throw new InventoryCutoverPreflightError(500, "INVENTORY_CUTOVER_EVIDENCE_INVALID",
        "Cutover evidence is incomplete or inconsistent; no partial report is usable.", { cause: error });
    }
  }
}
