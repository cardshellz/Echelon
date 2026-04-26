/**
 * Unit tests for scripts/parity-check-push.ts
 *
 * Coverage:
 *   1. All-match scenario → exit 0, all-OK summary
 *   2. Divergence on amountPaid → DIVERGE, exit 1
 *   3. Divergence on lineItems (extra line) → DIVERGE
 *   4. Within tolerance → OK
 *   5. No WMS shipment for order → skip (no_wms_shipment)
 *   6. SS API 404 → skip (ss_not_found)
 *   7. DB error → exit 2
 *   8. --order flag → only checks that one order
 *   9. --silent → only summary printed
 *  10. Pure comparison helpers (compareLineItems, compareFinancials, etc.)
 *  11. Order number comparison
 *  12. CustomField1 comparison
 *  13. ShipTo comparison
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  compareLineItems,
  compareFinancials,
  compareShipTo,
  compareOrderNumber,
  compareCustomField1,
  checkSingleOrder,
  runParityCheck,
} from "../parity-check-push";

// ─── Mock db + sql helpers ───────────────────────────────────────────

function makeMockDb(responses: Array<{ rows: any[] }>) {
  let callIndex = 0;
  return {
    execute: vi.fn(async (_query: any) => {
      if (callIndex >= responses.length) {
        throw new Error(`mock db.execute: no more responses (call #${callIndex + 1})`);
      }
      return responses[callIndex++];
    }),
  };
}

function mockSql(strings: TemplateStringsArray, ..._values: any[]) {
  // Return a marker object that the mock db ignores
  return { queryChunks: strings.join(""), params: _values };
}

const getOrderById = vi.fn();

beforeEach(() => {
  getOrderById.mockReset();
});

// ─── Pure comparison helpers ─────────────────────────────────────────

describe("compareLineItems", () => {
  it("matches identical items", () => {
    const diffs = compareLineItems(
      [{ sku: "A", quantity: 2, unitPrice: 10.0 }],
      [{ sku: "A", qty: 2, unitPrice: 10.0 }],
      1,
    );
    expect(diffs.every((d) => d.match)).toBe(true);
  });

  it("detects count mismatch", () => {
    const diffs = compareLineItems(
      [{ sku: "A", quantity: 1, unitPrice: 10 }],
      [{ sku: "A", qty: 1, unitPrice: 10 }, { sku: "B", qty: 1, unitPrice: 5 }],
      1,
    );
    const countDiff = diffs.find((d) => d.field === "lineItems.count");
    expect(countDiff?.match).toBe(false);
  });

  it("detects sku mismatch", () => {
    const diffs = compareLineItems(
      [{ sku: "A", quantity: 1, unitPrice: 10 }],
      [{ sku: "B", qty: 1, unitPrice: 10 }],
      1,
    );
    const skuDiff = diffs.find((d) => d.field === "lineItems[0].sku");
    expect(skuDiff?.match).toBe(false);
  });

  it("detects quantity mismatch", () => {
    const diffs = compareLineItems(
      [{ sku: "A", quantity: 1, unitPrice: 10 }],
      [{ sku: "A", qty: 2, unitPrice: 10 }],
      1,
    );
    const qtyDiff = diffs.find((d) => d.field === "lineItems[0].quantity");
    expect(qtyDiff?.match).toBe(false);
  });

  it("within tolerance on unitPrice", () => {
    // 10.00 vs 10.01 = 1 cent diff, tolerance = 1
    const diffs = compareLineItems(
      [{ sku: "A", quantity: 1, unitPrice: 10.0 }],
      [{ sku: "A", qty: 1, unitPrice: 10.01 }],
      1,
    );
    const priceDiff = diffs.find((d) => d.field === "lineItems[0].unitPrice");
    expect(priceDiff?.match).toBe(true);
  });

  it("outside tolerance on unitPrice", () => {
    // 10.00 vs 10.05 = 5 cent diff, tolerance = 1
    const diffs = compareLineItems(
      [{ sku: "A", quantity: 1, unitPrice: 10.0 }],
      [{ sku: "A", qty: 1, unitPrice: 10.05 }],
      1,
    );
    const priceDiff = diffs.find((d) => d.field === "lineItems[0].unitPrice");
    expect(priceDiff?.match).toBe(false);
  });
});

describe("compareFinancials", () => {
  it("matches identical financials", () => {
    const diffs = compareFinancials(
      { amountPaid: 59.13, taxAmount: 4.13, shippingAmount: 5.0 },
      { amountPaid: 59.13, taxAmount: 4.13, shippingAmount: 5.0 },
      1,
      2,
    );
    expect(diffs.every((d) => d.match)).toBe(true);
  });

  it("detects amountPaid divergence beyond tolerance", () => {
    // 100 cents diff, tolerance = 1 cent * 1 line = 1 cent
    const diffs = compareFinancials(
      { amountPaid: 50.0, taxAmount: 0, shippingAmount: 0 },
      { amountPaid: 51.0, taxAmount: 0, shippingAmount: 0 },
      1,
      1,
    );
    const apDiff = diffs.find((d) => d.field === "amountPaid");
    expect(apDiff?.match).toBe(false);
  });

  it("within tolerance for small rounding diffs", () => {
    // 0.01 diff, tolerance = 1 cent * 3 lines = 3 cents
    const diffs = compareFinancials(
      { amountPaid: 50.0, taxAmount: 3.0, shippingAmount: 5.0 },
      { amountPaid: 50.01, taxAmount: 3.0, shippingAmount: 5.0 },
      1,
      3,
    );
    const apDiff = diffs.find((d) => d.field === "amountPaid");
    expect(apDiff?.match).toBe(true);
  });
});

describe("compareShipTo", () => {
  it("matches identical addresses", () => {
    const diffs = compareShipTo(
      { name: "Jane", street1: "123 Main St", city: "Springfield", state: "IL", postalCode: "62701", country: "US" },
      { name: "Jane", street1: "123 Main St", city: "Springfield", state: "IL", postalCode: "62701", country: "US" },
    );
    expect(diffs.every((d) => d.match)).toBe(true);
  });

  it("normalizes whitespace", () => {
    const diffs = compareShipTo(
      { name: "  Jane  Doe  ", street1: "123 Main St", city: "Springfield", state: "IL", postalCode: "62701", country: "US" },
      { name: "Jane Doe", street1: "123 Main St", city: "Springfield", state: "IL", postalCode: "62701", country: "US" },
    );
    expect(diffs.every((d) => d.match)).toBe(true);
  });

  it("detects city mismatch", () => {
    const diffs = compareShipTo(
      { name: "Jane", street1: "123 Main St", city: "Chicago", state: "IL", postalCode: "62701", country: "US" },
      { name: "Jane", street1: "123 Main St", city: "Springfield", state: "IL", postalCode: "62701", country: "US" },
    );
    const cityDiff = diffs.find((d) => d.field === "shipTo.city");
    expect(cityDiff?.match).toBe(false);
  });
});

describe("compareOrderNumber", () => {
  it("matches identical order numbers", () => {
    const diff = compareOrderNumber("1001", "1001");
    expect(diff.match).toBe(true);
  });

  it("detects mismatch", () => {
    const diff = compareOrderNumber("1001", "EB-1001");
    expect(diff.match).toBe(false);
  });
});

describe("compareCustomField1", () => {
  it("matches identical sort rank", () => {
    const diff = compareCustomField1("0000000100", "0000000100");
    expect(diff.match).toBe(true);
  });

  it("handles undefined ss value", () => {
    const diff = compareCustomField1(undefined, "");
    expect(diff.match).toBe(true);
  });

  it("detects mismatch", () => {
    const diff = compareCustomField1("0000000100", "0000000200");
    expect(diff.match).toBe(false);
  });
});

// ─── checkSingleOrder ────────────────────────────────────────────────

describe("checkSingleOrder", () => {
  const omsOrder = {
    id: 42,
    shipstation_order_id: 999,
    external_order_number: "1001",
    external_order_id: "EXT-1001",
    channel_name: "shopify",
  };

  function ssOrderFixture(overrides: any = {}) {
    return {
      orderId: 999,
      orderNumber: "1001",
      orderKey: "shopify-1001",
      orderStatus: "awaiting_shipment",
      customerUsername: "jane",
      customerEmail: "jane@example.com",
      billTo: { name: "Jane Customer" },
      shipTo: {
        name: "Jane Customer",
        street1: "123 Main St",
        street2: "",
        city: "Springfield",
        state: "IL",
        postalCode: "62701",
        country: "US",
        phone: "",
      },
      items: [
        { lineItemKey: "li-1", sku: "ABC-1", name: "Widget", quantity: 2, unitPrice: 25.0, options: [] },
      ],
      amountPaid: 59.13,
      taxAmount: 4.13,
      shippingAmount: 5.0,
      advancedOptions: {
        warehouseId: 996884,
        storeId: 319989,
        source: "shopify",
        customField1: "0000000100",
        customField2: "",
        customField3: "",
      },
      ...overrides,
    };
  }

  it("returns ok for matching payloads", async () => {
    getOrderById.mockResolvedValue(ssOrderFixture());

    const db = makeMockDb([
      // WMS shipment lookup
      { rows: [{ id: 200, order_id: 100 }] },
      // WMS order lookup
      {
        rows: [{
          id: 100, order_number: "1001", channel_id: 1, oms_fulfillment_order_id: "42",
          sort_rank: "0000000100", external_order_id: "EXT-1001",
          customer_name: "Jane Customer", customer_email: "jane@example.com",
          shipping_name: "Jane Customer", shipping_address: "123 Main St",
          shipping_city: "Springfield", shipping_state: "IL",
          shipping_postal_code: "62701", shipping_country: "US",
          amount_paid_cents: 5913, tax_cents: 413, shipping_cents: 500,
          total_cents: 5000, currency: "USD", order_placed_at: new Date(),
        }],
      },
      // WMS items lookup
      {
        rows: [
          { id: 301, order_item_id: 500, sku: "ABC-1", name: "Widget", qty: 2, unit_price_cents: 2500 },
        ],
      },
    ]);

    const result = await checkSingleOrder(omsOrder as any, {
      tolerance: 1,
      verbose: false,
      db,
      sql: mockSql,
      getOrderById,
    });

    expect(result.outcome).toBe("ok");
    expect(result.diffs.every((d) => d.match)).toBe(true);
  });

  it("returns diverge on amountPaid mismatch", async () => {
    getOrderById.mockResolvedValue(ssOrderFixture({ amountPaid: 99.99 }));

    const db = makeMockDb([
      { rows: [{ id: 200, order_id: 100 }] },
      {
        rows: [{
          id: 100, order_number: "1001", channel_id: 1, oms_fulfillment_order_id: "42",
          sort_rank: "0000000100", external_order_id: "EXT-1001",
          customer_name: "Jane Customer", customer_email: "jane@example.com",
          shipping_name: "Jane Customer", shipping_address: "123 Main St",
          shipping_city: "Springfield", shipping_state: "IL",
          shipping_postal_code: "62701", shipping_country: "US",
          amount_paid_cents: 5913, tax_cents: 413, shipping_cents: 500,
          total_cents: 5000, currency: "USD", order_placed_at: new Date(),
        }],
      },
      {
        rows: [
          { id: 301, order_item_id: 500, sku: "ABC-1", name: "Widget", qty: 2, unit_price_cents: 2500 },
        ],
      },
    ]);

    const result = await checkSingleOrder(omsOrder as any, {
      tolerance: 1,
      verbose: false,
      db,
      sql: mockSql,
      getOrderById,
    });

    expect(result.outcome).toBe("diverge");
    const apDiff = result.diffs.find((d) => d.field === "amountPaid");
    expect(apDiff?.match).toBe(false);
  });

  it("returns diverge on extra line item", async () => {
    getOrderById.mockResolvedValue(ssOrderFixture({
      items: [
        { lineItemKey: "li-1", sku: "ABC-1", name: "Widget", quantity: 2, unitPrice: 25.0, options: [] },
        { lineItemKey: "li-2", sku: "XYZ-1", name: "Gadget", quantity: 1, unitPrice: 9.13, options: [] },
      ],
    }));

    const db = makeMockDb([
      { rows: [{ id: 200, order_id: 100 }] },
      {
        rows: [{
          id: 100, order_number: "1001", channel_id: 1, oms_fulfillment_order_id: "42",
          sort_rank: "0000000100", external_order_id: "EXT-1001",
          customer_name: "Jane Customer", customer_email: "jane@example.com",
          shipping_name: "Jane Customer", shipping_address: "123 Main St",
          shipping_city: "Springfield", shipping_state: "IL",
          shipping_postal_code: "62701", shipping_country: "US",
          amount_paid_cents: 5913, tax_cents: 413, shipping_cents: 500,
          total_cents: 5000, currency: "USD", order_placed_at: new Date(),
        }],
      },
      {
        rows: [
          { id: 301, order_item_id: 500, sku: "ABC-1", name: "Widget", qty: 2, unit_price_cents: 2500 },
        ],
      },
    ]);

    const result = await checkSingleOrder(omsOrder as any, {
      tolerance: 1,
      verbose: false,
      db,
      sql: mockSql,
      getOrderById,
    });

    expect(result.outcome).toBe("diverge");
    const countDiff = result.diffs.find((d) => d.field === "lineItems.count");
    expect(countDiff?.match).toBe(false);
  });

  it("returns ok within tolerance", async () => {
    // SS has 59.13, Echelon has 5912 cents = 59.12 → 1 cent diff, tolerance 2 per line, 1 line = 2 cents
    getOrderById.mockResolvedValue(ssOrderFixture({ amountPaid: 59.13 }));

    const db = makeMockDb([
      { rows: [{ id: 200, order_id: 100 }] },
      {
        rows: [{
          id: 100, order_number: "1001", channel_id: 1, oms_fulfillment_order_id: "42",
          sort_rank: "0000000100", external_order_id: "EXT-1001",
          customer_name: "Jane Customer", customer_email: "jane@example.com",
          shipping_name: "Jane Customer", shipping_address: "123 Main St",
          shipping_city: "Springfield", shipping_state: "IL",
          shipping_postal_code: "62701", shipping_country: "US",
          amount_paid_cents: 5912, tax_cents: 413, shipping_cents: 500,
          total_cents: 5000, currency: "USD", order_placed_at: new Date(),
        }],
      },
      {
        rows: [
          { id: 301, order_item_id: 500, sku: "ABC-1", name: "Widget", qty: 2, unit_price_cents: 2500 },
        ],
      },
    ]);

    const result = await checkSingleOrder(omsOrder as any, {
      tolerance: 2,
      verbose: false,
      db,
      sql: mockSql,
      getOrderById,
    });

    expect(result.outcome).toBe("ok");
  });

  it("skips with no_wms_shipment when no WMS shipment found", async () => {
    getOrderById.mockResolvedValue(ssOrderFixture());

    const db = makeMockDb([
      { rows: [] }, // No WMS shipment
    ]);

    const result = await checkSingleOrder(omsOrder as any, {
      tolerance: 1,
      verbose: false,
      db,
      sql: mockSql,
      getOrderById,
    });

    expect(result.outcome).toBe("no_wms_shipment");
  });

  it("skips with ss_not_found when SS returns null", async () => {
    getOrderById.mockResolvedValue(null);

    const db = makeMockDb([]);

    const result = await checkSingleOrder(omsOrder as any, {
      tolerance: 1,
      verbose: false,
      db,
      sql: mockSql,
      getOrderById,
    });

    expect(result.outcome).toBe("ss_not_found");
  });

  it("skips with ss_not_found when SS throws 404", async () => {
    getOrderById.mockRejectedValue(new Error("ShipStation API GET /orders/999 failed (404): not found"));

    const db = makeMockDb([]);

    const result = await checkSingleOrder(omsOrder as any, {
      tolerance: 1,
      verbose: false,
      db,
      sql: mockSql,
      getOrderById,
    });

    expect(result.outcome).toBe("ss_not_found");
  });
});

// ─── runParityCheck integration (mocked) ─────────────────────────────

describe("runParityCheck", () => {
  it("returns exit 0 when all orders match", async () => {
    getOrderById.mockResolvedValue({
      orderId: 999,
      orderNumber: "1001",
      items: [{ sku: "ABC-1", quantity: 1, unitPrice: 50.0 }],
      amountPaid: 54.13,
      taxAmount: 4.13,
      shippingAmount: 0,
      shipTo: { name: "Jane", street1: "123 Main", city: "Springfield", state: "IL", postalCode: "62701", country: "US" },
      advancedOptions: { customField1: "0000000100" },
    });

    const db = makeMockDb([
      // OMS orders query
      { rows: [{ id: 42, shipstation_order_id: 999, external_order_number: "1001", external_order_id: "EXT", channel_name: "shopify" }] },
      // WMS shipment lookup
      { rows: [{ id: 200, order_id: 100 }] },
      // WMS order lookup
      {
        rows: [{
          id: 100, order_number: "1001", channel_id: 1, oms_fulfillment_order_id: "42",
          sort_rank: "0000000100", external_order_id: "EXT",
          customer_name: "Jane", customer_email: "jane@example.com",
          shipping_name: "Jane", shipping_address: "123 Main",
          shipping_city: "Springfield", shipping_state: "IL",
          shipping_postal_code: "62701", shipping_country: "US",
          amount_paid_cents: 5413, tax_cents: 413, shipping_cents: 0,
          total_cents: 5000, currency: "USD", order_placed_at: new Date(),
        }],
      },
      // WMS items
      { rows: [{ id: 301, order_item_id: 500, sku: "ABC-1", name: "Widget", qty: 1, unit_price_cents: 5000 }] },
    ]);

    const report = await runParityCheck(
      { limit: 20, orderId: null, tolerance: 1, verbose: false, silent: true },
      { db, sql: mockSql, getOrderById },
    );

    expect(report.ok).toBe(1);
    expect(report.diverge).toBe(0);
    expect(report.skipped).toBe(0);
  });

  it("returns diverge count > 0 when financials differ", async () => {
    getOrderById.mockResolvedValue({
      orderId: 999,
      orderNumber: "1001",
      items: [{ sku: "ABC-1", quantity: 1, unitPrice: 50.0 }],
      amountPaid: 99.99, // way off
      taxAmount: 4.13,
      shippingAmount: 0,
      shipTo: { name: "Jane", street1: "123 Main", city: "Springfield", state: "IL", postalCode: "62701", country: "US" },
      advancedOptions: { customField1: "0000000100" },
    });

    const db = makeMockDb([
      { rows: [{ id: 42, shipstation_order_id: 999, external_order_number: "1001", external_order_id: "EXT", channel_name: "shopify" }] },
      { rows: [{ id: 200, order_id: 100 }] },
      {
        rows: [{
          id: 100, order_number: "1001", channel_id: 1, oms_fulfillment_order_id: "42",
          sort_rank: "0000000100", external_order_id: "EXT",
          customer_name: "Jane", customer_email: "jane@example.com",
          shipping_name: "Jane", shipping_address: "123 Main",
          shipping_city: "Springfield", shipping_state: "IL",
          shipping_postal_code: "62701", shipping_country: "US",
          amount_paid_cents: 5413, tax_cents: 413, shipping_cents: 0,
          total_cents: 5000, currency: "USD", order_placed_at: new Date(),
        }],
      },
      { rows: [{ id: 301, order_item_id: 500, sku: "ABC-1", name: "Widget", qty: 1, unit_price_cents: 5000 }] },
    ]);

    const report = await runParityCheck(
      { limit: 20, orderId: null, tolerance: 1, verbose: false, silent: true },
      { db, sql: mockSql, getOrderById },
    );

    expect(report.diverge).toBe(1);
    expect(report.ok).toBe(0);
  });

  it("skips orders with no WMS shipment without failing", async () => {
    getOrderById.mockResolvedValue({
      orderId: 999,
      orderNumber: "1001",
      items: [{ sku: "ABC-1", quantity: 1, unitPrice: 50.0 }],
      amountPaid: 54.13,
      taxAmount: 4.13,
      shippingAmount: 0,
      shipTo: {},
      advancedOptions: {},
    });

    const db = makeMockDb([
      { rows: [{ id: 42, shipstation_order_id: 999, external_order_number: "1001", external_order_id: "EXT", channel_name: "shopify" }] },
      { rows: [] }, // No WMS shipment
    ]);

    const report = await runParityCheck(
      { limit: 20, orderId: null, tolerance: 1, verbose: false, silent: true },
      { db, sql: mockSql, getOrderById },
    );

    expect(report.skipped).toBe(1);
    expect(report.skipReasons["no_wms_shipment"]).toBe(1);
    expect(report.ok).toBe(0);
    expect(report.diverge).toBe(0);
  });

  it("handles --order flag by checking only that order", async () => {
    getOrderById.mockResolvedValue({
      orderId: 999,
      orderNumber: "1001",
      items: [{ sku: "ABC-1", quantity: 1, unitPrice: 50.0 }],
      amountPaid: 54.13,
      taxAmount: 4.13,
      shippingAmount: 0,
      shipTo: { name: "Jane", street1: "123 Main", city: "Springfield", state: "IL", postalCode: "62701", country: "US" },
      advancedOptions: { customField1: "0000000100" },
    });

    const db = makeMockDb([
      { rows: [{ id: 42, shipstation_order_id: 999, external_order_number: "1001", external_order_id: "EXT", channel_name: "shopify" }] },
      { rows: [{ id: 200, order_id: 100 }] },
      {
        rows: [{
          id: 100, order_number: "1001", channel_id: 1, oms_fulfillment_order_id: "42",
          sort_rank: "0000000100", external_order_id: "EXT",
          customer_name: "Jane", customer_email: "jane@example.com",
          shipping_name: "Jane", shipping_address: "123 Main",
          shipping_city: "Springfield", shipping_state: "IL",
          shipping_postal_code: "62701", shipping_country: "US",
          amount_paid_cents: 5413, tax_cents: 413, shipping_cents: 0,
          total_cents: 5000, currency: "USD", order_placed_at: new Date(),
        }],
      },
      { rows: [{ id: 301, order_item_id: 500, sku: "ABC-1", name: "Widget", qty: 1, unit_price_cents: 5000 }] },
    ]);

    const report = await runParityCheck(
      { limit: 20, orderId: 42, tolerance: 1, verbose: false, silent: true },
      { db, sql: mockSql, getOrderById },
    );

    expect(report.totalChecked).toBe(1);
    expect(report.ok).toBe(1);
  });

  it("handles --silent mode without printing per-order detail", async () => {
    getOrderById.mockResolvedValue({
      orderId: 999,
      orderNumber: "1001",
      items: [{ sku: "ABC-1", quantity: 1, unitPrice: 50.0 }],
      amountPaid: 54.13,
      taxAmount: 4.13,
      shippingAmount: 0,
      shipTo: { name: "Jane", street1: "123 Main", city: "Springfield", state: "IL", postalCode: "62701", country: "US" },
      advancedOptions: { customField1: "0000000100" },
    });

    const db = makeMockDb([
      { rows: [{ id: 42, shipstation_order_id: 999, external_order_number: "1001", external_order_id: "EXT", channel_name: "shopify" }] },
      { rows: [{ id: 200, order_id: 100 }] },
      {
        rows: [{
          id: 100, order_number: "1001", channel_id: 1, oms_fulfillment_order_id: "42",
          sort_rank: "0000000100", external_order_id: "EXT",
          customer_name: "Jane", customer_email: "jane@example.com",
          shipping_name: "Jane", shipping_address: "123 Main",
          shipping_city: "Springfield", shipping_state: "IL",
          shipping_postal_code: "62701", shipping_country: "US",
          amount_paid_cents: 5413, tax_cents: 413, shipping_cents: 0,
          total_cents: 5000, currency: "USD", order_placed_at: new Date(),
        }],
      },
      { rows: [{ id: 301, order_item_id: 500, sku: "ABC-1", name: "Widget", qty: 1, unit_price_cents: 5000 }] },
    ]);

    // silent = true, no per-order output expected
    const report = await runParityCheck(
      { limit: 20, orderId: null, tolerance: 1, verbose: false, silent: true },
      { db, sql: mockSql, getOrderById },
    );

    expect(report.ok).toBe(1);
    expect(report.results.length).toBe(1);
  });

  it("handles DB error gracefully (throws from db.execute)", async () => {
    const db = {
      execute: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };

    await expect(
      runParityCheck(
        { limit: 20, orderId: null, tolerance: 1, verbose: false, silent: true },
        { db, sql: mockSql, getOrderById },
      ),
    ).rejects.toThrow("connection refused");
  });
});
