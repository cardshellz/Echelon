import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReturnLabelProviderError,
  returnLabelDownloadUrlSchema,
  type ReturnLabelInput,
} from "../../application/return-label-provider.port";
import { buildReturnLabelRequest, createShipStationReturnLabelAdapter } from "../../infrastructure/shipstation-return-label.adapter";

const INPUT: ReturnLabelInput = {
  externalShipmentId: "return-42-parcel-1",
  rmaNumber: "RMA-42",
  carrierId: "se-101",
  serviceCode: "ups_ground",
  shipFrom: { name: "Fictional Customer", addressLine1: "100 Sample Street", city: "Albany", state: "NY", postalCode: "12207", countryCode: "US" },
  shipTo: { name: "Fictional Returns", companyName: "Sample Warehouse", phone: "5550101000", addressLine1: "200 Example Road", addressLine2: "Suite 2", city: "Albany", state: "NY", postalCode: "12207", countryCode: "US" },
  parcel: { weightGrams: 500, dimensionsInches: { length: 12.125, width: 8, height: 4 } },
};
const PDF = "https://api.shipstation.com/v2/downloads/account/token/label-1.pdf";
function parcel() {
  return { package_code: "package", weight: { value: 1.10231132, unit: "pound" },
    dimensions: { unit: "inch", length: 12.125, width: 8, height: 4 }, tracking_number: "TRACK-42" };
}
function label() {
  return {
    label_id: "se-201", shipment_id: "se-301", external_shipment_id: INPUT.externalShipmentId,
    status: "completed", is_return_label: true, is_international: false, rma_number: INPUT.rmaNumber,
    carrier_id: INPUT.carrierId, service_code: INPUT.serviceCode, tracking_number: "TRACK-42", trackable: true,
    voided: false, voided_at: null, label_format: "pdf", label_layout: "4x6", charge_event: "carrier_default",
    created_at: "2026-09-26T12:00:00Z", shipment_cost: { currency: "usd", amount: "4.25" },
    insurance_cost: { currency: "usd", amount: "0.10" }, label_download: { pdf: PDF, href: PDF }, packages: [parcel()],
  };
}
function shipment(): Record<string, unknown> {
  const request = buildReturnLabelRequest(INPUT);
  return { ...(request.shipment as Record<string, unknown>), shipment_id: "se-301" };
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function fixture(responses: Array<Response | Error> = [json(label()), json(shipment())]) {
  const fetchFn = vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected fixture request");
    return response;
  });
  return { fetchFn, provider: createShipStationReturnLabelAdapter({ apiKey: "fixture-key", fetchFn }) };
}
function listing(ids: string[], total = ids.length, page = 1) {
  return { labels: ids.map(label_id => ({ label_id, external_shipment_id: INPUT.externalShipmentId })), total, page, pages: Math.max(1, Math.ceil(total / 50)) };
}

afterEach(() => { vi.useRealTimers(); });

describe("ShipStation return-label request", () => {
  it("uses the return-only purchase endpoint, reverse addresses and one product-only measured parcel", async () => {
    const frozen = JSON.stringify(INPUT);
    const { provider, fetchFn } = fixture();
    await expect(provider.purchase(INPUT)).resolves.toEqual({
      labelId: "se-201", shipmentId: "se-301", externalShipmentId: INPUT.externalShipmentId,
      trackingNumber: "TRACK-42", carrierId: "se-101", serviceCode: "ups_ground", amountCents: 435,
      currency: "USD", downloadUrl: PDF, labelFormat: "pdf", createdAt: "2026-09-26T12:00:00Z",
    });
    expect(JSON.stringify(INPUT)).toBe(frozen);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.shipstation.com/v2/labels");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", headers: { "API-Key": "fixture-key" } });
    expect(JSON.parse(String(init?.body))).toEqual({
      is_return_label: true, rma_number: "RMA-42", charge_event: "carrier_default",
      label_format: "pdf", label_layout: "4x6", label_download_type: "url",
      shipment: { validate_address: "no_validation", external_shipment_id: INPUT.externalShipmentId,
        carrier_id: "se-101", service_code: "ups_ground",
        ship_from: { name: "Fictional Customer", address_line1: "100 Sample Street", city_locality: "Albany", state_province: "NY", postal_code: "12207", country_code: "US", address_residential_indicator: "unknown" },
        ship_to: { name: "Fictional Returns", company_name: "Sample Warehouse", phone: "5550101000", address_line1: "200 Example Road", address_line2: "Suite 2", city_locality: "Albany", state_province: "NY", postal_code: "12207", country_code: "US", address_residential_indicator: "unknown" },
        packages: [{ package_code: "package", weight: { value: 1.10231132, unit: "pound" }, dimensions: { unit: "inch", length: 12.125, width: 8, height: 4 } }],
      },
    });
    expect(fetchFn.mock.calls[1][0]).toBe("https://api.shipstation.com/v2/shipments/se-301");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])("rejects invalid or unrepresentable parcel grams %s before transport", async weightGrams => {
    const { provider, fetchFn } = fixture();
    await expect(provider.purchase({ ...INPUT, parcel: { ...INPUT.parcel, weightGrams } })).rejects.toMatchObject({ code: "RETURN_LABEL_INPUT_INVALID", outcome: "rejected" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("rejects international origins and invalid external IDs before transport", async () => {
    const { provider, fetchFn } = fixture();
    await expect(provider.purchase({ ...INPUT, shipFrom: { ...INPUT.shipFrom, countryCode: "CA" } })).rejects.toMatchObject({ outcome: "rejected" });
    await expect(provider.purchase({ ...INPUT, externalShipmentId: "x".repeat(51) })).rejects.toMatchObject({ outcome: "rejected" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("requires injected credentials and bounded timeout without reading environment", () => {
    expect(() => createShipStationReturnLabelAdapter({ apiKey: "" })).toThrow(ReturnLabelProviderError);
    expect(() => createShipStationReturnLabelAdapter({ apiKey: "fixture-key", timeoutMs: 30_001 })).toThrow(ReturnLabelProviderError);
  });
});

describe("purchase outcomes", () => {
  it("sends the explicit customer and warehouse classifications on the only purchase POST", async () => {
    const input = { ...INPUT, shipFrom: { ...INPUT.shipFrom, addressType: "residential" as const },
      shipTo: { ...INPUT.shipTo, addressType: "commercial" as const } };
    const responseShipment = shipment();
    (responseShipment.ship_from as Record<string, unknown>).address_residential_indicator = "yes";
    (responseShipment.ship_to as Record<string, unknown>).address_residential_indicator = "no";
    const { provider, fetchFn } = fixture([json(label()), json(responseShipment)]);
    await expect(provider.purchase(input)).resolves.toMatchObject({ labelId: "se-201" });
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body)).shipment).toMatchObject({
      ship_from: { address_line1: "100 Sample Street", address_residential_indicator: "yes" },
      ship_to: { address_line1: "200 Example Road", address_residential_indicator: "no" },
    });
    expect(fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it.each(["ship_from", "ship_to"] as const)("rejects an explicitly opposite %s classification without repeating a purchase", async side => {
    const input = { ...INPUT, shipFrom: { ...INPUT.shipFrom, addressType: "residential" as const },
      shipTo: { ...INPUT.shipTo, addressType: "commercial" as const } };
    const responseShipment = shipment();
    (responseShipment[side] as Record<string, unknown>).address_residential_indicator = side === "ship_from" ? "no" : "yes";
    const { provider, fetchFn } = fixture([json(label()), json(responseShipment)]);
    await expect(provider.purchase(input)).rejects.toMatchObject({ code: "RETURN_LABEL_IDENTITY_MISMATCH", outcome: "unknown" });
    expect(fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("recovers a historical request and physical readback without classification using only GETs", async () => {
    const responseShipment = shipment();
    delete (responseShipment.ship_from as Record<string, unknown>).address_residential_indicator;
    delete (responseShipment.ship_to as Record<string, unknown>).address_residential_indicator;
    const { provider, fetchFn } = fixture([json(listing(["se-201"])), json(label()), json(responseShipment)]);
    await expect(provider.recover(INPUT)).resolves.toMatchObject({ labelId: "se-201" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("accepts an omitted provider classification while still verifying an explicitly classified request's physical addresses", async () => {
    const input = { ...INPUT, shipTo: { ...INPUT.shipTo, addressType: "commercial" as const } };
    const responseShipment = shipment();
    delete (responseShipment.ship_to as Record<string, unknown>).address_residential_indicator;
    const { provider } = fixture([json(listing(["se-201"])), json(label()), json(responseShipment)]);
    await expect(provider.recover(input)).resolves.toMatchObject({ labelId: "se-201" });
    (responseShipment.ship_to as Record<string, unknown>).address_line1 = "Wrong destination";
    const changed = fixture([json(listing(["se-201"])), json(label()), json(responseShipment)]);
    await expect(changed.provider.recover(input)).rejects.toMatchObject({ code: "RETURN_LABEL_IDENTITY_MISMATCH", outcome: "unknown" });
  });
  it.each([400, 401, 403, 404, 405, 422, 429])("classifies HTTP %s as a definitive rejection without automatic retries or raw errors", async status => {
    const response = new Response("private provider message fixture-key", { status });
    const text = vi.spyOn(response, "text");
    const { provider, fetchFn } = fixture([response]);
    await expect(provider.purchase(INPUT)).rejects.toMatchObject({ outcome: "rejected" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
  });
  it.each([409, 500, 502, 503])("preserves HTTP %s as unknown and never repeats the POST", async status => {
    const { provider, fetchFn } = fixture([json({}, status)]);
    await expect(provider.purchase(INPUT)).rejects.toMatchObject({ outcome: "unknown" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("sanitizes network failures without exposing credentials or request addresses", async () => {
    const { provider, fetchFn } = fixture([new Error("fixture-key 100 Sample Street")]);
    let caught: unknown;
    try { await provider.purchase(INPUT); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ReturnLabelProviderError);
    expect(caught).toMatchObject({ code: "RETURN_LABEL_TRANSPORT_FAILED", outcome: "unknown" });
    expect(String(caught)).not.toMatch(/fixture-key|Sample Street/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("bounds an uncooperative transport and aborts it without retrying", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const provider = createShipStationReturnLabelAdapter({ apiKey: "fixture-key", fetchFn, timeoutMs: 20 });
    const assertion = expect(provider.purchase(INPUT)).rejects.toMatchObject({ code: "RETURN_LABEL_TIMEOUT", outcome: "unknown" });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not dispatch already-canceled purchases", async () => {
    const { provider, fetchFn } = fixture();
    await expect(provider.purchase(INPUT, AbortSignal.abort())).rejects.toMatchObject({ code: "RETURN_LABEL_CANCELLED", outcome: "rejected" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("propagates parent cancellation after dispatch as unknown and cleans up the listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetchFn = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const provider = createShipStationReturnLabelAdapter({ apiKey: "fixture-key", fetchFn });
    const assertion = expect(provider.purchase(INPUT, controller.signal)).rejects.toMatchObject({ outcome: "unknown", code: "RETURN_LABEL_CANCELLED" });
    controller.abort();
    await assertion;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each([new Response("bad json"), new Response("{}", { headers: { "content-length": "1048577" } }), new Response("x".repeat(1_048_577))])("treats malformed or oversized success responses as unknown", async response => {
    const { provider, fetchFn } = fixture([response]);
    await expect(provider.purchase(INPUT)).rejects.toMatchObject({ outcome: "unknown" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("does not turn a post-purchase shipment read failure into permission to purchase again", async () => {
    const { provider, fetchFn } = fixture([json(label()), json({}, 401)]);
    await expect(provider.purchase(INPUT)).rejects.toMatchObject({ outcome: "unknown", code: "RETURN_LABEL_CREDENTIAL_REJECTED" });
    expect(fetchFn.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });
});

describe("exact provider evidence", () => {
  it("accepts the exact declared fractional pounds returned as decimal strings", async () => {
    const converted = { ...parcel(), weight: { value: "1.102311320", unit: "pound" } };
    const { provider } = fixture([json({ ...label(), packages: [converted] }), json({ ...shipment(), packages: [converted] })]);
    await expect(provider.purchase(INPUT)).resolves.toMatchObject({ labelId: "se-201" });
  });
  it.each(["purchase", "recover"] as const)("verifies the live RMA-2 two-decimal label and shipment weights during %s", async operation => {
    const input: ReturnLabelInput = { ...INPUT, externalShipmentId: "ecr-2-2", rmaNumber: "RMA-2",
      carrierId: "se-342199", serviceCode: "usps_ground_advantage",
      shipTo: { ...INPUT.shipTo, addressType: "commercial" },
      parcel: { weightGrams: 850, dimensionsInches: { length: 16, width: 14, height: 4 } } };
    const packageReadback = { ...parcel(), weight: { value: 1.87, unit: "pound" },
      dimensions: { unit: "inch", length: 16, width: 14, height: 4 } };
    const labelReadback = { ...label(), external_shipment_id: input.externalShipmentId, rma_number: input.rmaNumber,
      carrier_id: input.carrierId, service_code: input.serviceCode, packages: [packageReadback] };
    const shipmentReadback = { ...shipment(), ...buildReturnLabelRequest(input).shipment as Record<string, unknown>, packages: [packageReadback] };
    const responses = [json(labelReadback), json(shipmentReadback)];
    if (operation === "recover") responses.unshift(json({ ...listing(["se-201"]), labels: [{ label_id: "se-201", external_shipment_id: input.externalShipmentId }] }));
    const { provider, fetchFn } = fixture(responses);
    await expect(provider[operation](input)).resolves.toMatchObject({ externalShipmentId: input.externalShipmentId, labelId: "se-201" });
    if (operation === "recover") expect(fetchFn.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    else {
      expect(fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body)).shipment.packages[0].weight).toEqual({ value: 1.87392923, unit: "pound" });
    }
  });
  it.each(["1.10231131", "1.10231133", "1.1023113201"])("refuses a changed pound weight %s in either label or stored shipment without repeating the purchase", async value => {
    const changed = { ...parcel(), weight: { value, unit: "pound" } };
    for (const evidence of [
      [json({ ...label(), packages: [changed] })],
      [json(label()), json({ ...shipment(), packages: [changed] })],
    ]) {
      const { provider, fetchFn } = fixture(evidence);
      await expect(provider.purchase(INPUT)).rejects.toMatchObject({ code: "RETURN_LABEL_MEASUREMENTS_MISMATCH", outcome: "unknown" });
      expect(fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  });
  it.each([
    { is_return_label: false }, { is_international: true }, { trackable: false }, { voided: true },
    { voided_at: "2026-09-26T12:01:00Z" }, { external_shipment_id: "wrong" }, { rma_number: "wrong" },
    { carrier_id: "se-999" }, { service_code: "wrong" }, { label_format: "png" }, { label_layout: "letter" },
    { charge_event: "on_creation" }, { tracking_number: "OTHER" }, { status: "processing" }, { packages: [parcel(), parcel()] },
  ])("refuses mismatched or incomplete purchased label evidence %j", async patch => {
    const { provider } = fixture([json({ ...label(), ...patch })]);
    await expect(provider.purchase(INPUT)).rejects.toMatchObject({ outcome: "unknown" });
  });
  it.each([
    { external_shipment_id: "wrong" }, { shipment_id: "se-999" }, { carrier_id: "se-999" },
    { service_code: "wrong" }, { ship_from: { ...buildReturnLabelRequest(INPUT).shipment as object } },
    { packages: [{ ...parcel(), weight: { value: 501, unit: "gram" } }] },
    { packages: [{ ...parcel(), dimensions: { ...parcel().dimensions, length: 10 } }] },
  ])("refuses mismatched stored shipment identity or measurements %j", async patch => {
    const { provider } = fixture([json(label()), json({ ...shipment(), ...patch })]);
    await expect(provider.purchase(INPUT)).rejects.toMatchObject({ outcome: "unknown" });
  });
  it("verifies exact origin and destination instead of accepting reversed or unrelated addresses", async () => {
    const expected = shipment();
    const { provider } = fixture([json(label()), json({ ...expected, ship_from: expected.ship_to, ship_to: expected.ship_from })]);
    await expect(provider.purchase(INPUT)).rejects.toMatchObject({ code: "RETURN_LABEL_IDENTITY_MISMATCH", outcome: "unknown" });
  });
  it("accepts exact equivalent supported measurement units", async () => {
    const converted = { ...parcel(), weight: { value: "0.5", unit: "kilogram" }, dimensions: { unit: "centimeter", length: "30.7975", width: "20.32", height: "10.16" } };
    const { provider } = fixture([json({ ...label(), packages: [converted] }), json({ ...shipment(), packages: [converted] })]);
    await expect(provider.purchase(INPUT)).resolves.toMatchObject({ amountCents: 435 });
  });
  it.each([{ currency: "eur", amount: "4.25" }, { currency: "usd", amount: "0.001" }, { currency: "usd", amount: -1 }, { currency: "usd", amount: "90071992547410.00" }])("rejects non-USD, fractional cents and unsafe total money %j", async cost => {
    const { provider } = fixture([json({ ...label(), shipment_cost: cost }), json(shipment())]);
    await expect(provider.purchase(INPUT)).rejects.toMatchObject({ outcome: "unknown", code: "RETURN_LABEL_AMOUNT_INVALID" });
  });
  it.each([
    "http://api.shipstation.com/v2/downloads/label.pdf", "https://evil.example/label.pdf", "https://api.shipstation.com.evil.example/v2/downloads/label.pdf",
    "https://user:secret@api.shipstation.com/v2/downloads/label.pdf", "https://api.shipstation.com:444/v2/downloads/label.pdf",
    "https://api.shipstation.com/v2/downloads/../../../admin", "https://api.shipstation.com/v2/downloads/label.pdf#fragment",
    "https://api.shipstation.com/v2/downloads/%2e%2e%2flabels/label.pdf",
    "https://api.shipstation.com/v2/downloads/%252e%252e%252flabels/label.pdf",
    "https://api.shipstation.com/v2/downloads/label.pdf\n",
  ])("rejects unsafe artifact metadata without fetching %s", async download => {
    const { provider, fetchFn } = fixture([json({ ...label(), label_download: { href: download, pdf: download } }), json(shipment())]);
    await expect(provider.purchase(INPUT)).rejects.toMatchObject({ code: "RETURN_LABEL_ARTIFACT_INVALID", outcome: "unknown" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("allows the explicitly approved ShipEngine artifact endpoint", () => {
    expect(returnLabelDownloadUrlSchema.safeParse("https://api.shipengine.com/v1/downloads/a/label.pdf").success).toBe(true);
  });
});

describe("read-only uncertain-purchase recovery", () => {
  it("continues to recover historical labels and shipments created in grams without a purchase", async () => {
    const historical = { ...parcel(), weight: { value: 500, unit: "gram" } };
    const { provider, fetchFn } = fixture([
      json(listing(["se-201"])),
      json({ ...label(), packages: [historical] }),
      json({ ...shipment(), packages: [historical] }),
    ]);
    await expect(provider.recover(INPUT)).resolves.toMatchObject({ labelId: "se-201" });
    expect(fetchFn.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "GET"]);
  });
  it("returns not-found without issuing another purchase", async () => {
    const { provider, fetchFn } = fixture([json({ labels: [], total: 0, page: 1, pages: 0 })]);
    await expect(provider.recover(INPUT)).resolves.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(new URL(String(url)).searchParams.get("external_shipment_id")).toBe(INPUT.externalShipmentId);
    expect(init?.method).toBe("GET");
  });
  it("gets the single label and its shipment before returning exact recovered evidence", async () => {
    const { provider, fetchFn } = fixture([json(listing(["se-201"])), json(label()), json(shipment())]);
    await expect(provider.recover(INPUT)).resolves.toMatchObject({ labelId: "se-201", externalShipmentId: INPUT.externalShipmentId });
    expect(fetchFn.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "GET"]);
    expect(fetchFn.mock.calls[1][0]).toBe("https://api.shipstation.com/v2/labels/se-201");
  });
  it("fails closed on multiple matches instead of trusting external-ID uniqueness", async () => {
    const { provider, fetchFn } = fixture([json(listing(["se-201", "se-202"]))]);
    await expect(provider.recover(INPUT)).rejects.toMatchObject({ code: "RETURN_LABEL_RECOVERY_AMBIGUOUS", outcome: "unknown" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("reads all bounded pages before declaring ambiguity", async () => {
    const first = Array.from({ length: 50 }, (_, i) => `se-${i + 1}`);
    const { provider, fetchFn } = fixture([json(listing(first, 51, 1)), json(listing(["se-51"], 51, 2))]);
    await expect(provider.recover(INPUT)).rejects.toMatchObject({ code: "RETURN_LABEL_RECOVERY_AMBIGUOUS" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchFn.mock.calls[1][0])).searchParams.get("page")).toBe("2");
  });
  it.each([
    { ...listing(["se-201"]), total: 2 }, { ...listing(["se-201"]), pages: 2 }, { ...listing(["se-201"]), page: 2 },
    listing(["se-201", "se-201"]), { ...listing(["se-201"]), labels: [{ label_id: "se-201", external_shipment_id: "other" }] },
  ])("rejects truncated, duplicate, wrong-page or wrong-filter recovery listings %j", async body => {
    const { provider } = fixture([json(body)]);
    await expect(provider.recover(INPUT)).rejects.toMatchObject({ code: "RETURN_LABEL_RECOVERY_INCOMPLETE", outcome: "unknown" });
  });
  it("rejects changing totals across pages", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `se-${i + 1}`);
    const { provider } = fixture([json(listing(ids, 51, 1)), json(listing(["se-51", "se-52"], 52, 2))]);
    await expect(provider.recover(INPUT)).rejects.toMatchObject({ code: "RETURN_LABEL_RECOVERY_INCOMPLETE" });
  });
  it("rejects an unexpected exact-label response ID", async () => {
    const { provider } = fixture([json(listing(["se-201"])), json({ ...label(), label_id: "se-999" })]);
    await expect(provider.recover(INPUT)).rejects.toMatchObject({ code: "RETURN_LABEL_IDENTITY_MISMATCH" });
  });
  it("preserves unknown state for invalid recovery input", async () => {
    const { provider, fetchFn } = fixture();
    await expect(provider.recover({ ...INPUT, externalShipmentId: "" })).rejects.toMatchObject({ outcome: "unknown" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
