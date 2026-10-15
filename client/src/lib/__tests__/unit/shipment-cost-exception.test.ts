import { afterEach, describe, expect, it, vi } from "vitest";
import { createShipmentExceptionClient } from "../../shipment-cost-exception";
const request = { sourceVersion: "a".repeat(64), action: "accept" as const, reason: "Historical receipt records reviewed." };
const result = { lineId: 141, shipmentId: 92, decision: { id: 1, action: "accept", fingerprint: "b".repeat(64),
  reason: request.reason, actorId: "admin", recordedAt: "2026-10-15T12:00:00Z" } };
afterEach(() => vi.unstubAllGlobals());
describe("shipment exception approval client", () => {
  it("retries a lost response with the exact same approval and idempotency key", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("network lost"))
      .mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetch);
    const key = vi.fn(() => "approval-key"), client = createShipmentExceptionClient(key);
    await expect(client.decide(141, request)).rejects.toMatchObject({ ambiguous: true });
    expect(await client.decide(141, request)).toEqual(result);
    expect(key).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.map(call => call[1])).toEqual([expect.objectContaining({
      body: JSON.stringify(request), headers: expect.objectContaining({ "Idempotency-Key": "approval-key" }),
    }), expect.objectContaining({ body: JSON.stringify(request), headers: expect.objectContaining({ "Idempotency-Key": "approval-key" }) })]);
  });
  it.each([{}, { ...result, lineId: 99 }, { ...result, decision: { ...result.decision, action: "reopen" } }])("does not confirm an invalid response %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(createShipmentExceptionClient(() => "key").decide(141, request)).rejects.toMatchObject({ ambiguous: true, code: "SHIPMENT_EXCEPTION_RESPONSE_INVALID" });
  });
  it("rejects invalid identifiers and unsupported client fields before posting", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const client = createShipmentExceptionClient(() => "key");
    for (const id of [0, -1, 1.5, 2147483648]) await expect(client.decide(id, request)).rejects.toThrow();
    await expect(client.decide(141, { ...request, reason: "" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
