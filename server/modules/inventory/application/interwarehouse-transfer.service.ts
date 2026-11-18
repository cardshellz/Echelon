import { sql } from "drizzle-orm";
import { z } from "zod";

import { AppError, IntegrityError } from "@shared/errors";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  cancelInterwarehouseTransferSchema,
  createInterwarehouseTransferSchema,
  deriveInterwarehouseTransferStatus,
  receiveInterwarehouseTransferSchema,
  reconcileInterwarehouseTransferSchema,
  type InterwarehouseTransferSummary,
  type InterwarehouseTransferStatus,
} from "@shared/types/interwarehouse-transfer";
import { createHash, randomUUID } from "node:crypto";
import type { db } from "../../../db";
import {
  closeInterwarehouseTransitLocationInWarehouse,
  insertInterwarehouseTransitLocationInWarehouse,
} from "../../warehouse/cross-module-warehouse-mutations.api";
import type { InventoryUseCases } from "./inventory.use-cases";

type Database = Pick<typeof db, "transaction" | "execute">;
type Executor = Pick<typeof db, "execute">;
type EventType = "dispatched" | "received" | "reconciled" | "cancelled";

type LockedTransfer = {
  id: number;
  status: InterwarehouseTransferStatus;
  sourceWarehouseId: number;
  destinationWarehouseId: number;
  sourceLocationId: number;
  destinationLocationId: number;
  transitLocationId: number;
  productVariantId: number;
  requestedQty: number;
  dispatchedQty: number;
  receivedQty: number;
  damagedQty: number;
  lostQty: number;
  cancelledQty: number;
  revision: number;
};

type TransferFollowup = {
  eventId: number;
  transferId: number;
  eventType: EventType;
  productVariantId: number;
  sourceLocationId: number;
  destinationLocationId: number;
};

const actorSchema = z.string().trim().min(1).max(100);
const commandKeySchema = z.string().trim().min(8).max(120);
const positiveId = z.number().int().positive().max(2_147_483_647);

function integer(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new IntegrityError(`Invalid ${field} on inter-warehouse transfer`, { field, value });
  return parsed;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function iso(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new IntegrityError(`Invalid ${field} on inter-warehouse transfer`);
  return date.toISOString();
}

function nullableIso(value: unknown): string | null {
  if (value == null) return null;
  return iso(value, "timestamp");
}

function requestHash(operation: string, input: unknown): string {
  return createHash("sha256").update(canonicalJson({ operation, input })).digest("hex");
}

function requireCommandKey(value: string | undefined): string {
  return commandKeySchema.parse(value);
}

function terminal(status: InterwarehouseTransferStatus): boolean {
  return status === "completed" || status === "closed_with_variance" || status === "cancelled";
}

/**
 * Owns the two-leg physical custody lifecycle. Every command locks the transfer,
 * posts inventory/lot movements, updates workflow counters and appends immutable
 * event evidence inside one database transaction.
 */
export class InterwarehouseTransferService {
  constructor(
    private readonly database: Database,
    private readonly inventory: InventoryUseCases,
    private readonly effects: { deliver(event: TransferFollowup): Promise<void> },
    private readonly clock: () => Date,
  ) {}

  async createAndDispatch(rawInput: unknown, rawActor: string): Promise<InterwarehouseTransferSummary> {
    const input = createInterwarehouseTransferSchema.parse(rawInput);
    const actor = actorSchema.parse(rawActor);
    const commandKey = requireCommandKey(input.commandKey);
    const hash = requestHash("interwarehouse_transfer.dispatch", input);
    const occurredAt = z.date().parse(this.clock());
    let eventId = 0;

    const transferId = await this.database.transaction(async (tx) => {
      await this.lockCommand(tx, commandKey);
      const existing = await tx.execute(sql`
        SELECT id, request_hash FROM inventory.interwarehouse_transfers
        WHERE create_command_key=${commandKey} FOR UPDATE
      `);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== hash) {
          throw new AppError("This idempotency key was already used for a different transfer.", "INTERWAREHOUSE_COMMAND_CONFLICT", 409);
        }
        const existingEvent = await tx.execute(sql`
          SELECT id FROM inventory.interwarehouse_transfer_events
          WHERE transfer_id=${integer(existing.rows[0].id, "transfer id")} AND command_key=${commandKey}
        `);
        if (!existingEvent.rows[0]) throw new IntegrityError("Committed transfer is missing its dispatch event");
        eventId = integer(existingEvent.rows[0].id, "event id");
        return integer(existing.rows[0].id, "transfer id");
      }

      const route = await tx.execute(sql`
        SELECT
          source.id AS source_location_id, source.warehouse_id AS source_warehouse_id,
          source.is_active AS source_active, source.location_type AS source_type,
          destination.id AS destination_location_id, destination.warehouse_id AS destination_warehouse_id,
          destination.is_active AS destination_active, destination.location_type AS destination_type,
          source_warehouse.is_active AS source_warehouse_active,
          source_warehouse.warehouse_type AS source_warehouse_type,
          destination_warehouse.is_active AS destination_warehouse_active,
          destination_warehouse.warehouse_type AS destination_warehouse_type
        FROM warehouse.warehouse_locations source
        JOIN warehouse.warehouses source_warehouse ON source_warehouse.id=source.warehouse_id
        JOIN warehouse.warehouse_locations destination ON destination.id=${input.toLocationId}
        JOIN warehouse.warehouses destination_warehouse ON destination_warehouse.id=destination.warehouse_id
        WHERE source.id=${input.fromLocationId}
        FOR SHARE OF source, destination, source_warehouse, destination_warehouse
      `);
      const location = route.rows[0];
      if (!location) throw new AppError("Source or destination location was not found.", "INTERWAREHOUSE_LOCATION_NOT_FOUND", 400);
      const sourceWarehouseId = integer(location.source_warehouse_id, "source warehouse id");
      const destinationWarehouseId = integer(location.destination_warehouse_id, "destination warehouse id");
      if (sourceWarehouseId === destinationWarehouseId) {
        throw new AppError("Use a bin move for locations in the same warehouse.", "INTERWAREHOUSE_ROUTE_NOT_REQUIRED", 409);
      }
      if (location.source_active !== 1 || location.destination_active !== 1 ||
          location.source_warehouse_active !== 1 || location.destination_warehouse_active !== 1 ||
          location.source_type === "in_transit" || location.destination_type === "in_transit" ||
          location.source_warehouse_type === "system_transit" || location.destination_warehouse_type === "system_transit") {
        throw new AppError("Choose active physical warehouse locations.", "INTERWAREHOUSE_ROUTE_UNAVAILABLE", 409);
      }
      const transitWarehouse = await tx.execute(sql`
        SELECT id FROM warehouse.warehouses
        WHERE code='SYSTEM-TRANSIT' AND warehouse_type='system_transit' AND is_active=1
        FOR SHARE
      `);
      if (!transitWarehouse.rows[0]) {
        throw new AppError("The in-transit custody warehouse is not configured.", "INTERWAREHOUSE_TRANSIT_NOT_CONFIGURED", 503);
      }

      const inserted = await tx.execute(sql`
        INSERT INTO inventory.interwarehouse_transfers(
          create_command_key,request_hash,source_warehouse_id,destination_warehouse_id,
          source_location_id,destination_location_id,status,notes,created_by,created_at,updated_at
        ) VALUES (
          ${commandKey},${hash},${sourceWarehouseId},${destinationWarehouseId},
          ${input.fromLocationId},${input.toLocationId},'ready',${input.notes ?? null},${actor},${occurredAt},${occurredAt}
        ) RETURNING id
      `);
      const id = integer(inserted.rows[0]?.id, "transfer id");
      const transitCode = `IWT-${String(id).padStart(8, "0")}`;
      const transitLocationId = integer(await insertInterwarehouseTransitLocationInWarehouse(tx, {
        warehouseId: integer(transitWarehouse.rows[0].id, "transit warehouse id"),
        code: transitCode,
        name: `Transit custody for WT-${String(id).padStart(8, "0")}`,
        occurredAt,
      }), "transit location id");
      await tx.execute(sql`UPDATE inventory.interwarehouse_transfers SET transit_location_id=${transitLocationId} WHERE id=${id}`);
      await tx.execute(sql`
        INSERT INTO inventory.interwarehouse_transfer_lines(transfer_id,product_variant_id,requested_qty)
        VALUES (${id},${input.variantId},${input.quantity})
      `);

      const movement = await this.inventory.withTx(tx).transfer({
        commandKey: `${commandKey}:dispatch`,
        productVariantId: input.variantId,
        fromLocationId: input.fromLocationId,
        toLocationId: transitLocationId,
        qty: input.quantity,
        userId: actor,
        notes: input.notes || `Dispatched ${transitCode}`,
        referenceType: "interwarehouse_transfer",
        referenceId: `${id}:dispatch`,
        interwarehouseTransfer: { transferId: id, stage: "dispatch" },
        deferUntilCommit: () => { /* durable event follow-up owns publication */ },
      });
      if (!movement.transferReceiptId) throw new IntegrityError("Dispatch did not produce physical movement evidence", { transferId: id });

      await tx.execute(sql`
        UPDATE inventory.interwarehouse_transfer_lines SET dispatched_qty=${input.quantity} WHERE transfer_id=${id}
      `);
      await tx.execute(sql`
        UPDATE inventory.interwarehouse_transfers SET status='in_transit',dispatched_by=${actor},
          dispatched_at=${occurredAt},updated_at=${occurredAt},revision=revision+1 WHERE id=${id}
      `);
      const event = await tx.execute(sql`
        INSERT INTO inventory.interwarehouse_transfer_events(
          transfer_id,event_type,command_key,request_hash,quantity,inventory_transaction_id,actor,detail,occurred_at
        ) VALUES (
          ${id},'dispatched',${commandKey},${hash},${input.quantity},${movement.transferReceiptId},${actor},
          ${JSON.stringify({ notes: input.notes ?? null })}::jsonb,${occurredAt}
        ) RETURNING id
      `);
      eventId = integer(event.rows[0]?.id, "event id");
      return id;
    });

    const delivered = eventId > 0 ? await this.recoverEvent(eventId) : false;
    return { ...(await this.getById(transferId)), followupPending: !delivered };
  }

  async receive(transferIdInput: number, rawInput: unknown, rawActor: string): Promise<InterwarehouseTransferSummary> {
    const transferId = positiveId.parse(transferIdInput);
    const input = receiveInterwarehouseTransferSchema.parse(rawInput);
    const actor = actorSchema.parse(rawActor);
    const commandKey = requireCommandKey(input.commandKey);
    const hash = requestHash("interwarehouse_transfer.receive", { transferId, ...input });
    const occurredAt = z.date().parse(this.clock());
    let eventId = 0;

    await this.database.transaction(async (tx) => {
      await this.lockCommand(tx, commandKey);
      const duplicate = await this.findEvent(tx, commandKey, transferId, "received", hash);
      if (duplicate) { eventId = duplicate; return; }
      const current = await this.loadLocked(tx, transferId);
      if (terminal(current.status)) throw new AppError("This transfer is already closed.", "INTERWAREHOUSE_TRANSFER_CLOSED", 409);
      const inTransit = current.dispatchedQty - current.receivedQty - current.damagedQty - current.lostQty;
      const accountedNow = input.quantity + input.damagedQuantity;
      if (accountedNow > inTransit) {
        throw new AppError(`Only ${inTransit} unit(s) remain in transit.`, "INTERWAREHOUSE_RECEIPT_EXCEEDS_TRANSIT", 409, { inTransitQuantity: inTransit });
      }

      let receiptId: number | null = null;
      let adjustmentId: number | null = null;
      if (input.quantity > 0) {
        const movement = await this.inventory.withTx(tx).transfer({
          commandKey: `${commandKey}:receive`,
          productVariantId: current.productVariantId,
          fromLocationId: current.transitLocationId,
          toLocationId: current.destinationLocationId,
          qty: input.quantity,
          userId: actor,
          notes: input.notes || `Received WT-${String(transferId).padStart(8, "0")}`,
          referenceType: "interwarehouse_transfer",
          referenceId: `${transferId}:receive:${commandKey}`,
          interwarehouseTransfer: { transferId, stage: "receive" },
          deferUntilCommit: () => { /* durable event follow-up owns publication */ },
        });
        receiptId = movement.transferReceiptId;
        if (!receiptId) throw new IntegrityError("Receipt did not produce physical movement evidence", { transferId });
      }
      if (input.damagedQuantity > 0) {
        const adjustment = await this.inventory.withTx(tx).adjustInventory({
          commandKey: `${commandKey}:damage`,
          productVariantId: current.productVariantId,
          warehouseLocationId: current.transitLocationId,
          qtyDelta: -input.damagedQuantity,
          reason: `Damaged during inter-warehouse transfer: ${input.notes}`,
          userId: actor,
          deferUntilCommit: () => { /* durable event follow-up owns publication */ },
        });
        adjustmentId = adjustment.adjustmentTransactionId;
      }

      const next = {
        ...current,
        receivedQty: current.receivedQty + input.quantity,
        damagedQty: current.damagedQty + input.damagedQuantity,
      };
      const status = deriveInterwarehouseTransferStatus({
        requestedQuantity: next.requestedQty,
        dispatchedQuantity: next.dispatchedQty,
        receivedQuantity: next.receivedQty,
        damagedQuantity: next.damagedQty,
        lostQuantity: next.lostQty,
        cancelledQuantity: next.cancelledQty,
        exceptionOpen: input.damagedQuantity > 0,
      });
      const isClosed = terminal(status);
      await tx.execute(sql`
        UPDATE inventory.interwarehouse_transfer_lines SET
          received_qty=received_qty+${input.quantity},damaged_qty=damaged_qty+${input.damagedQuantity}
        WHERE transfer_id=${transferId}
      `);
      await tx.execute(sql`
        UPDATE inventory.interwarehouse_transfers SET status=${status},
          exception_notes=CASE WHEN ${input.damagedQuantity} > 0 THEN
            concat_ws(E'\n',NULLIF(exception_notes,''),${input.notes ?? "Damaged inventory reported"}) ELSE exception_notes END,
          completed_by=CASE WHEN ${isClosed} THEN ${actor} ELSE completed_by END,
          completed_at=CASE WHEN ${isClosed} THEN ${occurredAt} ELSE completed_at END,
          updated_at=${occurredAt},revision=revision+1 WHERE id=${transferId}
      `);
      if (isClosed) await this.closeTransitLocation(tx, current.transitLocationId, occurredAt);
      const event = await tx.execute(sql`
        INSERT INTO inventory.interwarehouse_transfer_events(
          transfer_id,event_type,command_key,request_hash,quantity,damaged_quantity,inventory_transaction_id,adjustment_transaction_id,actor,detail,occurred_at
        ) VALUES (
          ${transferId},'received',${commandKey},${hash},${input.quantity},${input.damagedQuantity},${receiptId},${adjustmentId},${actor},
          ${JSON.stringify({ notes: input.notes ?? null })}::jsonb,${occurredAt}
        ) RETURNING id
      `);
      eventId = integer(event.rows[0]?.id, "event id");
    });

    const delivered = eventId > 0 ? await this.recoverEvent(eventId) : false;
    return { ...(await this.getById(transferId)), followupPending: !delivered };
  }

  async reconcileMissing(transferIdInput: number, rawInput: unknown, rawActor: string): Promise<InterwarehouseTransferSummary> {
    const transferId = positiveId.parse(transferIdInput);
    const input = reconcileInterwarehouseTransferSchema.parse(rawInput);
    const actor = actorSchema.parse(rawActor);
    const commandKey = requireCommandKey(input.commandKey);
    const hash = requestHash("interwarehouse_transfer.reconcile", { transferId, ...input });
    const occurredAt = z.date().parse(this.clock());
    let eventId = 0;

    await this.database.transaction(async (tx) => {
      await this.lockCommand(tx, commandKey);
      const duplicate = await this.findEvent(tx, commandKey, transferId, "reconciled", hash);
      if (duplicate) { eventId = duplicate; return; }
      const current = await this.loadLocked(tx, transferId);
      if (terminal(current.status)) throw new AppError("This transfer is already closed.", "INTERWAREHOUSE_TRANSFER_CLOSED", 409);
      const inTransit = current.dispatchedQty - current.receivedQty - current.damagedQty - current.lostQty;
      if (input.quantity > inTransit) {
        throw new AppError(`Only ${inTransit} unit(s) remain in transit.`, "INTERWAREHOUSE_RECONCILIATION_EXCEEDS_TRANSIT", 409, { inTransitQuantity: inTransit });
      }
      const adjustment = await this.inventory.withTx(tx).adjustInventory({
        commandKey: `${commandKey}:missing`,
        productVariantId: current.productVariantId,
        warehouseLocationId: current.transitLocationId,
        qtyDelta: -input.quantity,
        reason: `Inter-warehouse transfer loss: ${input.reason}`,
        userId: actor,
        deferUntilCommit: () => { /* durable event follow-up owns publication */ },
      });
      const nextLost = current.lostQty + input.quantity;
      const status = deriveInterwarehouseTransferStatus({
        requestedQuantity: current.requestedQty,
        dispatchedQuantity: current.dispatchedQty,
        receivedQuantity: current.receivedQty,
        damagedQuantity: current.damagedQty,
        lostQuantity: nextLost,
        cancelledQuantity: current.cancelledQty,
        exceptionOpen: true,
      });
      const isClosed = terminal(status);
      await tx.execute(sql`UPDATE inventory.interwarehouse_transfer_lines SET lost_qty=${nextLost} WHERE transfer_id=${transferId}`);
      await tx.execute(sql`
        UPDATE inventory.interwarehouse_transfers SET status=${status},
          exception_notes=concat_ws(E'\n',NULLIF(exception_notes,''),${input.reason}),
          completed_by=CASE WHEN ${isClosed} THEN ${actor} ELSE completed_by END,
          completed_at=CASE WHEN ${isClosed} THEN ${occurredAt} ELSE completed_at END,
          updated_at=${occurredAt},revision=revision+1 WHERE id=${transferId}
      `);
      if (isClosed) await this.closeTransitLocation(tx, current.transitLocationId, occurredAt);
      const event = await tx.execute(sql`
        INSERT INTO inventory.interwarehouse_transfer_events(
          transfer_id,event_type,command_key,request_hash,quantity,adjustment_transaction_id,actor,detail,occurred_at
        ) VALUES (${transferId},'reconciled',${commandKey},${hash},${input.quantity},${adjustment.adjustmentTransactionId},${actor},
          ${JSON.stringify({ reason: input.reason })}::jsonb,${occurredAt}) RETURNING id
      `);
      eventId = integer(event.rows[0]?.id, "event id");
    });

    const delivered = eventId > 0 ? await this.recoverEvent(eventId) : false;
    return { ...(await this.getById(transferId)), followupPending: !delivered };
  }

  async cancel(transferIdInput: number, rawInput: unknown, rawActor: string): Promise<InterwarehouseTransferSummary> {
    const transferId = positiveId.parse(transferIdInput);
    const input = cancelInterwarehouseTransferSchema.parse(rawInput);
    const actor = actorSchema.parse(rawActor);
    const commandKey = requireCommandKey(input.commandKey);
    const hash = requestHash("interwarehouse_transfer.cancel", { transferId, ...input });
    const occurredAt = z.date().parse(this.clock());
    let eventId = 0;

    await this.database.transaction(async (tx) => {
      await this.lockCommand(tx, commandKey);
      const duplicate = await this.findEvent(tx, commandKey, transferId, "cancelled", hash);
      if (duplicate) { eventId = duplicate; return; }
      const current = await this.loadLocked(tx, transferId);
      if (terminal(current.status)) throw new AppError("This transfer is already closed.", "INTERWAREHOUSE_TRANSFER_CLOSED", 409);
      const inTransit = current.dispatchedQty - current.receivedQty - current.damagedQty - current.lostQty;
      if (inTransit > 0) {
        throw new AppError("Receive or reconcile all in-transit stock before closing the remaining request.", "INTERWAREHOUSE_TRANSFER_HAS_TRANSIT_STOCK", 409, { inTransitQuantity: inTransit });
      }
      const cancelledQty = current.requestedQty - current.dispatchedQty;
      const status: InterwarehouseTransferStatus = current.dispatchedQty === 0 ? "cancelled" : "closed_with_variance";
      await tx.execute(sql`UPDATE inventory.interwarehouse_transfer_lines SET cancelled_qty=${cancelledQty} WHERE transfer_id=${transferId}`);
      await tx.execute(sql`
        UPDATE inventory.interwarehouse_transfers SET status=${status},cancelled_by=${actor},cancelled_at=${occurredAt},
          completed_by=${actor},completed_at=${occurredAt},exception_notes=concat_ws(E'\n',NULLIF(exception_notes,''),${input.reason}),
          updated_at=${occurredAt},revision=revision+1 WHERE id=${transferId}
      `);
      await this.closeTransitLocation(tx, current.transitLocationId, occurredAt);
      const event = await tx.execute(sql`
        INSERT INTO inventory.interwarehouse_transfer_events(
          transfer_id,event_type,command_key,request_hash,actor,detail,occurred_at
        ) VALUES (${transferId},'cancelled',${commandKey},${hash},${actor},
          ${JSON.stringify({ reason: input.reason, cancelledQuantity: cancelledQty })}::jsonb,${occurredAt}) RETURNING id
      `);
      eventId = integer(event.rows[0]?.id, "event id");
    });

    const delivered = eventId > 0 ? await this.recoverEvent(eventId) : false;
    return { ...(await this.getById(transferId)), followupPending: !delivered };
  }

  async list(limitInput = 50): Promise<InterwarehouseTransferSummary[]> {
    const limit = z.number().int().min(1).max(200).parse(limitInput);
    const rows = await this.database.execute(this.summaryQuery(sql`TRUE`, sql`${limit}`));
    return rows.rows.map((row) => this.mapSummary(row));
  }

  async getById(transferIdInput: number): Promise<InterwarehouseTransferSummary> {
    const transferId = positiveId.parse(transferIdInput);
    const rows = await this.database.execute(this.summaryQuery(sql`t.id=${transferId}`, sql`1`));
    if (!rows.rows[0]) throw new AppError("Inter-warehouse transfer not found.", "INTERWAREHOUSE_TRANSFER_NOT_FOUND", 404);
    return this.mapSummary(rows.rows[0]);
  }

  async recoverPending(): Promise<void> {
    const result = await this.database.execute(sql`
      SELECT id FROM inventory.interwarehouse_transfer_events
      WHERE effects_completed_at IS NULL
        AND (effects_claimed_at IS NULL OR effects_claimed_at < transaction_timestamp() - interval '5 minutes')
      ORDER BY occurred_at,id LIMIT 20
    `);
    for (const row of result.rows) await this.recoverEvent(integer(row.id, "event id"));
  }

  private async recoverEvent(eventId: number): Promise<boolean> {
    const claimToken = randomUUID();
    try {
      const result = await this.database.execute(sql`
        WITH claimed AS (
          UPDATE inventory.interwarehouse_transfer_events
          SET effects_claim_token=${claimToken},effects_claimed_at=transaction_timestamp()
          WHERE id=${eventId} AND effects_completed_at IS NULL
            AND (effects_claimed_at IS NULL OR effects_claimed_at < transaction_timestamp() - interval '5 minutes')
          RETURNING *
        )
        SELECT event.id,event.transfer_id,event.event_type,event.effects_completed_at,
          line.product_variant_id,transfer.source_location_id,transfer.destination_location_id
        FROM claimed event
        JOIN inventory.interwarehouse_transfers transfer ON transfer.id=event.transfer_id
        JOIN inventory.interwarehouse_transfer_lines line ON line.transfer_id=transfer.id
      `);
      const row = result.rows[0];
      if (!row) {
        const current = await this.database.execute(sql`
          SELECT effects_completed_at FROM inventory.interwarehouse_transfer_events WHERE id=${eventId}
        `);
        if (!current.rows[0]) throw new IntegrityError("Inter-warehouse transfer follow-up event is missing", { eventId });
        return current.rows[0].effects_completed_at != null;
      }
      await this.effects.deliver({
        eventId,
        transferId: integer(row.transfer_id, "transfer id"),
        eventType: z.enum(["dispatched", "received", "reconciled", "cancelled"]).parse(row.event_type),
        productVariantId: integer(row.product_variant_id, "variant id"),
        sourceLocationId: integer(row.source_location_id, "source location id"),
        destinationLocationId: integer(row.destination_location_id, "destination location id"),
      });
      const completed = await this.database.execute(sql`
        UPDATE inventory.interwarehouse_transfer_events
        SET effects_completed_at=transaction_timestamp(),effects_claim_token=NULL,effects_claimed_at=NULL,last_error=NULL
        WHERE id=${eventId} AND effects_completed_at IS NULL AND effects_claim_token=${claimToken}
        RETURNING id
      `);
      return completed.rows.length === 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database.execute(sql`
        UPDATE inventory.interwarehouse_transfer_events SET last_error=${message.slice(0, 2000)},
          effects_claim_token=NULL,effects_claimed_at=NULL
        WHERE id=${eventId} AND effects_completed_at IS NULL AND effects_claim_token=${claimToken}
      `).catch(() => undefined);
      console.error(JSON.stringify({ event: "interwarehouse_transfer_followup_pending", eventId, message }));
      return false;
    }
  }

  private async findEvent(tx: Executor, commandKey: string, transferId: number, eventType: EventType, hash: string): Promise<number | null> {
    const result = await tx.execute(sql`
      SELECT id,transfer_id,event_type,request_hash FROM inventory.interwarehouse_transfer_events
      WHERE command_key=${commandKey} FOR UPDATE
    `);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    if (integer(row.transfer_id, "transfer id") !== transferId || row.event_type !== eventType || row.request_hash !== hash) {
      throw new AppError("This idempotency key was already used for a different transfer action.", "INTERWAREHOUSE_COMMAND_CONFLICT", 409);
    }
    return integer(row.id, "event id");
  }

  private async lockCommand(tx: Executor, commandKey: string): Promise<void> {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`interwarehouse_transfer:${commandKey}`}, 0))
    `);
  }

  private async closeTransitLocation(tx: Executor, transitLocationId: number, occurredAt: Date): Promise<void> {
    const closed = await closeInterwarehouseTransitLocationInWarehouse(tx, { transitLocationId, occurredAt });
    if (!closed) {
      throw new IntegrityError("Transfer transit custody could not be closed", { transitLocationId });
    }
  }

  private async loadLocked(tx: Executor, transferId: number): Promise<LockedTransfer> {
    const result = await tx.execute(sql`
      SELECT transfer.id,transfer.status,transfer.source_warehouse_id,transfer.destination_warehouse_id,
        transfer.source_location_id,transfer.destination_location_id,transfer.transit_location_id,transfer.revision,
        line.product_variant_id,line.requested_qty,line.dispatched_qty,line.received_qty,line.damaged_qty,line.lost_qty,line.cancelled_qty
      FROM inventory.interwarehouse_transfers transfer
      JOIN inventory.interwarehouse_transfer_lines line ON line.transfer_id=transfer.id
      WHERE transfer.id=${transferId}
      FOR UPDATE OF transfer,line
    `);
    const row = result.rows[0];
    if (!row) throw new AppError("Inter-warehouse transfer not found.", "INTERWAREHOUSE_TRANSFER_NOT_FOUND", 404);
    if (row.transit_location_id == null) throw new IntegrityError("Transfer has no isolated transit custody", { transferId });
    return {
      id: transferId,
      status: z.enum(["ready","in_transit","partially_received","exception","completed","closed_with_variance","cancelled"]).parse(row.status),
      sourceWarehouseId: integer(row.source_warehouse_id, "source warehouse id"),
      destinationWarehouseId: integer(row.destination_warehouse_id, "destination warehouse id"),
      sourceLocationId: integer(row.source_location_id, "source location id"),
      destinationLocationId: integer(row.destination_location_id, "destination location id"),
      transitLocationId: integer(row.transit_location_id, "transit location id"),
      productVariantId: integer(row.product_variant_id, "variant id"),
      requestedQty: integer(row.requested_qty, "requested quantity"),
      dispatchedQty: integer(row.dispatched_qty, "dispatched quantity"),
      receivedQty: integer(row.received_qty, "received quantity"),
      damagedQty: integer(row.damaged_qty, "damaged quantity"),
      lostQty: integer(row.lost_qty, "lost quantity"),
      cancelledQty: integer(row.cancelled_qty, "cancelled quantity"),
      revision: integer(row.revision, "revision"),
    };
  }

  private summaryQuery(where: ReturnType<typeof sql>, limit: ReturnType<typeof sql>) {
    return sql`
      SELECT t.id,t.status,t.source_warehouse_id,t.destination_warehouse_id,t.source_location_id,
        t.destination_location_id,t.transit_location_id,t.notes,t.exception_notes,t.created_by,t.dispatched_by,
        t.created_at,t.dispatched_at,t.completed_at,t.updated_at,t.revision,
        source_warehouse.code AS source_warehouse_code,source_warehouse.name AS source_warehouse_name,
        destination_warehouse.code AS destination_warehouse_code,destination_warehouse.name AS destination_warehouse_name,
        source_location.code AS source_location_code,destination_location.code AS destination_location_code,
        line.product_variant_id,line.requested_qty,line.dispatched_qty,line.received_qty,line.damaged_qty,line.lost_qty,line.cancelled_qty,
        variant.sku,variant.name AS product_name
      FROM inventory.interwarehouse_transfers t
      JOIN inventory.interwarehouse_transfer_lines line ON line.transfer_id=t.id
      JOIN warehouse.warehouses source_warehouse ON source_warehouse.id=t.source_warehouse_id
      JOIN warehouse.warehouses destination_warehouse ON destination_warehouse.id=t.destination_warehouse_id
      JOIN warehouse.warehouse_locations source_location ON source_location.id=t.source_location_id
      JOIN warehouse.warehouse_locations destination_location ON destination_location.id=t.destination_location_id
      JOIN catalog.product_variants variant ON variant.id=line.product_variant_id
      WHERE ${where}
      ORDER BY t.updated_at DESC,t.id DESC LIMIT ${limit}
    `;
  }

  private mapSummary(row: Record<string, unknown>): InterwarehouseTransferSummary {
    const dispatched = integer(row.dispatched_qty, "dispatched quantity");
    const received = integer(row.received_qty, "received quantity");
    const damaged = integer(row.damaged_qty, "damaged quantity");
    const lost = integer(row.lost_qty, "lost quantity");
    const id = integer(row.id, "transfer id");
    return {
      id,
      transferNumber: `WT-${String(id).padStart(8, "0")}`,
      status: z.enum(["ready","in_transit","partially_received","exception","completed","closed_with_variance","cancelled"]).parse(row.status),
      sourceWarehouseId: integer(row.source_warehouse_id, "source warehouse id"),
      sourceWarehouseCode: String(row.source_warehouse_code),
      sourceWarehouseName: String(row.source_warehouse_name),
      destinationWarehouseId: integer(row.destination_warehouse_id, "destination warehouse id"),
      destinationWarehouseCode: String(row.destination_warehouse_code),
      destinationWarehouseName: String(row.destination_warehouse_name),
      sourceLocationId: integer(row.source_location_id, "source location id"),
      sourceLocationCode: String(row.source_location_code),
      destinationLocationId: integer(row.destination_location_id, "destination location id"),
      destinationLocationCode: String(row.destination_location_code),
      transitLocationId: integer(row.transit_location_id, "transit location id"),
      variantId: integer(row.product_variant_id, "variant id"),
      sku: String(row.sku ?? ""),
      productName: String(row.product_name ?? ""),
      requestedQuantity: integer(row.requested_qty, "requested quantity"),
      dispatchedQuantity: dispatched,
      receivedQuantity: received,
      damagedQuantity: damaged,
      lostQuantity: lost,
      cancelledQuantity: integer(row.cancelled_qty, "cancelled quantity"),
      inTransitQuantity: dispatched - received - damaged - lost,
      notes: nullableText(row.notes),
      exceptionNotes: nullableText(row.exception_notes),
      createdBy: String(row.created_by),
      dispatchedBy: nullableText(row.dispatched_by),
      createdAt: iso(row.created_at, "created at"),
      dispatchedAt: nullableIso(row.dispatched_at),
      completedAt: nullableIso(row.completed_at),
      updatedAt: iso(row.updated_at, "updated at"),
      revision: integer(row.revision, "revision"),
    };
  }
}
