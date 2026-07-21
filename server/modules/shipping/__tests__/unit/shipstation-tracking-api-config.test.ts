import { afterEach, describe, expect, it } from "vitest";

import {
  normalizeShipStationTrackingApiBaseUrl,
  resolveShipStationTrackingApiKey,
  SHIPSTATION_TRACKING_API_BASE_URL,
} from "../../shipstation-tracking-api-config";

const originalTrackingKey = process.env.SHIPSTATION_TRACKING_API_KEY;
const originalV2Key = process.env.SHIPSTATION_V2_API_KEY;

afterEach(() => {
  if (originalTrackingKey === undefined) delete process.env.SHIPSTATION_TRACKING_API_KEY;
  else process.env.SHIPSTATION_TRACKING_API_KEY = originalTrackingKey;
  if (originalV2Key === undefined) delete process.env.SHIPSTATION_V2_API_KEY;
  else process.env.SHIPSTATION_V2_API_KEY = originalV2Key;
});

describe("ShipStation tracking API configuration", () => {
  it("uses the documented standalone ShipStation API base URL", () => {
    expect(SHIPSTATION_TRACKING_API_BASE_URL).toBe("https://api.shipengine.com/v1");
  });

  it("normalizes only credential-free HTTPS API origins", () => {
    expect(normalizeShipStationTrackingApiBaseUrl("https://api.shipengine.test/v1/"))
      .toBe("https://api.shipengine.test/v1");
    expect(() => normalizeShipStationTrackingApiBaseUrl("http://api.shipengine.test/v1"))
      .toThrow(/HTTPS/);
    expect(() => normalizeShipStationTrackingApiBaseUrl("https://user:pass@api.shipengine.test/v1"))
      .toThrow(/credentials/);
    expect(() => normalizeShipStationTrackingApiBaseUrl("https://api.shipengine.test/v1?key=secret"))
      .toThrow(/query string/);
  });

  it("requires a dedicated tracking API key instead of assuming V2 credentials are interchangeable", () => {
    delete process.env.SHIPSTATION_TRACKING_API_KEY;
    process.env.SHIPSTATION_V2_API_KEY = "unproven-v2-key";

    expect(resolveShipStationTrackingApiKey()).toBe("");

    process.env.SHIPSTATION_TRACKING_API_KEY = " tracking-key ";
    expect(resolveShipStationTrackingApiKey()).toBe("tracking-key");
  });
});
