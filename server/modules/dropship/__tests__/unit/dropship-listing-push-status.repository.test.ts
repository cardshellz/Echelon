import type { Pool, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgDropshipListingPushStatusRepository } from "../../infrastructure/dropship-listing-push-status.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const NOW = new Date("2026-09-28T17:55:00.000Z");

interface Call { sql: string; values: unknown[] | undefined }

function fakePool(answers: Array<QueryResult<QueryResultRow>>) {
  const calls: Call[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
    return answers.shift() ?? result([]);
  });
  return { pool: { query } as unknown as Pool, calls };
}

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}

const jobRow = {
  id: 31, vendor_id: 10, store_connection_id: 5, platform: "ebay", provider_environment: "Sandbox", status: "failed",
  created_at: NOW, updated_at: NOW, completed_at: NOW,
};
const itemRow = {
  id: 1, listing_id: 100, product_variant_id: 101, status: "failed", error_code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
  error_message: "eBay listing push failed with HTTP 400: 25002 Invalid value", retryable: false, external_listing_id: null, published: null,
  variant_sku: "ARM-ENV-SGL-P50", variant_name: "Pack of 50", product_name: "Armalope Envelope Single Pocket",
};

describe("PgDropshipListingPushStatusRepository", () => {
  it("resolves the vendor from the member id", async () => {
    const { pool, calls } = fakePool([result([{ id: 10 }])]);
    expect(await new PgDropshipListingPushStatusRepository(pool).findVendorIdByMemberId("member-5")).toBe(10);
    expect(calls[0]).toEqual({ sql: "SELECT id FROM dropship.dropship_vendors WHERE member_id::text = $1 LIMIT 1", values: ["member-5"] });
  });

  it("reads the job only with the vendor id in the lookup, then its items with their catalog names and the worker's verdict", async () => {
    const { pool, calls } = fakePool([result([jobRow]), result([itemRow])]);
    const job = await new PgDropshipListingPushStatusRepository(pool).loadVendorJob({ vendorId: 10, jobId: 31 });

    expect(calls[0]?.sql).toContain("FROM dropship.dropship_listing_push_jobs j JOIN dropship.dropship_store_connections sc ON sc.id = j.store_connection_id WHERE j.id = $1 AND j.vendor_id = $2");
    expect(calls[0]?.sql).toContain("COALESCE(sc.provider_environment, sc.config -> 'tokenMetadata' ->> 'environment') AS provider_environment");
    expect(calls[0]?.values).toEqual([31, 10]);
    expect(calls[1]?.sql).toContain("(i.result -> 'push' ->> 'retryable')::boolean AS retryable");
    expect(calls[1]?.sql).toContain("(i.result -> 'push' -> 'rawResult' ->> 'published')::boolean AS published");
    expect(calls[1]?.sql).toContain("COALESCE(i.external_listing_id, l.external_listing_id) AS external_listing_id");
    expect(calls[1]?.sql).toContain("LEFT JOIN dropship.dropship_vendor_listings l ON l.id = i.listing_id JOIN catalog.product_variants pv ON pv.id = i.product_variant_id JOIN catalog.products p ON p.id = pv.product_id WHERE i.job_id = $1 ORDER BY i.id");
    expect(calls[1]?.values).toEqual([31]);
    expect(job).toEqual({
      jobId: 31, vendorId: 10, storeConnectionId: 5, platform: "ebay", environment: "sandbox", status: "failed",
      createdAt: NOW, updatedAt: NOW, completedAt: NOW,
      items: [{
        itemId: 1, listingId: 100, productVariantId: 101, sku: "ARM-ENV-SGL-P50", productName: "Armalope Envelope Single Pocket", variantName: "Pack of 50",
        status: "failed", errorCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", errorMessage: "eBay listing push failed with HTTP 400: 25002 Invalid value",
        retryable: false, externalListingId: null, published: null,
      }],
    });
  });

  it("reads an unknown environment as unknown, never as production", async () => {
    const { pool } = fakePool([result([{ ...jobRow, provider_environment: "staging" }]), result([])]);
    const job = await new PgDropshipListingPushStatusRepository(pool).loadVendorJob({ vendorId: 10, jobId: 31 });
    expect(job?.environment).toBeNull();
  });

  it("returns null without reading items when the vendor does not own the job", async () => {
    const { pool, calls } = fakePool([result([])]);
    expect(await new PgDropshipListingPushStatusRepository(pool).loadVendorJob({ vendorId: 10, jobId: 31 })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("refuses a stored row outside the contract instead of serving it", async () => {
    const { pool } = fakePool([result([jobRow]), result([{ ...itemRow, product_variant_id: "101" }])]);
    await expect(new PgDropshipListingPushStatusRepository(pool).loadVendorJob({ vendorId: 10, jobId: 31 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_STATUS_INVALID_ROW", context: { classification: "fatal", kind: "item" } });
  });
});
