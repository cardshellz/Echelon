import { describe, expect, it, vi } from "vitest";
import type {
  DropshipEbayStoreCategoryAssignment,
  DropshipEbayStoreCategoryContext,
  DropshipEbayStoreCategoryDirectory,
  DropshipEbayStoreCategoryRepository,
  ReplaceDropshipEbayStoreCategoryAssignmentRepositoryInput,
  ReplaceDropshipEbayStoreCategoryAssignmentRepositoryResult,
} from "../../application/dropship-ebay-store-category-service";
import {
  DropshipEbayStoreCategoryService,
  hashEbayStoreCategoryAssignment,
} from "../../application/dropship-ebay-store-category-service";
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

  it("persists canonical full paths instead of trusting client-provided names", async () => {
    const fixture = makeFixture();

    const result = await fixture.service.replaceForMember("member-1", {
      storeConnectionId: 44,
      productVariantId: 501,
      storeCategoryIds: ["22", "30"],
      idempotencyKey: "store-category-001",
    });

    expect(result).toMatchObject({ revisionId: 91, idempotentReplay: false });
    expect(fixture.repository.lastReplaceInput).toEqual({
      vendorId: 10,
      storeConnectionId: 44,
      productVariantId: 501,
      storeCategoryIds: ["22", "30"],
      storeCategoryNames: ["Supplies:Toploaders", "Clearance"],
      idempotencyKey: "store-category-001",
      requestHash: hashEbayStoreCategoryAssignment({
        storeConnectionId: 44,
        productVariantId: 501,
        storeCategoryIds: ["22", "30"],
        storeCategoryNames: ["Supplies:Toploaders", "Clearance"],
      }),
      actor: { actorType: "vendor", actorId: "member-1" },
      now: NOW,
    });
    expect(fixture.logs).toContainEqual(expect.objectContaining({
      code: "DROPSHIP_EBAY_STORE_CATEGORY_ASSIGNMENT_REPLACED",
      context: expect.objectContaining({ storeCategoryCount: 2, revisionId: 91 }),
    }));
  });

  it("rejects a stale or non-leaf category before any write", async () => {
    const fixture = makeFixture();

    await expect(fixture.service.replaceForMember("member-1", {
      storeConnectionId: 44,
      productVariantId: 501,
      storeCategoryIds: ["not-current"],
      idempotencyKey: "store-category-002",
    })).rejects.toMatchObject({ code: "DROPSHIP_EBAY_STORE_CATEGORY_INVALID" });
    expect(fixture.repository.lastReplaceInput).toBeNull();
  });

  it.each([
    ["shopify", "connected", "DROPSHIP_EBAY_STORE_REQUIRED"],
    ["ebay", "needs_reauth", "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED"],
  ])("blocks invalid store context platform=%s status=%s", async (platform, status, code) => {
    const fixture = makeFixture({ context: { platform, status } });

    await expect(fixture.service.listForMember("member-1", { storeConnectionId: 44 }))
      .rejects.toMatchObject({ code });
    expect(fixture.directory.lastInput).toBeNull();
  });

  it("rejects duplicate Store category choices at the input boundary", async () => {
    const fixture = makeFixture();

    await expect(fixture.service.replaceForMember("member-1", {
      storeConnectionId: 44,
      productVariantId: 501,
      storeCategoryIds: ["22", "22"],
      idempotencyKey: "store-category-003",
    })).rejects.toMatchObject({ name: "ZodError" });
    expect(fixture.directory.lastInput).toBeNull();
    expect(fixture.repository.lastReplaceInput).toBeNull();
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
  lastReplaceInput: ReplaceDropshipEbayStoreCategoryAssignmentRepositoryInput | null = null;

  async loadStoreContext(input: { vendorId: number; storeConnectionId: number }) {
    this.lastContextInput = input;
    return this.context;
  }

  async listAssignments() {
    return this.assignments;
  }

  async replaceAssignment(
    input: ReplaceDropshipEbayStoreCategoryAssignmentRepositoryInput,
  ): Promise<ReplaceDropshipEbayStoreCategoryAssignmentRepositoryResult> {
    this.lastReplaceInput = input;
    return {
      assignment: {
        productVariantId: input.productVariantId,
        storeCategoryIds: input.storeCategoryIds,
        storeCategoryNames: input.storeCategoryNames,
        updatedAt: input.now,
      },
      revisionId: 91,
      idempotentReplay: false,
    };
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
