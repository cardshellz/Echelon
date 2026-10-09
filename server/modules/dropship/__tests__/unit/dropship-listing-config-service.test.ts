import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  dropshipStoreConnectionStatusEnum,
  dropshipVendorStatusEnum,
  type DropshipStoreConnectionStatus,
  type DropshipVendorStatus,
} from "../../../../../shared/schema/dropship.schema";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  assertStoreStatusAllowsListingConfigWrite,
  buildDefaultDropshipStoreListingConfig,
  decideDropshipListingConfigAccess,
  DROPSHIP_DEFAULT_EBAY_LISTING_MODE,
  DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
  DROPSHIP_DEFAULT_LISTING_MODE,
  DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
  DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES,
  DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES,
  DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
  dropshipListingConfigFault,
  dropshipListingConfigReadOnlyError,
  DropshipListingConfigService,
  listingConfigChangedFields,
  listingConfigContent,
  listingConfigContentEquals,
  normalizeListingConfigInput,
  type DropshipListingConfigKeyedRequest,
  type DropshipListingConfigKeyedRequestRecord,
  type DropshipListingConfigReadOnlyReason,
  type DropshipListingConfigRepository,
  type DropshipListingConfigStoreConnectionContext,
  type DropshipStoreListingConfigContent,
  type DropshipStoreListingConfigRecord,
  type EnsureDropshipStoreListingConfigRepositoryInput,
  type ReplaceDropshipStoreListingConfigRepositoryInput,
  type ReplaceDropshipStoreListingConfigRepositoryResult,
} from "../../application/dropship-listing-config-service";
import type { ReplaceDropshipStoreListingConfigInput } from "../../application/dropship-listing-config-dtos";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";

const now = new Date("2026-05-01T18:30:00.000Z");
const createdAt = new Date("2026-04-01T12:00:00.000Z");
/** The top of Postgres int4, the revision column's type (migration 0728). */
const MAX_REVISION = 2_147_483_647;

/** A keyed eBay setup save, as the setup service sends it. */
const saveRequest: DropshipListingConfigKeyedRequest = {
  operation: "ebay_listing_setup_save",
  idempotencyKey: "listing-setup:22:0001",
  requestHash: "a".repeat(64),
};

/** A second keyed save for the same store, under its own key. */
const laterSaveRequest: DropshipListingConfigKeyedRequest = {
  operation: "ebay_listing_setup_save",
  idempotencyKey: "listing-setup:22:0002",
  requestHash: "e".repeat(64),
};

type LoggedEvent = DropshipLogEvent & { level: "info" | "warn" | "error" };

describe("DropshipListingConfigService", () => {
  let repository: FakeListingConfigRepository;
  let vendorProvisioning: FakeVendorProvisioningService;
  let logs: LoggedEvent[];
  let service: DropshipListingConfigService;

  beforeEach(() => {
    repository = new FakeListingConfigRepository();
    vendorProvisioning = new FakeVendorProvisioningService();
    logs = [];
    service = new DropshipListingConfigService({
      vendorProvisioning: vendorProvisioning as unknown as DropshipVendorProvisioningService,
      repository,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push({ level: "info", ...event }),
        warn: (event) => logs.push({ level: "warn", ...event }),
        error: (event) => logs.push({ level: "error", ...event }),
      },
    });
  });

  it("ensures a neutral listing config for a connected store", async () => {
    const result = await service.getForMember("member-1", 22);

    expect(result.config).toMatchObject({
      storeConnectionId: 22,
      platform: "shopify",
      listingMode: DROPSHIP_DEFAULT_LISTING_MODE,
      inventoryMode: DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
      priceMode: DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
      marketplaceConfig: {},
      requiredConfigKeys: [],
      requiredProductFields: [],
      isActive: true,
      revision: 1,
    });
    expect(repository.lastEnsureInput).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      actor: { actorType: "vendor", actorId: "member-1" },
    });
  });

  it("refuses the editable member read for a closed vendor before loading the store", async () => {
    vendorProvisioning.vendor = makeVendor({ status: "closed" });

    await expect(service.getForMember("member-1", 22)).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
    });
    expect(repository.storeLookups).toEqual([]);
    expect(repository.ensureInputs).toEqual([]);
  });

  it("defaults new eBay configs to live while Shopify remains draft-first", () => {
    const ebayConfig = buildDefaultDropshipStoreListingConfig("ebay");
    expect(ebayConfig.listingMode).toBe(
      DROPSHIP_DEFAULT_EBAY_LISTING_MODE,
    );
    expect(ebayConfig.requiredConfigKeys).not.toContain("categoryId");
    expect(ebayConfig.requiredProductFields).toContain("ebayBrowseCategoryId");
    expect(ebayConfig.marketplaceConfig).toEqual({ marketplaceId: "EBAY_US" });
    expect(buildDefaultDropshipStoreListingConfig("shopify").listingMode).toBe(
      DROPSHIP_DEFAULT_LISTING_MODE,
    );
  });

  it("lets admins ensure a listing config without provisioning a member identity", async () => {
    const result = await service.getForAdmin(22, {
      actorType: "admin",
      actorId: "admin-1",
    });

    expect(result.storeConnection).toMatchObject({ vendorId: 10, storeConnectionId: 22 });
    expect(result.config).toMatchObject({
      storeConnectionId: 22,
      platform: "shopify",
      isActive: true,
      revision: 1,
    });
    expect(repository.lastEnsureInput).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    expect(vendorProvisioning.provisionCalls).toEqual([]);
  });

  it("replaces listing config with normalized required keys and fields", async () => {
    repository.config = makeConfigRecord();

    const result = await service.replaceForMember("member-1", 22, {
      listingMode: "live",
      inventoryMode: "manual_quantity",
      priceMode: "vendor_defined",
      marketplaceConfig: { fulfillmentPolicyId: "fulfillment-1" },
      requiredConfigKeys: [" fulfillmentPolicyId ", "fulfillmentPolicyId", "payment.policy"],
      requiredProductFields: ["sku", "brand", "sku"],
      isActive: true,
      expectedRevision: 1,
    });

    expect(result).toMatchObject({ outcome: "changed", revisionBefore: 1, revisionAfter: 2 });
    expect(result.config).toMatchObject({
      listingMode: "live",
      inventoryMode: "manual_quantity",
      priceMode: "vendor_defined",
      marketplaceConfig: { fulfillmentPolicyId: "fulfillment-1" },
      requiredConfigKeys: ["fulfillmentPolicyId", "payment.policy"],
      requiredProductFields: ["sku", "brand"],
      revision: 2,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "info", code: "DROPSHIP_LISTING_CONFIG_REPLACED" });
  });

  it("lets admins replace listing config for any existing store connection", async () => {
    repository.config = makeConfigRecord();

    const result = await service.replaceForAdmin(22, {
      listingMode: "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfig: { marketplaceId: "EBAY_US" },
      requiredConfigKeys: [" marketplaceId ", "marketplaceId"],
      requiredProductFields: ["sku", "title"],
      isActive: true,
      expectedRevision: 1,
    }, {
      actorType: "admin",
      actorId: "admin-1",
    });

    expect(result).toMatchObject({ outcome: "changed", revisionBefore: 1, revisionAfter: 2 });
    expect(result.config).toMatchObject({
      marketplaceConfig: { marketplaceId: "EBAY_US" },
      requiredConfigKeys: ["marketplaceId"],
      requiredProductFields: ["sku", "title"],
      revision: 2,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_LISTING_CONFIG_REPLACED",
      context: expect.objectContaining({ actorType: "admin", storeConnectionId: 22 }),
    });
    expect(vendorProvisioning.provisionCalls).toEqual([]);
  });

  it("blocks updates for disconnected stores and logs the refusal at INFO", async () => {
    repository.config = makeConfigRecord();
    repository.storeConnection = {
      ...repository.storeConnection,
      status: "disconnected",
    };

    await expect(service.replaceForMember("member-1", 22, {
      listingMode: "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfig: {},
      requiredConfigKeys: [],
      requiredProductFields: [],
      isActive: true,
      expectedRevision: 1,
    })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED",
      context: { vendorId: 10, storeConnectionId: 22, status: "disconnected", retryable: false },
    });
    expect(repository.replaceInputs).toEqual([]);
    expect(logs).toEqual([refusalLog({ errorCode: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED" })]);
  });

  it("blocks admin updates for disconnected stores", async () => {
    repository.config = makeConfigRecord();
    repository.storeConnection = {
      ...repository.storeConnection,
      status: "disconnected",
    };

    await expect(service.replaceForAdmin(22, {
      listingMode: "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfig: {},
      requiredConfigKeys: [],
      requiredProductFields: [],
      isActive: true,
      expectedRevision: 1,
    }, {
      actorType: "admin",
      actorId: "admin-1",
    })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED" });
    expect(repository.replaceInputs).toEqual([]);
  });

  it("rejects unsupported required product fields at the boundary", async () => {
    repository.config = makeConfigRecord();

    const error = await service.replaceForMember("member-1", 22, {
      listingMode: "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfig: {},
      requiredConfigKeys: [],
      requiredProductFields: ["unknownField"],
      isActive: true,
      expectedRevision: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues).toEqual([
      expect.objectContaining({ path: ["requiredProductFields", 0] }),
    ]);
    expect(repository.replaceInputs).toEqual([]);
  });

  it("refuses a member write for a blocked vendor before loading the store or writing", async () => {
    repository.config = makeConfigRecord();
    vendorProvisioning.vendor = makeVendor({ status: "suspended" });

    await expect(service.replaceForMember("member-1", 22, replaceBody())).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
    });
    expect(repository.storeLookups).toEqual([]);
    expect(repository.replaceInputs).toEqual([]);
  });

  it("refuses a member write to another vendor's store as not found", async () => {
    repository.config = makeConfigRecord();
    repository.storeConnection = { ...repository.storeConnection, vendorId: 99 };

    await expect(service.replaceForMember("member-1", 22, replaceBody())).rejects.toMatchObject({
      code: "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
      context: { vendorId: 10, storeConnectionId: 22 },
    });
    expect(repository.replaceInputs).toEqual([]);
  });

  it("does not mutate the request body", async () => {
    repository.config = makeConfigRecord();
    const body = deepFreeze(replaceBody({
      marketplaceConfig: { businessPolicies: { fulfillmentPolicyId: "fulfillment-1" } },
      requiredConfigKeys: [" fulfillmentPolicyId ", "fulfillmentPolicyId"],
    }));
    const snapshot = structuredClone(body);

    await service.replaceForMember("member-1", 22, body);

    expect(body).toEqual(snapshot);
    expect(repository.replaceInputs[0]!.config.requiredConfigKeys).toEqual(["fulfillmentPolicyId"]);
  });

  it("answers a keyed request lookup from the repository", async () => {
    repository.config = makeConfigRecord();
    await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest });

    await expect(service.findKeyedRequest({
      vendorId: 10,
      idempotencyKey: saveRequest.idempotencyKey,
    })).resolves.toEqual({
      storeConnectionId: 22,
      operation: "ebay_listing_setup_save",
      requestHash: saveRequest.requestHash,
      revisionBefore: 1,
      revisionAfter: 2,
      outcome: "changed",
      createdAt: now,
    });
    await expect(service.findKeyedRequest({ vendorId: 10, idempotencyKey: "listing-setup:22:never" }))
      .resolves.toBeNull();
    // The ledger is per vendor: the same key under another vendor is a different request.
    await expect(service.findKeyedRequest({ vendorId: 11, idempotencyKey: saveRequest.idempotencyKey }))
      .resolves.toBeNull();
  });

  describe("expected revision", () => {
    beforeEach(() => {
      repository.config = makeConfigRecord();
    });

    it("refuses a member replace without expectedRevision before provisioning the vendor or writing", async () => {
      const error = await service.replaceForMember("member-1", 22, replaceBodyWithout("expectedRevision"))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues).toEqual([
        expect.objectContaining({ code: "invalid_type", received: "undefined", path: ["expectedRevision"] }),
      ]);
      expect(vendorProvisioning.provisionCalls).toEqual([]);
      expect(repository.replaceInputs).toEqual([]);
      expect(logs).toEqual([]);
    });

    it("refuses an admin replace without expectedRevision before loading the store or writing", async () => {
      const error = await service.replaceForAdmin(22, replaceBodyWithout("expectedRevision"), {
        actorType: "admin",
        actorId: "admin-1",
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues).toEqual([
        expect.objectContaining({ code: "invalid_type", received: "undefined", path: ["expectedRevision"] }),
      ]);
      expect(repository.storeLookups).toEqual([]);
      expect(repository.replaceInputs).toEqual([]);
    });

    it.each([
      { label: "zero", expectedRevision: 0 },
      { label: "negative", expectedRevision: -1 },
      { label: "fractional", expectedRevision: 1.5 },
      { label: "a numeric string", expectedRevision: "1" },
      { label: "null", expectedRevision: null },
      { label: "above the int4 range", expectedRevision: MAX_REVISION + 1 },
    ])("refuses an expectedRevision that is $label", async ({ expectedRevision }) => {
      const error = await service.replaceForMember("member-1", 22, replaceBody({ expectedRevision }))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues).toEqual([
        expect.objectContaining({ path: ["expectedRevision"] }),
      ]);
      expect(repository.replaceInputs).toEqual([]);
    });

    it("refuses `revision` sent in place of `expectedRevision`", async () => {
      const body = { ...replaceBodyWithout("expectedRevision"), revision: 1 };

      const error = await service.replaceForAdmin(22, body, { actorType: "admin", actorId: "admin-1" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues.map((issue) => issue.code).sort()).toEqual([
        "invalid_type",
        "unrecognized_keys",
      ]);
      expect(repository.replaceInputs).toEqual([]);
    });

    it("hands the largest int4 revision to the repository", async () => {
      repository.config = makeConfigRecord({ revision: MAX_REVISION });

      const result = await service.replaceForMember("member-1", 22, unchangedBody({ expectedRevision: MAX_REVISION }));

      expect(repository.replaceInputs[0]!.expectedRevision).toBe(MAX_REVISION);
      expect(result).toMatchObject({ outcome: "unchanged", revisionBefore: MAX_REVISION, revisionAfter: MAX_REVISION });
    });

    it("propagates the repository's revision conflict and logs it as a refused write, never as a write", async () => {
      repository.config = makeConfigRecord({ revision: 3 });

      await expect(service.replaceForMember("member-1", 22, replaceBody({ expectedRevision: 2 })))
        .rejects.toMatchObject({
          code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
          context: { expectedRevision: 2, currentRevision: 3 },
        });
      expect(repository.config!.revision).toBe(3);
      expect(logs).toEqual([refusalLog({
        expectedRevision: 2,
        errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        currentRevision: 3,
      })]);
    });
  });

  describe("repository terms", () => {
    beforeEach(() => {
      repository.config = makeConfigRecord();
    });

    it("sends a member write with the vendor setup statuses, no request key and the replace audit event by default", async () => {
      await service.replaceForMember("member-1", 22, replaceBody());

      expect(repository.replaceInputs[0]!.allowedStoreStatuses).toBe(DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES);

      expect(repository.replaceInputs).toEqual([{
        vendorId: 10,
        storeConnectionId: 22,
        platform: "shopify",
        config: {
          listingMode: "live",
          inventoryMode: "manual_quantity",
          priceMode: "vendor_defined",
          marketplaceConfig: { fulfillmentPolicyId: "fulfillment-1" },
          requiredConfigKeys: ["fulfillmentPolicyId"],
          requiredProductFields: ["sku"],
          isActive: true,
        },
        expectedRevision: 1,
        allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
        request: null,
        auditEventType: "listing_config_replaced",
        actor: { actorType: "vendor", actorId: "member-1" },
        now,
      }]);
    });

    it("passes a member write's request key, audit event and store statuses through", async () => {
      const repairRequest: DropshipListingConfigKeyedRequest = {
        operation: "ebay_ship_from_repair",
        idempotencyKey: "ship-from:22:0001",
        requestHash: "b".repeat(64),
      };

      await service.replaceForMember("member-1", 22, replaceBody(), {
        request: repairRequest,
        auditEventType: "listing_config_ship_from_repaired",
        allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
      });

      const input = repository.replaceInputs[0]!;
      expect(input.request).toEqual(repairRequest);
      expect(input.auditEventType).toBe("listing_config_ship_from_repaired");
      expect(input.allowedStoreStatuses).toBe(DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES);
      expect(input.expectedRevision).toBe(1);
    });

    it("sends an admin write with the staff statuses, no request key and the replace audit event by default", async () => {
      await service.replaceForAdmin(22, replaceBody(), { actorType: "admin", actorId: "admin-1" });

      expect(repository.replaceInputs).toEqual([expect.objectContaining({
        vendorId: 10,
        storeConnectionId: 22,
        platform: "shopify",
        expectedRevision: 1,
        allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES,
        request: null,
        auditEventType: "listing_config_replaced",
        actor: { actorType: "admin", actorId: "admin-1" },
        now,
      })]);
      expect(repository.replaceInputs[0]!.config).not.toHaveProperty("expectedRevision");
    });

    it("passes an admin write's request key, audit event, store statuses and actor through", async () => {
      await service.replaceForAdmin(22, replaceBody(), { actorType: "system", actorId: null }, {
        request: saveRequest,
        auditEventType: "listing_config_ship_from_repaired",
        allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES,
      });

      expect(repository.replaceInputs[0]).toMatchObject({
        request: saveRequest,
        auditEventType: "listing_config_ship_from_repaired",
        actor: { actorType: "system", actorId: null },
        expectedRevision: 1,
      });
      expect(repository.replaceInputs[0]!.allowedStoreStatuses).toBe(DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES);
    });

    it("returns the repository's config, outcome and revisions to staff", async () => {
      const result = await service.replaceForAdmin(22, replaceBody(), { actorType: "admin", actorId: "admin-1" });

      expect(result).toEqual({
        storeConnection: repository.storeConnection,
        config: repository.config,
        outcome: "changed",
        revisionBefore: 1,
        revisionAfter: 2,
      });
    });

    it("returns the repository's config, outcome and revisions to the vendor", async () => {
      const result = await service.replaceForMember("member-1", 22, replaceBody());

      expect(result).toEqual({
        vendor: { ...vendorProvisioning.vendor, memberId: "member-1" },
        storeConnection: repository.storeConnection,
        config: repository.config,
        outcome: "changed",
        revisionBefore: 1,
        revisionAfter: 2,
      });
    });

    it("returns a replay's revision after as the ledger recorded it, not the newer config's revision", async () => {
      await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest });
      await service.replaceForMember("member-1", 22, movedOnBody(), { request: laterSaveRequest });
      const current = repository.config;

      const replay = await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest });

      expect(replay).toEqual({
        vendor: { ...vendorProvisioning.vendor, memberId: "member-1" },
        storeConnection: repository.storeConnection,
        config: current,
        outcome: "replayed",
        revisionBefore: 1,
        revisionAfter: 2,
      });
      expect(replay.config.revision).toBe(3);
      // Nothing was written by the replay.
      expect(repository.config).toBe(current);
      expect(repository.ledger.size).toBe(2);
    });

    it("returns a staff replay's ledger revisions with the current config", async () => {
      const actor = { actorType: "admin", actorId: "admin-1" } as const;
      await service.replaceForAdmin(22, replaceBody(), actor, { request: saveRequest });
      await service.replaceForAdmin(22, movedOnBody(), actor, { request: laterSaveRequest });

      const replay = await service.replaceForAdmin(22, replaceBody(), actor, { request: saveRequest });

      expect(replay).toEqual({
        storeConnection: repository.storeConnection,
        config: repository.config,
        outcome: "replayed",
        revisionBefore: 1,
        revisionAfter: 2,
      });
      expect(replay.config.revision).toBe(3);
      expect(logs[2]!.context).toMatchObject({ actorType: "admin", revisionAfter: 2, currentRevision: 3 });
    });
  });

  describe("store statuses a write may land on", () => {
    beforeEach(() => {
      repository.config = makeConfigRecord();
    });

    it.each(["connected", "needs_reauth", "refresh_failed", "grace_period", "paused"] satisfies DropshipStoreConnectionStatus[])(
      "lets staff save on a %s store",
      async (status) => {
        repository.storeConnection = { ...repository.storeConnection, status };

        const result = await service.replaceForAdmin(22, replaceBody(), { actorType: "admin", actorId: "admin-1" });

        expect(result.outcome).toBe("changed");
        expect(repository.replaceInputs).toHaveLength(1);
        expect(repository.replaceInputs[0]!.allowedStoreStatuses).toBe(DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES);
      },
    );

    it.each([
      { status: "paused", code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" },
      { status: "grace_period", code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING" },
      { status: "disconnected", code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED" },
    ] satisfies Array<{ status: DropshipStoreConnectionStatus; code: string }>)(
      "refuses a vendor setup save on a $status store before calling the repository",
      async ({ status, code }) => {
        repository.storeConnection = { ...repository.storeConnection, status };

        const error = await service.replaceForMember("member-1", 22, replaceBody(), {
          request: saveRequest,
          allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(DropshipError);
        expect(error).toMatchObject({
          code,
          context: { vendorId: 10, storeConnectionId: 22, status, retryable: false },
        });
        expect(repository.replaceInputs).toEqual([]);
        expect(repository.ledger.size).toBe(0);
        expect(logs).toEqual([refusalLog({ requestKey: saveRequest.idempotencyKey, errorCode: code })]);
      },
    );

    it.each(["connected", "needs_reauth", "refresh_failed"] satisfies DropshipStoreConnectionStatus[])(
      "lets a vendor setup save land on a %s store",
      async (status) => {
        repository.storeConnection = { ...repository.storeConnection, status };

        const result = await service.replaceForMember("member-1", 22, replaceBody(), {
          allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
        });

        expect(result.outcome).toBe("changed");
      },
    );

    it("refuses a system setup save on a store that needs a new eBay sign-in as not writable", async () => {
      repository.storeConnection = { ...repository.storeConnection, status: "needs_reauth" };

      await expect(service.replaceForAdmin(22, replaceBody(), { actorType: "system", actorId: null }, {
        allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES,
      })).rejects.toMatchObject({
        code: "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE",
        context: { status: "needs_reauth", retryable: false },
      });
      expect(repository.replaceInputs).toEqual([]);
    });

    it("refuses an admin save with the vendor setup statuses on a paused store", async () => {
      repository.storeConnection = { ...repository.storeConnection, status: "paused" };

      await expect(service.replaceForAdmin(22, replaceBody(), { actorType: "admin", actorId: "admin-1" }, {
        allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
      })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" });
      expect(repository.replaceInputs).toEqual([]);
    });
  });

  describe("getViewForMember", () => {
    it("ensures the config for an editable view and never takes the read-only path", async () => {
      const result = await service.getViewForMember("member-1", 22);

      expect(result.access).toEqual({ canEdit: true, reason: null });
      expect(result.config).toMatchObject({ storeConnectionId: 22, revision: 1 });
      expect(result.vendor).toMatchObject({ vendorId: 10, memberId: "member-1" });
      expect(result.storeConnection).toMatchObject({ vendorId: 10, storeConnectionId: 22, status: "connected" });
      expect(repository.ensureInputs).toEqual([{
        vendorId: 10,
        storeConnectionId: 22,
        platform: "shopify",
        actor: { actorType: "vendor", actorId: "member-1" },
        now,
      }]);
      expect(repository.findConfigInputs).toEqual([]);
    });

    it.each(["onboarding", "active", "paused"] satisfies DropshipVendorStatus[])(
      "keeps the view editable for a %s vendor on a connected store",
      async (status) => {
        vendorProvisioning.vendor = makeVendor({ status });

        const result = await service.getViewForMember("member-1", 22);

        expect(result.access).toEqual({ canEdit: true, reason: null });
        expect(repository.ensureInputs).toHaveLength(1);
        expect(repository.findConfigInputs).toEqual([]);
      },
    );

    it.each([
      { label: "a closed vendor", vendorStatus: "closed", storeStatus: "connected", reason: "vendor_not_active" },
      { label: "a lapsed vendor", vendorStatus: "lapsed", storeStatus: "connected", reason: "vendor_not_active" },
      { label: "a suspended vendor", vendorStatus: "suspended", storeStatus: "connected", reason: "vendor_not_active" },
      { label: "a paused store", vendorStatus: "active", storeStatus: "paused", reason: "store_paused" },
      { label: "a store being disconnected", vendorStatus: "active", storeStatus: "grace_period", reason: "store_disconnecting" },
      { label: "a disconnected store", vendorStatus: "active", storeStatus: "disconnected", reason: "store_disconnected" },
    ] satisfies Array<{
      label: string;
      vendorStatus: DropshipVendorStatus;
      storeStatus: DropshipStoreConnectionStatus;
      reason: DropshipListingConfigReadOnlyReason;
    }>)("shows $label read-only from the stored config without ensuring one", async ({ vendorStatus, storeStatus, reason }) => {
      vendorProvisioning.vendor = makeVendor({ status: vendorStatus });
      repository.storeConnection = { ...repository.storeConnection, status: storeStatus };
      const stored = makeConfigRecord({ revision: 4, listingMode: "live" });
      repository.config = stored;

      const result = await service.getViewForMember("member-1", 22);

      expect(result.access).toEqual({ canEdit: false, reason });
      expect(result.config).toBe(stored);
      expect(result.storeConnection.status).toBe(storeStatus);
      expect(repository.findConfigInputs).toEqual([{ storeConnectionId: 22 }]);
      expect(repository.ensureInputs).toEqual([]);
    });

    it.each([
      { vendorStatus: "closed", storeStatus: "connected" },
      { vendorStatus: "active", storeStatus: "paused" },
      { vendorStatus: "active", storeStatus: "grace_period" },
      { vendorStatus: "active", storeStatus: "disconnected" },
    ] satisfies Array<{ vendorStatus: DropshipVendorStatus; storeStatus: DropshipStoreConnectionStatus }>)(
      "returns no config for a read-only view ($vendorStatus vendor, $storeStatus store) of a store that has none, and creates none",
      async ({ vendorStatus, storeStatus }) => {
        vendorProvisioning.vendor = makeVendor({ status: vendorStatus });
        repository.storeConnection = { ...repository.storeConnection, status: storeStatus };

        const result = await service.getViewForMember("member-1", 22);

        expect(result.config).toBeNull();
        expect(result.access.canEdit).toBe(false);
        expect(repository.config).toBeNull();
        expect(repository.ensureInputs).toEqual([]);
      },
    );

    it("refuses a view of another vendor's store as not found, without reading or creating its config", async () => {
      repository.storeConnection = { ...repository.storeConnection, vendorId: 99 };

      await expect(service.getViewForMember("member-1", 22)).rejects.toMatchObject({
        code: "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
      });
      expect(repository.findConfigInputs).toEqual([]);
      expect(repository.ensureInputs).toEqual([]);
    });
  });

  describe("write logging", () => {
    beforeEach(() => {
      repository.config = makeConfigRecord();
    });

    it("logs one INFO line for a changed write with its revisions and request key", async () => {
      await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest });

      expect(logs).toEqual([{
        level: "info",
        code: "DROPSHIP_LISTING_CONFIG_REPLACED",
        message: expect.any(String),
        context: {
          vendorId: 10,
          storeConnectionId: 22,
          platform: "shopify",
          actorType: "vendor",
          expectedRevision: 1,
          requestKey: saveRequest.idempotencyKey,
          operation: "listing_config_replaced",
          outcome: "changed",
          revisionBefore: 1,
          revisionAfter: 2,
          currentRevision: 2,
          listingMode: "live",
          inventoryMode: "manual_quantity",
          priceMode: "vendor_defined",
          isActive: true,
        },
      }]);
    });

    it("logs one INFO line for an unchanged write, with the same revision before, after and now", async () => {
      const result = await service.replaceForMember("member-1", 22, unchangedBody());

      expect(result).toMatchObject({ outcome: "unchanged", revisionBefore: 1, revisionAfter: 1, config: { revision: 1 } });
      expect(repository.config!.revision).toBe(1);
      expect(logs).toEqual([expect.objectContaining({
        level: "info",
        code: "DROPSHIP_LISTING_CONFIG_UNCHANGED",
        context: expect.objectContaining({
          outcome: "unchanged",
          revisionBefore: 1,
          revisionAfter: 1,
          currentRevision: 1,
          requestKey: null,
        }),
      })]);
    });

    it("logs a replayed request by its key with the ledger's revisions and the current revision", async () => {
      const first = await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest });
      const replay = await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest });

      expect(first).toMatchObject({ outcome: "changed", revisionBefore: 1, revisionAfter: 2, config: { revision: 2 } });
      expect(replay).toMatchObject({ outcome: "replayed", revisionBefore: 1, revisionAfter: 2, config: { revision: 2 } });
      expect(repository.config!.revision).toBe(2);
      expect(logs.map((log) => [log.level, log.code])).toEqual([
        ["info", "DROPSHIP_LISTING_CONFIG_REPLACED"],
        ["info", "DROPSHIP_LISTING_CONFIG_REPLAYED"],
      ]);
      expect(logs[1]!.context).toMatchObject({
        outcome: "replayed",
        requestKey: saveRequest.idempotencyKey,
        revisionBefore: 1,
        revisionAfter: 2,
        currentRevision: 2,
      });
    });

    it("logs a replay whose config moved on with the ledger's revision after and the newer current revision", async () => {
      await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest });
      // Another save lands after the first one (revision 2 -> 3) before the first is retried.
      await service.replaceForMember("member-1", 22, movedOnBody(), { request: laterSaveRequest });

      const replay = await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest });

      expect(repository.config!.revision).toBe(3);
      expect(replay).toMatchObject({ outcome: "replayed", revisionBefore: 1, revisionAfter: 2, config: { revision: 3 } });
      expect(logs.map((log) => [log.level, log.code])).toEqual([
        ["info", "DROPSHIP_LISTING_CONFIG_REPLACED"],
        ["info", "DROPSHIP_LISTING_CONFIG_REPLACED"],
        ["info", "DROPSHIP_LISTING_CONFIG_REPLAYED"],
      ]);
      expect(logs[2]).toEqual({
        level: "info",
        code: "DROPSHIP_LISTING_CONFIG_REPLAYED",
        message: expect.any(String),
        context: {
          vendorId: 10,
          storeConnectionId: 22,
          platform: "shopify",
          actorType: "vendor",
          expectedRevision: 1,
          requestKey: saveRequest.idempotencyKey,
          operation: "listing_config_replaced",
          outcome: "replayed",
          // What this request did, as the ledger recorded it...
          revisionBefore: 1,
          revisionAfter: 2,
          // ...and where the config is now, after the later save.
          currentRevision: 3,
          listingMode: "live",
          inventoryMode: "manual_quantity",
          priceMode: "vendor_defined",
          isActive: true,
        },
      });
    });

    it("logs a replayed unchanged request with its unmoved ledger revision, even after the config moved on", async () => {
      await service.replaceForMember("member-1", 22, unchangedBody(), { request: saveRequest });
      await service.replaceForMember("member-1", 22, replaceBody(), { request: laterSaveRequest });

      const replay = await service.replaceForMember("member-1", 22, unchangedBody(), { request: saveRequest });

      expect(replay).toMatchObject({ outcome: "replayed", revisionBefore: 1, revisionAfter: 1, config: { revision: 2 } });
      expect(logs.map((log) => log.code)).toEqual([
        "DROPSHIP_LISTING_CONFIG_UNCHANGED",
        "DROPSHIP_LISTING_CONFIG_REPLACED",
        "DROPSHIP_LISTING_CONFIG_REPLAYED",
      ]);
      expect(logs[2]!.context).toMatchObject({
        outcome: "replayed",
        requestKey: saveRequest.idempotencyKey,
        revisionBefore: 1,
        revisionAfter: 1,
        currentRevision: 2,
      });
    });

    it("names the audit event the write was made as", async () => {
      await service.replaceForAdmin(22, replaceBody(), { actorType: "admin", actorId: "admin-1" }, {
        auditEventType: "listing_config_ship_from_repaired",
      });

      expect(logs).toHaveLength(1);
      expect(logs[0]!.context).toMatchObject({
        actorType: "admin",
        operation: "listing_config_ship_from_repaired",
        requestKey: null,
      });
    });

    it("logs a key reused for a different request as one refused write and no second write", async () => {
      await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest });

      await expect(service.replaceForMember("member-1", 22, replaceBody({ expectedRevision: 2 }), {
        request: { ...saveRequest, requestHash: "c".repeat(64) },
      })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT" });
      expect(logs.map((log) => [log.level, log.code])).toEqual([
        ["info", "DROPSHIP_LISTING_CONFIG_REPLACED"],
        ["info", "DROPSHIP_LISTING_CONFIG_WRITE_REFUSED"],
      ]);
      expect(logs[1]).toEqual(refusalLog({
        expectedRevision: 2,
        requestKey: saveRequest.idempotencyKey,
        errorCode: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
      }));
      expect(repository.config!.revision).toBe(2);
    });
  });

  describe("default store statuses", () => {
    beforeEach(() => {
      repository.config = makeConfigRecord();
    });

    it.each([
      { status: "paused", code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" },
      { status: "grace_period", code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING" },
      { status: "disconnected", code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED" },
    ] satisfies Array<{ status: DropshipStoreConnectionStatus; code: string }>)(
      "refuses a vendor replace that names no statuses on a $status store before calling the repository",
      async ({ status, code }) => {
        repository.storeConnection = { ...repository.storeConnection, status };

        const error = await service.replaceForMember("member-1", 22, replaceBody()).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(DropshipError);
        expect(error).toMatchObject({
          code,
          context: { vendorId: 10, storeConnectionId: 22, status, retryable: false },
        });
        expect(repository.replaceInputs).toEqual([]);
        expect(repository.config).toEqual(makeConfigRecord());
        expect(logs).toEqual([refusalLog({ errorCode: code })]);
      },
    );

    it.each(["connected", "needs_reauth", "refresh_failed"] satisfies DropshipStoreConnectionStatus[])(
      "lets a vendor replace that names no statuses land on a %s store, re-checked with the vendor setup statuses",
      async (status) => {
        repository.storeConnection = { ...repository.storeConnection, status };

        const result = await service.replaceForMember("member-1", 22, replaceBody());

        expect(result).toMatchObject({ outcome: "changed", revisionBefore: 1, config: { revision: 2 } });
        expect(repository.replaceInputs[0]!.allowedStoreStatuses).toBe(DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES);
      },
    );

    it("refuses a vendor replace on a store paused after the service checked it, through the repository's re-check", async () => {
      repository.beforeReplace = () => {
        repository.storeConnection = { ...repository.storeConnection, status: "paused" };
      };

      await expect(service.replaceForMember("member-1", 22, replaceBody())).rejects.toMatchObject({
        code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
        context: { status: "paused", retryable: false },
      });
      expect(repository.replaceInputs).toHaveLength(1);
      expect(repository.config!.revision).toBe(1);
      expect(logs).toEqual([refusalLog({ errorCode: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" })]);
    });

    it.each(["paused", "grace_period"] satisfies DropshipStoreConnectionStatus[])(
      "lets a staff replace that names no statuses land on a %s store a vendor may not save on",
      async (status) => {
        repository.storeConnection = { ...repository.storeConnection, status };

        await expect(service.replaceForMember("member-1", 22, replaceBody())).rejects.toBeInstanceOf(DropshipError);
        const result = await service.replaceForAdmin(22, replaceBody(), { actorType: "admin", actorId: "admin-1" });

        expect(result).toMatchObject({ outcome: "changed", revisionBefore: 1, config: { revision: 2 } });
        expect(repository.replaceInputs).toHaveLength(1);
        expect(repository.replaceInputs[0]!.allowedStoreStatuses).toBe(DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES);
        expect(logs.map((log) => [log.level, log.code])).toEqual([
          ["info", "DROPSHIP_LISTING_CONFIG_WRITE_REFUSED"],
          ["info", "DROPSHIP_LISTING_CONFIG_REPLACED"],
        ]);
      },
    );
  });

  describe("write refusal logging", () => {
    beforeEach(() => {
      repository.config = makeConfigRecord();
    });

    it("logs a staff write refused on a moved revision at INFO with the staff actor and the current revision", async () => {
      repository.config = makeConfigRecord({ revision: 5 });

      await expect(service.replaceForAdmin(22, replaceBody({ expectedRevision: 2 }), {
        actorType: "admin",
        actorId: "admin-1",
      })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT" });

      expect(logs).toEqual([refusalLog({
        actorType: "admin",
        expectedRevision: 2,
        errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        currentRevision: 5,
      })]);
    });

    it("names the request key, the actor and the audit event of a refused system ship-from repair", async () => {
      repository.storeConnection = { ...repository.storeConnection, status: "needs_reauth" };
      const repairRequest: DropshipListingConfigKeyedRequest = {
        operation: "ebay_ship_from_repair",
        idempotencyKey: "ship-from:22:0002",
        requestHash: "d".repeat(64),
      };

      await expect(service.replaceForAdmin(22, replaceBody(), { actorType: "system", actorId: null }, {
        request: repairRequest,
        auditEventType: "listing_config_ship_from_repaired",
        allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES,
      })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE" });

      expect(logs).toEqual([refusalLog({
        actorType: "system",
        requestKey: repairRequest.idempotencyKey,
        operation: "listing_config_ship_from_repaired",
        errorCode: "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE",
      })]);
      expect(repository.replaceInputs).toEqual([]);
    });

    it("rethrows an unexpected repository failure untouched and logs neither a refusal nor a write", async () => {
      const failure = new Error("connection terminated unexpectedly");
      repository.failWith = failure;

      const error = await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest })
        .catch((caught: unknown) => caught);

      expect(error).toBe(failure);
      expect(logs).toEqual([]);
      expect(repository.config!.revision).toBe(1);
    });
  });

  /**
   * Who and where are checked inside the refusal log too: a refusal there
   * comes before the vendor or the store is known, so the line takes the
   * vendor from the error (or null) and names no platform.
   */
  describe("refusals before the write is reached", () => {
    beforeEach(() => {
      repository.config = makeConfigRecord();
    });

    it.each(["closed", "lapsed", "suspended"] satisfies DropshipVendorStatus[])(
      "logs a member write refused for a %s vendor once at INFO, with the vendor from the error and no platform",
      async (status) => {
        // Another vendor id than the store's, so the logged id can only have come from the error.
        vendorProvisioning.vendor = makeVendor({ vendorId: 77, status });

        await expect(service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest }))
          .rejects.toMatchObject({
            code: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
            context: { vendorId: 77, status },
          });

        expect(logs).toEqual([refusalLog({
          vendorId: 77,
          platform: null,
          requestKey: saveRequest.idempotencyKey,
          errorCode: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
        })]);
        expect(repository.storeLookups).toEqual([]);
        expect(repository.replaceInputs).toEqual([]);
        expect(repository.ledger.size).toBe(0);
      },
    );

    it.each([
      { label: "another vendor's store", arrange: (r: FakeListingConfigRepository) => { r.storeConnection = { ...r.storeConnection, vendorId: 99 }; } },
      { label: "a store that does not exist", arrange: (r: FakeListingConfigRepository) => { r.storeConnection = { ...r.storeConnection, storeConnectionId: 23 }; } },
    ])("logs a member write to $label once at INFO as not found, with the vendor from the error and no platform", async ({ arrange }) => {
      arrange(repository);

      await expect(service.replaceForMember("member-1", 22, replaceBody(), {
        auditEventType: "listing_config_ship_from_repaired",
      })).rejects.toMatchObject({
        code: "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
        context: { vendorId: 10, storeConnectionId: 22 },
      });

      expect(logs).toEqual([refusalLog({
        platform: null,
        operation: "listing_config_ship_from_repaired",
        errorCode: "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
      })]);
      expect(repository.storeLookups).toEqual([{ vendorId: 10, storeConnectionId: 22 }]);
      expect(repository.replaceInputs).toEqual([]);
    });

    it("logs a provisioning refusal that names no vendor once at INFO with vendorId null", async () => {
      // As DropshipVendorProvisioningService refuses a member with no entitlement.
      vendorProvisioning.failWith = new DropshipError(
        "DROPSHIP_ENTITLEMENT_REQUIRED",
        "Dropship entitlement is required to provision a vendor profile.",
        { memberId: "member-1", reasonCode: "ENTITLEMENT_NOT_FOUND" },
      );

      await expect(service.replaceForMember("member-1", 22, replaceBody()))
        .rejects.toBe(vendorProvisioning.failWith);

      // A code ending in _REQUIRED is a refusal unless it is one of the named faults.
      expect(logs).toEqual([refusalLog({
        vendorId: null,
        platform: null,
        errorCode: "DROPSHIP_ENTITLEMENT_REQUIRED",
      })]);
      expect(repository.storeLookups).toEqual([]);
      expect(repository.replaceInputs).toEqual([]);
    });

    it.each([
      { label: "a numeric string", vendorId: "10" },
      { label: "a fraction", vendorId: 10.5 },
      { label: "NaN", vendorId: Number.NaN },
      { label: "past the safe integer range", vendorId: Number.MAX_SAFE_INTEGER + 1 },
      { label: "null", vendorId: null },
    ])("logs vendorId null when the refusal's vendor id is $label, never a guessed id", async ({ vendorId }) => {
      vendorProvisioning.failWith = new DropshipError(
        "DROPSHIP_ENTITLEMENT_REQUIRED",
        "Dropship entitlement is required to provision a vendor profile.",
        { vendorId },
      );

      await expect(service.replaceForMember("member-1", 22, replaceBody())).rejects.toBeInstanceOf(DropshipError);

      expect(logs).toEqual([refusalLog({ vendorId: null, platform: null, errorCode: "DROPSHIP_ENTITLEMENT_REQUIRED" })]);
    });

    it("logs a refusal with no context at all with vendorId null and no current revision", async () => {
      vendorProvisioning.failWith = new DropshipError("INVALID_DROPSHIP_MEMBER_ID", "Dropship member id is required.");

      await expect(service.replaceForMember("member-1", 22, replaceBody())).rejects.toMatchObject({
        code: "INVALID_DROPSHIP_MEMBER_ID",
      });

      expect(logs).toEqual([refusalLog({
        vendorId: null,
        platform: null,
        errorCode: "INVALID_DROPSHIP_MEMBER_ID",
        currentRevision: null,
      })]);
    });

    it("rethrows a provisioning failure that is not a DropshipError untouched, logging no refusal", async () => {
      const failure = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      vendorProvisioning.failWith = failure;

      const error = await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest })
        .catch((caught: unknown) => caught);

      expect(error).toBe(failure);
      expect(logs).toEqual([]);
      expect(repository.storeLookups).toEqual([]);
      expect(repository.replaceInputs).toEqual([]);
    });

    it("rethrows a member store lookup failure that is not a DropshipError untouched, logging no refusal", async () => {
      const failure = new Error("Connection terminated unexpectedly");
      repository.storeLookupFailure = failure;

      const error = await service.replaceForMember("member-1", 22, replaceBody()).catch((caught: unknown) => caught);

      expect(error).toBe(failure);
      expect(logs).toEqual([]);
      expect(repository.replaceInputs).toEqual([]);
    });

    it("logs a staff write to a store that does not exist once at INFO as not found, with no vendor or platform", async () => {
      await expect(service.replaceForAdmin(23, replaceBody(), { actorType: "admin", actorId: "admin-1" }))
        .rejects.toMatchObject({
          code: "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
          context: { storeConnectionId: 23 },
        });

      expect(logs).toEqual([refusalLog({
        vendorId: null,
        storeConnectionId: 23,
        platform: null,
        actorType: "admin",
        errorCode: "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
      })]);
      expect(repository.storeLookups).toEqual([{ storeConnectionId: 23 }]);
      expect(repository.replaceInputs).toEqual([]);
      expect(vendorProvisioning.provisionCalls).toEqual([]);
    });

    it("names the system actor, request key and audit event of a system write to a store that does not exist", async () => {
      const repairRequest: DropshipListingConfigKeyedRequest = {
        operation: "ebay_ship_from_repair",
        idempotencyKey: "ship-from:23:0001",
        requestHash: "f".repeat(64),
      };

      await expect(service.replaceForAdmin(23, replaceBody({ expectedRevision: 4 }), { actorType: "system", actorId: "ebay-post-connect-setup" }, {
        request: repairRequest,
        auditEventType: "listing_config_ship_from_repaired",
      })).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_NOT_FOUND" });

      expect(logs).toEqual([refusalLog({
        vendorId: null,
        storeConnectionId: 23,
        platform: null,
        actorType: "system",
        expectedRevision: 4,
        requestKey: repairRequest.idempotencyKey,
        operation: "listing_config_ship_from_repaired",
        errorCode: "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
      })]);
    });

    it("rethrows a staff store lookup failure that is not a DropshipError untouched, logging no refusal", async () => {
      const failure = new Error("Connection terminated unexpectedly");
      repository.storeLookupFailure = failure;

      const error = await service.replaceForAdmin(22, replaceBody(), { actorType: "admin", actorId: "admin-1" })
        .catch((caught: unknown) => caught);

      expect(error).toBe(failure);
      expect(logs).toEqual([]);
      expect(repository.replaceInputs).toEqual([]);
    });

    it("logs only the who-and-where refusal, never a second line from the write's own refusal log", async () => {
      vendorProvisioning.vendor = makeVendor({ status: "closed" });
      // The store would refuse too; the write's checks are never reached.
      repository.storeConnection = { ...repository.storeConnection, status: "paused" };

      await expect(service.replaceForMember("member-1", 22, replaceBody())).rejects.toMatchObject({
        code: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
      });

      expect(logs.map((log) => [log.level, log.code])).toEqual([["info", "DROPSHIP_LISTING_CONFIG_WRITE_REFUSED"]]);
    });
  });

  /**
   * A check that should always hold and did not (dropshipListingConfigFault)
   * is a fault for a person: one ERROR line, outcome "failed", never the INFO
   * refusal line. The error itself is rethrown untouched.
   */
  describe("write failure logging", () => {
    beforeEach(() => {
      repository.config = makeConfigRecord();
    });

    it.each(LISTING_CONFIG_FAULTS)("logs a member write failing with $code once at ERROR as failed, with nothing at INFO", async ({ error }) => {
      const fault = error();
      repository.failWith = fault;

      const caught = await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest })
        .catch((thrown: unknown) => thrown);

      expect(caught).toBe(fault);
      expect(logs).toEqual([failureLog({ requestKey: saveRequest.idempotencyKey, errorCode: fault.code })]);
      expect(logs.filter((log) => log.level === "info")).toEqual([]);
      expect(repository.replaceInputs).toHaveLength(1);
      expect(repository.config!.revision).toBe(1);
      expect(repository.ledger.size).toBe(0);
    });

    it.each(LISTING_CONFIG_FAULTS)("logs a staff write failing with $code once at ERROR as failed, with nothing at INFO", async ({ error }) => {
      const fault = error();
      repository.failWith = fault;

      await expect(service.replaceForAdmin(22, replaceBody({ expectedRevision: 1 }), { actorType: "system", actorId: null }, {
        allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES,
      })).rejects.toBe(fault);

      expect(logs).toEqual([failureLog({ actorType: "system", errorCode: fault.code })]);
      expect(logs.filter((log) => log.level === "info")).toEqual([]);
    });

    it("carries a fault's currentRevision into the failure line when the error names one", async () => {
      repository.failWith = new DropshipError(
        "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED",
        "The listing config revision did not advance by exactly one.",
        { storeConnectionId: 22, currentRevision: 9, retryable: false },
      );

      await expect(service.replaceForMember("member-1", 22, replaceBody())).rejects.toBeInstanceOf(DropshipError);

      expect(logs).toEqual([failureLog({
        errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED",
        currentRevision: 9,
      })]);
    });

    it("logs a fault found while the vendor and store are checked at ERROR, with no vendor or platform yet", async () => {
      // Any code with the invariant suffix is a fault, wherever it is thrown.
      vendorProvisioning.failWith = new DropshipError(
        "DROPSHIP_VENDOR_PROFILE_INVARIANT_FAILED",
        "The vendor profile broke a check that should always hold.",
        { memberId: "member-1", retryable: false },
      );

      await expect(service.replaceForMember("member-1", 22, replaceBody())).rejects.toMatchObject({
        code: "DROPSHIP_VENDOR_PROFILE_INVARIANT_FAILED",
      });

      expect(logs).toEqual([failureLog({
        vendorId: null,
        platform: null,
        errorCode: "DROPSHIP_VENDOR_PROFILE_INVARIANT_FAILED",
      })]);
      expect(repository.storeLookups).toEqual([]);
    });

    it("keeps an expected refusal from the write at INFO, never ERROR", async () => {
      repository.config = makeConfigRecord({ revision: 2 });

      await expect(service.replaceForMember("member-1", 22, replaceBody())).rejects.toMatchObject({
        code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
      });

      expect(logs).toEqual([refusalLog({ errorCode: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", currentRevision: 2 })]);
      expect(logs.filter((log) => log.level === "error")).toEqual([]);
    });
  });

  describe("findConfig", () => {
    it("returns the stored config without creating one, provisioning the vendor or loading the store", async () => {
      const stored = makeConfigRecord({ revision: 6, listingMode: "live" });
      repository.config = stored;

      await expect(service.findConfig({ storeConnectionId: 22 })).resolves.toBe(stored);
      expect(repository.findConfigInputs).toEqual([{ storeConnectionId: 22 }]);
      expect(repository.ensureInputs).toEqual([]);
      expect(repository.storeLookups).toEqual([]);
      expect(vendorProvisioning.provisionCalls).toEqual([]);
      expect(logs).toEqual([]);
    });

    it("answers null for a store with no config and creates none", async () => {
      await expect(service.findConfig({ storeConnectionId: 22 })).resolves.toBeNull();
      expect(repository.config).toBeNull();
      expect(repository.ensureInputs).toEqual([]);
    });

    it("reads the repository on every call, so a read after a write sees the new revision", async () => {
      repository.config = makeConfigRecord();

      const before = await service.findConfig({ storeConnectionId: 22 });
      await service.replaceForMember("member-1", 22, replaceBody(), { request: saveRequest });
      const after = await service.findConfig({ storeConnectionId: 22 });

      expect(before).toMatchObject({ revision: 1, listingMode: DROPSHIP_DEFAULT_LISTING_MODE });
      expect(after).toMatchObject({ revision: 2, listingMode: "live" });
      expect(repository.findConfigInputs).toEqual([{ storeConnectionId: 22 }, { storeConnectionId: 22 }]);
    });
  });

  describe("marketplace config values jsonb cannot keep", () => {
    beforeEach(() => {
      repository.config = makeConfigRecord();
    });

    it("hands the repository -0 as 0 and non-finite numbers as null, and saves without throwing", async () => {
      const result = await service.replaceForMember("member-1", 22, replaceBody({
        marketplaceConfig: {
          handlingDays: -0,
          ratio: Number.NaN,
          maxWeightGrams: Number.POSITIVE_INFINITY,
          businessPolicies: { fulfillmentPolicyId: "f-1", weightGrams: -0 },
        },
      }));

      expect(result.outcome).toBe("changed");
      const stored = repository.replaceInputs[0]!.config.marketplaceConfig;
      expect(stored).toStrictEqual({
        handlingDays: 0,
        ratio: null,
        maxWeightGrams: null,
        businessPolicies: { fulfillmentPolicyId: "f-1", weightGrams: 0 },
      });
      expect(Object.is(stored.handlingDays, 0)).toBe(true);
      expect(Object.is((stored.businessPolicies as { weightGrams: number }).weightGrams, 0)).toBe(true);
    });

    it("answers unchanged, and moves no revision, when the only difference from the stored config is -0 for 0 or NaN for null", async () => {
      repository.config = makeConfigRecord({
        listingMode: "live",
        inventoryMode: "manual_quantity",
        priceMode: "vendor_defined",
        marketplaceConfig: { fulfillmentPolicyId: "fulfillment-1", handlingDays: 0, ratio: null },
        requiredConfigKeys: ["fulfillmentPolicyId"],
        requiredProductFields: ["sku"],
        isActive: true,
      });

      const result = await service.replaceForMember("member-1", 22, replaceBody({
        marketplaceConfig: { fulfillmentPolicyId: "fulfillment-1", handlingDays: -0, ratio: Number.NaN },
      }), { request: saveRequest });

      expect(result).toMatchObject({ outcome: "unchanged", revisionBefore: 1, config: { revision: 1 } });
      expect(repository.config!.revision).toBe(1);
      expect(repository.ledger.get(`10:${saveRequest.idempotencyKey}`)).toMatchObject({
        outcome: "unchanged",
        revisionBefore: 1,
        revisionAfter: 1,
      });
      expect(logs.map((log) => log.code)).toEqual(["DROPSHIP_LISTING_CONFIG_UNCHANGED"]);
    });
  });
});

describe("decideDropshipListingConfigAccess", () => {
  /** Closed, lapsed and suspended accounts read their settings; nothing else blocks the vendor. */
  const VENDOR_READ_ONLY: Record<DropshipVendorStatus, boolean> = {
    onboarding: false,
    active: false,
    paused: false,
    lapsed: true,
    suspended: true,
    closed: true,
  };
  const STORE_READ_ONLY_REASON: Record<DropshipStoreConnectionStatus, DropshipListingConfigReadOnlyReason | null> = {
    connected: null,
    needs_reauth: null,
    refresh_failed: null,
    grace_period: "store_disconnecting",
    paused: "store_paused",
    disconnected: "store_disconnected",
  };
  const combinations = dropshipVendorStatusEnum.flatMap((vendorStatus) =>
    dropshipStoreConnectionStatusEnum.map((storeStatus) => ({ vendorStatus, storeStatus })));

  it("covers every vendor and store status", () => {
    expect(combinations).toHaveLength(dropshipVendorStatusEnum.length * dropshipStoreConnectionStatusEnum.length);
    expect(Object.keys(VENDOR_READ_ONLY).sort()).toEqual([...dropshipVendorStatusEnum].sort());
    expect(Object.keys(STORE_READ_ONLY_REASON).sort()).toEqual([...dropshipStoreConnectionStatusEnum].sort());
  });

  it.each(combinations)("decides a $vendorStatus vendor on a $storeStatus store", ({ vendorStatus, storeStatus }) => {
    const storeReason = STORE_READ_ONLY_REASON[storeStatus];
    const expected = VENDOR_READ_ONLY[vendorStatus]
      ? { canEdit: false, reason: "vendor_not_active" }
      : storeReason
        ? { canEdit: false, reason: storeReason }
        : { canEdit: true, reason: null };

    expect(decideDropshipListingConfigAccess(vendorStatus, storeStatus)).toEqual(expected);
  });

  it.each(["paused", "grace_period", "disconnected"] satisfies DropshipStoreConnectionStatus[])(
    "gives the vendor reason over a %s store's reason",
    (storeStatus) => {
      for (const vendorStatus of ["closed", "lapsed", "suspended"] as const) {
        expect(decideDropshipListingConfigAccess(vendorStatus, storeStatus)).toEqual({
          canEdit: false,
          reason: "vendor_not_active",
        });
      }
    },
  );
});

describe("dropshipListingConfigReadOnlyError", () => {
  const context = Object.freeze({ vendorId: 10, storeConnectionId: 22 });
  const EXPECTED: Record<DropshipListingConfigReadOnlyReason, { code: string; context: Record<string, unknown> }> = {
    vendor_not_active: {
      code: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
      context: { vendorId: 10, storeConnectionId: 22, retryable: false },
    },
    store_paused: {
      code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
      context: { vendorId: 10, storeConnectionId: 22, status: "paused", retryable: false },
    },
    store_disconnecting: {
      code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING",
      context: { vendorId: 10, storeConnectionId: 22, status: "grace_period", retryable: false },
    },
    store_disconnected: {
      code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED",
      context: { vendorId: 10, storeConnectionId: 22, status: "disconnected", retryable: false },
    },
  };

  it.each(Object.entries(EXPECTED) as Array<[DropshipListingConfigReadOnlyReason, typeof EXPECTED[DropshipListingConfigReadOnlyReason]]>)(
    "builds the %s error",
    (reason, expected) => {
      const error = dropshipListingConfigReadOnlyError(reason, context);

      expect(error).toBeInstanceOf(DropshipError);
      expect(error.code).toBe(expected.code);
      expect(error.context).toEqual(expected.context);
      expect(error.message.length).toBeGreaterThan(0);
    },
  );

  it("gives a store reason the same error a vendor setup write on that store gets", () => {
    for (const status of dropshipStoreConnectionStatusEnum) {
      const access = decideDropshipListingConfigAccess("active", status);
      if (access.canEdit) continue;
      const refused = captureError(() => assertStoreStatusAllowsListingConfigWrite(
        { vendorId: 10, storeConnectionId: 22, status },
        DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
      ));
      const readOnly = dropshipListingConfigReadOnlyError(access.reason, context);

      expect({ code: readOnly.code, context: readOnly.context, message: readOnly.message }).toEqual({
        code: refused.code,
        context: refused.context,
        message: refused.message,
      });
    }
  });
});

describe("assertStoreStatusAllowsListingConfigWrite", () => {
  const REFUSAL_CODE: Record<DropshipStoreConnectionStatus, string> = {
    connected: "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE",
    needs_reauth: "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE",
    refresh_failed: "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE",
    grace_period: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING",
    paused: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
    disconnected: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED",
  };
  const LISTS: Array<{ name: string; list: readonly DropshipStoreConnectionStatus[]; allowed: DropshipStoreConnectionStatus[] }> = [
    {
      name: "staff",
      list: DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES,
      allowed: ["connected", "needs_reauth", "refresh_failed", "grace_period", "paused"],
    },
    {
      name: "vendor setup",
      list: DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
      allowed: ["connected", "needs_reauth", "refresh_failed"],
    },
    {
      name: "system setup",
      list: DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES,
      allowed: ["connected", "refresh_failed"],
    },
    { name: "empty", list: [], allowed: [] },
  ];

  it.each(LISTS)("pins the $name statuses", ({ list, allowed }) => {
    expect([...list].sort()).toEqual([...allowed].sort());
  });

  it.each(LISTS)("allows exactly the $name statuses and names every refusal by the store's status", ({ list, allowed }) => {
    for (const status of dropshipStoreConnectionStatusEnum) {
      const store = Object.freeze({ vendorId: 10, storeConnectionId: 22, status });
      if (allowed.includes(status)) {
        expect(() => assertStoreStatusAllowsListingConfigWrite(store, list)).not.toThrow();
        continue;
      }
      const error = captureError(() => assertStoreStatusAllowsListingConfigWrite(store, list));
      expect(error.code).toBe(REFUSAL_CODE[status]);
      expect(error.context).toEqual({ vendorId: 10, storeConnectionId: 22, status, retryable: false });
    }
  });
});

describe("dropshipListingConfigFault", () => {
  it.each([
    // Broken invariants, by suffix, from any module.
    { code: "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED", fault: true },
    { code: "DROPSHIP_EBAY_LISTING_SETUP_INVARIANT_FAILED", fault: true },
    { code: "DROPSHIP_WALLET_PENDING_BALANCE_INVARIANT_FAILED", fault: true },
    // The named faults.
    { code: "DROPSHIP_LISTING_CONFIG_REQUEST_ACTOR_REQUIRED", fault: true },
    { code: "DROPSHIP_LISTING_CONFIG_REVISION_INVALID", fault: true },
    { code: "DROPSHIP_LISTING_CONFIG_REQUIRED", fault: true },
    // Refusals by the rules.
    { code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", fault: false },
    { code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT", fault: false },
    { code: "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED", fault: false },
    { code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED", fault: false },
    { code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING", fault: false },
    { code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED", fault: false },
    { code: "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE", fault: false },
    { code: "DROPSHIP_STORE_CONNECTION_NOT_FOUND", fault: false },
    { code: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID", fault: false },
    { code: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", fault: false },
    // Look-alikes: another _REQUIRED or _INVALID code, the suffix not at the end, a near miss.
    { code: "DROPSHIP_ENTITLEMENT_REQUIRED", fault: false },
    { code: "DROPSHIP_EBAY_LISTING_SETUP_STORE_REQUIRED", fault: false },
    { code: "DROPSHIP_EBAY_FULFILLMENT_RATE_TABLE_REQUIRED", fault: false },
    { code: "DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID", fault: false },
    { code: "DROPSHIP_LISTING_CONFIG_REQUIRED_FIELDS_MISSING", fault: false },
    { code: "DROPSHIP_LISTING_CONFIG_REQUIRED ", fault: false },
    { code: "DROPSHIP_LISTING_CONFIG_INVARIANT_FAILED_RETRY", fault: false },
    { code: "DROPSHIP_LISTING_CONFIG_INVARIANTFAILED", fault: false },
    { code: "INVARIANT_FAILED", fault: false },
    { code: "dropship_listing_config_revision_invariant_failed", fault: false },
    { code: "", fault: false },
  ])("calls $code a fault: $fault", ({ code, fault }) => {
    expect(dropshipListingConfigFault(code)).toBe(fault);
  });
});

describe("listingConfigContent", () => {
  it("keeps only the content fields and copies the arrays", () => {
    const record = deepFreeze(makeConfigRecord({
      revision: 7,
      marketplaceConfig: { marketplaceId: "EBAY_US" },
      requiredConfigKeys: ["marketplaceId"],
      requiredProductFields: ["sku"],
    }));

    const content = listingConfigContent(record);

    expect(content).toEqual({
      listingMode: DROPSHIP_DEFAULT_LISTING_MODE,
      inventoryMode: DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
      priceMode: DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
      marketplaceConfig: { marketplaceId: "EBAY_US" },
      requiredConfigKeys: ["marketplaceId"],
      requiredProductFields: ["sku"],
      isActive: true,
    });
    expect(content.requiredConfigKeys).not.toBe(record.requiredConfigKeys);
    expect(content.requiredProductFields).not.toBe(record.requiredProductFields);
  });
});

describe("listingConfigContentEquals", () => {
  const base = (): DropshipStoreListingConfigContent => ({
    listingMode: "live",
    inventoryMode: "managed_quantity_sync",
    priceMode: "vendor_defined",
    marketplaceConfig: {
      marketplaceId: "EBAY_US",
      merchantLocationKey: "dropship-10-22",
      businessPolicies: { fulfillmentPolicyId: "f-1", paymentPolicyId: "p-1", returnPolicyId: "r-1" },
    },
    requiredConfigKeys: ["marketplaceId", "merchantLocationKey"],
    requiredProductFields: ["sku", "title"],
    isActive: true,
  });

  it("treats a stored record and an input with the same content as equal, ignoring identity, revision and timestamps", () => {
    const record = makeConfigRecord({ ...base(), id: 9, revision: 12, updatedAt: now });

    expect(listingConfigContentEquals(record, base())).toBe(true);
    expect(listingConfigContentEquals(base(), record)).toBe(true);
  });

  it("ignores key order at every level of the marketplace config", () => {
    const reordered: DropshipStoreListingConfigContent = {
      isActive: true,
      requiredProductFields: ["sku", "title"],
      requiredConfigKeys: ["marketplaceId", "merchantLocationKey"],
      marketplaceConfig: {
        businessPolicies: { returnPolicyId: "r-1", paymentPolicyId: "p-1", fulfillmentPolicyId: "f-1" },
        merchantLocationKey: "dropship-10-22",
        marketplaceId: "EBAY_US",
      },
      priceMode: "vendor_defined",
      inventoryMode: "managed_quantity_sync",
      listingMode: "live",
    };

    expect(listingConfigContentEquals(base(), reordered)).toBe(true);
  });

  it.each([
    { label: "listing mode", change: (c: DropshipStoreListingConfigContent) => ({ ...c, listingMode: "draft_first" as const }) },
    { label: "inventory mode", change: (c: DropshipStoreListingConfigContent) => ({ ...c, inventoryMode: "manual_quantity" as const }) },
    { label: "price mode", change: (c: DropshipStoreListingConfigContent) => ({ ...c, priceMode: "disabled" as const }) },
    { label: "active flag", change: (c: DropshipStoreListingConfigContent) => ({ ...c, isActive: false }) },
    { label: "an added required key", change: (c: DropshipStoreListingConfigContent) => ({ ...c, requiredConfigKeys: [...c.requiredConfigKeys, "categoryId"] }) },
    { label: "required key order", change: (c: DropshipStoreListingConfigContent) => ({ ...c, requiredConfigKeys: [...c.requiredConfigKeys].reverse() }) },
    { label: "a removed required product field", change: (c: DropshipStoreListingConfigContent) => ({ ...c, requiredProductFields: ["sku"] }) },
    { label: "a marketplace value", change: (c: DropshipStoreListingConfigContent) => ({ ...c, marketplaceConfig: { ...c.marketplaceConfig, merchantLocationKey: "other" } }) },
    { label: "an added marketplace key", change: (c: DropshipStoreListingConfigContent) => ({ ...c, marketplaceConfig: { ...c.marketplaceConfig, categoryId: "261" } }) },
    { label: "a marketplace key set to null", change: (c: DropshipStoreListingConfigContent) => ({ ...c, marketplaceConfig: { ...c.marketplaceConfig, merchantLocationKey: null } }) },
    {
      label: "a nested policy id",
      change: (c: DropshipStoreListingConfigContent) => ({
        ...c,
        marketplaceConfig: { ...c.marketplaceConfig, businessPolicies: { fulfillmentPolicyId: "f-2", paymentPolicyId: "p-1", returnPolicyId: "r-1" } },
      }),
    },
    {
      label: "a number where a string was",
      change: (c: DropshipStoreListingConfigContent) => ({ ...c, marketplaceConfig: { ...c.marketplaceConfig, marketplaceId: 1 } }),
    },
  ])("sees a different $label", ({ change }) => {
    const changed = change(base());

    expect(listingConfigContentEquals(base(), changed)).toBe(false);
    expect(listingConfigContentEquals(changed, base())).toBe(false);
  });

  describe("compared as the jsonb column stores the marketplace config", () => {
    const withMarketplace = (marketplaceConfig: Record<string, unknown>): DropshipStoreListingConfigContent => ({
      ...base(),
      marketplaceConfig,
    });

    it("treats -0 and 0 as the same value at any depth", () => {
      const zero = withMarketplace({ handlingDays: 0, businessPolicies: { overrides: [{ weightGrams: 0 }] } });
      const negativeZero = withMarketplace({ handlingDays: -0, businessPolicies: { overrides: [{ weightGrams: -0 }] } });

      expect(listingConfigContentEquals(zero, negativeZero)).toBe(true);
      expect(listingConfigContentEquals(negativeZero, zero)).toBe(true);
    });

    it.each([
      { label: "NaN", value: Number.NaN },
      { label: "Infinity", value: Number.POSITIVE_INFINITY },
      { label: "-Infinity", value: Number.NEGATIVE_INFINITY },
    ])("treats $label as the null jsonb stores for it, without throwing", ({ value }) => {
      const nonFinite = withMarketplace({ ratio: value, nested: { ratio: value }, list: [value] });
      const stored = withMarketplace({ ratio: null, nested: { ratio: null }, list: [null] });

      expect(listingConfigContentEquals(nonFinite, stored)).toBe(true);
      expect(listingConfigContentEquals(stored, nonFinite)).toBe(true);
      expect(listingConfigContentEquals(nonFinite, withMarketplace({ ratio: 0, nested: { ratio: 0 }, list: [0] })))
        .toBe(false);
    });

    it("treats a member set to undefined as absent", () => {
      expect(listingConfigContentEquals(
        withMarketplace({ marketplaceId: "EBAY_US", categoryId: undefined }),
        withMarketplace({ marketplaceId: "EBAY_US" }),
      )).toBe(true);
    });

    it("still sees a change between two finite numbers", () => {
      expect(listingConfigContentEquals(withMarketplace({ weightGrams: 12.5 }), withMarketplace({ weightGrams: 12.25 })))
        .toBe(false);
      expect(listingConfigContentEquals(withMarketplace({ handlingDays: -0 }), withMarketplace({ handlingDays: 1 })))
        .toBe(false);
    });

    it("does not mutate either side", () => {
      const left = deepFreeze(withMarketplace({ handlingDays: -0, ratio: Number.NaN }));
      const right = deepFreeze(withMarketplace({ handlingDays: 0, ratio: null }));

      expect(listingConfigContentEquals(left, right)).toBe(true);
      expect(Object.is(left.marketplaceConfig.handlingDays, -0)).toBe(true);
      expect(Number.isNaN(left.marketplaceConfig.ratio)).toBe(true);
    });
  });
});

describe("normalizeListingConfigInput", () => {
  const input = (marketplaceConfig: Record<string, unknown>): ReplaceDropshipStoreListingConfigInput => ({
    listingMode: "live",
    inventoryMode: "managed_quantity_sync",
    priceMode: "vendor_defined",
    marketplaceConfig,
    requiredConfigKeys: [" marketplaceId ", "marketplaceId", "merchantLocationKey"],
    requiredProductFields: ["sku", "title", "sku"],
    isActive: true,
  });

  it("stores the marketplace config as jsonb reads it back: -0 as 0, non-finite numbers as null, undefined members dropped", () => {
    const normalized = normalizeListingConfigInput(input({
      handlingDays: -0,
      ratio: Number.NaN,
      maxWeightGrams: Number.POSITIVE_INFINITY,
      minWeightGrams: Number.NEGATIVE_INFINITY,
      categoryId: undefined,
      weightGrams: 12.5,
      marketplaceId: "EBAY_US",
      isGlobal: false,
      businessPolicies: { fulfillmentPolicyId: "f-1", overrides: [{ weightGrams: -0 }, undefined] },
    }));

    expect(normalized.marketplaceConfig).toStrictEqual({
      handlingDays: 0,
      ratio: null,
      maxWeightGrams: null,
      minWeightGrams: null,
      weightGrams: 12.5,
      marketplaceId: "EBAY_US",
      isGlobal: false,
      businessPolicies: { fulfillmentPolicyId: "f-1", overrides: [{ weightGrams: 0 }, null] },
    });
    expect(Object.is(normalized.marketplaceConfig.handlingDays, 0)).toBe(true);
    expect(normalized.requiredConfigKeys).toEqual(["marketplaceId", "merchantLocationKey"]);
    expect(normalized.requiredProductFields).toEqual(["sku", "title"]);
  });

  it("returns a new marketplace config and leaves the input untouched", () => {
    const original = deepFreeze(input({ handlingDays: -0, nested: { ratio: Number.NaN } }));

    const normalized = normalizeListingConfigInput(original);

    expect(normalized.marketplaceConfig).not.toBe(original.marketplaceConfig);
    expect(Object.is(original.marketplaceConfig.handlingDays, -0)).toBe(true);
    expect(Number.isNaN((original.marketplaceConfig.nested as { ratio: number }).ratio)).toBe(true);
    expect(original.requiredConfigKeys).toEqual([" marketplaceId ", "marketplaceId", "merchantLocationKey"]);
  });

  it("changes nothing in a marketplace config that already reads back from jsonb the same", () => {
    const clean = input({ marketplaceId: "EBAY_US", businessPolicies: { fulfillmentPolicyId: "f-1" }, handlingDays: 2 });

    expect(normalizeListingConfigInput(clean).marketplaceConfig).toStrictEqual(clean.marketplaceConfig);
  });
});

describe("listingConfigChangedFields", () => {
  const base = (marketplaceConfig: Record<string, unknown> = {}): DropshipStoreListingConfigContent => ({
    listingMode: "live",
    inventoryMode: "managed_quantity_sync",
    priceMode: "vendor_defined",
    marketplaceConfig,
    requiredConfigKeys: ["marketplaceId"],
    requiredProductFields: ["sku"],
    isActive: true,
  });

  it("is empty when nothing changed, whatever the key order or identity fields", () => {
    const before = makeConfigRecord({
      ...base({ marketplaceId: "EBAY_US", businessPolicies: { fulfillmentPolicyId: "f-1", returnPolicyId: "r-1" } }),
      revision: 3,
    });
    const after = makeConfigRecord({
      ...base({ businessPolicies: { returnPolicyId: "r-1", fulfillmentPolicyId: "f-1" }, marketplaceId: "EBAY_US" }),
      revision: 4,
      updatedAt: now,
    });

    expect(listingConfigChangedFields(before, after)).toEqual([]);
  });

  it("names each changed top-level field, sorted", () => {
    const after: DropshipStoreListingConfigContent = {
      listingMode: "draft_first",
      inventoryMode: "manual_quantity",
      priceMode: "disabled",
      marketplaceConfig: {},
      requiredConfigKeys: ["marketplaceId", "merchantLocationKey"],
      requiredProductFields: [],
      isActive: false,
    };

    expect(listingConfigChangedFields(base(), after)).toEqual([
      "inventoryMode",
      "isActive",
      "listingMode",
      "priceMode",
      "requiredConfigKeys",
      "requiredProductFields",
    ]);
  });

  it("names changed, added and removed marketplace keys as paths", () => {
    const before = base({ marketplaceId: "EBAY_US", merchantLocationKey: "loc-1", untouched: "same" });
    const after = base({ merchantLocationKey: "loc-2", categoryId: "261", untouched: "same" });

    expect(listingConfigChangedFields(before, after)).toEqual([
      "marketplaceConfig.categoryId",
      "marketplaceConfig.marketplaceId",
      "marketplaceConfig.merchantLocationKey",
    ]);
  });

  it("goes one level into businessPolicies, naming changed, added and removed policy ids", () => {
    const before = base({ businessPolicies: { fulfillmentPolicyId: "f-1", returnPolicyId: "r-1", unchanged: "u" } });
    const after = base({ businessPolicies: { fulfillmentPolicyId: "f-2", paymentPolicyId: "p-1", unchanged: "u" } });

    expect(listingConfigChangedFields(before, after)).toEqual([
      "marketplaceConfig.businessPolicies.fulfillmentPolicyId",
      "marketplaceConfig.businessPolicies.paymentPolicyId",
      "marketplaceConfig.businessPolicies.returnPolicyId",
    ]);
  });

  it("goes one level into businessPolicyNames and storeShelfDefault", () => {
    const before = base({
      businessPolicyNames: { fulfillmentPolicyId: "Free shipping", returnPolicyId: "30 days" },
      storeShelfDefault: { ids: ["100"], names: ["Cards"] },
    });
    const after = base({
      businessPolicyNames: { fulfillmentPolicyId: "Flat rate", returnPolicyId: "30 days" },
      storeShelfDefault: { ids: ["100", "200"], names: ["Cards", "Cards > Sleeves"] },
    });

    expect(listingConfigChangedFields(before, after)).toEqual([
      "marketplaceConfig.businessPolicyNames.fulfillmentPolicyId",
      "marketplaceConfig.storeShelfDefault.ids",
      "marketplaceConfig.storeShelfDefault.names",
    ]);
  });

  it("names a nested key whole when it is added, removed or not an object on one side", () => {
    const before = base({
      businessPolicies: { fulfillmentPolicyId: "f-1" },
      storeShelfDefault: null,
      businessPolicyNames: ["not", "a", "record"],
    });
    const after = base({
      storeShelfDefault: { ids: ["100"], names: ["Cards"] },
      businessPolicyNames: { fulfillmentPolicyId: "Flat rate" },
    });

    expect(listingConfigChangedFields(before, after)).toEqual([
      "marketplaceConfig.businessPolicies",
      "marketplaceConfig.businessPolicyNames",
      "marketplaceConfig.storeShelfDefault",
    ]);
  });

  it("names other object keys whole and goes no deeper than one level", () => {
    const before = base({
      itemSpecificDefaults: { Brand: "Card Shellz", Material: "PP" },
      businessPolicies: { overrides: { size: { fulfillmentPolicyId: "f-1" } } },
    });
    const after = base({
      itemSpecificDefaults: { Brand: "Card Shellz", Material: "PET" },
      businessPolicies: { overrides: { size: { fulfillmentPolicyId: "f-2" } } },
    });

    expect(listingConfigChangedFields(before, after)).toEqual([
      "marketplaceConfig.businessPolicies.overrides",
      "marketplaceConfig.itemSpecificDefaults",
    ]);
  });

  it("sorts top-level and marketplace paths together and does not mutate its inputs", () => {
    const before = deepFreeze(base({ merchantLocationKey: "loc-1", businessPolicies: { returnPolicyId: "r-1" } }));
    const after = deepFreeze({
      ...base({ merchantLocationKey: "loc-2", businessPolicies: { returnPolicyId: "r-2" } }),
      priceMode: "disabled" as const,
      isActive: false,
    });
    const snapshot = structuredClone({ before, after });

    const changed = listingConfigChangedFields(before, after);

    expect(changed).toEqual([
      "isActive",
      "marketplaceConfig.businessPolicies.returnPolicyId",
      "marketplaceConfig.merchantLocationKey",
      "priceMode",
    ]);
    expect(listingConfigChangedFields(before, after)).toEqual(changed);
    expect({ before, after }).toEqual(snapshot);
  });
});

/** A valid replace body whose content differs from the default config. */
function replaceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listingMode: "live",
    inventoryMode: "manual_quantity",
    priceMode: "vendor_defined",
    marketplaceConfig: { fulfillmentPolicyId: "fulfillment-1" },
    requiredConfigKeys: ["fulfillmentPolicyId"],
    requiredProductFields: ["sku"],
    isActive: true,
    expectedRevision: 1,
    ...overrides,
  };
}

/** A later save, made at revision 2, whose content differs from replaceBody(). */
function movedOnBody(): Record<string, unknown> {
  return replaceBody({ marketplaceConfig: { fulfillmentPolicyId: "fulfillment-2" }, expectedRevision: 2 });
}

function replaceBodyWithout(key: string): Record<string, unknown> {
  const body = replaceBody();
  delete body[key];
  return body;
}

/** A replace body that says exactly what the default Shopify config already says. */
function unchangedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listingMode: DROPSHIP_DEFAULT_LISTING_MODE,
    inventoryMode: DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
    priceMode: DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
    marketplaceConfig: {},
    requiredConfigKeys: [],
    requiredProductFields: [],
    isActive: true,
    expectedRevision: 1,
    ...overrides,
  };
}

/**
 * The one INFO line a refused write logs, for a vendor's Shopify write on
 * store 22 at revision 1 with no request key unless overridden.
 */
function refusalLog(overrides: { errorCode: string } & Record<string, unknown>): LoggedEvent {
  return {
    level: "info",
    code: "DROPSHIP_LISTING_CONFIG_WRITE_REFUSED",
    message: expect.any(String),
    context: {
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      actorType: "vendor",
      expectedRevision: 1,
      requestKey: null,
      operation: "listing_config_replaced",
      outcome: "refused",
      currentRevision: null,
      ...overrides,
    },
  };
}

/**
 * The one ERROR line a write that failed a check that should always hold
 * logs, with the same correlation fields and defaults as refusalLog.
 */
function failureLog(overrides: { errorCode: string } & Record<string, unknown>): LoggedEvent {
  return {
    level: "error",
    code: "DROPSHIP_LISTING_CONFIG_WRITE_FAILED",
    message: expect.any(String),
    context: {
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      actorType: "vendor",
      expectedRevision: 1,
      requestKey: null,
      operation: "listing_config_replaced",
      outcome: "failed",
      currentRevision: null,
      ...overrides,
    },
  };
}

/**
 * One error of each code dropshipListingConfigFault calls a fault, with the
 * context the code that throws it gives it (dropship-listing-config.repository.ts,
 * dropship-ebay-listing-setup-service.ts). Built fresh per test.
 */
const LISTING_CONFIG_FAULTS: ReadonlyArray<{ code: string; error: () => DropshipError }> = [
  {
    code: "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED",
    error: () => new DropshipError(
      "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED",
      "The listing config revision did not advance by exactly one.",
      { storeConnectionId: 22, revisionBefore: 1, revisionAfter: 3, retryable: false },
    ),
  },
  {
    code: "DROPSHIP_LISTING_CONFIG_REQUEST_ACTOR_REQUIRED",
    error: () => new DropshipError(
      "DROPSHIP_LISTING_CONFIG_REQUEST_ACTOR_REQUIRED",
      "A keyed listing settings request needs the id of who made it.",
      { storeConnectionId: 22, actorType: "system", retryable: false },
    ),
  },
  {
    code: "DROPSHIP_LISTING_CONFIG_REVISION_INVALID",
    error: () => new DropshipError(
      "DROPSHIP_LISTING_CONFIG_REVISION_INVALID",
      "The stored listing config has no valid revision.",
      { storeConnectionId: 22, revision: null, retryable: false },
    ),
  },
  {
    code: "DROPSHIP_LISTING_CONFIG_REQUIRED",
    error: () => new DropshipError(
      "DROPSHIP_LISTING_CONFIG_REQUIRED",
      "The store's listing config could not be loaded.",
      { storeConnectionId: 22, retryable: false },
    ),
  },
];

function makeConfigRecord(overrides: Partial<DropshipStoreListingConfigRecord> = {}): DropshipStoreListingConfigRecord {
  return {
    id: 1,
    storeConnectionId: 22,
    platform: "shopify",
    listingMode: DROPSHIP_DEFAULT_LISTING_MODE,
    inventoryMode: DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
    priceMode: DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
    marketplaceConfig: {},
    requiredConfigKeys: [],
    requiredProductFields: [],
    isActive: true,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function captureError(run: () => void): DropshipError {
  try {
    run();
  } catch (error) {
    if (error instanceof DropshipError) return error;
    throw error;
  }
  throw new Error("Expected a DropshipError to be thrown.");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

class FakeVendorProvisioningService {
  vendor = makeVendor();
  /** What provisionForMember throws, e.g. an entitlement refusal or a dropped database connection. */
  failWith: Error | null = null;
  readonly provisionCalls: string[] = [];

  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    this.provisionCalls.push(memberId);
    if (this.failWith) throw this.failWith;
    return {
      vendor: { ...this.vendor, memberId },
      created: false,
      changedFields: [],
    };
  }
}

interface FakeLedgerEntry extends DropshipListingConfigKeyedRequestRecord {
  vendorId: number;
  idempotencyKey: string;
}

/**
 * The repository's contract without a database: store lookups scoped to the
 * vendor, a read-only find, keyed-request replay before any other check, the
 * store-status re-check, the revision compare-and-set, "unchanged" when the
 * content already matches, and a ledger row for every keyed write.
 */
class FakeListingConfigRepository implements DropshipListingConfigRepository {
  storeConnection: DropshipListingConfigStoreConnectionContext = {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "shopify",
    status: "connected",
    setupStatus: "pending",
  };
  config: DropshipStoreListingConfigRecord | null = null;
  readonly ledger = new Map<string, FakeLedgerEntry>();
  readonly storeLookups: Array<{ vendorId?: number; storeConnectionId: number }> = [];
  readonly ensureInputs: EnsureDropshipStoreListingConfigRepositoryInput[] = [];
  readonly findConfigInputs: Array<{ storeConnectionId: number }> = [];
  readonly replaceInputs: ReplaceDropshipStoreListingConfigRepositoryInput[] = [];
  /** Runs when replaceConfig is entered, e.g. to change the store's status after the service read it. */
  beforeReplace: (() => void) | null = null;
  /** A failure replaceConfig throws once entered: an unexpected error, or a DropshipError for a broken invariant. */
  failWith: Error | null = null;
  /** A failure both store lookups throw, e.g. a dropped database connection. */
  storeLookupFailure: Error | null = null;

  get lastEnsureInput(): EnsureDropshipStoreListingConfigRepositoryInput | null {
    return this.ensureInputs[this.ensureInputs.length - 1] ?? null;
  }

  async loadStoreConnectionContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipListingConfigStoreConnectionContext | null> {
    this.storeLookups.push(input);
    if (this.storeLookupFailure) throw this.storeLookupFailure;
    return this.storeConnection.vendorId === input.vendorId
      && this.storeConnection.storeConnectionId === input.storeConnectionId
      ? this.storeConnection
      : null;
  }

  async loadStoreConnectionContextById(input: {
    storeConnectionId: number;
  }): Promise<DropshipListingConfigStoreConnectionContext | null> {
    this.storeLookups.push(input);
    if (this.storeLookupFailure) throw this.storeLookupFailure;
    return this.storeConnection.storeConnectionId === input.storeConnectionId ? this.storeConnection : null;
  }

  async ensureDefaultConfig(
    input: EnsureDropshipStoreListingConfigRepositoryInput,
  ): Promise<DropshipStoreListingConfigRecord> {
    this.ensureInputs.push(input);
    this.config ??= {
      id: 1,
      storeConnectionId: input.storeConnectionId,
      platform: input.platform,
      listingMode: DROPSHIP_DEFAULT_LISTING_MODE,
      inventoryMode: DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
      priceMode: DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
      marketplaceConfig: {},
      requiredConfigKeys: [],
      requiredProductFields: [],
      isActive: true,
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
    };
    return this.config;
  }

  async findConfig(input: { storeConnectionId: number }): Promise<DropshipStoreListingConfigRecord | null> {
    this.findConfigInputs.push(input);
    return this.config;
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

  async replaceConfig(
    input: ReplaceDropshipStoreListingConfigRepositoryInput,
  ): Promise<ReplaceDropshipStoreListingConfigRepositoryResult> {
    this.replaceInputs.push(input);
    this.beforeReplace?.();
    if (this.failWith) throw this.failWith;
    if (input.request) {
      const prior = this.ledger.get(ledgerKey(input.vendorId, input.request.idempotencyKey));
      if (prior) {
        if (prior.requestHash !== input.request.requestHash
          || prior.storeConnectionId !== input.storeConnectionId
          || prior.operation !== input.request.operation) {
          throw new DropshipError(
            "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
            "This request key was already used for a different listing settings change.",
            { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, retryable: false },
          );
        }
        if (!this.config) throw revisionConflict(input, null);
        // A replay names the revisions the ledger recorded; the config is the current one,
        // which is newer when another write followed.
        return {
          config: this.config,
          outcome: "replayed",
          revisionBefore: prior.revisionBefore,
          revisionAfter: prior.revisionAfter,
        };
      }
    }

    assertStoreStatusAllowsListingConfigWrite({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      status: this.storeConnection.status,
    }, input.allowedStoreStatuses);

    const current = this.config;
    if (!current || current.revision !== input.expectedRevision) {
      throw revisionConflict(input, current?.revision ?? null);
    }
    if (listingConfigContentEquals(current, input.config)) {
      this.record(input, current.revision, current.revision, "unchanged");
      return { config: current, outcome: "unchanged", revisionBefore: current.revision, revisionAfter: current.revision };
    }

    this.config = {
      ...current,
      ...listingConfigContent(input.config),
      platform: input.platform,
      revision: current.revision + 1,
      updatedAt: input.now,
    };
    this.record(input, current.revision, this.config.revision, "changed");
    return { config: this.config, outcome: "changed", revisionBefore: current.revision, revisionAfter: this.config.revision };
  }

  private record(
    input: ReplaceDropshipStoreListingConfigRepositoryInput,
    revisionBefore: number,
    revisionAfter: number,
    outcome: "changed" | "unchanged",
  ): void {
    if (!input.request) return;
    this.ledger.set(ledgerKey(input.vendorId, input.request.idempotencyKey), {
      vendorId: input.vendorId,
      idempotencyKey: input.request.idempotencyKey,
      storeConnectionId: input.storeConnectionId,
      operation: input.request.operation,
      requestHash: input.request.requestHash,
      revisionBefore,
      revisionAfter,
      outcome,
      createdAt: input.now,
    });
  }
}

function ledgerKey(vendorId: number, idempotencyKey: string): string {
  return `${vendorId}:${idempotencyKey}`;
}

function revisionConflict(
  input: ReplaceDropshipStoreListingConfigRepositoryInput,
  currentRevision: number | null,
): DropshipError {
  return new DropshipError(
    "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
    "These store settings changed after they were loaded. Load the latest settings and save again.",
    {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      expectedRevision: input.expectedRevision,
      currentRevision,
      retryable: false,
    },
  );
}

function makeVendor(overrides: Partial<DropshipProvisionedVendorProfile> = {}): DropshipProvisionedVendorProfile {
  return {
    vendorId: 10,
    memberId: "member-1",
    currentSubscriptionId: "sub-1",
    currentPlanId: "ops-plan",
    businessName: "Vendor LLC",
    contactName: "Vendor User",
    email: "vendor@cardshellz.com",
    phone: null,
    status: "active",
    entitlementStatus: "active",
    entitlementCheckedAt: now,
    membershipGraceEndsAt: null,
    includedStoreConnections: 1,
    standingReason: null,
    pausedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
