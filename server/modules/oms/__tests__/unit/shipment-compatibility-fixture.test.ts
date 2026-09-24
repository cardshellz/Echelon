import { describe, expect, it } from "vitest";
import { shipmentCompatibilitySeedSql } from "../fixtures/shipment-compatibility";
import { dispatchRuntimeTables } from "../../../inventory-planning/__tests__/fixtures/inventory-availability-dispatch-runtime-fixture";

describe("shipment compatibility fixture dependency cleanup", () => {
  it("truncates operational receipts and every runtime FK dependency in the same statement", () => {
    const statement = shipmentCompatibilitySeedSql.split(";")
      .find(part => part.includes("inventory.operational_shipment_dispatch_receipts"));
    expect(statement).toBeDefined();
    expect(statement).toContain("inventory.operational_shipment_dispatch_lots");
    for (const table of dispatchRuntimeTables) expect(statement).toContain(table);
    expect(statement).toContain("RESTART IDENTITY");
  });
});
