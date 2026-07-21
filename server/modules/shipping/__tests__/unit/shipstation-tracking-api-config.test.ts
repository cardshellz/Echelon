import { afterEach, describe, expect, it } from "vitest";

import {
  assertValidShipStationTrackingWebhookSecret,
  normalizeShipStationTrackingApiBaseUrl,
  resolveShipStationTrackingApiKey,
  resolveShipStationTrackingWebhookSecret,
  SHIPSTATION_TRACKING_API_BASE_URL,
} from "../../shipstation-tracking-api-config";

const originalTrackingKey = process.env.SHIPSTATION_TRACKING_API_KEY;
const originalV2Key = process.env.SHIPSTATION_V2_API_KEY;
const originalWebhookSecret = process.env.SHIPSTATION_TRACKING_WEBHOOK_SECRET;

afterEach(() => {
  if (originalTrackingKey === undefined) delete process.env.SHIPSTATION_TRACKING_API_KEY;
  else process.env.SHIPSTATION_TRACKING_API_KEY = originalTrackingKey;
  if (originalV2Key === undefined) delete process.env.SHIPSTATION_V2_API_KEY;
  else process.env.SHIPSTATION_V2_API_KEY = originalV2Key;
  if (originalWebhookSecret === undefined) delete process.env.SHIPSTATION_TRACKING_WEBHOOK_SECRET;
  else process.env.SHIPSTATION_TRACKING_WEBHOOK_SECRET = originalWebhookSecret;
});

describe("ShipStation tracking API configuration", () => {
  it("uses the documented ShipStation application V2 API base URL", () => {
    expect(SHIPSTATION_TRACKING_API_BASE_URL).toBe("https://api.shipstation.com/v2");
  });

  it("normalizes only credential-free HTTPS API origins", () => {
    expect(normalizeShipStationTrackingApiBaseUrl("https://api.shipstation.test/v2/"))
      .toBe("https://api.shipstation.test/v2");
    expect(() => normalizeShipStationTrackingApiBaseUrl("http://api.shipstation.test/v2"))
      .toThrow(/HTTPS/);
    expect(() => normalizeShipStationTrackingApiBaseUrl("https://user:pass@api.shipstation.test/v2"))
      .toThrow(/credentials/);
    expect(() => normalizeShipStationTrackingApiBaseUrl("https://api.shipstation.test/v2?key=secret"))
      .toThrow(/query string/);
  });

  it("uses only the ShipStation V2 key and ignores the standalone API key", () => {
    delete process.env.SHIPSTATION_V2_API_KEY;
    process.env.SHIPSTATION_TRACKING_API_KEY = "standalone-key";

    expect(resolveShipStationTrackingApiKey()).toBe("");

    process.env.SHIPSTATION_V2_API_KEY = " v2-key ";
    expect(resolveShipStationTrackingApiKey()).toBe("v2-key");
  });

  it("keeps webhook authentication separate from the full-access API key", () => {
    process.env.SHIPSTATION_V2_API_KEY = "v2-key";
    delete process.env.SHIPSTATION_TRACKING_WEBHOOK_SECRET;
    expect(resolveShipStationTrackingWebhookSecret()).toBe("");

    process.env.SHIPSTATION_TRACKING_WEBHOOK_SECRET = ` ${"s".repeat(32)} `;
    expect(resolveShipStationTrackingWebhookSecret()).toBe("s".repeat(32));
    expect(() => assertValidShipStationTrackingWebhookSecret("short")).toThrow(/32/);
    expect(() => assertValidShipStationTrackingWebhookSecret("s".repeat(32))).not.toThrow();
  });
});
