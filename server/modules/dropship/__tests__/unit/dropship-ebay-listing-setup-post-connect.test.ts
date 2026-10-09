import { describe, expect, it, vi } from "vitest";
import {
  DropshipEbayListingSetupService,
  type DropshipEbayListingSetupDiscovery,
} from "../../application/dropship-ebay-listing-setup-service";
import {
  managedMerchantLocationKeyForWarehouse,
  type DropshipEbayManagedLocation,
} from "../../application/dropship-ebay-managed-location-service";
import {
  DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES,
  DropshipListingConfigService,
  assertStoreStatusAllowsListingConfigWrite,
  buildDefaultDropshipStoreListingConfig,
  listingConfigContentEquals,
  type DropshipListingConfigRepository,
  type DropshipListingConfigStoreConnectionContext,
  type DropshipStoreListingConfigRecord,
  type ReplaceDropshipStoreListingConfigRepositoryInput,
  type ReplaceDropshipStoreListingConfigRepositoryResult,
} from "../../application/dropship-listing-config-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type { DropshipStoreConnectionPostConnectProvider } from "../../application/dropship-store-connection-service";
import type { DropshipVendorProvisioningService } from "../../application/dropship-vendor-provisioning-service";
import type {
  DropshipEbayFulfillmentCapability,
  DropshipEbayFulfillmentPolicy,
} from "../../domain/ebay-fulfillment-policy-compatibility";
import { DropshipError } from "../../domain/errors";
import type { DropshipStoreConnectionStatus } from "../../../../../shared/schema/dropship.schema";
import { EbayDropshipListingSetupPostConnectProvider } from "../../infrastructure/dropship-ebay-listing-setup.factory";
import { DropshipStoreConnectionPostConnectPipeline } from "../../infrastructure/dropship-store-connection-post-connect.provider";

const connectedAt = new Date("2026-08-30T15:00:00.000Z");

describe("eBay listing setup post-connect integration", () => {
  it("uses the OAuth grant environment and records incomplete discovery without failing connection", async () => {
    const autoConfigureAfterConnection = vi.fn(async () => ({
      complete: false,
      missingFields: ["paymentPolicyId"],
    }));
    const logs: DropshipLogEvent[] = [];
    const provider = new EbayDropshipListingSetupPostConnectProvider(
      { autoConfigureAfterConnection } as unknown as DropshipEbayListingSetupService,
      logger(logs),
    );

    await provider.afterStoreConnected(connectionInput());

    expect(autoConfigureAfterConnection).toHaveBeenCalledWith({
      storeConnectionId: 44,
      accessToken: "access-token",
      environment: "sandbox",
    });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_REQUIRED",
      context: { storeConnectionId: 44, missingFields: ["paymentPolicyId"] },
    });
  });

  it("does not treat listing setup discovery failure as an OAuth credential failure", async () => {
    const autoConfigureAfterConnection = vi.fn();
    const logs: DropshipLogEvent[] = [];
    const provider = new EbayDropshipListingSetupPostConnectProvider(
      { autoConfigureAfterConnection } as unknown as DropshipEbayListingSetupService,
      logger(logs),
    );

    await expect(provider.afterStoreConnected(connectionInput({
      providerEnvironment: "invalid",
    }))).resolves.toBeUndefined();

    expect(autoConfigureAfterConnection).not.toHaveBeenCalled();
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED",
      context: { errorCode: "DROPSHIP_EBAY_LISTING_SETUP_ENVIRONMENT_INVALID" },
    });
  });

  it("logs a revision conflict as a superseded automatic setup at INFO, never WARN", async () => {
    // A vendor save that lands while the post-connect setup runs wins the
    // compare-and-set; the automatic write is refused and that is expected.
    const autoConfigureAfterConnection = vi.fn(async () => {
      throw new DropshipError(
        "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        "These store settings changed after they were loaded. Load the latest settings and save again.",
        { storeConnectionId: 44, expectedRevision: 1, currentRevision: 2, retryable: false },
      );
    });
    const entries: LevelledLogEntry[] = [];
    const provider = new EbayDropshipListingSetupPostConnectProvider(
      { autoConfigureAfterConnection } as unknown as DropshipEbayListingSetupService,
      levelledLogger(entries),
    );

    await expect(provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(autoConfigureAfterConnection).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([{
      level: "info",
      event: {
        code: "DROPSHIP_EBAY_LISTING_SETUP_AUTO_CONFIG_SUPERSEDED",
        message: expect.any(String),
        context: { vendorId: 10, storeConnectionId: 44 },
      },
    }]);
    expect(entries.filter((entry) => entry.level !== "info")).toEqual([]);
  });

  it("keeps other listing-config conflicts on the WARN discovery-failed path", async () => {
    const autoConfigureAfterConnection = vi.fn(async () => {
      throw new DropshipError(
        "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
        "This request key was already used for a different listing settings change.",
        { storeConnectionId: 44, retryable: false },
      );
    });
    const entries: LevelledLogEntry[] = [];
    const provider = new EbayDropshipListingSetupPostConnectProvider(
      { autoConfigureAfterConnection } as unknown as DropshipEbayListingSetupService,
      levelledLogger(entries),
    );

    await expect(provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(entries).toEqual([{
      level: "warn",
      event: expect.objectContaining({
        code: "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED",
        context: expect.objectContaining({
          vendorId: 10,
          storeConnectionId: 44,
          errorCode: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
        }),
      }),
    }]);
  });

  it("does not treat a plain error carrying the conflict code as a superseded setup", async () => {
    // Only a DropshipError from the compare-and-set counts; an unclassified
    // error that merely carries the same code string stays a WARN.
    const autoConfigureAfterConnection = vi.fn(async () => {
      throw Object.assign(new Error("connection reset"), {
        code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
      });
    });
    const entries: LevelledLogEntry[] = [];
    const provider = new EbayDropshipListingSetupPostConnectProvider(
      { autoConfigureAfterConnection } as unknown as DropshipEbayListingSetupService,
      levelledLogger(entries),
    );

    await expect(provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(entries).toEqual([{
      level: "warn",
      event: expect.objectContaining({
        code: "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED",
        context: expect.objectContaining({
          errorCode: "DROPSHIP_EBAY_LISTING_SETUP_INTERNAL_ERROR",
          errorMessage: "connection reset",
        }),
      }),
    }]);
  });

  it("runs post-connect providers in declared order", async () => {
    const calls: string[] = [];
    const pipeline = new DropshipStoreConnectionPostConnectPipeline([
      provider("first", calls),
      provider("second", calls),
    ]);

    await pipeline.afterStoreConnected(connectionInput());

    expect(calls).toEqual(["first", "second"]);
  });
});

/**
 * The provider over the real setup service and the real listing-config
 * service, with only the repository and the eBay / Card Shellz ports faked:
 * the automatic setup's compare-and-set reaches the repository as it does in
 * production.
 */
describe("eBay listing setup post-connect over the real setup and listing-config services", () => {
  it("compare-and-sets the automatic setup on the revision it read, with the system's store statuses", async () => {
    const harness = postConnectHarness({ revision: 5 });

    await expect(harness.provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(harness.repository.replaceCalls).toHaveLength(1);
    const write = harness.repository.replaceCalls[0];
    expect(write).toMatchObject({
      vendorId: 10,
      storeConnectionId: 44,
      platform: "ebay",
      expectedRevision: 5,
      allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES,
      request: null,
      auditEventType: "listing_config_replaced",
      actor: { actorType: "system", actorId: "ebay-post-connect-setup" },
      now: connectedAt,
    });
    expect(harness.repository.config).toMatchObject({
      revision: 6,
      marketplaceConfig: {
        marketplaceId: "EBAY_US",
        merchantLocationKey: "cardshellz-dropship-wh-1",
        businessPolicies: {
          fulfillmentPolicyId: "fulfillment-1",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-1",
        },
        businessPolicyNames: {
          fulfillmentPolicyId: { id: "fulfillment-1", name: "Standard" },
          returnPolicyId: { id: "return-1", name: "Thirty days" },
          paymentPolicyId: { id: "payment-1", name: "Managed payments" },
        },
      },
    });
    // The OAuth grant's own token and environment are used for every eBay call.
    expect(harness.discoverWithAccessToken).toHaveBeenCalledWith({
      accessToken: "access-token",
      environment: "sandbox",
      marketplaceId: "EBAY_US",
      storeConnectionId: 44,
    });
    expect(harness.entries).toContainEqual({
      level: "info",
      event: expect.objectContaining({
        code: "DROPSHIP_LISTING_CONFIG_REPLACED",
        context: expect.objectContaining({
          actorType: "system",
          expectedRevision: 5,
          revisionBefore: 5,
          revisionAfter: 6,
          currentRevision: 6,
        }),
      }),
    });
    expect(harness.entries.filter((entry) => entry.level !== "info")).toEqual([]);
  });

  it("logs a second automatic setup that changes nothing as unchanged, with the stored revision as revisionAfter", async () => {
    const harness = postConnectHarness({ revision: 5 });
    await expect(harness.provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();
    const configAfterFirstRun = harness.repository.config;
    harness.entries.length = 0;

    await expect(harness.provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(harness.repository.replaceCalls).toHaveLength(2);
    expect(harness.repository.replaceCalls[1].expectedRevision).toBe(6);
    expect(harness.repository.config).toBe(configAfterFirstRun);
    expect(harness.entries.filter((entry) => entry.event.code.startsWith("DROPSHIP_LISTING_CONFIG_"))).toEqual([{
      level: "info",
      event: expect.objectContaining({
        code: "DROPSHIP_LISTING_CONFIG_UNCHANGED",
        context: expect.objectContaining({
          actorType: "system",
          outcome: "unchanged",
          expectedRevision: 6,
          revisionBefore: 6,
          revisionAfter: 6,
          currentRevision: 6,
        }),
      }),
    }]);
    expect(harness.entries.filter((entry) => entry.level !== "info")).toEqual([]);
  });

  it("loses to a vendor save that lands while it runs: the vendor's save is kept and the skip is logged INFO", async () => {
    const harness = postConnectHarness({ revision: 5 });
    const vendorSave = makeListingConfig({
      marketplaceId: "EBAY_US",
      businessPolicies: { returnPolicyId: "vendor-choice" },
    }, 6);
    harness.onDiscover(() => {
      // A vendor save commits between the automatic setup's read and its write.
      harness.repository.config = vendorSave;
    });

    await expect(harness.provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(harness.repository.replaceCalls).toHaveLength(1);
    expect(harness.repository.replaceCalls[0].expectedRevision).toBe(5);
    expect(harness.repository.config).toBe(vendorSave);
    expect(harness.entries.filter((entry) => entry.event.code === "DROPSHIP_EBAY_LISTING_SETUP_AUTO_CONFIG_SUPERSEDED"))
      .toEqual([{
        level: "info",
        event: {
          code: "DROPSHIP_EBAY_LISTING_SETUP_AUTO_CONFIG_SUPERSEDED",
          message: expect.any(String),
          context: { vendorId: 10, storeConnectionId: 44 },
        },
      }]);
    // The write's own refusal line names the revisions, so the skip can be traced.
    expect(harness.entries).toContainEqual({
      level: "info",
      event: expect.objectContaining({
        code: "DROPSHIP_LISTING_CONFIG_WRITE_REFUSED",
        context: expect.objectContaining({
          actorType: "system",
          errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
          expectedRevision: 5,
          currentRevision: 6,
        }),
      }),
    });
    expect(harness.entries.map((entry) => entry.event.code)).not.toContain("DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED");
    expect(harness.entries.filter((entry) => entry.level !== "info")).toEqual([]);
  });

  it.each([
    { storeStatus: "needs_reauth", code: "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE" },
    { storeStatus: "paused", code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" },
  ] as const)("writes nothing on a $storeStatus store, which the system may not save on, and logs the setup as not completed", async ({
    storeStatus,
    code,
  }) => {
    const harness = postConnectHarness({ revision: 5, storeStatus });
    const before = harness.repository.config;

    await expect(harness.provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(harness.repository.replaceCalls).toEqual([]);
    expect(harness.repository.config).toBe(before);
    expect(harness.entries.filter((entry) => entry.level === "warn")).toEqual([{
      level: "warn",
      event: expect.objectContaining({
        code: "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED",
        context: expect.objectContaining({ vendorId: 10, storeConnectionId: 44, errorCode: code }),
      }),
    }]);
    expect(harness.entries.map((entry) => entry.event.code)).not.toContain("DROPSHIP_EBAY_LISTING_SETUP_AUTO_CONFIG_SUPERSEDED");
  });

  it.each(["created", "enabled", "updated", "unchanged"] as const)(
    "logs a %s managed location once, with its action and the system actor, as soon as it is ensured",
    async (locationAction) => {
      const harness = postConnectHarness({ revision: 5, locationAction });
      let codesWhenEbayWasRead: string[] | null = null;
      harness.onDiscover(() => {
        codesWhenEbayWasRead = harness.entries.map((entry) => entry.event.code);
      });

      await expect(harness.provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

      expect(harness.repository.replaceCalls).toHaveLength(1);
      expect(reconciledEntries(harness.entries)).toEqual([reconciledEntry(locationAction)]);
      // Logged right after the ensure: before eBay's policies are read and before the write.
      expect(codesWhenEbayWasRead).toEqual(["DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED"]);
      expect(levelsAndCodes(harness.entries)).toEqual([
        ["info", "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED"],
        ["info", "DROPSHIP_LISTING_CONFIG_REPLACED"],
        ["info", "DROPSHIP_EBAY_LISTING_SETUP_EVALUATED"],
      ]);
    },
  );

  /**
   * The location may have just been created at eBay, which stays true when the
   * automatic write is then refused, so its line never depends on the write.
   */
  it.each([
    {
      label: "a vendor save won the compare-and-set (superseded)",
      storeStatus: "connected",
      arrange: (harness: PostConnectHarness) => {
        harness.onDiscover(() => {
          harness.repository.config = makeListingConfig({
            marketplaceId: "EBAY_US",
            businessPolicies: { returnPolicyId: "vendor-choice" },
          }, 6);
        });
      },
      writes: 1,
      afterLocation: [
        ["info", "DROPSHIP_LISTING_CONFIG_WRITE_REFUSED"],
        ["info", "DROPSHIP_EBAY_LISTING_SETUP_AUTO_CONFIG_SUPERSEDED"],
      ],
    },
    {
      label: "the store is paused",
      storeStatus: "paused",
      arrange: () => {},
      writes: 0,
      afterLocation: [
        ["info", "DROPSHIP_LISTING_CONFIG_WRITE_REFUSED"],
        ["warn", "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED"],
      ],
    },
    {
      label: "the store needs a new eBay sign-in",
      storeStatus: "needs_reauth",
      arrange: () => {},
      writes: 0,
      afterLocation: [
        ["info", "DROPSHIP_LISTING_CONFIG_WRITE_REFUSED"],
        ["warn", "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED"],
      ],
    },
  ] as const)("logs the managed location once, with the system actor, when the automatic write is refused because $label", async ({
    storeStatus,
    arrange,
    writes,
    afterLocation,
  }) => {
    const harness = postConnectHarness({ revision: 5, storeStatus, locationAction: "created" });
    arrange(harness);

    await expect(harness.provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(harness.repository.replaceCalls).toHaveLength(writes);
    // The automatic selection (which points listings at the managed location) never landed.
    expect(harness.repository.config.marketplaceConfig).not.toHaveProperty("merchantLocationKey");
    expect(reconciledEntries(harness.entries)).toEqual([reconciledEntry("created")]);
    expect(levelsAndCodes(harness.entries)).toEqual([
      ["info", "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED"],
      ...afterLocation,
    ]);
    expect(harness.entries.map((entry) => entry.event.code)).not.toContain("DROPSHIP_EBAY_LISTING_SETUP_EVALUATED");
  });

  it("logs the managed location once, with the system actor, when eBay's policies can't be read after it", async () => {
    const harness = postConnectHarness({ revision: 5, locationAction: "created" });
    const before = harness.repository.config;
    harness.onDiscover(() => {
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
        "eBay listing setup could not be loaded.",
        { storeConnectionId: 44, resource: "fulfillment_policies", retryable: true },
      );
    });

    await expect(harness.provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(harness.discoverWithAccessToken).toHaveBeenCalledTimes(1);
    expect(harness.repository.replaceCalls).toEqual([]);
    expect(harness.repository.config).toBe(before);
    expect(reconciledEntries(harness.entries)).toEqual([reconciledEntry("created")]);
    expect(levelsAndCodes(harness.entries)).toEqual([
      ["info", "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED"],
      ["warn", "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED"],
    ]);
    expect(harness.entries[1].event.context).toMatchObject({
      vendorId: 10,
      storeConnectionId: 44,
      errorCode: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
    });
  });

  it("logs no managed location when the ensure itself fails, and reads nothing from eBay", async () => {
    const harness = postConnectHarness({
      revision: 5,
      ensureFailure: new DropshipError(
        "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE",
        "The Card Shellz-managed eBay inventory location could not be synchronized.",
        { storeConnectionId: 44, operation: "create", retryable: true },
      ),
    });

    await expect(harness.provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(harness.discoverWithAccessToken).not.toHaveBeenCalled();
    expect(harness.repository.replaceCalls).toEqual([]);
    expect(reconciledEntries(harness.entries)).toEqual([]);
    expect(levelsAndCodes(harness.entries)).toEqual([["warn", "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED"]]);
    expect(harness.entries[0].event.context).toMatchObject({ errorCode: "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE" });
  });

  it("logs a system write that fails a check that should always hold once at ERROR as failed, never as a refusal", async () => {
    const harness = postConnectHarness({ revision: 5 });
    const fault = new DropshipError(
      "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED",
      "The listing config revision did not advance by exactly one.",
      { storeConnectionId: 44, revisionBefore: 5, revisionAfter: 7, retryable: false },
    );
    harness.repository.replaceFailure = fault;
    const before = harness.repository.config;

    await expect(harness.provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(harness.repository.replaceCalls).toHaveLength(1);
    expect(harness.repository.config).toBe(before);
    expect(harness.entries.filter((entry) => entry.level === "error")).toEqual([{
      level: "error",
      event: {
        code: "DROPSHIP_LISTING_CONFIG_WRITE_FAILED",
        message: expect.any(String),
        context: {
          vendorId: 10,
          storeConnectionId: 44,
          platform: "ebay",
          actorType: "system",
          expectedRevision: 5,
          requestKey: null,
          operation: "listing_config_replaced",
          errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED",
          currentRevision: null,
          outcome: "failed",
        },
      },
    }]);
    const codes = harness.entries.map((entry) => entry.event.code);
    expect(codes).not.toContain("DROPSHIP_LISTING_CONFIG_WRITE_REFUSED");
    expect(codes).not.toContain("DROPSHIP_EBAY_LISTING_SETUP_AUTO_CONFIG_SUPERSEDED");
    // The connection itself still succeeds; the setup is reported as not completed.
    expect(harness.entries.filter((entry) => entry.level === "warn")).toEqual([{
      level: "warn",
      event: expect.objectContaining({
        code: "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED",
        context: expect.objectContaining({ errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED" }),
      }),
    }]);
  });

  it("logs a store the write can no longer find as one refused write with no vendor or platform, and writes nothing", async () => {
    const harness = postConnectHarness({ revision: 5 });
    harness.onDiscover(() => {
      // The store is found when the setup reads its config, and not when it writes.
      harness.repository.storeFound = false;
    });

    await expect(harness.provider.afterStoreConnected(connectionInput())).resolves.toBeUndefined();

    expect(harness.repository.replaceCalls).toEqual([]);
    expect(harness.entries.filter((entry) => entry.event.code === "DROPSHIP_LISTING_CONFIG_WRITE_REFUSED")).toEqual([{
      level: "info",
      event: {
        code: "DROPSHIP_LISTING_CONFIG_WRITE_REFUSED",
        message: expect.any(String),
        context: {
          vendorId: null,
          storeConnectionId: 44,
          platform: null,
          actorType: "system",
          expectedRevision: 5,
          requestKey: null,
          operation: "listing_config_replaced",
          errorCode: "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
          currentRevision: null,
          outcome: "refused",
        },
      },
    }]);
    expect(harness.entries.filter((entry) => entry.level === "error")).toEqual([]);
    expect(harness.entries.filter((entry) => entry.level === "warn")).toEqual([{
      level: "warn",
      event: expect.objectContaining({
        code: "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED",
        context: expect.objectContaining({ errorCode: "DROPSHIP_STORE_CONNECTION_NOT_FOUND" }),
      }),
    }]);
  });
});

interface PostConnectHarness {
  provider: EbayDropshipListingSetupPostConnectProvider;
  repository: FakeListingConfigRepository;
  entries: LevelledLogEntry[];
  discoverWithAccessToken: ReturnType<typeof vi.fn>;
  /** Runs once, inside the eBay discovery call (between the setup's read and its write). */
  onDiscover(hook: () => void): void;
}

function postConnectHarness(options: {
  revision: number;
  storeStatus?: DropshipStoreConnectionStatus;
  /** What eBay did to the managed location (default: nothing to change). */
  locationAction?: DropshipEbayManagedLocation["action"];
  /** A failure the managed-location ensure throws instead of answering. */
  ensureFailure?: Error;
}): PostConnectHarness {
  const entries: LevelledLogEntry[] = [];
  const log = levelledLogger(entries);
  const repository = new FakeListingConfigRepository(makeListingConfig(undefined, options.revision));
  repository.storeStatus = options.storeStatus ?? "connected";
  let discoverHook: (() => void) | null = null;
  const discoverWithAccessToken = vi.fn(async (): Promise<DropshipEbayListingSetupDiscovery> => {
    const hook = discoverHook;
    discoverHook = null;
    hook?.();
    return {
      marketplaceId: "EBAY_US",
      merchantLocations: [{ id: managedMerchantLocationKeyForWarehouse(1), name: "Card Shellz Dropship - HQ" }],
      fulfillmentPolicies: [fulfillmentPolicy("fulfillment-1", "Standard")],
      returnPolicies: [{ id: "return-1", name: "Thirty days" }],
      paymentPolicies: [{ id: "payment-1", name: "Managed payments" }],
    };
  });
  const notUsed = async (): Promise<never> => {
    throw new Error("Not used by the post-connect setup");
  };
  const listingConfig = new DropshipListingConfigService({
    vendorProvisioning: { provisionForMember: notUsed } as unknown as DropshipVendorProvisioningService,
    repository,
    clock: { now: () => connectedAt },
    logger: log,
  });
  const setup = new DropshipEbayListingSetupService({
    listingConfig,
    directory: {
      discoverForStoreConnection: notUsed,
      discoverWithAccessToken,
      getFulfillmentPolicyForStoreConnection: notUsed,
      getFulfillmentPolicyWithAccessToken: notUsed,
    },
    storeShelves: { listLeafCategories: notUsed },
    fulfillmentCapabilities: { getForStoreConnection: async () => capability() },
    managedLocations: {
      ensureForStoreConnection: notUsed,
      ensureWithAccessToken: async (input): Promise<DropshipEbayManagedLocation> => {
        if (options.ensureFailure) throw options.ensureFailure;
        return {
          merchantLocationKey: managedMerchantLocationKeyForWarehouse(input.originWarehouseId),
          name: "Card Shellz Dropship - HQ",
          originWarehouseId: input.originWarehouseId,
          action: options.locationAction ?? "unchanged",
        };
      },
    },
    logger: log,
  });
  return {
    provider: new EbayDropshipListingSetupPostConnectProvider(setup, log),
    repository,
    entries,
    discoverWithAccessToken,
    onDiscover(hook) {
      discoverHook = hook;
    },
  };
}

/**
 * The listing-config repository as PostgreSQL behaves for a system write:
 * the store status and the revision re-checked under the store's lock,
 * "unchanged" when the content already matches, +1 revision otherwise.
 */
class FakeListingConfigRepository implements DropshipListingConfigRepository {
  storeStatus: DropshipStoreConnectionStatus = "connected";
  /** False once the store can no longer be found (both lookups then answer null). */
  storeFound = true;
  /** A failure replaceConfig throws once entered, e.g. a broken invariant. */
  replaceFailure: Error | null = null;
  readonly replaceCalls: ReplaceDropshipStoreListingConfigRepositoryInput[] = [];

  constructor(public config: DropshipStoreListingConfigRecord) {}

  async loadStoreConnectionContext(): Promise<DropshipListingConfigStoreConnectionContext | null> {
    return this.storeFound ? this.context() : null;
  }

  async loadStoreConnectionContextById(): Promise<DropshipListingConfigStoreConnectionContext | null> {
    return this.storeFound ? this.context() : null;
  }

  async ensureDefaultConfig(): Promise<DropshipStoreListingConfigRecord> {
    return this.config;
  }

  async findConfig(): Promise<DropshipStoreListingConfigRecord> {
    return this.config;
  }

  async findKeyedRequest(): Promise<null> {
    return null;
  }

  async replaceConfig(
    input: ReplaceDropshipStoreListingConfigRepositoryInput,
  ): Promise<ReplaceDropshipStoreListingConfigRepositoryResult> {
    this.replaceCalls.push(input);
    if (this.replaceFailure) throw this.replaceFailure;
    assertStoreStatusAllowsListingConfigWrite(this.context(), input.allowedStoreStatuses);
    const current = this.config;
    if (current.revision !== input.expectedRevision) {
      throw new DropshipError(
        "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        "These store settings changed after they were loaded. Load the latest settings and save again.",
        {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          expectedRevision: input.expectedRevision,
          currentRevision: current.revision,
          retryable: false,
        },
      );
    }
    if (listingConfigContentEquals(current, input.config)) {
      return { config: current, outcome: "unchanged", revisionBefore: current.revision, revisionAfter: current.revision };
    }
    this.config = {
      ...current,
      ...structuredClone(input.config),
      revision: current.revision + 1,
      updatedAt: input.now,
    };
    return { config: this.config, outcome: "changed", revisionBefore: current.revision, revisionAfter: this.config.revision };
  }

  private context(): DropshipListingConfigStoreConnectionContext {
    return {
      vendorId: 10,
      storeConnectionId: 44,
      platform: "ebay",
      status: this.storeStatus,
      setupStatus: "ready",
    };
  }
}

function makeListingConfig(
  marketplaceConfig: Record<string, unknown> = { marketplaceId: "EBAY_US" },
  revision: number,
): DropshipStoreListingConfigRecord {
  return {
    id: 9,
    storeConnectionId: 44,
    ...buildDefaultDropshipStoreListingConfig("ebay"),
    marketplaceConfig,
    revision,
    createdAt: connectedAt,
    updatedAt: connectedAt,
  };
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

function capability(): DropshipEbayFulfillmentCapability {
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
      originWarehouseId: 1,
      rateBookId: 34,
      rateBookCode: "dropship-vendor-default",
      rateTableId: 5,
      serviceLevelId: 7,
      fulfillmentRoutingRevision: 4,
    },
  };
}

function connectionInput(
  overrides: Partial<Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0]> = {},
): Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0] {
  return {
    vendorId: 10,
    storeConnectionId: 44,
    platform: "ebay",
    providerEnvironment: "sandbox",
    shopDomain: null,
    accessToken: "access-token",
    connectedAt,
    ...overrides,
  };
}

function provider(name: string, calls: string[]): DropshipStoreConnectionPostConnectProvider {
  return {
    async afterStoreConnected() {
      calls.push(name);
    },
  };
}

function logger(logs: DropshipLogEvent[]) {
  return {
    info: (event: DropshipLogEvent) => logs.push(event),
    warn: (event: DropshipLogEvent) => logs.push(event),
    error: (event: DropshipLogEvent) => logs.push(event),
  };
}

interface LevelledLogEntry {
  level: "info" | "warn" | "error";
  event: DropshipLogEvent;
}

/**
 * The managed-location line of the automatic setup: the system actor and the
 * store are its correlation (there is no vendor request key), then the location.
 */
function reconciledEntry(action: DropshipEbayManagedLocation["action"] = "unchanged"): LevelledLogEntry {
  return {
    level: "info",
    event: {
      code: "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED",
      message: expect.any(String),
      context: {
        storeConnectionId: 44,
        actorType: "system",
        originWarehouseId: 1,
        merchantLocationKey: "cardshellz-dropship-wh-1",
        action,
      },
    },
  };
}

function reconciledEntries(entries: readonly LevelledLogEntry[]): LevelledLogEntry[] {
  return entries.filter((entry) => entry.event.code === "DROPSHIP_EBAY_MANAGED_LOCATION_RECONCILED");
}

function levelsAndCodes(entries: readonly LevelledLogEntry[]): Array<[LevelledLogEntry["level"], string]> {
  return entries.map((entry) => [entry.level, entry.event.code]);
}

function levelledLogger(entries: LevelledLogEntry[]) {
  return {
    info: (event: DropshipLogEvent) => entries.push({ level: "info", event }),
    warn: (event: DropshipLogEvent) => entries.push({ level: "warn", event }),
    error: (event: DropshipLogEvent) => entries.push({ level: "error", event }),
  };
}
