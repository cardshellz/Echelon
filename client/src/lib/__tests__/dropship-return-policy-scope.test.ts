import { describe, expect, it } from "vitest";
import {
  RETURN_POLICY_ANY_STORE_VALUE,
  RETURN_POLICY_GLOBAL_VENDOR_VALUE,
  buildReturnPolicyStoreOptions,
  buildReturnPolicyVendorOptions,
  returnFeeRowToEditFormState,
  returnPolicyRowToEditFormState,
  returnPolicyScopeValueFromPicker,
  returnPolicyScopeValueToPicker,
} from "../dropship-return-policy-scope";

function vendorRow(overrides: {
  vendorId: number;
  businessName?: string | null;
  email?: string | null;
  memberId?: string;
  status?: string;
  entitlementStatus?: string;
}) {
  return {
    vendor: {
      vendorId: overrides.vendorId,
      memberId: overrides.memberId ?? `mem-${overrides.vendorId}`,
      businessName: overrides.businessName ?? null,
      email: overrides.email ?? null,
      status: overrides.status ?? "active",
      entitlementStatus: overrides.entitlementStatus ?? "active",
    },
  };
}

function storeRow(overrides: {
  storeConnectionId: number;
  vendorId: number;
  vendorBusinessName?: string | null;
  vendorEmail?: string | null;
  platform?: string;
  status?: string;
  externalDisplayName?: string | null;
  shopDomain?: string | null;
}) {
  return {
    storeConnectionId: overrides.storeConnectionId,
    platform: overrides.platform ?? "ebay",
    status: overrides.status ?? "connected",
    externalDisplayName: overrides.externalDisplayName ?? null,
    shopDomain: overrides.shopDomain ?? null,
    vendor: {
      vendorId: overrides.vendorId,
      memberId: `mem-${overrides.vendorId}`,
      businessName: overrides.vendorBusinessName ?? null,
      email: overrides.vendorEmail ?? null,
      status: "active",
      entitlementStatus: "active",
    },
  };
}

describe("buildReturnPolicyVendorOptions", () => {
  it("dedupes vendors, sorts by display name, and prepends the global blank option", () => {
    const options = buildReturnPolicyVendorOptions([
      vendorRow({ vendorId: 2, businessName: "Zebra Cards", email: "z@example.com" }),
      vendorRow({ vendorId: 1, businessName: "Alpha Cards", email: "a@example.com" }),
      vendorRow({ vendorId: 2, businessName: "Zebra Cards", email: "z@example.com" }),
    ]);

    expect(options[0]).toMatchObject({
      value: RETURN_POLICY_GLOBAL_VENDOR_VALUE,
      label: "Global (no vendor)",
    });
    expect(options.slice(1).map((option) => option.value)).toEqual(["1", "2"]);
    expect(options[1]).toMatchObject({ label: "Alpha Cards", detail: "a@example.com" });
  });

  it("falls back to email when business name is missing, and omits redundant detail", () => {
    const options = buildReturnPolicyVendorOptions([
      vendorRow({ vendorId: 7, businessName: null, email: "solo@example.com" }),
    ]);

    const vendor = options.find((option) => option.value === "7");
    expect(vendor?.label).toBe("solo@example.com");
    expect(vendor?.detail).toBeUndefined();
  });

  it("falls back to a Vendor <id> label when both name and email are missing", () => {
    const options = buildReturnPolicyVendorOptions([vendorRow({ vendorId: 9 })]);
    const vendor = options.find((option) => option.value === "9");
    expect(vendor?.label).toBe("Vendor 9");
  });

  it("includes name, email, member id, and id in the search text", () => {
    const options = buildReturnPolicyVendorOptions([
      vendorRow({ vendorId: 3, businessName: "Marz Cards", email: "marz@example.com", memberId: "mem-xyz" }),
    ]);
    const vendor = options.find((option) => option.value === "3");
    expect(vendor?.search).toContain("Marz Cards");
    expect(vendor?.search).toContain("marz@example.com");
    expect(vendor?.search).toContain("mem-xyz");
    expect(vendor?.search).toContain("3");
  });
});

describe("buildReturnPolicyStoreOptions", () => {
  const connections = [
    storeRow({
      storeConnectionId: 11,
      vendorId: 1,
      vendorBusinessName: "Alpha Cards",
      platform: "ebay",
      externalDisplayName: "marzcards",
    }),
    storeRow({
      storeConnectionId: 12,
      vendorId: 1,
      vendorBusinessName: "Alpha Cards",
      platform: "shopify",
      shopDomain: "alpha.myshopify.com",
    }),
    storeRow({
      storeConnectionId: 21,
      vendorId: 2,
      vendorBusinessName: "Zebra Cards",
      vendorEmail: "z@example.com",
      platform: "ebay",
      externalDisplayName: "zebra-outlet",
    }),
  ];

  it("filters store connections to the selected vendor and labels the blank option as vendor scope", () => {
    const options = buildReturnPolicyStoreOptions(connections, "1");

    expect(options[0]).toMatchObject({
      value: RETURN_POLICY_ANY_STORE_VALUE,
      label: "Any store (vendor scope)",
    });
    expect(options.slice(1).map((option) => option.value)).toEqual(["12", "11"]);
    // Vendor selected: vendor name moves to detail, label stays platform + store.
    const ebay = options.find((option) => option.value === "11");
    expect(ebay?.label).toBe("Ebay — marzcards");
    expect(ebay?.detail).toContain("Alpha Cards");
  });

  it("shows all connections with the vendor name in the label when no vendor is selected", () => {
    const options = buildReturnPolicyStoreOptions(connections, "");

    expect(options[0]).toMatchObject({
      value: RETURN_POLICY_ANY_STORE_VALUE,
      label: "Global (no store)",
    });
    expect(options).toHaveLength(4);
    const zebra = options.find((option) => option.value === "21");
    expect(zebra?.label).toBe("Ebay — zebra-outlet (Zebra Cards)");
  });

  it("treats whitespace-only vendor selection as no vendor", () => {
    const options = buildReturnPolicyStoreOptions(connections, "   ");
    expect(options).toHaveLength(4);
    expect(options[0]?.label).toBe("Global (no store)");
  });

  it("returns only the blank option when the selected vendor has no connections", () => {
    const options = buildReturnPolicyStoreOptions(connections, "999");
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ value: RETURN_POLICY_ANY_STORE_VALUE });
  });

  it("falls back to shop domain, then a platform label, for the store name", () => {
    const options = buildReturnPolicyStoreOptions([
      storeRow({ storeConnectionId: 31, vendorId: 3, platform: "shopify", shopDomain: "shop.example.com" }),
      storeRow({ storeConnectionId: 32, vendorId: 3, platform: "ebay" }),
    ], "3");

    const byDomain = options.find((option) => option.value === "31");
    const byPlatform = options.find((option) => option.value === "32");
    expect(byDomain?.label).toBe("Shopify — shop.example.com");
    expect(byPlatform?.label).toBe("Ebay — Ebay store");
  });

  it("includes store id, vendor name, and vendor email in the search text", () => {
    const options = buildReturnPolicyStoreOptions(connections, "");
    const zebra = options.find((option) => option.value === "21");
    expect(zebra?.search).toContain("21");
    expect(zebra?.search).toContain("Zebra Cards");
    expect(zebra?.search).toContain("z@example.com");
  });
});

describe("returnPolicyScopeValueFromPicker / returnPolicyScopeValueToPicker", () => {
  it("maps blank sentinels back to empty-string form state", () => {
    expect(returnPolicyScopeValueFromPicker(RETURN_POLICY_GLOBAL_VENDOR_VALUE)).toBe("");
    expect(returnPolicyScopeValueFromPicker(RETURN_POLICY_ANY_STORE_VALUE)).toBe("");
    expect(returnPolicyScopeValueFromPicker("42")).toBe("42");
  });

  it("maps empty-string form state to the blank sentinel for the picker", () => {
    expect(returnPolicyScopeValueToPicker("", RETURN_POLICY_GLOBAL_VENDOR_VALUE)).toBe(RETURN_POLICY_GLOBAL_VENDOR_VALUE);
    expect(returnPolicyScopeValueToPicker("  ", RETURN_POLICY_ANY_STORE_VALUE)).toBe(RETURN_POLICY_ANY_STORE_VALUE);
    expect(returnPolicyScopeValueToPicker("42", RETURN_POLICY_GLOBAL_VENDOR_VALUE)).toBe("42");
  });

  it("round-trips picker selections through form state", () => {
    for (const raw of ["", "5", "17"]) {
      const picker = returnPolicyScopeValueToPicker(raw, RETURN_POLICY_GLOBAL_VENDOR_VALUE);
      expect(returnPolicyScopeValueFromPicker(picker)).toBe(raw.trim() === "" ? "" : raw);
    }
  });
});

describe("returnPolicyRowToEditFormState", () => {
  it("maps a vendor+store-scoped policy row to string form state", () => {
    expect(returnPolicyRowToEditFormState({
      returnWindowDays: 45,
      vendorId: 12,
      storeConnectionId: 34,
      priority: 7,
    })).toEqual({
      returnWindowDays: "45",
      vendorId: "12",
      storeConnectionId: "34",
      priority: "7",
    });
  });

  it("maps null scope ids to empty-string (global) form state", () => {
    expect(returnPolicyRowToEditFormState({
      returnWindowDays: 30,
      vendorId: null,
      storeConnectionId: null,
      priority: 0,
    })).toEqual({
      returnWindowDays: "30",
      vendorId: "",
      storeConnectionId: "",
      priority: "0",
    });
  });

  it("maps vendor-only scope (null store) to a blank store field", () => {
    const state = returnPolicyRowToEditFormState({
      returnWindowDays: 14,
      vendorId: 9,
      storeConnectionId: null,
      priority: 1,
    });
    expect(state.vendorId).toBe("9");
    expect(state.storeConnectionId).toBe("");
  });
});

describe("returnFeeRowToEditFormState", () => {
  it("maps a flat-cents fee row to string form state, preserving integer cents", () => {
    expect(returnFeeRowToEditFormState({
      feeType: "restocking_fee",
      faultCategory: "customer",
      amountType: "flat_cents",
      amount: 1500,
      vendorId: 3,
      storeConnectionId: 8,
      priority: 2,
    })).toEqual({
      feeType: "restocking_fee",
      faultCategory: "customer",
      amountType: "flat_cents",
      amount: "1500",
      vendorId: "3",
      storeConnectionId: "8",
      priority: "2",
    });
  });

  it("maps a percent fee row without unit conversion", () => {
    const state = returnFeeRowToEditFormState({
      feeType: "processing_fee",
      faultCategory: "vendor",
      amountType: "percent",
      amount: 15,
      vendorId: null,
      storeConnectionId: null,
      priority: 0,
    });
    expect(state.amountType).toBe("percent");
    expect(state.amount).toBe("15");
    expect(state.vendorId).toBe("");
    expect(state.storeConnectionId).toBe("");
  });

  it("maps a return_shipping_fee row (amount ignored downstream) verbatim", () => {
    const state = returnFeeRowToEditFormState({
      feeType: "return_shipping_fee",
      faultCategory: "marketplace",
      amountType: "flat_cents",
      amount: 0,
      vendorId: 21,
      storeConnectionId: null,
      priority: 5,
    });
    expect(state).toEqual({
      feeType: "return_shipping_fee",
      faultCategory: "marketplace",
      amountType: "flat_cents",
      amount: "0",
      vendorId: "21",
      storeConnectionId: "",
      priority: "5",
    });
  });

  it("round-trips through the picker value mapping so the scope pickers show the row's scope", () => {
    const state = returnFeeRowToEditFormState({
      feeType: "restocking_fee",
      faultCategory: "carrier",
      amountType: "flat_cents",
      amount: 250,
      vendorId: 4,
      storeConnectionId: null,
      priority: 0,
    });
    expect(returnPolicyScopeValueToPicker(state.vendorId, RETURN_POLICY_GLOBAL_VENDOR_VALUE)).toBe("4");
    expect(returnPolicyScopeValueToPicker(state.storeConnectionId, RETURN_POLICY_ANY_STORE_VALUE))
      .toBe(RETURN_POLICY_ANY_STORE_VALUE);
  });
});
