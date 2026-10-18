import { describe, expect, it, vi } from "vitest";
import type {
  DropshipEbayStoreCategoryAssignment,
  DropshipEbayStoreCategoryContext,
  DropshipEbayStoreCategoryDirectory,
  DropshipEbayStoreCategoryRepository,
} from "../../application/dropship-ebay-store-category-service";
import { DropshipEbayStoreCategoryService } from "../../application/dropship-ebay-store-category-service";
import type { DropshipVendorProvisioningService } from "../../application/dropship-vendor-provisioning-service";

const NOW = new Date("2026-08-29T12:00:00.000Z");

describe("DropshipEbayStoreCategoryService", () => {
  it("lists live leaf categories and current assignments for the member-owned eBay store", async () => {
    const fixture = makeFixture();

    const result = await fixture.service.listForMember("member-1", { storeConnectionId: 44 });

    expect(result).toEqual({
      storeConnectionId: 44,
      categories: fixture.directory.categories,
      assignments: fixture.repository.assignments,
      fetchedAt: NOW,
    });
    expect(fixture.repository.lastContextInput).toEqual({ vendorId: 10, storeConnectionId: 44 });
    expect(fixture.directory.lastInput).toEqual({ vendorId: 10, storeConnectionId: 44 });
  });

  it.each([
    ["shopify", "connected", "DROPSHIP_EBAY_STORE_REQUIRED"],
    ["ebay", "needs_reauth", "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED"],
    ["ebay", "paused", "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED"],
    ["ebay", "disconnected", "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED"],
    ["ebay", "grace_period", "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED"],
  ])("blocks invalid store context platform=%s status=%s", async (platform, status, code) => {
    const fixture = makeFixture({ context: { platform, status } });

    await expect(fixture.service.listForMember("member-1", { storeConnectionId: 44 }))
      .rejects.toMatchObject({ code });
    expect(fixture.directory.lastInput).toBeNull();
  });

  it("allows recoverable token health to reach automatic category credential recovery", async () => {
    const fixture = makeFixture({ context: { status: "refresh_failed" } });
    await expect(fixture.service.listForMember("member-1", { storeConnectionId: 44 }))
      .resolves.toMatchObject({ storeConnectionId: 44 });
    expect(fixture.directory.lastInput).toEqual({ vendorId: 10, storeConnectionId: 44 });
  });

  it("records a safe operational warning when eBay category retrieval fails", async () => {
    const fixture = makeFixture();
    fixture.directory.error = Object.assign(new Error("provider unavailable"), {
      code: "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE",
    });

    await expect(fixture.service.listForMember("member-1", { storeConnectionId: 44 }))
      .rejects.toThrow("provider unavailable");
    expect(fixture.warnings).toContainEqual(expect.objectContaining({
      code: "DROPSHIP_EBAY_STORE_CATEGORIES_LOAD_FAILED",
      context: expect.objectContaining({ storeConnectionId: 44 }),
    }));
    expect(JSON.stringify(fixture.warnings)).not.toContain("provider unavailable");
  });
});

class FakeRepository implements DropshipEbayStoreCategoryRepository {
  context: DropshipEbayStoreCategoryContext | null = {
    vendorId: 10,
    storeConnectionId: 44,
    platform: "ebay",
    status: "connected",
  };
  assignments: DropshipEbayStoreCategoryAssignment[] = [{
    productVariantId: 501,
    storeCategoryIds: ["22"],
    storeCategoryNames: ["Supplies:Toploaders"],
    updatedAt: NOW,
  }];
  lastContextInput: unknown = null;

  async loadStoreContext(input: { vendorId: number; storeConnectionId: number }) {
    this.lastContextInput = input;
    return this.context;
  }

  async listAssignments() {
    return this.assignments;
  }
}

class FakeDirectory implements DropshipEbayStoreCategoryDirectory {
  categories = [
    { categoryId: "22", categoryName: "Toploaders", path: "Supplies:Toploaders", level: 2 },
    { categoryId: "30", categoryName: "Clearance", path: "Clearance", level: 1 },
  ];
  lastInput: unknown = null;
  error: Error | null = null;

  async listLeafCategories(input: { vendorId: number; storeConnectionId: number }) {
    this.lastInput = input;
    if (this.error) throw this.error;
    return this.categories;
  }
}

function makeFixture(overrides?: { context?: Partial<DropshipEbayStoreCategoryContext> }) {
  const repository = new FakeRepository();
  if (overrides?.context) repository.context = { ...repository.context!, ...overrides.context };
  const directory = new FakeDirectory();
  const logs: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const vendorProvisioning = {
    provisionForMember: vi.fn(async (memberId: string) => ({
      vendor: { vendorId: 10, memberId },
      created: false,
      changedFields: [],
    })),
  } as unknown as DropshipVendorProvisioningService;
  const service = new DropshipEbayStoreCategoryService({
    vendorProvisioning,
    repository,
    directory,
    clock: { now: () => NOW },
    logger: {
      info: (event) => logs.push(event as unknown as Record<string, unknown>),
      warn: (event) => warnings.push(event as unknown as Record<string, unknown>),
      error: vi.fn(),
    },
  });
  return { service, repository, directory, logs, warnings };
}
