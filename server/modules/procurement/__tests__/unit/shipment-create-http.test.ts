import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServiceRegistry } from "../../../../services";

const mocks = vi.hoisted(() => ({
  actorId: "operator" as string | undefined,
  permission: vi.fn(),
  repository: { reserve: vi.fn(), executeClaim: vi.fn(), rejectClaim: vi.fn(), markRetryable: vi.fn() },
}));
vi.mock("../../../../routes/middleware", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission: (resource: string, action: string) => (req: Request, _res: Response, next: NextFunction) => {
    mocks.permission(resource, action);
    (req as Request & { user: unknown }).user = mocks.actorId ? { id: mocks.actorId } : undefined;
    next();
  },
}));
vi.mock("../../../../middleware/idempotency", () => ({ requireIdempotency: () => (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: mocks.repository, createDrizzleFinancialCommandRepository: () => mocks.repository }));
vi.mock("../../ap-ledger.service", () => ({}));
vi.mock("../../../notifications/notifications.service", () => ({}));

import { registerInboundShipmentRoutes } from "../../inbound-shipment.routes";
import { FinancialCommandError } from "../../../../platform/commands/transactional-command.service";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import { shipmentCreateCommandScope } from "../../shipment-create.commands";

const NOW = new Date("2026-10-18T12:00:00.000Z");
const CREATED = { id: 7, shipmentNumber: "SHP-20261018-001", status: "draft", lineCount: 0, createdBy: "operator", createdAt: NOW, updatedAt: NOW };
const KEY = "shipment-create-http-fixture";
const service = { executeCreateShipmentInTransaction: vi.fn(), createShipment: vi.fn() };
let server: Server | undefined;
let url: string;
async function send(body: unknown, headers: Record<string, string> = { "Idempotency-Key": KEY }, suffix = "") {
  const payload = JSON.stringify(body);
  return new Promise<{ status: number; headers: Headers; body: unknown }>((resolve, reject) => {
    const req = request(`${url}/api/inbound-shipments${suffix}`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } }, res => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { content += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, headers: new Headers(res.headers as Record<string, string>), body: JSON.parse(content) }); }
        catch (error) { reject(error); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload);
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.actorId = "operator";
  mocks.repository.reserve.mockResolvedValue({ kind: "claimed", claim: { commandId: 1, leaseToken: "fixture" } });
  mocks.repository.executeClaim.mockImplementation(async (_claim, _descriptor, work) => ({ commandId: 1, replayed: false, terminalState: "succeeded", ...await work({ name: "fixture-tx" }) }));
  mocks.repository.rejectClaim.mockImplementation(async (_claim, _descriptor, rejection) => ({ commandId: 1, replayed: false, terminalState: "rejected", httpStatus: rejection.httpStatus, body: rejection.body }));
  mocks.repository.markRetryable.mockResolvedValue(undefined);
  service.executeCreateShipmentInTransaction.mockResolvedValue(CREATED);
  const app = express();
  app.use(express.json());
  // This HTTP harness supplies only the creation dependency; other handlers never execute.
  app.locals.services = { shipmentTracking: service } as unknown as ServiceRegistry;
  registerInboundShipmentRoutes(app);
  server = createServer(app);
  await new Promise<void>(resolve => { server!.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (!server?.listening) { server = undefined; return; }
  const active = server; server = undefined;
  await new Promise<void>((resolve, reject) => active.close(error => error ? reject(error) : resolve()));
  vi.restoreAllMocks();
});

describe("shipment create HTTP recovery contract", () => {
  it("reserves the original body and delegates exactly one atomic command with the authenticated actor", async () => {
    const body = { mode: "air", notes: "Reviewed input" };
    const result = await send(body);
    expect(result).toMatchObject({ status: 201, body: { id: 7, lineCount: 0, createdAt: NOW.toISOString() } });
    expect(result.headers.get("Idempotency-Replayed")).toBe("false");
    expect(mocks.permission).toHaveBeenCalledWith("purchasing", "create");
    expect(mocks.repository.reserve).toHaveBeenCalledWith(expect.objectContaining({
      ...shipmentCreateCommandScope(), actorType: "service", actorId: "procurement.shipment-create", idempotencyKey: KEY,
      requestHash: hashHttpFinancialCommand({ ...shipmentCreateCommandScope(), body }),
    }));
    expect(service.executeCreateShipmentInTransaction).toHaveBeenCalledWith({ name: "fixture-tx" }, body, "operator", expect.any(Date));
    expect(service.createShipment).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "  "])("rejects missing/invalid authentication before reserving even a possible replay %#", async actor => {
    mocks.actorId = actor;
    const result = await send({});
    expect(result).toMatchObject({ status: 401, body: { code: "SHIPMENT_CREATE_ACTOR_REQUIRED" } });
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REQUIRED"],
    [{ "Idempotency-Key": "short" }, "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_INVALID"],
    [{ "Idempotency-Key": KEY, "X-Idempotency-Key": "different-key" }, "FINANCIAL_COMMAND_IDEMPOTENCY_HEADERS_CONFLICT"],
  ] as const)("rejects missing/invalid request key before mutation %#", async (headers, code) => {
    expect(await send({}, headers)).toMatchObject({ status: 400, body: { code } });
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
  });

  it("rejects unsupported query input before reservation", async () => {
    const result = await send({}, { "Idempotency-Key": KEY }, "?unknown=1");
    expect(result.status).toBe(400);
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
  });

  it("marks only durable input rejection as safe for a revised request", async () => {
    const result = await send({ status: "closed" });
    expect(result).toMatchObject({ status: 400, body: { code: "SHIPMENT_CREATE_INPUT_INVALID", details: { shipmentCreateOutcome: "rejected", idempotencyKey: KEY } } });
    expect(service.executeCreateShipmentInTransaction).not.toHaveBeenCalled();
    expect(mocks.repository.rejectClaim).toHaveBeenCalledOnce();
  });

  it("replays the exact stored body and does not reexecute the transaction owner", async () => {
    const body = JSON.parse(JSON.stringify(CREATED));
    mocks.repository.reserve.mockResolvedValue({ kind: "replay", result: { commandId: 1, replayed: true, terminalState: "succeeded", httpStatus: 201, body } });
    const result = await send({});
    expect(result.body).toEqual(body);
    expect(result.headers.get("Idempotency-Replayed")).toBe("true");
    expect(service.executeCreateShipmentInTransaction).not.toHaveBeenCalled();
  });

  it("preserves in-progress retry headers without implying the original request failed", async () => {
    mocks.repository.reserve.mockRejectedValue(new FinancialCommandError("Still running", 409, "FINANCIAL_COMMAND_IN_PROGRESS", undefined, { "Retry-After": "2" }));
    const result = await send({});
    expect(result).toMatchObject({ status: 409, body: { code: "FINANCIAL_COMMAND_IN_PROGRESS" } });
    expect(result.headers.get("Retry-After")).toBe("2");
    expect(result.body).not.toHaveProperty("details.shipmentCreateOutcome");
  });

  it("logs a sanitized retryable failure and keeps the unresolved recovery outcome", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    service.executeCreateShipmentInTransaction.mockRejectedValue(new Error("private SQL/password/row payload"));
    const result = await send({});
    expect(result).toMatchObject({ status: 500, body: { code: "SHIPMENT_CREATE_TRANSIENT_FAILURE" } });
    expect(result.body).not.toHaveProperty("details.shipmentCreateOutcome");
    expect(JSON.stringify(result.body)).not.toContain("private");
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"actorId":"operator"'));
    expect(log.mock.calls.flat().join(" ")).not.toContain("private SQL");
    expect(mocks.repository.markRetryable).toHaveBeenCalledOnce();
  });
});
