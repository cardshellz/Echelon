import { describe, expect, it } from "vitest";
import {
  buildRatesRequestBody,
  createShipStationV2RatingAdapter,
  gramsToOunces,
  mapV2CarrierCode,
  mmToInches,
  normalizeCarriersResponse,
  normalizeRatesResponse,
  parseRetryAfterSeconds,
  type V2RateRequest,
} from "../../infrastructure/shipstation-v2-rating.adapter";

const REQUEST: V2RateRequest = {
  carrierIds: ["se-111", "se-222"],
  from: {
    name: "CardShellz",
    addressLine1: "1 Warehouse Way",
    city: "Las Vegas",
    state: "NV",
    postalCode: "89101",
    countryCode: "US",
  },
  to: { postalCode: "96813", countryCode: "US" },
  parcels: [{ weightGrams: 453.59237, lengthMm: 254, widthMm: 127, heightMm: 50.8 }],
};

describe("unit conversions", () => {
  it("converts grams to ounces at 2dp", () => {
    expect(gramsToOunces(453.59237)).toBe(16);
    expect(gramsToOunces(100)).toBe(3.53);
  });

  it("never rounds a positive weight down to zero", () => {
    expect(gramsToOunces(0.1)).toBe(0.01);
  });

  it("returns 0 for non-positive or non-finite grams", () => {
    expect(gramsToOunces(0)).toBe(0);
    expect(gramsToOunces(-5)).toBe(0);
    expect(gramsToOunces(Number.NaN)).toBe(0);
  });

  it("converts mm to inches at 2dp", () => {
    expect(mmToInches(254)).toBe(10);
    expect(mmToInches(100)).toBe(3.94);
    expect(mmToInches(0)).toBe(0);
  });
});

describe("mapV2CarrierCode", () => {
  it("maps the wallet carrier codes to display carriers", () => {
    expect(mapV2CarrierCode("stamps_com")).toBe("USPS");
    expect(mapV2CarrierCode("usps")).toBe("USPS");
    expect(mapV2CarrierCode("ups")).toBe("UPS");
    expect(mapV2CarrierCode("ups_walleted")).toBe("UPS");
    expect(mapV2CarrierCode("fedex")).toBe("FedEx");
    expect(mapV2CarrierCode("dhl_express_worldwide")).toBe("DHL");
  });

  it("is case-insensitive and uppercases unknown codes", () => {
    expect(mapV2CarrierCode("Stamps_Com")).toBe("USPS");
    expect(mapV2CarrierCode("globalpost")).toBe("GLOBALPOST");
  });
});

describe("buildRatesRequestBody", () => {
  it("builds the ShipEngine /v2/rates shape with converted units", () => {
    expect(buildRatesRequestBody(REQUEST)).toEqual({
      rate_options: { carrier_ids: ["se-111", "se-222"] },
      shipment: {
        validate_address: "no_validation",
        ship_from: {
          name: "CardShellz",
          address_line1: "1 Warehouse Way",
          city_locality: "Las Vegas",
          state_province: "NV",
          postal_code: "89101",
          country_code: "US",
        },
        ship_to: { postal_code: "96813", country_code: "US" },
        packages: [
          {
            weight: { value: 16, unit: "ounce" },
            dimensions: { unit: "inch", length: 10, width: 5, height: 2 },
          },
        ],
      },
    });
  });

  it("defaults carrier_ids to an empty list", () => {
    const body = buildRatesRequestBody({ ...REQUEST, carrierIds: undefined }) as {
      rate_options: { carrier_ids: string[] };
    };
    expect(body.rate_options.carrier_ids).toEqual([]);
  });

  it("omits dimensions when any dimension is missing or zero", () => {
    const body = buildRatesRequestBody({
      ...REQUEST,
      parcels: [{ weightGrams: 100, lengthMm: 254, widthMm: 0, heightMm: 50 }],
    }) as { shipment: { packages: Array<Record<string, unknown>> } };
    expect(body.shipment.packages[0]).toEqual({ weight: { value: 3.53, unit: "ounce" } });
  });
});

describe("normalizeRatesResponse", () => {
  const payload = {
    rate_response: {
      rates: [
        {
          carrier_code: "stamps_com",
          service_code: "usps_ground_advantage",
          service_type: "USPS Ground Advantage",
          shipping_amount: { currency: "usd", amount: 7.9 },
          other_amount: { currency: "usd", amount: 0.35 },
          insurance_amount: { currency: "usd", amount: 0 },
          confirmation_amount: { currency: "usd", amount: 0 },
          delivery_days: 3,
          estimated_delivery_date: "2026-07-08T00:00:00Z",
        },
        {
          carrier_code: "ups_walleted",
          service_code: "ups_ground",
          shipping_amount: { currency: "usd", amount: 11.02 },
        },
      ],
    },
  };

  it("normalizes rates, mapping carriers and summing amounts to integer cents", () => {
    expect(normalizeRatesResponse(payload)).toEqual([
      {
        carrier: "USPS",
        serviceCode: "usps_ground_advantage",
        serviceName: "USPS Ground Advantage",
        amountCents: 825,
        currency: "USD",
        deliveryDays: 3,
        estimatedDeliveryDate: "2026-07-08T00:00:00Z",
      },
      {
        carrier: "UPS",
        serviceCode: "ups_ground",
        serviceName: "ups_ground",
        amountCents: 1102,
        currency: "USD",
        deliveryDays: null,
        estimatedDeliveryDate: null,
      },
    ]);
  });

  it("sums component amounts without float drift", () => {
    const drifty = {
      rate_response: {
        rates: [{
          carrier_code: "fedex",
          service_code: "fedex_home_delivery",
          shipping_amount: { currency: "usd", amount: 0.1 },
          other_amount: { currency: "usd", amount: 0.2 },
        }],
      },
    };
    expect(normalizeRatesResponse(drifty)[0].amountCents).toBe(30);
  });

  it("returns an empty array for missing or malformed payloads", () => {
    expect(normalizeRatesResponse(null)).toEqual([]);
    expect(normalizeRatesResponse({})).toEqual([]);
    expect(normalizeRatesResponse({ rate_response: {} })).toEqual([]);
  });

  it("skips malformed rate entries", () => {
    const mixed = {
      rate_response: {
        rates: [
          null,
          { carrier_code: "ups" }, // no service_code / amount
          {
            carrier_code: "ups",
            service_code: "ups_ground",
            shipping_amount: { currency: "usd", amount: 12 },
          },
        ],
      },
    };
    expect(normalizeRatesResponse(mixed)).toHaveLength(1);
  });
});

describe("normalizeCarriersResponse", () => {
  it("normalizes the carriers list", () => {
    const payload = {
      carriers: [
        { carrier_id: "se-111", carrier_code: "stamps_com", friendly_name: "ShipStation" },
        { carrier_id: "se-222", carrier_code: "fedex" },
        { carrier_code: "orphan-no-id" },
      ],
    };
    expect(normalizeCarriersResponse(payload)).toEqual([
      { carrierId: "se-111", code: "stamps_com", name: "ShipStation" },
      { carrierId: "se-222", code: "fedex", name: "fedex" },
    ]);
  });

  it("returns an empty array for malformed payloads", () => {
    expect(normalizeCarriersResponse(null)).toEqual([]);
    expect(normalizeCarriersResponse({})).toEqual([]);
  });
});

describe("parseRetryAfterSeconds", () => {
  it("parses positive integer seconds", () => {
    expect(parseRetryAfterSeconds("7")).toBe(7);
  });

  it("falls back to the default for missing or garbage values", () => {
    expect(parseRetryAfterSeconds(null)).toBe(2);
    expect(parseRetryAfterSeconds("soon")).toBe(2);
    expect(parseRetryAfterSeconds("0")).toBe(2);
    expect(parseRetryAfterSeconds("-3")).toBe(2);
  });

  it("caps pathological waits", () => {
    expect(parseRetryAfterSeconds("999")).toBe(30);
  });
});

describe("unconfigured adapter (no network)", () => {
  const adapter = createShipStationV2RatingAdapter({ apiKey: "  " });

  it("reports not configured", () => {
    expect(adapter.isConfigured()).toBe(false);
  });

  it("getRates resolves a typed configured:false result without throwing", async () => {
    await expect(adapter.getRates(REQUEST)).resolves.toEqual({ configured: false, rates: [] });
  });

  it("listCarriers resolves a typed configured:false result without throwing", async () => {
    await expect(adapter.listCarriers()).resolves.toEqual({ configured: false, carriers: [] });
  });
});

describe("configured adapter short-circuits", () => {
  it("returns empty rates for an empty parcel list without calling the API", async () => {
    const adapter = createShipStationV2RatingAdapter({
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:1", // would fail fast if it were ever hit
    });
    await expect(adapter.getRates({ ...REQUEST, parcels: [] })).resolves.toEqual({
      configured: true,
      rates: [],
    });
  });
});
