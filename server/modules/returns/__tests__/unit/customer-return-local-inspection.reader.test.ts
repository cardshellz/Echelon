import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresCustomerReturnLocalInspectionReader } from "../../infrastructure/customer-return-local-inspection.reader";
import { inspectionQueries } from "../../infrastructure/customer-return-local-inspection.queries";
import { deriveLocalInspectionIssues } from "../../infrastructure/customer-return-local-inspection.issues";
import { customerReturnLocalInspectionSnapshotSchema, type CustomerReturnLocalInspectionSnapshot } from "../../application/customer-return-local-inspection.ports";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const shop = { channelId: 36, connectionId: 4, shopDomain: "test-shop.myshopify.com", displayName: "Test shop" };
const configured = { ...shop, type: "internal", provider: "shopify", status: "active", connectionCount: "1", hasCredentials: true, isDropship: false };
const order = { omsOrderId: 100, channelId: 36, externalOrderId: "1000", externalOrderNumber: "#TEST-1",
  purchasedAt: NOW.toISOString(), shipToCountry: "US", cancelledAt: null };
const line = { omsOrderLineId: 101, externalLineItemId: "500", title: "Same product", variantTitle: null,
  sku: "SAME", quantity: 4, requiresShipping: true, unitWeightGrams: 12.34 };
const item = { wmsOrderId: 201, wmsOrderItemId: 301, omsOrderLineId: 101, channelId: 36, source: "oms",
  omsOrderReference: "100", legacyOrderReference: null, externalOrderId: "1000", externalLineItemId: "500",
  quantity: 4, fulfilledQuantity: 4, warehouseStatus: "shipped" };
const request = { channelId: 36, connectionId: 4, orderReference: " # TEST-1 " };

function source(): CustomerReturnLocalInspectionSnapshot {
  return { observedAt: NOW.toISOString(), shop, order, lines: [{ ...line }], wmsItems: [{ ...item }],
    rootClaims: [], legacyClaims: [], unallocatedReturns: [], inventoryReturnEvidence: [],
    fulfillmentBindings: [], packageItems: [], packageLabels: [], carrierEvents: [], issues: [] };
}
function harness(override?: (text: string, values: unknown[]) => Promise<unknown[] | undefined>) {
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    const rows = await override?.(text, values);
    if (rows !== undefined) return { rows };
    if (text === inspectionQueries.shops) return { rows: [{ ...configured }] };
    if (text === inspectionQueries.order) return { rows: [{ ...order, purchasedAt: NOW, isDropship: false }] };
    if (text === inspectionQueries.lines) return { rows: [{ ...line }] };
    if (text === inspectionQueries.wmsItems) return { rows: [{ ...item }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const reportFailure = vi.fn();
  const reader = new PostgresCustomerReturnLocalInspectionReader({ connect } as unknown as Pick<Pool, "connect">,
    { approvedShopDomains: [shop.shopDomain], clock: () => new Date(NOW), reportFailure });
  return { reader, query, release, connect, reportFailure };
}

describe("private local order inspection boundary", () => {
  it("keeps empty configuration disconnected and does not infer a shop", async () => {
    const { connect } = harness();
    const reader = new PostgresCustomerReturnLocalInspectionReader({ connect } as unknown as Pick<Pool, "connect">,
      { approvedShopDomains: [], clock: () => NOW, reportFailure: vi.fn() });
    expect(await reader.listShops()).toEqual([]);
    await expect(reader.read(request)).rejects.toMatchObject({ code: "RETURN_INSPECTION_CONFIGURATION_REQUIRED" });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([{ domains: ["https://test-shop.myshopify.com"] }, { domains: ["www.example.com"] }, { domains: ["test-shop.myshopify.com.evil.test"] },
    { domains: ["test-shop.myshopify.com", " TEST-SHOP.MYSHOPIFY.COM "] }, { domains: [""] }])("rejects unsafe or duplicate configuration %j", ({ domains }) => {
    expect(() => new PostgresCustomerReturnLocalInspectionReader({} as Pool,
      { approvedShopDomains: domains, clock: () => NOW })).toThrow("Configure distinct canonical");
  });

  it.each([{ status: "paused" }, { provider: "ebay" }, { type: "partner" }, { isDropship: true },
    { hasCredentials: false }, { connectionCount: "2" }])("rejects configured scope drift %j", async drift => {
    const { reader, release } = harness(async text => text === inspectionQueries.shops ? [{ ...configured, ...drift }] : undefined);
    await expect(reader.listShops()).rejects.toMatchObject({ code: "RETURN_INSPECTION_CONFIGURATION_UNRESOLVED" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("revalidates scope per request and only emits allowlisted public shop fields", async () => {
    const { reader, query } = harness();
    expect(await reader.listShops()).toEqual([shop]);
    expect(await reader.read(request)).toMatchObject({ shop, order, lines: [line], issues: [] });
    expect(query.mock.calls.filter(([text]) => text === inspectionQueries.shops)).toHaveLength(2);
    const lookup = query.mock.calls.find(([text]) => text === inspectionQueries.order)!;
    expect(lookup[1]).toEqual([36, ["TEST-1", "#TEST-1", "# TEST-1"]]);
    expect(query.mock.calls.some(([text]) => /FOR UPDATE|advisory|INSERT INTO|UPDATE\s|DELETE FROM/i.test(text))).toBe(false);
  });

  it("opens repeatable-read read-only transactions and returns schema-validated facts without optional projections", async () => {
    const { reader, query, release } = harness();
    const result = await reader.read(request);
    expect(customerReturnLocalInspectionSnapshotSchema.safeParse(result).success).toBe(true);
    expect(query.mock.calls[0][0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledWith(false);
  });

  it("rejects the selected connection and input authority overrides", async () => {
    const { reader } = harness();
    await expect(reader.read({ ...request, connectionId: 5 })).rejects.toMatchObject({ code: "RETURN_INSPECTION_SHOP_UNAVAILABLE" });
    await expect(reader.read({ ...request, approved: true } as never)).rejects.toMatchObject({ code: "RETURN_INSPECTION_INPUT_INVALID" });
  });

  it.each([{ rows: [] }, { rows: [{ ...order, isDropship: true }] }, { rows: [{ ...order, isDropship: false }, { ...order, omsOrderId: 102, isDropship: false }] }])(
    "distinguishes missing, Dropship and ambiguous order results %#", async ({ rows }) => {
      const { reader } = harness(async text => text === inspectionQueries.order ? rows : undefined);
      if (!rows.length) expect(await reader.read(request)).toBeNull();
      else await expect(reader.read(request)).rejects.toMatchObject({ code: rows.length > 1 ? "RETURN_INSPECTION_ORDER_AMBIGUOUS" : "RETURN_INSPECTION_ORDER_SCOPE_UNSUPPORTED" });
    });

  it("rejects too many facts rather than returning a truncated entitlement picture", async () => {
    const { reader } = harness(async text => text === inspectionQueries.lines ? Array.from({ length: 201 }, (_, i) => ({ ...line, omsOrderLineId: i + 1 })) : undefined);
    await expect(reader.read(request)).rejects.toMatchObject({ code: "RETURN_INSPECTION_EVIDENCE_LIMIT" });
  });

  it.each([{ omsOrderLineId: "9007199254740993" }, { quantity: -1 }, { privatePayload: "secret" }])(
    "rejects invalid DB output %#", async invalid => {
      const { reader, query } = harness(async text => text === inspectionQueries.lines ? [{ ...line, ...invalid }] : undefined);
      await expect(reader.read(request)).rejects.toMatchObject({ code: "RETURN_INSPECTION_DATA_INVALID" });
      expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    });

  it("sanitizes dependency failure, rolls back and releases; failed rollback discards the connection", async () => {
    const { reader, release, reportFailure } = harness(async text => {
      if (text === inspectionQueries.lines || text === "ROLLBACK") throw new Error("private-sql-email-token");
      return undefined;
    });
    await expect(reader.read(request)).rejects.toMatchObject({ code: "RETURN_INSPECTION_UNAVAILABLE", message: "Local order evidence is temporarily unavailable." });
    expect(reportFailure).toHaveBeenCalledWith({ operation: "read", code: "RETURN_INSPECTION_UNAVAILABLE" });
    expect(release).toHaveBeenCalledWith(true);
  });
});

describe("retained local claim uncertainty", () => {
  it("missing WMS or carrier projections do not negate provider evidence", () => {
    const facts = source(); facts.wmsItems = [];
    expect(deriveLocalInspectionIssues(facts)).toEqual([]);
  });
  it("same SKU remains separate while numeric/GID purchased identity collisions are explicit", () => {
    const facts = source(); facts.lines.push({ ...line, omsOrderLineId: 102, externalLineItemId: "501" });
    expect(deriveLocalInspectionIssues(facts)).toEqual([]);
    facts.lines[1].externalLineItemId = "gid://shopify/LineItem/500";
    expect(deriveLocalInspectionIssues(facts)).toEqual([
      { code: "purchased_line_identity_conflict", omsOrderLineId: 101 }, { code: "purchased_line_identity_conflict", omsOrderLineId: 102 },
    ]);
  });
  it("retains a legacy claimed quantity and blocks its line without assigning a fulfillment", () => {
    const facts = source(); facts.legacyClaims.push({ returnId: 1, returnItemId: 2, wmsOrderId: 201,
      wmsOrderItemId: 301, omsOrderLineId: 101, externalLineItemId: "500", expectedQuantity: 2,
      receivedQuantity: 2, status: "received", refundExternalId: null, source: "admin" });
    expect(deriveLocalInspectionIssues(facts)).toEqual([{ code: "legacy_claim_allocation_unknown", omsOrderLineId: 101 }]);
  });
  it("does not turn unallocated return headers or inventory-only returns into zero claims", () => {
    const facts = source(); facts.unallocatedReturns.push({ returnId: 1, wmsOrderId: 201, status: "closed", refundExternalId: "700" });
    facts.inventoryReturnEvidence.push({ transactionId: 1, wmsOrderId: 201, wmsOrderItemId: 301, quantityDelta: 1, occurredAt: NOW.toISOString() });
    expect(deriveLocalInspectionIssues(facts)).toContainEqual({ code: "unallocated_return_evidence", omsOrderLineId: null });
    expect(deriveLocalInspectionIssues(facts)).toContainEqual({ code: "inventory_return_correlation_unknown", omsOrderLineId: 101 });
  });
  it("detects retained root overclaims and changed WMS ownership", () => {
    const facts = source(); facts.rootClaims.push({ claimId: 1, authorizationId: 1, authorizationLineId: 1,
      channelId: 36, omsOrderId: 100, omsOrderLineId: 101, externalLineItemId: "500", wmsOrderItemId: 301,
      fulfillmentId: "600", fulfillmentLineItemId: "700", quantity: 5 });
    expect(deriveLocalInspectionIssues(facts)).toContainEqual({ code: "local_claim_quantity_conflict", omsOrderLineId: 101 });
    facts.wmsItems[0].channelId = 99;
    expect(deriveLocalInspectionIssues(facts)).toContainEqual({ code: "wms_identity_conflict", omsOrderLineId: 101 });
  });
  it.each([
    { omsOrderReference: null, legacyOrderReference: "999" },
    { externalOrderId: "gid://shopify/Order/999" },
  ])("retains contradictory legacy or provider order ownership %#", change => {
    const facts = source(); Object.assign(facts.wmsItems[0], change);
    expect(deriveLocalInspectionIssues(facts)).toContainEqual({ code: "wms_identity_conflict", omsOrderLineId: 101 });
  });
  it("accepts exact numeric/GID provider aliases and the authoritative modern OMS link", () => {
    const facts = source(); Object.assign(facts.wmsItems[0], {
      externalOrderId: "gid://shopify/Order/1000", legacyOrderReference: "999",
    });
    expect(deriveLocalInspectionIssues(facts)).toEqual([]);
  });
});
