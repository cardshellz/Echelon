import { describe, expect, it, vi } from "vitest";

// Channels PR2 (PLAN-CH2 v4.1 §4.3 steps 0, 5, 9, 11): the Shopify command policy's own rules: the fast-path predicate
// (also the final assert), the one audit action per command, and the re-confirmation of the reads under lock. The
// transaction itself is pinned over PostgreSQL (stock-link.integration.test.ts, PG 2-26).
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

import type { StockLinkSizeDecision } from "../../domain/stock-link";
import {
  assertStockLinkConfirmation, runShopifyStockLinkCommand, stockLinkCommandAction, stockLinkCommandHolds,
} from "../../infrastructure/stock-link-shopify-command";

const member = (overrides: Partial<StockLinkSizeDecision> = {}): StockLinkSizeDecision => ({ productVariantId: 101, productId: 20,
  change: "link", status: "linked", code: null, retry: null, link: { itemId: "222", storeSku: "P5", mappingAction: "create", draft: null },
  replacesMappingId: null, expectedHeadRevision: "0", cardShellzSku: "P5", selectionAction: "publish", waitingItemId: null,
  dueNextTick: false, recordObservedSku: null, detail: null, rule: "L10", ...overrides });
const retire = member({ productVariantId: 102, change: "retire", status: "waiting", code: "STOCK_LINK_NOT_LISTED", link: null,
  replacesMappingId: 62, expectedHeadRevision: "3", rule: "V2/L5" });
const head = (activeMappingId: number | null, activeItemId: string | null) => ({ activeMappingId, activeItemId });

describe("stockLinkCommandHolds (fast path and final assert)", () => {
  it("holds when each linking size has the chosen item active and each retiring size has no active version", () => {
    expect(stockLinkCommandHolds([member(), retire], new Map([[101, head(70, "222")], [102, head(null, null)]]))).toBe(true);
  });

  it("compares the saved item normalised: a gid of the chosen item is the same item", () => {
    expect(stockLinkCommandHolds([member()], new Map([[101, head(70, "gid://shopify/InventoryItem/222")]]))).toBe(true);
    expect(stockLinkCommandHolds([member()], new Map([[101, head(70, "gid://shopify/ProductVariant/222")]]))).toBe(false);
  });

  it("does not hold while the version a relink replaces is still active (a gid → decimal relink, V10)", () => {
    const v10 = member({ change: "relink", replacesMappingId: 61, rule: "V10" });
    expect(stockLinkCommandHolds([v10], new Map([[101, head(61, "gid://shopify/InventoryItem/222")]]))).toBe(false);
    expect(stockLinkCommandHolds([v10], new Map([[101, head(71, "222")]]))).toBe(true);
  });

  it("does not hold for another item, a missing head, or a retire whose head still has (any) active version", () => {
    expect(stockLinkCommandHolds([member()], new Map([[101, head(70, "223")]]))).toBe(false);
    expect(stockLinkCommandHolds([member()], new Map())).toBe(false);
    expect(stockLinkCommandHolds([retire], new Map([[102, head(62, "223")]]))).toBe(false);
    expect(stockLinkCommandHolds([retire], new Map([[102, head(80, "224")]]))).toBe(false);
    expect(stockLinkCommandHolds([retire], new Map())).toBe(true);
  });
});

describe("stockLinkCommandAction (one stock_link audit action per command)", () => {
  it("names a relink anywhere, else a retire, else a first link", () => {
    expect(stockLinkCommandAction([member()])).toBe("linked");
    expect(stockLinkCommandAction([member(), retire])).toBe("retired");
    expect(stockLinkCommandAction([member(), retire, member({ productVariantId: 103, change: "relink", replacesMappingId: 63 })])).toBe("relinked");
  });
});

describe("assertStockLinkConfirmation (§4.3 step 5)", () => {
  const input = { publicationTargetId: 9, readFingerprint: "a".repeat(64),
    members: [{ productVariantId: 101, cardShellzSku: "P5" }, { productVariantId: 102, cardShellzSku: null }] };
  const confirmation = (overrides: { fingerprint?: string; skus?: Array<{ productVariantId: number; cardShellzSku: string | null }> } = {}) => ({
    fingerprint: overrides.fingerprint ?? "a".repeat(64),
    skus: overrides.skus ?? [{ productVariantId: 101, cardShellzSku: " P5 " }, { productVariantId: 102, cardShellzSku: "  " }] });

  it("accepts the same credentials and SKUs (trimmed; a blank SKU stays blank)", () => {
    expect(() => assertStockLinkConfirmation(input, confirmation())).not.toThrow();
  });

  it("refuses STOCK_LINK_CONNECTION_CHANGED when the stored credentials are not the ones the store was read with", () => {
    expect(() => assertStockLinkConfirmation(input, confirmation({ fingerprint: "b".repeat(64) })))
      .toThrow(expect.objectContaining({ code: "STOCK_LINK_CONNECTION_CHANGED", errorClass: "transient" }));
  });

  it.each([
    ["another SKU", [{ productVariantId: 101, cardShellzSku: "P6" }, { productVariantId: 102, cardShellzSku: null }]],
    ["the same SKU in another case", [{ productVariantId: 101, cardShellzSku: "p5" }, { productVariantId: 102, cardShellzSku: null }]],
    ["a blank SKU that got one", [{ productVariantId: 101, cardShellzSku: "P5" }, { productVariantId: 102, cardShellzSku: "NEW" }]],
    ["a size whose variant is gone", [{ productVariantId: 101, cardShellzSku: "P5" }]],
  ])("refuses STOCK_LINK_SKU_CHANGED_SINCE_READ for %s", (_name, skus) => {
    expect(() => assertStockLinkConfirmation(input, confirmation({ skus })))
      .toThrow(expect.objectContaining({ code: "STOCK_LINK_SKU_CHANGED_SINCE_READ", errorClass: "transient" }));
  });
});

describe("runShopifyStockLinkCommand input", () => {
  const request = (overrides: Record<string, unknown> = {}) => ({ destination: { publicationTargetId: 9, destinationKind: "channel_connection",
    providerKey: "shopify", channelId: 35, channelConnectionId: 7, dropshipStoreConnectionId: null, providerScopeType: "location",
    externalScopeId: "98765", targetRevision: "4" }, command: { productId: 20, purpose: "publish", members: [member()], freedItemIds: [] },
  claims: [{ productVariantId: 101, leaseToken: "00000000-0000-4000-8000-000000000001", revision: "2" }],
  evidence: { observedAt: "2026-10-27T12:00:00.000Z", readFingerprint: "a".repeat(64) }, ...overrides }) as never;
  const deps = { source: { lockForConfirmation: vi.fn() }, clock: () => new Date("2026-10-27T12:00:00.000Z"), monotonicNow: () => 0,
    random: () => 0 };
  const pool = { connect: vi.fn(), query: vi.fn() };

  it("refuses a destination without this policy (fatal STOCK_LINK_POLICY_MISSING) before any read", async () => {
    const walmart = request({ destination: { ...(request() as { destination: object }).destination, providerKey: "walmart" } });
    await expect(runShopifyStockLinkCommand(pool, walmart, deps)).rejects.toMatchObject({ code: "STOCK_LINK_POLICY_MISSING", errorClass: "fatal" });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["no claim for a member", { claims: [] }],
    ["a member that changes nothing", { command: { productId: 20, purpose: "publish", members: [member({ change: "none" })], freedItemIds: [] } }],
    ["a member of another product", { command: { productId: 21, purpose: "publish", members: [member()], freedItemIds: [] } }],
    ["a retire without the version it replaces", { command: { productId: 20, purpose: "publish",
      members: [member({ change: "retire", link: null })], freedItemIds: [] } }],
  ])("refuses an inconsistent command (fatal STOCK_LINK_STATE_INVALID): %s", async (_name, overrides) => {
    await expect(runShopifyStockLinkCommand(pool, request(overrides), deps)).rejects.toMatchObject({ code: "STOCK_LINK_STATE_INVALID" });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
