import { afterEach, describe, expect, it, vi } from "vitest";
import { createShipmentCostUpdateClient, readShipmentCostWorkflow, shipmentCostWorkflowError } from "../../shipment-cost-workflow";
import { FinancialCommandRequestError } from "../../financial-command";

afterEach(() => vi.unstubAllGlobals());
const result = (shipmentId = 42) => ({ shipmentId, finalizedLines: 2, adjustments: 1,
  status: "applied", updated: 2, total: 2, skipped: [] });
const response = (body = result(), status = 200) => new Response(JSON.stringify(body), { status });

it("requests the exception-aware read contract with the current session", async () => {
  const saved = { shipmentId: 42, lines: [] };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(saved)));
  vi.stubGlobal("fetch", fetch);
  expect(await readShipmentCostWorkflow("/api/inbound-shipments/42/cost-review")).toEqual(saved);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/inbound-shipments/42/cost-review", {
    method: "GET", credentials: "include", headers: { "X-Shipment-Cost-Review-Version": "2" },
  });
});

describe("shipment cost update intent", () => {
  it("keeps the same key after a lost response and rotates only after verified completion", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("network lost"))
      .mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetch);
    const generateKey = vi.fn().mockReturnValueOnce("first-key").mockReturnValueOnce("second-key");
    const client = createShipmentCostUpdateClient(generateKey);
    await expect(client.update(42)).rejects.toThrow();
    expect(await client.update(42)).toEqual(result());
    await client.update(42);
    expect(fetch.mock.calls.map(call => call[1].headers["Idempotency-Key"])).toEqual(["first-key", "first-key", "second-key"]);
    expect(fetch.mock.calls.every(call => call[0] === "/api/inbound-shipments/42/update-costs" && call[1].body === "{}")).toBe(true);
  });
  it.each([{}, result(99)])("retains an uncertain command after an invalid success response %j", async body => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body))).mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetch);
    const generateKey = vi.fn(() => "same-key");
    const client = createShipmentCostUpdateClient(generateKey);
    await expect(client.update(42)).rejects.toMatchObject({ ambiguous: true, code: "SHIPMENT_COST_UPDATE_RESPONSE_INVALID" });
    await client.update(42);
    expect(generateKey).toHaveBeenCalledTimes(1);
  });
  it("isolates uncertain intents by shipment and rejects invalid identifiers before sending", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("network lost"));
    vi.stubGlobal("fetch", fetch);
    const generateKey = vi.fn().mockReturnValueOnce("shipment-42").mockReturnValueOnce("shipment-43");
    const client = createShipmentCostUpdateClient(generateKey);
    for (const id of [42, 43, 42]) await expect(client.update(id)).rejects.toThrow();
    for (const id of [0, -1, 1.2, 2147483648, NaN]) await expect(client.update(id)).rejects.toThrow();
    expect(fetch.mock.calls.map(call => call[1].headers["Idempotency-Key"])).toEqual(["shipment-42", "shipment-43", "shipment-42"]);
  });
});

describe("shipment cost explanations", () => {
  it("unwraps old transport errors without showing HTTP or JSON syntax", () => {
    expect(shipmentCostWorkflowError(new Error('409: {"error":"Check the shipment quantities."}'))).toBe("Check the shipment quantities.");
    expect(shipmentCostWorkflowError(new Error('500: {"error":"private database details"}'))).not.toContain("private");
    expect(shipmentCostWorkflowError(new Error("502: <html>bad gateway</html>"))).not.toContain("html");
  });
  it("explains permission and uncertain results without implying a failed commit", () => {
    expect(shipmentCostWorkflowError(new FinancialCommandRequestError("Forbidden", { status: 403, retryable: false, ambiguous: false }))).toContain("purchasing approval");
    expect(shipmentCostWorkflowError(new FinancialCommandRequestError("lost", { status: 0, ambiguous: true, retryable: true }))).toContain("could not confirm");
  });
});
