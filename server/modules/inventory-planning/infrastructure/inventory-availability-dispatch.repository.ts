import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  canonicalClaimDispatchCommandSchema, canonicalClaimDispatchReceiptSchema,
  type CanonicalClaimDispatchCommand, type CanonicalClaimDispatchEvidence,
  type CanonicalClaimDispatchPlan, type CanonicalClaimDispatchReceipt,
} from "@shared/types/inventory-availability-dispatch";
import type { CanonicalClaimInventoryDispatchPort } from "../application/canonical-claim-inventory.port";
import type {
  CanonicalClaimDispatchBeforeCommit, CanonicalClaimDispatchSourceOwner, CanonicalClaimDispatchStore,
} from "../application/inventory-availability-dispatch.port";
import {
  canonicalClaimDispatchCommandHash, canonicalClaimDispatchPlanHash,
  planCanonicalClaimDispatch, validateCanonicalClaimDispatchReplay,
} from "../domain/inventory-availability-dispatch";

const MAX_ATTEMPTS = 3;
const MAX_RESOURCES = 1_000;
const MAX_LOTS_AND_PICKS = 10_000;
type Resource = CanonicalClaimDispatchEvidence["resources"][number];
type Lot = Resource["lots"][number];
type PickMovement = CanonicalClaimDispatchEvidence["pickMovements"][number];
type PickRow = Omit<PickMovement, "cost"> & { orderItemCostId: number };

export class CanonicalClaimDispatchRepositoryError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "CanonicalClaimDispatchRepositoryError";
  }
}
function fail(code: string, message: string): never { throw new CanonicalClaimDispatchRepositoryError(code, message); }
function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === "40001" || code === "40P01"
    || (code === "23505" && constraint === "availability_claim_commands_idempotency_uq");
}
function bounded<T>(rows: T[], maximum: number): T[] {
  if (rows.length > maximum) fail("CLAIM_DISPATCH_EVIDENCE_LIMIT", "Dispatch evidence exceeds its complete-snapshot bound.");
  return rows;
}
async function exactlyOne(client: PoolClient, sql: string, values: unknown[]): Promise<void> {
  if ((await client.query(sql, values)).rowCount !== 1) {
    fail("CLAIM_DISPATCH_STATE_CHANGED", "Exact claim custody changed before dispatch could commit.");
  }
}

/**
 * Serializes exact picked custody; never plans new supply or changes model heads.
 * Lock order: authority SHARE -> WMS order/source owner -> claim/line -> resources
 * -> allocations/pick lineage -> inventory owner levels/lots. No graph lock is
 * acquired after the order: dispatch does not read or mutate graph policy.
 * No runtime construction/HTTP route is supplied by this repository.
 */
export class PostgresCanonicalClaimDispatchRepository implements CanonicalClaimDispatchStore {
  constructor(
    private readonly connectionPool: Pick<Pool, "connect">,
    private readonly sourceOwner: CanonicalClaimDispatchSourceOwner,
    private readonly inventoryWriter: CanonicalClaimInventoryDispatchPort,
    private readonly beforeCommit: CanonicalClaimDispatchBeforeCommit,
    private readonly clock: () => Date,
  ) {}

  async dispatch(rawCommand: CanonicalClaimDispatchCommand): Promise<CanonicalClaimDispatchReceipt> {
    const command = canonicalClaimDispatchCommandSchema.parse(rawCommand);
    const clockValue = this.clock();
    if (!(clockValue instanceof Date) || Number.isNaN(clockValue.getTime())) {
      fail("CLAIM_DISPATCH_INVALID_CLOCK", "The injected dispatch clock is invalid.");
    }
    const occurredAt = new Date(clockValue.getTime());
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const client = await this.connectionPool.connect();
      let began = false;
      let releaseError: Error | undefined;
      try {
        // A rejected BEGIN can have an ambiguous server-side outcome. Discard
        // that session unless the transaction was positively established.
        releaseError = new Error("Dispatch transaction BEGIN did not complete.");
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        began = true; releaseError = undefined;
        await client.query("SET LOCAL statement_timeout = '30s'");
        const replay = await loadReplay(client, command);
        if (replay) {
          await client.query("COMMIT"); began = false;
          return replay;
        }
        await requireCanonicalAuthority(client);
        const source = await this.sourceOwner.lockDispatchSource({ client, command });
        const evidence = await loadEvidence(client, command, source, this.inventoryWriter);
        const plan = planCanonicalClaimDispatch(command, evidence);
        const mutation = await this.inventoryWriter.dispatchPickedResources({ client, plan, occurredAt });
        if (mutation.quantity !== command.quantity || mutation.physicalOnHandDelta !== "0"
          || mutation.reservedQuantityDelta !== "0" || mutation.pickedQuantityDelta !== `-${command.quantity}`
          || !Number.isSafeInteger(mutation.inventoryTransactionId) || mutation.inventoryTransactionId <= 0) {
          fail("CLAIM_DISPATCH_INVALID_MUTATION_RESULT", "The inventory owner returned a different dispatch effect.");
        }
        await updateCustody(client, plan, occurredAt);
        const receipt = canonicalClaimDispatchReceiptSchema.parse({
          contractVersion: "canonical_claim_dispatch_receipt_v1",
          commandHash: plan.commandHash, planHash: canonicalClaimDispatchPlanHash(plan),
          plan, occurredAt: occurredAt.toISOString(),
        });
        await persistJournal(client, receipt, mutation.inventoryTransactionId, evidence.claim.status);
        await this.beforeCommit({ client, receipt: structuredClone(receipt), inventoryTransactionId: mutation.inventoryTransactionId });
        await client.query("COMMIT"); began = false;
        return receipt;
      } catch (error) {
        if (began) {
          try { await client.query("ROLLBACK"); }
          catch (rollbackError) {
            releaseError = rollbackError instanceof Error ? rollbackError : new Error("Dispatch rollback failed.");
            throw new AggregateError([error, rollbackError], "Canonical dispatch and rollback both failed.");
          }
        }
        if (began && retryable(error) && attempt < MAX_ATTEMPTS) continue;
        throw error;
      } finally { client.release(releaseError); }
    }
    return fail("CLAIM_DISPATCH_RETRY_EXHAUSTED", "Canonical dispatch could not serialize within its retry bound.");
  }
}

async function loadReplay(client: PoolClient, command: CanonicalClaimDispatchCommand): Promise<CanonicalClaimDispatchReceipt | null> {
  const rows = (await client.query<{ command_type: string; request_hash: string; result_hash: string; result_payload: unknown }>(
    `SELECT command_type, request_hash, result_hash, result_payload FROM inventory.availability_claim_commands
     WHERE idempotency_key = $1 FOR SHARE`, [command.idempotencyKey],
  )).rows;
  if (!rows.length) return null;
  const row = rows[0];
  if (row.command_type !== "dispatch" || row.request_hash !== canonicalClaimDispatchCommandHash(command)) {
    fail("CLAIM_DISPATCH_IDEMPOTENCY_CONFLICT", "The dispatch key already belongs to a different command.");
  }
  if (row.result_hash !== digest(row.result_payload)) fail("CLAIM_DISPATCH_RECEIPT_INVALID", "Stored dispatch result hash does not match its payload.");
  return validateCanonicalClaimDispatchReplay(command, row.result_payload);
}

async function requireCanonicalAuthority(client: PoolClient): Promise<void> {
  const row = (await client.query<{ authority: string; activation_run_id: string | null; revision: string }>(
    `SELECT authority, activation_run_id::text, revision::text
     FROM inventory.availability_runtime_authority WHERE singleton_key = true FOR SHARE`,
  )).rows[0];
  if (!row || row.authority !== "canonical" || !/^[1-9][0-9]*$/.test(row.activation_run_id ?? "")
    || !/^[1-9][0-9]*$/.test(row.revision)) {
    fail("CANONICAL_AUTHORITY_NOT_ACTIVE", "Dispatch requires the committed canonical inventory authority.");
  }
}

async function loadEvidence(
  client: PoolClient, command: CanonicalClaimDispatchCommand,
  source: Omit<CanonicalClaimDispatchEvidence["source"], "dispatchedQuantity">,
  inventoryWriter: CanonicalClaimInventoryDispatchPort,
): Promise<CanonicalClaimDispatchEvidence> {
  const claim = (await client.query<CanonicalClaimDispatchEvidence["claim"]>(
    `SELECT id::text, order_id AS "orderId", status FROM inventory.availability_claims WHERE id = $1 FOR UPDATE`, [command.claimId],
  )).rows[0];
  if (!claim) fail("CLAIM_DISPATCH_CLAIM_MISSING", "The dispatch claim does not exist.");
  const line = (await client.query<CanonicalClaimDispatchEvidence["line"]>(
    `SELECT id::text, claim_id::text AS "claimId", order_item_id AS "orderItemId", target_variant_id AS "targetVariantId",
       planned_qty::text AS "plannedQty", released_target_qty::text AS "releasedTargetQty",
       consumed_target_qty::text AS "consumedTargetQty", picked_target_qty::text AS "pickedTargetQty"
     FROM inventory.availability_claim_lines WHERE claim_id = $1 AND order_item_id = $2 FOR UPDATE`, [command.claimId, command.orderItemId],
  )).rows[0];
  if (!line) fail("CLAIM_DISPATCH_LINE_MISSING", "The dispatch claim does not own this order line.");
  const resourceRows = bounded((await client.query<Omit<Resource, "lots">>(
    `SELECT id::text, claim_id::text AS "claimId", claim_line_id::text AS "claimLineId", warehouse_id AS "warehouseId",
       warehouse_location_id AS "warehouseLocationId", inventory_level_id AS "inventoryLevelId", source_variant_id AS "sourceVariantId",
       consumer_operation_key AS "consumerOperationKey", producer_operation_key AS "producerOperationKey",
       claimed_qty::text AS "claimedQty", released_qty::text AS "releasedQty", consumed_qty::text AS "consumedQty", picked_qty::text AS "pickedQty"
     FROM inventory.availability_claim_resources WHERE claim_id = $1 AND claim_line_id = $2 AND consumer_operation_key IS NULL
     ORDER BY id LIMIT $3 FOR UPDATE`, [command.claimId, line.id, MAX_RESOURCES + 1],
  )).rows, MAX_RESOURCES);
  const ids = resourceRows.map((row) => row.id);
  const lots = bounded((await client.query<Lot>(
    `SELECT id::text, claim_id::text AS "claimId", claim_resource_id::text AS "claimResourceId", inventory_lot_id AS "inventoryLotId",
       claimed_qty::text AS "claimedQty", released_qty::text AS "releasedQty", consumed_qty::text AS "consumedQty", picked_qty::text AS "pickedQty"
     FROM inventory.availability_claim_lot_allocations WHERE claim_id = $1 AND claim_resource_id = ANY($2::bigint[])
     ORDER BY id LIMIT $3 FOR UPDATE`, [command.claimId, ids, MAX_LOTS_AND_PICKS + 1],
  )).rows, MAX_LOTS_AND_PICKS);
  const pickRows = bounded((await client.query<PickRow>(
    `SELECT pick.id::text, pick.claim_id::text AS "claimId", pick.claim_line_id::text AS "claimLineId",
       pick.claim_resource_id::text AS "claimResourceId", pick.claim_lot_allocation_id::text AS "claimLotAllocationId",
       pick.inventory_lot_id AS "inventoryLotId", pick.quantity::text, pick.order_item_cost_id AS "orderItemCostId",
       COALESCE((SELECT sum(reversal.quantity) FROM inventory.availability_claim_pick_movements reversal
         WHERE reversal.reverses_pick_movement_id = pick.id AND reversal.movement_type = 'unpick'), 0)::text AS "reversedQuantity",
       COALESCE((SELECT sum(dispatch.quantity) FROM inventory.availability_claim_dispatch_movements dispatch
         WHERE dispatch.pick_movement_id = pick.id), 0)::text AS "dispatchedQuantity"
     FROM inventory.availability_claim_pick_movements pick
     WHERE pick.claim_id = $1 AND pick.claim_line_id = $2 AND pick.movement_type = 'pick'
       AND pick.claim_resource_id = ANY($3::bigint[]) ORDER BY pick.id LIMIT $4 FOR UPDATE OF pick`,
    [command.claimId, line.id, ids, MAX_LOTS_AND_PICKS + 1],
  )).rows, MAX_LOTS_AND_PICKS);
  const costs = await inventoryWriter.loadDispatchCosts({ client, costIds: pickRows.map((row) => row.orderItemCostId) });
  const costsById = new Map(costs.map((cost) => [cost.id, cost]));
  if (costsById.size !== costs.length) fail("CLAIM_DISPATCH_COST_DUPLICATE", "The inventory owner returned duplicate cost evidence.");
  const pickMovements = pickRows.map(({ orderItemCostId, ...pick }) => {
    const cost = costsById.get(orderItemCostId);
    if (!cost) fail("CLAIM_DISPATCH_COST_MISSING", "Original pick cost evidence is missing.");
    return { ...pick, cost };
  });
  const dispatched = (await client.query<{ quantity: string }>(
    `SELECT COALESCE(sum(quantity), 0)::text AS quantity FROM inventory.availability_claim_dispatch_receipts
     WHERE source_shipment_item_id = $1`, [command.sourceShipmentItemId],
  )).rows[0];
  if (!dispatched) fail("CLAIM_DISPATCH_SOURCE_EVIDENCE_MISSING", "Prior dispatch evidence could not be read.");
  const lotsByResource = new Map<string, Lot[]>();
  for (const lot of lots) lotsByResource.set(lot.claimResourceId, [...(lotsByResource.get(lot.claimResourceId) ?? []), lot]);
  return { coverage: "complete_final_target_line", source: { ...source, dispatchedQuantity: dispatched.quantity }, claim, line,
    resources: resourceRows.map((resource) => ({ ...resource, lots: lotsByResource.get(resource.id) ?? [] })), pickMovements };
}

async function updateCustody(client: PoolClient, plan: CanonicalClaimDispatchPlan, occurredAt: Date): Promise<void> {
  for (const resource of plan.resources) {
    for (const lot of resource.lots) await exactlyOne(client,
      `UPDATE inventory.availability_claim_lot_allocations SET picked_qty = $1, consumed_qty = $2, updated_at = $3
       WHERE id = $4 AND claim_id = $5 AND claim_resource_id = $6 AND picked_qty = $7 AND consumed_qty = $8`,
      [lot.pickedQtyAfter, lot.consumedQtyAfter, occurredAt, lot.claimLotAllocationId, plan.command.claimId,
        resource.claimResourceId, lot.pickedQtyBefore, lot.consumedQtyBefore]);
    await exactlyOne(client,
      `UPDATE inventory.availability_claim_resources SET picked_qty = $1, consumed_qty = $2, updated_at = $3
       WHERE id = $4 AND claim_id = $5 AND claim_line_id = $6 AND picked_qty = $7 AND consumed_qty = $8`,
      [resource.pickedQtyAfter, resource.consumedQtyAfter, occurredAt, resource.claimResourceId, plan.command.claimId,
        plan.claimLineId, resource.pickedQtyBefore, resource.consumedQtyBefore]);
  }
  await exactlyOne(client,
    `UPDATE inventory.availability_claim_lines SET picked_target_qty = $1, consumed_target_qty = $2, updated_at = $3
     WHERE id = $4 AND claim_id = $5 AND picked_target_qty = $6 AND consumed_target_qty = $7`,
    [plan.pickedTargetQtyAfter, plan.consumedTargetQtyAfter, occurredAt, plan.claimLineId, plan.command.claimId,
      plan.pickedTargetQtyBefore, plan.consumedTargetQtyBefore]);
}

async function persistJournal(client: PoolClient, receipt: CanonicalClaimDispatchReceipt, transactionId: number, claimStatus: string): Promise<void> {
  const { command } = receipt.plan;
  const commandRow = (await client.query<{ id: string }>(
    `INSERT INTO inventory.availability_claim_commands (claim_id, order_id, command_type, idempotency_key, request_hash,
       result_hash, request_payload, result_payload, actor, reason, occurred_at)
     VALUES ($1, $2, 'dispatch', $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10) RETURNING id::text`,
    [command.claimId, command.orderId, command.idempotencyKey, receipt.commandHash, digest(receipt), JSON.stringify(command),
      JSON.stringify(receipt), command.actor, command.reason, receipt.occurredAt],
  )).rows[0];
  if (!commandRow || !/^[1-9][0-9]*$/.test(commandRow.id)) fail("CLAIM_DISPATCH_COMMAND_MISSING", "Dispatch command journal did not return its identity.");
  const receiptRow = (await client.query<{ id: string }>(
    `INSERT INTO inventory.availability_claim_dispatch_receipts (command_id, claim_id, claim_line_id, order_id, order_item_id,
       warehouse_id, warehouse_location_id, product_variant_id, outbound_shipment_id, source_shipment_item_id,
       physical_shipment_id, physical_shipment_item_id, quantity, inventory_transaction_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id::text`,
    [commandRow.id, command.claimId, receipt.plan.claimLineId, command.orderId, command.orderItemId, command.warehouseId,
      command.warehouseLocationId, command.productVariantId, command.outboundShipmentId, command.sourceShipmentItemId,
      command.physicalShipmentId, command.physicalShipmentItemId, command.quantity, transactionId, receipt.occurredAt],
  )).rows[0];
  if (!receiptRow || !/^[1-9][0-9]*$/.test(receiptRow.id)) fail("CLAIM_DISPATCH_RECEIPT_MISSING", "Dispatch custody journal did not return its identity.");
  for (const resource of receipt.plan.resources) for (const lot of resource.lots) for (const pick of lot.picks) {
    await client.query(
      `INSERT INTO inventory.availability_claim_dispatch_movements (receipt_id, claim_id, claim_line_id, pick_movement_id, quantity)
       VALUES ($1,$2,$3,$4,$5)`, [receiptRow.id, command.claimId, receipt.plan.claimLineId, pick.pickMovementId, pick.quantity]);
  }
  await client.query(
    `INSERT INTO inventory.availability_claim_events (claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at) VALUES ($1,'claim_line_dispatched',$2,$2,$3::jsonb,$4,$5,$6,$7)`,
    [command.claimId, claimStatus, JSON.stringify(receipt), digest(receipt), command.actor, command.reason, receipt.occurredAt]);
}
