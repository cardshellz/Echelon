import { createHash } from "crypto";
import { DropshipError } from "../domain/errors";
import type { DropshipVendorProvisioningService } from "./dropship-vendor-provisioning-service";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import {
  listDropshipEbayStoreCategoriesForMemberInputSchema,
  replaceDropshipEbayStoreCategoryAssignmentForMemberInputSchema,
} from "./dropship-ebay-store-category-dtos";

export interface DropshipEbayStoreCategory {
  categoryId: string;
  categoryName: string;
  path: string;
  level: number;
}

export interface DropshipEbayStoreCategoryAssignment {
  productVariantId: number;
  storeCategoryIds: string[];
  storeCategoryNames: string[];
  updatedAt: Date;
}

export interface DropshipEbayStoreCategoryContext {
  vendorId: number;
  storeConnectionId: number;
  platform: string;
  status: string;
}

export interface ReplaceDropshipEbayStoreCategoryAssignmentRepositoryInput {
  vendorId: number;
  storeConnectionId: number;
  productVariantId: number;
  storeCategoryIds: string[];
  storeCategoryNames: string[];
  idempotencyKey: string;
  requestHash: string;
  actor: {
    actorType: "vendor" | "admin" | "system";
    actorId: string | null;
  };
  now: Date;
}

export interface ReplaceDropshipEbayStoreCategoryAssignmentRepositoryResult {
  assignment: DropshipEbayStoreCategoryAssignment | null;
  revisionId: number;
  idempotentReplay: boolean;
}

export interface DropshipEbayStoreCategoryRepository {
  loadStoreContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipEbayStoreCategoryContext | null>;
  listAssignments(input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantIds?: readonly number[];
  }): Promise<DropshipEbayStoreCategoryAssignment[]>;
  replaceAssignment(
    input: ReplaceDropshipEbayStoreCategoryAssignmentRepositoryInput,
  ): Promise<ReplaceDropshipEbayStoreCategoryAssignmentRepositoryResult>;
}

export interface DropshipEbayStoreCategoryDirectory {
  listLeafCategories(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipEbayStoreCategory[]>;
}

export interface DropshipEbayStoreCategoryServiceDependencies {
  vendorProvisioning: DropshipVendorProvisioningService;
  repository: DropshipEbayStoreCategoryRepository;
  directory: DropshipEbayStoreCategoryDirectory;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export class DropshipEbayStoreCategoryService {
  constructor(private readonly deps: DropshipEbayStoreCategoryServiceDependencies) {}

  async listForMember(memberId: string, input: unknown): Promise<{
    storeConnectionId: number;
    categories: DropshipEbayStoreCategory[];
    assignments: DropshipEbayStoreCategoryAssignment[];
    fetchedAt: Date;
  }> {
    const parsed = listDropshipEbayStoreCategoriesForMemberInputSchema.parse(input);
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    await this.requireConnectedEbayStore(vendor.vendorId, parsed.storeConnectionId);
    const [categories, assignments] = await Promise.all([
      this.loadLeafCategories(vendor.vendorId, parsed.storeConnectionId),
      this.deps.repository.listAssignments({
        vendorId: vendor.vendorId,
        storeConnectionId: parsed.storeConnectionId,
      }),
    ]);
    return {
      storeConnectionId: parsed.storeConnectionId,
      categories,
      assignments,
      fetchedAt: this.deps.clock.now(),
    };
  }

  async replaceForMember(memberId: string, input: unknown): Promise<
    ReplaceDropshipEbayStoreCategoryAssignmentRepositoryResult
  > {
    const parsed = replaceDropshipEbayStoreCategoryAssignmentForMemberInputSchema.parse(input);
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    await this.requireConnectedEbayStore(vendor.vendorId, parsed.storeConnectionId);

    const categories = await this.loadLeafCategories(vendor.vendorId, parsed.storeConnectionId);
    const categoriesById = new Map(categories.map((category) => [category.categoryId, category]));
    const selectedCategories = parsed.storeCategoryIds.map((categoryId) => {
      const category = categoriesById.get(categoryId);
      if (!category) {
        throw new DropshipError(
          "DROPSHIP_EBAY_STORE_CATEGORY_INVALID",
          "Select a current leaf category from the connected eBay Store.",
          {
            storeConnectionId: parsed.storeConnectionId,
            productVariantId: parsed.productVariantId,
            categoryId,
          },
        );
      }
      return category;
    });
    const storeCategoryIds = selectedCategories.map((category) => category.categoryId);
    const storeCategoryNames = selectedCategories.map((category) => category.path);
    const requestHash = hashEbayStoreCategoryAssignment({
      storeConnectionId: parsed.storeConnectionId,
      productVariantId: parsed.productVariantId,
      storeCategoryIds,
      storeCategoryNames,
    });
    const result = await this.deps.repository.replaceAssignment({
      vendorId: vendor.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      productVariantId: parsed.productVariantId,
      storeCategoryIds,
      storeCategoryNames,
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
      actor: { actorType: "vendor", actorId: memberId },
      now: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: result.idempotentReplay
        ? "DROPSHIP_EBAY_STORE_CATEGORY_ASSIGNMENT_REPLAYED"
        : "DROPSHIP_EBAY_STORE_CATEGORY_ASSIGNMENT_REPLACED",
      message: result.idempotentReplay
        ? "eBay Store category assignment replayed by idempotency key."
        : "eBay Store category assignment replaced.",
      context: {
        vendorId: vendor.vendorId,
        storeConnectionId: parsed.storeConnectionId,
        productVariantId: parsed.productVariantId,
        storeCategoryCount: storeCategoryIds.length,
        revisionId: result.revisionId,
      },
    });
    return result;
  }

  private async requireConnectedEbayStore(
    vendorId: number,
    storeConnectionId: number,
  ): Promise<DropshipEbayStoreCategoryContext> {
    const context = await this.deps.repository.loadStoreContext({ vendorId, storeConnectionId });
    if (!context) {
      throw new DropshipError(
        "DROPSHIP_STORE_CONNECTION_REQUIRED",
        "Dropship store connection was not found.",
        { vendorId, storeConnectionId },
      );
    }
    if (context.platform !== "ebay") {
      throw new DropshipError(
        "DROPSHIP_EBAY_STORE_REQUIRED",
        "eBay Store categories are available only for an eBay connection.",
        { vendorId, storeConnectionId, platform: context.platform },
      );
    }
    if (context.status !== "connected") {
      throw new DropshipError(
        "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED",
        "Reconnect the eBay store before loading or changing Store categories.",
        { vendorId, storeConnectionId, status: context.status },
      );
    }
    return context;
  }

  private async loadLeafCategories(
    vendorId: number,
    storeConnectionId: number,
  ): Promise<DropshipEbayStoreCategory[]> {
    try {
      return await this.deps.directory.listLeafCategories({ vendorId, storeConnectionId });
    } catch (error) {
      this.deps.logger.warn({
        code: "DROPSHIP_EBAY_STORE_CATEGORIES_LOAD_FAILED",
        message: "Connected eBay Store categories could not be loaded.",
        context: {
          vendorId,
          storeConnectionId,
          errorCode: error instanceof DropshipError ? error.code : undefined,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      });
      throw error;
    }
  }
}

export function hashEbayStoreCategoryAssignment(input: {
  storeConnectionId: number;
  productVariantId: number;
  storeCategoryIds: readonly string[];
  storeCategoryNames: readonly string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    storeConnectionId: input.storeConnectionId,
    productVariantId: input.productVariantId,
    storeCategoryIds: input.storeCategoryIds,
    storeCategoryNames: input.storeCategoryNames,
  })).digest("hex");
}
