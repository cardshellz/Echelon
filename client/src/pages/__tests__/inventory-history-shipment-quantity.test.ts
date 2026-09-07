import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => ({ data: [] as unknown[], isLoading: false, refetch: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => query }));
import InventoryHistory from "../InventoryHistory";

beforeEach(() => {
  query.data = [{ id: 1, transactionType: "ship", variantQtyDelta: 0, variantQtyBefore: 12, variantQtyAfter: 12,
    shipmentQuantityEvidence: { status: "verified", quantity: 3, source: "canonical_dispatch_receipt", receiptId: "81" },
    createdAt: "2026-09-07T12:00:00Z", sourceState: "picked", targetState: "shipped", product: { baseSku: "P5", name: "Pack of 5" } }];
});

describe("InventoryHistory canonical shipment rows", () => {
  it("uses separate shipped units and on-hand deltas in both responsive layouts", () => {
    const html = renderToStaticMarkup(createElement(InventoryHistory));
    expect(html).toContain('data-testid="card-transaction-1"');
    expect(html).toContain('data-testid="row-transaction-1"');
    expect(html.match(/3 shipped/g)).toHaveLength(2);
    expect(html.match(/On-hand Δ 0/g)).toHaveLength(2);
    expect(html).toContain("Quantity / On-hand Δ");
  });

  it("shows review in both layouts when canonical quantity cannot be verified", () => {
    query.data = [{ ...(query.data[0] as object), shipmentQuantityEvidence: {
      status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID", reason: "Receipt missing." } }];
    const html = renderToStaticMarkup(createElement(InventoryHistory));
    expect(html.match(/Shipment quantity needs review/g)).toHaveLength(2);
    expect(html).not.toContain("0 shipped");
  });
});
