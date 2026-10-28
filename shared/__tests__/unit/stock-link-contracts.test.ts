import { describe, expect, it } from "vitest";
import {
  stockLinkCheckAgainRequestSchema,
  stockLinkControlResultSchema,
  stockLinkDestinationSchema,
  stockLinkItemObservationSchema,
  stockLinkRecordedFailureSchema,
  stockLinkSkuLookupSchema,
  stockLinkStatusRequestSchema,
  stockLinkStatusSchema,
  stockLinkStoreItemSchema,
  stockLinkSwitchRequestSchema,
} from "../../types/stock-link";

// Channels PR2 (PLAN-CH2 v4.1 §4.1, §6.1, §7.3): the shared stock-link contracts refuse what the engine must never
// trust: a gid or padded item id, a partial or duplicated read, an observation of another item, a non-canonical id
// in a query, a control without its revision guard.

const item = { itemId: "44001", sku: "P5", productId: "77", productStatus: "ACTIVE" };
const evidence = { observedAt: "2026-10-27T12:00:00.000Z", readFingerprint: "a".repeat(64) };
const destination = { publicationTargetId: 41, destinationKind: "channel_connection", providerKey: "shopify", channelId: 35,
  channelConnectionId: 7, dropshipStoreConnectionId: null, providerScopeType: "location", externalScopeId: "8800", targetRevision: "3" };

describe("stock-link shared contracts", () => {
  it("a store item carries a decimal REST id only, a raw SKU (even over 100 characters) and an upper-case status", () => {
    expect(stockLinkStoreItemSchema.parse({ ...item, sku: " p5 " })).toEqual({ ...item, sku: " p5 " });
    expect(stockLinkStoreItemSchema.safeParse({ ...item, sku: "Z".repeat(101) }).success).toBe(true);
    expect(stockLinkStoreItemSchema.safeParse({ ...item, sku: null }).success).toBe(true);
    for (const itemId of ["gid://shopify/InventoryItem/44001", " 44001", "0", "044", "1".repeat(21)]) {
      expect(stockLinkStoreItemSchema.safeParse({ ...item, itemId }).success, itemId).toBe(false);
    }
    for (const productStatus of ["active", "", "ACTIVE "]) {
      expect(stockLinkStoreItemSchema.safeParse({ ...item, productStatus }).success, productStatus).toBe(false);
    }
    expect(stockLinkStoreItemSchema.safeParse({ ...item, extra: 1 }).success).toBe(false);
  });

  it("a lookup asks 1..50 distinct SKUs and lists each item once", () => {
    expect(stockLinkSkuLookupSchema.safeParse({ ...evidence, skus: ["P5"], items: [item] }).success).toBe(true);
    expect(stockLinkSkuLookupSchema.safeParse({ ...evidence, skus: [], items: [] }).success).toBe(false);
    expect(stockLinkSkuLookupSchema.safeParse({ ...evidence, skus: Array.from({ length: 51 }, (_, index) => `S${index}`), items: [] }).success).toBe(false);
    expect(stockLinkSkuLookupSchema.safeParse({ ...evidence, skus: ["P5", "P5"], items: [] }).success).toBe(false);
    expect(stockLinkSkuLookupSchema.safeParse({ ...evidence, skus: ["P5"], items: [item, item] }).success).toBe(false);
    expect(stockLinkSkuLookupSchema.safeParse({ ...evidence, readFingerprint: "token", skus: ["P5"], items: [] }).success).toBe(false);
  });

  it("an observation names each asked item once, null when gone, never another item", () => {
    expect(stockLinkItemObservationSchema.safeParse({ ...evidence, observations: [{ itemId: "44001", item },
      { itemId: "44002", item: null }] }).success).toBe(true);
    expect(stockLinkItemObservationSchema.safeParse({ ...evidence, observations: [{ itemId: "44002", item }] }).success).toBe(false);
    expect(stockLinkItemObservationSchema.safeParse({ ...evidence, observations: [{ itemId: "44001", item: null },
      { itemId: "44001", item: null }] }).success).toBe(false);
    expect(stockLinkItemObservationSchema.safeParse({ ...evidence, observations: [] }).success).toBe(false);
  });

  it("a destination names exactly the connection of its kind", () => {
    expect(stockLinkDestinationSchema.safeParse(destination).success).toBe(true);
    expect(stockLinkDestinationSchema.safeParse({ ...destination, channelConnectionId: null }).success).toBe(false);
    expect(stockLinkDestinationSchema.safeParse({ ...destination, dropshipStoreConnectionId: 9 }).success).toBe(false);
    expect(stockLinkDestinationSchema.safeParse({ ...destination, destinationKind: "dropship_store_connection",
      channelConnectionId: null, dropshipStoreConnectionId: 9 }).success).toBe(true);
    expect(stockLinkDestinationSchema.safeParse({ ...destination, providerKey: "Shopify" }).success).toBe(false);
    expect(stockLinkDestinationSchema.safeParse({ ...destination, targetRevision: "0" }).success).toBe(false);
  });

  it("a recorded failure fits the check row's columns", () => {
    expect(stockLinkRecordedFailureSchema.safeParse({ code: "STOCK_LINK_SKU_BLANK", errorClass: "permanent", message: "x" }).success).toBe(true);
    expect(stockLinkRecordedFailureSchema.safeParse({ code: "A".repeat(121), errorClass: "fatal", message: "x" }).success).toBe(false);
    expect(stockLinkRecordedFailureSchema.safeParse({ code: "STOCK_LINK_SKU_BLANK", errorClass: "busy", message: "x" }).success).toBe(false);
    expect(stockLinkRecordedFailureSchema.safeParse({ code: "STOCK_LINK_SKU_BLANK", errorClass: "fatal", message: "x".repeat(1001) }).success).toBe(false);
  });

  it("the status query takes a canonical decimal id only", () => {
    expect(stockLinkStatusRequestSchema.parse({ publicationTargetId: "41" })).toEqual({ publicationTargetId: 41 });
    for (const raw of ["041", "1e3", " 41", "-1", "0", "41.0", "2147483648", "abc"]) {
      expect(stockLinkStatusRequestSchema.safeParse({ publicationTargetId: raw }).success, raw).toBe(false);
    }
  });

  it("status answers either unsupported or the full guarded state", () => {
    const supported = { supported: true, publicationTargetId: 41, autoLinkEnabled: true, revision: "0",
      counts: { linked: 3, waiting: 1, flagged: 0, error: 0 }, paused: null, halted: null, retiresHeld: null };
    expect(stockLinkStatusSchema.parse(supported)).toEqual(supported);
    expect(stockLinkControlResultSchema.parse(supported)).toEqual(supported);
    expect(stockLinkStatusSchema.parse({ supported: false, publicationTargetId: 41 })).toEqual({ supported: false, publicationTargetId: 41 });
    expect(stockLinkStatusSchema.safeParse({ ...supported, counts: { ...supported.counts, error: -1 } }).success).toBe(false);
    expect(stockLinkStatusSchema.safeParse({ ...supported, paused: { code: "STOCK_LINK_STORE_NOT_ANSWERING",
      since: "2026-10-27T12:00:00Z", until: "2026-10-27T12:15:00Z" } }).success).toBe(true);
  });

  it("controls carry the revision guard; a blank reason is stored as none", () => {
    expect(stockLinkSwitchRequestSchema.parse({ publicationTargetId: 41, enabled: false, expectedRevision: "2", reason: "   " }))
      .toEqual({ publicationTargetId: 41, enabled: false, expectedRevision: "2", reason: null });
    expect(stockLinkSwitchRequestSchema.parse({ publicationTargetId: 41, enabled: true, expectedRevision: "0" }).reason).toBeNull();
    expect(stockLinkSwitchRequestSchema.safeParse({ publicationTargetId: 41, enabled: true }).success).toBe(false);
    expect(stockLinkCheckAgainRequestSchema.safeParse({ publicationTargetId: 41, expectedRevision: "07" }).success).toBe(false);
    expect(stockLinkCheckAgainRequestSchema.safeParse({ publicationTargetId: 41, expectedRevision: "7", extra: true }).success).toBe(false);
  });
});
