import { describe, expect, it } from "vitest";
import { customerReturnContactAddress, customerReturnPreflightShipments } from "../../application/customer-return-shipping-plan";
import { prepareCustomerReturnIntake } from "../../application/customer-return-intake-preparation";
import { buildReturnLabelRequest } from "../../../shipping-engine/infrastructure/shipstation-return-label.adapter";
import { buildReturnRateRequest } from "../../../shipping-engine/infrastructure/shipstation-return-rate.adapter";
import { labelAddress, labelSettings, labelPreparationFixture, labelPolicy, LABEL_LEASE } from "../support/label-fixtures";

const BUSINESS_PHONE = "512-555-0100";
const CUSTOMER_PHONE = "512-555-0199";

describe("policy-owned return shipping contact", () => {
  it("uses the business number for a missing contact without mutating source addresses", () => {
    const address = { ...labelAddress, name: "Customer" };
    const settings = { ...labelSettings, contactPhone: BUSINESS_PHONE };
    const before = structuredClone({ address, settings });
    expect(customerReturnContactAddress(address, settings)).toEqual({ ...address, phone: BUSINESS_PHONE });
    expect({ address, settings }).toEqual(before);
  });

  it("preserves a supplied customer number and falls back to the configured destination contact", () => {
    const settings = { ...labelSettings, destinationAddress: { ...labelAddress, phone: BUSINESS_PHONE } };
    expect(customerReturnContactAddress({ ...labelAddress, phone: CUSTOMER_PHONE }, settings).phone).toBe(CUSTOMER_PHONE);
    expect(customerReturnContactAddress(labelAddress, settings).phone).toBe(BUSINESS_PHONE);
    expect(customerReturnContactAddress(labelAddress, labelSettings)).not.toHaveProperty("phone");
  });

  it("rejects an invalid business contact instead of sending unchecked provider fields", () => {
    expect(() => customerReturnContactAddress(labelAddress, { ...labelSettings, contactPhone: "123\n456" })).toThrow();
  });

  it("freezes the same business contact into mixed-box quotes and durable label inputs", async () => {
    const f = await labelPreparationFixture();
    const before = structuredClone({ provider: f.inspection.provider, input: f.input });
    const settings = { ...labelSettings, contactPhone: BUSINESS_PHONE };
    const prepared = prepareCustomerReturnIntake(f.input, f.inspection, settings,
      { id: 1, version: 1, snapshot: labelPolicy }, "test", LABEL_LEASE);
    const shipments = customerReturnPreflightShipments(prepared.parcels[0].originAddress, settings, prepared.parcels);
    expect(shipments).toHaveLength(2);
    for (const [index, shipment] of shipments.entries()) {
      const parcel = prepared.parcels[index];
      expect(parcel.originAddress.phone).toBe(BUSINESS_PHONE);
      expect(parcel.destinationAddress.phone).toBe(BUSINESS_PHONE);
      const quoteBody = buildReturnRateRequest({ shipment, carrierIds: ["se-123"] }) as { shipment: unknown };
      const labelBody = buildReturnLabelRequest({ ...shipment, externalShipmentId: `return-${index + 1}`,
        rmaNumber: "RMA-1", carrierId: "se-123", serviceCode: "ups_ground" }) as { shipment: unknown };
      expect(quoteBody.shipment).toMatchObject({ ship_from: { phone: BUSINESS_PHONE }, ship_to: { phone: BUSINESS_PHONE } });
      expect(labelBody.shipment).toMatchObject({ ship_from: { phone: BUSINESS_PHONE }, ship_to: { phone: BUSINESS_PHONE } });
      expect(shipment.shipFrom).toEqual(parcel.originAddress);
    }
    expect({ provider: f.inspection.provider, input: f.input }).toEqual(before);
  });
});
