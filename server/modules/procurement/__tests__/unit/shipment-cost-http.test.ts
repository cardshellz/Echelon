import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  actorId: "owner-1" as string | undefined,
  permission: vi.fn(),
  repository: { reserve: vi.fn(), executeClaim: vi.fn(), rejectClaim: vi.fn(), markRetryable: vi.fn() },
}));
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: (resource: string, action: string) => (req: Request, _res: Response, next: NextFunction) => {
    mocks.permission(resource, action);
    (req as Request & { user: unknown }).user = mocks.actorId ? { id: mocks.actorId } : undefined;
    next();
  },
}));
vi.mock("../../../../middleware/idempotency", () => ({ requireIdempotency: () => (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: mocks.repository }));
vi.mock("../../ap-ledger.service", () => ({}));
vi.mock("../../../notifications/notifications.service", () => ({}));

import { registerInboundShipmentRoutes } from "../../inbound-shipment.routes";
import { FinancialCommandError } from "../../../../platform/commands/transactional-command.service";

let server: Server | undefined;
let url: string;
const service = { executeCostCommandInTransaction: vi.fn() };
const KEY = "shipment-cost-http-fixture";

async function send(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.actorId = "owner-1";
  mocks.repository.reserve.mockResolvedValue({ kind: "claimed", claim: { commandId: 1, leaseToken: "fixture" } });
  mocks.repository.executeClaim.mockImplementation(async (_claim, _descriptor, work) => ({ commandId: 1, replayed: false, terminalState: "succeeded", ...await work({ name: "fixture-transaction" }) }));
  service.executeCostCommandInTransaction.mockResolvedValue({ id: 31, inboundShipmentId: 7, version: "a".repeat(64) });
  const app = express();
  app.use(express.json());
  app.locals.services = { shipmentTracking: service };
  registerInboundShipmentRoutes(app);
  server = createServer(app);
  await new Promise<void>((resolve) => { server!.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe("shipment cost HTTP command contract", () => {
  it.each([
    ["POST", "/api/inbound-shipments/7/costs", "create", "shipment:7", 201],
    ["PATCH", "/api/inbound-shipments/costs/31", "update", "shipment_cost:31", 200],
    ["DELETE", "/api/inbound-shipments/costs/31", "delete", "shipment_cost:31", 200],
  ])("binds %s to its command scope and preserves the request body", async (method, path, operation, resourceKey, status) => {
    const body = operation === "create" ? { costType: "freight", actualCents: 0 } : { expectedVersion: "b".repeat(64), reason: "Fixture correction" };
    const result = await send(method as string, path as string, body, { "Idempotency-Key": KEY });
    expect(result.status).toBe(status);
    expect(result.headers.get("Idempotency-Replayed")).toBe("false");
    expect(mocks.permission).toHaveBeenCalledWith("purchasing", "edit");
    expect(mocks.repository.reserve).toHaveBeenCalledWith(expect.objectContaining({
      method, resourceKey, commandName: `procurement.shipment_cost.${operation}`,
      actorType: "service", actorId: "procurement.shipment-cost", idempotencyKey: KEY,
    }));
    expect(service.executeCostCommandInTransaction).toHaveBeenCalledWith(
      expect.any(Object), { operation, resourceId: operation === "create" ? 7 : 31, body }, "owner-1", expect.any(Date),
    );
  });

  it.each(["0", "-1", "1.5", "01", "7junk", "2147483648", "9007199254740993"]) ("rejects invalid ID %s before reservation", async (id) => {
    const result = await send("POST", `/api/inbound-shipments/${id}/costs`, { costType: "freight" }, { "Idempotency-Key": KEY });
    expect(result).toMatchObject({ status: 400, body: { code: "SHIPMENT_COST_ID_INVALID" } });
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
  });

  it("rejects a missing key without reaching the domain", async () => {
    const result = await send("POST", "/api/inbound-shipments/7/costs", { costType: "freight" });
    expect(result).toMatchObject({ status: 400, body: { code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REQUIRED" } });
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
    expect(service.executeCostCommandInTransaction).not.toHaveBeenCalled();
  });

  it("requires an actual authenticated actor even though the replay scope uses the service owner", async () => {
    mocks.actorId = undefined;
    const result = await send("DELETE", "/api/inbound-shipments/costs/31", { expectedVersion: "b".repeat(64) }, { "Idempotency-Key": KEY });
    expect(result).toMatchObject({ status: 401, body: { code: "SHIPMENT_COST_ACTOR_REQUIRED" } });
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
  });

  it("returns exact stored status/body and signals replay to a delegated caller", async () => {
    const body = { id: 31, actualCents: 0, description: "Recorded response" };
    mocks.actorId = "delegate-2";
    mocks.repository.reserve.mockResolvedValue({ kind: "replay", result: { commandId: 1, replayed: true, terminalState: "succeeded", httpStatus: 201, body } });
    const result = await send("POST", "/api/inbound-shipments/7/costs", { costType: "freight", actualCents: 0 }, { "Idempotency-Key": KEY });
    expect(result.status).toBe(201);
    expect(result.body).toEqual(body);
    expect(result.headers.get("Idempotency-Replayed")).toBe("true");
    expect(service.executeCostCommandInTransaction).not.toHaveBeenCalled();
  });

  it("preserves the command retry header and structured conflict response", async () => {
    mocks.repository.reserve.mockRejectedValue(new FinancialCommandError("Still running", 409, "FINANCIAL_COMMAND_IN_PROGRESS", undefined, { "Retry-After": "3" }));
    const result = await send("POST", "/api/inbound-shipments/7/costs", { costType: "freight" }, { "Idempotency-Key": KEY });
    expect(result).toMatchObject({ status: 409, body: { code: "FINANCIAL_COMMAND_IN_PROGRESS", error: "Still running" } });
    expect(result.headers.get("Retry-After")).toBe("3");
    expect(service.executeCostCommandInTransaction).not.toHaveBeenCalled();
  });
});
