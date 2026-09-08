import { afterEach, describe, expect, it, vi } from "vitest";
import { createInboundTrackingProviders } from "../../inbound-tracking.providers";
import { oceanConfig, oceanPayload, parcelConfig, parcelPayload } from "./inbound-tracking.fixtures";
afterEach(() => vi.useRealTimers());
const clock = () => new Date("2026-09-07T12:00:00Z");
describe("inbound tracking real provider adapters with mocked HTTP", () => {
  it("calls the documented SeaRates endpoint using fixed origin, encoded identity and optional AIS", async () => {
    const fetchImpl = vi.fn(async () => Response.json(oceanPayload()));
    const providers = createInboundTrackingProviders({ seaRatesApiKey: "secret-only-in-request", shipStationApiKey: "", fetchImpl, now: clock });
    const snapshot = await providers.searates.fetch(oceanConfig);
    const [target, options] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(target.origin + target.pathname).toBe("https://tracking.searates.com/tracking");
    expect(Object.fromEntries(target.searchParams)).toEqual({ api_key: "secret-only-in-request", number: "TEST1234567", type: "CT", sealine: "auto", force_update: "false", route: "true", ais: "true" });
    expect(options).toMatchObject({ method: "GET", redirect: "error" });
    expect(JSON.stringify(snapshot)).not.toContain("secret-only-in-request"); expect(snapshot.vesselPosition?.latitude).toBe(0);
  });
  it("uses existing ShipStation v2 credential owner and prevents redirects", async () => {
    const fetchImpl = vi.fn(async () => Response.json(parcelPayload()));
    const providers = createInboundTrackingProviders({ seaRatesApiKey: "", shipStationApiKey: "parcel-secret", fetchImpl });
    const result = await providers.shipstation.fetch(parcelConfig);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.shipstation.com/v2/tracking?carrier_code=ups&tracking_number=1ZTEST123", expect.objectContaining({ redirect: "error", headers: { "API-Key": "parcel-secret" } }));
    expect(result.status).toBe("Delivered");
  });
  it.each(["searates", "shipstation"] as const)("does not call %s without credentials", async (provider) => {
    const fetchImpl = vi.fn(); const providers = createInboundTrackingProviders({ seaRatesApiKey: "", shipStationApiKey: "", fetchImpl });
    expect(providers[provider].configured()).toBe(false);
    await expect(providers[provider].fetch(provider === "searates" ? oceanConfig : parcelConfig)).rejects.toMatchObject({ retryable: false }); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("honors HTTP 429 Retry-After without persisting a provider error body", async () => {
    const providers = createInboundTrackingProviders({ seaRatesApiKey: "secret", fetchImpl: vi.fn(async () => new Response("secret echoed", { status: 429, headers: { "retry-after": "3600" } })), now: clock });
    await expect(providers.searates.fetch(oceanConfig)).rejects.toMatchObject({ code: "SEARATES_HTTP_429", retryable: true, retryAfterMs: 3_600_000 });
  });
  it.each(["WRONG_NUMBER", "API_KEY_LIMIT_REACHED", "API_KEY_ACCESS_DENIED"])("suspends %s for operator review", async (message) => {
    const providers = createInboundTrackingProviders({ seaRatesApiKey: "secret", fetchImpl: vi.fn(async () => Response.json({ status: "error", message })) });
    await expect(providers.searates.fetch(oceanConfig)).rejects.toMatchObject({ code: `SEARATES_${message}`, retryable: false });
  });
  it.each(["NO_EVENTS", "SEALINE_NO_RESPONSE", "API_KEY_RATE_LIMIT"])("retries transient provider response %s", async (message) => {
    const providers = createInboundTrackingProviders({ seaRatesApiKey: "secret", fetchImpl: vi.fn(async () => Response.json({ status: "error", message })) });
    await expect(providers.searates.fetch(oceanConfig)).rejects.toMatchObject({ retryable: true });
  });
  it("redacts raw network exceptions, unknown provider messages and parcel bodies", async () => {
    const secret = "never-persist-this-token";
    const network = createInboundTrackingProviders({ seaRatesApiKey: secret, fetchImpl: vi.fn(async () => { throw new Error(`fetch https://tracking.searates.com/tracking?api_key=${secret}`); }) });
    await expect(network.searates.fetch(oceanConfig)).rejects.toMatchObject({ message: "SeaRates tracking request failed." });
    const unknown = createInboundTrackingProviders({ seaRatesApiKey: secret, fetchImpl: vi.fn(async () => Response.json({ status: "error", message: secret })) });
    await expect(unknown.searates.fetch(oceanConfig)).rejects.toMatchObject({ code: "SEARATES_REJECTED", message: "SeaRates did not return a successful tracking response." });
    const parcel = createInboundTrackingProviders({ shipStationApiKey: secret, fetchImpl: vi.fn(async () => new Response(secret, { status: 401 })) });
    const failure = await parcel.shipstation.fetch(parcelConfig).catch((error: unknown) => error);
    expect(JSON.stringify(failure)).not.toContain(secret);
  });
  it("rejects invalid JSON, oversized bodies and mismatched references", async () => {
    for (const response of [new Response("not JSON"), new Response("{}", { headers: { "content-length": "2000001" } }), Response.json({ ...oceanPayload(), data: { ...oceanPayload().data, metadata: { ...oceanPayload().data.metadata, number: "OTHER" } } })]) {
      const provider = createInboundTrackingProviders({ seaRatesApiKey: "secret", fetchImpl: vi.fn(async () => response) });
      await expect(provider.searates.fetch(oceanConfig)).rejects.toMatchObject({ retryable: false });
    }
  });
  it("times out the entire ocean request including a slow response body", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_input: unknown, options?: RequestInit) => new Response(new ReadableStream({ start(controller) { options?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError"))); } })));
    const provider = createInboundTrackingProviders({ seaRatesApiKey: "secret", fetchImpl });
    const assertion = expect(provider.searates.fetch(oceanConfig)).rejects.toMatchObject({ code: "SEARATES_TIMEOUT", retryable: true });
    await vi.advanceTimersByTimeAsync(20_001); await assertion;
  });
});
