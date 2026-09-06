import { and, eq, ne, sql } from "drizzle-orm";
import { fulfillmentNodes, idempotencyKeys, warehouses } from "@shared/schema";
import {
  prepareWarehouseInventorySourceResultSchema,
  warehouseInventorySourceViewSchema,
  warehouseInventorySourceWarehouseSchema,
  type PrepareWarehouseInventorySourceResult,
} from "@shared/types/warehouse-inventory-source";
import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import { logger } from "../../../platform/observability/logger";
import type { PrepareWarehouseInventorySourceCommand, WarehouseInventorySourceStore } from "../application/warehouse-inventory-source.service";
import { planWarehouseInventorySource, resolveConfiguredWarehouseSource, warehouseInventorySourceFingerprint, WarehouseInventorySourceError } from "../domain/warehouse-inventory-source";

// Resolve schema columns when a query runs, not while the public module loads.
function warehouseColumns() {
  return {
    id: warehouses.id, code: warehouses.code, name: warehouses.name,
    warehouseType: warehouses.warehouseType, inventorySourceType: warehouses.inventorySourceType,
    inventorySourceChannelId: sql<string | null>`${warehouses.inventorySourceConfig}->>'channelId'`,
    isActive: warehouses.isActive,
  };
}
const RECEIPT_PREFIX = "warehouse-inventory-source:";

export class PostgresWarehouseInventorySourceStore implements WarehouseInventorySourceStore {
  constructor(private readonly database: typeof db = db) {}

  async getView() {
    try {
      const rows = await this.database.select({
        warehouse: warehouseColumns(),
        source: {
          id: fulfillmentNodes.id, lifecycleStatus: fulfillmentNodes.lifecycleStatus,
          inventoryAuthority: fulfillmentNodes.inventoryAuthority,
          fulfillmentAuthority: fulfillmentNodes.fulfillmentAuthority,
        },
      }).from(warehouses).leftJoin(fulfillmentNodes, and(
        eq(fulfillmentNodes.warehouseId, warehouses.id), ne(fulfillmentNodes.lifecycleStatus, "retired"),
      )).orderBy(warehouses.code, warehouses.id);
      // Parse before fingerprinting; a corrupt saved identity must not become an approved draft.
      return warehouseInventorySourceViewSchema.parse({ warehouses: rows.map(row => {
        const warehouse = warehouseInventorySourceWarehouseSchema.parse(row.warehouse);
        return { ...warehouse, source: row.source, fingerprint: warehouseInventorySourceFingerprint(warehouse),
          configuredSource: resolveConfiguredWarehouseSource(warehouse) };
      }) });
    } catch (error) {
      throw classifyError(error);
    }
  }

  async prepareDraft(command: PrepareWarehouseInventorySourceCommand): Promise<PrepareWarehouseInventorySourceResult> {
    const receiptKey = RECEIPT_PREFIX + command.idempotencyKey;
    try {
      return await this.database.transaction(async tx => {
        // READ COMMITTED is intentional: the warehouse row lock serializes
        // creators, and the next statement sees the first creator's commit.
        // A SERIALIZABLE snapshot taken before waiting could instead emit 40001.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${receiptKey}, 0))`);
        const [receipt] = await tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, receiptKey));
        if (receipt) {
          if (receipt.requestHash !== command.requestHash) {
            throw new WarehouseInventorySourceError(409, "WAREHOUSE_INVENTORY_SOURCE_KEY_REUSED",
              "This idempotency key belongs to a different warehouse source request or operator.");
          }
          const saved = prepareWarehouseInventorySourceResultSchema.parse(receipt.responseBody);
          return { ...saved, alreadyApplied: true };
        }
        const [warehouse] = await tx.select(warehouseColumns()).from(warehouses)
          .where(eq(warehouses.id, command.warehouseId)).for("update");
        if (!warehouse) {
          throw new WarehouseInventorySourceError(404, "WAREHOUSE_INVENTORY_SOURCE_NOT_FOUND",
            "The selected warehouse no longer exists.");
        }
        const definition = planWarehouseInventorySource(
          // Validate persisted fields again after locking, including the enums.
          warehouseInventorySourceWarehouseSchema.parse(warehouse),
          command,
        );
        const [existing] = await tx.select({ id: fulfillmentNodes.id }).from(fulfillmentNodes)
          .where(and(eq(fulfillmentNodes.warehouseId, command.warehouseId), ne(fulfillmentNodes.lifecycleStatus, "retired")));
        if (existing) {
          throw new WarehouseInventorySourceError(409, "WAREHOUSE_INVENTORY_SOURCE_EXISTS",
            "This warehouse already has a source. Reload and use that source; it was not replaced.");
        }
        const [created] = await tx.insert(fulfillmentNodes).values({
          ...definition, createdBy: command.actorId, createdAt: command.occurredAt, updatedAt: command.occurredAt,
        }).returning({ id: fulfillmentNodes.id });
        const result = prepareWarehouseInventorySourceResultSchema.parse({
          fulfillmentNodeId: created!.id, warehouseId: command.warehouseId,
          lifecycleStatus: "draft", alreadyApplied: false,
          runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false,
        });
        await persistAuditEvent(tx, {
          actor: command.actorId, action: "warehouse.inventory_source.prepared_draft",
          target: `warehouse.fulfillment_node:${result.fulfillmentNodeId}`,
          changes: { before: null, after: { ...definition, id: result.fulfillmentNodeId } },
          context: {
            changeReason: command.changeReason, idempotencyKey: command.idempotencyKey,
            requestHash: command.requestHash, warehouseFingerprint: command.expectedWarehouseFingerprint,
            authoritySource: command.authoritySource ?? "explicit",
            warehouseSettings: command.authoritySource === "warehouse_settings" ? {
              warehouseType: warehouse.warehouseType, inventorySourceType: warehouse.inventorySourceType,
              configuredSource: resolveConfiguredWarehouseSource(warehouseInventorySourceWarehouseSchema.parse(warehouse)),
            } : null,
            runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false,
          },
        }, { timestamp: command.occurredAt, emitStructuredLog: false });
        await tx.insert(idempotencyKeys).values({
          key: receiptKey, requestHash: command.requestHash, responseBody: result,
          createdAt: command.occurredAt, expiresAt: null,
        });
        return result;
      }, { isolationLevel: "read committed" });
    } catch (error) {
      throw classifyError(error);
    }
  }
}

function classifyError(error: unknown): WarehouseInventorySourceError {
  if (error instanceof WarehouseInventorySourceError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
  if (code === "40001" || code === "40P01" || code === "55P03") {
    return new WarehouseInventorySourceError(409, "WAREHOUSE_INVENTORY_SOURCE_CONCURRENT_CHANGE",
      "A concurrent warehouse change prevented this save. Retry the same request.", "transient");
  }
  if (code === "23505" || code === "23503") {
    return new WarehouseInventorySourceError(409, "WAREHOUSE_INVENTORY_SOURCE_CONFLICT",
      "A source or warehouse identity conflicts with the current setup. Reload before retrying.");
  }
  logger.error("warehouse.inventory_source.database", {
    outcome: "failed",
    error_code: code ?? "INVALID_PERSISTED_DATA", before: null, after: null,
  });
  return new WarehouseInventorySourceError(500, "WAREHOUSE_INVENTORY_SOURCE_DATABASE_ERROR",
    "The warehouse source operation failed. No partial setup was saved.", "fatal");
}
