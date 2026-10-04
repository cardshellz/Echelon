import { describe, expect, it } from "vitest";
import { customerReturnLabelSettingsSchema, customerReturnLabelSubmitInputSchema } from "@shared/returns/customer-return-label.contract";
import { customerReturnPreflightShipments, customerReturnWarehouseAddressType } from "../../application/customer-return-shipping-plan";
import { prepareCustomerReturnIntake } from "../../application/customer-return-intake-preparation";
import { labelSettings, labelPolicy, labelPreparationFixture, LABEL_LEASE } from "../support/label-fixtures";

describe("server-owned return address classification", () => {
  it.each([undefined, "commercial", "residential"] as const)("uses and freezes the policy's warehouse classification %s", async warehouseAddressType => {
    const f = await labelPreparationFixture();
    const settings = customerReturnLabelSettingsSchema.parse({ ...labelSettings, warehouseAddressType });
    const before = structuredClone(settings);
    const prepared = prepareCustomerReturnIntake(f.input, f.inspection, settings,
      { id: 1, version: 1, snapshot: labelPolicy }, "admin", LABEL_LEASE);
    const expected = warehouseAddressType ?? "commercial";
    expect(prepared.warehouseSnapshot.addressType).toBe(expected);
    const quotes = customerReturnPreflightShipments(prepared.parcels[0].originAddress,
      settings, prepared.parcels);
    for (const quote of quotes) {
      expect(quote.shipTo).toEqual({ ...settings.destinationAddress, addressType: expected });
      expect(quote.shipFrom).toEqual(prepared.parcels[0].originAddress);
      expect(quote.shipFrom.addressType).toBeUndefined();
    }
    expect(settings).toEqual(before);
  });
  it.each([null, "unknown", "yes", "no", "business", ""])("fails closed for invalid warehouse classification %s", value => {
    expect(() => customerReturnWarehouseAddressType(value)).toThrow();
    expect(customerReturnLabelSettingsSchema.safeParse({ ...labelSettings, warehouseAddressType: value }).success).toBe(false);
  });
  it("does not accept a customer override of the admin-owned classification", async () => {
    const f = await labelPreparationFixture();
    expect(customerReturnLabelSubmitInputSchema.safeParse({ ...f.input, warehouseAddressType: "residential" }).success).toBe(false);
    expect(customerReturnLabelSubmitInputSchema.safeParse({ ...f.input, shipTo: { addressType: "residential" } }).success).toBe(false);
  });
  it("does not change legacy saved configuration JSON while parsing", () => {
    const parsed = customerReturnLabelSettingsSchema.parse(labelSettings);
    expect(parsed).not.toHaveProperty("warehouseAddressType");
    expect(parsed).toEqual(labelSettings);
  });
});
