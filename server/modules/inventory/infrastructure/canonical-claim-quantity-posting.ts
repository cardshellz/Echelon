import type { CanonicalClaimTransactionClient } from "../../inventory-planning/application/canonical-claim-inventory.port";
import { InventoryQuantityError, quantityMovementSchema, type QuantityCommand, type QuantityMovement } from "../domain/quantity-ledger";
import { PostgresInventoryQuantityLedger } from "./quantity-ledger.repository";

type PlannedMovement = Omit<QuantityMovement, "warehouseId">;

/** Explicit command-local plan; never intercepts SQL or infers deltas from counters. */
export class CanonicalClaimQuantityPosting {
  private readonly movements = new Map<number, PlannedMovement>();
  private posted = false;

  private constructor(private readonly client: CanonicalClaimTransactionClient,
    private readonly command: Omit<QuantityCommand, "movements">) {}

  static async forCommand(client: CanonicalClaimTransactionClient, input: {
    key: string | undefined; kind: QuantityCommand["kind"]; actor: string; reason: string;
    occurredAt: Date; reference: QuantityCommand["reference"];
  }): Promise<CanonicalClaimQuantityPosting | null> {
    // Missing schema is a deployment error, not permission to use legacy writes.
    const opening = await client.query("SELECT command_id FROM inventory.quantity_ledger_opening WHERE singleton_key = true");
    if (opening.rows.length === 0) return null;
    if (opening.rows.length !== 1 || !input.key?.trim()) {
      throw new InventoryQuantityError("CANONICAL_QUANTITY_COMMAND_REQUIRED", "Active quantity authority requires a stable business command identity");
    }
    // Fail before any COGS, output-lot or business-journal write if a caller
    // accidentally supplies an autocommit Pool instead of its transaction.
    await client.query("SAVEPOINT canonical_quantity_context");
    await client.query("RELEASE SAVEPOINT canonical_quantity_context");
    return new CanonicalClaimQuantityPosting(client, { contractVersion: "inventory_quantity_v1",
      idempotencyKey: input.key, kind: input.kind, actor: input.actor, reason: input.reason,
      occurredAt: input.occurredAt.toISOString(), reference: input.reference, reversesCommandId: null });
  }

  add(movement: PlannedMovement): void {
    if (this.posted) throw new InventoryQuantityError("QUANTITY_POSTING_CLOSED", "A canonical quantity command is already posted");
    const previous = this.movements.get(movement.inventoryLotId);
    if (previous && (previous.inventoryLevelId !== movement.inventoryLevelId
      || previous.warehouseLocationId !== movement.warehouseLocationId || previous.productVariantId !== movement.productVariantId)) {
      throw new InventoryQuantityError("QUANTITY_IDENTITY_CONFLICT", "A canonical command cannot attribute one lot to multiple physical locations");
    }
    this.movements.set(movement.inventoryLotId, { ...movement, delta: previous ? {
      onHand: previous.delta.onHand + movement.delta.onHand,
      reserved: previous.delta.reserved + movement.delta.reserved,
      picked: previous.delta.picked + movement.delta.picked,
      packed: previous.delta.packed + movement.delta.packed,
    } : { ...movement.delta } });
  }

  async post(): Promise<void> {
    if (this.posted) throw new InventoryQuantityError("QUANTITY_POSTING_CLOSED", "A canonical quantity command may post only once");
    const planned = [...this.movements.values()].filter(movement => Object.values(movement.delta).some(delta => delta !== 0));
    if (planned.length === 0) throw new InventoryQuantityError("QUANTITY_MOVEMENT_REQUIRED", "Canonical quantity posting has no physical or reservation movement");
    const locationIds = [...new Set(planned.map(movement => movement.warehouseLocationId))].sort((a,b) => a-b);
    const locations = await this.client.query("SELECT id, warehouse_id FROM warehouse.warehouse_locations WHERE id = ANY($1::integer[]) ORDER BY id FOR SHARE", [locationIds]);
    const warehouseByLocation = new Map(locations.rows.map(row => [row.id, row.warehouse_id]));
    const movements = planned.map(movement => quantityMovementSchema.parse({ ...movement,
      warehouseId: warehouseByLocation.get(movement.warehouseLocationId) }));
    const result = await new PostgresInventoryQuantityLedger().postInsideTransaction(this.client, { ...this.command, movements });
    // The business owner must replay its entire immutable receipt, including costs
    // and claim counters. Returning here would double-post those other effects.
    if (result.alreadyApplied) throw new InventoryQuantityError("CANONICAL_QUANTITY_REPLAY_REQUIRED", "Replay the original canonical business receipt before posting inventory effects");
    this.posted = true;
  }
}
