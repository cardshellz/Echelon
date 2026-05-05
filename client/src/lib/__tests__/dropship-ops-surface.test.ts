import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allDropshipOpsOrderIntakeStatuses,
  allDropshipRmaStatuses,
  buildQueryUrl,
  buildListingPreviewRequest,
  buildListingPushRequest,
  buildAutoReloadConfigInput,
  buildStripeFundingSetupSessionInput,
  buildStripeWalletFundingSessionInput,
  buildVariantSelectionReplacement,
  buildAdminCatalogExposurePreviewUrl,
  buildAdminDogfoodReadinessUrl,
  buildAdminOmsChannelConfigUrl,
  buildAdminOmsChannelConfigureInput,
  buildAdminListingPushJobsUrl,
  buildAdminNotificationEventsUrl,
  buildAdminOrderIntakeUrl,
  buildAdminOrderOpsActionInput,
  buildAdminWalletConfirmedUsdcCreditInput,
  buildAdminWalletManualCreditInput,
  buildAdminReturnCreateInput,
  buildAdminReturnInspectionInput,
  buildAdminReturnStatusUpdateInput,
  buildAdminReturnsUrl,
  buildAdminShippingConfigUrl,
  buildAdminStoreConnectionsUrl,
  buildAdminStoreWebhookRepairInput,
  buildAdminTrackingPushRetryInput,
  buildAdminTrackingPushesUrl,
  buildShippingBoxInput,
  buildShippingInsurancePolicyInput,
  buildShippingMarkupPolicyInput,
  buildShippingPackageProfileInput,
  buildShippingRateTableInput,
  buildShippingZoneRuleInput,
  buildStoreConnectionDisconnectInput,
  buildStoreOrderProcessingConfigInput,
  buildCatalogExposureRuleInput,
  buildDropshipNotificationsUrl,
  buildDropshipOrderAcceptInput,
  buildNotificationPreferenceUpdateInput,
  catalogExposureRecordToInput,
  catalogExposureRuleKey,
  buildStoreConnectionOAuthStartInput,
  buildStoreListingConfigInput,
  formatCents,
  formatStatus,
  fetchJson,
  listingPreviewPushableCount,
  normalizePortalReturnPath,
  normalizeShopifyShopDomainInput,
  parseDollarInputToCents,
  queryErrorMessage,
  riskSeverityTone,
  sectionStatusTone,
} from "../dropship-ops-surface";
import type {
  DropshipCatalogRow,
  DropshipListingPreviewResult,
  DropshipVendorSelectionRule,
} from "../dropship-ops-surface";

describe("dropship ops surface client helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("formats integer cents without floating point display drift", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-987)).toBe("-$9.87");
  });

  it("surfaces common API error body shapes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({ error: "Unauthorized dropship session." }),
    } as Response)));

    await expect(fetchJson("/api/dropship/orders")).rejects.toThrow("Unauthorized dropship session.");
  });

  it("falls back to explicit query error messages", () => {
    expect(queryErrorMessage(new Error("Store connection failed."), "Fallback")).toBe("Store connection failed.");
    expect(queryErrorMessage({ code: "UNKNOWN" }, "Fallback")).toBe("Fallback");
  });

  it("normalizes API status tokens for display", () => {
    expect(formatStatus("attention_required")).toBe("Attention Required");
    expect(formatStatus("payment_hold")).toBe("Payment Hold");
    expect(formatStatus(null)).toBe("Unknown");
  });

  it("exports launch status filters shared by admin and portal surfaces", () => {
    expect(allDropshipOpsOrderIntakeStatuses).toEqual([
      "received",
      "processing",
      "accepted",
      "rejected",
      "retrying",
      "failed",
      "payment_hold",
      "cancelled",
      "exception",
    ]);
    expect(allDropshipRmaStatuses).toEqual([
      "requested",
      "in_transit",
      "received",
      "inspecting",
      "approved",
      "rejected",
      "credited",
      "closed",
    ]);
  });

  it("keeps status and severity tones explicit", () => {
    expect(sectionStatusTone("ready")).toContain("emerald");
    expect(sectionStatusTone("attention_required")).toContain("amber");
    expect(sectionStatusTone("coming_soon")).toContain("zinc");
    expect(riskSeverityTone("error")).toContain("rose");
    expect(riskSeverityTone("warning")).toContain("amber");
    expect(riskSeverityTone("info")).toContain("zinc");
  });

  it("builds query URLs without empty filters", () => {
    expect(buildQueryUrl("/api/dropship/orders", {
      search: "",
      statuses: "accepted",
      page: 1,
      selectedOnly: false,
      vendorId: undefined,
    })).toBe("/api/dropship/orders?statuses=accepted&page=1&selectedOnly=false");
  });

  it("builds dropship order acceptance requests with a normalized idempotency key", () => {
    expect(buildDropshipOrderAcceptInput({
      idempotencyKey: " accept-order-1 ",
    })).toEqual({
      idempotencyKey: "accept-order-1",
    });
    expect(() => buildDropshipOrderAcceptInput({
      idempotencyKey: "short",
    })).toThrow("idempotencyKey must be between 8 and 200 characters.");
  });

  it("builds admin catalog exposure preview URLs with explicit filters", () => {
    expect(buildAdminCatalogExposurePreviewUrl({
      search: " pack ",
      exposedOnly: true,
      includeInactiveCatalog: false,
    })).toBe("/api/dropship/admin/catalog/preview?search=pack&exposedOnly=true&includeInactiveCatalog=false&page=1&limit=50");
  });

  it("builds admin dogfood readiness URLs with optional filters", () => {
    expect(buildAdminDogfoodReadinessUrl({
      search: " vendor ",
      status: "blocked",
      platform: "ebay",
    })).toBe("/api/dropship/admin/dogfood-readiness?search=vendor&status=blocked&platform=ebay&page=1&limit=50");
    expect(buildAdminDogfoodReadinessUrl({
      search: "",
      status: "all",
      platform: "all",
      page: 2,
      limit: 25,
    })).toBe("/api/dropship/admin/dogfood-readiness?page=2&limit=25");
  });

  it("builds admin OMS channel config requests", () => {
    expect(buildAdminOmsChannelConfigUrl()).toBe("/api/dropship/admin/oms-channel-config");
    expect(buildAdminOmsChannelConfigureInput({
      channelId: " 7 ",
      idempotencyKey: "oms-config-001",
    })).toEqual({
      channelId: 7,
      idempotencyKey: "oms-config-001",
    });
  });

  it("builds admin shipping config URLs with bounded list parameters", () => {
    expect(buildAdminShippingConfigUrl({
      search: "  sku-1 ",
      packageProfileLimit: 25,
      rateTableLimit: 10,
    })).toBe("/api/dropship/admin/shipping/config?search=sku-1&packageProfileLimit=25&rateTableLimit=10");
  });

  it("builds admin order intake URLs without forcing default status filters", () => {
    expect(buildAdminOrderIntakeUrl({
      search: " EXT-1 ",
      status: "default",
    })).toBe("/api/dropship/admin/order-intake?search=EXT-1&page=1&limit=50");
    expect(buildAdminOrderIntakeUrl({
      search: "",
      status: "failed",
      page: 2,
      limit: 25,
    })).toBe("/api/dropship/admin/order-intake?statuses=failed&page=2&limit=25");
    expect(buildAdminOrderIntakeUrl({
      search: "",
      status: "all",
    })).toBe("/api/dropship/admin/order-intake?statuses=received%2Cprocessing%2Caccepted%2Crejected%2Cretrying%2Cfailed%2Cpayment_hold%2Ccancelled%2Cexception&page=1&limit=50");
  });

  it("builds admin listing push job URLs with optional operational filters", () => {
    expect(buildAdminListingPushJobsUrl({
      search: " vendor ",
      status: "default",
      platform: "all",
    })).toBe("/api/dropship/admin/listing-push-jobs?search=vendor&page=1&limit=50");
    expect(buildAdminListingPushJobsUrl({
      search: "",
      status: "failed",
      platform: "ebay",
      page: 2,
      limit: 25,
    })).toBe("/api/dropship/admin/listing-push-jobs?statuses=failed&platform=ebay&page=2&limit=25");
    expect(buildAdminListingPushJobsUrl({
      search: "",
      status: "all",
      platform: "shopify",
    })).toBe("/api/dropship/admin/listing-push-jobs?statuses=queued%2Cprocessing%2Ccompleted%2Cfailed%2Ccancelled&platform=shopify&page=1&limit=50");
  });

  it("builds admin tracking push URLs with optional operational filters", () => {
    expect(buildAdminTrackingPushesUrl({
      search: " tracking ",
      status: "default",
      platform: "all",
    })).toBe("/api/dropship/admin/tracking-pushes?search=tracking&page=1&limit=50");
    expect(buildAdminTrackingPushesUrl({
      search: "",
      status: "failed",
      platform: "shopify",
      page: 2,
      limit: 25,
    })).toBe("/api/dropship/admin/tracking-pushes?statuses=failed&platform=shopify&page=2&limit=25");
    expect(buildAdminTrackingPushesUrl({
      search: "",
      status: "all",
      platform: "ebay",
    })).toBe("/api/dropship/admin/tracking-pushes?statuses=queued%2Cprocessing%2Csucceeded%2Cfailed&platform=ebay&page=1&limit=50");
  });

  it("builds admin notification event URLs with optional operational filters", () => {
    expect(buildAdminNotificationEventsUrl({
      search: " payment ",
      status: "default",
      channel: "all",
      critical: "all",
    })).toBe("/api/dropship/admin/notifications?search=payment&page=1&limit=50");
    expect(buildAdminNotificationEventsUrl({
      search: "",
      status: "failed",
      channel: "email",
      critical: "critical",
      page: 2,
      limit: 25,
    })).toBe("/api/dropship/admin/notifications?statuses=failed&channel=email&critical=true&page=2&limit=25");
    expect(buildAdminNotificationEventsUrl({
      search: "",
      status: "all",
      channel: "in_app",
      critical: "noncritical",
    })).toBe("/api/dropship/admin/notifications?statuses=pending%2Cdelivered%2Cfailed&channel=in_app&critical=false&page=1&limit=50");
  });

  it("builds vendor notification URLs with unread filtering", () => {
    expect(buildDropshipNotificationsUrl({
      view: "all",
    })).toBe("/api/dropship/notifications?page=1&limit=50");
    expect(buildDropshipNotificationsUrl({
      view: "unread",
      page: 2,
      limit: 25,
    })).toBe("/api/dropship/notifications?unreadOnly=true&page=2&limit=25");
  });

  it("builds notification preference updates with critical delivery guardrails", () => {
    expect(buildNotificationPreferenceUpdateInput({
      critical: false,
      emailEnabled: false,
      inAppEnabled: true,
    })).toEqual({
      critical: false,
      emailEnabled: false,
      inAppEnabled: true,
      smsEnabled: false,
      webhookEnabled: false,
    });
    expect(buildNotificationPreferenceUpdateInput({
      critical: true,
      emailEnabled: true,
      inAppEnabled: true,
    })).toMatchObject({
      critical: true,
      emailEnabled: true,
      inAppEnabled: true,
    });
    expect(() => buildNotificationPreferenceUpdateInput({
      critical: true,
      emailEnabled: false,
      inAppEnabled: true,
    })).toThrow("Critical notifications must keep email and in-app delivery enabled.");
  });

  it("builds admin return URLs with optional operational filters", () => {
    expect(buildAdminReturnsUrl({
      search: " rma ",
      status: "default",
    })).toBe("/api/dropship/admin/returns?search=rma&statuses=requested%2Cin_transit%2Creceived%2Cinspecting%2Capproved%2Crejected&page=1&limit=50");
    expect(buildAdminReturnsUrl({
      search: "",
      status: "inspecting",
      page: 2,
      limit: 25,
    })).toBe("/api/dropship/admin/returns?statuses=inspecting&page=2&limit=25");
    expect(buildAdminReturnsUrl({
      search: "",
      status: "all",
    })).toBe("/api/dropship/admin/returns?statuses=requested%2Cin_transit%2Creceived%2Cinspecting%2Capproved%2Crejected%2Ccredited%2Cclosed&page=1&limit=50");
  });

  it("builds admin return status update bodies with optional audit notes", () => {
    expect(buildAdminReturnStatusUpdateInput({
      idempotencyKey: "return-status-1",
      status: "received",
      notes: " package arrived ",
    })).toEqual({
      idempotencyKey: "return-status-1",
      status: "received",
      notes: "package arrived",
    });
    expect(buildAdminReturnStatusUpdateInput({
      idempotencyKey: "return-status-2",
      status: "closed",
      notes: " ",
    })).toEqual({
      idempotencyKey: "return-status-2",
      status: "closed",
    });
    expect(() => buildAdminReturnStatusUpdateInput({
      idempotencyKey: "short",
      status: "closed",
      notes: "",
    })).toThrow();
  });

  it("builds admin return create bodies with explicit RMA fields and item rows", () => {
    expect(buildAdminReturnCreateInput({
      idempotencyKey: "return-create-1",
      vendorId: " 12 ",
      rmaNumber: " RMA-1001 ",
      storeConnectionId: "34",
      intakeId: "",
      omsOrderId: "56",
      reasonCode: "damaged",
      faultCategory: "carrier",
      returnWindowDays: "30",
      labelSource: " marketplace ",
      returnTrackingNumber: " 1Z999 ",
      vendorNotes: " package lost ",
      items: [
        {
          productVariantId: "789",
          quantity: "2",
          status: "requested",
          requestedCreditAmount: "12.50",
        },
        {
          productVariantId: "",
          quantity: "1",
          status: "",
          requestedCreditAmount: "",
        },
      ],
    })).toEqual({
      idempotencyKey: "return-create-1",
      vendorId: 12,
      rmaNumber: "RMA-1001",
      storeConnectionId: 34,
      intakeId: null,
      omsOrderId: 56,
      reasonCode: "damaged",
      faultCategory: "carrier",
      returnWindowDays: 30,
      labelSource: "marketplace",
      returnTrackingNumber: "1Z999",
      vendorNotes: "package lost",
      items: [
        { productVariantId: 789, quantity: 2, status: "requested", requestedCreditCents: 1250 },
        { productVariantId: null, quantity: 1, status: "requested", requestedCreditCents: null },
      ],
    });

    expect(() => buildAdminReturnCreateInput({
      idempotencyKey: "return-create-2",
      vendorId: "12",
      rmaNumber: "",
      storeConnectionId: "",
      intakeId: "",
      omsOrderId: "",
      reasonCode: "",
      faultCategory: "none",
      returnWindowDays: "30",
      labelSource: "",
      returnTrackingNumber: "",
      vendorNotes: "",
      items: [],
    })).toThrow("rmaNumber is required.");
    expect(() => buildAdminReturnCreateInput({
      idempotencyKey: "return-create-3",
      vendorId: "12",
      rmaNumber: "RMA-1002",
      storeConnectionId: "",
      intakeId: "",
      omsOrderId: "",
      reasonCode: "",
      faultCategory: "none",
      returnWindowDays: "30",
      labelSource: "",
      returnTrackingNumber: "",
      vendorNotes: "",
      items: [{ productVariantId: "", quantity: "0", status: "requested", requestedCreditAmount: "" }],
    })).toThrow("items.0.quantity must be a positive integer.");
  });

  it("builds admin return inspection bodies from item credit and fee rows", () => {
    expect(buildAdminReturnInspectionInput({
      idempotencyKey: "return-inspection-1",
      outcome: "approved",
      faultCategory: "carrier",
      notes: " carrier loss approved ",
      items: [
        {
          rmaItemId: 10,
          status: "approved",
          finalCreditAmount: "12.50",
          feeAmount: "",
        },
        {
          rmaItemId: 11,
          status: "approved",
          finalCreditAmount: "$3.25",
          feeAmount: "1.00",
        },
      ],
    })).toEqual({
      idempotencyKey: "return-inspection-1",
      outcome: "approved",
      faultCategory: "carrier",
      creditCents: 1575,
      feeCents: 100,
      notes: "carrier loss approved",
      photos: [],
      items: [
        { rmaItemId: 10, status: "approved", finalCreditCents: 1250, feeCents: 0 },
        { rmaItemId: 11, status: "approved", finalCreditCents: 325, feeCents: 100 },
      ],
    });

    expect(() => buildAdminReturnInspectionInput({
      idempotencyKey: "short",
      outcome: "approved",
      faultCategory: "carrier",
      notes: "",
      items: [],
    })).toThrow("idempotencyKey must be between 8 and 200 characters.");
    expect(() => buildAdminReturnInspectionInput({
      idempotencyKey: "return-inspection-2",
      outcome: "approved",
      faultCategory: "carrier",
      notes: "",
      items: [{ rmaItemId: 12, status: "approved", finalCreditAmount: "1.001", feeAmount: "0" }],
    })).toThrow("items.0.finalCreditAmount must be a non-negative dollar amount with no more than two decimal places.");
  });

  it("builds admin shipping config mutation bodies", () => {
    expect(buildShippingBoxInput({
      code: " small mailer ",
      name: "Small Mailer",
      lengthMm: "230",
      widthMm: "160",
      heightMm: "10",
      tareWeightGrams: "12",
      maxWeightGrams: "",
      isActive: true,
      idempotencyKey: "shipping-box-1",
    })).toEqual({
      code: "small mailer",
      name: "Small Mailer",
      lengthMm: 230,
      widthMm: 160,
      heightMm: 10,
      tareWeightGrams: 12,
      maxWeightGrams: null,
      isActive: true,
      idempotencyKey: "shipping-box-1",
    });

    expect(buildShippingPackageProfileInput({
      productVariantId: "10",
      weightGrams: "100",
      lengthMm: "200",
      widthMm: "120",
      heightMm: "20",
      shipAlone: false,
      defaultCarrier: "USPS",
      defaultService: "",
      defaultBoxId: "",
      maxUnitsPerPackage: "4",
      isActive: true,
      idempotencyKey: "package-profile-1",
    })).toMatchObject({
      productVariantId: 10,
      maxUnitsPerPackage: 4,
      defaultService: null,
    });

    expect(buildShippingZoneRuleInput({
      originWarehouseId: "1",
      destinationCountry: "us",
      destinationRegion: "",
      postalPrefix: "15",
      zone: "zone 2",
      priority: "10",
      isActive: true,
      idempotencyKey: "zone-rule-1",
    })).toMatchObject({
      originWarehouseId: 1,
      destinationCountry: "US",
      postalPrefix: "15",
      zone: "zone 2",
      priority: 10,
    });

    expect(buildShippingRateTableInput({
      carrier: "USPS",
      service: "Ground Advantage",
      currency: "usd",
      status: "active",
      effectiveFrom: "",
      effectiveTo: "",
      warehouseId: "",
      destinationZone: "2",
      minWeightGrams: "0",
      maxWeightGrams: "450",
      rate: "5.25",
      idempotencyKey: "rate-table-1",
    })).toMatchObject({
      carrier: "USPS",
      currency: "USD",
      rows: [{ warehouseId: null, destinationZone: "2", minWeightGrams: 0, maxWeightGrams: 450, rateCents: 525 }],
    });

    expect(buildShippingInsurancePolicyInput({
      name: "Carrier pool",
      feeBps: "200",
      minFee: "",
      maxFee: "",
      isActive: true,
      effectiveFrom: "",
      effectiveTo: "",
      idempotencyKey: "insurance-policy-1",
    })).toMatchObject({ feeBps: 200, minFeeCents: null, maxFeeCents: null });

    expect(buildShippingMarkupPolicyInput({
      name: "Default markup",
      markupBps: "0",
      fixedMarkup: "0",
      minMarkup: "",
      maxMarkup: "",
      isActive: true,
      effectiveFrom: "",
      effectiveTo: "",
      idempotencyKey: "markup-policy-1",
    })).toMatchObject({ markupBps: 0, fixedMarkupCents: 0 });
  });

  it("rejects malformed admin shipping config mutation bodies", () => {
    expect(() => buildShippingRateTableInput({
      carrier: "USPS",
      service: "Ground Advantage",
      currency: "USD",
      status: "active",
      effectiveFrom: "",
      effectiveTo: "",
      warehouseId: "",
      destinationZone: "2",
      minWeightGrams: "500",
      maxWeightGrams: "100",
      rate: "5.25",
      idempotencyKey: "rate-table-2",
    })).toThrow();
    expect(() => buildShippingInsurancePolicyInput({
      name: "Carrier pool",
      feeBps: "10001",
      minFee: "",
      maxFee: "",
      isActive: true,
      effectiveFrom: "",
      effectiveTo: "",
      idempotencyKey: "insurance-policy-2",
    })).toThrow();
  });

  it("builds admin tracking push retry bodies with optional audit reasons", () => {
    expect(buildAdminTrackingPushRetryInput({
      idempotencyKey: "tracking-retry-1",
      reason: " marketplace timeout ",
    })).toEqual({
      idempotencyKey: "tracking-retry-1",
      reason: "marketplace timeout",
    });
    expect(buildAdminTrackingPushRetryInput({
      idempotencyKey: "tracking-retry-2",
      reason: " ",
    })).toEqual({
      idempotencyKey: "tracking-retry-2",
    });
    expect(() => buildAdminTrackingPushRetryInput({
      idempotencyKey: "short",
      reason: "",
    })).toThrow();
  });

  it("builds admin store connection URLs with optional filters", () => {
    expect(buildAdminStoreConnectionsUrl({
      search: " vendor ",
      status: "needs_reauth",
      platform: "ebay",
    })).toBe("/api/dropship/admin/store-connections?search=vendor&statuses=needs_reauth&platform=ebay&page=1&limit=50");
    expect(buildAdminStoreConnectionsUrl({
      search: "",
      status: "all",
      platform: "all",
      page: 2,
      limit: 25,
    })).toBe("/api/dropship/admin/store-connections?page=2&limit=25");
  });

  it("builds store order processing config inputs with nullable warehouse ids", () => {
    expect(buildStoreOrderProcessingConfigInput({
      defaultWarehouseId: " 3 ",
      idempotencyKey: "warehouse-config-1",
    })).toEqual({
      defaultWarehouseId: 3,
      idempotencyKey: "warehouse-config-1",
    });
    expect(buildStoreOrderProcessingConfigInput({
      defaultWarehouseId: " ",
      idempotencyKey: "warehouse-config-2",
    })).toEqual({
      defaultWarehouseId: null,
      idempotencyKey: "warehouse-config-2",
    });
    expect(() => buildStoreOrderProcessingConfigInput({
      defaultWarehouseId: "0",
      idempotencyKey: "warehouse-config-3",
    })).toThrow();
  });

  it("builds store listing config inputs from explicit admin form state", () => {
    expect(buildStoreListingConfigInput({
      listingMode: "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfigJson: "{ \"marketplaceId\": \"EBAY_US\" }",
      requiredConfigKeys: " marketplaceId, marketplaceId, businessPolicies.paymentPolicyId ",
      requiredProductFields: "sku, title",
      isActive: true,
    })).toEqual({
      listingMode: "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfig: { marketplaceId: "EBAY_US" },
      requiredConfigKeys: ["marketplaceId", "businessPolicies.paymentPolicyId"],
      requiredProductFields: ["sku", "title"],
      isActive: true,
    });
  });

  it("rejects invalid store listing config form state", () => {
    expect(() => buildStoreListingConfigInput({
      listingMode: "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfigJson: "[]",
      requiredConfigKeys: "",
      requiredProductFields: "",
      isActive: true,
    })).toThrow();
    expect(() => buildStoreListingConfigInput({
      listingMode: "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfigJson: "{}",
      requiredConfigKeys: "bad key",
      requiredProductFields: "",
      isActive: true,
    })).toThrow();
    expect(() => buildStoreListingConfigInput({
      listingMode: "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfigJson: "{}",
      requiredConfigKeys: "",
      requiredProductFields: "unsupported",
      isActive: true,
    })).toThrow();
  });

  it("builds admin store webhook repair inputs with idempotency guardrails", () => {
    expect(buildAdminStoreWebhookRepairInput({
      idempotencyKey: " repair-shopify-webhooks-1 ",
    })).toEqual({
      idempotencyKey: "repair-shopify-webhooks-1",
    });
    expect(() => buildAdminStoreWebhookRepairInput({
      idempotencyKey: "short",
    })).toThrow();
  });

  it("builds admin order ops action bodies with required reason guardrails", () => {
    expect(buildAdminOrderOpsActionInput({
      idempotencyKey: "retry-intake-1",
      reason: " repaired config ",
      requireReason: false,
    })).toEqual({
      idempotencyKey: "retry-intake-1",
      reason: "repaired config",
    });
    expect(buildAdminOrderOpsActionInput({
      idempotencyKey: "retry-intake-2",
      reason: " ",
      requireReason: false,
    })).toEqual({
      idempotencyKey: "retry-intake-2",
    });
    expect(() => buildAdminOrderOpsActionInput({
      idempotencyKey: "short",
      reason: "valid",
      requireReason: false,
    })).toThrow();
    expect(() => buildAdminOrderOpsActionInput({
      idempotencyKey: "exception-intake-1",
      reason: " ",
      requireReason: true,
    })).toThrow();
  });

  it("builds catalog exposure rule inputs with exact scope targets", () => {
    expect(buildCatalogExposureRuleInput({
      scopeType: "variant",
      action: "exclude",
      productVariantId: "42",
      category: "ignored",
      priority: "200",
      notes: "  hold for review ",
    })).toEqual({
      scopeType: "variant",
      action: "exclude",
      productLineId: null,
      productId: null,
      productVariantId: 42,
      category: null,
      priority: 200,
      startsAt: null,
      endsAt: null,
      notes: "hold for review",
      metadata: {},
    });
    expect(buildCatalogExposureRuleInput({
      scopeType: "category",
      action: "include",
      category: " Supplies ",
    })).toEqual(expect.objectContaining({
      scopeType: "category",
      action: "include",
      category: "Supplies",
    }));
    expect(() => buildCatalogExposureRuleInput({
      scopeType: "product_line",
      action: "include",
      productLineId: "",
    })).toThrow();
  });

  it("dedupes catalog exposure rules by scope, action, and normalized target", () => {
    expect(catalogExposureRuleKey(buildCatalogExposureRuleInput({
      scopeType: "category",
      action: "include",
      category: " Supplies ",
    }))).toBe(catalogExposureRuleKey(buildCatalogExposureRuleInput({
      scopeType: "category",
      action: "include",
      category: "supplies",
    })));
  });

  it("preserves catalog exposure effective windows when loading records into draft rules", () => {
    expect(catalogExposureRecordToInput({
      id: 1,
      revisionId: 2,
      scopeType: "catalog",
      action: "include",
      productLineId: null,
      productId: null,
      productVariantId: null,
      category: null,
      priority: 0,
      startsAt: "2026-05-01T00:00:00.000Z",
      endsAt: "2026-06-01T00:00:00.000Z",
      isActive: true,
      notes: " launch ",
      metadata: { source: "test" },
    })).toEqual({
      scopeType: "catalog",
      action: "include",
      productLineId: null,
      productId: null,
      productVariantId: null,
      category: null,
      priority: 0,
      startsAt: "2026-05-01T00:00:00.000Z",
      endsAt: "2026-06-01T00:00:00.000Z",
      notes: "launch",
      metadata: { source: "test" },
    });
  });

  it("builds store OAuth start payloads with platform-specific fields", () => {
    expect(buildStoreConnectionOAuthStartInput({
      platform: "ebay",
      shopDomain: "ignored",
      returnTo: " /onboarding ",
    })).toEqual({
      platform: "ebay",
      returnTo: "/onboarding",
    });
    expect(buildStoreConnectionOAuthStartInput({
      platform: "shopify",
      shopDomain: "Vendor-Test",
      returnTo: "/onboarding",
    })).toEqual({
      platform: "shopify",
      shopDomain: "vendor-test.myshopify.com",
      returnTo: "/onboarding",
    });
  });

  it("builds store disconnect bodies with required confirmation fields", () => {
    expect(buildStoreConnectionDisconnectInput({
      reason: " vendor requested disconnect ",
      idempotencyKey: "disconnect-store-1",
    })).toEqual({
      reason: "vendor requested disconnect",
      confirmed: true,
      idempotencyKey: "disconnect-store-1",
    });
    expect(() => buildStoreConnectionDisconnectInput({
      reason: " ",
      idempotencyKey: "disconnect-store-2",
    })).toThrow("reason is required.");
    expect(() => buildStoreConnectionDisconnectInput({
      reason: "valid reason",
      idempotencyKey: "short",
    })).toThrow("idempotencyKey must be between 8 and 200 characters.");
  });

  it("keeps portal return paths relative", () => {
    expect(normalizePortalReturnPath("/settings")).toBe("/settings");
    expect(() => normalizePortalReturnPath("https://attacker.example")).toThrow();
    expect(() => normalizePortalReturnPath("//attacker.example")).toThrow();
    expect(() => normalizePortalReturnPath(`/${"x".repeat(501)}`)).toThrow();
  });

  it("normalizes Shopify shop domains before OAuth start", () => {
    expect(normalizeShopifyShopDomainInput("https://Vendor-Test.myshopify.com/")).toBe("vendor-test.myshopify.com");
    expect(normalizeShopifyShopDomainInput("Vendor-Test")).toBe("vendor-test.myshopify.com");
    expect(normalizeShopifyShopDomainInput(" ")).toBe("");
  });

  it("builds variant include replacements without carrying stale variant overrides", () => {
    const replacement = buildVariantSelectionReplacement({
      existingRules: [
        makeSelectionRule({ id: 1, scopeType: "catalog", action: "include" }),
        makeSelectionRule({ id: 2, scopeType: "variant", action: "exclude", productVariantId: 42 }),
        makeSelectionRule({ id: 3, scopeType: "variant", action: "include", productVariantId: 99 }),
      ],
      rows: [makeCatalogRow({ productVariantId: 42 })],
      action: "include",
    });

    expect(replacement).toEqual([
      expect.objectContaining({ scopeType: "catalog", action: "include" }),
      expect.objectContaining({ scopeType: "variant", action: "include", productVariantId: 99 }),
      expect.objectContaining({ scopeType: "variant", action: "include", productVariantId: 42 }),
    ]);
    expect(replacement.some((rule) => rule.action === "exclude" && rule.productVariantId === 42)).toBe(false);
  });

  it("builds variant exclude replacements for visible deselection", () => {
    const replacement = buildVariantSelectionReplacement({
      existingRules: [makeSelectionRule({ id: 1, scopeType: "catalog", action: "include" })],
      rows: [makeCatalogRow({ productVariantId: 42 }), makeCatalogRow({ productVariantId: 42 })],
      action: "exclude",
    });

    expect(replacement).toEqual([
      expect.objectContaining({ scopeType: "catalog", action: "include" }),
      expect.objectContaining({ scopeType: "variant", action: "exclude", productVariantId: 42 }),
    ]);
  });

  it("builds listing preview requests from selected catalog rows only", () => {
    expect(buildListingPreviewRequest({
      storeConnectionId: 12,
      rows: [
        makeCatalogRow({ productVariantId: 42, selectionDecision: makeSelectionDecision(true) }),
        makeCatalogRow({ productVariantId: 42, selectionDecision: makeSelectionDecision(true) }),
        makeCatalogRow({ productVariantId: 99, selectionDecision: makeSelectionDecision(false) }),
      ],
    })).toEqual({
      storeConnectionId: 12,
      productVariantIds: [42],
    });
  });

  it("builds listing push requests from non-blocked preview rows only", () => {
    const preview = makeListingPreview({
      rows: [
        makeListingPreviewRow({ productVariantId: 42, previewStatus: "ready" }),
        makeListingPreviewRow({ productVariantId: 99, previewStatus: "warning" }),
        makeListingPreviewRow({ productVariantId: 100, previewStatus: "blocked" }),
      ],
    });

    expect(listingPreviewPushableCount(preview)).toBe(2);
    expect(buildListingPushRequest({
      storeConnectionId: 12,
      preview,
      idempotencyKey: "push-1",
    })).toEqual({
      storeConnectionId: 12,
      productVariantIds: [42, 99],
      idempotencyKey: "push-1",
    });
  });

  it("rejects listing push requests when the preview belongs to another store connection", () => {
    const preview = makeListingPreview({
      storeConnectionId: 12,
      rows: [
        makeListingPreviewRow({ productVariantId: 42, previewStatus: "ready" }),
      ],
    });

    expect(() => buildListingPushRequest({
      storeConnectionId: 13,
      preview,
      idempotencyKey: "push-1",
    })).toThrow("Listing preview store connection must match the selected store connection.");
  });

  it("parses dollar input to integer cents without floating point math", () => {
    expect(parseDollarInputToCents("$1,234.56", "amount")).toBe(123456);
    expect(parseDollarInputToCents("25", "amount")).toBe(2500);
    expect(parseDollarInputToCents("25.5", "amount")).toBe(2550);
    expect(() => parseDollarInputToCents("25.555", "amount")).toThrow();
    expect(() => parseDollarInputToCents("-1", "amount")).toThrow();
  });

  it("builds auto-reload config input with integer cents and guardrails", () => {
    expect(buildAutoReloadConfigInput({
      enabled: true,
      fundingMethodId: "99",
      minimumBalance: "$50.00",
      maxSingleReload: "250.00",
      paymentHoldTimeoutMinutes: "2880",
    })).toEqual({
      enabled: true,
      fundingMethodId: 99,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    });
    expect(buildAutoReloadConfigInput({
      enabled: false,
      fundingMethodId: "",
      minimumBalance: "0",
      maxSingleReload: "",
      paymentHoldTimeoutMinutes: "2880",
    })).toEqual({
      enabled: false,
      fundingMethodId: null,
      minimumBalanceCents: 0,
      maxSingleReloadCents: null,
      paymentHoldTimeoutMinutes: 2880,
    });
    expect(() => buildAutoReloadConfigInput({
      enabled: true,
      fundingMethodId: "",
      minimumBalance: "50",
      maxSingleReload: "250",
      paymentHoldTimeoutMinutes: "2880",
    })).toThrow();
    expect(() => buildAutoReloadConfigInput({
      enabled: true,
      fundingMethodId: "99",
      minimumBalance: "250",
      maxSingleReload: "50",
      paymentHoldTimeoutMinutes: "2880",
    })).toThrow();
  });

  it("builds admin manual wallet credit input with integer cents and audit reason", () => {
    expect(buildAdminWalletManualCreditInput({
      vendorId: "10",
      amount: "$125.50",
      reason: " Internal dogfood seed ",
      idempotencyKey: "manual-credit-1",
    })).toEqual({
      vendorId: 10,
      amountCents: 12550,
      currency: "USD",
      reason: "Internal dogfood seed",
      idempotencyKey: "manual-credit-1",
    });

    expect(() => buildAdminWalletManualCreditInput({
      vendorId: "10",
      amount: "0",
      reason: "seed",
      idempotencyKey: "manual-credit-1",
    })).toThrow();
    expect(() => buildAdminWalletManualCreditInput({
      vendorId: "10",
      amount: "125.00",
      reason: "",
      idempotencyKey: "manual-credit-1",
    })).toThrow();
  });

  it("builds admin confirmed USDC credit input with exact atomic units", () => {
    expect(buildAdminWalletConfirmedUsdcCreditInput({
      vendorId: "10",
      fundingMethodId: "101",
      amount: "$125.50",
      usdcAmount: "125.50",
      transactionHash: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      fromAddress: "0x2222222222222222222222222222222222222222",
      toAddress: "0x1111111111111111111111111111111111111111",
      confirmations: "12",
      idempotencyKey: "usdc-credit-1",
    })).toEqual({
      vendorId: 10,
      fundingMethodId: 101,
      amountCents: 12550,
      currency: "USD",
      amountAtomicUnits: "125500000",
      chainId: 8453,
      transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fromAddress: "0x2222222222222222222222222222222222222222",
      toAddress: "0x1111111111111111111111111111111111111111",
      confirmations: 12,
      idempotencyKey: "usdc-credit-1",
    });

    expect(buildAdminWalletConfirmedUsdcCreditInput({
      vendorId: "10",
      fundingMethodId: "",
      amount: "1",
      usdcAmount: "0.000001",
      transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      fromAddress: "",
      toAddress: "0x1111111111111111111111111111111111111111",
      confirmations: "1",
      idempotencyKey: "usdc-credit-2",
    })).toMatchObject({
      amountAtomicUnits: "1",
      fromAddress: null,
    });

    expect(() => buildAdminWalletConfirmedUsdcCreditInput({
      vendorId: "10",
      fundingMethodId: "",
      amount: "1",
      usdcAmount: "1.0000001",
      transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      fromAddress: "",
      toAddress: "0x1111111111111111111111111111111111111111",
      confirmations: "1",
      idempotencyKey: "usdc-credit-3",
    })).toThrow();
    expect(() => buildAdminWalletConfirmedUsdcCreditInput({
      vendorId: "10",
      fundingMethodId: "",
      amount: "1",
      usdcAmount: "1",
      transactionHash: "not-a-hash",
      fromAddress: "",
      toAddress: "0x1111111111111111111111111111111111111111",
      confirmations: "1",
      idempotencyKey: "usdc-credit-4",
    })).toThrow();
    expect(() => buildAdminWalletConfirmedUsdcCreditInput({
      vendorId: "10",
      fundingMethodId: "",
      amount: "1",
      usdcAmount: "1",
      transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      fromAddress: "",
      toAddress: "0x1111111111111111111111111111111111111111",
      confirmations: "10001",
      idempotencyKey: "usdc-credit-5",
    })).toThrow();
  });

  it("builds Stripe funding setup session input with relative return path guardrails", () => {
    expect(buildStripeFundingSetupSessionInput({
      rail: "stripe_card",
      returnTo: "/wallet",
    })).toEqual({
      rail: "stripe_card",
      returnTo: "/wallet",
    });
    expect(buildStripeFundingSetupSessionInput({
      rail: "stripe_ach",
      returnTo: "/dropship-portal/wallet?tab=funding",
    })).toEqual({
      rail: "stripe_ach",
      returnTo: "/dropship-portal/wallet?tab=funding",
    });
    expect(() => buildStripeFundingSetupSessionInput({
      rail: "manual",
      returnTo: "/wallet",
    })).toThrow();
    expect(() => buildStripeFundingSetupSessionInput({
      rail: "stripe_card",
      returnTo: "https://attacker.example/wallet",
    })).toThrow();
  });

  it("builds Stripe wallet funding session input with integer cents", () => {
    expect(buildStripeWalletFundingSessionInput({
      fundingMethodId: "99",
      amount: "$250.00",
      returnTo: "/wallet",
    })).toEqual({
      fundingMethodId: 99,
      amountCents: 25000,
      returnTo: "/wallet",
    });
    expect(() => buildStripeWalletFundingSessionInput({
      fundingMethodId: "",
      amount: "250",
      returnTo: "/wallet",
    })).toThrow();
    expect(() => buildStripeWalletFundingSessionInput({
      fundingMethodId: "99",
      amount: "250.555",
      returnTo: "/wallet",
    })).toThrow();
    expect(() => buildStripeWalletFundingSessionInput({
      fundingMethodId: "99",
      amount: "250",
      returnTo: "https://attacker.example/wallet",
    })).toThrow();
  });
});

function makeSelectionRule(overrides: Partial<DropshipVendorSelectionRule>): DropshipVendorSelectionRule {
  return {
    scopeType: "variant",
    action: "include",
    productLineId: null,
    productId: null,
    productVariantId: 1,
    category: null,
    autoConnectNewSkus: true,
    autoListNewSkus: false,
    priority: 0,
    isActive: true,
    ...overrides,
  };
}

function makeCatalogRow(overrides: Partial<DropshipCatalogRow>): DropshipCatalogRow {
  return {
    productId: 10,
    productVariantId: 1,
    productSku: "SKU",
    productName: "Product",
    variantSku: "VARIANT",
    variantName: "Variant",
    category: null,
    productLineNames: [],
    unitsPerVariant: 1,
    selectionDecision: makeSelectionDecision(false),
    ...overrides,
  };
}

function makeSelectionDecision(selected: boolean): DropshipCatalogRow["selectionDecision"] {
  return {
    selected,
    reason: selected ? "selected" : "missing_vendor_include_rule",
    marketplaceQuantity: selected ? 5 : 0,
    quantityCapApplied: false,
    autoConnectNewSkus: selected,
    autoListNewSkus: false,
  };
}

function makeListingPreview(overrides: Partial<DropshipListingPreviewResult>): DropshipListingPreviewResult {
  return {
    vendorId: 1,
    storeConnectionId: 12,
    platform: "ebay",
    generatedAt: "2026-05-03T12:00:00.000Z",
    rows: [],
    summary: {
      total: 0,
      ready: 0,
      blocked: 0,
      warning: 0,
    },
    ...overrides,
  };
}

function makeListingPreviewRow(
  overrides: Partial<DropshipListingPreviewResult["rows"][number]>,
): DropshipListingPreviewResult["rows"][number] {
  return {
    productVariantId: 1,
    productId: 10,
    sku: "SKU",
    title: "Listing",
    platform: "ebay",
    listingMode: "live",
    currentListingStatus: "not_listed",
    previewStatus: "ready",
    blockers: [],
    warnings: [],
    marketplaceQuantity: 5,
    priceCents: 1299,
    previewHash: "hash",
    ...overrides,
  };
}
