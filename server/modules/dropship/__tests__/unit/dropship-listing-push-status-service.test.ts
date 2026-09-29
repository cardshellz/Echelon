import { describe, expect, it } from "vitest";
import {
  DropshipListingPushStatusService,
  marketplaceListingUrl,
  type DropshipListingPushStatusRepository,
  type VendorListingPushItemRecord,
  type VendorListingPushJobRecord,
} from "../../application/dropship-listing-push-status-service";

const NOW = new Date("2026-09-28T17:55:00.000Z");

function item(patch: Partial<VendorListingPushItemRecord> = {}): VendorListingPushItemRecord {
  return {
    itemId: 1, listingId: 100, productVariantId: 101, sku: "ARM-ENV-SGL-P50", productName: "Armalope Envelope Single Pocket",
    variantName: "Pack of 50", status: "completed", errorCode: null, errorMessage: null, retryable: null, externalListingId: "123456789012",
    published: true,
    ...patch,
  };
}

function job(patch: Partial<VendorListingPushJobRecord> = {}): VendorListingPushJobRecord {
  return {
    jobId: 31, vendorId: 10, storeConnectionId: 5, platform: "ebay", environment: "production", status: "completed",
    createdAt: NOW, updatedAt: NOW, completedAt: NOW, items: [item()], ...patch,
  };
}

class FakeRepository implements DropshipListingPushStatusRepository {
  vendorId: number | null = 10;
  jobs = new Map<string, VendorListingPushJobRecord>();
  calls: unknown[] = [];

  async findVendorIdByMemberId(memberId: string): Promise<number | null> {
    this.calls.push(["vendor", memberId]);
    return this.vendorId;
  }

  async loadVendorJob(input: { vendorId: number; jobId: number }): Promise<VendorListingPushJobRecord | null> {
    this.calls.push(["job", input]);
    return this.jobs.get(`${input.vendorId}:${input.jobId}`) ?? null;
  }
}

describe("DropshipListingPushStatusService", () => {
  it("returns the vendor's own job, finished, with a public page for the listing this push put live", async () => {
    const repository = new FakeRepository();
    repository.jobs.set("10:31", job());
    const service = new DropshipListingPushStatusService({ repository });

    const result = await service.getForMember("member-5", 31);

    expect(result).toEqual({
      jobId: 31, storeConnectionId: 5, platform: "ebay", environment: "production", status: "completed", finished: true,
      createdAt: NOW, updatedAt: NOW, completedAt: NOW,
      items: [{ ...item(), listingUrl: "https://www.ebay.com/itm/123456789012" }],
    });
    expect(result).not.toHaveProperty("vendorId");
    expect(repository.calls).toEqual([["vendor", "member-5"], ["job", { vendorId: 10, jobId: 31 }]]);
  });

  it("reads another vendor's job, or a member with no vendor, as not found", async () => {
    const repository = new FakeRepository();
    repository.jobs.set("11:31", job({ vendorId: 11 }));
    const service = new DropshipListingPushStatusService({ repository });

    await expect(service.getForMember("member-5", 31)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_JOB_NOT_FOUND" });

    repository.vendorId = null;
    repository.calls = [];
    await expect(service.getForMember("member-5", 31)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_JOB_NOT_FOUND" });
    expect(repository.calls).toEqual([["vendor", "member-5"]]);
  });

  it("rejects a missing member or an invalid job id before any read", async () => {
    const repository = new FakeRepository();
    const service = new DropshipListingPushStatusService({ repository });

    await expect(service.getForMember("", 31)).rejects.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
    for (const bad of [0, -1, 1.5, Number.NaN, "31", 2_147_483_648]) {
      await expect(service.getForMember("member-5", bad)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_JOB_INVALID" });
    }
    expect(repository.calls).toEqual([]);
  });

  it("is unfinished while the worker still runs, and links only listings that completed", async () => {
    const repository = new FakeRepository();
    repository.jobs.set("10:31", job({
      status: "processing", completedAt: null,
      items: [
        item({ itemId: 1, status: "processing", externalListingId: null }),
        item({ itemId: 2, status: "failed", errorCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
          errorMessage: "eBay listing push failed with HTTP 400: 25002 Invalid value", retryable: false, externalListingId: "123456789012" }),
      ],
    }));
    const service = new DropshipListingPushStatusService({ repository });

    const result = await service.getForMember("member-5", 31);

    expect(result.finished).toBe(false);
    expect(result.items.map((row) => [row.status, row.listingUrl])).toEqual([["processing", null], ["failed", null]]);
  });
});

describe("marketplaceListingUrl", () => {
  it("forms a public page only from an eBay item id", () => {
    expect(marketplaceListingUrl("ebay", "123456789012", "production")).toBe("https://www.ebay.com/itm/123456789012");
    expect(marketplaceListingUrl("ebay", "123456789012", null)).toBe("https://www.ebay.com/itm/123456789012");
    expect(marketplaceListingUrl("ebay", "offer:abc:publish", "production")).toBeNull();
    expect(marketplaceListingUrl("ebay", null, "production")).toBeNull();
    expect(marketplaceListingUrl("shopify", "gid://shopify/Product/900", null)).toBeNull();
    expect(marketplaceListingUrl("shopify", "123456789012", null)).toBeNull();
  });

  it("points a sandbox store's listing at eBay's test site, where it actually lives", () => {
    expect(marketplaceListingUrl("ebay", "123456789012", "sandbox")).toBe("https://sandbox.ebay.com/itm/123456789012");
  });

  it("gives a draft no page: the id held is the offer, not a listing", async () => {
    const repository = new FakeRepository();
    repository.jobs.set("10:31", job({ environment: "sandbox", items: [item({ published: false }), item({ itemId: 2, published: null })] }));
    const result = await new DropshipListingPushStatusService({ repository }).getForMember("member-5", 31);
    expect(result.environment).toBe("sandbox");
    expect(result.items.map((row) => row.listingUrl)).toEqual([null, "https://sandbox.ebay.com/itm/123456789012"]);
  });
});
