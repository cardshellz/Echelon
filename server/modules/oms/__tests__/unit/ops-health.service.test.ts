import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const OPS_HEALTH_SRC = readFileSync(
  resolve(__dirname, "../../ops-health.service.ts"),
  "utf-8",
);

describe("ops-health.service :: fulfillment alert severity", () => {
  it("treats stuck ShipStation push and missing tracking confirmation as critical", () => {
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION"[\s\S]*severity: "critical"/,
    );
    expect(OPS_HEALTH_SRC).toMatch(
      /code: "SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED"[\s\S]*severity: "critical"/,
    );
  });
});
