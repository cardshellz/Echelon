import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PostgresInventoryQuantityLedger } from "./quantity-ledger.repository";
import { loadAndLockRuntimeAuthority } from "../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository";
import type { OperationalShipmentBeforeCommit, OperationalShipmentDispatcher, OperationalShipmentSourceOwner } from "../application/operational-shipment-dispatch.port";
import { OperationalShipmentError, operationalShipmentRequestSchema, planOperationalShipmentConsumption,
  type OperationalShipmentRequest, type OperationalShipmentResult } from "../domain/operational-shipment-dispatch";

const MAX_ATTEMPTS = 3;
const MAX_LOCATIONS = 1_000;
const MAX_LOTS = 10_000;
const LEGACY_SHIPMENT_LOCK_NAMESPACE = 918407;
const positive = z.number().int().positive().max(2_147_483_647);
function fail(code: string, message: string): never { throw new OperationalShipmentError(code, message); }
function retryable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "40001" || code === "40P01" || code === "INVENTORY_PUBLICATION_TARGET_BUSY";
}
async function expectUpdate(client: PoolClient, sql: string, values: unknown[]) {
  if ((await client.query(sql, values)).rowCount !== 1) fail("OPERATIONAL_SHIPMENT_STATE_CHANGED", "Locked exact stock changed before its operational debit.");
}

/**
 * One SERIALIZABLE owner transaction: authority -> WMS source -> source dedup ->
 * levels/locations in location order -> exact FIFO lots -> receipt -> publication.
 * Only NEW unreserved on-hand is consumed. Customer picked/reserved/COGS rows and
 * historical source bins are never repurposed. No provider call occurs here.
 */
export class PostgresOperationalShipmentDispatchRepository implements OperationalShipmentDispatcher {
  constructor(private readonly pool: Pick<Pool, "connect">,
    private readonly sourceOwner: OperationalShipmentSourceOwner,
    private readonly beforeCommit: OperationalShipmentBeforeCommit, private readonly clock: () => Date) {}

  async dispatch(raw: OperationalShipmentRequest): Promise<OperationalShipmentResult> {
    const request = operationalShipmentRequestSchema.parse(raw);
    const occurredAt = this.clock();
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
      fail("OPERATIONAL_SHIPMENT_CLOCK_INVALID", "Operational shipment requires a valid injected timestamp.");
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const client = await this.pool.connect();
      let began = false;
      let releaseError: Error | undefined = new Error("Operational dispatch BEGIN did not complete.");
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE"); began = true; releaseError = undefined;
        await client.query("SET LOCAL statement_timeout = '30s'");
        const authority = await loadAndLockRuntimeAuthority(client);
        if (authority.authority !== "canonical") fail("OPERATIONAL_SHIPMENT_CANONICAL_REQUIRED", "Operational owner requires canonical authority.");
        const quantityLedgerActive = (await client.query("SELECT command_id FROM inventory.quantity_ledger_opening WHERE singleton_key = true")).rows.length === 1;
        const replay = await this.replay(client, request);
        if (replay) { await client.query("COMMIT"); began = false; return replay; }
        const source = await this.sourceOwner.lockSource(client, request);
        await client.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)",
          [LEGACY_SHIPMENT_LOCK_NAMESPACE, request.sourceShipmentItemId]);
        const prior = await client.query(`SELECT id FROM inventory.inventory_transactions
          WHERE transaction_type='ship' AND (shipment_item_id=$1 OR
            (shipment_item_id IS NULL AND shipment_id=$2 AND order_item_id=$3))
          ORDER BY id LIMIT 1`, [request.sourceShipmentItemId, request.outboundShipmentId, source.replacementForOrderItemId]);
        if (prior.rows.length) fail("OPERATIONAL_SHIPMENT_ALREADY_POSTED", "A prior unowned shipment posting requires explicit reconciliation, not another debit.");
        const levels = (await client.query(`SELECT level.id,level.warehouse_location_id AS location_id,
          level.variant_qty,level.reserved_qty,location.location_type,location.pick_sequence
          FROM inventory.inventory_levels level JOIN warehouse.warehouse_locations location
            ON location.id=level.warehouse_location_id
          JOIN warehouse.warehouses warehouse ON warehouse.id=location.warehouse_id
          WHERE level.product_variant_id=$1 AND location.warehouse_id=$2
            AND location.is_active=1 AND location.is_pickable=1 AND location.cycle_count_freeze_id IS NULL
            AND warehouse.is_active=1 AND warehouse.inventory_source_type='internal'
            AND level.variant_qty>level.reserved_qty
          ORDER BY level.warehouse_location_id,level.product_variant_id,level.id
          LIMIT $3 FOR UPDATE OF level FOR SHARE OF location,warehouse`,
          [request.productVariantId, source.warehouseId, MAX_LOCATIONS + 1])).rows;
        if (levels.length > MAX_LOCATIONS) fail("OPERATIONAL_SHIPMENT_EVIDENCE_LIMIT", "Available locations exceed the complete-snapshot bound.");
        const locations = levels.map((level) => positive.parse(level.location_id));
        const lots = (await client.query(`SELECT id,warehouse_location_id AS location_id,
          qty_on_hand,qty_reserved,unit_cost_mills::text,received_at
          FROM inventory.inventory_lots WHERE product_variant_id=$1
            AND warehouse_location_id=ANY($2::integer[]) AND status='active' AND qty_on_hand>0
          ORDER BY warehouse_location_id,product_variant_id,received_at,id
          LIMIT $3 FOR UPDATE`, [request.productVariantId, locations, MAX_LOTS + 1])).rows;
        if (lots.length > MAX_LOTS) fail("OPERATIONAL_SHIPMENT_EVIDENCE_LIMIT", "Available FIFO lots exceed the complete-snapshot bound.");
        const priority = (type: unknown) => type === "pick" ? 0 : type === "pallet" ? 1 : 2;
        const preferred = [...levels].sort((a, b) => priority(a.location_type)-priority(b.location_type)
          || (a.pick_sequence ?? Number.MAX_SAFE_INTEGER)-(b.pick_sequence ?? Number.MAX_SAFE_INTEGER)
          || a.location_id-b.location_id);
        let plan: ReturnType<typeof planOperationalShipmentConsumption> = null;
        for (const level of preferred) {
          plan = planOperationalShipmentConsumption(request.quantity,
            { id: level.id, locationId: level.location_id, onHand: level.variant_qty, reserved: level.reserved_qty },
            lots.filter((lot) => lot.location_id === level.location_id).map((lot) => ({
              id: lot.id, onHand: lot.qty_on_hand, reserved: lot.qty_reserved,
              unitCostMills: lot.unit_cost_mills, receivedAt: lot.received_at,
            })));
          if (plan) break;
        }
        if (!plan) fail("REPLACEMENT_INVENTORY_UNAVAILABLE", "No single authorized warehouse bin has complete unreserved balance and FIFO stock.");
        if (quantityLedgerActive) {
          await new PostgresInventoryQuantityLedger().postInsideTransaction(client, {
            contractVersion: "inventory_quantity_v1", idempotencyKey: `operational_shipment:${request.sourceShipmentItemId}`,
            kind: "ship", actor: request.actor, reason: "Authorized non-customer shipment from exact unreserved FIFO stock",
            reference: { type: "operational_shipment", id: String(request.sourceShipmentItemId) },
            occurredAt: occurredAt.toISOString(), reversesCommandId: null,
            movements: plan.lots.map(lot => ({ inventoryLotId: lot.lotId, inventoryLevelId: plan!.level.id,
              productVariantId: request.productVariantId, warehouseLocationId: plan!.level.locationId, warehouseId: source.warehouseId,
              delta: { onHand: -lot.quantity, reserved: 0, picked: 0, packed: 0 } })),
          });
        } else {
          for (const lot of plan.lots) {
            await expectUpdate(client, `UPDATE inventory.inventory_lots
              SET qty_on_hand=qty_on_hand-$1,
                status=CASE WHEN qty_on_hand=$1 AND qty_reserved=0 AND qty_picked=0 THEN 'depleted' ELSE status END
              WHERE id=$2 AND qty_on_hand-qty_reserved >= $1`, [lot.quantity, lot.lotId]);
          }
          await expectUpdate(client, `UPDATE inventory.inventory_levels SET variant_qty=variant_qty-$1,updated_at=$3
            WHERE id=$2 AND variant_qty-reserved_qty >= $1`, [request.quantity, plan.level.id, occurredAt]);
        }
        const posting = await client.query(`INSERT INTO inventory.inventory_transactions (
          transaction_type,product_variant_id,from_location_id,variant_qty_delta,variant_qty_before,variant_qty_after,
          reserved_qty_delta,source_state,target_state,order_id,order_item_id,shipment_id,shipment_item_id,
          reference_type,reference_id,total_cost_mills,user_id,notes,created_at)
          VALUES('ship',$1,$2,$3,$4,$5,0,'on_hand','shipped',$6,NULL,$7,$8,
            'operational_shipment',$9,$10,$11,$12,$13) RETURNING id`,
          [request.productVariantId, plan.level.locationId, -request.quantity, plan.level.onHand,
            plan.level.onHand-request.quantity, request.orderId, request.outboundShipmentId, request.sourceShipmentItemId,
            String(request.sourceShipmentItemId), plan.totalCostMills, request.actor,
            "Authorized non-customer shipment from exact unreserved FIFO stock; no customer-order COGS", occurredAt]);
        const inventoryTransactionId = positive.parse(posting.rows[0]?.id);
        const receipt = await client.query(`INSERT INTO inventory.operational_shipment_dispatch_receipts(
          source_shipment_item_id,outbound_shipment_id,order_id,product_variant_id,warehouse_id,warehouse_location_id,
          physical_shipment_item_id,replacement_for_order_item_id,purpose,quantity,total_cost_mills,
          inventory_transaction_id,actor,occurred_at)
          VALUES($1,$2,$3,$4,$5,$6,$7::bigint,$8,$9,$10,$11::bigint,$12,$13,$14) RETURNING id::text`,
          [request.sourceShipmentItemId, request.outboundShipmentId, request.orderId, request.productVariantId,
            source.warehouseId, plan.level.locationId, source.physicalShipmentItemId, source.replacementForOrderItemId,
            source.purpose, request.quantity, plan.totalCostMills, inventoryTransactionId, request.actor, occurredAt]);
        const receiptId = z.string().regex(/^[1-9][0-9]*$/).parse(receipt.rows[0]?.id);
        for (const lot of plan.lots) {
          await client.query(`INSERT INTO inventory.operational_shipment_dispatch_lots
            (receipt_id,inventory_lot_id,quantity,unit_cost_mills,total_cost_mills) VALUES($1::bigint,$2,$3,$4::bigint,$5::bigint)`,
            [receiptId, lot.lotId, lot.quantity, lot.unitCostMills, lot.totalCostMills]);
        }
        await this.beforeCommit({ client, request, inventoryTransactionId });
        await client.query("COMMIT"); began = false;
        return { warehouseLocationId: plan.level.locationId, alreadyRecorded: false, preserveSourceLocation: true };
      } catch (error) {
        if (began) {
          try { await client.query("ROLLBACK"); }
          catch (rollbackError) {
            releaseError = rollbackError instanceof Error ? rollbackError : new Error("Operational dispatch rollback failed.");
            throw new AggregateError([error, rollbackError], "Operational dispatch and rollback failed.");
          }
        }
        if (began && retryable(error) && attempt < MAX_ATTEMPTS) continue;
        throw error;
      } finally { client.release(releaseError); }
    }
    return fail("OPERATIONAL_SHIPMENT_RETRY_EXHAUSTED", "Operational dispatch could not serialize.");
  }

  private async replay(client: PoolClient, request: OperationalShipmentRequest): Promise<OperationalShipmentResult | null> {
    const rows = (await client.query(`SELECT order_id,outbound_shipment_id,product_variant_id,quantity,warehouse_location_id
      FROM inventory.operational_shipment_dispatch_receipts WHERE source_shipment_item_id=$1 FOR SHARE`,
      [request.sourceShipmentItemId])).rows;
    if (!rows.length) return null;
    const receipt = rows[0];
    if (rows.length !== 1 || receipt.order_id !== request.orderId || receipt.outbound_shipment_id !== request.outboundShipmentId
      || receipt.product_variant_id !== request.productVariantId || receipt.quantity !== request.quantity) {
      fail("OPERATIONAL_SHIPMENT_REPLAY_CONFLICT", "Operational replay differs from the immutable full-source receipt.");
    }
    return { warehouseLocationId: positive.parse(receipt.warehouse_location_id), alreadyRecorded: true, preserveSourceLocation: true };
  }
}
