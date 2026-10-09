import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  DropshipEbayListingSetupService,
  type DropshipEbayListingSetupDirectory,
  type DropshipEbayListingSetupDiscovery,
  type DropshipEbayListingSetupWriteResult,
  type DropshipEbayStoreShelfDirectory,
} from "../../application/dropship-ebay-listing-setup-service";
import {
  DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES,
  DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES,
  DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
  assertStoreStatusAllowsListingConfigWrite,
  buildDefaultDropshipStoreListingConfig,
  decideDropshipListingConfigAccess,
  listingConfigContentEquals,
  normalizeListingConfigInput,
  type DropshipListingConfigActor,
  type DropshipListingConfigKeyedRequest,
  type DropshipListingConfigKeyedRequestRecord,
  type DropshipListingConfigReplaceOptions,
  type DropshipListingConfigService,
  type DropshipListingConfigWriteOutcome,
  type DropshipStoreListingConfigRecord,
} from "../../application/dropship-listing-config-service";
import { replaceDropshipStoreListingConfigRequestSchema } from "../../application/dropship-listing-config-dtos";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type {
  DropshipEbayFulfillmentCapabilityProvider,
} from "../../application/dropship-ebay-fulfillment-capability-service";
import {
  managedMerchantLocationKeyForWarehouse,
  type DropshipEbayManagedLocation,
  type DropshipEbayManagedLocationProvider,
} from "../../application/dropship-ebay-managed-location-service";
import type { DropshipEbayStoreCategory } from "../../application/dropship-ebay-store-category-service";
import type {
  DropshipEbayFulfillmentCapability,
  DropshipEbayFulfillmentPolicy,
} from "../../domain/ebay-fulfillment-policy-compatibility";
import { DropshipError } from "../../domain/errors";
import type { DropshipStoreConnectionStatus } from "../../../../../shared/schema/dropship.schema";

const now = new Date("2026-08-30T14:00:00.000Z");
const MEMBER_ID = "member-1";
const STORE_CONNECTION_ID = 44;
const VENDOR_ID = 10;
const SAVE_KEY = "setup-save-0001";
const REPAIR_KEY = "ship-from-repair-0001";
const SYSTEM_ACTOR = { actorType: "system", actorId: "ebay-post-connect-setup" } as const;

type LoggedEvent = DropshipLogEvent & { level: "info" | "warn" | "error" };

/**
 * One Card Shellz shipping failure of each kind the setup tells apart
 * (classifyCapabilityFailure): a passing outage, a Card Shellz setup still
 * being finished, and a store on an eBay site Card Shellz does not list on.
 * Built fresh per test so no test sees another's error object.
 */
const CAPABILITY_FAILURES: ReadonlyArray<{
  label: string;
  kind: "temporary" | "setup_incomplete" | "marketplace_unsupported";
  level: "warn" | "info";
  error: () => DropshipError;
}> = [
  {
    label: "a passing routing outage",
    kind: "temporary",
    level: "warn",
    error: () => new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
      "Card Shellz fulfillment routing could not be verified.",
      { serviceLevelId: 7, routingCode: null, retryable: true },
    ),
  },
  {
    label: "a rate table Card Shellz has not set up",
    kind: "setup_incomplete",
    level: "info",
    error: () => new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_RATE_TABLE_REQUIRED",
      "Exactly one active Standard dropship rate table is required.",
      { rateBookId: 34, activeTableIds: [], retryable: false },
    ),
  },
  {
    label: "a failure with no context at all",
    kind: "setup_incomplete",
    level: "info",
    error: () => new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_WAREHOUSE_REQUIRED",
      "The dropship store must have a valid default warehouse before fulfillment policies can be verified.",
    ),
  },
  {
    label: "a store on another eBay site",
    kind: "marketplace_unsupported",
    level: "info",
    error: () => new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED",
      "Card Shellz fulfillment capability validation currently supports EBAY_US only.",
      { storeConnectionId: 44, marketplaceId: "EBAY_US", retryable: false },
    ),
  },
];

describe("DropshipEbayListingSetupService", () => {
  let listingConfig: FakeListingConfig;
  let directory: FakeDirectory;
  let locations: FakeManagedLocations;
  let getCapability: ReturnType<typeof vi.fn<DropshipEbayFulfillmentCapabilityProvider["getForStoreConnection"]>>;
  let listLeafCategories: ReturnType<typeof vi.fn<DropshipEbayStoreShelfDirectory["listLeafCategories"]>>;
  let logs: LoggedEvent[];
  let service: DropshipEbayListingSetupService;

  beforeEach(() => {
    listingConfig = new FakeListingConfig();
    directory = new FakeDirectory();
    locations = managedLocations(directory);
    getCapability = vi.fn<DropshipEbayFulfillmentCapabilityProvider["getForStoreConnection"]>(
      async () => capability(),
    );
    listLeafCategories = vi.fn<DropshipEbayStoreShelfDirectory["listLeafCategories"]>(async () => storeShelves());
    logs = [];
    service = new DropshipEbayListingSetupService({
      listingConfig: listingConfig as unknown as Pick<
        DropshipListingConfigService,
        | "getForMember"
        | "getViewForMember"
        | "findKeyedRequest"
        | "findConfig"
        | "replaceForMember"
        | "getForAdmin"
        | "replaceForAdmin"
      >,
      directory,
      storeShelves: { listLeafCategories },
      fulfillmentCapabilities: { getForStoreConnection: getCapability },
      managedLocations: locations,
      logger: {
        info: (event) => logs.push({ level: "info", ...event }),
        warn: (event) => logs.push({ level: "warn", ...event }),
        error: (event) => logs.push({ level: "error", ...event }),
      },
    });
  });

  /** Nothing outside Echelon was asked: no eBay read, no Card Shellz shipping read, no location write. */
  function expectNoProviderCalls(): void {
    expect(directory.storeConnectionCalls).toEqual([]);
    expect(directory.accessTokenCall).toBeNull();
    expect(getCapability).not.toHaveBeenCalled();
    expect(locations.ensureForStoreConnection).not.toHaveBeenCalled();
    expect(locations.ensureWithAccessToken).not.toHaveBeenCalled();
    expect(listLeafCategories).not.toHaveBeenCalled();
  }

  function clearProviderCalls(): void {
    directory.storeConnectionCalls = [];
    directory.accessTokenCall = null;
    getCapability.mockClear();
    locations.ensureForStoreConnection.mockClear();
    locations.ensureWithAccessToken.mockClear();
    listLeafCategories.mockClear();
  }

  function lastMemberWrite(): { input: Record<string, unknown>; options: DropshipListingConfigReplaceOptions } {
    const call = listingConfig.replaceMember.mock.calls.at(-1);
    if (!call) throw new Error("Expected a member write");
    return { input: call[2] as Record<string, unknown>, options: call[3] ?? {} };
  }

  describe("autoConfigureAfterConnection", () => {
    it("auto-selects each prerequisite only when eBay returns one valid option", async () => {
      const result = await service.autoConfigureAfterConnection({
        storeConnectionId: 44,
        accessToken: "access-token",
        environment: "production",
      });

      expect(result).toMatchObject({
        complete: true,
        marketplaceId: "EBAY_US",
        selection: {
          merchantLocationKey: "cardshellz-dropship-wh-1",
          fulfillmentPolicyId: "fulfillment-1",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-1",
        },
        checks: { ebay: "checked", fulfillment: { status: "checked" } },
      });
      expect(directory.accessTokenCall).toEqual({
        accessToken: "access-token",
        environment: "production",
        marketplaceId: "EBAY_US",
        storeConnectionId: 44,
      });
      expect(listingConfig.replaceAdmin).toHaveBeenCalledTimes(1);
      expect(listingConfig.config?.marketplaceConfig).toMatchObject({
        unrelatedSetting: "preserved",
        marketplaceId: "EBAY_US",
        merchantLocationKey: "cardshellz-dropship-wh-1",
        businessPolicies: {
          unrelatedPolicySetting: "preserved",
          fulfillmentPolicyId: "fulfillment-1",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-1",
        },
      });
      expect(logs.at(-1)).toMatchObject({
        code: "DROPSHIP_EBAY_LISTING_SETUP_EVALUATED",
        context: { complete: true, actorType: "system" },
      });
    });

    it("compare-and-sets against the revision it read, with the system's store statuses and no request key", async () => {
      listingConfig.config = makeConfig(undefined, { revision: 5 });

      const result = await service.autoConfigureAfterConnection({
        storeConnectionId: 44,
        accessToken: "access-token",
        environment: "production",
      });

      expect(listingConfig.replaceAdmin).toHaveBeenCalledTimes(1);
      const [storeConnectionId, input, actor, options] = listingConfig.replaceAdmin.mock.calls[0];
      expect(storeConnectionId).toBe(44);
      expect(input).toMatchObject({ expectedRevision: 5 });
      expect(actor).toEqual(SYSTEM_ACTOR);
      expect(options).toEqual({ allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES });
      expect(result.revision).toBe(6);
      expect(listingConfig.ledger.size).toBe(0);
    });

    it("loses to a vendor save that lands while it runs, leaving the vendor's settings in place", async () => {
      listingConfig.config = makeConfig(undefined, { revision: 5 });
      const discoverWithAccessToken = directory.discoverWithAccessToken.bind(directory);
      vi.spyOn(directory, "discoverWithAccessToken").mockImplementation(async (input) => {
        // A vendor save commits between the automatic setup's read and write.
        listingConfig.config = makeConfig({
          marketplaceId: "EBAY_US",
          businessPolicies: { returnPolicyId: "vendor-choice" },
        }, { revision: 6 });
        return discoverWithAccessToken(input);
      });

      await expect(service.autoConfigureAfterConnection({
        storeConnectionId: 44,
        accessToken: "access-token",
        environment: "production",
      })).rejects.toMatchObject({
        code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        context: { expectedRevision: 5, currentRevision: 6 },
      });
      expect(listingConfig.config).toMatchObject({
        revision: 6,
        marketplaceConfig: { businessPolicies: { returnPolicyId: "vendor-choice" } },
      });
    });

    it("uses the Card Shellz-managed location even when other seller locations exist", async () => {
      directory.discovery = {
        ...directory.discovery,
        merchantLocations: [
          { id: "warehouse-east", name: "East" },
          { id: "warehouse-west", name: "West" },
        ],
        paymentPolicies: [
          { id: "payment-retail", name: "Retail" },
          { id: "payment-wholesale", name: "Wholesale" },
        ],
      };

      const result = await service.autoConfigureAfterConnection({
        storeConnectionId: 44,
        accessToken: "access-token",
        environment: "production",
      });

      expect(result.complete).toBe(false);
      expect(result.selection).toEqual({
        merchantLocationKey: "cardshellz-dropship-wh-1",
        fulfillmentPolicyId: "fulfillment-1",
        returnPolicyId: "return-1",
        paymentPolicyId: null,
      });
      expect(result.missingFields).toEqual(["paymentPolicyId"]);
    });

    it("replaces a seller-owned location while preserving valid policy choices", async () => {
      listingConfig.config = makeConfig({
        marketplaceId: "EBAY_US",
        merchantLocationKey: "warehouse-west",
        businessPolicies: {
          fulfillmentPolicyId: "fulfillment-2",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-1",
        },
      });
      directory.discovery = {
        ...directory.discovery,
        merchantLocations: [
          { id: "warehouse-east", name: "East" },
          { id: "warehouse-west", name: "West" },
        ],
        fulfillmentPolicies: [
          fulfillmentPolicy("fulfillment-1", "Standard"),
          fulfillmentPolicy("fulfillment-2", "Expedited"),
        ],
      };

      const result = await service.autoConfigureAfterConnection({
        storeConnectionId: 44,
        accessToken: "access-token",
        environment: "production",
      });

      expect(result.complete).toBe(true);
      expect(result.selection).toMatchObject({
        merchantLocationKey: "cardshellz-dropship-wh-1",
        fulfillmentPolicyId: "fulfillment-2",
      });
      expect(listingConfig.replaceAdmin).toHaveBeenCalledTimes(1);
    });

    it("removes the stored name of a policy it removes", async () => {
      listingConfig.config = makeConfig({
        marketplaceId: "EBAY_US",
        businessPolicies: {
          fulfillmentPolicyId: "fulfillment-1",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-gone",
        },
        businessPolicyNames: savedPolicyNames({ paymentPolicyId: { id: "payment-gone", name: "Gone payments" } }),
      });
      directory.discovery = {
        ...directory.discovery,
        paymentPolicies: [
          { id: "payment-retail", name: "Retail" },
          { id: "payment-wholesale", name: "Wholesale" },
        ],
      };

      const result = await service.autoConfigureAfterConnection({
        storeConnectionId: 44,
        accessToken: "access-token",
        environment: "production",
      });

      const stored = listingConfig.config!.marketplaceConfig;
      expect(stored.businessPolicies).not.toHaveProperty("paymentPolicyId");
      expect(stored.businessPolicyNames).toEqual({
        fulfillmentPolicyId: { id: "fulfillment-1", name: "Standard" },
        returnPolicyId: { id: "return-1", name: "Thirty days" },
      });
      expect(result.storedNames).toEqual({
        fulfillmentPolicyName: "Standard",
        returnPolicyName: "Thirty days",
        paymentPolicyName: null,
      });
      expect(result.missingFields).toEqual(["paymentPolicyId"]);
    });

    it("drops the names key altogether when no policy is left", async () => {
      listingConfig.config = makeConfig({
        marketplaceId: "EBAY_US",
        businessPolicies: {
          fulfillmentPolicyId: "fulfillment-gone",
          returnPolicyId: "return-gone",
          paymentPolicyId: "payment-gone",
        },
        businessPolicyNames: {
          fulfillmentPolicyId: { id: "fulfillment-gone", name: "Gone shipping" },
          returnPolicyId: { id: "return-gone", name: "Gone returns" },
          paymentPolicyId: { id: "payment-gone", name: "Gone payments" },
        },
      });
      directory.discovery = {
        ...directory.discovery,
        fulfillmentPolicies: [fulfillmentPolicy("fulfillment-1", "Standard"), fulfillmentPolicy("fulfillment-2", "Expedited")],
        returnPolicies: [{ id: "return-1", name: "Thirty days" }, { id: "return-2", name: "Sixty days" }],
        paymentPolicies: [{ id: "payment-1", name: "Managed payments" }, { id: "payment-2", name: "Invoice" }],
      };

      const result = await service.autoConfigureAfterConnection({
        storeConnectionId: 44,
        accessToken: "access-token",
        environment: "production",
      });

      expect(listingConfig.config!.marketplaceConfig).not.toHaveProperty("businessPolicyNames");
      expect(listingConfig.config!.marketplaceConfig.businessPolicies).toEqual({});
      expect(result.storedNames).toEqual({
        fulfillmentPolicyName: null,
        returnPolicyName: null,
        paymentPolicyName: null,
      });
    });
  });

  it("reads saved selections without provider discovery, location reconciliation, or config replacement", async () => {
    listingConfig.config = makeConfig({ businessPolicies: { fulfillmentPolicyId: "saved-ground", returnPolicyId: "saved-return", paymentPolicyId: "saved-payment" } });
    const discover = vi.spyOn(directory, "discoverForStoreConnection").mockRejectedValue(new Error("Provider outage"));
    await expect(service.getSavedSelectionForMember("member-1", 44)).resolves.toEqual({
      merchantLocationKey: null, fulfillmentPolicyId: "saved-ground", returnPolicyId: "saved-return", paymentPolicyId: "saved-payment",
    });
    expect(discover).not.toHaveBeenCalled();
    expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    expect(listingConfig.replaceAdmin).not.toHaveBeenCalled();
  });

  describe("getViewForMember (the setup page read)", () => {
    it("checks eBay and Card Shellz shipping live without writing anything or reconciling the location", async () => {
      listingConfig.config = makeConfig(completeMarketplaceConfig(), { revision: 3 });
      directory.discovery = withManagedLocationListed(directory.discovery);

      const result = await service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID);

      expect(result).toMatchObject({
        complete: true,
        missingFields: [],
        revision: 3,
        access: { canEdit: true, reason: null },
        checks: { ebay: "checked", fulfillment: { status: "checked" } },
        storedNames: {
          fulfillmentPolicyName: "Standard",
          returnPolicyName: "Thirty days",
          paymentPolicyName: "Managed payments",
        },
      });
      // The page read uses the cached Card Shellz shipping answer, never a fresh one.
      expect(getCapability).toHaveBeenCalledWith({ storeConnectionId: 44, marketplaceId: "EBAY_US" });
      expect(locations.ensureForStoreConnection).not.toHaveBeenCalled();
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      expect(listingConfig.replaceAdmin).not.toHaveBeenCalled();
    });

    it("shows a suspended vendor's saved settings read-only without any eBay or Card Shellz call", async () => {
      listingConfig.vendorStatus = "suspended";
      listingConfig.config = makeConfig({
        ...completeMarketplaceConfig(),
        storeShelfDefault: { ids: ["101"], names: ["Supplies:Toploaders"] },
      }, { revision: 7 });

      const result = await service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID);

      expectNoProviderCalls();
      expect(result).toEqual({
        storeConnectionId: 44,
        marketplaceId: "EBAY_US",
        complete: false,
        missingFields: [],
        fulfillmentCapability: null,
        selection: {
          merchantLocationKey: "cardshellz-dropship-wh-1",
          fulfillmentPolicyId: "fulfillment-1",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-1",
        },
        options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
        revision: 7,
        access: { canEdit: false, reason: "vendor_not_active" },
        checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
        storedNames: {
          fulfillmentPolicyName: "Standard",
          returnPolicyName: "Thirty days",
          paymentPolicyName: "Managed payments",
        },
        storeShelfDefault: { ids: ["101"], names: ["Supplies:Toploaders"] },
      });
    });

    it("shows a paused store with no saved config read-only, with no revision, and never creates the config", async () => {
      listingConfig.storeStatus = "paused";
      listingConfig.config = null;

      const result = await service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID);

      expectNoProviderCalls();
      expect(listingConfig.config).toBeNull();
      expect(result).toMatchObject({
        marketplaceId: "EBAY_US",
        complete: false,
        missingFields: ["merchantLocationKey", "fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"],
        selection: { merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null },
        options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
        revision: null,
        access: { canEdit: false, reason: "store_paused" },
        checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
        storedNames: { fulfillmentPolicyName: null, returnPolicyName: null, paymentPolicyName: null },
        storeShelfDefault: null,
      });
    });

    it.each([
      { storeStatus: "grace_period", reason: "store_disconnecting" },
      { storeStatus: "disconnected", reason: "store_disconnected" },
    ] as const)("shows a $storeStatus store read-only ($reason) without any eBay call", async ({ storeStatus, reason }) => {
      listingConfig.storeStatus = storeStatus;

      const result = await service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID);

      expectNoProviderCalls();
      expect(result.access).toEqual({ canEdit: false, reason });
      expect(result.revision).toBe(1);
    });

    it("still shows eBay's policies when Card Shellz shipping can't be read, without judging the location or shipping fit", async () => {
      listingConfig.config = makeConfig({
        marketplaceId: "EBAY_US",
        merchantLocationKey: "warehouse-west",
        businessPolicies: {
          fulfillmentPolicyId: "fulfillment-fast",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-1",
        },
      });
      directory.discovery = { ...directory.discovery, fulfillmentPolicies: [sameDayPolicy()] };
      getCapability.mockRejectedValue(new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_SERVICES_REQUIRED",
        "No allowed fulfillment routing method has a verified eBay service mapping.",
        { retryable: false },
      ));

      const result = await service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID);

      expect(result).toMatchObject({
        complete: false,
        missingFields: [],
        fulfillmentCapability: null,
        checks: {
          ebay: "checked",
          fulfillment: {
            status: "unavailable",
            reference: "DROPSHIP_EBAY_FULFILLMENT_SERVICES_REQUIRED",
            kind: "setup_incomplete",
          },
        },
        options: {
          fulfillmentPolicies: [{
            id: "fulfillment-fast",
            name: "Same day",
            compatible: false,
            compatibilityChecked: false,
            compatibilityIssues: [],
          }],
          returnPolicies: [{ id: "return-1", name: "Thirty days" }],
          paymentPolicies: [{ id: "payment-1", name: "Managed payments" }],
        },
      });
      expect(result.missingFields).not.toContain("merchantLocationKey");
      expect(result.missingFields).not.toContain("fulfillmentPolicyCompatibility");
      // A Card Shellz setup still being finished is a known state, logged INFO on each read, not WARN.
      expect(logs.filter((event) => event.code === "DROPSHIP_EBAY_LISTING_SETUP_CAPABILITY_UNAVAILABLE")).toEqual([
        expect.objectContaining({
          level: "info",
          context: {
            vendorId: 10,
            storeConnectionId: 44,
            marketplaceId: "EBAY_US",
            errorCode: "DROPSHIP_EBAY_FULFILLMENT_SERVICES_REQUIRED",
            kind: "setup_incomplete",
          },
        }),
      ]);
      expect(logs.filter((event) => event.level !== "info")).toEqual([]);
    });

    it("flags the same location and shipping policy once Card Shellz shipping can be read", async () => {
      listingConfig.config = makeConfig({
        marketplaceId: "EBAY_US",
        merchantLocationKey: "warehouse-west",
        businessPolicies: {
          fulfillmentPolicyId: "fulfillment-fast",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-1",
        },
      });
      directory.discovery = { ...directory.discovery, fulfillmentPolicies: [sameDayPolicy()] };

      const result = await service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID);

      expect(result.checks.fulfillment).toEqual({ status: "checked" });
      expect(result.missingFields).toEqual(["merchantLocationKey", "fulfillmentPolicyCompatibility"]);
      expect(result.options.fulfillmentPolicies[0]).toMatchObject({ compatible: false, compatibilityChecked: true });
      expect(logs.filter((event) => event.level === "warn")).toEqual([]);
    });

    it("lets an unexpected (non-Dropship) capability failure fail the read", async () => {
      const failure = new TypeError("Cannot read properties of undefined (reading 'rateTableId')");
      getCapability.mockRejectedValue(failure);

      await expect(service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID)).rejects.toBe(failure);
      expect(logs.filter((event) => event.level === "warn")).toEqual([]);
    });

    it.each(CAPABILITY_FAILURES)(
      "reports $label as unavailable ($kind) with its code as the reference, logged at $level",
      async ({ kind, level, error }) => {
        listingConfig.config = makeConfig(completeMarketplaceConfig(), { revision: 3 });
        directory.discovery = withManagedLocationListed(directory.discovery);
        const failure = error();
        getCapability.mockRejectedValue(failure);

        const result = await service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID);

        expect(result.checks).toEqual({
          ebay: "checked",
          fulfillment: { status: "unavailable", reference: failure.code, kind },
        });
        expect(result).toMatchObject({ complete: false, fulfillmentCapability: null, revision: 3 });
        // Only Card Shellz shipping is missing: the saved, listed policies are not called missing.
        expect(result.missingFields).toEqual([]);
        expect(result.options.fulfillmentPolicies).toEqual([
          expect.objectContaining({ id: "fulfillment-1", compatible: false, compatibilityChecked: false }),
        ]);
        expect(logs.filter((event) => event.code === "DROPSHIP_EBAY_LISTING_SETUP_CAPABILITY_UNAVAILABLE")).toEqual([{
          level,
          code: "DROPSHIP_EBAY_LISTING_SETUP_CAPABILITY_UNAVAILABLE",
          message: expect.any(String),
          context: {
            vendorId: VENDOR_ID,
            storeConnectionId: STORE_CONNECTION_ID,
            marketplaceId: "EBAY_US",
            errorCode: failure.code,
            kind,
          },
        }]);
        // A known Card Shellz state is never a WARN per page view; only a passing outage is.
        expect(logs.filter((event) => event.level === "warn")).toHaveLength(level === "warn" ? 1 : 0);
        expect(logs.filter((event) => event.level === "error")).toEqual([]);
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      },
    );

    it("never calls an unsupported eBay site a passing outage, even when the failure says it is retryable", async () => {
      getCapability.mockRejectedValue(new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED",
        "Card Shellz fulfillment capability validation currently supports EBAY_US only.",
        { storeConnectionId: 44, marketplaceId: "EBAY_US", retryable: true },
      ));

      const result = await service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID);

      expect(result.checks.fulfillment).toEqual({
        status: "unavailable",
        reference: "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED",
        kind: "marketplace_unsupported",
      });
      expect(logs.filter((event) => event.level === "warn")).toEqual([]);
    });

    it("calls a failure temporary only when it is marked retryable: true, not a truthy look-alike", async () => {
      getCapability.mockRejectedValue(new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
        "Card Shellz fulfillment routing could not be verified.",
        { retryable: "true" },
      ));

      const result = await service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID);

      expect(result.checks.fulfillment).toMatchObject({ status: "unavailable", kind: "setup_incomplete" });
      expect(logs.filter((event) => event.level === "warn")).toEqual([]);
    });

    it("shows the saved names only for the ids still saved, so a policy another writer changed shows no old name", async () => {
      // Staff (or the generic PUT) changed the return policy id without touching the names.
      listingConfig.vendorStatus = "suspended";
      listingConfig.config = makeConfig(savedSetupMarketplaceConfig({
        businessPolicies: {
          fulfillmentPolicyId: "fulfillment-1",
          returnPolicyId: "return-staff",
          paymentPolicyId: "payment-1",
        },
      }));

      const result = await service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID);

      expectNoProviderCalls();
      expect(result.selection.returnPolicyId).toBe("return-staff");
      expect(result.storedNames).toEqual({
        fulfillmentPolicyName: "Standard",
        returnPolicyName: null,
        paymentPolicyName: "Managed payments",
      });
    });
  });

  describe("getForMember (the live setup other writers validate against)", () => {
    it("marks persisted location and policy ids incomplete after eBay stops returning them", async () => {
      listingConfig.config = makeConfig({
        marketplaceId: "EBAY_US",
        merchantLocationKey: "deleted-location",
        businessPolicies: {
          fulfillmentPolicyId: "deleted-fulfillment",
          returnPolicyId: "deleted-return",
          paymentPolicyId: "deleted-payment",
        },
      });

      const result = await service.getForMember("member-1", 44);

      expect(result.complete).toBe(false);
      expect(result.missingFields).toEqual([
        "merchantLocationKey",
        "fulfillmentPolicyId",
        "returnPolicyId",
        "paymentPolicyId",
      ]);
    });

    it.each([
      { vendorStatus: "suspended", storeStatus: "connected", code: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED" },
      { vendorStatus: "closed", storeStatus: "connected", code: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED" },
      { vendorStatus: "active", storeStatus: "paused", code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" },
      { vendorStatus: "active", storeStatus: "grace_period", code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING" },
      { vendorStatus: "active", storeStatus: "disconnected", code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED" },
    ] as const)("refuses a $vendorStatus vendor on a $storeStatus store with $code instead of a read-only view", async ({
      vendorStatus,
      storeStatus,
      code,
    }) => {
      listingConfig.vendorStatus = vendorStatus;
      listingConfig.storeStatus = storeStatus;

      await expect(service.getForMember(MEMBER_ID, STORE_CONNECTION_ID)).rejects.toMatchObject({
        code,
        context: { vendorId: 10, storeConnectionId: 44, retryable: false },
      });
      expectNoProviderCalls();
    });

    it.each(CAPABILITY_FAILURES)(
      "fails with $label's own error ($kind) instead of judging every shipping policy unchecked",
      async ({ error }) => {
        const failure = error();
        getCapability.mockRejectedValue(failure);

        await expect(service.getForMember(MEMBER_ID, STORE_CONNECTION_ID)).rejects.toBe(failure);
        // It reads the cached Card Shellz shipping answer, as the page read does.
        expect(getCapability).toHaveBeenCalledWith({ storeConnectionId: 44, marketplaceId: "EBAY_US" });
        // The failure is the caller's to report; this read logs no "shown without the shipping check" line.
        expect(logs.map((event) => event.code)).not.toContain("DROPSHIP_EBAY_LISTING_SETUP_CAPABILITY_UNAVAILABLE");
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      },
    );

    it.each(CAPABILITY_FAILURES)(
      "reports $label as unavailable ($kind) on the page read, where getForMember fails",
      async ({ kind, error }) => {
        const failure = error();
        getCapability.mockRejectedValue(failure);

        const view = await service.getViewForMember(MEMBER_ID, STORE_CONNECTION_ID);

        expect(view.checks.fulfillment).toEqual({ status: "unavailable", reference: failure.code, kind });
      },
    );

    it("refuses an editable view that came back without a config, before any eBay call", async () => {
      vi.spyOn(listingConfig, "getViewForMember").mockResolvedValue({
        vendor: { vendorId: VENDOR_ID, status: "active" },
        storeConnection: {
          vendorId: VENDOR_ID,
          storeConnectionId: STORE_CONNECTION_ID,
          platform: "ebay",
          status: "connected",
          setupStatus: "ready",
        },
        config: null,
        access: { canEdit: true, reason: null },
      });

      await expect(service.getForMember(MEMBER_ID, STORE_CONNECTION_ID)).rejects.toMatchObject({
        code: "DROPSHIP_LISTING_CONFIG_REQUIRED",
        context: { storeConnectionId: 44, retryable: false },
      });
      expectNoProviderCalls();
    });

    it("returns the checked live setup when eBay and Card Shellz shipping can both be read", async () => {
      listingConfig.config = makeConfig(completeMarketplaceConfig(), { revision: 3 });
      directory.discovery = withManagedLocationListed(directory.discovery);

      const result = await service.getForMember(MEMBER_ID, STORE_CONNECTION_ID);

      expect(result).toMatchObject({
        complete: true,
        missingFields: [],
        revision: 3,
        access: { canEdit: true, reason: null },
        checks: { ebay: "checked", fulfillment: { status: "checked" } },
        fulfillmentCapability: { source: { originWarehouseId: 1 } },
      });
      expect(locations.ensureForStoreConnection).not.toHaveBeenCalled();
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });
  });

  describe("replaceForMember (W2 store default save)", () => {
    it("rejects stale or fabricated vendor selections before writing config", async () => {
      await expect(service.replaceForMember("member-1", 44, saveBody({
        merchantLocationKey: "warehouse-main",
        fulfillmentPolicyId: "fabricated-policy",
        returnPolicyId: "return-1",
        paymentPolicyId: "payment-1",
      }))).rejects.toMatchObject({
        code: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID",
        context: { invalidFields: ["fulfillmentPolicyId"] },
      });
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    it("saves a validated vendor selection without changing unrelated listing config", async () => {
      directory.discovery = {
        ...directory.discovery,
        fulfillmentPolicies: [
          fulfillmentPolicy("fulfillment-1", "Standard"),
          fulfillmentPolicy("fulfillment-2", "Expedited"),
        ],
      };

      const result = await service.replaceForMember("member-1", 44, saveBody({
        fulfillmentPolicyId: "fulfillment-2",
        returnPolicyId: "return-1",
        paymentPolicyId: "payment-1",
      }));

      expect(result).toMatchObject({
        complete: true,
        outcome: "changed",
        revision: 2,
        access: { canEdit: true, reason: null },
        checks: { ebay: "checked", fulfillment: { status: "checked" } },
      });
      expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
      expect(listingConfig.config).toMatchObject({
        listingMode: "live",
        inventoryMode: "managed_quantity_sync",
        priceMode: "vendor_defined",
        isActive: true,
        marketplaceConfig: {
          unrelatedSetting: "preserved",
          businessPolicies: {
            unrelatedPolicySetting: "preserved",
            fulfillmentPolicyId: "fulfillment-2",
          },
        },
      });
      const { input, options } = lastMemberWrite();
      expect(input.expectedRevision).toBe(1);
      expect(options).toEqual({
        request: expect.objectContaining({ operation: "ebay_listing_setup_save", idempotencyKey: SAVE_KEY }),
        auditEventType: "listing_config_replaced",
        allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
      });
    });

    it("stores eBay's names for every policy the config holds after the save, each with the id it names", async () => {
      const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
        fulfillmentPolicyId: "fulfillment-1",
        returnPolicyId: "return-1",
        paymentPolicyId: "payment-1",
      }));

      expect(listingConfig.config!.marketplaceConfig.businessPolicyNames).toEqual({
        fulfillmentPolicyId: { id: "fulfillment-1", name: "Standard" },
        returnPolicyId: { id: "return-1", name: "Thirty days" },
        paymentPolicyId: { id: "payment-1", name: "Managed payments" },
      });
      expect(result.storedNames).toEqual({
        fulfillmentPolicyName: "Standard",
        returnPolicyName: "Thirty days",
        paymentPolicyName: "Managed payments",
      });
    });

    it("rejects a real eBay policy whose handling promise is shorter than the OMS SLA", async () => {
      directory.discovery = {
        ...directory.discovery,
        fulfillmentPolicies: [sameDayPolicy()],
      };

      await expect(service.replaceForMember("member-1", 44, saveBody({
        fulfillmentPolicyId: "fulfillment-fast",
        returnPolicyId: "return-1",
        paymentPolicyId: "payment-1",
      }))).rejects.toMatchObject({
        code: "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
        context: {
          fulfillmentPolicyId: "fulfillment-fast",
          issues: [expect.objectContaining({ code: "handling_time_too_short" })],
          retryable: false,
        },
      });
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    it("saves a return policy alone without reading Card Shellz shipping or touching the ship-from location", async () => {
      listingConfig.config = makeConfig(savedSetupMarketplaceConfig({ merchantLocationKey: "warehouse-west" }));
      directory.discovery = {
        ...directory.discovery,
        returnPolicies: [{ id: "return-1", name: "Thirty days" }, { id: "return-2", name: "Sixty days" }],
      };

      const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ returnPolicyId: "return-2" }));

      expect(getCapability).not.toHaveBeenCalled();
      expect(locations.ensureForStoreConnection).not.toHaveBeenCalled();
      expect(listLeafCategories).not.toHaveBeenCalled();
      expect(directory.storeConnectionCalls).toEqual([
        { vendorId: 10, storeConnectionId: 44, marketplaceId: "EBAY_US" },
      ]);
      expect(listingConfig.config!.marketplaceConfig).toEqual({
        ...savedSetupMarketplaceConfig({ merchantLocationKey: "warehouse-west" }),
        businessPolicies: {
          unrelatedPolicySetting: "preserved",
          fulfillmentPolicyId: "fulfillment-1",
          returnPolicyId: "return-2",
          paymentPolicyId: "payment-1",
        },
        businessPolicyNames: savedPolicyNames({ returnPolicyId: { id: "return-2", name: "Sixty days" } }),
      });
      expect(result).toMatchObject({
        outcome: "changed",
        revision: 2,
        // Without Card Shellz shipping the location is not judged and the setup can't be called complete.
        complete: false,
        missingFields: [],
        fulfillmentCapability: null,
        selection: { merchantLocationKey: "warehouse-west", returnPolicyId: "return-2" },
        checks: { ebay: "checked", fulfillment: { status: "not_checked" } },
        options: {
          fulfillmentPolicies: [expect.objectContaining({ id: "fulfillment-1", compatibilityChecked: false, compatible: false })],
        },
      });
      expect(logs.map((event) => event.code)).not.toContain("DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED");
    });

    it("saves a payment policy alone, leaving every other setting as it was", async () => {
      listingConfig.config = makeConfig(savedSetupMarketplaceConfig());
      directory.discovery = {
        ...directory.discovery,
        paymentPolicies: [{ id: "payment-1", name: "Managed payments" }, { id: "payment-2", name: "Invoice" }],
      };

      const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ paymentPolicyId: "payment-2" }));

      expect(getCapability).not.toHaveBeenCalled();
      expect(locations.ensureForStoreConnection).not.toHaveBeenCalled();
      expect(listingConfig.config!.marketplaceConfig).toEqual({
        ...savedSetupMarketplaceConfig(),
        businessPolicies: {
          unrelatedPolicySetting: "preserved",
          fulfillmentPolicyId: "fulfillment-1",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-2",
        },
        businessPolicyNames: savedPolicyNames({ paymentPolicyId: { id: "payment-2", name: "Invoice" } }),
      });
      expect(result).toMatchObject({ outcome: "changed", selection: { paymentPolicyId: "payment-2" } });
    });

    it("saves a shipping policy against fresh Card Shellz shipping and points listings at the managed location", async () => {
      listingConfig.config = makeConfig(savedSetupMarketplaceConfig({ merchantLocationKey: "warehouse-west" }));
      getCapability.mockResolvedValue(capability(2));

      const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
        fulfillmentPolicyId: "fulfillment-1",
      }));

      expect(getCapability).toHaveBeenCalledWith({ storeConnectionId: 44, marketplaceId: "EBAY_US", fresh: true });
      expect(locations.ensureForStoreConnection).toHaveBeenCalledWith({
        vendorId: 10,
        storeConnectionId: 44,
        originWarehouseId: 2,
      });
      expect(listLeafCategories).not.toHaveBeenCalled();
      expect(listingConfig.config!.marketplaceConfig.merchantLocationKey).toBe("cardshellz-dropship-wh-2");
      expect(result).toMatchObject({
        outcome: "changed",
        complete: true,
        missingFields: [],
        selection: { merchantLocationKey: "cardshellz-dropship-wh-2", fulfillmentPolicyId: "fulfillment-1" },
        checks: { ebay: "checked", fulfillment: { status: "checked" } },
      });
      expect(result.options.merchantLocations).toContainEqual({
        id: "cardshellz-dropship-wh-2",
        name: "Card Shellz Dropship - HQ",
      });
      expect(logs).toContainEqual(expect.objectContaining({
        code: "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED",
        context: expect.objectContaining({ merchantLocationKey: "cardshellz-dropship-wh-2", originWarehouseId: 2 }),
      }));
    });

    it("rejects a return policy eBay no longer lists without reading Card Shellz shipping or writing", async () => {
      await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
        returnPolicyId: "return-deleted",
      }))).rejects.toMatchObject({
        code: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID",
        context: { invalidFields: ["returnPolicyId"], retryable: false },
      });
      expect(getCapability).not.toHaveBeenCalled();
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    it("keeps a stored name for an untouched policy eBay no longer lists, and refreshes the names eBay does list", async () => {
      listingConfig.config = makeConfig({
        marketplaceId: "EBAY_US",
        merchantLocationKey: "cardshellz-dropship-wh-1",
        businessPolicies: {
          fulfillmentPolicyId: "saved-ground",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-1",
        },
        businessPolicyNames: savedPolicyNames({
          fulfillmentPolicyId: { id: "saved-ground", name: "Saved Ground" },
          returnPolicyId: { id: "return-1", name: "Thirty days (old name)" },
        }),
      });

      const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ returnPolicyId: "return-1" }));

      expect(listingConfig.config!.marketplaceConfig.businessPolicyNames).toEqual({
        fulfillmentPolicyId: { id: "saved-ground", name: "Saved Ground" },
        returnPolicyId: { id: "return-1", name: "Thirty days" },
        paymentPolicyId: { id: "payment-1", name: "Managed payments" },
      });
      expect(listingConfig.config!.marketplaceConfig.businessPolicies).toMatchObject({ fulfillmentPolicyId: "saved-ground" });
      // The live check still reports the unlisted shipping policy.
      expect(result.missingFields).toEqual(["fulfillmentPolicyId"]);
      expect(result.storedNames.fulfillmentPolicyName).toBe("Saved Ground");
    });

    describe("stored names follow the saved policy id", () => {
      /** The return policy was changed by another writer (staff PUT) that left the names as they were. */
      function configWithReturnPolicyChangedElsewhere(): DropshipStoreListingConfigRecord {
        return makeConfig(savedSetupMarketplaceConfig({
          businessPolicies: {
            unrelatedPolicySetting: "preserved",
            fulfillmentPolicyId: "fulfillment-1",
            returnPolicyId: "return-staff",
            paymentPolicyId: "payment-1",
          },
        }));
      }

      it("drops a stored name that names another id instead of carrying it over to the saved policy", async () => {
        listingConfig.config = configWithReturnPolicyChangedElsewhere();

        const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ paymentPolicyId: "payment-1" }));

        expect(listingConfig.config!.marketplaceConfig.businessPolicyNames).toEqual({
          fulfillmentPolicyId: { id: "fulfillment-1", name: "Standard" },
          paymentPolicyId: { id: "payment-1", name: "Managed payments" },
        });
        expect(result.selection.returnPolicyId).toBe("return-staff");
        expect(result.storedNames).toEqual({
          fulfillmentPolicyName: "Standard",
          returnPolicyName: null,
          paymentPolicyName: "Managed payments",
        });
        // eBay does not list return-staff, so the live check still flags it.
        expect(result.missingFields).toEqual(["returnPolicyId"]);
      });

      it("stores eBay's name for the id another writer saved, on the next save", async () => {
        listingConfig.config = configWithReturnPolicyChangedElsewhere();
        directory.discovery = {
          ...directory.discovery,
          returnPolicies: [{ id: "return-1", name: "Thirty days" }, { id: "return-staff", name: "Staff returns" }],
        };

        const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ paymentPolicyId: "payment-1" }));

        expect(listingConfig.config!.marketplaceConfig.businessPolicyNames).toEqual({
          fulfillmentPolicyId: { id: "fulfillment-1", name: "Standard" },
          returnPolicyId: { id: "return-staff", name: "Staff returns" },
          paymentPolicyId: { id: "payment-1", name: "Managed payments" },
        });
        expect(result.storedNames.returnPolicyName).toBe("Staff returns");
      });

      it("stores no name for a newly picked policy eBay lists without one, never the previous policy's name", async () => {
        listingConfig.config = makeConfig(savedSetupMarketplaceConfig());
        directory.discovery = {
          ...directory.discovery,
          returnPolicies: [{ id: "return-1", name: "Thirty days" }, { id: "return-2", name: "   " }],
        };

        const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ returnPolicyId: "return-2" }));

        expect(listingConfig.config!.marketplaceConfig.businessPolicies).toMatchObject({ returnPolicyId: "return-2" });
        expect(listingConfig.config!.marketplaceConfig.businessPolicyNames).toEqual({
          fulfillmentPolicyId: { id: "fulfillment-1", name: "Standard" },
          paymentPolicyId: { id: "payment-1", name: "Managed payments" },
        });
        expect(result.storedNames.returnPolicyName).toBeNull();
      });

      it("never changes the config it read while building the save", async () => {
        const before = makeConfig(savedSetupMarketplaceConfig());
        const snapshot = structuredClone(before);
        listingConfig.config = before;
        directory.discovery = {
          ...directory.discovery,
          returnPolicies: [{ id: "return-1", name: "Thirty days" }, { id: "return-2", name: "Sixty days" }],
        };

        await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
          returnPolicyId: "return-2",
          storeShelfDefault: { ids: ["101"] },
        }));

        expect(before).toEqual(snapshot);
        expect(listingConfig.config).not.toBe(before);
      });
    });

    it("reports outcome unchanged when the save says what the settings already say", async () => {
      listingConfig.config = makeConfig(savedSetupMarketplaceConfig(), { revision: 4 });

      const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
        expectedRevision: 4,
        returnPolicyId: "return-1",
      }));

      expect(result).toMatchObject({ outcome: "unchanged", revision: 4 });
      expect(listingConfig.config!.revision).toBe(4);
    });

    describe("store shelf default", () => {
      it("validates the shelves against the eBay store and stores their paths as the names, primary first", async () => {
        const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
          storeShelfDefault: { ids: ["102", "101"] },
        }));

        expect(listLeafCategories).toHaveBeenCalledWith({ vendorId: 10, storeConnectionId: 44 });
        // A shelf-only save needs neither eBay's policy lists nor Card Shellz shipping.
        expect(directory.storeConnectionCalls).toEqual([]);
        expect(getCapability).not.toHaveBeenCalled();
        expect(locations.ensureForStoreConnection).not.toHaveBeenCalled();
        expect(listingConfig.config!.marketplaceConfig).toEqual({
          ...makeConfig().marketplaceConfig,
          storeShelfDefault: {
            ids: ["102", "101"],
            names: ["Supplies:Penny sleeves", "Supplies:Toploaders"],
          },
        });
        expect(result).toMatchObject({
          outcome: "changed",
          storeShelfDefault: { ids: ["102", "101"], names: ["Supplies:Penny sleeves", "Supplies:Toploaders"] },
          checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
          options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
        });
      });

      it("refuses a shelf the eBay store no longer has, without writing", async () => {
        await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
          storeShelfDefault: { ids: ["101", "999"] },
        }))).rejects.toMatchObject({
          code: "DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID",
          context: { storeConnectionId: 44, invalidFields: ["storeShelfDefault"], retryable: false },
        });
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
        expect(listingConfig.config!.revision).toBe(1);
      });

      it("clears the shelf default with null without any eBay call", async () => {
        listingConfig.config = makeConfig({
          ...makeConfig().marketplaceConfig,
          storeShelfDefault: { ids: ["101"], names: ["Supplies:Toploaders"] },
        });

        const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ storeShelfDefault: null }));

        expectNoProviderCalls();
        expect(listingConfig.config!.marketplaceConfig).toEqual(makeConfig().marketplaceConfig);
        expect(result).toMatchObject({ outcome: "changed", revision: 2, storeShelfDefault: null });
      });

      it("lets a store that needs a new eBay sign-in clear its shelf default", async () => {
        listingConfig.storeStatus = "needs_reauth";
        listingConfig.config = makeConfig({
          ...makeConfig().marketplaceConfig,
          storeShelfDefault: { ids: ["101"], names: ["Supplies:Toploaders"] },
        });

        const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ storeShelfDefault: null }));

        expectNoProviderCalls();
        expect(result.outcome).toBe("changed");
      });
    });

    describe("request key replay", () => {
      it("answers a retry of a recorded request as replayed, before the revision check, with no eBay call or write", async () => {
        const body = saveBody({ returnPolicyId: "return-1", paymentPolicyId: "payment-1" });
        const first = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body);
        expect(first).toMatchObject({ outcome: "changed", revision: 2 });
        clearProviderCalls();
        listingConfig.replaceMember.mockClear();
        const configAfterFirstSave = listingConfig.config;

        // expectedRevision 1 is stale now; a retry must still be answered, not refused.
        const retry = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body);

        expect(retry).toMatchObject({
          outcome: "replayed",
          revision: 2,
          selection: { returnPolicyId: "return-1", paymentPolicyId: "payment-1" },
          checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
          options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
        });
        expectNoProviderCalls();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
        expect(listingConfig.config).toBe(configAfterFirstSave);
      });

      it.each([
        { vendorStatus: "suspended", storeStatus: "connected", reason: "vendor_not_active" },
        { vendorStatus: "active", storeStatus: "paused", reason: "store_paused" },
        { vendorStatus: "active", storeStatus: "grace_period", reason: "store_disconnecting" },
        { vendorStatus: "active", storeStatus: "disconnected", reason: "store_disconnected" },
      ] as const)(
        "answers a retry as replayed, not refused, after the settings became read-only ($reason)",
        async ({ vendorStatus, storeStatus, reason }) => {
          const body = saveBody({ returnPolicyId: "return-1", paymentPolicyId: "payment-1" });
          await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body);
          clearProviderCalls();
          listingConfig.replaceMember.mockClear();
          logs.length = 0;
          listingConfig.vendorStatus = vendorStatus;
          listingConfig.storeStatus = storeStatus;

          const retry = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body);

          expect(retry).toMatchObject({
            outcome: "replayed",
            revision: 2,
            access: { canEdit: false, reason },
            selection: { returnPolicyId: "return-1", paymentPolicyId: "payment-1" },
            checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
          });
          expectNoProviderCalls();
          expect(listingConfig.replaceMember).not.toHaveBeenCalled();
          expect(logs.map((event) => event.code)).not.toContain("DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED");
        },
      );

      it("answers a retry from the config as it is now, including a later save, not as the first save left it", async () => {
        directory.discovery = {
          ...directory.discovery,
          paymentPolicies: [{ id: "payment-1", name: "Managed payments" }, { id: "payment-2", name: "Invoice" }],
        };
        const body = saveBody({ returnPolicyId: "return-1" });
        await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body)).resolves.toMatchObject({ revision: 2 });
        await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
          expectedRevision: 2,
          idempotencyKey: "setup-save-0002",
          paymentPolicyId: "payment-2",
        }))).resolves.toMatchObject({ outcome: "changed", revision: 3 });
        clearProviderCalls();
        listingConfig.replaceMember.mockClear();
        listingConfig.findConfig.mockClear();

        const retry = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body);

        // The ledger says the first save ended at revision 2; the answer is the config now.
        expect(listingConfig.ledger.get(ledgerKey(VENDOR_ID, SAVE_KEY))).toMatchObject({ revisionAfter: 2 });
        expect(retry).toMatchObject({
          outcome: "replayed",
          revision: 3,
          selection: { returnPolicyId: "return-1", paymentPolicyId: "payment-2" },
          storedNames: { returnPolicyName: "Thirty days", paymentPolicyName: "Invoice" },
        });
        expect(listingConfig.findConfig).toHaveBeenCalledTimes(1);
        expect(listingConfig.findConfig).toHaveBeenCalledWith({ storeConnectionId: STORE_CONNECTION_ID });
        expectNoProviderCalls();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it("reads the replay answer after finding the recorded request, so a save committed meanwhile is shown", async () => {
        const body = saveBody({ returnPolicyId: "return-1" });
        await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body);
        const findKeyedRequest = listingConfig.findKeyedRequest.bind(listingConfig);
        vi.spyOn(listingConfig, "findKeyedRequest").mockImplementation(async (input) => {
          // Another save commits after this retry loaded its view, before the replay reads the config.
          listingConfig.config = makeConfig({
            ...listingConfig.config!.marketplaceConfig,
            storeShelfDefault: { ids: ["101"], names: ["Supplies:Toploaders"] },
          }, { revision: 3 });
          return findKeyedRequest(input);
        });

        const retry = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body);

        expect(retry).toMatchObject({
          outcome: "replayed",
          revision: 3,
          storeShelfDefault: { ids: ["101"], names: ["Supplies:Toploaders"] },
        });
      });

      it("refuses another body under a recorded key as an idempotency conflict even on a paused store", async () => {
        await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ returnPolicyId: "return-1" }));
        clearProviderCalls();
        listingConfig.replaceMember.mockClear();
        listingConfig.storeStatus = "paused";

        await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
          returnPolicyId: "return-2",
        }))).rejects.toMatchObject({
          code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
          context: { storeConnectionId: 44, retryable: false },
        });
        expectNoProviderCalls();
        expect(listingConfig.findConfig).not.toHaveBeenCalled();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it("looks the key up for this vendor, and treats a key never recorded as a new save", async () => {
        const findKeyedRequest = vi.spyOn(listingConfig, "findKeyedRequest");

        const result = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ returnPolicyId: "return-1" }));

        expect(findKeyedRequest).toHaveBeenCalledWith({ vendorId: VENDOR_ID, idempotencyKey: SAVE_KEY });
        expect(result.outcome).toBe("changed");
        expect(listingConfig.findConfig).not.toHaveBeenCalled();
        expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
      });

      it.each([
        { label: "another policy", body: saveBody({ returnPolicyId: "return-2" }) },
        { label: "another expected revision", body: saveBody({ expectedRevision: 2, returnPolicyId: "return-1" }) },
        { label: "the shelf default", body: saveBody({ returnPolicyId: "return-1", storeShelfDefault: null }) },
      ])("refuses the same key with $label as an idempotency conflict, with no eBay call or write", async ({ body }) => {
        await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ returnPolicyId: "return-1" }));
        clearProviderCalls();
        listingConfig.replaceMember.mockClear();

        await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body)).rejects.toMatchObject({
          code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
          context: { storeConnectionId: 44, retryable: false },
        });
        expectNoProviderCalls();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it("refuses a save key reused for a ship-from repair", async () => {
        await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ returnPolicyId: "return-1" }));
        clearProviderCalls();
        listingConfig.replaceMember.mockClear();

        await expect(service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, {
          expectedRevision: 2,
          idempotencyKey: SAVE_KEY,
        })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT" });
        expectNoProviderCalls();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it("refuses a key recorded for another store even when the hash matches", async () => {
        const body = saveBody({ returnPolicyId: "return-1" });
        await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body);
        const entry = listingConfig.ledger.get(ledgerKey(VENDOR_ID, SAVE_KEY))!;
        listingConfig.ledger.set(ledgerKey(VENDOR_ID, SAVE_KEY), { ...entry, storeConnectionId: 45 });
        clearProviderCalls();
        listingConfig.replaceMember.mockClear();

        await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body)).rejects.toMatchObject({
          code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
        });
        expectNoProviderCalls();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });
    });

    it.each([
      { label: "a shipping policy", body: { fulfillmentPolicyId: "fulfillment-1" } },
      { label: "a shelf default", body: { storeShelfDefault: { ids: ["101"] } } },
    ])("refuses a stale expectedRevision for $label before any eBay or Card Shellz call", async ({ body }) => {
      listingConfig.config = makeConfig(undefined, { revision: 3 });

      await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
        expectedRevision: 2,
        ...body,
      }))).rejects.toMatchObject({
        code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        context: { storeConnectionId: 44, expectedRevision: 2, currentRevision: 3, retryable: false },
      });
      expectNoProviderCalls();
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    it.each([
      { storeStatus: "paused", code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" },
      { storeStatus: "grace_period", code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING" },
      { storeStatus: "disconnected", code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED" },
    ] as const)("refuses a save on a $storeStatus store with $code before any eBay call", async ({ storeStatus, code }) => {
      listingConfig.storeStatus = storeStatus;

      await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
        fulfillmentPolicyId: "fulfillment-1",
      }))).rejects.toMatchObject({
        code,
        context: { vendorId: 10, storeConnectionId: 44, status: storeStatus, retryable: false },
      });
      expectNoProviderCalls();
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    describe("request schema", () => {
      it.each([
        { label: "no policy and no shelf default", body: { expectedRevision: 1, idempotencyKey: SAVE_KEY } },
        {
          label: "only the ignored legacy location",
          body: { expectedRevision: 1, idempotencyKey: SAVE_KEY, merchantLocationKey: "warehouse-main" },
        },
      ])("requires at least one field to save ($label)", async ({ body }) => {
        const getForMember = vi.spyOn(listingConfig, "getForMember");

        const error = await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body).catch((caught) => caught);

        expect(error).toBeInstanceOf(ZodError);
        expect((error as ZodError).issues.map((issue) => issue.message)).toContain(
          "Send at least one policy or the shelf default to save.",
        );
        expect(getForMember).not.toHaveBeenCalled();
        expectNoProviderCalls();
      });

      it.each([
        { label: "a missing expectedRevision", body: { idempotencyKey: SAVE_KEY, returnPolicyId: "return-1" } },
        { label: "a zero expectedRevision", body: saveBody({ expectedRevision: 0, returnPolicyId: "return-1" }) },
        { label: "a fractional expectedRevision", body: saveBody({ expectedRevision: 1.5, returnPolicyId: "return-1" }) },
        { label: "an expectedRevision past the integer column", body: saveBody({ expectedRevision: 2_147_483_648, returnPolicyId: "return-1" }) },
        { label: "a missing request key", body: { expectedRevision: 1, returnPolicyId: "return-1" } },
        { label: "a short request key", body: saveBody({ idempotencyKey: "short", returnPolicyId: "return-1" }) },
        { label: "a request key with spaces", body: saveBody({ idempotencyKey: "has spaces 0001", returnPolicyId: "return-1" }) },
        { label: "a blank policy id", body: saveBody({ returnPolicyId: "   " }) },
        { label: "an empty shelf list", body: saveBody({ storeShelfDefault: { ids: [] } }) },
        { label: "three shelves", body: saveBody({ storeShelfDefault: { ids: ["101", "102", "103"] } }) },
        { label: "the same shelf twice", body: saveBody({ storeShelfDefault: { ids: ["101", "101"] } }) },
        { label: "shelf names sent by the client", body: saveBody({ storeShelfDefault: { ids: ["101"], names: ["x"] } }) },
        { label: "an unknown field", body: saveBody({ returnPolicyId: "return-1", listingMode: "live" }) },
      ])("rejects $label before loading the config", async ({ body }) => {
        const getForMember = vi.spyOn(listingConfig, "getForMember");

        await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body)).rejects.toBeInstanceOf(ZodError);
        expect(getForMember).not.toHaveBeenCalled();
        expectNoProviderCalls();
      });
    });

    describe("request hash", () => {
      async function savedRequest(body: Record<string, unknown>): Promise<DropshipListingConfigKeyedRequest> {
        listingConfig.config = makeConfig(undefined, { revision: Number(body.expectedRevision) });
        listingConfig.ledger.clear();
        listingConfig.replaceMember.mockClear();
        await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body);
        const request = lastMemberWrite().options.request;
        if (!request) throw new Error("Expected a keyed request");
        return request;
      }

      it("hashes the same save the same way whatever the field order or surrounding whitespace", async () => {
        const first = await savedRequest({
          expectedRevision: 1,
          idempotencyKey: SAVE_KEY,
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-1",
        });
        const reordered = await savedRequest({
          paymentPolicyId: " payment-1 ",
          returnPolicyId: "return-1",
          idempotencyKey: SAVE_KEY,
          expectedRevision: 1,
        });
        const withLegacyLocation = await savedRequest({
          expectedRevision: 1,
          idempotencyKey: SAVE_KEY,
          merchantLocationKey: "warehouse-main",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-1",
        });

        expect(first.requestHash).toMatch(/^[0-9a-f]{64}$/);
        expect(reordered.requestHash).toBe(first.requestHash);
        // The legacy location is ignored by the save, so it can't make a retry look different.
        expect(withLegacyLocation.requestHash).toBe(first.requestHash);
        expect(first).toMatchObject({ operation: "ebay_listing_setup_save", idempotencyKey: SAVE_KEY });
      });

      it("hashes the canonical form: sorted keys, version 1, the operation, the store and the normalized body", async () => {
        const request = await savedRequest(saveBody({ paymentPolicyId: "payment-1" }));

        const canonical = '{"body":{"expectedRevision":1,"fulfillmentPolicyId":null,"paymentPolicyId":"payment-1",'
          + '"returnPolicyId":null,"storeShelfDefault":"unchanged"},"operation":"ebay_listing_setup_save",'
          + '"storeConnectionId":44,"version":1}';
        expect(request.requestHash).toBe(sha256Hex(canonical));
      });

      it("hashes a different expectedRevision differently", async () => {
        const atRevisionOne = await savedRequest(saveBody({ expectedRevision: 1, returnPolicyId: "return-1" }));
        const atRevisionTwo = await savedRequest(saveBody({ expectedRevision: 2, returnPolicyId: "return-1" }));

        expect(atRevisionTwo.requestHash).not.toBe(atRevisionOne.requestHash);
      });

      it("tells a cleared shelf default from an untouched one, and the primary shelf from the secondary", async () => {
        const untouched = await savedRequest(saveBody({ returnPolicyId: "return-1" }));
        const cleared = await savedRequest(saveBody({ returnPolicyId: "return-1", storeShelfDefault: null }));
        const primaryFirst = await savedRequest(saveBody({ storeShelfDefault: { ids: ["101", "102"] } }));
        const secondaryFirst = await savedRequest(saveBody({ storeShelfDefault: { ids: ["102", "101"] } }));

        expect(cleared.requestHash).not.toBe(untouched.requestHash);
        expect(secondaryFirst.requestHash).not.toBe(primaryFirst.requestHash);
      });
    });
  });

  describe("repairShipFromForMember (W10)", () => {
    it("re-points listings at the managed location from fresh Card Shellz shipping, changing nothing else", async () => {
      const before = savedSetupMarketplaceConfig({
        merchantLocationKey: "cardshellz-dropship-wh-1",
        // A stored name eBay has since changed: the repair must not touch names.
        businessPolicyNames: savedPolicyNames({ returnPolicyId: { id: "return-1", name: "Thirty days (old name)" } }),
        storeShelfDefault: { ids: ["101"], names: ["Supplies:Toploaders"] },
      });
      listingConfig.config = makeConfig(before, { revision: 4 });
      // Card Shellz moved the store to warehouse 2.
      getCapability.mockResolvedValue(capability(2));

      const result = await service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, {
        expectedRevision: 4,
        idempotencyKey: REPAIR_KEY,
      });

      expect(getCapability).toHaveBeenCalledWith({ storeConnectionId: 44, marketplaceId: "EBAY_US", fresh: true });
      expect(locations.ensureForStoreConnection).toHaveBeenCalledWith({
        vendorId: 10,
        storeConnectionId: 44,
        originWarehouseId: 2,
      });
      expect(directory.storeConnectionCalls).toEqual([
        { vendorId: 10, storeConnectionId: 44, marketplaceId: "EBAY_US" },
      ]);
      expect(listLeafCategories).not.toHaveBeenCalled();

      const { input, options } = lastMemberWrite();
      expect(input).toMatchObject({ expectedRevision: 4, listingMode: "live", isActive: true });
      expect(input.marketplaceConfig).toEqual({ ...before, merchantLocationKey: "cardshellz-dropship-wh-2" });
      expect(options).toEqual({
        request: {
          operation: "ebay_ship_from_repair",
          idempotencyKey: REPAIR_KEY,
          requestHash: sha256Hex(
            '{"body":{"expectedRevision":4},"operation":"ebay_ship_from_repair","storeConnectionId":44,"version":1}',
          ),
        },
        auditEventType: "listing_config_ship_from_repaired",
        allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
      });
      expect(result).toMatchObject({
        outcome: "changed",
        revision: 5,
        complete: true,
        missingFields: [],
        selection: { merchantLocationKey: "cardshellz-dropship-wh-2" },
        checks: { ebay: "checked", fulfillment: { status: "checked" } },
        storedNames: { returnPolicyName: "Thirty days (old name)" },
        storeShelfDefault: { ids: ["101"], names: ["Supplies:Toploaders"] },
      });
      expect(logs).toContainEqual(expect.objectContaining({
        level: "info",
        code: "DROPSHIP_EBAY_SHIP_FROM_REPAIRED",
        context: {
          vendorId: 10,
          storeConnectionId: 44,
          merchantLocationKey: "cardshellz-dropship-wh-2",
          outcome: "changed",
          revisionBefore: 4,
          revisionAfter: 5,
          currentRevision: 5,
          requestKey: REPAIR_KEY,
        },
      }));
    });

    it("reports outcome unchanged when listings already point at the managed location", async () => {
      listingConfig.config = makeConfig(savedSetupMarketplaceConfig(), { revision: 2 });

      const result = await service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, {
        expectedRevision: 2,
        idempotencyKey: REPAIR_KEY,
      });

      expect(result).toMatchObject({ outcome: "unchanged", revision: 2 });
      expect(locations.ensureForStoreConnection).toHaveBeenCalledTimes(1);
      expect(logs).toContainEqual(expect.objectContaining({
        code: "DROPSHIP_EBAY_SHIP_FROM_REPAIRED",
        context: expect.objectContaining({ outcome: "unchanged", revisionBefore: 2, revisionAfter: 2, currentRevision: 2 }),
      }));
    });

    it("logs the ledger's revisionAfter and the revision now when the write itself finds the repair recorded", async () => {
      const discover = directory.discoverForStoreConnection.bind(directory);
      vi.spyOn(directory, "discoverForStoreConnection").mockImplementationOnce(async (input) => {
        // While this repair reads eBay, the same repair commits (1 -> 2) and a later save moves the config to 3.
        listingConfig.ledger.set(ledgerKey(VENDOR_ID, REPAIR_KEY), {
          vendorId: VENDOR_ID,
          idempotencyKey: REPAIR_KEY,
          storeConnectionId: STORE_CONNECTION_ID,
          operation: "ebay_ship_from_repair",
          requestHash: sha256Hex(
            '{"body":{"expectedRevision":1},"operation":"ebay_ship_from_repair","storeConnectionId":44,"version":1}',
          ),
          revisionBefore: 1,
          revisionAfter: 2,
          outcome: "changed",
          createdAt: now,
        });
        listingConfig.config = makeConfig(savedSetupMarketplaceConfig(), { revision: 3 });
        return discover(input);
      });

      const result = await service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, {
        expectedRevision: 1,
        idempotencyKey: REPAIR_KEY,
      });

      expect(result).toMatchObject({ outcome: "replayed", revision: 3 });
      expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
      expect(logs.filter((event) => event.code === "DROPSHIP_EBAY_SHIP_FROM_REPAIRED")).toEqual([{
        level: "info",
        code: "DROPSHIP_EBAY_SHIP_FROM_REPAIRED",
        message: expect.any(String),
        context: {
          vendorId: VENDOR_ID,
          storeConnectionId: STORE_CONNECTION_ID,
          merchantLocationKey: "cardshellz-dropship-wh-1",
          outcome: "replayed",
          revisionBefore: 1,
          revisionAfter: 2,
          currentRevision: 3,
          requestKey: REPAIR_KEY,
        },
      }]);
    });

    it("answers a retried repair as replayed with no eBay call or write", async () => {
      const body = { expectedRevision: 1, idempotencyKey: REPAIR_KEY };
      await service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, body);
      clearProviderCalls();
      listingConfig.replaceMember.mockClear();

      const retry = await service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, body);

      expect(retry.outcome).toBe("replayed");
      expectNoProviderCalls();
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    it("answers a retried repair as replayed after the store was paused, with the config as it is now", async () => {
      const body = { expectedRevision: 1, idempotencyKey: REPAIR_KEY };
      await expect(service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, body))
        .resolves.toMatchObject({ outcome: "changed", revision: 2 });
      clearProviderCalls();
      listingConfig.replaceMember.mockClear();
      listingConfig.storeStatus = "paused";

      const retry = await service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, body);

      expect(retry).toMatchObject({
        outcome: "replayed",
        revision: 2,
        access: { canEdit: false, reason: "store_paused" },
        selection: { merchantLocationKey: "cardshellz-dropship-wh-1" },
        checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
      });
      expect(listingConfig.findConfig).toHaveBeenCalledWith({ storeConnectionId: STORE_CONNECTION_ID });
      expectNoProviderCalls();
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    it("refuses a repair key reused with another expected revision as an idempotency conflict", async () => {
      await service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, { expectedRevision: 1, idempotencyKey: REPAIR_KEY });
      clearProviderCalls();
      listingConfig.replaceMember.mockClear();

      await expect(service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, {
        expectedRevision: 2,
        idempotencyKey: REPAIR_KEY,
      })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT" });
      expectNoProviderCalls();
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    it("refuses a stale expectedRevision before reading Card Shellz shipping", async () => {
      listingConfig.config = makeConfig(undefined, { revision: 3 });

      await expect(service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, {
        expectedRevision: 2,
        idempotencyKey: REPAIR_KEY,
      })).rejects.toMatchObject({
        code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        context: { expectedRevision: 2, currentRevision: 3 },
      });
      expectNoProviderCalls();
    });

    it("refuses a paused store before any eBay call", async () => {
      listingConfig.storeStatus = "paused";

      await expect(service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, {
        expectedRevision: 1,
        idempotencyKey: REPAIR_KEY,
      })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" });
      expectNoProviderCalls();
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    it("rejects a body with anything but the revision and request key", async () => {
      await expect(service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, {
        expectedRevision: 1,
        idempotencyKey: REPAIR_KEY,
        merchantLocationKey: "warehouse-west",
      })).rejects.toBeInstanceOf(ZodError);
      expectNoProviderCalls();
    });
  });

  describe("write refusal log (DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED)", () => {
    function refusalLogs(): LoggedEvent[] {
      return logs.filter((event) => event.code === "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED");
    }

    it.each([
      {
        label: "a stale expectedRevision",
        arrange: () => { listingConfig.config = makeConfig(undefined, { revision: 3 }); },
        body: saveBody({ expectedRevision: 2, returnPolicyId: "return-1" }),
        errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        expectedRevision: 2,
        currentRevision: 3,
      },
      {
        label: "a paused store",
        arrange: () => { listingConfig.storeStatus = "paused"; },
        body: saveBody({ returnPolicyId: "return-1" }),
        errorCode: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
        expectedRevision: 1,
        currentRevision: null,
      },
      {
        label: "a suspended vendor",
        arrange: () => { listingConfig.vendorStatus = "suspended"; },
        body: saveBody({ returnPolicyId: "return-1" }),
        errorCode: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
        expectedRevision: 1,
        currentRevision: null,
      },
      {
        label: "a policy eBay no longer lists",
        arrange: () => {},
        body: saveBody({ returnPolicyId: "return-deleted" }),
        errorCode: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID",
        expectedRevision: 1,
        currentRevision: null,
      },
      {
        label: "a shipping policy that does not fit Card Shellz shipping",
        arrange: () => { directory.discovery = { ...directory.discovery, fulfillmentPolicies: [sameDayPolicy()] }; },
        body: saveBody({ fulfillmentPolicyId: "fulfillment-fast" }),
        errorCode: "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
        expectedRevision: 1,
        currentRevision: null,
      },
      {
        label: "a shelf the eBay store no longer has",
        arrange: () => {},
        body: saveBody({ storeShelfDefault: { ids: ["999"] } }),
        errorCode: "DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID",
        expectedRevision: 1,
        currentRevision: null,
      },
      {
        label: "a rate table Card Shellz has not set up, for a shipping policy save",
        arrange: () => { getCapability.mockRejectedValue(CAPABILITY_FAILURES[1].error()); },
        body: saveBody({ fulfillmentPolicyId: "fulfillment-1" }),
        errorCode: "DROPSHIP_EBAY_FULFILLMENT_RATE_TABLE_REQUIRED",
        expectedRevision: 1,
        currentRevision: null,
      },
    ])("logs a save refused for $label once at INFO, with its code and the request's correlation fields", async ({
      arrange,
      body,
      errorCode,
      expectedRevision,
      currentRevision,
    }) => {
      arrange();

      await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body)).rejects.toMatchObject({ code: errorCode });

      expect(refusalLogs()).toEqual([{
        level: "info",
        code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED",
        message: expect.any(String),
        context: {
          operation: "ebay_listing_setup_save",
          vendorId: VENDOR_ID,
          storeConnectionId: STORE_CONNECTION_ID,
          requestKey: SAVE_KEY,
          expectedRevision,
          outcome: "refused",
          errorCode,
          currentRevision,
        },
      }]);
      // An expected refusal is not an anomaly: nothing at WARN or ERROR.
      expect(logs.filter((event) => event.level !== "info")).toEqual([]);
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: "a stale expectedRevision",
        arrange: () => { listingConfig.config = makeConfig(undefined, { revision: 3 }); },
        expectedRevision: 2,
        errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        currentRevision: 3,
      },
      {
        label: "a store on another eBay site",
        arrange: () => { getCapability.mockRejectedValue(CAPABILITY_FAILURES[3].error()); },
        expectedRevision: 1,
        errorCode: "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED",
        currentRevision: null,
      },
    ])("logs a ship-from repair refused for $label with its own operation and request key", async ({
      arrange,
      expectedRevision,
      errorCode,
      currentRevision,
    }) => {
      arrange();

      await expect(service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, {
        expectedRevision,
        idempotencyKey: REPAIR_KEY,
      })).rejects.toMatchObject({ code: errorCode });

      expect(refusalLogs()).toEqual([expect.objectContaining({
        level: "info",
        context: {
          operation: "ebay_ship_from_repair",
          vendorId: VENDOR_ID,
          storeConnectionId: STORE_CONNECTION_ID,
          requestKey: REPAIR_KEY,
          expectedRevision,
          outcome: "refused",
          errorCode,
          currentRevision,
        },
      })]);
      expect(logs.map((event) => event.code)).not.toContain("DROPSHIP_EBAY_SHIP_FROM_REPAIRED");
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    it("rethrows an unexpected (non-Dropship) failure untouched without calling it a refusal", async () => {
      const failure = new TypeError("Cannot read properties of undefined (reading 'policies')");
      vi.spyOn(directory, "discoverForStoreConnection").mockRejectedValue(failure);

      await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
        returnPolicyId: "return-1",
      }))).rejects.toBe(failure);

      expect(refusalLogs()).toEqual([]);
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });

    it("leaves a refusal by the write itself to the listing-config service's own log", async () => {
      // A save commits between this save's revision check and its write.
      const discover = directory.discoverForStoreConnection.bind(directory);
      vi.spyOn(directory, "discoverForStoreConnection").mockImplementation(async (input) => {
        listingConfig.config = makeConfig(undefined, { revision: 2 });
        return discover(input);
      });

      await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
        returnPolicyId: "return-1",
      }))).rejects.toMatchObject({
        code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        context: { expectedRevision: 1, currentRevision: 2 },
      });

      expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
      expect(refusalLogs()).toEqual([]);
    });

    it("logs no refusal for a save that is written", async () => {
      await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({ returnPolicyId: "return-1" }));

      expect(refusalLogs()).toEqual([]);
    });
  });

  /**
   * The two keyed writes that ensure the Card Shellz-managed eBay location
   * before they write, and their correlation fields.
   */
  interface LocationEnsuringWrite {
    label: string;
    operation: "ebay_listing_setup_save" | "ebay_ship_from_repair";
    requestKey: string;
    /** sha256 of body()'s canonical form, as the "request hash" tests pin it. */
    requestHash: string;
    body: () => Record<string, unknown>;
    send: (body: Record<string, unknown>) => Promise<DropshipEbayListingSetupWriteResult>;
    /** The line a write that lands logs after the location. */
    outcomeCode: string;
  }

  const LOCATION_ENSURING_WRITES: readonly LocationEnsuringWrite[] = [
    {
      label: "the W2 shipping policy save",
      operation: "ebay_listing_setup_save",
      requestKey: SAVE_KEY,
      requestHash: sha256Hex(
        '{"body":{"expectedRevision":1,"fulfillmentPolicyId":"fulfillment-1","paymentPolicyId":null,'
          + '"returnPolicyId":null,"storeShelfDefault":"unchanged"},"operation":"ebay_listing_setup_save",'
          + '"storeConnectionId":44,"version":1}',
      ),
      body: () => saveBody({ fulfillmentPolicyId: "fulfillment-1" }),
      send: (body) => service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body),
      outcomeCode: "DROPSHIP_EBAY_LISTING_SETUP_EVALUATED",
    },
    {
      label: "the W10 ship-from repair",
      operation: "ebay_ship_from_repair",
      requestKey: REPAIR_KEY,
      requestHash: sha256Hex(
        '{"body":{"expectedRevision":1},"operation":"ebay_ship_from_repair","storeConnectionId":44,"version":1}',
      ),
      body: () => ({ expectedRevision: 1, idempotencyKey: REPAIR_KEY }),
      send: (body) => service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, body),
      outcomeCode: "DROPSHIP_EBAY_SHIP_FROM_REPAIRED",
    },
  ];

  function keyedCorrelation(write: LocationEnsuringWrite, expectedRevision = 1) {
    return {
      operation: write.operation,
      vendorId: VENDOR_ID,
      storeConnectionId: STORE_CONNECTION_ID,
      requestKey: write.requestKey,
      expectedRevision,
    };
  }

  function loggedCodes(): string[] {
    return logs.map((event) => event.code);
  }

  /**
   * DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED is logged as soon as the
   * location is ensured, before anything that can still refuse the save: the
   * location may have just been created at eBay, which stays true when the
   * save is then refused, or answered as a replay after a refusal.
   */
  describe("managed location log (DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED)", () => {
    /**
     * The line names the request that ensured the location (its operation and
     * request key), so the eBay change is traced with that request. It carries
     * no expectedRevision: the location is not part of the revisioned config.
     */
    function locationLine(
      write: LocationEnsuringWrite,
      originWarehouseId: number,
      action: DropshipEbayManagedLocation["action"],
    ): LoggedEvent {
      return {
        level: "info",
        code: "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED",
        message: expect.any(String),
        context: {
          storeConnectionId: STORE_CONNECTION_ID,
          vendorId: VENDOR_ID,
          operation: write.operation,
          requestKey: write.requestKey,
          originWarehouseId,
          merchantLocationKey: managedMerchantLocationKeyForWarehouse(originWarehouseId),
          action,
        },
      };
    }

    function locationLines(): LoggedEvent[] {
      return logs.filter((event) => event.code === "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED");
    }

    /** The fake ensure, answering with `action` (e.g. a location eBay just created). */
    function ensureAnswers(action: DropshipEbayManagedLocation["action"]): void {
      const ensure = locations.ensureForStoreConnection.getMockImplementation();
      if (!ensure) throw new Error("Expected the fake managed-location ensure");
      locations.ensureForStoreConnection.mockImplementation(async (input) => ({ ...(await ensure(input)), action }));
    }

    /** Runs `hook` inside the eBay policy read, after the location was ensured; the read then answers normally. */
    function duringEbayRead(hook: () => void): void {
      const discover = directory.discoverForStoreConnection.bind(directory);
      vi.spyOn(directory, "discoverForStoreConnection").mockImplementationOnce(async (input) => {
        hook();
        return discover(input);
      });
    }

    describe.each(LOCATION_ENSURING_WRITES)("$label", (write) => {
      it.each(["created", "enabled", "updated", "unchanged"] as const)(
        "logs a %s location once, before the outcome line of a write that lands",
        async (action) => {
          // Card Shellz moved the store to warehouse 2.
          getCapability.mockResolvedValue(capability(2));
          ensureAnswers(action);

          const result = await write.send(write.body());

          expect(result).toMatchObject({
            outcome: "changed",
            selection: { merchantLocationKey: "cardshellz-dropship-wh-2" },
          });
          expect(locationLines()).toEqual([locationLine(write, 2, action)]);
          expect(loggedCodes()).toEqual(["DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED", write.outcomeCode]);
        },
      );

      it.each([
        {
          label: "the store was paused",
          errorCode: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
          change: () => { listingConfig.storeStatus = "paused"; },
        },
        {
          label: "another save moved the revision",
          errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
          change: () => { listingConfig.config = makeConfig(undefined, { revision: 2 }); },
        },
        {
          label: "the vendor was suspended",
          errorCode: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
          change: () => { listingConfig.vendorStatus = "suspended"; },
        },
      ])("logs the location once, and nothing after it, when the write is then refused because $label", async ({
        errorCode,
        change,
      }) => {
        ensureAnswers("created");
        duringEbayRead(change);

        await expect(write.send(write.body())).rejects.toMatchObject({ code: errorCode });

        expect(locations.ensureForStoreConnection).toHaveBeenCalledTimes(1);
        expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
        // The write's own refusal is the listing-config service's line; this service adds only the location.
        expect(logs).toEqual([locationLine(write, 1, "created")]);
      });

      it("logs the location once, before the replay line, when a refused write's request is found committed", async () => {
        ensureAnswers("created");
        duringEbayRead(() => {
          // The same request (key and body) commits elsewhere, then the store is paused.
          listingConfig.ledger.set(ledgerKey(VENDOR_ID, write.requestKey), {
            vendorId: VENDOR_ID,
            idempotencyKey: write.requestKey,
            storeConnectionId: STORE_CONNECTION_ID,
            operation: write.operation,
            requestHash: write.requestHash,
            revisionBefore: 1,
            revisionAfter: 2,
            outcome: "changed",
            createdAt: now,
          });
          listingConfig.config = makeConfig(savedSetupMarketplaceConfig(), { revision: 2 });
          listingConfig.storeStatus = "paused";
        });

        const result = await write.send(write.body());

        expect(result).toMatchObject({ outcome: "replayed", revision: 2 });
        expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
        expect(loggedCodes()).toEqual([
          "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED",
          "DROPSHIP_EBAY_LISTING_SETUP_REPLAYED",
        ]);
        expect(logs[0]).toEqual(locationLine(write, 1, "created"));
        expect(logs[1]!.context).toMatchObject({ afterRefusalCode: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" });
      });

      it("logs the location once, before the WARN outage line, when eBay can't be reached after it", async () => {
        vi.spyOn(directory, "discoverForStoreConnection").mockRejectedValueOnce(new DropshipError(
          "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
          "eBay listing setup could not be loaded.",
          { storeConnectionId: STORE_CONNECTION_ID, resource: "fulfillment_policies", retryable: true },
        ));

        await expect(write.send(write.body())).rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE" });

        expect(logs.map((event) => [event.level, event.code])).toEqual([
          ["info", "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED"],
          ["warn", "DROPSHIP_EBAY_LISTING_SETUP_WRITE_UNAVAILABLE"],
        ]);
        expect(logs[0]).toEqual(locationLine(write, 1, "unchanged"));
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it.each([
        {
          label: "a stale expectedRevision",
          errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
          outcomeLine: ["info", "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED"],
          arrange: () => { listingConfig.config = makeConfig(undefined, { revision: 3 }); },
        },
        {
          label: "a paused store",
          errorCode: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
          outcomeLine: ["info", "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED"],
          arrange: () => { listingConfig.storeStatus = "paused"; },
        },
        {
          label: "Card Shellz shipping that can't be read",
          errorCode: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
          outcomeLine: ["warn", "DROPSHIP_EBAY_LISTING_SETUP_WRITE_UNAVAILABLE"],
          arrange: () => { getCapability.mockRejectedValue(CAPABILITY_FAILURES[0].error()); },
        },
        {
          label: "a location eBay would not ensure",
          errorCode: "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE",
          outcomeLine: ["warn", "DROPSHIP_EBAY_LISTING_SETUP_WRITE_UNAVAILABLE"],
          arrange: () => {
            locations.ensureForStoreConnection.mockRejectedValueOnce(new DropshipError(
              "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE",
              "The Card Shellz-managed eBay location could not be checked.",
              { storeConnectionId: STORE_CONNECTION_ID, retryable: true },
            ));
          },
        },
      ])("logs no location when the save is refused before the location is ensured ($label)", async ({
        errorCode,
        outcomeLine,
        arrange,
      }) => {
        arrange();

        await expect(write.send(write.body())).rejects.toMatchObject({ code: errorCode });

        expect(locationLines()).toEqual([]);
        expect(logs.map((event) => [event.level, event.code])).toEqual([outcomeLine]);
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });
    });

    it.each([
      { label: "a return policy", body: saveBody({ returnPolicyId: "return-1" }) },
      { label: "a payment policy", body: saveBody({ paymentPolicyId: "payment-1" }) },
      { label: "a return and a payment policy", body: saveBody({ returnPolicyId: "return-1", paymentPolicyId: "payment-1" }) },
      { label: "a shelf default", body: saveBody({ storeShelfDefault: { ids: ["101"] } }) },
      { label: "a cleared shelf default", body: saveBody({ storeShelfDefault: null }) },
    ])("logs no location for a W2 save that sends no shipping policy ($label)", async ({ body }) => {
      await service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body);

      expect(locations.ensureForStoreConnection).not.toHaveBeenCalled();
      expect(loggedCodes()).toEqual(["DROPSHIP_EBAY_LISTING_SETUP_EVALUATED"]);
    });

    it("logs no location for a refused W2 save that sends no shipping policy", async () => {
      await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
        returnPolicyId: "return-deleted",
      }))).rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID" });

      expect(locations.ensureForStoreConnection).not.toHaveBeenCalled();
      expect(loggedCodes()).toEqual(["DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED"]);
    });

    it("logs the location before refusing a W2 shipping policy that does not fit Card Shellz shipping", async () => {
      directory.discovery = { ...directory.discovery, fulfillmentPolicies: [sameDayPolicy()] };

      await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
        fulfillmentPolicyId: "fulfillment-fast",
      }))).rejects.toMatchObject({ code: "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE" });

      expect(loggedCodes()).toEqual([
        "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED",
        "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED",
      ]);
      expect(logs[0]).toEqual(locationLine(LOCATION_ENSURING_WRITES[0], 1, "unchanged"));
    });
  });

  /**
   * A refusal found before the write whose code says a check that should
   * always hold did not (dropshipListingConfigFault) is one ERROR line,
   * DROPSHIP_EBAY_LISTING_SETUP_WRITE_FAILED with outcome "failed", never the
   * INFO refusal line.
   */
  describe("write failure log (DROPSHIP_EBAY_LISTING_SETUP_WRITE_FAILED)", () => {
    const FAULT_CODES = [
      "DROPSHIP_EBAY_LISTING_SETUP_INVARIANT_FAILED",
      "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED",
      "DROPSHIP_LISTING_CONFIG_REQUEST_ACTOR_REQUIRED",
      "DROPSHIP_LISTING_CONFIG_REVISION_INVALID",
      "DROPSHIP_LISTING_CONFIG_REQUIRED",
    ] as const;

    function failureLine(write: LocationEnsuringWrite, errorCode: string, currentRevision: unknown = null): LoggedEvent {
      return {
        level: "error",
        code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_FAILED",
        message: expect.any(String),
        context: { ...keyedCorrelation(write), errorCode, currentRevision, outcome: "failed" },
      };
    }

    describe.each(LOCATION_ENSURING_WRITES)("$label", (write) => {
      it.each(FAULT_CODES)("logs a planning failure with %s once at ERROR as failed, with nothing at INFO", async (code) => {
        // Card Shellz shipping is the first call out in both writes' planning,
        // so each code reaches the refusal log the same way.
        const fault = new DropshipError(code, "A check that should always hold did not.", {
          storeConnectionId: STORE_CONNECTION_ID,
          retryable: false,
        });
        getCapability.mockRejectedValue(fault);

        await expect(write.send(write.body())).rejects.toBe(fault);

        expect(logs).toEqual([failureLine(write, code)]);
        expect(logs.filter((event) => event.level === "info")).toEqual([]);
        expect(locations.ensureForStoreConnection).not.toHaveBeenCalled();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it("logs an editable view that came back without a config once at ERROR as failed, before any eBay call", async () => {
        vi.spyOn(listingConfig, "getViewForMember").mockResolvedValue({
          vendor: { vendorId: VENDOR_ID, status: "active" },
          storeConnection: {
            vendorId: VENDOR_ID,
            storeConnectionId: STORE_CONNECTION_ID,
            platform: "ebay",
            status: "connected",
            setupStatus: "ready",
          },
          config: null,
          access: { canEdit: true, reason: null },
        });

        await expect(write.send(write.body())).rejects.toMatchObject({
          code: "DROPSHIP_LISTING_CONFIG_REQUIRED",
          context: { storeConnectionId: STORE_CONNECTION_ID, retryable: false },
        });

        expect(logs).toEqual([failureLine(write, "DROPSHIP_LISTING_CONFIG_REQUIRED")]);
        expectNoProviderCalls();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it("carries a fault's currentRevision into the failure line", async () => {
        const fault = new DropshipError(
          "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED",
          "The listing config revision did not advance by exactly one.",
          { storeConnectionId: STORE_CONNECTION_ID, currentRevision: 6, retryable: false },
        );
        getCapability.mockRejectedValue(fault);

        await expect(write.send(write.body())).rejects.toBe(fault);

        expect(logs).toEqual([failureLine(write, fault.code, 6)]);
      });

      it("leaves a fault the write itself found to the listing-config service's own log", async () => {
        const fault = new DropshipError(
          "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED",
          "The listing config revision did not advance by exactly one.",
          { storeConnectionId: STORE_CONNECTION_ID, revisionBefore: 1, revisionAfter: 3, retryable: false },
        );
        listingConfig.replaceMember.mockRejectedValueOnce(fault);

        await expect(write.send(write.body())).rejects.toBe(fault);

        // Only the location ensured on the way is logged here.
        expect(loggedCodes()).toEqual(["DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED"]);
        expect(logs.filter((event) => event.level !== "info")).toEqual([]);
      });

      // The passing outage (kind "temporary") is a provider failure, logged at
      // WARN; see the write unavailable log below.
      it.each(CAPABILITY_FAILURES.filter((failure) => failure.kind !== "temporary"))(
        "keeps $label, an expected refusal, at INFO as refused, never ERROR",
        async ({ error }) => {
          const failure = error();
          getCapability.mockRejectedValue(failure);

          await expect(write.send(write.body())).rejects.toBe(failure);

          expect(logs).toEqual([{
            level: "info",
            code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED",
            message: expect.any(String),
            context: { ...keyedCorrelation(write), errorCode: failure.code, currentRevision: null, outcome: "refused" },
          }]);
        },
      );
    });
  });

  /**
   * eBay or Card Shellz shipping failing to answer, found before the write
   * (dropshipEbayProviderFailure: context.retryable === true, or a code that
   * ends with _UNAVAILABLE or _INVALID_RESPONSE), is one WARN line,
   * DROPSHIP_EBAY_LISTING_SETUP_WRITE_UNAVAILABLE with outcome "failed": an
   * outage worth noticing, not a refusal by the rules (INFO) and not a broken
   * invariant (ERROR, which wins when both apply).
   */
  describe("write unavailable log (DROPSHIP_EBAY_LISTING_SETUP_WRITE_UNAVAILABLE)", () => {
    type LineKind = "unavailable" | "refused" | "failed";

    const LINE_BY_KIND: Record<LineKind, { level: LoggedEvent["level"]; code: string; outcome: string }> = {
      unavailable: { level: "warn", code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_UNAVAILABLE", outcome: "failed" },
      refused: { level: "info", code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED", outcome: "refused" },
      failed: { level: "error", code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_FAILED", outcome: "failed" },
    };

    function outcomeLine(
      write: LocationEnsuringWrite,
      kind: LineKind,
      errorCode: string,
      currentRevision: unknown = null,
    ): LoggedEvent {
      const { level, code, outcome } = LINE_BY_KIND[kind];
      return {
        level,
        code,
        message: expect.any(String),
        context: { ...keyedCorrelation(write), errorCode, currentRevision, outcome },
      };
    }

    /**
     * Each failure is thrown by the managed-location ensure, a call out both
     * writes make before eBay is read. Only context.retryable === true makes
     * an outage (the same rule as a page read); a code that names one but is
     * not marked retryable is a refusal or setup gap, as on the read path.
     * The ensure failing also means no location line is logged.
     */
    const CLASSIFIED_FAILURES: ReadonlyArray<{ label: string; kind: LineKind; error: () => DropshipError }> = [
      {
        label: "a failure marked retryable: true whose code names no outage",
        kind: "unavailable",
        error: () => new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_CREATE_CONFLICT",
          "The managed eBay inventory location could not be confirmed after a concurrent create.",
          { storeConnectionId: STORE_CONNECTION_ID, retryable: true },
        ),
      },
      {
        label: "an _UNAVAILABLE code not marked retryable (eBay answered 400)",
        kind: "refused",
        error: () => new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE",
          "The Card Shellz-managed eBay inventory location could not be synchronized.",
          { storeConnectionId: STORE_CONNECTION_ID, status: 400, retryable: false },
        ),
      },
      {
        label: "an _UNAVAILABLE code with no context at all",
        kind: "refused",
        error: () => new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE",
          "The Card Shellz-managed eBay inventory location could not be synchronized.",
        ),
      },
      {
        label: "a Card Shellz routing setup error (ROUTING_UNAVAILABLE, retryable: false)",
        kind: "refused",
        error: () => new DropshipError(
          "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
          "Card Shellz fulfillment routing could not be read.",
          { storeConnectionId: STORE_CONNECTION_ID, retryable: false },
        ),
      },
      {
        label: "an _UNAVAILABLE code marked retryable: true (a passing outage)",
        kind: "unavailable",
        error: () => new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE",
          "The Card Shellz-managed eBay inventory location could not be synchronized.",
          { storeConnectionId: STORE_CONNECTION_ID, status: 503, retryable: true },
        ),
      },
      {
        label: "an _INVALID_RESPONSE code not marked retryable",
        kind: "refused",
        error: () => new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_RESPONSE",
          "eBay returned an invalid inventory location response.",
          { storeConnectionId: STORE_CONNECTION_ID, retryable: false },
        ),
      },
      {
        label: "_UNAVAILABLE_X, a look-alike code that only contains _UNAVAILABLE",
        kind: "refused",
        error: () => new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE_X",
          "A look-alike code.",
          { storeConnectionId: STORE_CONNECTION_ID, retryable: false },
        ),
      },
      {
        label: "_INVALID_RESPONSE_X, a look-alike code that only contains _INVALID_RESPONSE",
        kind: "refused",
        error: () => new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_RESPONSE_X",
          "A look-alike code.",
          { storeConnectionId: STORE_CONNECTION_ID, retryable: false },
        ),
      },
      {
        label: "retryable: \"true\" (a string, not the boolean)",
        kind: "refused",
        error: () => new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_CREATE_CONFLICT",
          "The managed eBay inventory location could not be confirmed after a concurrent create.",
          { storeConnectionId: STORE_CONNECTION_ID, retryable: "true" },
        ),
      },
      {
        label: "a refusal by the rules from the same call (a warehouse with no address)",
        kind: "refused",
        error: () => new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_ADDRESS_REQUIRED",
          "The dropship origin warehouse is missing eBay location address data.",
          { originWarehouseId: 1, field: "postalCode", retryable: false },
        ),
      },
      {
        label: "a broken invariant that is also marked retryable: true",
        kind: "failed",
        error: () => new DropshipError(
          "DROPSHIP_EBAY_LISTING_SETUP_INVARIANT_FAILED",
          "A check that should always hold did not.",
          { storeConnectionId: STORE_CONNECTION_ID, retryable: true },
        ),
      },
    ];

    describe.each(LOCATION_ENSURING_WRITES)("$label", (write) => {
      it.each(CLASSIFIED_FAILURES)("logs $label once, as $kind, and rethrows it", async ({ kind, error }) => {
        const failure = error();
        locations.ensureForStoreConnection.mockRejectedValueOnce(failure);

        await expect(write.send(write.body())).rejects.toBe(failure);

        expect(logs).toEqual([outcomeLine(write, kind, failure.code)]);
        expect(directory.storeConnectionCalls).toEqual([]);
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it("logs a passing Card Shellz shipping outage once at WARN as failed, never at INFO or ERROR", async () => {
        const failure = CAPABILITY_FAILURES[0].error();
        getCapability.mockRejectedValue(failure);

        await expect(write.send(write.body())).rejects.toBe(failure);

        expect(logs).toEqual([outcomeLine(write, "unavailable", "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE")]);
        expect(locations.ensureForStoreConnection).not.toHaveBeenCalled();
      });

      it("carries an outage's currentRevision into the WARN line", async () => {
        const failure = new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE",
          "The Card Shellz-managed eBay inventory location could not be synchronized.",
          { storeConnectionId: STORE_CONNECTION_ID, currentRevision: 4, retryable: true },
        );
        locations.ensureForStoreConnection.mockRejectedValueOnce(failure);

        await expect(write.send(write.body())).rejects.toBe(failure);

        expect(logs).toEqual([outcomeLine(write, "unavailable", failure.code, 4)]);
      });
    });

    it("logs a shelf default save whose eBay store shelves came back unreadable at WARN, with no location line", async () => {
      const failure = new DropshipError(
        "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE",
        "eBay returned an invalid store category response.",
        { storeConnectionId: STORE_CONNECTION_ID, reason: "schema", retryable: true },
      );
      listLeafCategories.mockRejectedValueOnce(failure);

      await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
        storeShelfDefault: { ids: ["101"] },
      }))).rejects.toBe(failure);

      expect(logs).toEqual([outcomeLine(LOCATION_ENSURING_WRITES[0], "unavailable", failure.code)]);
      expect(listingConfig.replaceMember).not.toHaveBeenCalled();
    });
  });

  /**
   * A keyed write that is refused rereads the request ledger first: another
   * attempt with the same key and body (a retry sent while the first was still
   * running, after its answer was lost) may have committed meanwhile, and then
   * that answer wins over the refusal. Both keyed writes behave the same, so
   * each case runs for the W2 save and the W10 repair.
   */
  describe("a refused keyed write rechecks the request ledger", () => {
    interface KeyedWrite {
      label: string;
      operation: "ebay_listing_setup_save" | "ebay_ship_from_repair";
      requestKey: string;
      /** Both bodies read Card Shellz shipping, ensure the managed location and read eBay before writing. */
      body: (expectedRevision?: number) => Record<string, unknown>;
      send: (body: Record<string, unknown>) => Promise<DropshipEbayListingSetupWriteResult>;
    }

    /** What an overlapping attempt with the same key and body committed. */
    interface CommittedAttempt {
      row: FakeLedgerEntry;
      /** The config as that attempt left it. */
      config: DropshipStoreListingConfigRecord;
    }

    const KEYED_WRITES: readonly KeyedWrite[] = [
      {
        label: "the W2 shipping policy save",
        operation: "ebay_listing_setup_save",
        requestKey: SAVE_KEY,
        body: (expectedRevision = 1) => saveBody({ expectedRevision, fulfillmentPolicyId: "fulfillment-1" }),
        send: (body) => service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, body),
      },
      {
        label: "the W10 ship-from repair",
        operation: "ebay_ship_from_repair",
        requestKey: REPAIR_KEY,
        body: (expectedRevision = 1) => ({ expectedRevision, idempotencyKey: REPAIR_KEY }),
        send: (body) => service.repairShipFromForMember(MEMBER_ID, STORE_CONNECTION_ID, body),
      },
    ];

    /**
     * Runs the write once, as an overlapping attempt with the same key and body
     * would, then puts the fake back as it was before it, so each test says
     * when that commit becomes visible (commitAttempt).
     */
    async function overlappingAttempt(write: KeyedWrite): Promise<CommittedAttempt> {
      const configBefore = listingConfig.config;
      await expect(write.send(write.body())).resolves.toMatchObject({ outcome: "changed", revision: 2 });
      const key = ledgerKey(VENDOR_ID, write.requestKey);
      const row = listingConfig.ledger.get(key);
      const config = listingConfig.config;
      if (!row || !config) throw new Error("Expected the overlapping attempt to commit");
      listingConfig.ledger.delete(key);
      listingConfig.config = configBefore;
      clearProviderCalls();
      listingConfig.replaceMember.mockClear();
      listingConfig.findConfig.mockClear();
      logs.length = 0;
      return { row, config };
    }

    function commitAttempt(attempt: CommittedAttempt, row: FakeLedgerEntry = attempt.row): void {
      listingConfig.ledger.set(ledgerKey(VENDOR_ID, row.idempotencyKey), row);
      listingConfig.config = attempt.config;
    }

    /** The same key recorded for another body (another attempt that used the key for a different change). */
    function anotherBody(attempt: CommittedAttempt): FakeLedgerEntry {
      return { ...attempt.row, requestHash: sha256Hex("another body under the same key") };
    }

    function spyOnLookups() {
      return vi.spyOn(listingConfig, "findKeyedRequest");
    }

    /** Runs `hook` inside the eBay policy read, which then answers normally. */
    function duringEbayRead(hook: () => void): void {
      const discover = directory.discoverForStoreConnection.bind(directory);
      vi.spyOn(directory, "discoverForStoreConnection").mockImplementationOnce(async (input) => {
        hook();
        return discover(input);
      });
    }

    function correlation(write: KeyedWrite, expectedRevision: number) {
      return {
        operation: write.operation,
        vendorId: VENDOR_ID,
        storeConnectionId: STORE_CONNECTION_ID,
        requestKey: write.requestKey,
        expectedRevision,
      };
    }

    function logsWithCode(code: string): LoggedEvent[] {
      return logs.filter((event) => event.code === code);
    }

    /** Nothing says the write happened or was refused by this service: no success line, no refusal line. */
    function expectNoOutcomeLines(): void {
      const codes = logs.map((event) => event.code);
      expect(codes).not.toContain("DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED");
      expect(codes).not.toContain("DROPSHIP_EBAY_LISTING_SETUP_EVALUATED");
      expect(codes).not.toContain("DROPSHIP_EBAY_SHIP_FROM_REPAIRED");
    }

    function ebaySetupUnavailable(): DropshipError {
      return new DropshipError(
        "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
        "eBay listing setup could not be loaded.",
        { storeConnectionId: STORE_CONNECTION_ID, resource: "fulfillment_policies", retryable: true, errorName: "TimeoutError" },
      );
    }

    /** A ledger row that breaks a check that should always hold (a fault: its code ends with _INVARIANT_FAILED). */
    function ledgerRowFault(): DropshipError {
      return new DropshipError(
        "DROPSHIP_LISTING_CONFIG_REQUEST_INVARIANT_FAILED",
        "The recorded listing settings request could not be read.",
        { storeConnectionId: STORE_CONNECTION_ID, retryable: false },
      );
    }

    /** A stored config with no valid revision, as the repository's row mapper refuses it (a fault). */
    function configRowFault(): DropshipError {
      return new DropshipError(
        "DROPSHIP_LISTING_CONFIG_REVISION_INVALID",
        "The stored listing config has no valid revision.",
        { storeConnectionId: STORE_CONNECTION_ID, revision: null, retryable: false },
      );
    }

    function writeFailedLine(write: KeyedWrite, errorCode: string): LoggedEvent {
      return {
        level: "error",
        code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_FAILED",
        message: expect.any(String),
        context: { ...correlation(write, 1), outcome: "failed", errorCode, currentRevision: null },
      };
    }

    function writeRefusedLine(write: KeyedWrite, errorCode: string, currentRevision: unknown): LoggedEvent {
      return {
        level: "info",
        code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED",
        message: expect.any(String),
        context: { ...correlation(write, 1), outcome: "refused", errorCode, currentRevision },
      };
    }

    function replayedLine(write: KeyedWrite, afterRefusalCode: string): LoggedEvent {
      return {
        level: "info",
        code: "DROPSHIP_EBAY_LISTING_SETUP_REPLAYED",
        message: expect.any(String),
        context: {
          ...correlation(write, 1),
          outcome: "replayed",
          recordedOutcome: "changed",
          revisionBefore: 1,
          revisionAfter: 2,
          currentRevision: 2,
          afterRefusalCode,
        },
      };
    }

    describe.each(KEYED_WRITES)("$label", (write) => {
      it.each([
        {
          label: "a stale expectedRevision",
          errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
          access: { canEdit: true, reason: null },
          arrange: (attempt: CommittedAttempt, lookups: ReturnType<typeof spyOnLookups>) => {
            // The overlapping commit moved the revision; this attempt's first
            // ledger read ran before that row was visible to it.
            commitAttempt(attempt);
            lookups.mockResolvedValueOnce(null);
          },
        },
        {
          label: "a paused store",
          errorCode: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
          access: { canEdit: false, reason: "store_paused" },
          arrange: (attempt: CommittedAttempt, lookups: ReturnType<typeof spyOnLookups>) => {
            commitAttempt(attempt);
            listingConfig.storeStatus = "paused";
            lookups.mockResolvedValueOnce(null);
          },
        },
        {
          label: "Card Shellz shipping that can't be read (a passing outage)",
          errorCode: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
          access: { canEdit: true, reason: null },
          arrange: (attempt: CommittedAttempt) => {
            getCapability.mockImplementationOnce(async () => {
              commitAttempt(attempt);
              throw CAPABILITY_FAILURES[0].error();
            });
          },
        },
        {
          label: "eBay that can't be reached",
          errorCode: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
          access: { canEdit: true, reason: null },
          arrange: (attempt: CommittedAttempt) => {
            vi.spyOn(directory, "discoverForStoreConnection").mockImplementationOnce(async () => {
              commitAttempt(attempt);
              throw ebaySetupUnavailable();
            });
          },
        },
      ] as const)(
        "answers an attempt refused in planning for $label as replayed once the same request committed, logging no refusal",
        async ({ errorCode, access, arrange }) => {
          const attempt = await overlappingAttempt(write);
          const lookups = spyOnLookups();
          arrange(attempt, lookups);

          const result = await write.send(write.body());

          expect(result).toMatchObject({
            outcome: "replayed",
            revision: 2,
            access,
            selection: { merchantLocationKey: "cardshellz-dropship-wh-1" },
            checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
            options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
          });
          expect(listingConfig.replaceMember).not.toHaveBeenCalled();
          expect(lookups).toHaveBeenCalledTimes(2);
          expect(lookups).toHaveBeenLastCalledWith({ vendorId: VENDOR_ID, idempotencyKey: write.requestKey });
          expect(listingConfig.findConfig).toHaveBeenCalledTimes(1);
          expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_REPLAYED")).toEqual([{
            level: "info",
            code: "DROPSHIP_EBAY_LISTING_SETUP_REPLAYED",
            message: expect.any(String),
            context: {
              ...correlation(write, 1),
              outcome: "replayed",
              recordedOutcome: "changed",
              revisionBefore: 1,
              revisionAfter: 2,
              currentRevision: 2,
              afterRefusalCode: errorCode,
            },
          }]);
          expectNoOutcomeLines();
          expect(logs.filter((event) => event.level !== "info")).toEqual([]);
        },
      );

      it.each([
        {
          label: "the store was paused",
          errorCode: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
          change: () => { listingConfig.storeStatus = "paused"; },
        },
        {
          label: "the vendor was suspended",
          errorCode: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
          change: () => { listingConfig.vendorStatus = "suspended"; },
        },
      ])(
        "answers an attempt whose write was refused because $label as replayed once the same request committed",
        async ({ errorCode, change }) => {
          const attempt = await overlappingAttempt(write);
          const lookups = spyOnLookups();
          // Both happen while this attempt reads eBay, after its own checks passed.
          duringEbayRead(() => {
            commitAttempt(attempt);
            change();
          });

          const result = await write.send(write.body());

          expect(result).toMatchObject({
            outcome: "replayed",
            revision: 2,
            selection: { merchantLocationKey: "cardshellz-dropship-wh-1" },
            checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
          });
          expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
          expect(lookups).toHaveBeenCalledTimes(2);
          expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_REPLAYED")).toEqual([
            expect.objectContaining({
              level: "info",
              context: {
                ...correlation(write, 1),
                outcome: "replayed",
                recordedOutcome: "changed",
                revisionBefore: 1,
                revisionAfter: 2,
                currentRevision: 2,
                afterRefusalCode: errorCode,
              },
            }),
          ]);
          expectNoOutcomeLines();
          expect(logs.filter((event) => event.level !== "info")).toEqual([]);
        },
      );

      it("answers a refusal found in planning with an idempotency conflict when the recheck finds another body under the key", async () => {
        const attempt = await overlappingAttempt(write);
        const lookups = spyOnLookups();
        getCapability.mockImplementationOnce(async () => {
          commitAttempt(attempt, anotherBody(attempt));
          throw CAPABILITY_FAILURES[0].error();
        });

        await expect(write.send(write.body())).rejects.toMatchObject({
          code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
          context: { storeConnectionId: STORE_CONNECTION_ID, retryable: false },
        });

        expect(lookups).toHaveBeenCalledTimes(2);
        expect(listingConfig.findConfig).not.toHaveBeenCalled();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
        // One refusal line, for the conflict: the outage is not logged as a second refusal.
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED")).toEqual([{
          level: "info",
          code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED",
          message: expect.any(String),
          context: {
            ...correlation(write, 1),
            outcome: "refused",
            errorCode: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
            currentRevision: null,
          },
        }]);
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_REPLAYED")).toEqual([]);
        expect(logs.filter((event) => event.level !== "info")).toEqual([]);
      });

      it("answers a refused write with an idempotency conflict when the recheck finds another body under the key", async () => {
        const attempt = await overlappingAttempt(write);
        const lookups = spyOnLookups();
        duringEbayRead(() => {
          commitAttempt(attempt, anotherBody(attempt));
          listingConfig.storeStatus = "paused";
        });

        await expect(write.send(write.body())).rejects.toMatchObject({
          code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
        });

        expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
        expect(lookups).toHaveBeenCalledTimes(2);
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED")).toEqual([
          expect.objectContaining({
            context: expect.objectContaining({ errorCode: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT" }),
          }),
        ]);
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_REPLAYED")).toEqual([]);
      });

      it("does not recheck an idempotency conflict the write found itself, and leaves its log to the listing-config service", async () => {
        const attempt = await overlappingAttempt(write);
        const lookups = spyOnLookups();
        duringEbayRead(() => commitAttempt(attempt, anotherBody(attempt)));

        await expect(write.send(write.body())).rejects.toMatchObject({
          code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
        });

        expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
        expect(lookups).toHaveBeenCalledTimes(1);
        expect(listingConfig.findConfig).not.toHaveBeenCalled();
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED")).toEqual([]);
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_REPLAYED")).toEqual([]);
      });

      it("rereads the ledger once after a refusal and, finding nothing, answers the refusal", async () => {
        listingConfig.config = makeConfig(undefined, { revision: 3 });
        const lookups = spyOnLookups();

        await expect(write.send(write.body())).rejects.toMatchObject({
          code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
          context: { expectedRevision: 1, currentRevision: 3 },
        });

        expect(lookups.mock.calls).toEqual([
          [{ vendorId: VENDOR_ID, idempotencyKey: write.requestKey }],
          [{ vendorId: VENDOR_ID, idempotencyKey: write.requestKey }],
        ]);
        expect(listingConfig.findConfig).not.toHaveBeenCalled();
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED")).toHaveLength(1);
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_REPLAYED")).toEqual([]);
        expectNoProviderCalls();
      });

      it("answers the original planning refusal, with a WARN, when the ledger can't be read again", async () => {
        listingConfig.config = makeConfig(undefined, { revision: 3 });
        const lookups = spyOnLookups()
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

        await expect(write.send(write.body())).rejects.toMatchObject({
          code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
          context: { expectedRevision: 1, currentRevision: 3 },
        });

        expect(lookups).toHaveBeenCalledTimes(2);
        expect(logs).toEqual([
          {
            level: "warn",
            code: "DROPSHIP_EBAY_LISTING_SETUP_REPLAY_RECHECK_FAILED",
            message: expect.any(String),
            context: {
              ...correlation(write, 1),
              errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
              // Not a DropshipError, so there is no code to name.
              recheckErrorCode: null,
              recheckError: "Connection terminated unexpectedly",
            },
          },
          {
            level: "info",
            code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED",
            message: expect.any(String),
            context: {
              ...correlation(write, 1),
              outcome: "refused",
              errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
              currentRevision: 3,
            },
          },
        ]);
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it("answers the original refused write, with a WARN naming a non-Error failure, when the ledger can't be read again", async () => {
        const lookups = spyOnLookups()
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce("socket hang up");
        duringEbayRead(() => { listingConfig.storeStatus = "paused"; });

        await expect(write.send(write.body())).rejects.toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" });

        expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
        expect(lookups).toHaveBeenCalledTimes(2);
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_REPLAY_RECHECK_FAILED")).toEqual([{
          level: "warn",
          code: "DROPSHIP_EBAY_LISTING_SETUP_REPLAY_RECHECK_FAILED",
          message: expect.any(String),
          context: {
            ...correlation(write, 1),
            errorCode: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
            recheckErrorCode: null,
            recheckError: "socket hang up",
          },
        }]);
        // The listing-config service logs a refusal by the write; this service adds none.
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED")).toEqual([]);
      });

      it("answers the original refusal, with a WARN, when the request is recorded but the config can't be read", async () => {
        const attempt = await overlappingAttempt(write);
        getCapability.mockImplementationOnce(async () => {
          commitAttempt(attempt);
          throw CAPABILITY_FAILURES[0].error();
        });
        listingConfig.findConfig.mockRejectedValueOnce(new Error("canceling statement due to statement timeout"));

        await expect(write.send(write.body())).rejects.toMatchObject({
          code: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
        });

        // The recheck's WARN, then the outage itself, which is a provider failure (WARN, not INFO).
        expect(logs).toEqual([
          {
            level: "warn",
            code: "DROPSHIP_EBAY_LISTING_SETUP_REPLAY_RECHECK_FAILED",
            message: expect.any(String),
            context: {
              ...correlation(write, 1),
              errorCode: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
              recheckErrorCode: null,
              recheckError: "canceling statement due to statement timeout",
            },
          },
          {
            level: "warn",
            code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_UNAVAILABLE",
            message: expect.any(String),
            context: {
              ...correlation(write, 1),
              outcome: "failed",
              errorCode: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
              currentRevision: null,
            },
          },
        ]);
        expect(listingConfig.findConfig).toHaveBeenCalledTimes(1);
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it("answers a planning fault as replayed once the same request committed, logging the fault at ERROR before the replay", async () => {
        const attempt = await overlappingAttempt(write);
        const lookups = spyOnLookups();
        const fault = new DropshipError(
          "DROPSHIP_EBAY_LISTING_SETUP_INVARIANT_FAILED",
          "A check that should always hold did not.",
          { storeConnectionId: STORE_CONNECTION_ID, retryable: false },
        );
        getCapability.mockImplementationOnce(async () => {
          commitAttempt(attempt);
          throw fault;
        });

        const result = await write.send(write.body());

        expect(result).toMatchObject({ outcome: "replayed", revision: 2 });
        expect(lookups).toHaveBeenCalledTimes(2);
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
        // The broken invariant still reaches a person although the committed twin answers the request.
        expect(logs).toEqual([writeFailedLine(write, fault.code), replayedLine(write, fault.code)]);
      });

      it("answers a fault the write itself found as replayed once the same request committed, adding only the replay line", async () => {
        const attempt = await overlappingAttempt(write);
        const fault = new DropshipError(
          "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED",
          "The listing config revision did not advance by exactly one.",
          { storeConnectionId: STORE_CONNECTION_ID, revisionBefore: 1, revisionAfter: 3, retryable: false },
        );
        listingConfig.replaceMember.mockImplementationOnce(async () => {
          commitAttempt(attempt);
          throw fault;
        });

        const result = await write.send(write.body());

        expect(result).toMatchObject({ outcome: "replayed", revision: 2 });
        // The listing-config service logs the write's own fault; this service adds the
        // location ensured on the way and the replay, and no second ERROR.
        expect(logs.map((event) => [event.level, event.code])).toEqual([
          ["info", "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED"],
          ["info", "DROPSHIP_EBAY_LISTING_SETUP_REPLAYED"],
        ]);
        expect(logs[1]).toEqual(replayedLine(write, fault.code));
      });

      it.each([
        {
          label: "the ledger row",
          fault: ledgerRowFault,
          arrange: async (fault: DropshipError) => {
            spyOnLookups().mockRejectedValueOnce(fault);
          },
          configReads: 0,
        },
        {
          label: "the config a recorded request is answered from",
          fault: configRowFault,
          arrange: async (fault: DropshipError) => {
            await expect(write.send(write.body())).resolves.toMatchObject({ outcome: "changed", revision: 2 });
            clearProviderCalls();
            listingConfig.replaceMember.mockClear();
            listingConfig.findConfig.mockClear();
            logs.length = 0;
            spyOnLookups();
            listingConfig.findConfig.mockRejectedValueOnce(fault);
          },
          configReads: 1,
        },
      ])("logs a fault reading $label before planning once at ERROR and rethrows it, with no eBay call", async ({
        fault: makeFault,
        arrange,
        configReads,
      }) => {
        const fault = makeFault();
        await arrange(fault);

        await expect(write.send(write.body())).rejects.toBe(fault);

        expect(logs).toEqual([writeFailedLine(write, fault.code)]);
        expect(listingConfig.findKeyedRequest).toHaveBeenCalledTimes(1);
        expect(listingConfig.findConfig).toHaveBeenCalledTimes(configReads);
        expectNoProviderCalls();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it.each([
        {
          label: "the ledger row",
          fault: ledgerRowFault,
          arrange: async (fault: DropshipError) => {
            listingConfig.config = makeConfig(undefined, { revision: 3 });
            spyOnLookups().mockResolvedValueOnce(null).mockRejectedValueOnce(fault);
            return 3;
          },
        },
        {
          label: "the config of the request found committed",
          fault: configRowFault,
          arrange: async (fault: DropshipError) => {
            // The overlapping commit moved the revision; this attempt's first
            // ledger read ran before that row was visible to it.
            const attempt = await overlappingAttempt(write);
            commitAttempt(attempt);
            spyOnLookups().mockResolvedValueOnce(null);
            listingConfig.findConfig.mockRejectedValueOnce(fault);
            return 2;
          },
        },
      ])(
        "logs a fault the recheck found in $label once at ERROR, with no WARN, and answers the original planning refusal",
        async ({ fault: makeFault, arrange }) => {
          const fault = makeFault();
          const currentRevision = await arrange(fault);

          await expect(write.send(write.body())).rejects.toMatchObject({
            code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
            context: { expectedRevision: 1, currentRevision },
          });

          expect(listingConfig.findKeyedRequest).toHaveBeenCalledTimes(2);
          expect(logs).toEqual([
            writeFailedLine(write, fault.code),
            writeRefusedLine(write, "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", currentRevision),
          ]);
          expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_REPLAY_RECHECK_FAILED")).toEqual([]);
          expectNoProviderCalls();
          expect(listingConfig.replaceMember).not.toHaveBeenCalled();
        },
      );

      it("logs a fault the recheck after a refused write found once at ERROR, with no WARN, and answers the write's refusal", async () => {
        const fault = ledgerRowFault();
        const lookups = spyOnLookups().mockResolvedValueOnce(null).mockRejectedValueOnce(fault);
        duringEbayRead(() => { listingConfig.storeStatus = "paused"; });

        await expect(write.send(write.body())).rejects.toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" });

        expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
        expect(lookups).toHaveBeenCalledTimes(2);
        // The location ensured on the way, then the fault. The write's refusal is
        // the listing-config service's own line.
        expect(logs.map((event) => [event.level, event.code])).toEqual([
          ["info", "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED"],
          ["error", "DROPSHIP_EBAY_LISTING_SETUP_WRITE_FAILED"],
        ]);
        expect(logs[1]).toEqual(writeFailedLine(write, fault.code));
      });

      it.each([
        {
          label: "the ledger read fails with a transient DropshipError",
          recheckError: () => new DropshipError(
            "DROPSHIP_LISTING_CONFIG_LEDGER_UNAVAILABLE",
            "The listing settings request ledger could not be read.",
            { storeConnectionId: STORE_CONNECTION_ID, retryable: true },
          ),
          arrange: async (recheckError: DropshipError) => {
            listingConfig.config = makeConfig(undefined, { revision: 3 });
            spyOnLookups().mockResolvedValueOnce(null).mockRejectedValueOnce(recheckError);
            return 3;
          },
        },
        {
          label: "the config read fails with a DropshipError that is no fault",
          recheckError: () => new DropshipError(
            "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
            "Dropship store connection was not found.",
            { storeConnectionId: STORE_CONNECTION_ID },
          ),
          arrange: async (recheckError: DropshipError) => {
            const attempt = await overlappingAttempt(write);
            commitAttempt(attempt);
            spyOnLookups().mockResolvedValueOnce(null);
            listingConfig.findConfig.mockRejectedValueOnce(recheckError);
            return 2;
          },
        },
      ])(
        "answers the original refusal, with a WARN naming the recheck's code, when $label",
        async ({ recheckError: makeRecheckError, arrange }) => {
          const recheckError = makeRecheckError();
          const currentRevision = await arrange(recheckError);

          // The refusal, not the recheck's failure, is the answer.
          await expect(write.send(write.body())).rejects.toMatchObject({
            code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
            context: { expectedRevision: 1, currentRevision },
          });

          expect(listingConfig.findKeyedRequest).toHaveBeenCalledTimes(2);
          expect(logs).toEqual([
            {
              level: "warn",
              code: "DROPSHIP_EBAY_LISTING_SETUP_REPLAY_RECHECK_FAILED",
              message: expect.any(String),
              context: {
                ...correlation(write, 1),
                errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
                recheckErrorCode: recheckError.code,
                recheckError: recheckError.message,
              },
            },
            writeRefusedLine(write, "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", currentRevision),
          ]);
          expect(logs.filter((event) => event.level === "error")).toEqual([]);
          expect(listingConfig.replaceMember).not.toHaveBeenCalled();
        },
      );

      it("rethrows a non-Dropship planning failure untouched, without rereading the ledger, even when the request committed", async () => {
        const attempt = await overlappingAttempt(write);
        const lookups = spyOnLookups();
        const failure = new TypeError("Cannot read properties of undefined (reading 'originWarehouseId')");
        getCapability.mockImplementationOnce(async () => {
          commitAttempt(attempt);
          throw failure;
        });

        await expect(write.send(write.body())).rejects.toBe(failure);

        expect(lookups).toHaveBeenCalledTimes(1);
        expect(listingConfig.findConfig).not.toHaveBeenCalled();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_REPLAYED")).toEqual([]);
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED")).toEqual([]);
      });

      it("rethrows a non-Dropship write failure untouched, without rereading the ledger", async () => {
        const lookups = spyOnLookups();
        const failure = new Error("Connection terminated unexpectedly");
        listingConfig.replaceMember.mockRejectedValueOnce(failure);

        await expect(write.send(write.body())).rejects.toBe(failure);

        expect(lookups).toHaveBeenCalledTimes(1);
        expect(listingConfig.findConfig).not.toHaveBeenCalled();
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_REPLAYED")).toEqual([]);
        expect(logsWithCode("DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED")).toEqual([]);
        expect(logs.filter((event) => event.level !== "info")).toEqual([]);
      });

      it("logs a retry answered before planning with the ledger's revisions, the revision now and no refusal code", async () => {
        await expect(write.send(write.body())).resolves.toMatchObject({ outcome: "changed", revision: 2 });
        // A later save moves the config on.
        await expect(service.replaceForMember(MEMBER_ID, STORE_CONNECTION_ID, saveBody({
          expectedRevision: 2,
          idempotencyKey: "setup-save-0002",
          returnPolicyId: "return-1",
        }))).resolves.toMatchObject({ outcome: "changed", revision: 3 });
        clearProviderCalls();
        listingConfig.replaceMember.mockClear();
        logs.length = 0;
        const lookups = spyOnLookups();

        const retry = await write.send(write.body());

        expect(retry).toMatchObject({ outcome: "replayed", revision: 3 });
        expect(lookups).toHaveBeenCalledTimes(1);
        expect(logs).toEqual([{
          level: "info",
          code: "DROPSHIP_EBAY_LISTING_SETUP_REPLAYED",
          message: expect.any(String),
          context: {
            ...correlation(write, 1),
            outcome: "replayed",
            recordedOutcome: "changed",
            revisionBefore: 1,
            revisionAfter: 2,
            currentRevision: 3,
            afterRefusalCode: null,
          },
        }]);
        expectNoProviderCalls();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });

      it("logs a replayed request that changed nothing with the outcome the ledger recorded", async () => {
        listingConfig.config = makeConfig(savedSetupMarketplaceConfig(), { revision: 2 });
        await expect(write.send(write.body(2))).resolves.toMatchObject({ outcome: "unchanged", revision: 2 });
        logs.length = 0;

        await expect(write.send(write.body(2))).resolves.toMatchObject({ outcome: "replayed", revision: 2 });

        expect(logs).toEqual([expect.objectContaining({
          code: "DROPSHIP_EBAY_LISTING_SETUP_REPLAYED",
          context: expect.objectContaining({
            outcome: "replayed",
            recordedOutcome: "unchanged",
            revisionBefore: 2,
            revisionAfter: 2,
            currentRevision: 2,
            afterRefusalCode: null,
          }),
        })]);
      });

      it("logs an idempotency conflict found before planning once, with the new request's revision", async () => {
        await write.send(write.body());
        clearProviderCalls();
        listingConfig.replaceMember.mockClear();
        logs.length = 0;
        const lookups = spyOnLookups();

        await expect(write.send(write.body(2))).rejects.toMatchObject({
          code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
          context: { storeConnectionId: STORE_CONNECTION_ID, retryable: false },
        });

        expect(logs).toEqual([{
          level: "info",
          code: "DROPSHIP_EBAY_LISTING_SETUP_WRITE_REFUSED",
          message: expect.any(String),
          context: {
            ...correlation(write, 2),
            outcome: "refused",
            errorCode: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
            currentRevision: null,
          },
        }]);
        expect(lookups).toHaveBeenCalledTimes(1);
        expect(listingConfig.findConfig).not.toHaveBeenCalled();
        expectNoProviderCalls();
        expect(listingConfig.replaceMember).not.toHaveBeenCalled();
      });
    });
  });
});

function saveBody(fields: Record<string, unknown>): Record<string, unknown> {
  return { expectedRevision: 1, idempotencyKey: SAVE_KEY, ...fields };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class FakeDirectory implements DropshipEbayListingSetupDirectory {
  discovery: DropshipEbayListingSetupDiscovery = {
    marketplaceId: "EBAY_US",
    merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
    fulfillmentPolicies: [fulfillmentPolicy("fulfillment-1", "Standard")],
    returnPolicies: [{ id: "return-1", name: "Thirty days" }],
    paymentPolicies: [{ id: "payment-1", name: "Managed payments" }],
  };
  accessTokenCall: unknown = null;
  storeConnectionCalls: Parameters<DropshipEbayListingSetupDirectory["discoverForStoreConnection"]>[0][] = [];

  async discoverForStoreConnection(
    input: Parameters<DropshipEbayListingSetupDirectory["discoverForStoreConnection"]>[0],
  ): Promise<DropshipEbayListingSetupDiscovery> {
    this.storeConnectionCalls.push(input);
    return this.discovery;
  }

  async discoverWithAccessToken(
    input: Parameters<DropshipEbayListingSetupDirectory["discoverWithAccessToken"]>[0],
  ): Promise<DropshipEbayListingSetupDiscovery> {
    this.accessTokenCall = input;
    return this.discovery;
  }

  async getFulfillmentPolicyForStoreConnection(
    input: Parameters<DropshipEbayListingSetupDirectory["getFulfillmentPolicyForStoreConnection"]>[0],
  ): Promise<DropshipEbayFulfillmentPolicy> {
    return this.requiredPolicy(input.fulfillmentPolicyId);
  }

  async getFulfillmentPolicyWithAccessToken(
    input: Parameters<DropshipEbayListingSetupDirectory["getFulfillmentPolicyWithAccessToken"]>[0],
  ): Promise<DropshipEbayFulfillmentPolicy> {
    return this.requiredPolicy(input.fulfillmentPolicyId);
  }

  private requiredPolicy(id: string): DropshipEbayFulfillmentPolicy {
    const policy = this.discovery.fulfillmentPolicies.find((candidate) => candidate.id === id);
    if (!policy) throw new Error(`Missing fake policy ${id}`);
    return policy;
  }
}

interface FakeManagedLocations extends DropshipEbayManagedLocationProvider {
  ensureForStoreConnection: ReturnType<typeof vi.fn<DropshipEbayManagedLocationProvider["ensureForStoreConnection"]>>;
  ensureWithAccessToken: ReturnType<typeof vi.fn<DropshipEbayManagedLocationProvider["ensureWithAccessToken"]>>;
}

/** Like eBay: once the managed location is ensured, eBay lists it. The key follows the origin warehouse. */
function managedLocations(directory: FakeDirectory): FakeManagedLocations {
  const ensure = async (input: { originWarehouseId: number }): Promise<DropshipEbayManagedLocation> => {
    const location = {
      merchantLocationKey: managedMerchantLocationKeyForWarehouse(input.originWarehouseId),
      name: "Card Shellz Dropship - HQ",
      originWarehouseId: input.originWarehouseId,
      action: "unchanged" as const,
    };
    directory.discovery = {
      ...directory.discovery,
      merchantLocations: [
        ...directory.discovery.merchantLocations.filter(
          (option) => option.id !== location.merchantLocationKey,
        ),
        { id: location.merchantLocationKey, name: location.name },
      ],
    };
    return location;
  };
  return {
    ensureForStoreConnection: vi.fn<DropshipEbayManagedLocationProvider["ensureForStoreConnection"]>(ensure),
    ensureWithAccessToken: vi.fn<DropshipEbayManagedLocationProvider["ensureWithAccessToken"]>(ensure),
  };
}

function withManagedLocationListed(discovery: DropshipEbayListingSetupDiscovery): DropshipEbayListingSetupDiscovery {
  return {
    ...discovery,
    merchantLocations: [
      ...discovery.merchantLocations,
      { id: "cardshellz-dropship-wh-1", name: "Card Shellz Dropship - HQ" },
    ],
  };
}

const BLOCKED_VENDOR_STATUSES: ReadonlySet<string> = new Set(["closed", "lapsed", "suspended"]);

interface FakeLedgerEntry extends DropshipListingConfigKeyedRequestRecord {
  vendorId: number;
  idempotencyKey: string;
}

function ledgerKey(vendorId: number, idempotencyKey: string): string {
  return `${vendorId}:${idempotencyKey}`;
}

/**
 * The listing-config port as the real service and repository behave together:
 * vendor and store-status checks, read-only views that never create a row,
 * keyed-request replay, the revision compare-and-set, "unchanged" when the
 * content already matches, and the ledger.
 */
class FakeListingConfig {
  config: DropshipStoreListingConfigRecord | null = makeConfig();
  vendorStatus = "active";
  storeStatus: DropshipStoreConnectionStatus = "connected";
  readonly ledger = new Map<string, FakeLedgerEntry>();
  replaceMember = vi.fn(async (
    _memberId: string,
    _storeConnectionId: number,
    input: unknown,
    options: DropshipListingConfigReplaceOptions = {},
  ) => {
    this.assertVendorCanEdit();
    // As the real service: a vendor write defaults to the vendor setup statuses.
    return {
      vendor: this.vendor(),
      ...this.write(input, options, DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES),
    };
  });
  replaceAdmin = vi.fn(async (
    _storeConnectionId: number,
    input: unknown,
    _actor: DropshipListingConfigActor,
    options: DropshipListingConfigReplaceOptions = {},
  ) => this.write(input, options, DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES));
  /** Read-only, as the real port: the stored config now, or null; never creates one. */
  findConfig = vi.fn(async (_input: { storeConnectionId: number }) => this.config);

  async getForMember(_memberId: string, _storeConnectionId: number) {
    this.assertVendorCanEdit();
    return { vendor: this.vendor(), storeConnection: this.storeConnection(), config: this.ensureConfig() };
  }

  async getViewForMember(_memberId: string, _storeConnectionId: number) {
    const access = decideDropshipListingConfigAccess(this.vendorStatus, this.storeStatus);
    const config = access.canEdit ? this.ensureConfig() : this.config;
    return { vendor: this.vendor(), storeConnection: this.storeConnection(), config, access };
  }

  async getForAdmin(_storeConnectionId: number, _actor: DropshipListingConfigActor) {
    return { storeConnection: this.storeConnection(), config: this.ensureConfig() };
  }

  async findKeyedRequest(input: {
    vendorId: number;
    idempotencyKey: string;
  }): Promise<DropshipListingConfigKeyedRequestRecord | null> {
    const entry = this.ledger.get(ledgerKey(input.vendorId, input.idempotencyKey));
    if (!entry) return null;
    const { vendorId: _vendorId, idempotencyKey: _idempotencyKey, ...record } = entry;
    return record;
  }

  async replaceForMember(
    memberId: string,
    storeConnectionId: number,
    input: unknown,
    options?: DropshipListingConfigReplaceOptions,
  ) {
    return this.replaceMember(memberId, storeConnectionId, input, options);
  }

  async replaceForAdmin(
    storeConnectionId: number,
    input: unknown,
    actor: DropshipListingConfigActor,
    options?: DropshipListingConfigReplaceOptions,
  ) {
    return this.replaceAdmin(storeConnectionId, input, actor, options);
  }

  private vendor() {
    return { vendorId: VENDOR_ID, status: this.vendorStatus };
  }

  private storeConnection() {
    return {
      vendorId: VENDOR_ID,
      storeConnectionId: STORE_CONNECTION_ID,
      platform: "ebay" as const,
      status: this.storeStatus,
      setupStatus: "ready",
    };
  }

  private assertVendorCanEdit(): void {
    if (BLOCKED_VENDOR_STATUSES.has(this.vendorStatus)) {
      throw new DropshipError(
        "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
        "Dropship vendor status does not allow listing configuration changes.",
        { vendorId: VENDOR_ID, status: this.vendorStatus },
      );
    }
  }

  private ensureConfig(): DropshipStoreListingConfigRecord {
    if (!this.config) {
      const defaults = buildDefaultDropshipStoreListingConfig("ebay");
      this.config = makeConfig(defaults.marketplaceConfig, { revision: 1 });
    }
    return this.config;
  }

  private write(
    input: unknown,
    options: DropshipListingConfigReplaceOptions,
    defaultStoreStatuses: readonly DropshipStoreConnectionStatus[],
  ): {
    storeConnection: ReturnType<FakeListingConfig["storeConnection"]>;
    config: DropshipStoreListingConfigRecord;
    outcome: DropshipListingConfigWriteOutcome;
    revisionBefore: number;
    revisionAfter: number;
  } {
    const parsed = replaceDropshipStoreListingConfigRequestSchema.parse(input);
    const storeConnection = this.storeConnection();
    assertStoreStatusAllowsListingConfigWrite(
      storeConnection,
      options.allowedStoreStatuses ?? defaultStoreStatuses,
    );
    const request = options.request ?? null;
    if (request) {
      const prior = this.ledger.get(ledgerKey(VENDOR_ID, request.idempotencyKey));
      if (prior) {
        if (prior.requestHash !== request.requestHash
          || prior.storeConnectionId !== STORE_CONNECTION_ID
          || prior.operation !== request.operation) {
          throw new DropshipError(
            "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
            "This request key was already used for a different listing settings change.",
            { storeConnectionId: STORE_CONNECTION_ID, retryable: false },
          );
        }
        // As the repository: the ledger's revisions, with the config as it is now.
        return {
          storeConnection,
          config: this.ensureConfig(),
          outcome: "replayed",
          revisionBefore: prior.revisionBefore,
          revisionAfter: prior.revisionAfter,
        };
      }
    }
    const current = this.config;
    if (!current || current.revision !== parsed.expectedRevision) {
      throw new DropshipError(
        "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        "These store settings changed after they were loaded. Load the latest settings and save again.",
        {
          storeConnectionId: STORE_CONNECTION_ID,
          expectedRevision: parsed.expectedRevision,
          currentRevision: current?.revision ?? null,
          retryable: false,
        },
      );
    }
    const content = normalizeListingConfigInput(parsed);
    if (listingConfigContentEquals(current, content)) {
      this.record(request, current.revision, current.revision, "unchanged");
      return {
        storeConnection,
        config: current,
        outcome: "unchanged",
        revisionBefore: current.revision,
        revisionAfter: current.revision,
      };
    }
    this.config = {
      ...current,
      ...content,
      marketplaceConfig: structuredClone(content.marketplaceConfig),
      requiredConfigKeys: [...content.requiredConfigKeys],
      requiredProductFields: [...content.requiredProductFields],
      revision: current.revision + 1,
      updatedAt: now,
    };
    this.record(request, current.revision, this.config.revision, "changed");
    return {
      storeConnection,
      config: this.config,
      outcome: "changed",
      revisionBefore: current.revision,
      revisionAfter: this.config.revision,
    };
  }

  private record(
    request: DropshipListingConfigKeyedRequest | null,
    revisionBefore: number,
    revisionAfter: number,
    outcome: "changed" | "unchanged",
  ): void {
    if (!request) return;
    this.ledger.set(ledgerKey(VENDOR_ID, request.idempotencyKey), {
      vendorId: VENDOR_ID,
      idempotencyKey: request.idempotencyKey,
      storeConnectionId: STORE_CONNECTION_ID,
      operation: request.operation,
      requestHash: request.requestHash,
      revisionBefore,
      revisionAfter,
      outcome,
      createdAt: now,
    });
  }
}

function makeConfig(
  marketplaceConfig: Record<string, unknown> = {
    marketplaceId: "EBAY_US",
    unrelatedSetting: "preserved",
    businessPolicies: { unrelatedPolicySetting: "preserved" },
  },
  overrides: Partial<Pick<DropshipStoreListingConfigRecord, "revision">> = {},
): DropshipStoreListingConfigRecord {
  return {
    id: 9,
    storeConnectionId: 44,
    // Includes platform: "ebay".
    ...buildDefaultDropshipStoreListingConfig("ebay"),
    marketplaceConfig,
    revision: overrides.revision ?? 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** A store whose setup was saved before: all three policies with their names, on the wh-1 managed location. */
function savedSetupMarketplaceConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    marketplaceId: "EBAY_US",
    unrelatedSetting: "preserved",
    merchantLocationKey: "cardshellz-dropship-wh-1",
    businessPolicies: {
      unrelatedPolicySetting: "preserved",
      fulfillmentPolicyId: "fulfillment-1",
      returnPolicyId: "return-1",
      paymentPolicyId: "payment-1",
    },
    businessPolicyNames: savedPolicyNames(),
    ...overrides,
  };
}

/**
 * Names as the setup service stores them: keyed by policy field, each with the
 * id it names (readStoredEbayPolicyName shows a name only while that id is saved).
 */
function savedPolicyNames(
  overrides: Partial<Record<"fulfillmentPolicyId" | "returnPolicyId" | "paymentPolicyId", { id: string; name: string }>> = {},
): Record<string, { id: string; name: string }> {
  return {
    fulfillmentPolicyId: { id: "fulfillment-1", name: "Standard" },
    returnPolicyId: { id: "return-1", name: "Thirty days" },
    paymentPolicyId: { id: "payment-1", name: "Managed payments" },
    ...overrides,
  };
}

function completeMarketplaceConfig(): Record<string, unknown> {
  return savedSetupMarketplaceConfig();
}

function storeShelves(): DropshipEbayStoreCategory[] {
  return [
    { categoryId: "101", categoryName: "Toploaders", path: "Supplies:Toploaders", level: 2 },
    { categoryId: "102", categoryName: "Penny sleeves", path: "Supplies:Penny sleeves", level: 2 },
  ];
}

function fulfillmentPolicy(id: string, name: string): DropshipEbayFulfillmentPolicy {
  return {
    id,
    name,
    marketplaceId: "EBAY_US",
    handlingTime: { value: 1, unit: "DAY" },
    shippingOptions: [{ optionType: "DOMESTIC", shippingServiceCodes: ["USPSParcel"] }],
    localPickup: false,
    freightShipping: false,
    pickupDropOff: false,
  };
}

/** A real eBay policy promising same-day handling, shorter than the Card Shellz SLA. */
function sameDayPolicy(): DropshipEbayFulfillmentPolicy {
  return { ...fulfillmentPolicy("fulfillment-fast", "Same day"), handlingTime: { value: 0, unit: "DAY" } };
}

function capability(originWarehouseId = 1): DropshipEbayFulfillmentCapability {
  return {
    marketplaceId: "EBAY_US",
    requiredHandlingTimeBusinessDays: 1,
    destinationCountry: "US",
    destinationRegions: ["CA"],
    destinationCoverageComplete: true,
    supportedServices: [{
      carrier: "USPS",
      ebayServiceCode: "USPSParcel",
      serviceName: "USPS Ground Advantage",
      shipStationCarrierCode: "usps",
      shipStationServiceCode: "usps_ground_advantage",
    }],
    evidenceHash: "capability-hash",
    source: {
      omsChannelId: 103,
      originWarehouseId,
      rateBookId: 34,
      rateBookCode: "dropship-vendor-default",
      rateTableId: 5,
      serviceLevelId: 7,
      fulfillmentRoutingRevision: 4,
    },
  };
}
