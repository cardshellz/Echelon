import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { canonicalClaimDispatchCommandSchema, type CanonicalClaimDispatchCommand } from "@shared/types/inventory-availability-dispatch";
import type { CanonicalClaimTransactionClient } from "../application/canonical-claim-inventory.port";
import type { CanonicalClaimDispatchSourceCommandResolver, CanonicalClaimDispatchSourcePreparationOwner,
  CanonicalClaimDispatchSourceRequest } from "../application/inventory-availability-dispatch-source-command.port";
import { canonicalClaimDispatchCommandHash, validateCanonicalClaimDispatchReplay } from "../domain/inventory-availability-dispatch";
import { assertCanonicalClaimDispatchSourceIdentity, canonicalClaimDispatchSourceKey, canonicalClaimDispatchSourceRequestSchema,
  CanonicalClaimDispatchSourceCommandError, selectCanonicalClaimDispatchPickedOwner } from "../domain/inventory-availability-dispatch-source-command";

const MAX_CLAIMS = 1_000;
const MAX_ROWS = 10_000;
const bigintId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const id = z.number().int().positive().max(2_147_483_647);
const replaySchema = z.object({ id: bigintId, claim_id: bigintId, order_id: id, command_type: z.string(),
  idempotency_key: z.string(), request_hash: z.string(), result_hash: z.string(),
  request_payload: z.unknown(), result_payload: z.unknown() }).strict();
const receiptIdentitySchema = z.object({ command_id: bigintId, claim_id: bigintId, claim_line_id: bigintId,
  order_id: id, order_item_id: id, warehouse_id: id, warehouse_location_id: id, product_variant_id: id,
  outbound_shipment_id: id, source_shipment_item_id: id, physical_shipment_id: bigintId.nullable(),
  physical_shipment_item_id: bigintId.nullable(), quantity: bigintId }).strict();

function fail(code: string, message: string): never { throw new CanonicalClaimDispatchSourceCommandError(code, message); }
function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function bounded(rows: unknown[], maximum = MAX_ROWS): unknown[] {
  if (rows.length > maximum) fail("CLAIM_DISPATCH_SOURCE_EVIDENCE_LIMIT", "Complete source ownership evidence exceeds its safe bound");
  return rows;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CanonicalClaimDispatchSourceCommandError("CLAIM_DISPATCH_SOURCE_EVIDENCE_INVALID",
    "Source command evidence violates its strict contract", { issues: result.error.issues });
  return result.data;
}

/**
 * Transaction-scoped resolution, never a new transaction or shipment writer.
 * Committed replay precedes authority/current source reads. New commands pin
 * authority -> WMS source/physical -> all owning claims/lines/resources -> lots
 * -> original picks. Dispatch must run on this same client before commit.
 */
export class PostgresCanonicalClaimDispatchSourceCommandResolver implements CanonicalClaimDispatchSourceCommandResolver {
  constructor(private readonly sourceOwner: CanonicalClaimDispatchSourcePreparationOwner) {}

  async resolve(client: CanonicalClaimTransactionClient, rawRequest: CanonicalClaimDispatchSourceRequest): Promise<CanonicalClaimDispatchCommand> {
    const request = parse(canonicalClaimDispatchSourceRequestSchema, rawRequest);
    const settings = (await client.query("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only")).rows;
    if (settings.length !== 1 || settings[0].isolation !== "serializable" || settings[0].read_only !== "off") {
      fail("CLAIM_DISPATCH_SOURCE_TRANSACTION_REQUIRED", "Source preparation requires the caller's SERIALIZABLE read-write transaction");
    }
    const replay = await resolveReplay(client, request);
    if (replay) return replay;

    const authority = (await client.query(`SELECT authority, activation_run_id::text, revision::text
      FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE`)).rows[0];
    if (!authority || authority.authority !== "canonical" || !bigintId.safeParse(authority.activation_run_id).success
      || !bigintId.safeParse(authority.revision).success) {
      fail("CANONICAL_AUTHORITY_NOT_ACTIVE", "New source dispatch requires committed canonical authority");
    }
    const source = await this.sourceOwner.lockSourceForPreparation({ client, request });
    const picked = selectCanonicalClaimDispatchPickedOwner(request, source, await loadPickedOwnership(client, request));
    if (source.warehouseLocationId === null) {
      await this.sourceOwner.bindSourceLocation({ client, request, warehouseLocationId: picked.warehouseLocationId });
    }
    return parse(canonicalClaimDispatchCommandSchema, { ...request,
      claimId: picked.claimId, warehouseId: picked.warehouseId, warehouseLocationId: picked.warehouseLocationId,
      physicalShipmentId: source.physicalShipmentId, physicalShipmentItemId: source.physicalShipmentItemId,
      idempotencyKey: canonicalClaimDispatchSourceKey(request.sourceShipmentItemId) });
  }
}

async function resolveReplay(client: CanonicalClaimTransactionClient, request: CanonicalClaimDispatchSourceRequest): Promise<CanonicalClaimDispatchCommand | null> {
  // The source lookup also recovers a dispatch made through an older exact-command
  // caller with a different key. It never creates a second command for that source.
  const rows = (await client.query(`SELECT command.id::text, command.claim_id::text, command.order_id, command.command_type,
      command.idempotency_key, command.request_hash, command.result_hash, command.request_payload, command.result_payload
    FROM inventory.availability_claim_commands command
    WHERE command.idempotency_key=$1 OR EXISTS (
      SELECT 1 FROM inventory.availability_claim_dispatch_receipts receipt
      WHERE receipt.command_id=command.id AND receipt.source_shipment_item_id=$2)
    ORDER BY command.id LIMIT 2 FOR SHARE OF command`,
  [canonicalClaimDispatchSourceKey(request.sourceShipmentItemId), request.sourceShipmentItemId])).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1) fail("CLAIM_DISPATCH_SOURCE_REPLAY_CONFLICT", "Source identity and stable key resolve to different commands");
  const row = parse(replaySchema, rows[0]);
  const command = parse(canonicalClaimDispatchCommandSchema, row.request_payload);
  assertCanonicalClaimDispatchSourceIdentity(request, command);
  if (row.command_type !== "dispatch" || row.claim_id !== command.claimId || row.order_id !== command.orderId
    || row.idempotency_key !== command.idempotencyKey || row.request_hash !== canonicalClaimDispatchCommandHash(command)
    || row.result_hash !== digest(row.result_payload)) {
    fail("CLAIM_DISPATCH_SOURCE_REPLAY_INVALID", "Committed source command identity or hashes do not match its immutable payload");
  }
  const receipt = validateCanonicalClaimDispatchReplay(command, row.result_payload);
  if (!receipt) fail("CLAIM_DISPATCH_SOURCE_REPLAY_INVALID", "Committed source command has no dispatch result");
  const receipts = (await client.query(`SELECT command_id::text, claim_id::text, claim_line_id::text, order_id, order_item_id,
      warehouse_id, warehouse_location_id, product_variant_id, outbound_shipment_id, source_shipment_item_id,
      physical_shipment_id::text, physical_shipment_item_id::text, quantity::text
    FROM inventory.availability_claim_dispatch_receipts WHERE command_id=$1 ORDER BY id LIMIT 2`, [row.id])).rows;
  if (receipts.length !== 1) fail("CLAIM_DISPATCH_SOURCE_REPLAY_INVALID", "Committed source command must have one exact custody receipt");
  const identity = parse(receiptIdentitySchema, receipts[0]);
  const expected = { command_id: row.id, claim_id: command.claimId, claim_line_id: receipt.plan.claimLineId,
    order_id: command.orderId, order_item_id: command.orderItemId, warehouse_id: command.warehouseId,
    warehouse_location_id: command.warehouseLocationId, product_variant_id: command.productVariantId,
    outbound_shipment_id: command.outboundShipmentId, source_shipment_item_id: command.sourceShipmentItemId,
    physical_shipment_id: command.physicalShipmentId, physical_shipment_item_id: command.physicalShipmentItemId, quantity: command.quantity };
  if (canonicalJson(identity) !== canonicalJson(expected)) fail("CLAIM_DISPATCH_SOURCE_REPLAY_INVALID", "Source custody receipt differs from the original command");
  return command;
}

async function loadPickedOwnership(client: CanonicalClaimTransactionClient, request: CanonicalClaimDispatchSourceRequest): Promise<unknown> {
  const claims = bounded((await client.query(`SELECT id::text, order_id AS "orderId", status
    FROM inventory.availability_claims WHERE order_id=$1 ORDER BY id LIMIT $2 FOR UPDATE`,
  [request.orderId, MAX_CLAIMS + 1])).rows, MAX_CLAIMS);
  const claimIds = claims.map((row) => parse(z.object({ id: bigintId }).passthrough(), row).id);
  const lines = bounded((await client.query(`SELECT id::text, claim_id::text AS "claimId", order_item_id AS "orderItemId",
      target_variant_id AS "targetVariantId", picked_target_qty::text AS "pickedQty"
    FROM inventory.availability_claim_lines WHERE claim_id=ANY($1::bigint[]) AND order_item_id=$2
    ORDER BY claim_id,id LIMIT $3 FOR UPDATE`, [claimIds, request.orderItemId, MAX_ROWS + 1])).rows);
  const lineIds = lines.map((row) => parse(z.object({ id: bigintId }).passthrough(), row).id);
  const resources = bounded((await client.query(`SELECT id::text, claim_id::text AS "claimId", claim_line_id::text AS "claimLineId",
      warehouse_id AS "warehouseId", warehouse_location_id AS "warehouseLocationId", source_variant_id AS "sourceVariantId",
      picked_qty::text AS "pickedQty"
    FROM inventory.availability_claim_resources WHERE claim_line_id=ANY($1::bigint[]) AND consumer_operation_key IS NULL
    ORDER BY id LIMIT $2 FOR UPDATE`, [lineIds, MAX_ROWS + 1])).rows);
  const resourceIds = resources.map((row) => parse(z.object({ id: bigintId }).passthrough(), row).id);
  const lots = bounded((await client.query(`SELECT id::text, claim_id::text AS "claimId", claim_resource_id::text AS "claimResourceId",
      picked_qty::text AS "pickedQty"
    FROM inventory.availability_claim_lot_allocations WHERE claim_resource_id=ANY($1::bigint[])
    ORDER BY id LIMIT $2 FOR UPDATE`, [resourceIds, MAX_ROWS + 1])).rows);
  const picks = bounded((await client.query(`SELECT pick.id::text, pick.claim_id::text AS "claimId", pick.claim_line_id::text AS "claimLineId",
      pick.claim_resource_id::text AS "claimResourceId", pick.claim_lot_allocation_id::text AS "claimLotAllocationId", pick.quantity::text,
      COALESCE((SELECT sum(reversal.quantity) FROM inventory.availability_claim_pick_movements reversal
        WHERE reversal.reverses_pick_movement_id=pick.id AND reversal.movement_type='unpick'),0)::text AS "reversedQuantity",
      COALESCE((SELECT sum(dispatch.quantity) FROM inventory.availability_claim_dispatch_movements dispatch
        WHERE dispatch.pick_movement_id=pick.id),0)::text AS "dispatchedQuantity"
    FROM inventory.availability_claim_pick_movements pick WHERE pick.claim_resource_id=ANY($1::bigint[]) AND pick.movement_type='pick'
    ORDER BY pick.id LIMIT $2 FOR UPDATE OF pick`, [resourceIds, MAX_ROWS + 1])).rows);
  return { claims, lines, resources, lots, picks };
}
