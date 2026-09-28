import type { Pool } from "pg";
import { z } from "zod";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  DropshipListingPushStatusRepository,
  VendorListingPushItemRecord,
  VendorListingPushJobRecord,
} from "../application/dropship-listing-push-status-service";

const positiveInteger = z.number().int().positive();

const jobRowSchema = z.object({
  id: positiveInteger,
  vendor_id: positiveInteger,
  store_connection_id: positiveInteger,
  platform: z.string().min(1),
  status: z.string().min(1),
  created_at: z.date(),
  updated_at: z.date(),
  completed_at: z.date().nullable(),
}).strict();

const itemRowSchema = z.object({
  id: positiveInteger,
  listing_id: positiveInteger.nullable(),
  product_variant_id: positiveInteger,
  status: z.string().min(1),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  retryable: z.boolean().nullable(),
  external_listing_id: z.string().nullable(),
  variant_sku: z.string().nullable(),
  variant_name: z.string(),
  product_name: z.string(),
}).strict();

export class PgDropshipListingPushStatusRepository implements DropshipListingPushStatusRepository {
  constructor(private readonly pool: Pool = defaultPool) {}

  async findVendorIdByMemberId(memberId: string): Promise<number | null> {
    const result = await this.pool.query<{ id: number }>(
      `SELECT id FROM dropship.dropship_vendors WHERE member_id::text = $1 LIMIT 1`,
      [memberId],
    );
    return result.rows[0]?.id ?? null;
  }

  /** The vendor id is part of the lookup, so a job another vendor owns is simply absent. */
  async loadVendorJob(input: { vendorId: number; jobId: number }): Promise<VendorListingPushJobRecord | null> {
    const jobs = await this.pool.query<Record<string, unknown>>(
      `SELECT j.id, j.vendor_id, j.store_connection_id, sc.platform, j.status, j.created_at, j.updated_at, j.completed_at
       FROM dropship.dropship_listing_push_jobs j
       JOIN dropship.dropship_store_connections sc ON sc.id = j.store_connection_id
       WHERE j.id = $1 AND j.vendor_id = $2`,
      [input.jobId, input.vendorId],
    );
    const jobRow = jobs.rows[0];
    if (!jobRow) return null;
    const job = parseRow(jobRowSchema, jobRow, "job");
    const items = await this.pool.query<Record<string, unknown>>(
      `SELECT i.id, i.listing_id, i.product_variant_id, i.status, i.error_code, i.error_message,
              (i.result -> 'push' ->> 'retryable')::boolean AS retryable,
              COALESCE(i.external_listing_id, l.external_listing_id) AS external_listing_id,
              pv.sku AS variant_sku, pv.name AS variant_name, p.name AS product_name
       FROM dropship.dropship_listing_push_job_items i
       LEFT JOIN dropship.dropship_vendor_listings l ON l.id = i.listing_id
       JOIN catalog.product_variants pv ON pv.id = i.product_variant_id
       JOIN catalog.products p ON p.id = pv.product_id
       WHERE i.job_id = $1
       ORDER BY i.id`,
      [input.jobId],
    );
    return {
      jobId: job.id,
      vendorId: job.vendor_id,
      storeConnectionId: job.store_connection_id,
      platform: job.platform,
      status: job.status,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      completedAt: job.completed_at,
      items: items.rows.map((row): VendorListingPushItemRecord => {
        const item = parseRow(itemRowSchema, row, "item");
        return {
          itemId: item.id,
          listingId: item.listing_id,
          productVariantId: item.product_variant_id,
          sku: item.variant_sku,
          productName: item.product_name,
          variantName: item.variant_name,
          status: item.status,
          errorCode: item.error_code,
          errorMessage: item.error_message,
          retryable: item.retryable,
          externalListingId: item.external_listing_id,
        };
      }),
    };
  }
}

/** A stored row outside the contract is refused, never served half-read. */
function parseRow<T extends z.ZodTypeAny>(schema: T, row: Record<string, unknown>, kind: "job" | "item"): z.infer<T> {
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    throw new DropshipError(
      "DROPSHIP_LISTING_PUSH_STATUS_INVALID_ROW",
      `A listing push ${kind} row does not match its contract.`,
      { classification: "fatal", kind, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) },
    );
  }
  return parsed.data;
}
