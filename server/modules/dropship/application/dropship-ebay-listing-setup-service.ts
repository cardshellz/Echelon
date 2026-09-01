import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type { DropshipLogger } from "./dropship-ports";
import { replaceDropshipStoreListingConfigInputSchema } from "./dropship-listing-config-dtos";
import {
  DROPSHIP_DEFAULT_EBAY_MARKETPLACE_ID,
  type DropshipListingConfigService,
  type DropshipStoreListingConfigRecord,
  type NormalizedDropshipStoreListingConfigInput,
} from "./dropship-listing-config-service";

export interface DropshipEbayListingSetupOption {
  id: string;
  name: string;
}

export interface DropshipEbayListingSetupDiscovery {
  marketplaceId: string;
  merchantLocations: DropshipEbayListingSetupOption[];
  fulfillmentPolicies: DropshipEbayListingSetupOption[];
  returnPolicies: DropshipEbayListingSetupOption[];
  paymentPolicies: DropshipEbayListingSetupOption[];
}

export interface DropshipEbayListingSetupDirectory {
  discoverForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    marketplaceId: string;
  }): Promise<DropshipEbayListingSetupDiscovery>;
  discoverWithAccessToken(input: {
    accessToken: string;
    environment: "sandbox" | "production";
    marketplaceId: string;
    storeConnectionId: number;
  }): Promise<DropshipEbayListingSetupDiscovery>;
}

export interface DropshipEbayListingSetupSelection {
  merchantLocationKey: string | null;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
}

export interface DropshipEbayListingSetupResult {
  storeConnectionId: number;
  marketplaceId: string;
  complete: boolean;
  missingFields: string[];
  selection: DropshipEbayListingSetupSelection;
  options: {
    merchantLocations: DropshipEbayListingSetupOption[];
    fulfillmentPolicies: DropshipEbayListingSetupOption[];
    returnPolicies: DropshipEbayListingSetupOption[];
    paymentPolicies: DropshipEbayListingSetupOption[];
  };
}

export const replaceDropshipEbayListingSetupInputSchema = z.object({
  merchantLocationKey: z.string().trim().min(1).max(100),
  fulfillmentPolicyId: z.string().trim().min(1).max(100),
  returnPolicyId: z.string().trim().min(1).max(100),
  paymentPolicyId: z.string().trim().min(1).max(100),
}).strict();

export type ReplaceDropshipEbayListingSetupInput = z.infer<
  typeof replaceDropshipEbayListingSetupInputSchema
>;

type ListingConfigPort = Pick<
  DropshipListingConfigService,
  "getForMember" | "replaceForMember" | "getForAdmin" | "replaceForAdmin"
>;

export class DropshipEbayListingSetupService {
  constructor(private readonly deps: {
    listingConfig: ListingConfigPort;
    directory: DropshipEbayListingSetupDirectory;
    logger: DropshipLogger;
  }) {}

  async getForMember(
    memberId: string,
    storeConnectionId: number,
  ): Promise<DropshipEbayListingSetupResult> {
    const current = await this.deps.listingConfig.getForMember(memberId, storeConnectionId);
    assertEbayStore(current.storeConnection.platform, storeConnectionId);
    const marketplaceId = resolveMarketplaceId(current.config);
    const discovery = await this.deps.directory.discoverForStoreConnection({
      vendorId: current.vendor.vendorId,
      storeConnectionId,
      marketplaceId,
    });
    return buildListingSetupResult(storeConnectionId, current.config, discovery);
  }

  async replaceForMember(
    memberId: string,
    storeConnectionId: number,
    input: unknown,
  ): Promise<DropshipEbayListingSetupResult> {
    const parsed = replaceDropshipEbayListingSetupInputSchema.parse(input);
    const current = await this.deps.listingConfig.getForMember(memberId, storeConnectionId);
    assertEbayStore(current.storeConnection.platform, storeConnectionId);
    const marketplaceId = resolveMarketplaceId(current.config);
    const discovery = await this.deps.directory.discoverForStoreConnection({
      vendorId: current.vendor.vendorId,
      storeConnectionId,
      marketplaceId,
    });
    const selection = validateSelection(parsed, discovery, storeConnectionId);
    const nextConfig = mergeListingSetup(current.config, discovery.marketplaceId, selection);
    const replaced = configsEqual(current.config, nextConfig)
      ? current.config
      : (await this.deps.listingConfig.replaceForMember(memberId, storeConnectionId, nextConfig)).config;
    const result = buildListingSetupResult(storeConnectionId, replaced, discovery);
    this.logConfigured(result, "vendor");
    return result;
  }

  async autoConfigureAfterConnection(input: {
    storeConnectionId: number;
    accessToken: string;
    environment: "sandbox" | "production";
  }): Promise<DropshipEbayListingSetupResult> {
    const current = await this.deps.listingConfig.getForAdmin(input.storeConnectionId, {
      actorType: "system",
      actorId: "ebay-post-connect-setup",
    });
    assertEbayStore(current.storeConnection.platform, input.storeConnectionId);
    const marketplaceId = resolveMarketplaceId(current.config);
    const discovery = await this.deps.directory.discoverWithAccessToken({
      accessToken: input.accessToken,
      environment: input.environment,
      marketplaceId,
      storeConnectionId: input.storeConnectionId,
    });
    const selection = resolveAutomaticSelection(current.config, discovery);
    const nextConfig = mergeListingSetup(current.config, discovery.marketplaceId, selection);
    const replaced = configsEqual(current.config, nextConfig)
      ? current.config
      : (await this.deps.listingConfig.replaceForAdmin(
          input.storeConnectionId,
          nextConfig,
          { actorType: "system", actorId: "ebay-post-connect-setup" },
        )).config;
    const result = buildListingSetupResult(input.storeConnectionId, replaced, discovery);
    this.logConfigured(result, "system");
    return result;
  }

  private logConfigured(result: DropshipEbayListingSetupResult, actorType: "vendor" | "system"): void {
    this.deps.logger.info({
      code: "DROPSHIP_EBAY_LISTING_SETUP_EVALUATED",
      message: "Dropship eBay listing prerequisites were evaluated.",
      context: {
        storeConnectionId: result.storeConnectionId,
        marketplaceId: result.marketplaceId,
        complete: result.complete,
        missingFields: result.missingFields,
        actorType,
      },
    });
  }
}

function assertEbayStore(platform: string, storeConnectionId: number): void {
  if (platform !== "ebay") {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_SETUP_STORE_REQUIRED",
      "eBay listing setup requires an eBay store connection.",
      { storeConnectionId, platform, retryable: false },
    );
  }
}

function resolveMarketplaceId(config: DropshipStoreListingConfigRecord): string {
  const configured = normalizedString(config.marketplaceConfig.marketplaceId);
  return configured ?? DROPSHIP_DEFAULT_EBAY_MARKETPLACE_ID;
}

function buildListingSetupResult(
  storeConnectionId: number,
  config: DropshipStoreListingConfigRecord,
  discovery: DropshipEbayListingSetupDiscovery,
): DropshipEbayListingSetupResult {
  const selection = readSelection(config);
  const missingFields = missingSelectionFields(selection);
  return {
    storeConnectionId,
    marketplaceId: discovery.marketplaceId,
    complete: missingFields.length === 0,
    missingFields,
    selection,
    options: {
      merchantLocations: discovery.merchantLocations,
      fulfillmentPolicies: discovery.fulfillmentPolicies,
      returnPolicies: discovery.returnPolicies,
      paymentPolicies: discovery.paymentPolicies,
    },
  };
}

function resolveAutomaticSelection(
  config: DropshipStoreListingConfigRecord,
  discovery: DropshipEbayListingSetupDiscovery,
): DropshipEbayListingSetupSelection {
  const current = readSelection(config);
  return {
    merchantLocationKey: resolveOption(current.merchantLocationKey, discovery.merchantLocations),
    fulfillmentPolicyId: resolveOption(current.fulfillmentPolicyId, discovery.fulfillmentPolicies),
    returnPolicyId: resolveOption(current.returnPolicyId, discovery.returnPolicies),
    paymentPolicyId: resolveOption(current.paymentPolicyId, discovery.paymentPolicies),
  };
}

function resolveOption(
  currentId: string | null,
  options: readonly DropshipEbayListingSetupOption[],
): string | null {
  if (currentId && options.some((option) => option.id === currentId)) return currentId;
  return options.length === 1 ? options[0].id : null;
}

function validateSelection(
  input: ReplaceDropshipEbayListingSetupInput,
  discovery: DropshipEbayListingSetupDiscovery,
  storeConnectionId: number,
): DropshipEbayListingSetupSelection {
  const selection: DropshipEbayListingSetupSelection = {
    merchantLocationKey: input.merchantLocationKey,
    fulfillmentPolicyId: input.fulfillmentPolicyId,
    returnPolicyId: input.returnPolicyId,
    paymentPolicyId: input.paymentPolicyId,
  };
  const checks: Array<{
    field: keyof DropshipEbayListingSetupSelection;
    id: string | null;
    options: readonly DropshipEbayListingSetupOption[];
  }> = [
    { field: "merchantLocationKey", id: selection.merchantLocationKey, options: discovery.merchantLocations },
    { field: "fulfillmentPolicyId", id: selection.fulfillmentPolicyId, options: discovery.fulfillmentPolicies },
    { field: "returnPolicyId", id: selection.returnPolicyId, options: discovery.returnPolicies },
    { field: "paymentPolicyId", id: selection.paymentPolicyId, options: discovery.paymentPolicies },
  ];
  const invalidFields = checks
    .filter((check) => !check.id || !check.options.some((option) => option.id === check.id))
    .map((check) => check.field);
  if (invalidFields.length > 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID",
      "One or more eBay listing setup selections are no longer available.",
      { storeConnectionId, invalidFields, retryable: false },
    );
  }
  return selection;
}

function readSelection(config: DropshipStoreListingConfigRecord): DropshipEbayListingSetupSelection {
  const policies = isRecord(config.marketplaceConfig.businessPolicies)
    ? config.marketplaceConfig.businessPolicies
    : {};
  return {
    merchantLocationKey: normalizedString(config.marketplaceConfig.merchantLocationKey),
    fulfillmentPolicyId: normalizedString(policies.fulfillmentPolicyId),
    returnPolicyId: normalizedString(policies.returnPolicyId),
    paymentPolicyId: normalizedString(policies.paymentPolicyId),
  };
}

function mergeListingSetup(
  config: DropshipStoreListingConfigRecord,
  marketplaceId: string,
  selection: DropshipEbayListingSetupSelection,
): NormalizedDropshipStoreListingConfigInput {
  const currentPolicies = isRecord(config.marketplaceConfig.businessPolicies)
    ? config.marketplaceConfig.businessPolicies
    : {};
  const marketplaceConfig: Record<string, unknown> = {
    ...config.marketplaceConfig,
    marketplaceId,
    businessPolicies: {
      ...currentPolicies,
      ...(selection.fulfillmentPolicyId ? { fulfillmentPolicyId: selection.fulfillmentPolicyId } : {}),
      ...(selection.returnPolicyId ? { returnPolicyId: selection.returnPolicyId } : {}),
      ...(selection.paymentPolicyId ? { paymentPolicyId: selection.paymentPolicyId } : {}),
    },
  };
  if (selection.merchantLocationKey) {
    marketplaceConfig.merchantLocationKey = selection.merchantLocationKey;
  } else {
    delete marketplaceConfig.merchantLocationKey;
  }
  const policies = marketplaceConfig.businessPolicies as Record<string, unknown>;
  if (!selection.fulfillmentPolicyId) delete policies.fulfillmentPolicyId;
  if (!selection.returnPolicyId) delete policies.returnPolicyId;
  if (!selection.paymentPolicyId) delete policies.paymentPolicyId;
  return replaceDropshipStoreListingConfigInputSchema.parse({
    listingMode: config.listingMode,
    inventoryMode: config.inventoryMode,
    priceMode: config.priceMode,
    marketplaceConfig,
    requiredConfigKeys: [...config.requiredConfigKeys],
    requiredProductFields: [...config.requiredProductFields],
    isActive: config.isActive,
  });
}

function missingSelectionFields(selection: DropshipEbayListingSetupSelection): string[] {
  return [
    ...(selection.merchantLocationKey ? [] : ["merchantLocationKey"]),
    ...(selection.fulfillmentPolicyId ? [] : ["fulfillmentPolicyId"]),
    ...(selection.returnPolicyId ? [] : ["returnPolicyId"]),
    ...(selection.paymentPolicyId ? [] : ["paymentPolicyId"]),
  ];
}

function configsEqual(
  current: DropshipStoreListingConfigRecord,
  next: NormalizedDropshipStoreListingConfigInput,
): boolean {
  return isDeepStrictEqual({
    listingMode: current.listingMode,
    inventoryMode: current.inventoryMode,
    priceMode: current.priceMode,
    marketplaceConfig: current.marketplaceConfig,
    requiredConfigKeys: current.requiredConfigKeys,
    requiredProductFields: current.requiredProductFields,
    isActive: current.isActive,
  }, next);
}

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
