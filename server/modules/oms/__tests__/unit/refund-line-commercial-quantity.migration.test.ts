import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function migration(path: string): string {
  return readFileSync(resolve(process.cwd(), "migrations", path), "utf8");
}

function commercialGuard(sql: string): string {
  const match = sql.match(
    /CREATE OR REPLACE FUNCTION oms\.validate_package_allocation_commercial_fulfillment_item\(\)[\s\S]*?\$\$;/,
  );
  if (!match) throw new Error("Package-allocation commercial guard is missing");
  return match[0].replace(/--[^\r\n]*/g, "").replace(/\s+/g, " ").trim();
}

describe("refund-line commercial quantity migration", () => {
  it("bounds current demand by the retained physical source quantity", () => {
    expect(migration("0681_outbound_shipment_commercial_requested_quantity.sql"))
      .toContain("commercial_requested_qty BETWEEN 0 AND qty");
  });

  it("retains every label and lineage guard while allowing a smaller channel quantity", () => {
    const previous = commercialGuard(migration("0674_label_time_package_portions.sql"));
    const current = commercialGuard(migration("0681_outbound_shipment_commercial_requested_quantity.sql"));
    expect(current).toBe(previous.replace(
      "OR NEW.quantity_pushed IS DISTINCT FROM lineage.physical_quantity",
      "OR NEW.quantity_pushed <= 0 OR NEW.quantity_pushed > lineage.physical_quantity",
    ));
  });
});
