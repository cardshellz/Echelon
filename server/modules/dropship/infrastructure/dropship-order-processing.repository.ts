import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  DropshipOrderProcessingClaim,
  DropshipOrderProcessingConfig,
  DropshipOrderProcessingIntakeRecord,
  DropshipOrderProcessingQuoteItem,
  DropshipOrderProcessingRepository,
} from "../application/dropship-order-processing-service";
import type {
  DropshipOrderIntakeStatus,
  NormalizedDropshipOrderPayload,
} from "../application/dropship-order-intake-service";

interface ProcessingIntakeRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  platform: "ebay" | "shopify";
  external_order_id: string;
  status: DropshipOrderIntakeStatus;
  payment_hold_expires_at: Date | null;
  normalized_payload: NormalizedDropshipOrderPayload | null;
  store_config: Record<string, unknown> | null;
}

interface ListingCandidateRow {
  listing_id: number;
  product_variant_id: number;
  listing_status: string;
  external_listing_id: string | null;
  external_offer_id: string | null;
  product_sku: string | null;
  variant_sku: string | null;
  product_is_active: boolean;
  variant_is_active: boolean;
  dropship_eligible: boolean | null;
}

const QUOTABLE_LISTING_STATUSES = new Set(["active", "drift_detected", "paused"]);
const PAYMENT_HOLD_EXPIRED_REASON = "Payment hold expired before wallet funds were available.";

export class PgDropshipOrderProcessingRepository implements DropshipOrderProcessingRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async claimIntake(input: {
    intakeId: number;
    workerId: string;
    now: Date;
  }): Promise<DropshipOrderProcessingClaim> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const row = await loadIntakeForUpdate(client, input.intakeId);
      if (!row) {
        throw new DropshipError(
          "DROPSHIP_ORDER_PROCESSING_INTAKE_NOT_FOUND",
          "Dropship order intake was not found for processing.",
          { intakeId: input.intakeId },
        );
      }

      const skipReason = claimSkipReason(row, input.now);
      if (skipReason) {
        await client.query("COMMIT");
        return {
          claimed: false,
          skipReason,
          intake: mapProcessingIntakeRow(row),
          config: mapProcessingConfig(row.store_config),
        };
      }

      const updated = await client.query<ProcessingIntakeRow>(
        `UPDATE dropship.dropship_order_intake AS oi
         SET status = 'processing',
             rejection_reason = NULL,
             updated_at = $2
         WHERE oi.id = $1
         RETURNING oi.id, oi.vendor_id, oi.store_connection_id, oi.platform,
                   oi.external_order_id, oi.status, oi.payment_hold_expires_at,
                   oi.normalized_payload,
                   (SELECT sc.config
                    FROM dropship.dropship_store_connections sc
                    WHERE sc.id = oi.store_connection_id) AS store_config`,
        [input.intakeId, input.now],
      );
      const claimed = requiredRow(updated.rows[0], "Dropship order intake claim did not return a row.");
      await recordProcessingAuditEvent(client, {
        intake: claimed,
        eventType: "order_processing_claimed",
        severity: "info",
        workerId: input.workerId,
        payload: { previousStatus: row.status },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return {
        claimed: true,
        skipReason: null,
        intake: mapProcessingIntakeRow(claimed),
        config: mapProcessingConfig(claimed.store_config),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveQuoteItems(input: {
    intake: DropshipOrderProcessingIntakeRecord;
  }): Promise<DropshipOrderProcessingQuoteItem[]> {
    const rawLines = input.intake.normalizedPayload.lines;
    if (rawLines.length === 0) {
      throw new DropshipError(
        "DROPSHIP_ORDER_PROCESSING_ITEMS_REQUIRED",
        "Dropship order intake has no lines to quote.",
        { intakeId: input.intake.intakeId },
      );
    }

    const productVariantIds = uniquePositiveIntegers(
      rawLines.map((line) => line.productVariantId).filter((value): value is number => Number.isInteger(value)),
    );
    const externalListingIds = uniqueStrings(rawLines.map((line) => line.externalListingId));
    const externalOfferIds = uniqueStrings(rawLines.map((line) => line.externalOfferId));
    const skus = uniqueStrings(rawLines.map((line) => line.sku?.toUpperCase()));

    const result = await this.dbPool.query<ListingCandidateRow>(
      `SELECT
         dl.id AS listing_id,
         dl.product_variant_id,
         dl.status AS listing_status,
         dl.external_listing_id,
         dl.external_offer_id,
         p.sku AS product_sku,
         pv.sku AS variant_sku,
         p.is_active AS product_is_active,
         pv.is_active AS variant_is_active,
         pv.dropship_eligible
       FROM dropship.dropship_vendor_listings dl
       INNER JOIN catalog.product_variants pv ON pv.id = dl.product_variant_id
       INNER JOIN catalog.products p ON p.id = pv.product_id
       WHERE dl.vendor_id = $1
         AND dl.store_connection_id = $2
         AND (
           dl.product_variant_id = ANY($3::int[])
           OR dl.external_listing_id = ANY($4::text[])
           OR dl.external_offer_id = ANY($5::text[])
           OR UPPER(pv.sku) = ANY($6::text[])
           OR UPPER(p.sku) = ANY($6::text[])
         )`,
      [
        input.intake.vendorId,
        input.intake.storeConnectionId,
        productVariantIds,
        externalListingIds,
        externalOfferIds,
        skus,
      ],
    );
    const candidates = result.rows;

    return rawLines.map((line, lineIndex) => {
      const candidate = findCandidateForOrderLine(candidates, line);
      if (!candidate) {
        throw new DropshipError(
          "DROPSHIP_ORDER_PROCESSING_LINE_LISTING_REQUIRED",
          "Dropship order line must resolve to a vendor-owned listing before shipping can be quoted.",
          {
            intakeId: input.intake.intakeId,
            lineIndex,
            productVariantId: line.productVariantId,
            externalListingId: line.externalListingId,
            externalOfferId: line.externalOfferId,
            sku: line.sku,
          },
        );
      }
      assertCandidateCanQuote(candidate, input.intake.intakeId, lineIndex);
      return {
        lineIndex,
        productVariantId: candidate.product_variant_id,
        quantity: line.quantity,
      };
    });
  }

  async markIntakeFailure(input: {
    intakeId: number;
    vendorId: number;
    storeConnectionId: number;
    workerId: string;
    status: "failed" | "retrying";
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    now: Date;
  }): Promise<void> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<ProcessingIntakeRow>(
        `UPDATE dropship.dropship_order_intake AS oi
         SET status = $2,
             rejection_reason = $3,
             updated_at = $4
         WHERE oi.id = $1
           AND oi.status = 'processing'
         RETURNING oi.id, oi.vendor_id, oi.store_connection_id, oi.platform,
                   oi.external_order_id, oi.status, oi.payment_hold_expires_at,
                   oi.normalized_payload,
                   (SELECT sc.config
                    FROM dropship.dropship_store_connections sc
                    WHERE sc.id = oi.store_connection_id) AS store_config`,
        [
          input.intakeId,
          input.status,
          `${input.errorCode}: ${input.errorMessage}`,
          input.now,
        ],
      );
      const row = updated.rows[0];
      if (row) {
        await recordProcessingAuditEvent(client, {
          intake: row,
          eventType: input.status === "retrying"
            ? "order_processing_retry_scheduled"
            : "order_processing_failed",
          severity: input.retryable ? "warning" : "error",
          workerId: input.workerId,
          payload: {
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
            retryable: input.retryable,
          },
          occurredAt: input.now,
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markPaymentHoldExpired(input: {
    intakeId: number;
    vendorId: number;
    storeConnectionId: number;
    workerId: string;
    now: Date;
  }): Promise<boolean> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<ProcessingIntakeRow>(
        `UPDATE dropship.dropship_order_intake AS oi
         SET status = 'cancelled',
             cancellation_status = 'payment_hold_expired',
             rejection_reason = $4,
             updated_at = $5
         WHERE oi.id = $1
           AND oi.vendor_id = $2
           AND oi.store_connection_id = $3
           AND oi.status = 'processing'
           AND oi.payment_hold_expires_at IS NOT NULL
           AND oi.payment_hold_expires_at <= $5
         RETURNING oi.id, oi.vendor_id, oi.store_connection_id, oi.platform,
                   oi.external_order_id, oi.status, oi.payment_hold_expires_at,
                   oi.normalized_payload,
                   (SELECT sc.config
                    FROM dropship.dropship_store_connections sc
                    WHERE sc.id = oi.store_connection_id) AS store_config`,
        [
          input.intakeId,
          input.vendorId,
          input.storeConnectionId,
          PAYMENT_HOLD_EXPIRED_REASON,
          input.now,
        ],
      );
      const row = updated.rows[0];
      if (row) {
        await recordProcessingAuditEvent(client, {
          intake: row,
          eventType: "order_payment_hold_expired",
          severity: "warning",
          workerId: input.workerId,
          payload: {
            previousStatus: "processing",
            cancellationStatus: "payment_hold_expired",
            paymentHoldExpiresAt: row.payment_hold_expires_at?.toISOString() ?? null,
            reason: PAYMENT_HOLD_EXPIRED_REASON,
          },
          occurredAt: input.now,
        });
      }
      await client.query("COMMIT");
      return Boolean(row);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadIntakeForUpdate(
  client: PoolClient,
  intakeId: number,
): Promise<ProcessingIntakeRow | null> {
  const result = await client.query<ProcessingIntakeRow>(
    `SELECT oi.id, oi.vendor_id, oi.store_connection_id, oi.platform,
            oi.external_order_id, oi.status, oi.payment_hold_expires_at,
            oi.normalized_payload, sc.config AS store_config
     FROM dropship.dropship_order_intake oi
     INNER JOIN dropship.dropship_store_connections sc ON sc.id = oi.store_connection_id
     WHERE oi.id = $1
     LIMIT 1
     FOR UPDATE OF oi`,
    [intakeId],
  );
  return result.rows[0] ?? null;
}

function claimSkipReason(row: ProcessingIntakeRow, now: Date): string | null {
  if (row.status === "payment_hold") {
    if (row.payment_hold_expires_at && row.payment_hold_expires_at <= now) {
      return "Payment hold has expired and requires cancellation/ops exception handling.";
    }
    return null;
  }
  if (row.status === "received" || row.status === "retrying") {
    return null;
  }
  return `Status ${row.status} is not claimable for order processing.`;
}

function mapProcessingIntakeRow(row: ProcessingIntakeRow): DropshipOrderProcessingIntakeRecord {
  if (!row.normalized_payload) {
    throw new DropshipError(
      "DROPSHIP_ORDER_PROCESSING_PAYLOAD_REQUIRED",
      "Dropship order processing requires normalized intake payload.",
      { intakeId: row.id },
    );
  }
  if (row.platform !== "ebay" && row.platform !== "shopify") {
    throw new DropshipError(
      "DROPSHIP_ORDER_PROCESSING_PLATFORM_UNSUPPORTED",
      "Dropship order processing only supports launch marketplace platforms.",
      { intakeId: row.id, platform: row.platform },
    );
  }
  return {
    intakeId: row.id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    externalOrderId: row.external_order_id,
    status: row.status,
    paymentHoldExpiresAt: row.payment_hold_expires_at,
    normalizedPayload: row.normalized_payload,
  };
}

function mapProcessingConfig(config: Record<string, unknown> | null): DropshipOrderProcessingConfig {
  const result = readDefaultWarehouseId(config ?? {});
  return result.ok
    ? { defaultWarehouseId: result.defaultWarehouseId, warehouseConfigError: null }
    : {
      defaultWarehouseId: null,
      warehouseConfigError: {
        code: "DROPSHIP_ORDER_PROCESSING_WAREHOUSE_CONFIG_INVALID",
        message: "Dropship order processing warehouse config must be a positive integer.",
        context: { value: result.invalidValue },
      },
    };
}

function readDefaultWarehouseId(config: Record<string, unknown>): {
  ok: true;
  defaultWarehouseId: number | null;
} | {
  ok: false;
  invalidValue: unknown;
} {
  const candidates = [
    config.defaultWarehouseId,
    config.warehouseId,
    readNestedConfigNumber(config, "orderProcessing", "defaultWarehouseId"),
    readNestedConfigNumber(config, "dropshipOrderProcessing", "defaultWarehouseId"),
  ];
  for (const candidate of candidates) {
    const parsed = parseOptionalPositiveInteger(candidate);
    if (parsed === "invalid") {
      return { ok: false, invalidValue: candidate };
    }
    if (typeof parsed === "number") {
      return { ok: true, defaultWarehouseId: parsed };
    }
  }
  return { ok: true, defaultWarehouseId: null };
}

function readNestedConfigNumber(
  config: Record<string, unknown>,
  parentKey: string,
  childKey: string,
): unknown {
  const parent = config[parentKey];
  return parent && typeof parent === "object"
    ? (parent as Record<string, unknown>)[childKey]
    : undefined;
}

function parseOptionalPositiveInteger(value: unknown): number | null | "invalid" {
  if (value === null || typeof value === "undefined" || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return "invalid";
}

function findCandidateForOrderLine(
  candidates: readonly ListingCandidateRow[],
  line: NormalizedDropshipOrderPayload["lines"][number],
): ListingCandidateRow | null {
  if (line.productVariantId) {
    return candidates.find((candidate) => candidate.product_variant_id === line.productVariantId) ?? null;
  }
  if (line.externalOfferId) {
    return candidates.find((candidate) => candidate.external_offer_id === line.externalOfferId) ?? null;
  }
  if (line.externalListingId) {
    return candidates.find((candidate) => candidate.external_listing_id === line.externalListingId) ?? null;
  }
  const normalizedSku = line.sku?.trim().toUpperCase();
  if (normalizedSku) {
    return candidates.find((candidate) => (
      candidate.variant_sku?.toUpperCase() === normalizedSku
      || candidate.product_sku?.toUpperCase() === normalizedSku
    )) ?? null;
  }
  return null;
}

function assertCandidateCanQuote(
  candidate: ListingCandidateRow,
  intakeId: number,
  lineIndex: number,
): void {
  if (!QUOTABLE_LISTING_STATUSES.has(candidate.listing_status)) {
    throw new DropshipError(
      "DROPSHIP_ORDER_PROCESSING_LISTING_NOT_QUOTABLE",
      "Dropship order line listing is not in a quotable status.",
      {
        intakeId,
        lineIndex,
        listingId: candidate.listing_id,
        listingStatus: candidate.listing_status,
      },
    );
  }
  if (!candidate.product_is_active || !candidate.variant_is_active || candidate.dropship_eligible !== true) {
    throw new DropshipError(
      "DROPSHIP_ORDER_PROCESSING_VARIANT_NOT_ELIGIBLE",
      "Dropship order line variant is not eligible for shipping quote generation.",
      {
        intakeId,
        lineIndex,
        productVariantId: candidate.product_variant_id,
        productIsActive: candidate.product_is_active,
        variantIsActive: candidate.variant_is_active,
        dropshipEligible: candidate.dropship_eligible === true,
      },
    );
  }
}

async function recordProcessingAuditEvent(
  client: PoolClient,
  input: {
    intake: ProcessingIntakeRow;
    eventType: string;
    severity: "info" | "warning" | "error";
    workerId: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_order_intake', $3, $4,
             'job', $5, $6, $7::jsonb, $8)`,
    [
      input.intake.vendor_id,
      input.intake.store_connection_id,
      String(input.intake.id),
      input.eventType,
      input.workerId,
      input.severity,
      JSON.stringify({
        status: input.intake.status,
        externalOrderId: input.intake.external_order_id,
        ...input.payload,
      }),
      input.occurredAt,
    ],
  );
}

function uniquePositiveIntegers(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

function uniqueStrings(values: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
