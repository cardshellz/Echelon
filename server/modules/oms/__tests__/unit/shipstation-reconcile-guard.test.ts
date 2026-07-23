import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INDEX_PATH = resolve(__dirname, "../../../../index.ts");

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("ShipStation reconciliation canonical identity guard", () => {
  const source = readFileSync(INDEX_PATH, "utf8");
  const reconcileBlock = sourceBetween(
    source,
    "const runShipStationReconcileV2 = async () => {",
    "const runShipStationReconcile = async () => {",
  );

  it("uses warehouse order number as the stable inbound lookup key", () => {
    expect(reconcileBlock).toContain("w.order_number");
    expect(reconcileBlock).toContain("const orderNumber = String(row.order_number");
    expect(reconcileBlock).toContain("orderNumber ? { orderNumber }");
  });

  it("does not cast the legacy OMS reference or join package facts by it", () => {
    expect(reconcileBlock).not.toContain("oms_fulfillment_order_id::int");
    expect(reconcileBlock).not.toContain("o.id = w.oms_fulfillment_order_id");
    expect(reconcileBlock).not.toContain("o.external_order_id = w.oms_fulfillment_order_id");
  });

  it("routes shipped and voided package facts through canonical authority", () => {
    expect(reconcileBlock).toContain("engine.applyInboundShipmentAuthority({");
    expect(reconcileBlock).toContain("engineRef: ref");
    expect(reconcileBlock).toContain("orderNumber");
    expect(reconcileBlock).toContain(
      'event.kind === "shipped" || event.kind === "voided"',
    );
  });

  it("never advances OMS fulfillment with an order-level status write", () => {
    expect(reconcileBlock).not.toMatch(/UPDATE\s+oms\.oms_orders/i);
    expect(reconcileBlock).not.toContain("markOrderShipped(");
    expect(reconcileBlock).not.toContain("runShipStationReconcileV1");
  });
});
