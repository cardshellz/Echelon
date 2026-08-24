import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "server/modules/returns/infrastructure/open-return-case.repository.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("open return case repository contract", () => {
  it("excludes non-shipping lines from source search, counts, and detail eligibility", () => {
    expect(source.match(/AND oi\.requires_shipping <> 0/g) ?? []).toHaveLength(4);
  });

  it("resolves provider line identity from the OMS line constrained to the source order", () => {
    expect(source).toContain("LEFT JOIN oms.oms_order_lines ol");
    expect(source).toContain("ON ol.id = oi.oms_order_line_id");
    expect(source).toContain("AND ol.order_id = ${omsOrderId}");
    expect(source).toContain("oi.source_item_id AS wms_external_line_item_id");
    expect(source).toContain("ol.external_line_item_id AS oms_external_line_item_id");
    expect(source).toContain("resolveReturnCaseExternalLineItemId({");
  });
});
