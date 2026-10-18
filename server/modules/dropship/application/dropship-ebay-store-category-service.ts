import { DropshipError } from "../domain/errors";
import type { DropshipVendorProvisioningService } from "./dropship-vendor-provisioning-service";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import { listDropshipEbayStoreCategoriesForMemberInputSchema } from "./dropship-ebay-store-category-dtos";

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
    if (context.status === "needs_reauth") {
      throw new DropshipError(
        "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED",
        "The eBay authorization has expired or been revoked. Reauthorize the connected store to continue.",
        { vendorId, storeConnectionId, status: context.status, retryable: false },
      );
    }
    // A recoverable refresh failure must reach the shared credential owner.
    // Paused, disconnected, and revoked connections remain blocked.
    if (context.status !== "connected" && context.status !== "refresh_failed") {
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
