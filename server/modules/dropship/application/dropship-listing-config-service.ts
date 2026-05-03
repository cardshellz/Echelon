import type { DropshipSourcePlatform, DropshipStoreConnectionStatus } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type {
  DropshipListingInventoryMode,
  DropshipListingMode,
  DropshipListingPriceMode,
  DropshipStoreListingConfig,
} from "./dropship-marketplace-listing-provider";
import {
  replaceDropshipStoreListingConfigInputSchema,
  type ReplaceDropshipStoreListingConfigInput,
} from "./dropship-listing-config-dtos";
import type {
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "./dropship-vendor-provisioning-service";

export const DROPSHIP_DEFAULT_LISTING_MODE: DropshipListingMode = "draft_first";
export const DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE: DropshipListingInventoryMode = "managed_quantity_sync";
export const DROPSHIP_DEFAULT_LISTING_PRICE_MODE: DropshipListingPriceMode = "vendor_defined";

export interface DropshipListingConfigStoreConnectionContext {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  status: DropshipStoreConnectionStatus;
  setupStatus: string;
}

export interface DropshipListingConfigActor {
  actorType: "vendor" | "admin" | "system";
  actorId: string | null;
}

export interface DropshipStoreListingConfigRecord extends DropshipStoreListingConfig {
  createdAt: Date;
  updatedAt: Date;
}

export interface ReplaceDropshipStoreListingConfigRepositoryInput {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  config: NormalizedDropshipStoreListingConfigInput;
  actor: DropshipListingConfigActor;
  now: Date;
}

export interface EnsureDropshipStoreListingConfigRepositoryInput {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  actor: DropshipListingConfigActor;
  now: Date;
}

export interface DropshipListingConfigRepository {
  loadStoreConnectionContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipListingConfigStoreConnectionContext | null>;
  loadStoreConnectionContextById(input: {
    storeConnectionId: number;
  }): Promise<DropshipListingConfigStoreConnectionContext | null>;
  ensureDefaultConfig(
    input: EnsureDropshipStoreListingConfigRepositoryInput,
  ): Promise<DropshipStoreListingConfigRecord>;
  replaceConfig(
    input: ReplaceDropshipStoreListingConfigRepositoryInput,
  ): Promise<DropshipStoreListingConfigRecord>;
}

export interface DropshipListingConfigServiceDependencies {
  vendorProvisioning: DropshipVendorProvisioningService;
  repository: DropshipListingConfigRepository;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export type NormalizedDropshipStoreListingConfigInput = ReplaceDropshipStoreListingConfigInput;

export class DropshipListingConfigService {
  constructor(private readonly deps: DropshipListingConfigServiceDependencies) {}

  async getForMember(memberId: string, storeConnectionId: number): Promise<{
    vendor: DropshipProvisionedVendorProfile;
    storeConnection: DropshipListingConfigStoreConnectionContext;
    config: DropshipStoreListingConfigRecord;
  }> {
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    assertVendorCanManageListingConfig(vendor);
    const storeConnection = await this.requireStoreConnection(vendor.vendorId, storeConnectionId);
    const config = await this.deps.repository.ensureDefaultConfig({
      vendorId: vendor.vendorId,
      storeConnectionId,
      platform: storeConnection.platform,
      actor: { actorType: "vendor", actorId: memberId },
      now: this.deps.clock.now(),
    });

    return { vendor, storeConnection, config };
  }

  async getForAdmin(storeConnectionId: number, actor: DropshipListingConfigActor): Promise<{
    storeConnection: DropshipListingConfigStoreConnectionContext;
    config: DropshipStoreListingConfigRecord;
  }> {
    const storeConnection = await this.requireStoreConnectionForAdmin(storeConnectionId);
    const config = await this.deps.repository.ensureDefaultConfig({
      vendorId: storeConnection.vendorId,
      storeConnectionId,
      platform: storeConnection.platform,
      actor,
      now: this.deps.clock.now(),
    });

    return { storeConnection, config };
  }

  async replaceForMember(memberId: string, storeConnectionId: number, input: unknown): Promise<{
    vendor: DropshipProvisionedVendorProfile;
    storeConnection: DropshipListingConfigStoreConnectionContext;
    config: DropshipStoreListingConfigRecord;
  }> {
    const parsed = replaceDropshipStoreListingConfigInputSchema.parse(input);
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    assertVendorCanManageListingConfig(vendor);
    const storeConnection = await this.requireStoreConnection(vendor.vendorId, storeConnectionId);
    if (storeConnection.status === "disconnected") {
      throw new DropshipError(
        "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED",
        "Disconnected store connections cannot be updated for dropship listing configuration.",
        { vendorId: vendor.vendorId, storeConnectionId },
      );
    }

    const config = await this.deps.repository.replaceConfig({
      vendorId: vendor.vendorId,
      storeConnectionId,
      platform: storeConnection.platform,
      config: normalizeListingConfigInput(parsed),
      actor: { actorType: "vendor", actorId: memberId },
      now: this.deps.clock.now(),
    });

    this.deps.logger.info({
      code: "DROPSHIP_LISTING_CONFIG_REPLACED",
      message: "Dropship store listing configuration replaced.",
      context: {
        vendorId: vendor.vendorId,
        storeConnectionId,
        platform: storeConnection.platform,
        listingMode: config.listingMode,
        inventoryMode: config.inventoryMode,
        priceMode: config.priceMode,
        isActive: config.isActive,
      },
    });

    return { vendor, storeConnection, config };
  }

  async replaceForAdmin(
    storeConnectionId: number,
    input: unknown,
    actor: DropshipListingConfigActor,
  ): Promise<{
    storeConnection: DropshipListingConfigStoreConnectionContext;
    config: DropshipStoreListingConfigRecord;
  }> {
    const parsed = replaceDropshipStoreListingConfigInputSchema.parse(input);
    const storeConnection = await this.requireStoreConnectionForAdmin(storeConnectionId);
    if (storeConnection.status === "disconnected") {
      throw new DropshipError(
        "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED",
        "Disconnected store connections cannot be updated for dropship listing configuration.",
        { vendorId: storeConnection.vendorId, storeConnectionId },
      );
    }

    const config = await this.deps.repository.replaceConfig({
      vendorId: storeConnection.vendorId,
      storeConnectionId,
      platform: storeConnection.platform,
      config: normalizeListingConfigInput(parsed),
      actor,
      now: this.deps.clock.now(),
    });

    this.deps.logger.info({
      code: "DROPSHIP_LISTING_CONFIG_REPLACED",
      message: "Dropship store listing configuration replaced.",
      context: {
        vendorId: storeConnection.vendorId,
        storeConnectionId,
        platform: storeConnection.platform,
        listingMode: config.listingMode,
        inventoryMode: config.inventoryMode,
        priceMode: config.priceMode,
        isActive: config.isActive,
        actorType: actor.actorType,
      },
    });

    return { storeConnection, config };
  }

  private async requireStoreConnection(
    vendorId: number,
    storeConnectionId: number,
  ): Promise<DropshipListingConfigStoreConnectionContext> {
    const storeConnection = await this.deps.repository.loadStoreConnectionContext({
      vendorId,
      storeConnectionId,
    });
    if (!storeConnection) {
      throw new DropshipError(
        "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
        "Dropship store connection was not found.",
        { vendorId, storeConnectionId },
      );
    }
    return storeConnection;
  }

  private async requireStoreConnectionForAdmin(
    storeConnectionId: number,
  ): Promise<DropshipListingConfigStoreConnectionContext> {
    const storeConnection = await this.deps.repository.loadStoreConnectionContextById({
      storeConnectionId,
    });
    if (!storeConnection) {
      throw new DropshipError(
        "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
        "Dropship store connection was not found.",
        { storeConnectionId },
      );
    }
    return storeConnection;
  }
}

export function buildDefaultDropshipStoreListingConfig(
  platform: DropshipSourcePlatform,
): NormalizedDropshipStoreListingConfigInput & { platform: DropshipSourcePlatform } {
  if (platform === "ebay") {
    return {
      platform,
      listingMode: DROPSHIP_DEFAULT_LISTING_MODE,
      inventoryMode: DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
      priceMode: DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
      marketplaceConfig: {},
      requiredConfigKeys: [
        "marketplaceId",
        "categoryId",
        "merchantLocationKey",
        "businessPolicies.paymentPolicyId",
        "businessPolicies.returnPolicyId",
        "businessPolicies.fulfillmentPolicyId",
      ],
      requiredProductFields: ["sku", "title", "description", "imageUrls"],
      isActive: true,
    };
  }

  return {
    platform,
    listingMode: DROPSHIP_DEFAULT_LISTING_MODE,
    inventoryMode: DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
    priceMode: DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
    marketplaceConfig: {},
    requiredConfigKeys: [],
    requiredProductFields: [],
    isActive: true,
  };
}

export function normalizeListingConfigInput(
  input: ReplaceDropshipStoreListingConfigInput,
): NormalizedDropshipStoreListingConfigInput {
  return {
    listingMode: input.listingMode,
    inventoryMode: input.inventoryMode,
    priceMode: input.priceMode,
    marketplaceConfig: input.marketplaceConfig,
    requiredConfigKeys: uniqueTrimmed(input.requiredConfigKeys),
    requiredProductFields: uniqueTrimmed(input.requiredProductFields),
    isActive: input.isActive,
  };
}

export function makeDropshipListingConfigLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipListingConfigEvent("info", event),
    warn: (event) => logDropshipListingConfigEvent("warn", event),
    error: (event) => logDropshipListingConfigEvent("error", event),
  };
}

export const systemDropshipListingConfigClock: DropshipClock = {
  now: () => new Date(),
};

function assertVendorCanManageListingConfig(vendor: DropshipProvisionedVendorProfile): void {
  if (["closed", "lapsed", "suspended"].includes(vendor.status)) {
    throw new DropshipError(
      "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
      "Dropship vendor status does not allow listing configuration changes.",
      { vendorId: vendor.vendorId, status: vendor.status },
    );
  }
}

function uniqueTrimmed<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const trimmed = value.trim() as T;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function logDropshipListingConfigEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}
