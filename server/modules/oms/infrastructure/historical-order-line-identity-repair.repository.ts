import { and, eq, inArray, or, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";

import {
  omsHistoricalLineIdentityRepairCommands,
  omsOrderEvents,
  omsOrderLines,
  omsOrders,
  webhookInbox,
  wmsOrderItems,
  wmsOrders,
} from "@shared/schema";
import { updateWmsOrderItemCatalogSnapshot } from "../../wms/order-item-commands";
import {
  HistoricalIdentityRepairError,
  type HistoricalIdentityRepairCommandRecord,
  type HistoricalIdentityRepairLineChange,
  type HistoricalIdentityRepairPreparedResult,
  type HistoricalRepairOrderAggregate,
  type HistoricalRepairSourceLineIdentity,
} from "../domain/historical-order-line-identity-repair";
import type { ResolvedOrderLineIdentity } from "../domain/order-line-catalog-identity";
import { resolveAssignedBinLocation } from "../wms-sync.service";
import {
  recordOrderLineCatalogIdentity,
  resolveOrderLineCatalogIdentity,
} from "../order-line-catalog-identity.service";

const MAX_ORDER_LINES = 500;

type EchelonSchema = typeof import("@shared/schema");
export type HistoricalIdentityRepairDatabase =
  | NodePgDatabase<EchelonSchema>
  | NodePgTransaction<EchelonSchema, ExtractTablesWithRelations<EchelonSchema>>;

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HistoricalIdentityRepairError(
      "REPAIR_EVIDENCE_INVALID",
      `${field} is not a positive integer`,
      500,
      { field },
    );
  }
  return parsed;
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return positiveInteger(value, field);
}

function parseTargetLineIds(value: unknown): readonly number[] {
  if (!Array.isArray(value)) {
    throw new HistoricalIdentityRepairError(
      "REPAIR_COMMAND_CORRUPT",
      "Persisted repair command target lines are invalid",
      500,
    );
  }
  const ids = value.map((item, index) => positiveInteger(item, `targetOmsLineIds[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new HistoricalIdentityRepairError(
      "REPAIR_COMMAND_CORRUPT",
      "Persisted repair command contains duplicate target lines",
      500,
    );
  }
  return Object.freeze(ids);
}

function parsePreparedResult(value: unknown): HistoricalIdentityRepairPreparedResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HistoricalIdentityRepairError(
      "REPAIR_COMMAND_CORRUPT",
      "Persisted repair result is invalid",
      500,
    );
  }
  const record = value as Record<string, unknown>;
  if (record.contractVersion !== 1 || typeof record.previewHash !== "string"
      || !/^[0-9a-f]{64}$/.test(record.previewHash) || !Array.isArray(record.repairedLines)) {
    throw new HistoricalIdentityRepairError(
      "REPAIR_COMMAND_CORRUPT",
      "Persisted repair result contract is invalid",
      500,
    );
  }
  const repairedLines = record.repairedLines.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HistoricalIdentityRepairError(
        "REPAIR_COMMAND_CORRUPT",
        `Persisted repaired line ${index} is invalid`,
        500,
      );
    }
    const line = raw as Record<string, unknown>;
    const previousOmsVariantId = nullableInteger(line.previousOmsVariantId, "previousOmsVariantId");
    const previousWmsVariantId = nullableInteger(line.previousWmsVariantId, "previousWmsVariantId");
    if (typeof line.previousWmsSku !== "string" || typeof line.catalogSku !== "string") {
      throw new HistoricalIdentityRepairError(
        "REPAIR_COMMAND_CORRUPT",
        `Persisted repaired line ${index} SKU evidence is invalid`,
        500,
      );
    }
    return Object.freeze({
      omsOrderLineId: positiveInteger(line.omsOrderLineId, "omsOrderLineId"),
      wmsOrderItemId: positiveInteger(line.wmsOrderItemId, "wmsOrderItemId"),
      previousOmsVariantId,
      productVariantId: positiveInteger(line.productVariantId, "productVariantId"),
      previousWmsVariantId,
      previousWmsSku: line.previousWmsSku,
      catalogSku: line.catalogSku,
    });
  });
  return Object.freeze({
    contractVersion: 1,
    omsOrderId: positiveInteger(record.omsOrderId, "omsOrderId"),
    wmsOrderId: positiveInteger(record.wmsOrderId, "wmsOrderId"),
    previewHash: record.previewHash,
    repairedLines: Object.freeze(repairedLines),
  });
}

function parseCommand(row: typeof omsHistoricalLineIdentityRepairCommands.$inferSelect): HistoricalIdentityRepairCommandRecord {
  const status = String(row.status);
  if (status !== "claim_pending" && status !== "succeeded" && status !== "failed") {
    throw new HistoricalIdentityRepairError(
      "REPAIR_COMMAND_CORRUPT",
      `Persisted repair command has unsupported status ${status}`,
      500,
      { commandId: row.id },
    );
  }
  const targetOmsLineIds = parseTargetLineIds(row.targetOmsLineIds);
  const repairResult = parsePreparedResult(row.repairResult);
  const repairedLineIds = repairResult.repairedLines.map((line) => line.omsOrderLineId);
  if (repairResult.omsOrderId !== Number(row.omsOrderId)
      || repairResult.wmsOrderId !== row.wmsOrderId
      || repairResult.previewHash !== row.previewHash
      || JSON.stringify(repairedLineIds) !== JSON.stringify(targetOmsLineIds)) {
    throw new HistoricalIdentityRepairError(
      "REPAIR_COMMAND_CORRUPT",
      "Persisted repair command and repair result disagree",
      500,
      { commandId: row.id },
    );
  }
  return Object.freeze({
    id: positiveInteger(row.id, "commandId"),
    omsOrderId: positiveInteger(row.omsOrderId, "omsOrderId"),
    wmsOrderId: positiveInteger(row.wmsOrderId, "wmsOrderId"),
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    previewHash: row.previewHash,
    operator: row.operator,
    reason: row.reason,
    status,
    targetOmsLineIds,
    repairResult,
    claimResult: row.claimResult,
    lastErrorCode: row.lastErrorCode,
    lastError: row.lastError,
  });
}

export interface HistoricalIdentityRepairCommandInsert {
  readonly omsOrderId: number;
  readonly wmsOrderId: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly previewHash: string;
  readonly operator: string;
  readonly reason: string;
  readonly targetOmsLineIds: readonly number[];
  readonly repairResult: HistoricalIdentityRepairPreparedResult;
  readonly now: Date;
}

export interface HistoricalIdentityRepairRepository {
  transaction<T>(work: (repository: HistoricalIdentityRepairRepository) => Promise<T>): Promise<T>;
  acquireOrderLock(omsOrderId: number): Promise<void>;
  loadOrderEvidence(omsOrderId: number, lock: boolean): Promise<HistoricalRepairOrderAggregate | null>;
  resolveIdentity(input: {
    channelId: number;
    externalVariantId: string;
    externalProductId: string;
    sku: string | null;
    previousVariantId: number | null;
  }): Promise<ResolvedOrderLineIdentity | null>;
  repairLine(input: {
    orderId: number;
    channelId: number;
    omsOrderLineId: number;
    wmsOrderItemId: number;
    previousOmsVariantId: number | null;
    previousWmsVariantId: number | null;
    previousWmsSku: string;
    identity: ResolvedOrderLineIdentity;
    source: HistoricalRepairSourceLineIdentity;
    sourceEventId: string;
    now: Date;
  }): Promise<HistoricalIdentityRepairLineChange>;
  findCommand(idempotencyKey: string, lock: boolean): Promise<HistoricalIdentityRepairCommandRecord | null>;
  findCommandById(commandId: number): Promise<HistoricalIdentityRepairCommandRecord | null>;
  insertCommand(input: HistoricalIdentityRepairCommandInsert): Promise<HistoricalIdentityRepairCommandRecord | null>;
  recordPreparedEvent(input: {
    orderId: number;
    commandId: number;
    operator: string;
    reason: string;
    idempotencyKey: string;
    prepared: HistoricalIdentityRepairPreparedResult;
  }): Promise<void>;
  markCommandSucceeded(commandId: number, claimResult: unknown, completedAt: Date): Promise<HistoricalIdentityRepairCommandRecord>;
  markCommandFailed(commandId: number, errorCode: string, message: string, failedAt: Date): Promise<void>;
  recordClaimEvent(input: {
    orderId: number;
    commandId: number;
    initiatedBy: string;
    reconciledBy: string;
    sourceEventId: string;
    claimResult: unknown;
  }): Promise<void>;
}

export function createHistoricalIdentityRepairRepository(
  database: HistoricalIdentityRepairDatabase,
): HistoricalIdentityRepairRepository {
  const findCommandById = async (commandId: number): Promise<HistoricalIdentityRepairCommandRecord | null> => {
    const [row] = await database.select().from(omsHistoricalLineIdentityRepairCommands)
      .where(eq(omsHistoricalLineIdentityRepairCommands.id, commandId)).limit(1);
    return row ? parseCommand(row) : null;
  };

  return {
    async transaction<T>(work: (repository: HistoricalIdentityRepairRepository) => Promise<T>): Promise<T> {
      if (typeof database.transaction !== "function") {
        throw new HistoricalIdentityRepairError(
          "REPAIR_TRANSACTION_UNAVAILABLE",
          "Historical identity repair requires a database transaction",
          503,
        );
      }
      return database.transaction((tx) => work(createHistoricalIdentityRepairRepository(tx)));
    },

    async acquireOrderLock(omsOrderId: number): Promise<void> {
      await database.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`oms-historical-line-identity-repair:${omsOrderId}`}, 0)
        )
      `);
    },

    async loadOrderEvidence(omsOrderId: number, lock: boolean): Promise<HistoricalRepairOrderAggregate | null> {
      const orderQuery = database.select({
        id: omsOrders.id,
        channelId: omsOrders.channelId,
        status: omsOrders.status,
        fulfillmentStatus: omsOrders.fulfillmentStatus,
        financialStatus: omsOrders.financialStatus,
      }).from(omsOrders).where(eq(omsOrders.id, omsOrderId)).limit(1);
      const orderRows = lock ? await orderQuery.for("update") : await orderQuery;
      const order = orderRows[0];
      if (!order) return null;

      const lineQuery = database.select({
        id: omsOrderLines.id,
        orderId: omsOrderLines.orderId,
        productVariantId: omsOrderLines.productVariantId,
        externalLineItemId: omsOrderLines.externalLineItemId,
        externalProductId: omsOrderLines.externalProductId,
        sourceSku: omsOrderLines.sku,
        quantity: omsOrderLines.quantity,
        requiresShipping: omsOrderLines.requiresShipping,
        giftCard: omsOrderLines.giftCard,
        productExists: omsOrderLines.productExists,
        authoritySourceInboxId: omsOrderLines.authoritySourceInboxId,
      }).from(omsOrderLines).where(eq(omsOrderLines.orderId, omsOrderId))
        .orderBy(omsOrderLines.id).limit(MAX_ORDER_LINES + 1);
      const lines = lock ? await lineQuery.for("update") : await lineQuery;
      if (lines.length > MAX_ORDER_LINES) {
        throw new HistoricalIdentityRepairError(
          "REPAIR_SCOPE_TOO_LARGE",
          `OMS order exceeds the ${MAX_ORDER_LINES}-line repair limit`,
          409,
          { omsOrderId },
        );
      }

      const wmsOrderScope = or(
        and(eq(wmsOrders.source, "oms"), eq(wmsOrders.omsFulfillmentOrderId, String(omsOrderId))),
        and(eq(wmsOrders.source, "shopify"), eq(wmsOrders.sourceTableId, String(omsOrderId))),
      );
      const wmsOrderQuery = database.select({
        id: wmsOrders.id,
        warehouseStatus: wmsOrders.warehouseStatus,
      }).from(wmsOrders).where(wmsOrderScope).orderBy(wmsOrders.id).limit(MAX_ORDER_LINES + 1);
      const wmsOrderRows = lock ? await wmsOrderQuery.for("update") : await wmsOrderQuery;
      if (wmsOrderRows.length > MAX_ORDER_LINES) {
        throw new HistoricalIdentityRepairError(
          "REPAIR_SCOPE_TOO_LARGE",
          `OMS order exceeds the ${MAX_ORDER_LINES}-WMS-order repair limit`,
          409,
          { omsOrderId },
        );
      }
      const wmsOrderIds = wmsOrderRows.map((candidate: { id: number }) => candidate.id);
      const wmsItemQuery = wmsOrderIds.length === 0 ? null : database.select({
        id: wmsOrderItems.id,
        orderId: wmsOrderItems.orderId,
        omsOrderLineId: wmsOrderItems.omsOrderLineId,
        productVariantId: wmsOrderItems.productId,
        sku: wmsOrderItems.sku,
        quantity: wmsOrderItems.quantity,
        status: wmsOrderItems.status,
        pickedQuantity: wmsOrderItems.pickedQuantity,
        fulfilledQuantity: wmsOrderItems.fulfilledQuantity,
      }).from(wmsOrderItems).where(inArray(wmsOrderItems.orderId, wmsOrderIds))
        .orderBy(wmsOrderItems.id).limit(MAX_ORDER_LINES + 1);
      const wmsItems = !wmsItemQuery ? [] : lock
        ? await wmsItemQuery.for("update")
        : await wmsItemQuery;
      if (wmsItems.length > MAX_ORDER_LINES) {
        throw new HistoricalIdentityRepairError(
          "REPAIR_SCOPE_TOO_LARGE",
          `WMS order exceeds the ${MAX_ORDER_LINES}-line repair limit`,
          409,
          { omsOrderId },
        );
      }

      const inboxIds: number[] = [...new Set<number>(lines
        .map((line: { authoritySourceInboxId: number | null }) => line.authoritySourceInboxId)
        .filter((id: number | null): id is number => id != null))];
      const inboxQuery = inboxIds.length === 0 ? null : database.select({
        id: webhookInbox.id,
        provider: webhookInbox.provider,
        topic: webhookInbox.topic,
        status: webhookInbox.status,
        payload: webhookInbox.payload,
      }).from(webhookInbox).where(inArray(webhookInbox.id, inboxIds))
        .orderBy(webhookInbox.id).limit(MAX_ORDER_LINES);
      const inboxRows = !inboxQuery ? [] : lock
        ? await inboxQuery.for("share")
        : await inboxQuery;
      const inboxById = new Map(inboxRows.map((row) => [row.id, row] as const));
      const warehouseStatusByOrderId = new Map(wmsOrderRows.map((row) =>
        [row.id, row.warehouseStatus] as const));

      return Object.freeze({
        order: Object.freeze({ ...order, linkedWmsOrderIds: Object.freeze([...wmsOrderIds]) }),
        lines: Object.freeze(lines.map((line: typeof lines[number]) => Object.freeze({
          omsLine: Object.freeze({ ...line }),
          wmsItems: Object.freeze(wmsItems
            .filter((item: { omsOrderLineId: number | null }) => item.omsOrderLineId === line.id)
            .map((item: typeof wmsItems[number]) => Object.freeze({
              id: item.id,
              orderId: item.orderId,
              warehouseStatus: warehouseStatusByOrderId.get(item.orderId) ?? "unknown",
              productVariantId: item.productVariantId,
              sku: item.sku,
              quantity: item.quantity,
              status: item.status,
              pickedQuantity: item.pickedQuantity,
              fulfilledQuantity: item.fulfilledQuantity,
            }))),
          sourceInbox: line.authoritySourceInboxId == null
            ? null
            : Object.freeze(inboxById.get(line.authoritySourceInboxId) ?? null),
        }))),
      });
    },

    resolveIdentity(input) {
      return resolveOrderLineCatalogIdentity(database, input);
    },

    async repairLine(input): Promise<HistoricalIdentityRepairLineChange> {
      const [updatedLine] = await database.update(omsOrderLines).set({
        productVariantId: input.identity.id,
        updatedAt: input.now,
      }).where(and(
        eq(omsOrderLines.id, input.omsOrderLineId),
        eq(omsOrderLines.orderId, input.orderId),
      )).returning({ id: omsOrderLines.id });
      if (!updatedLine) {
        throw new HistoricalIdentityRepairError(
          "OMS_LINE_UPDATE_LOST",
          "OMS line disappeared while applying the repair",
          409,
          { omsOrderLineId: input.omsOrderLineId },
        );
      }

      await recordOrderLineCatalogIdentity(database, {
        orderId: input.orderId,
        orderLineId: input.omsOrderLineId,
        channelId: input.channelId,
        previousVariantId: input.previousOmsVariantId,
        identity: input.identity,
        source: {
          channelId: input.channelId,
          externalVariantId: input.source.externalVariantId,
          externalProductId: input.source.externalProductId,
          sku: input.source.sku,
          previousVariantId: input.previousOmsVariantId,
        },
        sourceEventId: input.sourceEventId,
      });

      const bin = await resolveAssignedBinLocation(database, input.identity.id);
      const catalogSku = input.identity.sku?.trim() ?? "";
      if (!catalogSku) {
        throw new HistoricalIdentityRepairError(
          "CATALOG_SKU_MISSING",
          "Resolved catalog variant has no SKU",
          409,
          { productVariantId: input.identity.id },
        );
      }
      await updateWmsOrderItemCatalogSnapshot(database, {
        itemId: input.wmsOrderItemId,
        productId: input.identity.id,
        sku: catalogSku,
        ...(bin ? { location: bin.location, zone: bin.zone } : {}),
      });

      return Object.freeze({
        omsOrderLineId: input.omsOrderLineId,
        wmsOrderItemId: input.wmsOrderItemId,
        previousOmsVariantId: input.previousOmsVariantId,
        productVariantId: input.identity.id,
        previousWmsVariantId: input.previousWmsVariantId,
        previousWmsSku: input.previousWmsSku,
        catalogSku,
      });
    },

    async findCommand(idempotencyKey: string, lock: boolean): Promise<HistoricalIdentityRepairCommandRecord | null> {
      const query = database.select().from(omsHistoricalLineIdentityRepairCommands)
        .where(eq(omsHistoricalLineIdentityRepairCommands.idempotencyKey, idempotencyKey)).limit(1);
      const rows = lock ? await query.for("update") : await query;
      return rows[0] ? parseCommand(rows[0]) : null;
    },

    findCommandById,

    async insertCommand(input): Promise<HistoricalIdentityRepairCommandRecord | null> {
      const [inserted] = await database.insert(omsHistoricalLineIdentityRepairCommands).values({
        omsOrderId: input.omsOrderId,
        wmsOrderId: input.wmsOrderId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        previewHash: input.previewHash,
        operator: input.operator,
        reason: input.reason,
        status: "claim_pending",
        targetOmsLineIds: [...input.targetOmsLineIds],
        repairResult: input.repairResult,
        createdAt: input.now,
        updatedAt: input.now,
      }).onConflictDoNothing({
        target: omsHistoricalLineIdentityRepairCommands.idempotencyKey,
      }).returning();
      return inserted ? parseCommand(inserted) : null;
    },

    async recordPreparedEvent(input): Promise<void> {
      await database.insert(omsOrderEvents).values({
        orderId: input.orderId,
        eventType: "historical_line_identity_repair_prepared",
        details: {
          commandId: input.commandId,
          operator: input.operator,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          previewHash: input.prepared.previewHash,
          wmsOrderId: input.prepared.wmsOrderId,
          repairedLines: input.prepared.repairedLines,
          claimStatus: "pending",
        },
      });
    },

    async markCommandSucceeded(commandId, claimResult, completedAt) {
      const [updated] = await database.update(omsHistoricalLineIdentityRepairCommands).set({
        status: "succeeded",
        claimResult,
        lastErrorCode: null,
        lastError: null,
        completedAt,
        updatedAt: completedAt,
      }).where(and(
        eq(omsHistoricalLineIdentityRepairCommands.id, commandId),
        inArray(omsHistoricalLineIdentityRepairCommands.status, ["claim_pending", "failed"]),
      )).returning();
      if (!updated) {
        const existing = await findCommandById(commandId);
        if (existing?.status === "succeeded") return existing;
        throw new HistoricalIdentityRepairError(
          "REPAIR_COMMAND_STATE_CONFLICT",
          "Repair command could not transition to succeeded",
          409,
          { commandId },
        );
      }
      return parseCommand(updated);
    },

    async markCommandFailed(commandId, errorCode, message, failedAt) {
      await database.update(omsHistoricalLineIdentityRepairCommands).set({
        status: "failed",
        lastErrorCode: errorCode.slice(0, 100),
        lastError: message.slice(0, 4000),
        updatedAt: failedAt,
      }).where(and(
        eq(omsHistoricalLineIdentityRepairCommands.id, commandId),
        inArray(omsHistoricalLineIdentityRepairCommands.status, ["claim_pending", "failed"]),
      ));
    },

    async recordClaimEvent(input): Promise<void> {
      await database.insert(omsOrderEvents).values({
        orderId: input.orderId,
        eventType: "historical_line_identity_claim_reconciled",
        details: {
          commandId: input.commandId,
          initiatedBy: input.initiatedBy,
          reconciledBy: input.reconciledBy,
          sourceEventId: input.sourceEventId,
          claimResult: input.claimResult,
        },
      });
    },
  };
}
