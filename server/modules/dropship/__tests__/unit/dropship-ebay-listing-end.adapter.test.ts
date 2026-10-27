import { describe, expect, it, vi } from "vitest";
import { EbayApiClient } from "../../../channels/adapters/ebay/ebay-api.client";
import type { EbayQuantityRequestAdmission } from "../../../channels/quantity-publication-request";
import { QuantityPublicationAdmissionError } from "../../../inventory-planning/domain/quantity-publication-admission";
import { listingEndQuantityScope, parseListingEndResolvedIdentity } from "../../domain/listing-end-claims";
import {
  classifyWithdrawError,
  DropshipEbayListingEndAdapter,
  LISTING_END_CREDENTIAL_OPERATION,
  type CreateDropshipListingEndClient,
} from "../../infrastructure/dropship-ebay-listing-end.adapter";
import type { DropshipMarketplaceCredentialRepository, DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";
import { publishedInspection } from "../fixtures/listing-end-inspection.fixture";

/**
 * The end worker's eBay and inventory composition (PLAN-C v4.1 §5.5, §5.8; FID-8, FID-10): the token owner's
 * operation, the admission with the store's environment, the strict reconcile scope, the inspection owner and the
 * withdraw through the shared eBay client over a stubbed fetch. Nothing reaches eBay or a database.
 */
const STORE = 22;
const VENDOR = 10;

function storedCredential(overrides: Partial<DropshipMarketplaceStoreCredentials> = {}): DropshipMarketplaceStoreCredentials {
  return { vendorId: VENDOR, storeConnectionId: STORE, platform: "ebay", status: "connected", shopDomain: null, externalAccountId: "seller-22",
    providerEnvironment: "production", externalAccountIdentityScheme: "provider_user_id", externalAccountVerifiedAt: new Date("2026-10-01T00:00:00Z"),
    externalDisplayName: "Card Shop", config: {}, accessToken: "secret-access-token", accessTokenRef: "dst_ebay_access_1",
    accessTokenExpiresAt: new Date("2026-10-26T12:00:00Z"), refreshToken: "secret-refresh", refreshTokenRef: "dst_ebay_refresh_1",
    refreshTokenExpiresAt: null, ...overrides };
}

const passThroughAdmission: EbayQuantityRequestAdmission = {
  item: async (_sku, work) => work(null),
  group: async (_key, _skus, work) => work(null),
  reducing: async (_identity, work) => work(),
};

function adapter(overrides: Partial<ConstructorParameters<typeof DropshipEbayListingEndAdapter>[0]> = {}) {
  const loads: unknown[] = [];
  const admissions: unknown[] = [];
  const authFailures: unknown[] = [];
  const inspections: unknown[] = [];
  const reconciles: unknown[] = [];
  const credentialRepository = { recordAuthFailure: vi.fn(async (input: unknown) => { authFailures.push(input); return {} as never; }) } as
    unknown as DropshipMarketplaceCredentialRepository;
  const instance = new DropshipEbayListingEndAdapter({
    credentials: { loadFreshForStoreConnection: async (input) => { loads.push(input); return storedCredential(); } },
    credentialRepository,
    inspector: { inspectExistingPublication: async (input) => { inspections.push(input); return publishedInspection(); } },
    recovery: { reconcile: async (scopes) => { reconciles.push(scopes); return { resolved: [], unresolved: [], busy: false }; } },
    createAdmission: (input) => { admissions.push(input); return passThroughAdmission; },
    ...overrides,
  });
  return { instance, loads, admissions, authFailures, inspections, reconciles };
}

/** The shared EbayApiClient over a stubbed fetch: the offer read, then the withdraw answered as `withdraw` says. */
function stubbedClient(withdraw: () => Promise<Response>): { create: CreateDropshipListingEndClient; requests: string[] } {
  const requests: string[] = [];
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/withdraw")) return withdraw();
    return new Response(JSON.stringify({ offerId: "OFFER-101", sku: "CS-TOP-101", status: "PUBLISHED" }), { status: 200,
      headers: { "content-type": "application/json" } });
  });
  return {
    requests,
    create: (input) => new EbayApiClient({ getAccessToken: async () => input.accessToken }, input.storeConnectionId, input.environment,
      { quantityAdmission: async () => input.admission, request: fetchStub as unknown as typeof fetch }),
  };
}

describe("DropshipEbayListingEndAdapter", () => {
  it("loads the store's credential for the operation listing_end, passing a rejected token on", async () => {
    const { instance, loads } = adapter();
    const credential = await instance.loadCredential({ vendorId: VENDOR, storeConnectionId: STORE, rejectedAccessTokenRef: "dst_old" });
    expect(LISTING_END_CREDENTIAL_OPERATION).toBe("listing_end");
    expect(loads).toEqual([{ vendorId: VENDOR, storeConnectionId: STORE, operation: "listing_end", rejectedAccessTokenRef: "dst_old" }]);
    expect(credential).toMatchObject({ externalAccountId: "seller-22", environment: "production", accessTokenRef: "dst_ebay_access_1" });
    // The token never reaches the worker's view or its JSON.
    expect(JSON.stringify(credential)).not.toContain("secret");
    expect(Object.keys(credential)).not.toContain("accessToken");
  });

  it("refuses a credential of another store, and reports an unresolvable environment as null (account check fails it)", async () => {
    const other = adapter({ credentials: { loadFreshForStoreConnection: async () => storedCredential({ storeConnectionId: 99 }) } });
    await expect(other.instance.loadCredential({ vendorId: VENDOR, storeConnectionId: STORE })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_CREDENTIAL_OWNER_MISMATCH" });
    const noEnvironment = adapter({ credentials: { loadFreshForStoreConnection: async () => storedCredential({ providerEnvironment: null }) } });
    expect((await noEnvironment.instance.loadCredential({ vendorId: VENDOR, storeConnectionId: STORE })).environment).toBeNull();
    const sandbox = adapter({ credentials: { loadFreshForStoreConnection: async () => storedCredential({ providerEnvironment: "sandbox" }) } });
    expect((await sandbox.instance.loadCredential({ vendorId: VENDOR, storeConnectionId: STORE })).environment).toBe("sandbox");
  });

  it("inspects with a Dropship owner and the SKU as an observation-only candidate", async () => {
    const { instance, inspections } = adapter();
    await instance.inspect({ storeConnectionId: STORE, productId: 20, productVariantId: 101, marketplaceId: "EBAY_US", sku: "CS-TOP-101" });
    expect(inspections).toEqual([{ owner: { kind: "dropship", storeConnectionId: STORE, productId: 20, provider: "ebay", marketplaceId: "EBAY_US" },
      memberCandidates: [{ productVariantId: 101, sku: "CS-TOP-101", isActive: true, availableQuantity: 0 }] }]);
  });

  it("reconciles the admission's own scope under the strict schema, and refuses any other (FID-8)", async () => {
    const { instance, reconciles } = adapter();
    const identity = parseListingEndResolvedIdentity({ destinationKind: "dropship_store_connection", connectionId: STORE, channelId: null,
      vendorId: VENDOR, provider: "ebay", accountId: "seller-22", environment: "production", market: "EBAY_US", productId: 20,
      productVariantId: 101, externalSku: "CS-TOP-101", externalProductId: "1100", externalVariantId: "OFFER-101",
      externalInventoryItemId: null, identityConflict: false });
    await instance.reconcile(listingEndQuantityScope(identity));
    expect(reconciles).toEqual([[{ destinationKind: "dropship_store_connection", connectionId: STORE, providerKey: "ebay",
      providerScopeType: "account", externalScopeId: "seller-22", externalInventoryItemId: "CS-TOP-101", productId: null, productVariantId: null }]]);
    expect(() => instance.reconcile({ ...listingEndQuantityScope(identity), productId: 20 } as never)).toThrow();
  });

  it("composes the Dropship admission with the store's environment and withdraws the exact offer through the shared client", async () => {
    const client = stubbedClient(async () => new Response(null, { status: 204 }));
    const { instance, admissions } = adapter({ createClient: client.create });
    const credential = await instance.loadCredential({ vendorId: VENDOR, storeConnectionId: STORE });
    expect(await instance.withdraw({ credential, storeConnectionId: STORE, offerId: "OFFER-101" })).toEqual({ outcome: "ok" });
    expect(admissions).toEqual([{ storeConnectionId: STORE, externalAccountId: "seller-22",
      externalAccountVerifiedAt: new Date("2026-10-01T00:00:00Z"), providerEnvironment: "production" }]);
    expect(client.requests).toEqual(["GET /sell/inventory/v1/offer/OFFER-101", "POST /sell/inventory/v1/offer/OFFER-101/withdraw"]);
  });

  it.each([
    [async () => new Response(JSON.stringify({ errors: [{ errorId: 1001, category: "REQUEST" }] }), { status: 429 }),
      { outcome: "rejected", rejectionCode: "EBAY_PROVIDER_RATE_LIMITED", status: 429 }],
    [async () => new Response(JSON.stringify({ errors: [{ errorId: 1001, category: "REQUEST" }] }), { status: 401 }),
      { outcome: "rejected", rejectionCode: "EBAY_AUTH_REQUIRED", status: 401 }],
    [async () => new Response(JSON.stringify({ errors: [{ errorId: 25002, category: "REQUEST" }] }), { status: 400 }),
      { outcome: "rejected", rejectionCode: "EBAY_QUANTITY_REJECTED", status: 400 }],
    [async () => new Response("", { status: 500 }), { outcome: "uncertain", status: 500 }],
    [async () => { throw new TypeError("fetch failed"); }, { outcome: "network" }],
  ] as const)("classifies the one withdraw attempt (%#)", async (answer, expected) => {
    const client = stubbedClient(answer as () => Promise<Response>);
    const { instance } = adapter({ createClient: client.create });
    const credential = await instance.loadCredential({ vendorId: VENDOR, storeConnectionId: STORE });
    expect(await instance.withdraw({ credential, storeConnectionId: STORE, offerId: "OFFER-101" })).toMatchObject(expected);
    // One HTTP attempt, never replayed.
    expect(client.requests.filter((request) => request.endsWith("/withdraw"))).toHaveLength(1);
  });

  it("answers an admission refusal as nothing sent, whether at composition or inside the client", async () => {
    const unverified = adapter({ createAdmission: () => { throw new QuantityPublicationAdmissionError("PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED", "x"); } });
    const credential = await unverified.instance.loadCredential({ vendorId: VENDOR, storeConnectionId: STORE });
    expect(await unverified.instance.withdraw({ credential, storeConnectionId: STORE, offerId: "OFFER-101" }))
      .toEqual({ outcome: "admission", code: "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED", context: {} });
    const busy: EbayQuantityRequestAdmission = { ...passThroughAdmission,
      reducing: async () => { throw new QuantityPublicationAdmissionError("PUBLICATION_SCOPE_BUSY", "busy", { scope: "x" }); } };
    const client = stubbedClient(async () => new Response(null, { status: 204 }));
    const refused = adapter({ createAdmission: () => busy, createClient: client.create });
    const loaded = await refused.instance.loadCredential({ vendorId: VENDOR, storeConnectionId: STORE });
    expect(await refused.instance.withdraw({ credential: loaded, storeConnectionId: STORE, offerId: "OFFER-101" }))
      .toEqual({ outcome: "admission", code: "PUBLICATION_SCOPE_BUSY", context: { scope: "x" } });
    expect(client.requests.filter((request) => request.endsWith("/withdraw"))).toEqual([]);
  });

  it.each([
    ["a 401 on the offer read before the send", async () => new Response(JSON.stringify({ errors: [{ errorId: 1001 }] }), { status: 401 }),
      { outcome: "not_sent", status: 401 }],
    ["a 404 on the offer read before the send", async () => new Response(JSON.stringify({ errors: [{ errorId: 25713 }] }), { status: 404 }),
      { outcome: "not_sent", status: 404 }],
    // The protocol's own refusal of an unproven member is an admission refusal (PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN), as before.
    ["an offer read that names no SKU", async () => new Response(JSON.stringify({ offerId: "OFFER-101" }), { status: 200 }),
      { outcome: "admission", code: "PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN" }],
  ] as const)("answers %s as nothing sent, never as uncertain (WRK-4)", async (_label, offerRead, expected) => {
    const requests: string[] = [];
    const reached: string[] = [];
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/withdraw")) return new Response(null, { status: 204 });
      return offerRead();
    });
    const admission: EbayQuantityRequestAdmission = { ...passThroughAdmission,
      reducing: async (identity, work) => { reached.push(identity); return work(); } };
    const { instance } = adapter({ createAdmission: () => admission,
      createClient: (input) => new EbayApiClient({ getAccessToken: async () => input.accessToken }, input.storeConnectionId, input.environment,
        { quantityAdmission: async () => input.admission, request: fetchStub as unknown as typeof fetch }) });
    const credential = await instance.loadCredential({ vendorId: VENDOR, storeConnectionId: STORE });
    expect(await instance.withdraw({ credential, storeConnectionId: STORE, offerId: "OFFER-101" })).toMatchObject(expected);
    // The admission was never reached and nothing was posted to eBay.
    expect(reached).toEqual([]);
    expect(requests).toEqual(["GET /sell/inventory/v1/offer/OFFER-101"]);
  });

  it("treats any other error after admission as uncertain, never as not sent", () => {
    expect(classifyWithdrawError(Object.assign(new Error("evidence"), { code: "PUBLICATION_REQUEST_EVIDENCE_INCOMPLETE" })))
      .toEqual({ outcome: "uncertain", status: null, detail: { errorName: "Error", errorCode: "PUBLICATION_REQUEST_EVIDENCE_INCOMPLETE" } });
    expect(classifyWithdrawError("strange")).toMatchObject({ outcome: "uncertain" });
  });

  it("records a rejected access token against the credential this attempt loaded (FID-10)", async () => {
    const { instance, authFailures } = adapter();
    const credential = await instance.loadCredential({ vendorId: VENDOR, storeConnectionId: STORE });
    await instance.recordAccessTokenRejection({ credential, status: 401, failureCode: "DROPSHIP_LISTING_END_PROVIDER_THROTTLED",
      message: "rejected", now: new Date("2026-10-26T09:00:00Z") });
    expect(authFailures).toEqual([expect.objectContaining({ vendorId: VENDOR, storeConnectionId: STORE, status: "refresh_failed",
      statusCode: 401, invalidateAccessToken: true, expectedCredential: { accessTokenRef: "dst_ebay_access_1", refreshTokenRef: "dst_ebay_refresh_1" } })]);
    const foreign = { externalAccountId: "seller-22", externalAccountVerifiedAt: null, environment: "production" as const, accessTokenRef: "dst_x" };
    await expect(instance.recordAccessTokenRejection({ credential: foreign, status: 401, failureCode: "x", message: "x",
      now: new Date() })).rejects.toThrow("not loaded by this adapter");
  });
});
