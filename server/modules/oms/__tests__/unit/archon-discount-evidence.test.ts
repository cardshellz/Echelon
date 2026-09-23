import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { extractShopifyDiscountEvidence } from "../../archon-discount-evidence";
import { loadArchonSnapshot } from "../../archon-order-delivery";

function rawOrder() {
  return {
    currency: "USD",
    line_items: [
      {
        price: "10.05",
        quantity: 2,
        discount_allocations: [
          { amount: "1.00", discount_application_index: 0 },
          { amount: "0.50", discount_application_index: 1 },
        ],
      },
      {
        price: "7.00",
        quantity: 1,
        discount_allocations: [
          { amount: "0.70", discount_application_index: 0 },
        ],
      },
    ],
    shipping_lines: [
      {
        price: "5.00",
        discount_allocations: [
          { amount: "5.00", discount_application_index: 2 },
        ],
      },
    ],
    discount_applications: [
      {
        type: "manual",
        title: "Member discount",
        target_type: "line_item",
        value: "10.0",
      },
      {
        type: "discount_code",
        code: "WELCOME",
        target_type: "line_item",
        value: "5000",
      },
      {
        type: "automatic",
        title: "Free shipping",
        target_type: "shipping_line",
        value: "100.0",
      },
    ],
  };
}

describe("Shopify original discount evidence", () => {
  it("uses original prices and allocated cents, groups applications, and does not infer membership tier", () => {
    const raw = rawOrder();
    const before = structuredClone(raw);
    expect(extractShopifyDiscountEvidence(raw, "USD")).toEqual({
      version: 1,
      provider: "shopify",
      currency: "USD",
      status: "complete",
      grossMerchandiseCents: 2710,
      merchandiseDiscountCents: 220,
      shippingDiscountCents: 500,
      applications: [
        {
          key: "0:merchandise",
          code: null,
          title: "Member discount",
          type: "manual",
          target: "merchandise",
          amountCents: 170,
        },
        {
          key: "1:merchandise",
          code: "WELCOME",
          title: null,
          type: "discount_code",
          target: "merchandise",
          amountCents: 50,
        },
        {
          key: "2:shipping",
          code: null,
          title: "Free shipping",
          type: "automatic",
          target: "shipping",
          amountCents: 500,
        },
      ],
      issues: [],
    });
    expect(raw).toEqual(before);
    expect(extractShopifyDiscountEvidence({ order: raw }, "USD")).toEqual(
      extractShopifyDiscountEvidence(raw, "USD"),
    );
  });
  it("preserves explicit zero discounts only with complete empty allocation arrays", () => {
    const raw = {
      currency: "USD",
      line_items: [{ price: "0.00", quantity: 1, discount_allocations: [] }],
      shipping_lines: [],
      discount_applications: [],
    };
    expect(extractShopifyDiscountEvidence(raw, "USD")).toMatchObject({
      status: "complete",
      grossMerchandiseCents: 0,
      merchandiseDiscountCents: 0,
      shippingDiscountCents: 0,
    });
    expect(
      extractShopifyDiscountEvidence(
        { ...raw, shipping_lines: undefined },
        "USD",
      ),
    ).toMatchObject({
      status: "partial",
      shippingDiscountCents: null,
      issues: ["MISSING_SHIPPING_ALLOCATIONS"],
    });
    expect(
      extractShopifyDiscountEvidence(
        { ...raw, discount_applications: undefined },
        "USD",
      ),
    ).toMatchObject({
      merchandiseDiscountCents: null,
      shippingDiscountCents: null,
    });
  });
  it.each([
    "1.005",
    "1e3",
    "-1.00",
    "",
    " 1.00",
    1.0,
    null,
    "99999999999999.99",
  ])(
    "rejects invalid or unsafe original price %s without losing valid allocations",
    (price) => {
      const raw = rawOrder();
      const malformed = {
        ...raw,
        line_items: [{ ...raw.line_items[0], price }],
      };
      expect(extractShopifyDiscountEvidence(malformed, "USD")).toMatchObject({
        status: "partial",
        grossMerchandiseCents: null,
        merchandiseDiscountCents: 150,
      });
    },
  );
  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "2", null])(
    "rejects invalid quantity %s",
    (quantity) => {
      const raw = rawOrder();
      expect(
        extractShopifyDiscountEvidence(
          { ...raw, line_items: [{ ...raw.line_items[0], quantity }] },
          "USD",
        )?.grossMerchandiseCents,
      ).toBeNull();
    },
  );
  it("does not expose partial target totals when an allocation or application is invalid", () => {
    const raw = rawOrder();
    raw.line_items[1].discount_allocations[0].discount_application_index = 999;
    const result = extractShopifyDiscountEvidence(raw, "USD")!;
    expect(result).toMatchObject({
      status: "partial",
      grossMerchandiseCents: 2710,
      merchandiseDiscountCents: null,
      shippingDiscountCents: 500,
      issues: ["INVALID_MERCHANDISE_ALLOCATIONS"],
    });
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0].target).toBe("shipping");
  });
  it("rejects target mismatches, missing arrays, and decimal allocation precision", () => {
    const raw = rawOrder();
    raw.discount_applications[0].target_type = "shipping_line";
    expect(
      extractShopifyDiscountEvidence(raw, "USD")?.merchandiseDiscountCents,
    ).toBeNull();
    expect(
      extractShopifyDiscountEvidence(
        {
          ...rawOrder(),
          shipping_lines: [
            {
              discount_allocations: [
                { amount: "0.001", discount_application_index: 2 },
              ],
            },
          ],
        },
        "USD",
      )?.shippingDiscountCents,
    ).toBeNull();
    expect(
      extractShopifyDiscountEvidence(
        { ...rawOrder(), line_items: [{ price: "1.00", quantity: 1 }] },
        "USD",
      )?.merchandiseDiscountCents,
    ).toBeNull();
  });
  it("never guesses currencies and produces unavailable evidence for missing payloads", () => {
    expect(
      extractShopifyDiscountEvidence(rawOrder(), undefined),
    ).toBeUndefined();
    for (const currency of ["JPY", "CAD"]) {
      expect(
        extractShopifyDiscountEvidence(rawOrder(), currency),
      ).toMatchObject({
        status: "unavailable",
        grossMerchandiseCents: null,
        applications: [],
      });
    }
    expect(extractShopifyDiscountEvidence(null, "USD")).toMatchObject({
      status: "unavailable",
      issues: ["MISSING_OR_MISMATCHED_CURRENCY"],
    });
  });
  it("rejects repeated application indexes on one line instead of double counting", () => {
    const raw = rawOrder();
    raw.line_items[0].discount_allocations.push({
      ...raw.line_items[0].discount_allocations[0],
    });
    expect(
      extractShopifyDiscountEvidence(raw, "USD")?.merchandiseDiscountCents,
    ).toBeNull();
  });
  it("checks safe integer multiplication and aggregation", () => {
    const raw = {
      ...rawOrder(),
      line_items: [
        { price: "90071992547409.91", quantity: 2, discount_allocations: [] },
      ],
    };
    expect(
      extractShopifyDiscountEvidence(raw, "USD")?.grossMerchandiseCents,
    ).toBeNull();
    expect(
      extractShopifyDiscountEvidence(
        { ...raw, line_items: [{ ...raw.line_items[0], quantity: 1 }] },
        "USD",
      )?.grossMerchandiseCents,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("does not report discounts exceeding the known original line total", () => {
    const raw = rawOrder();
    raw.line_items[0].discount_allocations[0].amount = "100.00";
    const evidence = extractShopifyDiscountEvidence(raw, "USD")!;
    expect(evidence).toMatchObject({
      status: "partial",
      grossMerchandiseCents: 2710,
      merchandiseDiscountCents: null,
      shippingDiscountCents: 500,
      issues: ["MERCHANDISE_DISCOUNT_EXCEEDS_GROSS"],
    });
    expect(
      evidence.applications.every((entry) => entry.target === "shipping"),
    ).toBe(true);
  });
});

describe("Archon snapshot optional evidence delivery", () => {
  async function snapshot(raw: unknown, provider = "shopify") {
    const db = {
      query: async (sql: string) => ({
        rows: sql.includes("oms.oms_orders")
          ? [
              {
                id: 1,
                channel_id: 2,
                external_order_id: "123",
                raw_payload: raw,
                total_cents: 2490,
                subtotal_cents: 2490,
                shipping_cents: 0,
                tax_cents: 0,
                discount_cents: 720,
                refund_amount_cents: 0,
                currency: "USD",
                financial_status: "paid",
                fulfillment_status: "unfulfilled",
                ordered_at: new Date("2026-09-22T00:00:00Z"),
              },
            ]
          : sql.includes("channels.channels")
            ? [{ name: "Store", provider, shipping_config: {} }]
            : [],
      }),
    } as unknown as PoolClient;
    return loadArchonSnapshot(db, 1, "1");
  }
  it("validates and forwards the additive contract through the actual snapshot builder", async () => {
    const result = await snapshot(rawOrder());
    expect(result.order.discount_evidence).toEqual(
      extractShopifyDiscountEvidence(rawOrder(), "USD"),
    );
    expect(result.order.total_cents).toBe(2490);
  });
  it("still delivers the financial snapshot with unavailable optional evidence", async () => {
    const result = await snapshot({ currency: "USD", line_items: "malformed" });
    expect(result.order.total_cents).toBe(2490);
    expect(result.order.discount_evidence?.status).toBe("unavailable");
  });
  it("does not classify another connector's payload as Shopify", async () => {
    expect(
      (await snapshot(rawOrder(), "ebay")).order.discount_evidence,
    ).toBeUndefined();
  });
});
