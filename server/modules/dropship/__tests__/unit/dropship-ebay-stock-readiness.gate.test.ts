import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { DropshipEbayStockReadinessGate, type DropshipStockLinkLogger } from "../../infrastructure/dropship-ebay-stock-readiness.gate";
import type { DropshipMarketplaceListingPushRequest } from "../../application/dropship-marketplace-listing-push-provider";
import type { DropshipStockLinkCredential } from "../../application/dropship-ebay-stock-readiness-port";
import type { DropshipEbayStockReadinessInput, DropshipEbayStockReadinessResult } from "../../../inventory-planning/quantity-publication";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import { DROPSHIP_STOCK_LINK_REFUSAL_WORDS } from "../../../../../shared/dropship/stock-link-refusals";
import { DropshipError } from "../../domain/errors";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const COMMAND_KEY = "5e0f7f3c-2a4b-5c6d-8e9f-0a1b2c3d4e5f";

type Scripted = DropshipEbayStockReadinessResult | Error;

function request(intent: Partial<DropshipMarketplaceListingPushRequest["listingIntent"]> = {}): DropshipMarketplaceListingPushRequest {
  return {
    vendorId: 10, storeConnectionId: 22, jobId: 30, jobItemId: 40, listingId: 50, productVariantId: 101, platform: "ebay",
    existingExternalListingId: null, existingExternalOfferId: null, idempotencyKey: "push-1",
    listingIntent: {
      platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync", priceMode: "vendor_defined",
      productVariantId: 101, sku: "P5", title: "Pack", description: null, category: null, marketplaceCategoryId: "1",
      marketplaceCategoryName: null, storeCategoryNames: [], brand: null, gtin: null, mpn: null, condition: null, itemSpecifics: null,
      imageUrls: ["https://cdn.example.test/p5.jpg"], weightGrams: 10, priceCents: 999, quantity: 4, marketplaceConfig: {},
      ...intent,
    },
  };
}

function credential(patch: Partial<DropshipStockLinkCredential> = {}): DropshipStockLinkCredential {
  return { vendorId: 10, storeConnectionId: 22, platform: "ebay", externalAccountId: " seller-1 ",
    externalAccountIdentityScheme: "provider_user_id", externalAccountVerifiedAt: new Date("2026-05-01T00:00:00.000Z"), ...patch };
}

const resolved = (patch: Partial<{ variantId: number; sku: string; existingOfferId: string | null }> = {}) =>
  ({ offers: [{ variantId: 101, sku: "P5", existingOfferId: null, ...patch }], verifiedPublishedListingId: null });

const ready = (alreadyLinked: boolean): DropshipEbayStockReadinessResult => ({ status: "ready", commandKey: COMMAND_KEY,
  publicationTargetId: 7, linkedProductVariantIds: [101], alreadyLinked,
  mappingActions: [{ productVariantId: 101, mappingAction: alreadyLinked ? "none" : "create" }],
  preparation: null, fenceHoldMs: alreadyLinked ? null : 42 });
const blocked = (blockers: Array<{ code: string; productVariantId: number | null }>, targetCount = 1): DropshipEbayStockReadinessResult => ({
  status: "blocked", commandKey: COMMAND_KEY, publicationTargetId: targetCount === 1 ? 7 : null, targetCount,
  blockers: blockers.map(row => ({ ...row, message: "inventory detail", action: "configure_inventory" as const })) });
const coded = (code: string) => Object.assign(new Error(`inventory ${code}`), { code });

function setup(options: { authority?: "legacy" | "canonical" | Error; authorityScript?: Array<"legacy" | "canonical" | Error>;
  script?: Scripted[]; owned?: boolean; requestedBy?: string | null } = {}) {
  const logs: Array<DropshipLogEvent & { level: string }> = [];
  const sleeps: number[] = [];
  const ensureCalls: Array<{ input: DropshipEbayStockReadinessInput; options: { actor: string; now: Date; requestedBy?: string } }> = [];
  const queries: unknown[][] = [];
  const script = [...(options.script ?? [])];
  const authorityScript = [...(options.authorityScript ?? [])];
  let authorityReads = 0;
  const logger: DropshipStockLinkLogger = {
    debug: event => logs.push({ level: "debug", ...event }), info: event => logs.push({ level: "info", ...event }),
    warn: event => logs.push({ level: "warn", ...event }), error: event => logs.push({ level: "error", ...event }),
  };
  const database = { query: async (_sql: string, values: unknown[]) => {
    queries.push(values);
    return { rows: options.owned === false ? [] : [{ product_id: 20, requested_by: options.requestedBy === undefined ? "member-7" : options.requestedBy }] };
  } } as unknown as Pick<Pool, "query">;
  const gate = new DropshipEbayStockReadinessGate({
    readAuthority: async () => {
      authorityReads += 1;
      const authority = authorityScript.length > 0 ? authorityScript.shift()! : options.authority ?? "canonical";
      if (authority instanceof Error) throw authority;
      return authority;
    },
    ensure: async (input, ensureOptions) => {
      ensureCalls.push({ input, options: ensureOptions });
      const next = script.shift();
      if (!next) throw new Error("No scripted stock link outcome.");
      if (next instanceof Error) throw next;
      return next;
    },
    database, clock: { now: () => NOW }, sleep: async ms => { sleeps.push(ms); }, logger,
  });
  return { gate, logs, sleeps, ensureCalls, queries, authorityReads: () => authorityReads };
}

/** node-postgres's own errors for a lost or unavailable connection: no SQLSTATE (review CF-1). */
const connectionTerminated = () => new Error("Connection terminated unexpectedly");
const poolConnectTimeout = () => new Error("timeout exceeded when trying to connect");

async function refusal(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

describe("DropshipEbayStockReadinessGate.begin", () => {
  it("under legacy authority checks nothing else: an unverified store and a foreign listing produce no new code", async () => {
    const { gate, ensureCalls, queries, logs } = setup({ authority: "legacy", owned: false });
    await expect(gate.begin({ request: request(), credential: credential({ externalAccountIdentityScheme: null, externalAccountVerifiedAt: null }) }))
      .resolves.toEqual({ authority: "legacy", mustLink: false });
    await expect(gate.begin({ request: request({ listingMode: "draft_first", quantity: 9 }), credential: credential() }))
      .resolves.toEqual({ authority: "legacy", mustLink: false });
    expect(ensureCalls).toHaveLength(0);
    expect(queries).toHaveLength(0);
    expect(logs.map(log => [log.level, log.context?.outcome])).toEqual([["debug", "not_applicable"], ["debug", "not_applicable"]]);
  });

  it("under canonical authority links only a live managed push", async () => {
    const { gate } = setup();
    await expect(gate.begin({ request: request(), credential: credential() })).resolves.toEqual({ authority: "canonical", mustLink: true });
  });

  it.each([["draft_first", "managed_quantity_sync"], ["live", "manual_quantity"], ["manual_only", "managed_quantity_sync"], ["live", "disabled"]] as const)(
    "refuses a positive %s/%s push before any eBay call, and lets a zero-quantity one through", async (listingMode, inventoryMode) => {
      const { gate, logs, ensureCalls } = setup();
      const error = await refusal(gate.begin({ request: request({ listingMode, inventoryMode, quantity: 5 }), credential: credential() }));
      expect(error).toMatchObject({ code: "DROPSHIP_STOCK_MODE_NOT_MANAGED",
        message: "Card Shellz only lists items with stock on eBay stores set to live listings with Card Shellz-managed quantity.",
        context: { retryable: false, classification: "permanent", needsOperator: false, listingMode, inventoryMode } });
      expect(logs.at(-1)).toMatchObject({ level: "info", context: { outcome: "refused", error_code: "DROPSHIP_STOCK_MODE_NOT_MANAGED",
        job_id: 30, job_item_id: 40, listing_id: 50 } });
      await expect(gate.begin({ request: request({ listingMode, inventoryMode, quantity: 0 }), credential: credential() }))
        .resolves.toEqual({ authority: "canonical", mustLink: false });
      expect(ensureCalls).toHaveLength(0);
    });

  it("waits out a lost database connection while reading the authority, then proceeds exactly as legacy (review CF-1)", async () => {
    const { gate, sleeps, ensureCalls, queries, logs, authorityReads } = setup({ authorityScript: [poolConnectTimeout(), connectionTerminated(), "legacy"] });
    await expect(gate.begin({ request: request(), credential: credential({ externalAccountIdentityScheme: null }) }))
      .resolves.toEqual({ authority: "legacy", mustLink: false });
    expect(authorityReads()).toBe(3);
    expect(sleeps).toEqual([500, 2_000]);
    expect(ensureCalls).toHaveLength(0);
    expect(queries).toHaveLength(0);
    expect(logs.map(log => [log.level, log.context?.outcome, log.context?.inventory_code])).toEqual([
      ["debug", "retry", "DATABASE_UNAVAILABLE"], ["debug", "retry", "DATABASE_UNAVAILABLE"], ["debug", "not_applicable", null]]);
  });

  it("gives up on an authority read the database never answers with DROPSHIP_STOCK_LINK_BUSY, retryable, not an operator failure", async () => {
    const { gate, sleeps, logs } = setup({ authority: connectionTerminated() });
    expect(await refusal(gate.begin({ request: request(), credential: credential() }))).toMatchObject({
      code: "DROPSHIP_STOCK_LINK_BUSY", context: { retryable: true, classification: "transient", needsOperator: false,
        inventoryCode: "DATABASE_UNAVAILABLE", attempt: 4 } });
    expect(sleeps).toEqual([500, 2_000, 5_000]);
    expect(logs.at(-1)).toMatchObject({ level: "warn", context: { outcome: "gave_up", error_code: "DROPSHIP_STOCK_LINK_BUSY" } });
  });

  it("fails closed when the authority is unknown", async () => {
    const { gate, logs } = setup({ authority: coded("PUBLICATION_AUTHORITY_MISSING") });
    expect(await refusal(gate.begin({ request: request(), credential: credential() }))).toMatchObject({
      code: "DROPSHIP_STOCK_LINK_FAILED", context: { retryable: false, classification: "fatal", needsOperator: true,
        inventoryCode: "PUBLICATION_AUTHORITY_MISSING" } });
    expect(logs.at(-1)?.level).toBe("error");
  });
});

describe("DropshipEbayStockReadinessGate.ensureLinked", () => {
  const link = (gate: DropshipEbayStockReadinessGate, patch: Partial<Parameters<DropshipEbayStockReadinessGate["ensureLinked"]>[0]> = {}) =>
    gate.ensureLinked({ request: request(), credential: credential(), environment: "production", sku: "P5", resolved: resolved(), ...patch });

  it("asks inventory for exactly this listing push's link, as the push actor", async () => {
    const { gate, ensureCalls, queries } = setup({ script: [ready(false)], requestedBy: `  ${"m".repeat(120)}  ` });
    await link(gate, { resolved: resolved({ existingOfferId: "offer-9" }) });
    expect(queries).toEqual([[50, 10, 22, 101, 40, 30]]);
    expect(ensureCalls).toEqual([{
      input: { vendorId: 10, storeConnectionId: 22, accountId: "seller-1", environment: "production", productId: 20, purpose: "publish",
        variants: [{ productVariantId: 101, sku: "P5" }], origin: { kind: "listing_push", jobId: 30, jobItemId: 40, listingId: 50 } },
      options: { actor: "system:dropship-listing-push", now: NOW, requestedBy: "m".repeat(100) },
    }]);
  });

  it("logs a new link at INFO with the full correlation and the fence hold, and an existing one at DEBUG", async () => {
    const { gate, logs } = setup({ script: [ready(false), ready(true)], requestedBy: null });
    await link(gate, { resolved: resolved({ existingOfferId: "offer-9" }) });
    await link(gate);
    expect(logs[0]).toMatchObject({ level: "info", code: "DROPSHIP_STOCK_LINK_ENSURE", context: {
      action: "dropship.stock_link.ensure", outcome: "linked", vendor_id: 10, store_connection_id: 22, job_id: 30, job_item_id: 40,
      listing_id: 50, product_id: 20, product_variant_id: 101, publication_target_id: 7, command_key: COMMAND_KEY,
      external_offer_id: "offer-9", fence_hold_ms: 42, before: { mappingActions: [{ productVariantId: 101, mappingAction: "create" }] },
      after: { linkedProductVariantIds: [101] }, error_code: null } });
    expect(logs[1]).toMatchObject({ level: "debug", context: { outcome: "already_linked", fence_hold_ms: null } });
  });

  it("returns quietly when authority moved to legacy after begin", async () => {
    const { gate, logs } = setup({ script: [{ status: "not_applicable", reason: "legacy_authority" }] });
    await expect(link(gate)).resolves.toBeUndefined();
    expect(logs).toEqual([expect.objectContaining({ level: "debug", context: expect.objectContaining({ outcome: "not_applicable" }) })]);
  });

  it.each([
    [[{ code: "STOCK_LISTING_TARGET_MISMATCH", productVariantId: null }], 0, "DROPSHIP_STOCK_DESTINATION_NOT_READY", "error"],
    [[{ code: "STOCK_LISTING_TARGET_MISMATCH", productVariantId: null }], 2, "DROPSHIP_STOCK_DESTINATION_DUPLICATED", "error"],
    [[{ code: "PUBLICATION_DESTINATION_NOT_LIVE", productVariantId: null }], 0, "DROPSHIP_STOCK_DESTINATION_NOT_READY", "error"],
    [[{ code: "STOCK_LISTING_QUANTITY_UNAVAILABLE", productVariantId: 101 }], 1, "DROPSHIP_STOCK_ITEM_NOT_READY", "error"],
    [[{ code: "STOCK_LISTING_HELD", productVariantId: null }], 1, "DROPSHIP_STOCK_STORE_ON_HOLD", "info"],
    [[{ code: "STOCK_LISTING_HELD", productVariantId: 101 }], 1, "DROPSHIP_STOCK_ITEM_ON_HOLD", "info"],
    [[{ code: "STOCK_LISTING_ACCOUNT_CHANGED", productVariantId: null }], 1, "DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED", "warn"],
    [[{ code: "STOCK_LISTING_MAPPING_CONFLICT", productVariantId: 101 }], 1, "DROPSHIP_STOCK_SKU_LINK_CONFLICT", "error"],
    [[{ code: "STOCK_LISTING_MAPPING_REVIEW_REQUIRED", productVariantId: 101 }], 1, "DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU", "error"],
    [[{ code: "STOCK_MAPPING_COMMAND_CONFLICT", productVariantId: null }], 0, "DROPSHIP_STOCK_SKU_CHANGED", "info"],
    [[{ code: "STOCK_MAPPING_LINK_CHANGED_AFTER_APPLY", productVariantId: null }], 1, "DROPSHIP_STOCK_LINK_CHANGED", "warn"],
    [[{ code: "STOCK_LISTING_NOT_SELECTED", productVariantId: 101 }], 1, "DROPSHIP_STOCK_NOT_OFFERED", "info"],
  ] as const)("a blocked %o (targetCount %i) fails the push with %s, logged at %s, without retrying", async (blockers, targetCount, code, level) => {
    const { gate, logs, sleeps, ensureCalls } = setup({ script: [blocked([...blockers], targetCount)] });
    const error = await refusal(link(gate));
    const reason = DROPSHIP_STOCK_LINK_REFUSAL_WORDS[code].reason;
    expect(error).toMatchObject({ code, message: reason[0]!.toUpperCase() + reason.slice(1), context: {
      source: "dropship_stock_link", retryable: false, classification: "permanent", inventoryCode: blockers[0]!.code, targetCount,
      command_key: COMMAND_KEY } });
    expect(ensureCalls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ level, context: { outcome: "refused", error_code: code, inventory_code: blockers[0]!.code,
      target_count: targetCount, job_item_id: 40, command_key: COMMAND_KEY } });
  });

  it("files a global stop as retryable for the automatic re-queue, without an in-process retry", async () => {
    const { gate, sleeps } = setup({ script: [blocked([{ code: "STOCK_LISTING_GLOBAL_STOP", productVariantId: null }])] });
    expect(await refusal(link(gate))).toMatchObject({ code: "DROPSHIP_STOCK_UPDATES_PAUSED",
      context: { retryable: true, classification: "transient" } });
    expect(sleeps).toEqual([]);
  });

  it("retries a transient failure with the bounded backoff and succeeds on the fourth attempt", async () => {
    const { gate, sleeps, ensureCalls, logs } = setup({ script: [coded("STOCK_MAPPING_PROVIDER_BUSY"), coded("40001"),
      blocked([{ code: "CANONICAL_AUTHORITY_REQUIRED", productVariantId: null }]), ready(false)] });
    await expect(link(gate)).resolves.toBeUndefined();
    expect(sleeps).toEqual([500, 2_000, 5_000]);
    expect(ensureCalls).toHaveLength(4);
    expect(logs.filter(log => log.context?.outcome === "retry").map(log => [log.level, log.context?.inventory_code, log.context?.attempt]))
      .toEqual([["debug", "STOCK_MAPPING_PROVIDER_BUSY", 1], ["debug", "40001", 2], ["debug", "CANONICAL_AUTHORITY_REQUIRED", 3]]);
  });

  it("gives up after four transient attempts with DROPSHIP_STOCK_LINK_BUSY, retryable, logged at WARN", async () => {
    const { gate, sleeps, logs } = setup({ script: [coded("55P03"), coded("55P03"), coded("55P03"), coded("STOCK_MAPPING_CONCURRENT_CHANGE")] });
    const error = await refusal(link(gate));
    expect(error).toMatchObject({ code: "DROPSHIP_STOCK_LINK_BUSY",
      message: "Card Shellz stock for this item was being updated at the same moment.",
      context: { retryable: true, classification: "transient", needsOperator: false, inventoryCode: "STOCK_MAPPING_CONCURRENT_CHANGE",
        attempt: 4, attempts: 4 } });
    expect(sleeps).toEqual([500, 2_000, 5_000]);
    expect(logs.at(-1)).toMatchObject({ level: "warn", context: { outcome: "gave_up", error_code: "DROPSHIP_STOCK_LINK_BUSY" } });
  });

  it("retries a link that loses its database connection, and files it retryable once the retries are spent (review CF-1)", async () => {
    const { gate, sleeps, ensureCalls, logs } = setup({ script: [connectionTerminated(), poolConnectTimeout(),
      Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }), connectionTerminated()] });
    const error = await refusal(link(gate));
    expect(error).toMatchObject({ code: "DROPSHIP_STOCK_LINK_BUSY", context: { retryable: true, classification: "transient",
      needsOperator: false, inventoryCode: "DATABASE_UNAVAILABLE", attempts: 4 } });
    expect(ensureCalls).toHaveLength(4);
    expect(sleeps).toEqual([500, 2_000, 5_000]);
    expect(logs.some(log => log.level === "error")).toBe(false);
  });

  it("stops at once on a fatal failure: DROPSHIP_STOCK_LINK_FAILED, an operator problem, logged at ERROR", async () => {
    const { gate, sleeps, logs } = setup({ script: [coded("STOCK_MAPPING_PREPARATION_RECEIPT_INVALID")] });
    expect(await refusal(link(gate))).toMatchObject({ code: "DROPSHIP_STOCK_LINK_FAILED",
      context: { retryable: false, classification: "fatal", needsOperator: true, inventoryCode: "STOCK_MAPPING_PREPARATION_RECEIPT_INVALID" } });
    expect(sleeps).toEqual([]);
    expect(logs.at(-1)?.level).toBe("error");
  });

  it.each([
    ["no verified scheme", { externalAccountIdentityScheme: null }],
    ["no verification time", { externalAccountVerifiedAt: null }],
    ["a blank account id", { externalAccountId: "  " }],
    ["another store's credential", { storeConnectionId: 23 }],
  ])("refuses %s as DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED without calling inventory", async (_name, patch) => {
    const { gate, ensureCalls } = setup({ script: [ready(false)] });
    expect(await refusal(link(gate, { credential: credential(patch) }))).toMatchObject({
      code: "DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED", message: "Card Shellz couldn't confirm which eBay account this store is connected to.",
      context: { retryable: false, needsOperator: false } });
    expect(ensureCalls).toHaveLength(0);
  });

  it.each([
    ["two discovered offers", resolved(), { resolved: { offers: [...resolved().offers, { variantId: 102, sku: "P6", existingOfferId: null }], verifiedPublishedListingId: null } }],
    ["another variant", resolved({ variantId: 102 }), {}],
    ["another SKU", resolved({ sku: "P6" }), {}],
  ])("refuses %s as DROPSHIP_STOCK_SKU_CHANGED without calling inventory", async (_name, offers, extra) => {
    const { gate, ensureCalls, queries } = setup({ script: [ready(false)] });
    expect(await refusal(link(gate, { resolved: offers, ...extra }))).toMatchObject({ code: "DROPSHIP_STOCK_SKU_CHANGED",
      context: { retryable: false } });
    expect(ensureCalls).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });

  // Review TW-1: an automatic re-send (owner Q4, plan 2.10) never adopts a published eBay listing this listing did
  // not record; the account-check recovery has the same rule (dropship-listing-push-ops.repository.ts, live listings only).
  it("refuses an automatic re-send that found a published eBay listing this listing never recorded, before any write", async () => {
    const { gate, ensureCalls, queries, logs } = setup({ script: [ready(false)] });
    const error = await refusal(link(gate, { request: { ...request(), automaticRetry: true },
      resolved: { offers: [{ variantId: 101, sku: "P5", existingOfferId: "vendor-offer" }], verifiedPublishedListingId: "vendor-listing" } }));
    expect(error).toMatchObject({ code: "DROPSHIP_STOCK_RESEND_LISTING_FOUND",
      message: "eBay already has a published listing with this SKU in your store, so Card Shellz did not send this listing again automatically.",
      context: { retryable: false, classification: "permanent", needsOperator: false,
        inventoryCode: "DROPSHIP_STOCK_UNRECORDED_PUBLISHED_LISTING", verifiedPublishedListingId: "vendor-listing" } });
    expect(ensureCalls).toHaveLength(0);
    expect(queries).toHaveLength(0);
    expect(logs.at(-1)).toMatchObject({ level: "warn", context: { outcome: "refused", error_code: "DROPSHIP_STOCK_RESEND_LISTING_FOUND",
      external_offer_id: "vendor-offer", job_item_id: 40 } });
  });

  it("runs only the adoption check, with no inventory call, for an automatic re-queue of a push that needs no link", async () => {
    const { gate, ensureCalls, queries } = setup({ script: [ready(false)] });
    expect(await refusal(link(gate, { request: { ...request({ listingMode: "draft_first", quantity: 0 }), automaticRetry: true }, linkStock: false,
      resolved: { offers: [{ variantId: 101, sku: "P5", existingOfferId: "vendor-offer" }], verifiedPublishedListingId: "vendor-listing" } })))
      .toMatchObject({ code: "DROPSHIP_STOCK_RESEND_LISTING_FOUND" });
    await expect(link(gate, { request: { ...request({ listingMode: "draft_first", quantity: 0 }), automaticRetry: true }, linkStock: false }))
      .resolves.toBeUndefined();
    expect(ensureCalls).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });

  it.each([
    ["an automatic re-send of the listing's own recorded eBay listing", { automaticRetry: true, existingExternalListingId: "listing-1" }, "listing-1"],
    ["an automatic re-send with no published listing yet", { automaticRetry: true }, null],
    ["the vendor's own push adopting a published listing (unchanged, plan R12)", {}, "vendor-listing"],
  ] as const)("links %s", async (_name, patch, verifiedPublishedListingId) => {
    const { gate, ensureCalls } = setup({ script: [ready(false)] });
    await expect(link(gate, { request: { ...request(), ...patch },
      resolved: { offers: [{ variantId: 101, sku: "P5", existingOfferId: "offer-9" }], verifiedPublishedListingId } })).resolves.toBeUndefined();
    expect(ensureCalls).toHaveLength(1);
  });

  it("refuses a listing, job item or job that no longer belongs to this vendor's store variant", async () => {
    const { gate, ensureCalls } = setup({ owned: false, script: [ready(false)] });
    expect(await refusal(link(gate))).toMatchObject({ code: "DROPSHIP_STOCK_SKU_CHANGED",
      context: { inventoryCode: "DROPSHIP_STOCK_LISTING_OWNERSHIP_MISMATCH" } });
    expect(ensureCalls).toHaveLength(0);
  });
});
