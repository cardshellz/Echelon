import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "..", "shipstation.service.ts"), "utf8");

describe("SHIP_NOTIFY provider-label shadow boundary", () => {
  it("durably observes labels before legacy processing without synchronously reconciling links", () => {
    const processShipNotify = source.indexOf("async function processShipNotify(resourceUrl");
    const loopStart = source.indexOf("for (const shipment of shipments)", processShipNotify);
    const observe = source.indexOf("await observeProviderLabelShadow(shipment)", loopStart);
    const process = source.indexOf("await processShipmentNotification(shipment)", loopStart);
    const loopEnd = source.indexOf("if (failures.length > 0)", loopStart);

    expect(processShipNotify).toBeGreaterThan(0);
    expect(loopStart).toBeGreaterThan(processShipNotify);
    expect(observe).toBeGreaterThan(loopStart);
    expect(process).toBeGreaterThan(observe);
    expect(loopEnd).toBeGreaterThan(process);
    expect(source.slice(loopStart, loopEnd)).not.toContain("reconcileProviderLabelLinks");
  });

  it("keeps shadow observation errors separate from established fulfillment processing", () => {
    expect(source).toContain('outcome: "shadow_error"');
    expect(source).toContain('action: "shipping_provider_label_observation_failed"');
  });
});
