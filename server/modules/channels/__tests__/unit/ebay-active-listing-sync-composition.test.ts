import { beforeEach, describe, expect, it, vi } from "vitest";
import { storedEbayListingSyncJobSchema } from "../../ebay-listing-sync.domain";
import { ebayListingSyncJobSchema } from "@shared/types/ebay-listing-sync";

const fixture = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queued: [] as unknown[],
  failures: [] as Array<Record<string, unknown>>,
  products: [] as Array<{ id: number; name: string }>,
}));
vi.mock("../../../../db", () => ({
  pool: {},
  db: { select: (selection?: Record<string, unknown>) => {
    const query = {
      from: () => query, innerJoin: () => query, leftJoin: () => query, where: () => query,
      limit: async () => [{ id: 12, metadata: { marketplaceId: "EBAY_US" } }],
      orderBy: async () => fixture.rows,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(selection?.id ? fixture.products : []).then(resolve),
    };
    return query;
  } },
}));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({ EBAY_CHANNEL_ID: 67,
  getAuthService: () => ({ getVerifiedProviderAccount: async () => ({ externalAccountId: "seller" }) }),
  atpService: {}, ebayListingPhotoResolver: {},
}));
vi.mock("../../infrastructure/ebay-listing-sync.repository", () => ({ PostgresEbayListingSyncRepository: class {} }));
vi.mock("../../../inventory-planning/quantity-publication", () => ({ quantityProviderResponseRecovery: {} }));
vi.mock("../../ebay-listing-sync.service", async importOriginal => {
  const actual = await importOriginal<typeof import("../../ebay-listing-sync.service")>();
  return { ...actual, EbayListingSyncService: class {
    async enqueue(identity: { productId: number }, actor: string, key: string) {
      fixture.queued.push({ identity, actor, key });
      return storedEbayListingSyncJobSchema.parse({ id: key, productId: identity.productId, state: "queued", kind: "sync", code: null, message: null,
        nextAttemptAt: "2026-10-09T20:00:00.000Z", updatedAt: "2026-10-09T20:00:00.000Z", identity,
        revision: "1", claimedRevision: null, ownerToken: null, attempts: 0, result: null, verificationIntentHash: null, verificationRevision: null });
    }
    async recordAdmissionFailure(failure: Record<string, unknown>) {
      fixture.failures.push(failure);
      return ebayListingSyncJobSchema.parse({ id: failure.commandKey, productId: failure.productId, kind: "admission", state: "needs_attention",
        code: failure.code, message: failure.message, nextAttemptAt: "2026-10-09T20:00:00.000Z", updatedAt: "2026-10-09T20:00:00.000Z" });
    }
  } };
});
import { syncActiveListings } from "../../infrastructure/ebay-active-listing-sync";

function rows(productId: number, catalog: string, external: string, invalid = false) {
  return ["PACK", "CASE"].map((unit, index) => ({ product_id: productId, product_name: `Toploader ${productId}`, product_sku: catalog,
    product_is_active: true, variant_is_active: true, variant_sales_eligibility: "sellable",
    variant_id: productId * 10 + index, variant_sku: invalid ? null : `${catalog}-${unit}`, external_sku: `${external}-${unit}`,
    external_variant_id: `offer-${productId}-${index}`, external_product_id: `listing-${productId}` }));
}
beforeEach(() => {
  fixture.rows = [];
  fixture.queued = [];
  fixture.failures = [];
  fixture.products = [];
});

describe("active existing-listing selection to admission composition", () => {
  it("admits both renamed SKU/group examples without any provider discovery during the HTTP request", async () => {
    fixture.rows = [...rows(3, "SHLZ-TOP-180PT-CLR", "SHLZ-TOP-180PT"), ...rows(86, "SHLZ-TOP-TCG-SLIM-CLR", "SHLZ-TOP-40PT-SLIM")];
    const result = await syncActiveListings(null, "operator");
    expect(result).toMatchObject({ pending: 2, errors: 0 });
    expect(fixture.queued).toEqual([
      expect.objectContaining({ identity: expect.objectContaining({ productId: 3, groupKey: null,
        variants: [expect.objectContaining({ catalogSku: "SHLZ-TOP-180PT-CLR-PACK", sku: "SHLZ-TOP-180PT-PACK" }), expect.anything()] }) }),
      expect.objectContaining({ identity: expect.objectContaining({ productId: 86, groupKey: null,
        variants: [expect.objectContaining({ catalogSku: "SHLZ-TOP-TCG-SLIM-CLR-PACK", sku: "SHLZ-TOP-40PT-SLIM-PACK" }), expect.anything()] }) }),
    ]);
    expect(fixture.failures).toEqual([]);
  });

  it("does not let malformed middle-product rows abort a Sync All request before durable admission", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fixture.rows = [...rows(3, "CAT-3", "EBAY-3"), ...rows(20, "CAT-20", "EBAY-20", true), ...rows(86, "CAT-86", "EBAY-86")];
      const result = await syncActiveListings(null, "operator");
      expect(result).toMatchObject({ pending: 2, errors: 2 });
      expect(result.jobs.map(job => [job.productId, job.state])).toEqual([[3, "queued"], [20, "needs_attention"], [86, "queued"]]);
      expect(fixture.queued).toHaveLength(2);
      expect(fixture.failures).toEqual([expect.objectContaining({ productId: 20, variantIds: [200, 201], code: "EBAY_SYNC_MAPPING_INVALID" })]);
    } finally { errorLog.mockRestore(); }
  });

  it("records an existing but ineligible requested product and continues eligible products", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fixture.rows = rows(3, "CAT-3", "EBAY-3");
      fixture.products = [{ id: 86, name: "Excluded toploader" }];
      const result = await syncActiveListings({ productIds: [3, 86] }, "operator");
      expect(result).toMatchObject({ pending: 1, errors: 1 });
      expect(result.details).toEqual([expect.objectContaining({ productId: 86, productName: "Excluded toploader", code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE" })]);
      expect(fixture.failures).toEqual([expect.objectContaining({ productId: 86, variantIds: [], code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE" })]);
    } finally { errorLog.mockRestore(); }
  });

  it("reports a missing requested product without attempting a foreign-key-invalid admission journal", async () => {
    const result = await syncActiveListings({ productIds: [999] }, "operator", "00000000-0000-4000-8000-000000000001");
    expect(result).toMatchObject({ pending: 0, errors: 1, jobs: [], details: [{ productId: 999, code: "EBAY_SYNC_PRODUCT_NOT_FOUND" }] });
    expect(fixture.failures).toEqual([]);
    expect(fixture.queued).toEqual([]);
  });

  it("records an all-disabled product as an actionable admission rather than an update waiting to run", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fixture.rows = rows(3, "CAT-3", "EBAY-3").map(row => ({ ...row, variant_is_active: false }));
      const result = await syncActiveListings({ productIds: [3] }, "operator");
      expect(result).toMatchObject({ pending: 0, errors: 2, jobs: [{ productId: 3, kind: "admission", code: "EBAY_SYNC_CONTENT_SCOPE_EMPTY" }] });
      expect(fixture.queued).toEqual([]);
    } finally { errorLog.mockRestore(); }
  });
});
