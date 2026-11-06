import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readShipmentResource, retryShipmentRead, ShipmentReadError } from "../../shipment-reads";
afterEach(() => vi.unstubAllGlobals());
describe("safe read-only shipment transport", () => {
  it("validates a permitted response and includes session credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ count: 1 })));
    vi.stubGlobal("fetch",fetch);
    expect(await readShipmentResource("/api/outbound-shipments",z.object({ count: z.number().int() }))).toEqual({ count: 1 });
    expect(fetch).toHaveBeenCalledWith("/api/outbound-shipments",expect.objectContaining({ credentials: "include" }));
  });
  it.each([400,401,403,404])("never retries permanent HTTP refusal %i or displays response diagnostics",async status => {
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("private-provider-diagnostic",{ status })));
    const error = await readShipmentResource("/api/outbound-shipments",z.object({})).catch(value => value as Error);
    expect(error).toBeInstanceOf(ShipmentReadError); expect((error as Error).message).not.toContain("private-provider");
    expect(retryShipmentRead(0,error as Error)).toBe(false);
  });
  it.each(["not JSON with private diagnostics",JSON.stringify({ count: "private diagnostics" })])("fails closed on an invalid read contract",async payload => {
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(payload)));
    const error = await readShipmentResource("/api/outbound-shipments",z.object({ count: z.number() })).catch(value => value as Error);
    expect((error as Error).message).toBe("Shipment data could not be verified.");
    expect(retryShipmentRead(0,error as Error)).toBe(false);
  });
  it("bounds transient server/network retries and never retries an unknown error",async () => {
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("private diagnostic",{ status: 503 })));
    const error = await readShipmentResource("/api/outbound-shipments",z.object({})).catch(value => value as Error);
    expect(retryShipmentRead(0,error as Error)).toBe(true); expect(retryShipmentRead(2,error as Error)).toBe(false);
    expect(retryShipmentRead(1,new TypeError("network unavailable"))).toBe(true);
    expect(retryShipmentRead(2,new TypeError("network unavailable"))).toBe(false);
    expect(retryShipmentRead(0,new Error("unknown"))).toBe(false);
  });
});
