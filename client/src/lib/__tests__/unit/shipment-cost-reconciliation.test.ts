import { afterEach, describe, expect, it, vi } from "vitest";
import { createShipmentReconciliationClient } from "../../shipment-cost-reconciliation";
const request = {
  sourceVersion: "a".repeat(64),
  destination: "inventory_variance" as const,
  reason: "Synthetic historical evidence reviewed.",
};
const result = {
  lineId: 23,
  shipmentId: 4,
  applicationId: 8,
  state: { status: "posted", postedMills: 10001, unassignedMills: 0, destination: "inventory_variance" },
};
afterEach(() => vi.unstubAllGlobals());
describe("reconciliation command client", () => {
  it("retains the exact request and key after a lost response", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("lost response"))
      .mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetch);
    const key = vi.fn(() => "synthetic-key"),
      client = createShipmentReconciliationClient(key);
    await expect(client.reconcile(23, request)).rejects.toMatchObject({ ambiguous: true });
    expect(await client.reconcile(23, request)).toEqual(result);
    expect(key).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toEqual(fetch.mock.calls[1][1]);
  });
  it.each([
    {},
    { ...result, lineId: 99 },
    { ...result, state: { ...result.state, status: "review_required" } },
    { ...result, state: { ...result.state, destination: "historical_cogs" } },
  ])("rejects an unverified success %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(createShipmentReconciliationClient(() => "key").reconcile(23, request)).rejects.toMatchObject({
      ambiguous: true,
    });
  });
  it("does not send invalid or modified ambiguous approvals", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("network lost"));
    vi.stubGlobal("fetch", fetch);
    const client = createShipmentReconciliationClient(() => "key");
    await expect(client.reconcile(0, request)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.reconcile(23, request)).rejects.toThrow();
    await expect(client.reconcile(23, { ...request, destination: "historical_cogs" })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
