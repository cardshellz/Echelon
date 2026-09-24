import { afterEach, describe, expect, it, vi } from "vitest";
import { createCustomerReturnShipStationDimensionsReader } from "../../infrastructure/customer-return-shipstation-dimensions.reader";
import { CustomerReturnPackageDimensionsError, customerReturnPackageDimensionsInputSchema } from "../../application/customer-return-package-dimensions.ports";

const input = { providerPhysicalShipmentId: "123", trackingNumber: "TRACK-123" };
const shipment = () => ({ shipmentId: 123, trackingNumber: input.trackingNumber, voided: false,
  voidDate: null, isReturnLabel: false, dimensions: { units: "inches", length: 12, width: 10, height: 6 } });
const page = () => ({ shipments: [shipment()], page: 1, pages: 1, total: 1 });
function setup(body: unknown = page(), status = 200) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const reader = createCustomerReturnShipStationDimensionsReader({ apiKey: "fixture-key", apiSecret: "fixture-secret", request });
  return { request, reader };
}
afterEach(() => vi.useRealTimers());

describe("exact read-only original ShipStation dimensions", () => {
  it("reads only a documented tracking filter and selects the exact immutable shipment", async () => {
    const body = page(); body.shipments.unshift({ ...shipment(), shipmentId: 122 }); body.total = 2;
    const { reader, request } = setup(body);
    expect(await reader.read(input)).toEqual({ lengthMm: 304.8, widthMm: 254, heightMm: 152.4 });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0];
    const target = new URL(String(url));
    expect(target.origin).toBe("https://ssapi.shipstation.com"); expect(target.pathname).toBe("/shipments");
    expect(target.searchParams.get("trackingNumber")).toBe(input.trackingNumber);
    expect(target.searchParams.has("shipmentId")).toBe(false);
    expect(target.searchParams.get("pageSize")).toBe("100");
    expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(options?.body).toBeUndefined();
  });
  it("converts centimeters and preserves exact fractional millimeters", async () => {
    const body = page(); body.shipments[0].dimensions = { units: "centimeters", length: 12.3456, width: 1.25, height: 0.1 };
    expect(await setup(body).reader.read(input)).toEqual({ lengthMm: 123.456, widthMm: 12.5, heightMm: 1 });
  });
  it.each([null, undefined])("returns no invented dimensions for %s", async dimensions => {
    const body = { ...page(), shipments: [{ ...shipment(), dimensions }] };
    expect(await setup(body).reader.read(input)).toBeNull();
  });
  it.each([{ voided: true }, { voidDate: "2026-09-24T12:00:00" }, { isReturnLabel: true }])("does not use inactive or return package %j", async change => {
    expect(await setup({ ...page(), shipments: [{ ...shipment(), ...change }] }).reader.read(input)).toBeNull();
  });
  it.each(["millimeters", "inch", "", null])("rejects unsupported dimension unit %s", async units => {
    const body = { ...page(), shipments: [{ ...shipment(), dimensions: { ...shipment().dimensions, units } }] };
    await expect(setup(body).reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_RESPONSE_INVALID" });
  });
  it.each([0, -1, "12", null, 100_000_000_000, 0.1234567])("rejects invalid/out-of-contract source length %s", async length => {
    const body = { ...page(), shipments: [{ ...shipment(), dimensions: { ...shipment().dimensions, length } }] };
    await expect(setup(body).reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_RESPONSE_INVALID" });
  });
  it.each([{ voided: undefined }, { isReturnLabel: undefined }, { dimensions: { length: 1, width: 2, units: "inches" } }])("fails closed on malformed required evidence %j", async change => {
    await expect(setup({ ...page(), shipments: [{ ...shipment(), ...change }] }).reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_RESPONSE_INVALID" });
  });
  it.each([
    { page: 2 }, { pages: 2 }, { total: 2 }, { page: undefined },
    { shipments: [shipment(), shipment()], total: 2 },
    { shipments: [{ ...shipment(), trackingNumber: "OTHER" }] },
  ])("rejects incomplete, duplicate or differently scoped page %j", async change => {
    await expect(setup({ ...page(), ...change }).reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_LOOKUP_INCOMPLETE" });
  });
  it("accepts the documented legacy pages=0 complete first-page shape", async () => {
    expect(await setup({ ...page(), pages: 0 }).reader.read(input)).not.toBeNull();
  });
  it("does not mistake a different shipment with the same tracking for the requested package", async () => {
    await expect(setup({ ...page(), shipments: [{ ...shipment(), shipmentId: 999 }] }).reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_NOT_FOUND" });
  });
  it("distinguishes a complete empty lookup from absent measurements", async () => {
    await expect(setup({ shipments: [], page: 1, pages: 0, total: 0 }).reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_NOT_FOUND" });
  });
  it.each(["0", "00123", "se-123", "9007199254740992", "123\n"]) ("rejects ambiguous/invalid immutable ID %s before transport", async providerPhysicalShipmentId => {
    const { reader, request } = setup();
    await expect(reader.read({ ...input, providerPhysicalShipmentId })).rejects.toMatchObject({ code: "RETURN_PACKAGE_INPUT_INVALID" });
    expect(request).not.toHaveBeenCalled();
  });
  it("validates the entire port input without coercing or accepting authority fields", () => {
    expect(customerReturnPackageDimensionsInputSchema.safeParse({ ...input, trackingNumber: " TRACK-123 " }).success).toBe(false);
    expect(customerReturnPackageDimensionsInputSchema.safeParse({ ...input, admin: true }).success).toBe(false);
    expect(customerReturnPackageDimensionsInputSchema.safeParse({ ...input, providerPhysicalShipmentId: 123 }).success).toBe(false);
  });
  it("classifies missing configuration without making a request", async () => {
    const request = vi.fn<typeof fetch>();
    const reader = createCustomerReturnShipStationDimensionsReader({ request });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_NOT_CONFIGURED", failureClass: "configuration" });
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects malformed credentials without leaking them", async () => {
    const request = vi.fn<typeof fetch>();
    const reader = createCustomerReturnShipStationDimensionsReader({ apiKey: "SECRET:bad", apiSecret: "SECRET", request });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_CONFIGURATION_INVALID", message: expect.not.stringContaining("SECRET") });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 429, 500])("classifies HTTP %i and never returns the raw error body", async status => {
    await expect(setup({ secret: "PRIVATE_PROVIDER_PAYLOAD" }, status).reader.read(input)).rejects.toMatchObject({
      code: "RETURN_PACKAGE_HTTP_REJECTED", failureClass: status === 401 || status === 403 ? "configuration"
        : status === 429 || status >= 500 ? "transient" : "permanent",
      message: expect.not.stringContaining("PRIVATE_PROVIDER_PAYLOAD"),
    });
  });
  it("sanitizes transport failure", async () => {
    const { reader, request } = setup(); request.mockRejectedValue(new Error("PRIVATE_PROVIDER_PAYLOAD"));
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_TRANSPORT_FAILED", message: expect.not.stringContaining("PRIVATE_PROVIDER_PAYLOAD") });
  });
  it("rejects oversized bodies before parsing", async () => {
    const { reader, request } = setup();
    request.mockResolvedValue(new Response("{}", { headers: { "content-length": "1000001" } }));
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_RESPONSE_TOO_LARGE" });
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("rejects malformed JSON without exposing content", async () => {
    const { reader, request } = setup(); request.mockResolvedValue(new Response("PRIVATE_PROVIDER_PAYLOAD"));
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_RESPONSE_INVALID", message: expect.not.stringContaining("PRIVATE_PROVIDER_PAYLOAD") });
  });
  it("classifies interrupted response bodies as transient without exposing content", async () => {
    const { reader, request } = setup();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("PRIVATE_PROVIDER_PAYLOAD")); },
    });
    request.mockResolvedValue(new Response(body));
    await expect(reader.read(input)).rejects.toMatchObject({
      code: "RETURN_PACKAGE_TRANSPORT_FAILED", failureClass: "transient",
      message: expect.not.stringContaining("PRIVATE_PROVIDER_PAYLOAD"),
    });
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("bounds a hanging fetch even when the injected implementation ignores abort", async () => {
    vi.useFakeTimers(); const { reader, request } = setup(); request.mockImplementation(() => new Promise(() => undefined));
    const result = expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_PACKAGE_TIMEOUT", failureClass: "transient" });
    await vi.advanceTimersByTimeAsync(10_000); await result;
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors cancellation before work without any provider request", async () => {
    const { reader, request } = setup(); const parent = new AbortController(); parent.abort();
    await expect(reader.read(input, parent.signal)).rejects.toMatchObject({ code: "RETURN_PACKAGE_CANCELLED" });
    expect(request).not.toHaveBeenCalled();
  });
  it("propagates in-flight parent cancellation and removes its listener/timer", async () => {
    vi.useFakeTimers(); const { reader, request } = setup(); const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    request.mockImplementation(() => new Promise(() => undefined));
    const result = expect(reader.read(input, parent.signal)).rejects.toMatchObject({ code: "RETURN_PACKAGE_CANCELLED" });
    parent.abort(); await result;
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans the parent listener after a successful read", async () => {
    const { reader } = setup(); const parent = new AbortController(); const remove = vi.spyOn(parent.signal, "removeEventListener");
    await reader.read(input, parent.signal);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("exports only sanitized structured failures", () => {
    const error = new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_RESPONSE_INVALID");
    expect(error.status).toBe(503); expect(error).not.toHaveProperty("cause");
  });
});
