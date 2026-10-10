import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DROPSHIP_COST_CHANGE_POLICY } from "../../../../../shared/dropship/cost-change-policy";
import { refreshQueuedListingIntent } from "../../application/dropship-listing-intent-refresh";
import type { DropshipListingPreviewResult, DropshipListingPreviewRow } from "../../application/dropship-listing-preview-service";
import type { DropshipListingIntentRefreshInput } from "../../application/dropship-listing-push-worker-service";
import type { DropshipMarketplaceListingIntent } from "../../application/dropship-marketplace-listing-provider";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type { GenerateVendorListingPreviewInput } from "../../application/dropship-use-case-dtos";

const QUEUED = { categoryId: "183438", categoryName: "Card Toploaders & Holders" };

const baseInput: DropshipListingIntentRefreshInput = {
  jobId: 30, jobItemId: 1, vendorId: 10, storeConnectionId: 22, productVariantId: 101,
  queuedPriceCents: 1299, queuedMarketplaceCategory: QUEUED,
};

function intent(overrides: Partial<DropshipMarketplaceListingIntent> = {}): DropshipMarketplaceListingIntent {
  return { platform: "ebay", productVariantId: 101, sku: "SKU-101", priceCents: 1299, quantity: 7,
    marketplaceCategoryId: "261328", marketplaceCategoryName: "Toploaders", ...overrides } as DropshipMarketplaceListingIntent;
}

function row(overrides: Partial<DropshipListingPreviewRow> = {}): DropshipListingPreviewRow {
  return { productVariantId: 101, previewStatus: "ready", blockers: [], listingIntent: intent(), ...overrides } as DropshipListingPreviewRow;
}

function setup(options: { rows?: DropshipListingPreviewRow[]; rulePricedListings?: "reprice_automatically" | "wait_for_review" } = {}) {
  const previewInputs: GenerateVendorListingPreviewInput[] = [];
  const logs: DropshipLogEvent[] = [];
  const deps = {
    generatePreview: vi.fn(async (input: GenerateVendorListingPreviewInput) => {
      previewInputs.push(input);
      return { vendorId: 10, storeConnectionId: 22, platform: "ebay", rows: options.rows ?? [row()] } as unknown as DropshipListingPreviewResult;
    }),
    resolveCostChangePolicy: vi.fn(async () => ({
      policyId: null,
      settings: { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY, rulePricedListings: options.rulePricedListings ?? "reprice_automatically" },
    })),
    logger: { info: (event: DropshipLogEvent) => logs.push(event), warn: (event: DropshipLogEvent) => logs.push(event),
      error: (event: DropshipLogEvent) => logs.push(event) },
  };
  return { deps, previewInputs, logs };
}

describe("refreshQueuedListingIntent", () => {
  it("builds the preview for the one listing, with the queued category under its variant key, and returns the fresh intent", async () => {
    const { deps, previewInputs } = setup();

    const result = await refreshQueuedListingIntent(deps, baseInput);

    expect(previewInputs).toEqual([{ vendorId: 10, storeConnectionId: 22, productVariantIds: [101],
      actor: { actorType: "system", actorId: "inventory_publication_catchup" },
      queuedEbayCategoriesByVariantId: { "101": QUEUED } }]);
    expect(result).toMatchObject({ marketplaceCategoryId: "261328", quantity: 7 });
  });

  it("sends no queued category when the item carried none", async () => {
    const { deps, previewInputs } = setup();

    await refreshQueuedListingIntent(deps, { ...baseInput, queuedMarketplaceCategory: null });

    expect(previewInputs[0]).not.toHaveProperty("queuedEbayCategoriesByVariantId");
  });

  it("logs, with the job's ids, when the queued category is published because the rules name none now", async () => {
    const { deps, logs } = setup({ rows: [row({ marketplaceCategoryFallback: "queued",
      listingIntent: intent({ marketplaceCategoryId: QUEUED.categoryId, marketplaceCategoryName: QUEUED.categoryName }) })] });

    const result = await refreshQueuedListingIntent(deps, baseInput);

    expect(result.marketplaceCategoryId).toBe("183438");
    expect(logs).toEqual([expect.objectContaining({
      code: "DROPSHIP_LISTING_PUSH_QUEUED_CATEGORY_KEPT",
      context: { jobId: 30, jobItemId: 1, vendorId: 10, storeConnectionId: 22, productVariantId: 101, categoryId: "183438" },
    })]);
  });

  it("logs nothing when the rules name a category now", async () => {
    const { deps, logs } = setup();

    await refreshQueuedListingIntent(deps, baseInput);

    expect(logs).toEqual([]);
  });

  it("refuses a blocked listing as retryable and names why it is blocked", async () => {
    const { deps } = setup({ rows: [row({ previewStatus: "blocked", listingIntent: null, blockers: ["ebay_browse_category_required"] })] });

    await expect(refreshQueuedListingIntent(deps, baseInput)).rejects.toMatchObject({
      code: "DROPSHIP_CURRENT_LISTING_INTENT_BLOCKED",
      context: { productVariantId: 101, blockers: ["ebay_browse_category_required"], retryable: true },
    });
    expect(deps.resolveCostChangePolicy).not.toHaveBeenCalled();
  });

  it("refuses when the preview has no row for the listing", async () => {
    const { deps } = setup({ rows: [row({ productVariantId: 999 })] });

    await expect(refreshQueuedListingIntent(deps, baseInput)).rejects.toMatchObject({
      code: "DROPSHIP_CURRENT_LISTING_INTENT_BLOCKED",
      context: { productVariantId: 101, blockers: [], retryable: true },
    });
  });

  it("fails for good when a rule price moved since queueing and the policy waits for review", async () => {
    const { deps } = setup({ rulePricedListings: "wait_for_review",
      rows: [row({ rulePriceEvidenceHash: "a".repeat(64), listingIntent: intent({ priceCents: 1499 }) })] });

    await expect(refreshQueuedListingIntent(deps, baseInput)).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW",
      context: { productVariantId: 101, queuedPriceCents: 1299, currentPriceCents: 1499, retryable: false, classification: "permanent" },
    });
  });

  it("waits for review when a size that follows the store's pricing fell back to retail since queueing", async () => {
    // Queued at the rule price ($12.99); the rules cannot price it now, so it is on retail ($14.99) with no rule evidence.
    const { deps } = setup({ rulePricedListings: "wait_for_review",
      rows: [row({ followsStorePricing: true, listingIntent: intent({ priceCents: 1499 }) })] });

    await expect(refreshQueuedListingIntent(deps, baseInput)).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW",
      context: { queuedPriceCents: 1299, currentPriceCents: 1499, followsStorePricing: true, classification: "permanent" },
    });
  });

  it("publishes a size that follows the store's pricing when its price did not move", async () => {
    const { deps } = setup({ rulePricedListings: "wait_for_review", rows: [row({ followsStorePricing: true })] });

    await expect(refreshQueuedListingIntent(deps, baseInput)).resolves.toMatchObject({ priceCents: 1299 });
  });

  it("publishes a moved price for a size with a price of its own: only rule-owned prices wait", async () => {
    const { deps } = setup({ rulePricedListings: "wait_for_review", rows: [row({ listingIntent: intent({ priceCents: 1499 }) })] });

    await expect(refreshQueuedListingIntent(deps, baseInput)).resolves.toMatchObject({ priceCents: 1499 });
  });

  it("publishes a moved rule price when the policy reprices automatically", async () => {
    const { deps } = setup({ rows: [row({ rulePriceEvidenceHash: "a".repeat(64), listingIntent: intent({ priceCents: 1499 }) })] });

    await expect(refreshQueuedListingIntent(deps, baseInput)).resolves.toMatchObject({ priceCents: 1499 });
  });
});
