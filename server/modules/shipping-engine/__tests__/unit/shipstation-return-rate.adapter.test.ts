import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReturnRateProviderError,
  returnRateInputSchema,
  returnRateResultSchema,
  type ReturnRateInput,
} from "../../application/return-rate-provider.port";
import {
  buildReturnRateRequest,
  createShipStationReturnRateAdapter,
  normalizeReturnRateResponse,
} from "../../infrastructure/shipstation-return-rate.adapter";
import { buildReturnLabelRequest } from "../../infrastructure/shipstation-return-label.adapter";

const INPUT: ReturnRateInput = {
  shipment: {
    externalShipmentId: "ecr-42-51",
    rmaNumber: "RMA-42",
    shipFrom: {
      name: "Fictional Customer",
      addressLine1: "100 Sample Street",
      addressLine3: "Unit C",
      city: "Albany",
      state: "NY",
      postalCode: "12207",
      countryCode: "US",
    },
    shipTo: {
      name: "Fictional Returns",
      companyName: "Sample Warehouse",
      phone: "5550101000",
      addressLine1: "200 Example Road",
      addressLine2: "Suite 2",
      city: "Albany",
      state: "NY",
      postalCode: "12207",
      countryCode: "US",
    },
    parcel: {
      weightGrams: 500,
      dimensionsInches: { length: 12.125, width: 8.001, height: 4 },
    },
  },
  carrierIds: ["se-101", "se-102"],
};
function rate(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    rate_id: null,
    rate_type: "quick",
    carrier_id: "se-101",
    carrier_code: "ups_walleted",
    service_code: "ups_ground",
    trackable: true,
    package_type: "package",
    validation_status: "valid",
    warning_messages: [],
    error_messages: [],
    shipping_amount: { currency: "usd", amount: "4.10" },
    insurance_amount: { currency: "usd", amount: "0.20" },
    confirmation_amount: { currency: "usd", amount: 0 },
    other_amount: { currency: "usd", amount: "0.30" },
    ...overrides,
  };
}
function response(
  rates: unknown[] = [rate()],
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    rate_response: {
      status: "completed",
      rates,
      invalid_rates: [],
      errors: [],
      ...overrides,
    },
  };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function fixture(body: unknown = response()) {
  const fetchFn = vi.fn<typeof fetch>(async () => json(body));
  return {
    fetchFn,
    provider: createShipStationReturnRateAdapter({
      apiKey: "fixture-key",
      fetchFn,
    }),
  };
}
afterEach(() => vi.useRealTimers());

describe("return-rate requests", () => {
  it("requests nonpersisted return quotes for every account and exact purchase addresses, dimensions and whole grams", async () => {
    const before = JSON.stringify(INPUT);
    const { provider, fetchFn } = fixture();
    const result = await provider.quote(INPUT);
    expect(result.rates[0]).toEqual({
      carrierId: "se-101",
      carrierCode: "ups_walleted",
      serviceCode: "ups_ground",
      amountCents: 460,
      currency: "USD",
      rateId: null,
      rateType: "quick",
      packageType: "package",
      trackable: true,
      validationStatus: "valid",
      warningCount: 0,
      amounts: {
        shippingCents: 410,
        insuranceCents: 20,
        confirmationCents: 0,
        otherCents: 30,
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.shipstation.com/v2/rates");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { "API-Key": "fixture-key" },
    });
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(request.rate_options).toEqual({
      carrier_ids: INPUT.carrierIds,
      package_types: ["package"],
      preferred_currency: "usd",
      is_return: true,
      rate_type: "quick",
    });
    const purchase = buildReturnLabelRequest({
      ...INPUT.shipment,
      carrierId: "se-101",
      serviceCode: "ups_ground",
    });
    const purchaseShipment = purchase.shipment as Record<string, unknown>;
    expect(request.shipment).toEqual({
      validate_address: "no_validation",
      ship_from: purchaseShipment.ship_from,
      ship_to: purchaseShipment.ship_to,
      packages: purchaseShipment.packages,
    });
    expect(JSON.stringify(request)).not.toMatch(
      /rate_id|is_return_label|external_shipment_id/,
    );
    expect(JSON.stringify(INPUT)).toBe(before);
  });
  it.each([
    { carrierIds: [] },
    { carrierIds: ["se-101", "se-101"] },
    { carrierIds: ["fake"] },
    { carrierIds: Array.from({ length: 101 }, (_, i) => `se-${i}`) },
  ])(
    "rejects empty, repeated, invalid or excessive account IDs",
    async ({ carrierIds }) => {
      const { provider, fetchFn } = fixture();
      await expect(
        provider.quote({ ...INPUT, carrierIds }),
      ).rejects.toMatchObject({
        code: "RETURN_RATE_INPUT_INVALID",
        failureClass: "rejected",
      });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid grams %s before transport", async (weightGrams) => {
    const { provider, fetchFn } = fixture();
    await expect(
      provider.quote({
        ...INPUT,
        shipment: {
          ...INPUT.shipment,
          parcel: { ...INPUT.shipment.parcel, weightGrams },
        },
      }),
    ).rejects.toMatchObject({ code: "RETURN_RATE_INPUT_INVALID" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("rejects international input and caller-selected purchase fields", () => {
    expect(
      returnRateInputSchema.safeParse({
        ...INPUT,
        shipment: { ...INPUT.shipment, carrierId: "se-101" },
      }).success,
    ).toBe(false);
    expect(() =>
      buildReturnRateRequest({
        ...INPUT,
        shipment: {
          ...INPUT.shipment,
          shipFrom: { ...INPUT.shipment.shipFrom, countryCode: "CA" },
        },
      }),
    ).toThrow(ReturnRateProviderError);
  });
  it.each(["", "key\r\nsecret", "bad key"])(
    "requires explicit safe credentials %j",
    (apiKey) => {
      expect(() => createShipStationReturnRateAdapter({ apiKey })).toThrow(
        ReturnRateProviderError,
      );
    },
  );
  it.each([0, -1, 30_001, Number.NaN])(
    "rejects an unbounded/invalid timeout %s",
    (timeoutMs) => {
      expect(() =>
        createShipStationReturnRateAdapter({
          apiKey: "fixture-key",
          timeoutMs,
        }),
      ).toThrow(ReturnRateProviderError);
    },
  );
});

describe("complete and exact return-rate evidence", () => {
  it("retains distinct account identity even for identical carrier/service names", () => {
    const result = normalizeReturnRateResponse(
      response([rate(), rate({ carrier_id: "se-102" })]),
      INPUT,
    );
    expect(result.rates.map((row) => row.carrierId)).toEqual([
      "se-101",
      "se-102",
    ]);
  });
  it("preserves warnings as counts without exposing raw provider text or double-counting details", () => {
    const result = normalizeReturnRateResponse(
      response([
        rate({
          package_type: null,
          validation_status: "has_warnings",
          warning_messages: ["private-address"],
          rate_details: [{ amount: { currency: "usd", amount: 99 } }],
        }),
      ]),
      INPUT,
    );
    expect(result.rates[0]).toMatchObject({
      warningCount: 1,
      validationStatus: "has_warnings",
      amountCents: 460,
      packageType: null,
    });
    expect(JSON.stringify(result)).not.toContain("private-address");
  });
  it("returns explicit exclusions for invalid services, unsupported packaging and untrackable rates", () => {
    const result = normalizeReturnRateResponse(
      response(
        [
          rate({ trackable: false }),
          rate({ carrier_id: "se-102", package_type: "flat_rate_box" }),
        ],
        {
          invalid_rates: [
            {
              carrier_id: "se-101",
              service_code: "ups_air",
              validation_status: "invalid",
              error_messages: ["private-address"],
            },
          ],
        },
      ),
      INPUT,
    );
    expect(result).toEqual({
      status: "completed",
      rates: [],
      exclusions: [
        {
          carrierId: "se-101",
          serviceCode: "ups_ground",
          code: "RETURN_RATE_NOT_TRACKABLE",
        },
        {
          carrierId: "se-102",
          serviceCode: "ups_ground",
          code: "RETURN_RATE_PACKAGE_UNSUPPORTED",
        },
        {
          carrierId: "se-101",
          serviceCode: "ups_air",
          code: "RETURN_RATE_SERVICE_INVALID",
        },
      ],
    });
  });
  it("permits a completed empty quote without inventing fallback services", () => {
    expect(normalizeReturnRateResponse(response([]), INPUT)).toEqual({
      status: "completed",
      rates: [],
      exclusions: [],
    });
  });
  it.each(["working", "partial", "error"])(
    "rejects %s outcomes even with an otherwise valid candidate",
    (status) => {
      expect(() =>
        normalizeReturnRateResponse(response([rate()], { status }), INPUT),
      ).toThrowError(
        expect.objectContaining({ code: "RETURN_RATE_RESPONSE_INCOMPLETE" }),
      );
    },
  );
  it("rejects partial carrier failures instead of calling the available subset globally cheapest", () => {
    expect(() =>
      normalizeReturnRateResponse(
        response([rate()], {
          errors: [{ carrier_id: "se-102", message: "private failure" }],
        }),
        INPUT,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "RETURN_RATE_RESPONSE_INCOMPLETE" }),
    );
  });
  it.each([
    { carrier_id: "se-999" },
    { service_code: "" },
    { rate_id: "se-5" },
    { rate_type: "shipment" },
    { trackable: undefined },
    { validation_status: "unknown" },
    { error_messages: ["carrier failed"] },
    { insurance_amount: undefined },
    { warning_messages: undefined },
  ])(
    "fails closed for malformed/unknown or wrong-scope candidate %j",
    (override) => {
      expect(() =>
        normalizeReturnRateResponse(response([rate(override)]), INPUT),
      ).toThrow(ReturnRateProviderError);
    },
  );
  it("rejects duplicate candidates, including contradictory valid/invalid results", () => {
    expect(() =>
      normalizeReturnRateResponse(response([rate(), rate()]), INPUT),
    ).toThrowError(
      expect.objectContaining({ code: "RETURN_RATE_IDENTITY_MISMATCH" }),
    );
    expect(() =>
      normalizeReturnRateResponse(
        response([rate()], {
          invalid_rates: [rate({ validation_status: "invalid" })],
        }),
        INPUT,
      ),
    ).toThrow(ReturnRateProviderError);
  });
  it("requires explicit invalid evidence on invalid_rates", () => {
    expect(() =>
      normalizeReturnRateResponse(
        response([], { invalid_rates: [rate()] }),
        INPUT,
      ),
    ).toThrow(ReturnRateProviderError);
  });
  it.each([
    "shipping_amount",
    "insurance_amount",
    "confirmation_amount",
    "other_amount",
  ])("rejects mixed currencies in %s", (component) => {
    expect(() =>
      normalizeReturnRateResponse(
        response([rate({ [component]: { currency: "cad", amount: 0 } })]),
        INPUT,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "RETURN_RATE_CURRENCY_UNSUPPORTED" }),
    );
  });
  it.each([-1, "0.001", "NaN", Number.MAX_VALUE, "90071992547409.92"])(
    "rejects invalid cents %s",
    (amount) => {
      expect(() =>
        normalizeReturnRateResponse(
          response([rate({ shipping_amount: { currency: "usd", amount } })]),
          INPUT,
        ),
      ).toThrow(ReturnRateProviderError);
    },
  );
  it("checks the aggregate safe-integer bound after exact component conversion", () => {
    expect(() =>
      normalizeReturnRateResponse(
        response([
          rate({
            shipping_amount: { currency: "usd", amount: "90071992547409.90" },
          }),
        ]),
        INPUT,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "RETURN_RATE_AMOUNT_INVALID" }),
    );
  });
  it("rejects unexpected domestic tax instead of omitting a possible charge", () => {
    expect(() =>
      normalizeReturnRateResponse(
        response([rate({ tax_amount: { currency: "usd", amount: 1 } })]),
        INPUT,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "RETURN_RATE_TAX_UNSUPPORTED" }),
    );
    expect(
      normalizeReturnRateResponse(
        response([rate({ tax_amount: { currency: "USD", amount: "0.00" } })]),
        INPUT,
      ).rates,
    ).toHaveLength(1);
  });
  it("validates totals and uniqueness on the public port result schema", () => {
    const result = normalizeReturnRateResponse(response(), INPUT);
    expect(
      returnRateResultSchema.safeParse({
        ...result,
        rates: [result.rates[0], result.rates[0]],
      }).success,
    ).toBe(false);
    expect(
      returnRateResultSchema.safeParse({
        ...result,
        rates: [{ ...result.rates[0], amountCents: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("bounded sanitized quote failures", () => {
  it.each([
    [401, "configuration"],
    [403, "configuration"],
    [429, "transient"],
    [500, "transient"],
    [400, "rejected"],
    [422, "rejected"],
  ] as const)(
    "classifies HTTP %s without retries or raw response text",
    async (status, failureClass) => {
      const denied = new Response("fixture-key private-address", { status });
      const text = vi.spyOn(denied, "text");
      const fetchFn = vi.fn<typeof fetch>(async () => denied);
      const provider = createShipStationReturnRateAdapter({
        apiKey: "fixture-key",
        fetchFn,
      });
      await expect(provider.quote(INPUT)).rejects.toMatchObject({
        failureClass,
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(text).not.toHaveBeenCalled();
    },
  );
  it("sanitizes transport failures", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error("fixture-key private-address");
    });
    const provider = createShipStationReturnRateAdapter({
      apiKey: "fixture-key",
      fetchFn,
    });
    const error = await provider
      .quote(INPUT)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "RETURN_RATE_TRANSPORT_FAILED",
      failureClass: "transient",
    });
    expect(String(error)).not.toMatch(/fixture-key|private-address/);
  });
  it("does not dispatch an already aborted quote", async () => {
    const { provider, fetchFn } = fixture();
    await expect(
      provider.quote(INPUT, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "RETURN_RATE_CANCELLED" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("bounds even an uncooperative fetch and cleans up timer and parent listener", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const fetchFn = vi.fn<typeof fetch>(
      () => new Promise<Response>(() => undefined),
    );
    const provider = createShipStationReturnRateAdapter({
      apiKey: "fixture-key",
      fetchFn,
      timeoutMs: 20,
    });
    const assertion = expect(
      provider.quote(INPUT, parent.signal),
    ).rejects.toMatchObject({
      code: "RETURN_RATE_TIMEOUT",
      failureClass: "transient",
    });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors parent cancellation after dispatch", async () => {
    const parent = new AbortController();
    const fetchFn = vi.fn<typeof fetch>(
      () => new Promise<Response>(() => undefined),
    );
    const provider = createShipStationReturnRateAdapter({
      apiKey: "fixture-key",
      fetchFn,
    });
    const assertion = expect(
      provider.quote(INPUT, parent.signal),
    ).rejects.toMatchObject({ code: "RETURN_RATE_CANCELLED" });
    parent.abort();
    await assertion;
    expect(fetchFn.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("bounds an indefinitely stalled body as well as response headers", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(new ReadableStream<Uint8Array>({ cancel })),
    );
    const provider = createShipStationReturnRateAdapter({
      apiKey: "fixture-key",
      fetchFn,
      timeoutMs: 20,
    });
    const assertion = expect(provider.quote(INPUT)).rejects.toMatchObject({
      code: "RETURN_RATE_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each([
    () => new Response("{}", { headers: { "content-length": "2097153" } }),
    () => new Response("x".repeat(2_097_153)),
  ])("enforces declared and streamed response byte bounds", async (build) => {
    const fetchFn = vi.fn<typeof fetch>(async () => build());
    const provider = createShipStationReturnRateAdapter({
      apiKey: "fixture-key",
      fetchFn,
    });
    await expect(provider.quote(INPUT)).rejects.toMatchObject({
      code: "RETURN_RATE_RESPONSE_LIMIT",
    });
  });
  it("rejects malformed JSON without exposing its body", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response("private-address not-json"),
    );
    const provider = createShipStationReturnRateAdapter({
      apiKey: "fixture-key",
      fetchFn,
    });
    await expect(provider.quote(INPUT)).rejects.toMatchObject({
      code: "RETURN_RATE_RESPONSE_INVALID",
      failureClass: "invalid_response",
    });
  });
});
