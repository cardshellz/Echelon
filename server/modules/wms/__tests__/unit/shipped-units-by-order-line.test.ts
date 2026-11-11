import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { WmsShippingProgressError } from "@shared/wms-shipping-progress";
import {
  shippedUnitsByOrderLine,
  shippedUnitsByOrderLineQuery,
  wmsShippingProgressQuery,
} from "../../shipping-progress.query";

const dialect = new PgDialect();
const render = (query: Parameters<PgDialect["sqlToQuery"]>[0]) => dialect.sqlToQuery(query);
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The shipment-evidence subquery both readers must share, as rendered SQL. */
function evidence(text: string): string {
  const start = text.indexOf("FROM (");
  const end = text.indexOf(") evidence");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return squash(text.slice(start + "FROM (".length, end));
}

describe("shipped units by order line", () => {
  it("reads every line of the requested orders without taking locks", () => {
    const { sql: text, params } = render(shippedUnitsByOrderLineQuery([1216318, 7]));
    const rendered = squash(text);
    expect(params).toEqual([1216318, 7]);
    expect(rendered).toContain("FROM oms.oms_order_lines ol LEFT JOIN wms.order_items oi ON oi.oms_order_line_id = ol.id");
    expect(rendered).toContain("WHERE ol.order_id IN ($1, $2)");
    expect(rendered).toContain("GROUP BY ol.order_id, ol.id");
    expect(rendered).not.toMatch(/FOR (UPDATE|SHARE)/i);
    expect(rendered).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it("uses exactly the same shipment evidence as the locking progress query", () => {
    const read = evidence(render(shippedUnitsByOrderLineQuery([1])).sql);
    const locking = evidence(render(wmsShippingProgressQuery([1])).sql);
    expect(read).toBe(locking);
    expect(read).toContain("wms.effective_physical_shipment_items");
    expect(read).toContain("package.status IN ('shipped', 'returned')");
  });

  it.each([[[]], [[0]], [[-1]], [[1.5]], [[Number.NaN]], [[1, Number.MAX_SAFE_INTEGER + 1]]])(
    "rejects invalid order ids %j",
    (ids) => {
      expect(() => shippedUnitsByOrderLineQuery(ids as number[])).toThrow(WmsShippingProgressError);
    },
  );

  it("maps database rows, including bigint strings and zero", () => {
    expect(shippedUnitsByOrderLine({ oms_order_id: "1216318", oms_order_line_id: "124243", shipped_quantity: "0" }))
      .toEqual({ omsOrderId: 1216318, omsOrderLineId: 124243, shippedQuantity: 0 });
    expect(shippedUnitsByOrderLine({ oms_order_id: 5, oms_order_line_id: 9, shipped_quantity: 3 }))
      .toEqual({ omsOrderId: 5, omsOrderLineId: 9, shippedQuantity: 3 });
  });

  it.each([
    { oms_order_id: "1", oms_order_line_id: "2", shipped_quantity: "-1" },
    { oms_order_id: "1", oms_order_line_id: "2", shipped_quantity: "1.5" },
    { oms_order_id: "1", oms_order_line_id: "2", shipped_quantity: "abc" },
    { oms_order_id: "0", oms_order_line_id: "2", shipped_quantity: "1" },
    { oms_order_id: "1", oms_order_line_id: "0", shipped_quantity: "1" },
  ])("rejects an invalid row %j", (row) => {
    expect(() => shippedUnitsByOrderLine(row)).toThrow(WmsShippingProgressError);
  });
});
