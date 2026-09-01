import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Inbound shipment detail error-state contract", () => {
  const source = readFileSync("client/src/pages/InboundShipmentDetail.tsx", "utf8");

  it("does not present a failed detail request as a missing shipment", () => {
    const requestFailureState = source.indexOf("if (shipmentError && !shipment)");
    const missingShipmentState = source.indexOf("if (!shipment)", requestFailureState + 1);

    expect(source).toContain("error: shipmentError");
    expect(requestFailureState).toBeGreaterThanOrEqual(0);
    expect(missingShipmentState).toBeGreaterThan(requestFailureState);
    expect(source).toContain('"Unable to load shipment."');
    expect(source).toContain("void refetchShipment()");
  });
});
