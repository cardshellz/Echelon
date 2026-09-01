import type { Pool, PoolClient } from "pg";

import {
  HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE,
} from "./historical-shipstation-contents-review.service";
import type {
  HistoricalShipStationContentsCorrectionFacts,
} from "./historical-shipstation-contents-correction.domain";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const EVIDENCE_HASH = /^[0-9a-f]{64}$/;

export interface HistoricalShipStationContentsCorrectionFactsRequest {
  readonly exceptionId: string;
  readonly reviewPreviewEvidenceHash: string;
  readonly orderNumber: string | null;
  readonly trackingNumber: string;
  readonly providerLines: readonly Readonly<{
    readonly sku: string;
    readonly quantity: number;
  }>[] | null;
}

export interface HistoricalShipStationContentsCorrectionRepository {
  loadFacts(
    input: HistoricalShipStationContentsCorrectionFactsRequest,
  ): Promise<HistoricalShipStationContentsCorrectionFacts>;
}

export type HistoricalShipStationContentsCorrectionRepositoryErrorCode =
  | "CORRECTION_NOT_AUTHORIZED"
  | "INVALID_DATABASE_EVIDENCE"
  | "REVIEW_NOT_FOUND"
  | "DATABASE_ERROR";

export class HistoricalShipStationContentsCorrectionRepositoryError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsCorrectionRepositoryErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = Object.freeze({}),
  ) {
    super(message);
    this.name = "HistoricalShipStationContentsCorrectionRepositoryError";
  }
}

function classify(error: unknown): HistoricalShipStationContentsCorrectionRepositoryError {
  if (error instanceof HistoricalShipStationContentsCorrectionRepositoryError) return error;
  const record = error !== null && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  return new HistoricalShipStationContentsCorrectionRepositoryError(
    "DATABASE_ERROR",
    "Historical contents correction evidence query failed",
    Object.freeze({
      postgresCode: typeof record.code === "string" ? record.code : null,
      constraint: typeof record.constraint === "string" ? record.constraint : null,
    }),
  );
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HistoricalShipStationContentsCorrectionRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents correction ${field} is not an object`,
    );
  }
  return value as Record<string, unknown>;
}

function objectArray(value: unknown, field: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new HistoricalShipStationContentsCorrectionRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents correction ${field} is not an array`,
    );
  }
  return value.map((entry, index) => object(entry, `${field}[${index}]`));
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > POSTGRES_INTEGER_MAX) {
    throw new HistoricalShipStationContentsCorrectionRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents correction ${field} is not a positive PostgreSQL integer`,
    );
  }
  return parsed;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value == null ? null : positiveInteger(value, field);
}

function exactText(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
  ) {
    throw new HistoricalShipStationContentsCorrectionRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents correction ${field} failed validation`,
    );
  }
  return value;
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !EVIDENCE_HASH.test(value)) {
    throw new HistoricalShipStationContentsCorrectionRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents correction ${field} is not an evidence hash`,
    );
  }
  return value;
}

interface PersistedWmsLine {
  readonly wmsShipmentItemId: number;
  readonly sku: string;
  readonly quantity: number;
}

function persistedWmsLines(details: Record<string, unknown>): readonly PersistedWmsLine[] {
  const wmsEvidence = object(details.wmsEvidence, "wmsEvidence");
  if (wmsEvidence.kind === "unavailable") return Object.freeze([]);
  if (wmsEvidence.kind !== "available") {
    throw new HistoricalShipStationContentsCorrectionRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents correction WMS evidence kind is unsupported",
    );
  }
  const lines = objectArray(wmsEvidence.lines, "wmsEvidence.lines").map((line) => Object.freeze({
    wmsShipmentItemId: positiveInteger(line.wmsShipmentItemId, "wmsShipmentItemId"),
    sku: exactText(line.sku, "sku", 100),
    quantity: positiveInteger(line.quantity, "quantity"),
  }));
  const ids = new Set(lines.map((line) => line.wmsShipmentItemId));
  if (ids.size !== lines.length) {
    throw new HistoricalShipStationContentsCorrectionRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents correction WMS evidence contains duplicate line identifiers",
    );
  }
  return Object.freeze(lines);
}

async function withRepeatableRead<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw classify(error);
  } finally {
    client.release();
  }
}

interface WmsLineRow {
  readonly id: unknown;
  readonly shipment_id: unknown;
  readonly order_item_id: unknown;
  readonly product_variant_id: unknown;
  readonly qty: unknown;
  readonly from_location_id: unknown;
  readonly variant_sku: unknown;
  readonly variant_name: unknown;
}

interface InventoryTransactionRow {
  readonly id: unknown;
  readonly shipment_id: unknown;
  readonly shipment_item_id: unknown;
  readonly order_item_id: unknown;
  readonly product_variant_id: unknown;
  readonly from_location_id: unknown;
  readonly variant_qty_delta: unknown;
}

interface CatalogVariantRow {
  readonly id: unknown;
  readonly sku: unknown;
  readonly name: unknown;
  readonly is_active: unknown;
  readonly requires_shipping: unknown;
  readonly track_inventory: unknown;
}

export class PgHistoricalShipStationContentsCorrectionRepository
implements HistoricalShipStationContentsCorrectionRepository {
  constructor(private readonly pool: Pool) {}

  async loadFacts(
    input: HistoricalShipStationContentsCorrectionFactsRequest,
  ): Promise<HistoricalShipStationContentsCorrectionFacts> {
    return withRepeatableRead(this.pool, async (client) => {
      const review = await client.query<{ readonly id: unknown; readonly details: unknown }>(
        `SELECT id::text AS id, details
         FROM wms.reconciliation_exceptions
         WHERE id = $1::bigint
           AND rule = $2
           AND status IN ('open', 'acknowledged')`,
        [input.exceptionId, HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE],
      );
      if (review.rows.length !== 1) {
        throw new HistoricalShipStationContentsCorrectionRepositoryError(
          "REVIEW_NOT_FOUND",
          "Historical contents review is no longer open",
        );
      }
      const details = object(review.rows[0].details, "details");
      if (details.contract !== "historical_shipstation_contents_review_v1") {
        throw new HistoricalShipStationContentsCorrectionRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Historical contents correction review contract is unsupported",
        );
      }
      if (
        details.decision !== "provider_confirmed_pending_inventory_correction"
        || details.inventoryCorrectionRequired !== true
      ) {
        throw new HistoricalShipStationContentsCorrectionRepositoryError(
          "CORRECTION_NOT_AUTHORIZED",
          "ShipStation contents must be confirmed before a correction can be previewed",
        );
      }
      const recordedPreviewHash = hash(
        details.decisionPreviewEvidenceHash,
        "decisionPreviewEvidenceHash",
      );
      if (recordedPreviewHash !== input.reviewPreviewEvidenceHash) {
        throw new HistoricalShipStationContentsCorrectionRepositoryError(
          "CORRECTION_NOT_AUTHORIZED",
          "The confirmed contents decision does not match the current provider evidence",
        );
      }
      const decisionHash = hash(details.decisionHash, "decisionHash");
      const providerEvidenceHash = hash(
        object(details.providerEvidence, "providerEvidence").evidenceHash,
        "providerEvidence.evidenceHash",
      );
      const persistedLines = persistedWmsLines(details);
      const wmsIds = persistedLines.map((line) => line.wmsShipmentItemId);
      const wmsResult = wmsIds.length === 0
        ? { rows: [] as WmsLineRow[] }
        : await client.query<WmsLineRow>(
            `SELECT item.id, item.shipment_id, item.order_item_id,
                    item.product_variant_id, item.qty, item.from_location_id,
                    variant.sku AS variant_sku, variant.name AS variant_name
             FROM wms.outbound_shipment_items AS item
             LEFT JOIN catalog.product_variants AS variant
               ON variant.id = item.product_variant_id
             WHERE item.id = ANY($1::integer[])
             ORDER BY item.id`,
            [wmsIds],
          );
      if (wmsResult.rows.length !== persistedLines.length) {
        throw new HistoricalShipStationContentsCorrectionRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "One or more persisted WMS package lines no longer exist",
        );
      }

      const persistedById = new Map(persistedLines.map(
        (line) => [line.wmsShipmentItemId, line] as const,
      ));
      const wmsRows = wmsResult.rows.map((row) => {
        const id = positiveInteger(row.id, "wmsShipmentItemId");
        const persisted = persistedById.get(id);
        if (!persisted || positiveInteger(row.qty, "WMS quantity") !== persisted.quantity) {
          throw new HistoricalShipStationContentsCorrectionRepositoryError(
            "INVALID_DATABASE_EVIDENCE",
            "Current WMS package quantity does not match the confirmed evidence",
            Object.freeze({ wmsShipmentItemId: id }),
          );
        }
        if (
          row.variant_sku !== null
          && exactText(row.variant_sku, "catalog SKU", 100).toUpperCase()
            !== persisted.sku.toUpperCase()
        ) {
          throw new HistoricalShipStationContentsCorrectionRepositoryError(
            "INVALID_DATABASE_EVIDENCE",
            "Current WMS product variant does not match the confirmed package SKU",
            Object.freeze({ wmsShipmentItemId: id }),
          );
        }
        return Object.freeze({
          id,
          shipmentId: positiveInteger(row.shipment_id, "wmsShipmentId"),
          orderItemId: nullablePositiveInteger(row.order_item_id, "orderItemId"),
          productVariantId: nullablePositiveInteger(row.product_variant_id, "productVariantId"),
          sku: persisted.sku,
          itemName: row.variant_name == null
            ? null
            : exactText(row.variant_name, "variant name", 500),
          quantity: persisted.quantity,
          fromLocationId: nullablePositiveInteger(row.from_location_id, "fromLocationId"),
        });
      });

      const shipmentIds = [...new Set(wmsRows.map((line) => line.shipmentId))];
      const transactionResult = shipmentIds.length === 0
        ? { rows: [] as InventoryTransactionRow[] }
        : await client.query<InventoryTransactionRow>(
            `SELECT inventory_txn.id, inventory_txn.shipment_id,
                    inventory_txn.shipment_item_id, inventory_txn.order_item_id,
                    inventory_txn.product_variant_id, inventory_txn.from_location_id,
                    inventory_txn.variant_qty_delta
             FROM inventory.inventory_transactions AS inventory_txn
             WHERE inventory_txn.transaction_type = 'ship'
               AND inventory_txn.voided_at IS NULL
               AND inventory_txn.shipment_id = ANY($1::integer[])
             ORDER BY inventory_txn.id`,
            [shipmentIds],
          );
      const transactions = transactionResult.rows.map((row) => Object.freeze({
        id: positiveInteger(row.id, "inventoryTransactionId"),
        shipmentId: positiveInteger(row.shipment_id, "inventory shipmentId"),
        shipmentItemId: nullablePositiveInteger(row.shipment_item_id, "inventory shipmentItemId"),
        orderItemId: nullablePositiveInteger(row.order_item_id, "inventory orderItemId"),
        productVariantId: nullablePositiveInteger(row.product_variant_id, "inventory productVariantId"),
        fromLocationId: nullablePositiveInteger(row.from_location_id, "inventory fromLocationId"),
        quantity: (() => {
          const delta = Number(row.variant_qty_delta);
          if (!Number.isInteger(delta) || delta >= 0 || delta < -POSTGRES_INTEGER_MAX) {
            throw new HistoricalShipStationContentsCorrectionRepositoryError(
              "INVALID_DATABASE_EVIDENCE",
              "Active inventory ship transaction has an invalid quantity delta",
              Object.freeze({ inventoryTransactionId: row.id }),
            );
          }
          return Math.abs(delta);
        })(),
      }));

      const providerSkus = input.providerLines?.map((line) => line.sku.toUpperCase()) ?? [];
      const variantIds = [...new Set(wmsRows
        .map((line) => line.productVariantId)
        .filter((value): value is number => value !== null))];
      const requestedSkus = [...new Set([
        ...providerSkus,
        ...persistedLines.map((line) => line.sku.toUpperCase()),
      ])];
      const catalogResult = variantIds.length === 0 && requestedSkus.length === 0
        ? { rows: [] as CatalogVariantRow[] }
        : await client.query<CatalogVariantRow>(
            `SELECT id, sku, name, is_active, requires_shipping, track_inventory
             FROM catalog.product_variants
             WHERE id = ANY($1::integer[])
                OR UPPER(sku) = ANY($2::text[])
             ORDER BY id`,
            [variantIds, requestedSkus],
          );
      const catalogVariants = catalogResult.rows
        .filter((row) => row.sku !== null)
        .map((row) => Object.freeze({
          productVariantId: positiveInteger(row.id, "catalog productVariantId"),
          sku: exactText(row.sku, "catalog SKU", 100),
          itemName: exactText(row.name, "catalog variant name", 500),
          isActive: row.is_active === true,
          requiresShipping: row.requires_shipping === true,
          trackInventory: row.track_inventory === true,
        }));

      return Object.freeze({
        exceptionId: input.exceptionId,
        decisionHash,
        providerEvidenceHash,
        reviewPreviewEvidenceHash: input.reviewPreviewEvidenceHash,
        orderNumber: input.orderNumber,
        trackingNumber: input.trackingNumber,
        providerLines: input.providerLines === null
          ? null
          : input.providerLines.map((line) => ({ ...line })),
        wmsLines: wmsRows.map((line) => {
          const exact = transactions.filter((entry) => entry.shipmentItemId === line.id);
          const matched = exact.length > 0
            ? exact.map((entry) => ({ ...entry, evidenceKind: "exact_shipment_item" as const }))
            : transactions
                .filter((entry) => (
                  entry.shipmentItemId === null
                  && entry.shipmentId === line.shipmentId
                  && entry.orderItemId === line.orderItemId
                  && entry.productVariantId === line.productVariantId
                ))
                .map((entry) => ({ ...entry, evidenceKind: "legacy_order_item" as const }));
          return Object.freeze({
            wmsShipmentItemId: line.id,
            wmsShipmentId: line.shipmentId,
            orderItemId: line.orderItemId,
            productVariantId: line.productVariantId,
            sku: line.sku,
            itemName: line.itemName,
            quantity: line.quantity,
            fromLocationId: line.fromLocationId,
            inventoryShipTransactions: matched.map((entry) => ({
              inventoryTransactionId: entry.id,
              productVariantId: entry.productVariantId,
              fromLocationId: entry.fromLocationId,
              quantity: entry.quantity,
              evidenceKind: entry.evidenceKind,
            })),
          });
        }),
        catalogVariants: [...catalogVariants],
      });
    });
  }
}
