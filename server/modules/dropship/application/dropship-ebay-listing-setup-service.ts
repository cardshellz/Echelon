import { createHash } from "node:crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import {
  evaluateDropshipEbayFulfillmentPolicyCompatibility,
  type DropshipEbayFulfillmentCapability,
  type DropshipEbayFulfillmentPolicy,
  type DropshipEbayFulfillmentPolicyIssue,
} from "../domain/ebay-fulfillment-policy-compatibility";
import {
  EBAY_BUSINESS_POLICY_FIELDS,
  EBAY_BUSINESS_POLICY_NAMES_KEY,
  EBAY_STORE_SHELF_DEFAULT_KEY,
  MAX_EBAY_STORE_SHELVES,
  readEbayBusinessPolicyNames,
  readEbayStoreShelfDefault,
  readStoredEbayPolicyName,
  type EbayBusinessPolicyField,
  type EbayBusinessPolicyNames,
  type EbayStoreShelfDefault,
} from "../domain/ebay-listing-setup-config";
import type {
  DropshipEbayFulfillmentCapabilityProvider,
} from "./dropship-ebay-fulfillment-capability-service";
import {
  managedMerchantLocationKeyForWarehouse,
  type DropshipEbayManagedLocation,
  type DropshipEbayManagedLocationProvider,
} from "./dropship-ebay-managed-location-service";
import type { DropshipEbayStoreCategory } from "./dropship-ebay-store-category-service";
import type { DropshipLogger } from "./dropship-ports";
import {
  dropshipListingConfigIdempotencyKeySchema,
  replaceDropshipStoreListingConfigInputSchema,
} from "./dropship-listing-config-dtos";
import {
  DROPSHIP_DEFAULT_EBAY_MARKETPLACE_ID,
  DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES,
  DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
  assertStoreStatusAllowsListingConfigWrite,
  dropshipListingConfigFault,
  dropshipListingConfigReadOnlyError,
  type DropshipListingConfigAccess,
  type DropshipListingConfigKeyedRequest,
  type DropshipListingConfigRequestOperation,
  type DropshipListingConfigService,
  type DropshipListingConfigWriteOutcome,
  type DropshipStoreListingConfigRecord,
  type NormalizedDropshipStoreListingConfigInput,
} from "./dropship-listing-config-service";

export interface DropshipEbayListingSetupOption {
  id: string;
  name: string;
}

export interface DropshipEbayFulfillmentPolicyOption
extends DropshipEbayListingSetupOption {
  /** False whenever compatibility could not be checked; never treat an unchecked policy as usable. */
  compatible: boolean;
  /** False when Card Shellz shipping could not be read, so `compatible` says nothing about the policy. */
  compatibilityChecked: boolean;
  compatibilityIssues: DropshipEbayFulfillmentPolicyIssue[];
}

export interface DropshipEbayListingSetupDiscovery {
  marketplaceId: string;
  merchantLocations: DropshipEbayListingSetupOption[];
  fulfillmentPolicies: DropshipEbayFulfillmentPolicy[];
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
  getFulfillmentPolicyForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    fulfillmentPolicyId: string;
  }): Promise<DropshipEbayFulfillmentPolicy>;
  getFulfillmentPolicyWithAccessToken(input: {
    accessToken: string;
    environment: "sandbox" | "production";
    storeConnectionId: number;
    fulfillmentPolicyId: string;
  }): Promise<DropshipEbayFulfillmentPolicy>;
}

/** The connected eBay store's shelves (store categories), for the shelf default. */
export interface DropshipEbayStoreShelfDirectory {
  listLeafCategories(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipEbayStoreCategory[]>;
}

export interface DropshipEbayListingSetupSelection {
  merchantLocationKey: string | null;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
}

/**
 * Whether Card Shellz shipping was checked for this result.
 * - checked: the shipping policies were judged against Card Shellz shipping.
 * - unavailable: Card Shellz shipping could not be read; `reference` is the
 *   error code to give support (never staff wording).
 * - not_checked: this result was built without it (a read-only view, or a
 *   save that did not change the shipping policy).
 */
export type DropshipEbayListingSetupFulfillmentCheck =
  | { status: "checked" }
  | { status: "unavailable"; reference: string; kind: DropshipEbayFulfillmentUnavailableKind }
  | { status: "not_checked" };

/**
 * Why Card Shellz shipping could not be read, so the vendor gets the right
 * words: a passing outage (try again), a Card Shellz setup still being
 * finished (nothing for the vendor to do), or a store on an eBay site Card
 * Shellz does not list on.
 */
export type DropshipEbayFulfillmentUnavailableKind = "temporary" | "setup_incomplete" | "marketplace_unsupported";

export interface DropshipEbayListingSetupResult {
  storeConnectionId: number;
  marketplaceId: string;
  /** True only when eBay and Card Shellz shipping were both checked and nothing is missing. */
  complete: boolean;
  missingFields: string[];
  fulfillmentCapability: DropshipEbayFulfillmentCapability | null;
  selection: DropshipEbayListingSetupSelection;
  options: {
    merchantLocations: DropshipEbayListingSetupOption[];
    fulfillmentPolicies: DropshipEbayFulfillmentPolicyOption[];
    returnPolicies: DropshipEbayListingSetupOption[];
    paymentPolicies: DropshipEbayListingSetupOption[];
  };
  /** The listing config revision to send with the next save; null only when no config exists yet. */
  revision: number | null;
  access: DropshipListingConfigAccess;
  checks: {
    /** checked: the option lists above came from eBay now; not_checked: they are empty. */
    ebay: "checked" | "not_checked";
    fulfillment: DropshipEbayListingSetupFulfillmentCheck;
  };
  /** Policy names as eBay listed them at the last save, for when eBay can't be read. */
  storedNames: EbayBusinessPolicyNames;
  storeShelfDefault: EbayStoreShelfDefault | null;
}

/** The correlation fields on every log line of one keyed setup write. */
interface KeyedWriteLogContext {
  operation: DropshipListingConfigRequestOperation;
  vendorId: number;
  storeConnectionId: number;
  requestKey: string;
  expectedRevision: number;
}

export interface DropshipEbayListingSetupWriteResult extends DropshipEbayListingSetupResult {
  /** changed: saved; unchanged: it already said this; replayed: this request key was saved before. */
  outcome: DropshipListingConfigWriteOutcome;
}

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const policyIdSchema = z.string().trim().min(1).max(100);
const storeShelfIdSchema = z.string().trim().min(1).max(40);
const expectedRevisionSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);

/**
 * One store default save (W2). Any subset of the three policies and the
 * shelf default: a field left out is left as it is. `storeShelfDefault: null`
 * removes the shelf default. The save is a compare-and-set on
 * `expectedRevision`, and `idempotencyKey` makes a retry safe.
 */
export const replaceDropshipEbayListingSetupInputSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: dropshipListingConfigIdempotencyKeySchema,
  // Accepted only for rolling-deploy compatibility with the previous client.
  // The value is ignored: Card Shellz owns the physical inventory location.
  merchantLocationKey: z.string().trim().min(1).max(100).optional(),
  fulfillmentPolicyId: policyIdSchema.optional(),
  returnPolicyId: policyIdSchema.optional(),
  paymentPolicyId: policyIdSchema.optional(),
  storeShelfDefault: z.object({
    ids: z.array(storeShelfIdSchema).min(1).max(MAX_EBAY_STORE_SHELVES),
  }).strict().nullable().optional(),
}).strict().superRefine((value, context) => {
  const changes = [
    value.fulfillmentPolicyId,
    value.returnPolicyId,
    value.paymentPolicyId,
    value.storeShelfDefault,
  ].filter((field) => field !== undefined);
  if (changes.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "Send at least one policy or the shelf default to save.",
    });
  }
  if (value.storeShelfDefault && new Set(value.storeShelfDefault.ids).size !== value.storeShelfDefault.ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["storeShelfDefault", "ids"],
      message: "Pick two different shelves.",
    });
  }
});

export type ReplaceDropshipEbayListingSetupInput = z.infer<
  typeof replaceDropshipEbayListingSetupInputSchema
>;

/** W10: point the store's listings at the Card Shellz-managed eBay location again, changing nothing else. */
export const repairDropshipEbayShipFromInputSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: dropshipListingConfigIdempotencyKeySchema,
}).strict();

export type RepairDropshipEbayShipFromInput = z.infer<typeof repairDropshipEbayShipFromInputSchema>;

type ListingConfigPort = Pick<
  DropshipListingConfigService,
  | "getForMember"
  | "getViewForMember"
  | "findKeyedRequest"
  | "findConfig"
  | "replaceForMember"
  | "getForAdmin"
  | "replaceForAdmin"
>;

/** What a W2 save asks to change; a field that is undefined is left as it is. */
interface ListingSetupChange {
  marketplaceId: string;
  merchantLocationKey?: string | null;
  policies: Partial<Record<EbayBusinessPolicyField, string | null>>;
  /** Names eBay lists now for the final ids, from the policy lists read for this save. */
  discoveredNames: Partial<Record<EbayBusinessPolicyField, string>>;
  storeShelfDefault?: EbayStoreShelfDefault | null;
}

type CapabilityRead =
  | { status: "checked"; capability: DropshipEbayFulfillmentCapability }
  | { status: "unavailable"; reference: string; kind: DropshipEbayFulfillmentUnavailableKind };

export class DropshipEbayListingSetupService {
  constructor(private readonly deps: {
    listingConfig: ListingConfigPort;
    directory: DropshipEbayListingSetupDirectory;
    storeShelves: DropshipEbayStoreShelfDirectory;
    fulfillmentCapabilities: DropshipEbayFulfillmentCapabilityProvider;
    managedLocations: DropshipEbayManagedLocationProvider;
    logger: DropshipLogger;
  }) {}

  /** Saved selections are readable independently of live provider availability.
   * Never use this display-only read for mutation or publication validation. */
  async getSavedSelectionForMember(memberId: string, storeConnectionId: number): Promise<DropshipEbayListingSetupSelection> {
    const current = await this.deps.listingConfig.getForMember(memberId, storeConnectionId);
    assertEbayStore(current.storeConnection.platform, storeConnectionId);
    return readSelection(current.config);
  }

  /**
   * The setup page's read (GET). A vendor who can't change these settings (an
   * inactive account, or a paused, disconnecting or disconnected store) gets
   * the saved values read-only, with no eBay call. If Card Shellz shipping
   * can't be read, the eBay policies are still shown, with the shipping check
   * marked unavailable instead of failing the whole read (design 8.8).
   */
  async getViewForMember(
    memberId: string,
    storeConnectionId: number,
  ): Promise<DropshipEbayListingSetupResult> {
    const view = await this.deps.listingConfig.getViewForMember(memberId, storeConnectionId);
    assertEbayStore(view.storeConnection.platform, storeConnectionId);
    if (!view.access.canEdit || !view.config) {
      return buildListingSetupResult({
        storeConnectionId,
        config: view.config,
        access: view.access,
        discovery: null,
        capability: { status: "not_checked" },
        managedMerchantLocationKey: null,
      });
    }
    return this.buildLiveView(view.vendor.vendorId, storeConnectionId, view.config, view.access);
  }

  /**
   * The live setup used by other writers (per-size policies) to validate
   * against. Unlike the page read it refuses, rather than shows read-only,
   * when the settings can't be changed, and a Card Shellz shipping failure
   * fails it with that failure's own error (often a temporary one), as before,
   * instead of making every shipping policy look incompatible.
   */
  async getForMember(
    memberId: string,
    storeConnectionId: number,
  ): Promise<DropshipEbayListingSetupResult> {
    const view = await this.deps.listingConfig.getViewForMember(memberId, storeConnectionId);
    assertEbayStore(view.storeConnection.platform, storeConnectionId);
    const config = requireEditableConfig(view, storeConnectionId);
    return this.buildLiveView(view.vendor.vendorId, storeConnectionId, config, view.access, "throw");
  }

  async replaceForMember(
    memberId: string,
    storeConnectionId: number,
    input: unknown,
  ): Promise<DropshipEbayListingSetupWriteResult> {
    const parsed = replaceDropshipEbayListingSetupInputSchema.parse(input);
    const view = await this.deps.listingConfig.getViewForMember(memberId, storeConnectionId);
    assertEbayStore(view.storeConnection.platform, storeConnectionId);
    const vendorId = view.vendor.vendorId;
    const request = keyedRequest("ebay_listing_setup_save", storeConnectionId, parsed.idempotencyKey, {
      expectedRevision: parsed.expectedRevision,
      fulfillmentPolicyId: parsed.fulfillmentPolicyId ?? null,
      returnPolicyId: parsed.returnPolicyId ?? null,
      paymentPolicyId: parsed.paymentPolicyId ?? null,
      storeShelfDefault: parsed.storeShelfDefault === undefined ? "unchanged" : parsed.storeShelfDefault,
    });
    const logContext: KeyedWriteLogContext = {
      operation: request.operation,
      vendorId,
      storeConnectionId,
      requestKey: parsed.idempotencyKey,
      expectedRevision: parsed.expectedRevision,
    };
    // A request already applied is answered first, whatever changed since (a
    // paused store, a lapsed account), so a retry never reads as refused.
    const replay = await this.replayIfSeen(logContext, request, view.access);
    if (replay) return replay;
    let plan: Awaited<ReturnType<DropshipEbayListingSetupService["planSetupSave"]>>;
    try {
      plan = await this.planSetupSave(view, parsed);
    } catch (error) {
      return this.answerRefusal(error, logContext, request, view.access, "log_refusal");
    }
    let written: Awaited<ReturnType<ListingConfigPort["replaceForMember"]>>;
    try {
      written = await this.deps.listingConfig.replaceForMember(
        memberId,
        storeConnectionId,
        { ...plan.nextConfig, expectedRevision: parsed.expectedRevision },
        { request, auditEventType: "listing_config_replaced", allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES },
      );
    } catch (error) {
      // The listing-config service logs its own refusals.
      return this.answerRefusal(error, logContext, request, view.access, "already_logged");
    }
    const result = buildListingSetupResult({
      storeConnectionId,
      config: written.config,
      access: view.access,
      discovery: plan.discovery,
      capability: plan.capability ? { status: "checked", capability: plan.capability } : { status: "not_checked" },
      managedMerchantLocationKey: plan.managedLocation?.merchantLocationKey ?? null,
    });
    this.logConfigured(result, "vendor");
    return { ...result, outcome: written.outcome };
  }

  /**
   * W10: make sure the Card Shellz-managed eBay location exists, then point
   * the store's listings at it. Nothing else changes. This is the fix for a
   * push refused with DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH, which
   * happens when Card Shellz moves the store to another warehouse.
   */
  async repairShipFromForMember(
    memberId: string,
    storeConnectionId: number,
    input: unknown,
  ): Promise<DropshipEbayListingSetupWriteResult> {
    const parsed = repairDropshipEbayShipFromInputSchema.parse(input);
    const view = await this.deps.listingConfig.getViewForMember(memberId, storeConnectionId);
    assertEbayStore(view.storeConnection.platform, storeConnectionId);
    const vendorId = view.vendor.vendorId;
    const request = keyedRequest("ebay_ship_from_repair", storeConnectionId, parsed.idempotencyKey, {
      expectedRevision: parsed.expectedRevision,
    });
    const logContext: KeyedWriteLogContext = {
      operation: request.operation,
      vendorId,
      storeConnectionId,
      requestKey: parsed.idempotencyKey,
      expectedRevision: parsed.expectedRevision,
    };
    const replay = await this.replayIfSeen(logContext, request, view.access);
    if (replay) return replay;
    let plan: Awaited<ReturnType<DropshipEbayListingSetupService["planShipFromRepair"]>>;
    try {
      plan = await this.planShipFromRepair(view, parsed);
    } catch (error) {
      return this.answerRefusal(error, logContext, request, view.access, "log_refusal");
    }
    let written: Awaited<ReturnType<ListingConfigPort["replaceForMember"]>>;
    try {
      written = await this.deps.listingConfig.replaceForMember(
        memberId,
        storeConnectionId,
        { ...plan.nextConfig, expectedRevision: parsed.expectedRevision },
        {
          request,
          auditEventType: "listing_config_ship_from_repaired",
          allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
        },
      );
    } catch (error) {
      return this.answerRefusal(error, logContext, request, view.access, "already_logged");
    }
    const result = buildListingSetupResult({
      storeConnectionId,
      config: written.config,
      access: view.access,
      discovery: plan.discovery,
      capability: { status: "checked", capability: plan.capability },
      managedMerchantLocationKey: plan.managedLocation.merchantLocationKey,
    });
    this.deps.logger.info({
      code: "DROPSHIP_EBAY_SHIP_FROM_REPAIRED",
      message: "The store's eBay ship-from location was pointed at the Card Shellz-managed location.",
      context: {
        vendorId,
        storeConnectionId,
        merchantLocationKey: plan.managedLocation.merchantLocationKey,
        outcome: written.outcome,
        revisionBefore: written.revisionBefore,
        revisionAfter: written.revisionAfter,
        currentRevision: written.config.revision,
        requestKey: parsed.idempotencyKey,
      },
    });
    return { ...result, outcome: written.outcome };
  }

  /**
   * Everything a W2 save checks and reads before it writes. eBay and Card
   * Shellz are read only for what the save changes, so a return policy or
   * shelf can be saved while Card Shellz shipping is down, and clearing the
   * shelf needs no eBay call at all.
   */
  private async planSetupSave(
    view: ListingConfigView,
    parsed: ReplaceDropshipEbayListingSetupInput,
  ): Promise<{
    nextConfig: NormalizedDropshipStoreListingConfigInput;
    discovery: DropshipEbayListingSetupDiscovery | null;
    capability: DropshipEbayFulfillmentCapability | null;
    managedLocation: DropshipEbayManagedLocation | null;
  }> {
    const storeConnectionId = view.storeConnection.storeConnectionId;
    const vendorId = view.vendor.vendorId;
    const config = requireEditableConfig(view, storeConnectionId);
    assertStoreStatusAllowsListingConfigWrite(view.storeConnection, DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES);
    assertExpectedRevision(config, parsed.expectedRevision, storeConnectionId);

    const marketplaceId = resolveMarketplaceId(config);
    const sendsPolicy = EBAY_BUSINESS_POLICY_FIELDS.some((field) => parsed[field] !== undefined);
    let capability: DropshipEbayFulfillmentCapability | null = null;
    let managedLocation: DropshipEbayManagedLocation | null = null;
    if (parsed.fulfillmentPolicyId !== undefined) {
      capability = await this.deps.fulfillmentCapabilities.getForStoreConnection({
        storeConnectionId,
        marketplaceId,
        fresh: true,
      });
      managedLocation = await this.deps.managedLocations.ensureForStoreConnection({
        vendorId,
        storeConnectionId,
        originWarehouseId: capability.source.originWarehouseId,
      });
      // Logged here, not after the write: the location may have just been
      // created at eBay, which stays true even if the save is then refused.
      this.logManagedLocation(managedLocation, {
        storeConnectionId,
        vendorId,
        operation: "ebay_listing_setup_save",
        requestKey: parsed.idempotencyKey,
      });
    }
    let discovery: DropshipEbayListingSetupDiscovery | null = null;
    if (sendsPolicy) {
      const discovered = await this.deps.directory.discoverForStoreConnection({ vendorId, storeConnectionId, marketplaceId });
      discovery = managedLocation ? withManagedLocation(discovered, managedLocation) : discovered;
    }
    const shelfDefault = parsed.storeShelfDefault
      ? await this.resolveShelfDefault(vendorId, storeConnectionId, parsed.storeShelfDefault.ids)
      : parsed.storeShelfDefault;

    const policies = validatePolicyChange(parsed, discovery, capability, storeConnectionId);
    const change: ListingSetupChange = {
      marketplaceId: discovery?.marketplaceId ?? marketplaceId,
      policies,
      discoveredNames: discovery ? namesFromDiscovery(discovery, readSelection(config), policies) : {},
      storeShelfDefault: shelfDefault,
    };
    // A shipping policy save also points listings at the Card Shellz
    // location, as every save did before (the location ensure above).
    if (managedLocation && discovery) {
      change.merchantLocationKey = hasOption(managedLocation.merchantLocationKey, discovery.merchantLocations)
        ? managedLocation.merchantLocationKey
        : null;
    }
    return { nextConfig: applyListingSetupChange(config, change), discovery, capability, managedLocation };
  }

  private async planShipFromRepair(
    view: ListingConfigView,
    parsed: RepairDropshipEbayShipFromInput,
  ): Promise<{
    nextConfig: NormalizedDropshipStoreListingConfigInput;
    discovery: DropshipEbayListingSetupDiscovery;
    capability: DropshipEbayFulfillmentCapability;
    managedLocation: DropshipEbayManagedLocation;
  }> {
    const storeConnectionId = view.storeConnection.storeConnectionId;
    const vendorId = view.vendor.vendorId;
    const config = requireEditableConfig(view, storeConnectionId);
    assertStoreStatusAllowsListingConfigWrite(view.storeConnection, DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES);
    assertExpectedRevision(config, parsed.expectedRevision, storeConnectionId);

    const marketplaceId = resolveMarketplaceId(config);
    const capability = await this.deps.fulfillmentCapabilities.getForStoreConnection({
      storeConnectionId,
      marketplaceId,
      fresh: true,
    });
    const managedLocation = await this.deps.managedLocations.ensureForStoreConnection({
      vendorId,
      storeConnectionId,
      originWarehouseId: capability.source.originWarehouseId,
    });
    // Logged here, not after the write (see planSetupSave).
    this.logManagedLocation(managedLocation, {
      storeConnectionId,
      vendorId,
      operation: "ebay_ship_from_repair",
      requestKey: parsed.idempotencyKey,
    });
    const discovery = withManagedLocation(
      await this.deps.directory.discoverForStoreConnection({ vendorId, storeConnectionId, marketplaceId }),
      managedLocation,
    );
    const nextConfig = applyListingSetupChange(config, {
      marketplaceId: discovery.marketplaceId,
      merchantLocationKey: managedLocation.merchantLocationKey,
      policies: {},
      discoveredNames: {},
    });
    return { nextConfig, discovery, capability, managedLocation };
  }

  /**
   * A keyed write was refused. Another attempt with the same key may have
   * committed while this one was being checked (a retry sent while the first
   * was still running, after its answer was lost), so the ledger is read
   * again: when it holds this request, that answer wins over the refusal.
   * Otherwise the refusal is logged (unless the listing-config service did)
   * and rethrown. A broken invariant is logged before the recheck, so it
   * reaches a person even when the committed twin answers the request.
   * Errors that are not DropshipErrors are rethrown untouched.
   */
  private async answerRefusal(
    error: unknown,
    context: KeyedWriteLogContext,
    request: DropshipListingConfigKeyedRequest,
    access: DropshipListingConfigAccess,
    logging: "log_refusal" | "already_logged",
  ): Promise<DropshipEbayListingSetupWriteResult> {
    if (!(error instanceof DropshipError)) throw error;
    const fault = dropshipListingConfigFault(error.code);
    if (logging === "log_refusal" && fault) this.logRefusal(context, error);
    if (error.code !== "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT") {
      const replay = await this.replayAfterRefusal(context, request, access, error);
      if (replay) return replay;
    }
    if (logging === "log_refusal" && !fault) this.logRefusal(context, error);
    throw error;
  }

  /** The ledger's answer for a refused attempt, or null. A failed read keeps the refusal as the answer. */
  private async replayAfterRefusal(
    context: KeyedWriteLogContext,
    request: DropshipListingConfigKeyedRequest,
    access: DropshipListingConfigAccess,
    refusal: DropshipError,
  ): Promise<DropshipEbayListingSetupWriteResult | null> {
    try {
      return await this.replayIfSeen(context, request, access, refusal.code);
    } catch (recheckError) {
      // An idempotency conflict found now is the truer answer: the key was
      // used for another body in the meantime.
      if (recheckError instanceof DropshipError && recheckError.code === "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT") {
        throw recheckError;
      }
      // Any other failure keeps the refusal as the answer. A fault was
      // already logged at ERROR by replayIfSeen; anything else is noted here.
      if (!(recheckError instanceof DropshipError && dropshipListingConfigFault(recheckError.code))) {
        this.deps.logger.warn({
          code: "DROPSHIP_EBAY_LISTING_SETUP_REPLAY_RECHECK_FAILED",
          message: "The request ledger could not be read after a refused save; the refusal is answered.",
          context: {
            ...context,
            errorCode: refusal.code,
            recheckErrorCode: recheckError instanceof DropshipError ? recheckError.code : null,
            recheckError: recheckError instanceof Error ? recheckError.message : String(recheckError),
          },
        });
      }
      return null;
    }
  }

  /**
   * A save that was not written, at the level it deserves: a broken invariant
   * (dropshipListingConfigFault) is ERROR, for a person; eBay or Card Shellz
   * shipping failing to answer (dropshipEbayProviderFailure) is WARN, an
   * outage worth noticing; a refusal by the rules is INFO.
   */
  private logRefusal(context: KeyedWriteLogContext, error: DropshipError): void {
    const fields = { ...context, errorCode: error.code, currentRevision: error.context?.currentRevision ?? null };
    if (dropshipListingConfigFault(error.code)) {
      this.deps.logger.error({
        code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_FAILED",
        message: "eBay listing setup change failed a check that should always hold; nothing was written.",
        context: { ...fields, outcome: "failed" },
      });
      return;
    }
    if (dropshipEbayProviderFailure(error)) {
      this.deps.logger.warn({
        code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_UNAVAILABLE",
        message: "eBay listing setup change was not saved because eBay or Card Shellz shipping did not answer; nothing was written.",
        context: { ...fields, outcome: "failed" },
      });
      return;
    }
    this.deps.logger.info({
      code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED",
      message: "eBay listing setup change was not saved; nothing was written.",
      context: { ...fields, outcome: "refused" },
    });
  }

  async autoConfigureAfterConnection(input: {
    storeConnectionId: number;
    accessToken: string;
    environment: "sandbox" | "production";
  }): Promise<DropshipEbayListingSetupResult> {
    const actor = { actorType: "system", actorId: "ebay-post-connect-setup" } as const;
    const current = await this.deps.listingConfig.getForAdmin(input.storeConnectionId, actor);
    assertEbayStore(current.storeConnection.platform, input.storeConnectionId);
    const marketplaceId = resolveMarketplaceId(current.config);
    const fulfillmentCapability = await this.deps.fulfillmentCapabilities.getForStoreConnection({
      storeConnectionId: input.storeConnectionId,
      marketplaceId,
      fresh: true,
    });
    const managedLocation = await this.deps.managedLocations.ensureWithAccessToken({
      accessToken: input.accessToken,
      environment: input.environment,
      storeConnectionId: input.storeConnectionId,
      originWarehouseId: fulfillmentCapability.source.originWarehouseId,
    });
    // Logged here, not after the write (see planSetupSave).
    this.logManagedLocation(managedLocation, { storeConnectionId: input.storeConnectionId, actorType: "system" });
    const discovery = withManagedLocation(
      await this.deps.directory.discoverWithAccessToken({
        accessToken: input.accessToken,
        environment: input.environment,
        marketplaceId,
        storeConnectionId: input.storeConnectionId,
      }),
      managedLocation,
    );
    const selection = resolveAutomaticSelection(
      current.config,
      discovery,
      fulfillmentCapability,
      managedLocation.merchantLocationKey,
    );
    const policies: Partial<Record<EbayBusinessPolicyField, string | null>> = {
      fulfillmentPolicyId: selection.fulfillmentPolicyId,
      returnPolicyId: selection.returnPolicyId,
      paymentPolicyId: selection.paymentPolicyId,
    };
    const nextConfig = applyListingSetupChange(current.config, {
      marketplaceId: discovery.marketplaceId,
      merchantLocationKey: selection.merchantLocationKey,
      policies,
      discoveredNames: namesFromDiscovery(discovery, readSelection(current.config), policies),
    });
    // Compare-and-set against the revision this writer read. A vendor save
    // that lands in between wins; the caller logs the conflict and the
    // vendor's choice is kept.
    const written = await this.deps.listingConfig.replaceForAdmin(
      input.storeConnectionId,
      { ...nextConfig, expectedRevision: current.config.revision },
      actor,
      { allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES },
    );
    const result = buildListingSetupResult({
      storeConnectionId: input.storeConnectionId,
      config: written.config,
      access: { canEdit: true, reason: null },
      discovery,
      capability: { status: "checked", capability: fulfillmentCapability },
      managedMerchantLocationKey: managedLocation.merchantLocationKey,
    });
    this.logConfigured(result, "system");
    return result;
  }

  private async buildLiveView(
    vendorId: number,
    storeConnectionId: number,
    config: DropshipStoreListingConfigRecord,
    access: DropshipListingConfigAccess,
    capabilityFailure: "report" | "throw" = "report",
  ): Promise<DropshipEbayListingSetupResult> {
    const marketplaceId = resolveMarketplaceId(config);
    const [discovery, capability] = await Promise.all([
      this.deps.directory.discoverForStoreConnection({ vendorId, storeConnectionId, marketplaceId }),
      capabilityFailure === "throw"
        ? this.deps.fulfillmentCapabilities.getForStoreConnection({ storeConnectionId, marketplaceId })
          .then((checked): CapabilityRead => ({ status: "checked", capability: checked }))
        : this.readCapability(vendorId, storeConnectionId, marketplaceId),
    ]);
    return buildListingSetupResult({
      storeConnectionId,
      config,
      access,
      discovery,
      capability: capability.status === "checked"
        ? { status: "checked", capability: capability.capability }
        : capability,
      managedMerchantLocationKey: capability.status === "checked"
        ? managedMerchantLocationKeyForWarehouse(capability.capability.source.originWarehouseId)
        : null,
    });
  }

  /** Card Shellz shipping for the read: a Card Shellz-side failure is shown as "unavailable", never as the vendor's problem. */
  private async readCapability(
    vendorId: number,
    storeConnectionId: number,
    marketplaceId: string,
  ): Promise<CapabilityRead> {
    try {
      return {
        status: "checked",
        capability: await this.deps.fulfillmentCapabilities.getForStoreConnection({ storeConnectionId, marketplaceId }),
      };
    } catch (error) {
      if (!(error instanceof DropshipError)) throw error;
      const kind = classifyCapabilityFailure(error);
      // A passing outage is an anomaly (WARN). A Card Shellz setup still being
      // finished, or a store on another eBay site, is a known state shown on
      // every read, so it is INFO rather than a WARN per page view.
      const event = {
        code: "DROPSHIP_EBAY_LISTING_SETUP_CAPABILITY_UNAVAILABLE",
        message: "Card Shellz shipping could not be read; the setup is shown without the shipping check.",
        context: { vendorId, storeConnectionId, marketplaceId, errorCode: error.code, kind },
      };
      if (kind === "temporary") this.deps.logger.warn(event);
      else this.deps.logger.info(event);
      return { status: "unavailable", reference: error.code, kind };
    }
  }

  private async resolveShelfDefault(
    vendorId: number,
    storeConnectionId: number,
    ids: readonly string[],
  ): Promise<EbayStoreShelfDefault> {
    const shelves = await this.deps.storeShelves.listLeafCategories({ vendorId, storeConnectionId });
    const shelvesById = new Map(shelves.map((shelf) => [shelf.categoryId, shelf]));
    const missing = ids.filter((id) => !shelvesById.has(id));
    if (missing.length > 0) {
      throw new DropshipError(
        "DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID",
        "That shelf is not in your eBay store anymore. Choose another shelf.",
        { storeConnectionId, invalidFields: ["storeShelfDefault"], retryable: false },
      );
    }
    // eBay takes store categories by name; the path is what an offer sends
    // (dropship-ebay-store-category-service.ts, replaceForMember).
    return { ids: [...ids], names: ids.map((id) => shelvesById.get(id)!.path) };
  }

  /**
   * A request key already recorded answers the request again from the saved
   * config, without eBay calls or a new write. The same key with another body
   * is refused. Both are logged with the revisions the ledger recorded.
   */
  private async replayIfSeen(
    context: KeyedWriteLogContext,
    request: DropshipListingConfigKeyedRequest,
    access: DropshipListingConfigAccess,
    afterRefusalCode: string | null = null,
  ): Promise<DropshipEbayListingSetupWriteResult | null> {
    try {
      return await this.answerFromLedger(context, request, access, afterRefusalCode);
    } catch (error) {
      // A row the ledger or config table can't map is a fault; a key reused
      // for another body is logged where it is found.
      if (error instanceof DropshipError && dropshipListingConfigFault(error.code)) this.logRefusal(context, error);
      throw error;
    }
  }

  private async answerFromLedger(
    context: KeyedWriteLogContext,
    request: DropshipListingConfigKeyedRequest,
    access: DropshipListingConfigAccess,
    afterRefusalCode: string | null,
  ): Promise<DropshipEbayListingSetupWriteResult | null> {
    const { vendorId, storeConnectionId } = context;
    const prior = await this.deps.listingConfig.findKeyedRequest({ vendorId, idempotencyKey: request.idempotencyKey });
    if (!prior) return null;
    if (prior.requestHash !== request.requestHash
      || prior.storeConnectionId !== storeConnectionId
      || prior.operation !== request.operation) {
      const conflict = new DropshipError(
        "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
        "This request key was already used for a different listing settings change.",
        { storeConnectionId, retryable: false },
      );
      this.logRefusal(context, conflict);
      throw conflict;
    }
    // Read after the ledger row: the row and its config change commit
    // together, so this sees at least what the first request saved.
    const config = await this.deps.listingConfig.findConfig({ storeConnectionId });
    this.deps.logger.info({
      code: "DROPSHIP_EBAY_LISTING_SETUP_REPLAYED",
      message: "eBay listing setup request answered from its recorded key; nothing was written.",
      context: {
        ...context,
        outcome: "replayed",
        recordedOutcome: prior.outcome,
        revisionBefore: prior.revisionBefore,
        revisionAfter: prior.revisionAfter,
        currentRevision: config?.revision ?? null,
        afterRefusalCode,
      },
    });
    return {
      ...buildListingSetupResult({
        storeConnectionId,
        config,
        access,
        discovery: null,
        capability: { status: "not_checked" },
        managedMerchantLocationKey: null,
      }),
      outcome: "replayed",
    };
  }

  /** The correlation names the request that ensured the location, so its eBay change is traced with it. */
  private logManagedLocation(
    location: DropshipEbayManagedLocation,
    correlation: {
      storeConnectionId: number;
      vendorId?: number;
      operation?: DropshipListingConfigRequestOperation;
      requestKey?: string;
      actorType?: "system";
    },
  ): void {
    this.deps.logger.info({
      code: "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED",
      message: "The Card Shellz-managed eBay inventory location was reconciled.",
      context: {
        ...correlation,
        originWarehouseId: location.originWarehouseId,
        merchantLocationKey: location.merchantLocationKey,
        action: location.action,
      },
    });
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
        revision: result.revision,
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

type ListingConfigView = Awaited<ReturnType<ListingConfigPort["getViewForMember"]>>;

/** The config of a view the vendor may change; the read-only error otherwise. */
function requireEditableConfig(view: ListingConfigView, storeConnectionId: number): DropshipStoreListingConfigRecord {
  if (!view.access.canEdit) {
    throw dropshipListingConfigReadOnlyError(view.access.reason, { vendorId: view.vendor.vendorId, storeConnectionId });
  }
  if (!view.config) {
    // An editable view always has a config (getViewForMember creates it).
    throw new DropshipError(
      "DROPSHIP_LISTING_CONFIG_REQUIRED",
      "The store's listing config could not be loaded.",
      { storeConnectionId, retryable: false },
    );
  }
  return view.config;
}

/**
 * eBay or Card Shellz shipping failing to answer for now (an outage), as
 * opposed to a refusal or a setup gap: the providers mark exactly these
 * retryable. The same rule as a page read (classifyCapabilityFailure), so a
 * failure is a passing outage on both or on neither. A code alone does not
 * decide: a routing setup error is DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE
 * with retryable false (dropship-ebay-fulfillment-capability.provider.ts).
 */
function dropshipEbayProviderFailure(error: DropshipError): boolean {
  return error.context?.retryable === true;
}

/** Card Shellz shipping failures, by what the vendor should be told (see DropshipEbayFulfillmentUnavailableKind). */
function classifyCapabilityFailure(error: DropshipError): DropshipEbayFulfillmentUnavailableKind {
  if (error.code === "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED") return "marketplace_unsupported";
  return error.context?.retryable === true ? "temporary" : "setup_incomplete";
}

function assertExpectedRevision(
  config: DropshipStoreListingConfigRecord,
  expectedRevision: number,
  storeConnectionId: number,
): void {
  // Checked before any eBay call so a stale page is refused at once; the
  // repository checks it again under the store's lock before writing.
  if (config.revision !== expectedRevision) {
    throw new DropshipError(
      "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
      "These store settings changed after they were loaded. Load the latest settings and save again.",
      { storeConnectionId, expectedRevision, currentRevision: config.revision, retryable: false },
    );
  }
}

function keyedRequest(
  operation: DropshipListingConfigRequestOperation,
  storeConnectionId: number,
  idempotencyKey: string,
  body: Record<string, unknown>,
): DropshipListingConfigKeyedRequest {
  return {
    operation,
    idempotencyKey,
    requestHash: createHash("sha256")
      .update(JSON.stringify(sortJsonValue({ version: 1, operation, storeConnectionId, body })))
      .digest("hex"),
  };
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
      return sorted;
    }, {});
}

function resolveMarketplaceId(config: DropshipStoreListingConfigRecord | null): string {
  const configured = config ? normalizedString(config.marketplaceConfig.marketplaceId) : null;
  return configured ?? DROPSHIP_DEFAULT_EBAY_MARKETPLACE_ID;
}

function buildListingSetupResult(input: {
  storeConnectionId: number;
  config: DropshipStoreListingConfigRecord | null;
  access: DropshipListingConfigAccess;
  discovery: DropshipEbayListingSetupDiscovery | null;
  capability: { status: "checked"; capability: DropshipEbayFulfillmentCapability }
    | { status: "unavailable"; reference: string; kind: DropshipEbayFulfillmentUnavailableKind }
    | { status: "not_checked" };
  managedMerchantLocationKey: string | null;
}): DropshipEbayListingSetupResult {
  const { discovery, capability, config } = input;
  const selection = config ? readSelection(config) : EMPTY_SELECTION;
  const fulfillmentCapability = capability.status === "checked" ? capability.capability : null;
  const fulfillmentPolicies = discovery
    ? buildFulfillmentPolicyOptions(discovery.fulfillmentPolicies, fulfillmentCapability)
    : [];
  const missingFields = missingSelectionFields(selection);
  // The location can be judged only with Card Shellz shipping (it names the
  // origin warehouse) and eBay's location list.
  if (discovery && input.managedMerchantLocationKey && (
    selection.merchantLocationKey !== input.managedMerchantLocationKey
    || !hasOption(input.managedMerchantLocationKey, discovery.merchantLocations)
  )) {
    missingFields.push("merchantLocationKey");
  }
  if (discovery && selection.fulfillmentPolicyId) {
    const selectedFulfillmentPolicy = fulfillmentPolicies.find(
      (policy) => policy.id === selection.fulfillmentPolicyId,
    );
    if (!selectedFulfillmentPolicy) {
      missingFields.push("fulfillmentPolicyId");
    } else if (selectedFulfillmentPolicy.compatibilityChecked && !selectedFulfillmentPolicy.compatible) {
      missingFields.push("fulfillmentPolicyCompatibility");
    }
  }
  if (discovery && selection.returnPolicyId && !hasOption(selection.returnPolicyId, discovery.returnPolicies)) {
    missingFields.push("returnPolicyId");
  }
  if (discovery && selection.paymentPolicyId && !hasOption(selection.paymentPolicyId, discovery.paymentPolicies)) {
    missingFields.push("paymentPolicyId");
  }
  const uniqueMissingFields = [...new Set(missingFields)];
  const fulfillmentCheck: DropshipEbayListingSetupFulfillmentCheck = capability.status === "checked"
    ? { status: "checked" }
    : capability;
  return {
    storeConnectionId: input.storeConnectionId,
    marketplaceId: discovery?.marketplaceId ?? resolveMarketplaceId(config),
    complete: Boolean(discovery) && fulfillmentCheck.status === "checked" && uniqueMissingFields.length === 0,
    missingFields: uniqueMissingFields,
    fulfillmentCapability,
    selection,
    options: {
      merchantLocations: discovery?.merchantLocations ?? [],
      fulfillmentPolicies,
      returnPolicies: discovery?.returnPolicies ?? [],
      paymentPolicies: discovery?.paymentPolicies ?? [],
    },
    revision: config?.revision ?? null,
    access: input.access,
    checks: { ebay: discovery ? "checked" : "not_checked", fulfillment: fulfillmentCheck },
    storedNames: config ? readEbayBusinessPolicyNames(config.marketplaceConfig) : EMPTY_NAMES,
    storeShelfDefault: config ? readEbayStoreShelfDefault(config.marketplaceConfig) : null,
  };
}

const EMPTY_SELECTION: DropshipEbayListingSetupSelection = {
  merchantLocationKey: null,
  fulfillmentPolicyId: null,
  returnPolicyId: null,
  paymentPolicyId: null,
};

const EMPTY_NAMES: EbayBusinessPolicyNames = {
  fulfillmentPolicyName: null,
  returnPolicyName: null,
  paymentPolicyName: null,
};

function resolveAutomaticSelection(
  config: DropshipStoreListingConfigRecord,
  discovery: DropshipEbayListingSetupDiscovery,
  fulfillmentCapability: DropshipEbayFulfillmentCapability,
  managedMerchantLocationKey: string,
): DropshipEbayListingSetupSelection {
  const current = readSelection(config);
  const compatiblePolicies = buildFulfillmentPolicyOptions(
    discovery.fulfillmentPolicies,
    fulfillmentCapability,
  ).filter((policy) => policy.compatible);
  return {
    merchantLocationKey: hasOption(managedMerchantLocationKey, discovery.merchantLocations)
      ? managedMerchantLocationKey
      : null,
    fulfillmentPolicyId: resolveOption(current.fulfillmentPolicyId, compatiblePolicies),
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

function hasOption(
  selectedId: string,
  options: readonly DropshipEbayListingSetupOption[],
): boolean {
  return options.some((option) => option.id === selectedId);
}

/**
 * Each eBay shipping policy with whether it fits Card Shellz shipping. With
 * no capability (Card Shellz shipping could not be read) every policy is
 * unchecked and not compatible, so nothing can pick it until it is checked.
 */
export function buildFulfillmentPolicyOptions(
  policies: readonly DropshipEbayFulfillmentPolicy[],
  capability: DropshipEbayFulfillmentCapability | null,
): DropshipEbayFulfillmentPolicyOption[] {
  return policies.map((policy) => {
    if (!capability) {
      return {
        id: policy.id,
        name: policy.name,
        compatible: false,
        compatibilityChecked: false,
        compatibilityIssues: [],
      };
    }
    const compatibility = evaluateDropshipEbayFulfillmentPolicyCompatibility({
      capability,
      policy,
    });
    return {
      id: policy.id,
      name: policy.name,
      compatible: compatibility.compatible,
      compatibilityChecked: true,
      compatibilityIssues: compatibility.issues,
    };
  });
}

/**
 * Checks each policy the save sends against eBay's current lists (and the
 * shipping policy against Card Shellz shipping). Fields the save leaves out
 * are not checked: they keep their saved value, and the preview's live check
 * reports any that eBay no longer lists.
 */
function validatePolicyChange(
  input: ReplaceDropshipEbayListingSetupInput,
  discovery: DropshipEbayListingSetupDiscovery | null,
  capability: DropshipEbayFulfillmentCapability | null,
  storeConnectionId: number,
): Partial<Record<EbayBusinessPolicyField, string>> {
  const sent = EBAY_BUSINESS_POLICY_FIELDS.filter((field) => input[field] !== undefined);
  if (sent.length === 0) return {};
  if (!discovery) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_SETUP_INVARIANT_FAILED",
      "eBay's policy lists are required to check a policy save.",
      { storeConnectionId, retryable: false },
    );
  }
  const fulfillmentPolicies = buildFulfillmentPolicyOptions(discovery.fulfillmentPolicies, capability);
  const optionsByField: Record<EbayBusinessPolicyField, readonly DropshipEbayListingSetupOption[]> = {
    fulfillmentPolicyId: fulfillmentPolicies,
    returnPolicyId: discovery.returnPolicies,
    paymentPolicyId: discovery.paymentPolicies,
  };
  const invalidFields = sent.filter((field) => !hasOption(input[field]!, optionsByField[field]));
  if (invalidFields.length > 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID",
      "One or more eBay listing setup selections are no longer available.",
      { storeConnectionId, invalidFields, retryable: false },
    );
  }
  if (input.fulfillmentPolicyId !== undefined) {
    const selectedFulfillmentPolicy = fulfillmentPolicies.find(
      (policy) => policy.id === input.fulfillmentPolicyId,
    );
    if (!selectedFulfillmentPolicy?.compatibilityChecked || !selectedFulfillmentPolicy.compatible) {
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
        "The selected eBay fulfillment policy exceeds Card Shellz fulfillment capabilities.",
        {
          storeConnectionId,
          fulfillmentPolicyId: input.fulfillmentPolicyId,
          issues: selectedFulfillmentPolicy?.compatibilityIssues ?? [],
          retryable: false,
        },
      );
    }
  }
  return Object.fromEntries(sent.map((field) => [field, input[field]!]));
}

/** The names eBay lists now for each policy id the config will hold after the change. */
function namesFromDiscovery(
  discovery: DropshipEbayListingSetupDiscovery,
  current: DropshipEbayListingSetupSelection,
  policies: Partial<Record<EbayBusinessPolicyField, string | null>>,
): Partial<Record<EbayBusinessPolicyField, string>> {
  const optionsByField: Record<EbayBusinessPolicyField, readonly DropshipEbayListingSetupOption[]> = {
    fulfillmentPolicyId: discovery.fulfillmentPolicies,
    returnPolicyId: discovery.returnPolicies,
    paymentPolicyId: discovery.paymentPolicies,
  };
  const names: Partial<Record<EbayBusinessPolicyField, string>> = {};
  for (const field of EBAY_BUSINESS_POLICY_FIELDS) {
    const finalId = policies[field] !== undefined ? policies[field] : current[field];
    if (!finalId) continue;
    const name = optionsByField[field].find((option) => option.id === finalId)?.name.trim();
    if (name) names[field] = name;
  }
  return names;
}

function withManagedLocation(
  discovery: DropshipEbayListingSetupDiscovery,
  managedLocation: DropshipEbayManagedLocation,
): DropshipEbayListingSetupDiscovery {
  const merchantLocations = [
    ...discovery.merchantLocations.filter(
      (location) => location.id !== managedLocation.merchantLocationKey,
    ),
    {
      id: managedLocation.merchantLocationKey,
      name: managedLocation.name,
    },
  ].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return { ...discovery, merchantLocations };
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

/**
 * The config after a setup change. Pure: never mutates the stored config.
 * - Policy ids: a field the change leaves undefined keeps its value; null
 *   removes it; other businessPolicies keys are kept.
 * - Names: the name eBay lists now for each final id; a kept id whose name
 *   eBay no longer lists keeps the stored name; a removed id loses its name.
 * - merchantLocationKey and the shelf default: undefined keeps, null removes.
 */
function applyListingSetupChange(
  config: DropshipStoreListingConfigRecord,
  change: ListingSetupChange,
): NormalizedDropshipStoreListingConfigInput {
  const currentPolicies = isRecord(config.marketplaceConfig.businessPolicies)
    ? config.marketplaceConfig.businessPolicies
    : {};
  const policies: Record<string, unknown> = { ...currentPolicies };
  const names: Record<string, { id: string; name: string }> = {};
  for (const field of EBAY_BUSINESS_POLICY_FIELDS) {
    const next = change.policies[field];
    if (next === null) delete policies[field];
    else if (next !== undefined) policies[field] = next;
    const finalId = normalizedString(policies[field]);
    if (!finalId) continue;
    // The name eBay lists now, else the stored one if it names this same id.
    const stored = readStoredEbayPolicyName(config.marketplaceConfig, field);
    const name = change.discoveredNames[field] ?? (stored?.id === finalId ? stored.name : null);
    if (name) names[field] = { id: finalId, name };
  }

  const marketplaceConfig: Record<string, unknown> = {
    ...config.marketplaceConfig,
    marketplaceId: change.marketplaceId,
    businessPolicies: policies,
  };
  if (Object.keys(names).length > 0) marketplaceConfig[EBAY_BUSINESS_POLICY_NAMES_KEY] = names;
  else delete marketplaceConfig[EBAY_BUSINESS_POLICY_NAMES_KEY];
  if (change.merchantLocationKey === null) delete marketplaceConfig.merchantLocationKey;
  else if (change.merchantLocationKey !== undefined) marketplaceConfig.merchantLocationKey = change.merchantLocationKey;
  if (change.storeShelfDefault === null) delete marketplaceConfig[EBAY_STORE_SHELF_DEFAULT_KEY];
  else if (change.storeShelfDefault !== undefined) {
    marketplaceConfig[EBAY_STORE_SHELF_DEFAULT_KEY] = {
      ids: [...change.storeShelfDefault.ids],
      names: [...change.storeShelfDefault.names],
    };
  }
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

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
