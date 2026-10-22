import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

import {
  checkPreviewAnswerSchema,
  toCheckRow,
} from "../../../../../client/src/lib/dropship-catalog-publish";
import { toDropshipVendorListingPreview } from "../../application/dropship-listing-dtos";
import { GOLDEN_PREVIEW_STORES } from "../fixtures/listing-preview-golden.fixture";
import { mockGoldenCostSource, runGoldenPreview, VARIANT_IDS } from "../fixtures/listing-preview-golden.harness";

/**
 * Step 3's Check (step 1 plan S2-5, PR A, §4.10) reads `POST
 * /api/dropship/listings/preview` with a schema the page owns
 * (`checkPreviewAnswerSchema`), because the server's preview row is a
 * TypeScript interface with no outbound Zod schema. This feeds the server's
 * own preview (the golden stores, through the vendor transport boundary the
 * route answers with) into the page's schema, so a change of a field's type on
 * the server fails here instead of turning every Check chunk into "site
 * updating" with every test green (review round 2 CT10).
 */
beforeEach(() => {
  mockGoldenCostSource();
});
afterEach(() => vi.restoreAllMocks());

describe("the Check's preview schema against the server's preview answer", () => {
  for (const store of GOLDEN_PREVIEW_STORES) {
    it(`reads every row the server answers for store ${store.context.storeConnectionId}`, async () => {
      const { preview } = await runGoldenPreview(store);
      // What the preview route sends: the vendor transport shape, through JSON.
      const answer = JSON.parse(JSON.stringify({ preview: toDropshipVendorListingPreview(preview) })) as unknown;
      const parsed = checkPreviewAnswerSchema.safeParse(answer);
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 5))).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.preview.rows.map((row) => row.productVariantId)).toEqual(preview.rows.map((row) => row.productVariantId));
      expect(parsed.data.preview.rows.length).toBe(VARIANT_IDS.length);
      // The light row keeps what step 3's table and the counts read, and drops the listing's content.
      for (const row of parsed.data.preview.rows) {
        const light = toCheckRow(row);
        const server = preview.rows.find((candidate) => candidate.productVariantId === row.productVariantId)!;
        expect(light).toMatchObject({
          productVariantId: server.productVariantId, sku: server.sku, title: server.title, previewStatus: server.previewStatus,
          blockers: server.blockers, warnings: server.warnings, priceCents: server.priceCents,
          marketplaceQuantity: server.marketplaceQuantity, previewHash: server.previewHash,
        });
        expect(light).not.toHaveProperty("presentation");
        expect(light).not.toHaveProperty("listingIntent");
      }
    });
  }

  it("fails when the server's row changes a field's type the Check reads", async () => {
    const { preview } = await runGoldenPreview(GOLDEN_PREVIEW_STORES[0]);
    const answer = JSON.parse(JSON.stringify({ preview: toDropshipVendorListingPreview(preview) })) as {
      preview: { rows: Array<Record<string, unknown>> };
    };
    answer.preview.rows[0].marketplaceQuantity = null;
    expect(checkPreviewAnswerSchema.safeParse(answer).success).toBe(false);
  });
});
