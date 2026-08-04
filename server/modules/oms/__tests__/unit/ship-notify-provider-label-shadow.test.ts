import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "..", "shipstation.service.ts"), "utf8");

describe("SHIP_NOTIFY provider-label authority boundary", () => {
  it("records every fetched label without invoking the shipment transition", () => {
    const processShipNotify = source.indexOf("async function processShipNotify(resourceUrl");
    const loopStart = source.indexOf("for (const shipment of shipments)", processShipNotify);
    const observe = source.indexOf("await observeProviderLabel(detailedShipment)", loopStart);
    const functionEnd = source.indexOf("\n  async function confirmDispatch(", loopStart);
    const process = source.indexOf("processShipmentNotification(", loopStart);

    expect(processShipNotify).toBeGreaterThan(0);
    expect(loopStart).toBeGreaterThan(processShipNotify);
    expect(observe).toBeGreaterThan(loopStart);
    expect(functionEnd).toBeGreaterThan(observe);
    expect(process === -1 || process > functionEnd).toBe(true);
  });

  it("requires durable label observation and rejects partial webhook processing", () => {
    expect(source).toContain("requireProviderLabelObserver");
    expect(source).toContain("CARRIER_LABEL_AUTHORITY_UNAVAILABLE");
    expect(source).toContain("throw new ShipStationWebhookProcessingError");
    expect(source).not.toContain("observeProviderLabelShadow");
    expect(source).not.toContain("shadow_error");
  });

  it("permits shipment transition only from the carrier-confirmed dispatch adapter", () => {
    const confirmDispatch = source.indexOf("async function confirmDispatch(");
    const transition = source.indexOf(
      "result = await processShipmentNotification(authoritativeShipment",
      confirmDispatch,
    );

    expect(confirmDispatch).toBeGreaterThan(0);
    expect(transition).toBeGreaterThan(confirmDispatch);
    expect(source.slice(confirmDispatch, transition)).toContain(
      "CARRIER_DISPATCH_PROVIDER_LABEL_VOIDED",
    );
    expect(source.slice(confirmDispatch, transition)).toContain(
      "CARRIER_DISPATCH_TRACKING_IDENTITY_MISMATCH",
    );
  });

  it("requires explicit operator identity for manual shipment remediation", () => {
    expect(source).toContain("async function processManualShipmentNotification(");
    expect(source).toContain('source: "shipstation_manual_remediation"');
    expect(source).toContain("requiredAuthorityText(input.operator");
    expect(source).not.toContain("processShipmentNotification,");
  });
});
