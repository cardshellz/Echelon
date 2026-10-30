import { describe, expect, it } from "vitest";
import { automaticPaidReplayEvidenceSchema, decideAutomaticPaidReplay } from "../../domain/shopify-paid-replay-policy";
import { paidReplayFixture } from "../fixtures/shopify-paid-replay.fixture";

describe("automatic paid receipt replay policy", () => {
  it("accepts the three seen, zero-authority lines missed by the old sweep without mutating evidence", () => {
    const fixture = paidReplayFixture();
    const before = structuredClone(fixture);
    expect(decideAutomaticPaidReplay(fixture.stored, fixture.lines, fixture.evidence)).toEqual({ eligible: true });
    expect(fixture).toEqual(before);
  });
  it.each([
    { financial_status: "refunded" }, { financial_status: "partially_refunded" },
    { financial_status: "partially_paid" }, { financial_status: "pending" },
    { cancelled_at: "2026-10-30T12:00:45Z" },
    { fulfillment_status: "fulfilled" }, { fulfillment_status: "partial" },
    { refunds: [{ id: "1" }] }, { fulfillments: [{ id: "1" }] },
  ])("refuses unsafe current Shopify state %j", change => {
    const fixture = paidReplayFixture();
    Object.assign(fixture.evidence.order, change);
    expect(decideAutomaticPaidReplay(fixture.stored, fixture.lines, fixture.evidence).eligible).toBe(false);
  });
  it.each([
    { sku: "OTHER" }, { id: "999" }, { quantity: 2 }, { current_quantity: 0 },
    { fulfillable_quantity: 0 }, { requires_shipping: false },
  ])("refuses changed provider lines %j", change => {
    const fixture = paidReplayFixture();
    Object.assign(fixture.evidence.order.line_items[0], change);
    expect(decideAutomaticPaidReplay(fixture.stored, fixture.lines, fixture.evidence).eligible).toBe(false);
  });
  it.each([
    { channel_id: 37 }, { external_order_id: "1002" }, { source_domain: "other.myshopify.com" },
    { status: "shipped" }, { status: "cancelled" }, { status: "refunded" }, { status: "partially_shipped" },
    { financial_status: "partially_paid" }, { fulfillment_status: "fulfilled" }, { settled: false },
    { paid_payload: null },
  ])("refuses unsafe locked OMS or original receipt state %j", change => {
    const fixture = paidReplayFixture();
    Object.assign(fixture.stored, change);
    expect(decideAutomaticPaidReplay(fixture.stored, fixture.lines, fixture.evidence).eligible).toBe(false);
  });
  it.each([
    { paid_quantity: 1 }, { authority_fulfillable_quantity: 1 }, { refunded_quantity: 1 },
    { cancelled_quantity: 1 }, { wms_materialized_quantity: 1 }, { authorization_status: "review" },
    { channel_current_quantity: 0 }, { channel_quantity_updated_at: "2026-10-30T12:02:00Z" },
    { channel_quantity_updated_at: "invalid" }, { quantity: 2 }, { sku: "OTHER" },
  ])("refuses changed locked OMS line state %j", change => {
    const fixture = paidReplayFixture();
    Object.assign(fixture.lines[0], change);
    expect(decideAutomaticPaidReplay(fixture.stored, fixture.lines, fixture.evidence).eligible).toBe(false);
  });
  it("accepts canonical Shopify GIDs and unobserved current quantities", () => {
    const fixture = paidReplayFixture();
    fixture.stored.external_order_id = "gid://shopify/Order/1001";
    fixture.lines[0].channel_current_quantity = null;
    fixture.lines[0].channel_quantity_updated_at = null;
    expect(decideAutomaticPaidReplay(fixture.stored, fixture.lines, fixture.evidence)).toEqual({ eligible: true });
  });
  it("refuses missing, duplicate and mismatched original receipt lines", () => {
    for (const change of ["missing", "duplicate", "original", "future_receipt"]) {
      const fixture = paidReplayFixture();
      if (change === "missing") fixture.lines.pop();
      if (change === "duplicate") fixture.evidence.order.line_items.push(fixture.evidence.order.line_items[0]);
      if (change === "original") fixture.stored.paid_payload = { ...fixture.evidence.order, id: "1002" };
      if (change === "future_receipt") fixture.stored.paid_payload = {
        ...fixture.evidence.order, updated_at: "2026-10-30T12:02:00Z",
      };
      expect(decideAutomaticPaidReplay(fixture.stored, fixture.lines, fixture.evidence).eligible, change).toBe(false);
    }
  });
  it.each([
    { channelId: 0 }, { shopDomain: "https://other.invalid" }, { order: {} },
  ])("rejects malformed input %j", change => {
    expect(automaticPaidReplayEvidenceSchema.safeParse({ ...paidReplayFixture().evidence, ...change }).success).toBe(false);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, Number.NaN])("rejects invalid provider quantities %s", value => {
    const fixture = paidReplayFixture();
    fixture.evidence.order.line_items[0].quantity = value;
    expect(automaticPaidReplayEvidenceSchema.safeParse(fixture.evidence).success).toBe(false);
  });
});
