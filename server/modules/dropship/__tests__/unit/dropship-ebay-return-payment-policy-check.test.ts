import { describe, expect, it, vi } from "vitest";
import {
  CachingDropshipEbayReturnPaymentPolicyChecker,
  EBAY_RETURN_PAYMENT_POLICY_LIST_TTL_MS,
  type DropshipEbayReturnPaymentPolicyDirectory,
  type DropshipEbayReturnPaymentPolicyIds,
} from "../../application/dropship-ebay-return-payment-policy-check";
import {
  EBAY_PAYMENT_POLICY_NOT_FOUND,
  EBAY_PAYMENT_POLICY_VERIFICATION_UNAVAILABLE,
  EBAY_RETURN_POLICY_NOT_FOUND,
  EBAY_RETURN_POLICY_VERIFICATION_UNAVAILABLE,
  ebayReturnPaymentPolicyBlockers,
} from "../../domain/ebay-return-payment-policy-blockers";
import { DropshipError } from "../../domain/errors";
import { EbayDropshipListingSetupDirectory } from "../../infrastructure/dropship-ebay-listing-setup.directory";
import type { DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";

const STORE = { vendorId: 10, storeConnectionId: 44, marketplaceId: "EBAY_US" };

describe("EbayDropshipListingSetupDirectory.listReturnAndPaymentPolicyIds", () => {
  it("reads the two policy lists once each, for the marketplace, and keeps the ids the setup would offer", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer store-access");
      if (String(url).includes("/return_policy?")) {
        return jsonResponse({ returnPolicies: [
          policy("returnPolicyId", "return-30", "Thirty days"),
          policy("returnPolicyId", "return-motors", "Motors only", "MOTORS_VEHICLES"),
        ] });
      }
      if (String(url).includes("/payment_policy?")) {
        return jsonResponse({ paymentPolicies: [policy("paymentPolicyId", "payment-1", "Managed")] });
      }
      throw new Error(`Unexpected eBay URL: ${String(url)}`);
    });
    const credentials = { loadFreshForStoreConnection: vi.fn(async () => credential("store")) };
    const directory = new EbayDropshipListingSetupDirectory(credentials, fetchFn as typeof fetch);

    const lists = await directory.listReturnAndPaymentPolicyIds({ ...STORE, marketplaceId: "EBAY US" });

    expect([...lists.returnPolicyIds]).toEqual(["return-30"]);
    expect([...lists.paymentPolicyIds]).toEqual(["payment-1"]);
    expect(urls.sort()).toEqual([
      "https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY%20US",
      "https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY%20US",
    ]);
    expect(credentials.loadFreshForStoreConnection).toHaveBeenCalledTimes(1);
    expect(credentials.loadFreshForStoreConnection).toHaveBeenCalledWith({
      vendorId: 10, storeConnectionId: 44, operation: "return_payment_policy_read",
    });
  });

  it("uses the sandbox host for a sandbox store", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => emptyPolicyResponse(String(url)));
    const directory = new EbayDropshipListingSetupDirectory({
      loadFreshForStoreConnection: async () => ({ ...credential("store"), providerEnvironment: "sandbox" }),
    }, fetchFn as typeof fetch);

    await directory.listReturnAndPaymentPolicyIds(STORE);

    expect(fetchFn.mock.calls.map(([url]) => String(url)).every((url) => url.startsWith("https://api.sandbox.ebay.com/")))
      .toBe(true);
  });

  it("repairs a rejected cached token once", async () => {
    const credentials = {
      loadFreshForStoreConnection: vi.fn().mockResolvedValueOnce(credential("old")).mockResolvedValue(credential("new")),
    };
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => (
      new Headers(init?.headers).get("Authorization") === "Bearer old-access"
        ? new Response("{}", { status: 401 })
        : emptyPolicyResponse(String(url))
    ));
    const directory = new EbayDropshipListingSetupDirectory(credentials, fetchFn as typeof fetch);

    await expect(directory.listReturnAndPaymentPolicyIds(STORE)).resolves.toEqual({
      returnPolicyIds: new Set(), paymentPolicyIds: new Set(),
    });
    expect(credentials.loadFreshForStoreConnection).toHaveBeenLastCalledWith({
      vendorId: 10, storeConnectionId: 44, operation: "return_payment_policy_read", rejectedAccessTokenRef: "old-access-ref",
    });
  });

  it("reports an eBay refusal as a setup read failure that is not retried", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => (
      String(url).includes("/return_policy?") ? new Response("{}", { status: 404 }) : emptyPolicyResponse(String(url))
    ));
    const directory = new EbayDropshipListingSetupDirectory({
      loadFreshForStoreConnection: async () => credential("store"),
    }, fetchFn as typeof fetch);

    await expect(directory.listReturnAndPaymentPolicyIds(STORE)).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
      context: { storeConnectionId: 44, resource: "returnPolicies", status: 404, retryable: false },
    });
  });

  it("asks for reauthorization when the store's eBay grant is gone", async () => {
    const directory = new EbayDropshipListingSetupDirectory({
      loadFreshForStoreConnection: async () => {
        throw new DropshipError("DROPSHIP_STORE_REFRESH_TOKEN_REQUIRED", "Refresh token required.", { retryable: false });
      },
    }, vi.fn() as unknown as typeof fetch);

    await expect(directory.listReturnAndPaymentPolicyIds(STORE)).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
    });
  });

  it("refuses a blank marketplace before loading credentials or calling eBay", async () => {
    const credentials = { loadFreshForStoreConnection: vi.fn() };
    const fetchFn = vi.fn();
    const directory = new EbayDropshipListingSetupDirectory(credentials, fetchFn as unknown as typeof fetch);

    await expect(directory.listReturnAndPaymentPolicyIds({ ...STORE, marketplaceId: "  " })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT",
    });
    expect(credentials.loadFreshForStoreConnection).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("CachingDropshipEbayReturnPaymentPolicyChecker", () => {
  it("names the checked ids eBay does not list", async () => {
    const { checker } = setup({ returnPolicyIds: ["return-1"], paymentPolicyIds: ["payment-1"] });

    const result = await checker.check({ ...STORE, returnPolicyIds: ["return-1", "return-gone"], paymentPolicyIds: ["payment-1"] });

    expect(result).toEqual({ missingReturnPolicyIds: new Set(["return-gone"]), missingPaymentPolicyIds: new Set() });
  });

  it("reuses a store's lists until they are a minute old", async () => {
    const { checker, directory, clock } = setup({ returnPolicyIds: ["return-1"], paymentPolicyIds: ["payment-1"] });
    const input = { ...STORE, returnPolicyIds: ["return-1"], paymentPolicyIds: ["payment-1"] };

    await checker.check(input);
    clock.advance(EBAY_RETURN_PAYMENT_POLICY_LIST_TTL_MS - 1);
    await checker.check(input);
    expect(directory.listReturnAndPaymentPolicyIds).toHaveBeenCalledTimes(1);

    clock.advance(1);
    await checker.check(input);
    expect(directory.listReturnAndPaymentPolicyIds).toHaveBeenCalledTimes(2);
  });

  it("reads afresh before calling an id missing, so a policy made a moment ago is found", async () => {
    const lists = { returnPolicyIds: ["return-1"], paymentPolicyIds: ["payment-1"] };
    const { checker, directory } = setup(lists);
    await checker.check({ ...STORE, returnPolicyIds: ["return-1"], paymentPolicyIds: ["payment-1"] });

    lists.returnPolicyIds.push("return-new");
    const result = await checker.check({ ...STORE, returnPolicyIds: ["return-new"], paymentPolicyIds: [] });

    expect(result.missingReturnPolicyIds).toEqual(new Set());
    expect(directory.listReturnAndPaymentPolicyIds).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed read: the next check asks eBay again", async () => {
    const { checker, directory } = setup({ returnPolicyIds: ["return-1"], paymentPolicyIds: [] });
    const outage = new DropshipError("DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", "down", { retryable: true });
    directory.listReturnAndPaymentPolicyIds.mockRejectedValueOnce(outage);
    const input = { ...STORE, returnPolicyIds: ["return-1"], paymentPolicyIds: [] };

    await expect(checker.check(input)).rejects.toBe(outage);
    await expect(checker.check(input)).resolves.toEqual({ missingReturnPolicyIds: new Set(), missingPaymentPolicyIds: new Set() });
    expect(directory.listReturnAndPaymentPolicyIds).toHaveBeenCalledTimes(2);
  });

  it("shares one read between checks for the same store made at the same time", async () => {
    const { checker, directory } = setup({ returnPolicyIds: ["return-1"], paymentPolicyIds: [] });
    const input = { ...STORE, returnPolicyIds: ["return-1"], paymentPolicyIds: [] };

    await Promise.all([checker.check(input), checker.check(input), checker.check(input)]);

    expect(directory.listReturnAndPaymentPolicyIds).toHaveBeenCalledTimes(1);
  });

  it("keeps stores and marketplaces apart", async () => {
    const { checker, directory } = setup({ returnPolicyIds: ["return-1"], paymentPolicyIds: [] });
    const ids = { returnPolicyIds: ["return-1"], paymentPolicyIds: [] };

    await checker.check({ ...STORE, ...ids });
    await checker.check({ ...STORE, storeConnectionId: 45, ...ids });
    await checker.check({ ...STORE, marketplaceId: "EBAY_GB", ...ids });

    expect(directory.listReturnAndPaymentPolicyIds.mock.calls.map(([store]) => store)).toEqual([
      STORE, { ...STORE, storeConnectionId: 45 }, { ...STORE, marketplaceId: "EBAY_GB" },
    ]);
  });

  it("does not call eBay when there is no id to check", async () => {
    const { checker, directory } = setup({ returnPolicyIds: [], paymentPolicyIds: [] });

    await expect(checker.check({ ...STORE, returnPolicyIds: [], paymentPolicyIds: [] }))
      .resolves.toEqual({ missingReturnPolicyIds: new Set(), missingPaymentPolicyIds: new Set() });
    expect(directory.listReturnAndPaymentPolicyIds).not.toHaveBeenCalled();
  });

  it("drops the oldest store once it holds the most it keeps", async () => {
    const { checker, directory } = setup({ returnPolicyIds: ["return-1"], paymentPolicyIds: [] }, 2);
    const ids = { returnPolicyIds: ["return-1"], paymentPolicyIds: [] };

    for (const storeConnectionId of [1, 2, 3]) await checker.check({ ...STORE, storeConnectionId, ...ids });
    await checker.check({ ...STORE, storeConnectionId: 3, ...ids });
    await checker.check({ ...STORE, storeConnectionId: 1, ...ids });

    expect(directory.listReturnAndPaymentPolicyIds.mock.calls.map(([store]) => store.storeConnectionId)).toEqual([1, 2, 3, 1]);
  });

  it("does not trust a list when the clock has moved backwards", async () => {
    const { checker, directory, clock } = setup({ returnPolicyIds: ["return-1"], paymentPolicyIds: [] });
    const input = { ...STORE, returnPolicyIds: ["return-1"], paymentPolicyIds: [] };

    await checker.check(input);
    clock.advance(-1);
    await checker.check(input);

    expect(directory.listReturnAndPaymentPolicyIds).toHaveBeenCalledTimes(2);
  });
});

describe("ebayReturnPaymentPolicyBlockers", () => {
  const checked = (missingReturn: string[], missingPayment: string[]) => ({
    status: "checked" as const,
    missingReturnPolicyIds: new Set(missingReturn),
    missingPaymentPolicyIds: new Set(missingPayment),
  });

  it("blocks each policy eBay no longer lists", () => {
    expect(ebayReturnPaymentPolicyBlockers({ returnPolicyId: "r", paymentPolicyId: "p", check: checked(["r"], ["p"]) }))
      .toEqual([EBAY_RETURN_POLICY_NOT_FOUND, EBAY_PAYMENT_POLICY_NOT_FOUND]);
    expect(ebayReturnPaymentPolicyBlockers({ returnPolicyId: "r", paymentPolicyId: "p", check: checked([], []) }))
      .toEqual([]);
  });

  it("only blocks the ids this listing sends", () => {
    expect(ebayReturnPaymentPolicyBlockers({ returnPolicyId: "r-own", paymentPolicyId: "p", check: checked(["r-default"], []) }))
      .toEqual([]);
  });

  it("blocks each policy it sends when eBay could not be read", () => {
    expect(ebayReturnPaymentPolicyBlockers({ returnPolicyId: "r", paymentPolicyId: "p", check: { status: "unavailable" } }))
      .toEqual([EBAY_RETURN_POLICY_VERIFICATION_UNAVAILABLE, EBAY_PAYMENT_POLICY_VERIFICATION_UNAVAILABLE]);
  });

  it("leaves a missing id to the listing config check, and adds nothing when nothing was checked", () => {
    expect(ebayReturnPaymentPolicyBlockers({ returnPolicyId: null, paymentPolicyId: null, check: { status: "unavailable" } }))
      .toEqual([]);
    expect(ebayReturnPaymentPolicyBlockers({ returnPolicyId: "r", paymentPolicyId: "p", check: { status: "not_checked" } }))
      .toEqual([]);
  });
});

function setup(lists: { returnPolicyIds: string[]; paymentPolicyIds: string[] }, maxStores?: number) {
  let nowMs = Date.parse("2026-10-08T12:00:00Z");
  const clock = { now: () => new Date(nowMs), advance: (ms: number) => { nowMs += ms; } };
  const directory = {
    listReturnAndPaymentPolicyIds: vi.fn<DropshipEbayReturnPaymentPolicyDirectory["listReturnAndPaymentPolicyIds"]>(
      async (): Promise<DropshipEbayReturnPaymentPolicyIds> => ({
        returnPolicyIds: new Set(lists.returnPolicyIds),
        paymentPolicyIds: new Set(lists.paymentPolicyIds),
      }),
    ),
  };
  const checker = new CachingDropshipEbayReturnPaymentPolicyChecker({ directory, clock, ...(maxStores ? { maxStores } : {}) });
  return { checker, directory, clock };
}

function credential(prefix: string): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 10, storeConnectionId: 44, platform: "ebay", status: "connected", shopDomain: null,
    externalAccountId: "seller", providerEnvironment: "production",
    externalAccountIdentityScheme: "ebay_user_id", externalAccountVerifiedAt: null,
    externalDisplayName: "Store", config: {}, accessToken: `${prefix}-access`, accessTokenRef: `${prefix}-access-ref`,
    accessTokenExpiresAt: new Date("2026-10-09T12:00:00Z"), refreshToken: "refresh", refreshTokenRef: "refresh-ref",
    refreshTokenExpiresAt: null,
  };
}

function policy(
  idKey: "returnPolicyId" | "paymentPolicyId",
  id: string,
  name: string,
  categoryType = "ALL_EXCLUDING_MOTORS_VEHICLES",
): Record<string, unknown> {
  return { [idKey]: id, name, categoryTypes: [{ name: categoryType }] };
}

function emptyPolicyResponse(url: string): Response {
  if (url.includes("/return_policy?")) return jsonResponse({ returnPolicies: [] });
  if (url.includes("/payment_policy?")) return jsonResponse({ paymentPolicies: [] });
  throw new Error(`Unexpected eBay URL: ${url}`);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
