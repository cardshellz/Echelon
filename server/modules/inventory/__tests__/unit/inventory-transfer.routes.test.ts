import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InventoryQuantityError } from "../../domain/quantity-ledger";
import { AppError } from "@shared/errors";
import { inventoryTransferRequestSchema } from "@shared/types/inventory-transfer";
import { FinancialCommandError } from "../../../../platform/commands/transactional-command.service";

const storage = vi.hoisted(() => ({ getWarehouseLocationById: vi.fn(), getProductVariantById: vi.fn() }));
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../index", () => ({ inventoryStorage: storage }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../orders", () => ({ ordersStorage: {} }));
vi.mock("../../../channels", () => ({ channelsStorage: {} }));
vi.mock("../../../../routes/middleware", () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return { requirePermission: () => pass, requireAuth: pass, upload: { single: () => pass } };
});
import { registerInventoryRoutes } from "../../inventory.routes";

describe("inventory transfer HTTP contract", () => {
  let server: Server;
  let url: string;
  const transfer = vi.fn();
  const queueSyncAfterInventoryChange = vi.fn();
  const completeMatchingTransferTask = vi.fn();
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    storage.getWarehouseLocationById.mockImplementation(async (id: number) => ({ id, warehouseId: id === 9 ? 2 : 1 }));
    storage.getProductVariantById.mockResolvedValue({ id: 174 });
    transfer.mockResolvedValue({ reservedMoved: 0, orderItemsRepointed: 0 });
    queueSyncAfterInventoryChange.mockResolvedValue(undefined);
    completeMatchingTransferTask.mockResolvedValue(undefined);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: "operator" } } as Request["session"]; next(); });
    // Isolate only the ports invoked by this handler; real transactional owners
    // are covered by the PostgreSQL suite rather than mocked here.
    app.locals.services = { inventoryTransfers: { transfer }, channelSync: { queueSyncAfterInventoryChange },
      replenishment: { completeMatchingTransferTask, checkReplenForLocation: vi.fn(async () => undefined) } } as unknown as typeof app.locals.services;
    registerInventoryRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory/transfer`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks(); });
  const body = { commandKey: "transfer:test", fromLocationId: 9, toLocationId: 10, variantId: 174, quantity: 50 };
  const post = (payload: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

  it("forwards exact locations, actor, arrival confirmation and retry identity to the existing owner", async () => {
    expect((await post({ ...body, crossWarehouseArrivalConfirmed: true })).status).toBe(200);
    expect(transfer).toHaveBeenCalledExactlyOnceWith({ ...body, crossWarehouseArrivalConfirmed: true }, "operator");
    // The transaction/outbox owner controls publication and task credit.
    expect(queueSyncAfterInventoryChange).not.toHaveBeenCalled();
    expect(completeMatchingTransferTask).not.toHaveBeenCalled();
  });
  it("does not silently opt existing callers into cross-warehouse movements", async () => {
    expect((await post(body)).status).toBe(200);
    expect(transfer.mock.calls[0][0]).not.toHaveProperty("crossWarehouseArrivalConfirmed");
  });
  it.each([{ quantity: 1.5 }, { quantity: "50cases" }, { crossWarehouseArrivalConfirmed: "true" }, { toLocationId: 9 }])(
    "returns structured validation failures from the application owner: %s", async patch => {
      transfer.mockImplementationOnce(async payload => inventoryTransferRequestSchema.parse(payload));
      const response = await post({ ...body, ...patch });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "TRANSFER_INPUT_INVALID" });
      expect(transfer).toHaveBeenCalledExactlyOnceWith({ ...body, ...patch }, "operator");
      expect(storage.getWarehouseLocationById).not.toHaveBeenCalled();
    });
  it("returns a structured conflict and does not publish when the owner rejects the movement", async () => {
    transfer.mockRejectedValue(new InventoryQuantityError("TRANSFER_ARRIVAL_CONFIRMATION_REQUIRED", "Confirm arrival", { fromWarehouseId: 2, toWarehouseId: 1 }));
    const response = await post(body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TRANSFER_ARRIVAL_CONFIRMATION_REQUIRED", context: { fromWarehouseId: 2, toWarehouseId: 1 } });
    expect(queueSyncAfterInventoryChange).not.toHaveBeenCalled();
    expect(completeMatchingTransferTask).not.toHaveBeenCalled();
  });
  it("preserves a replayed application rejection's status, code and context", async () => {
    transfer.mockRejectedValue(new AppError("Confirm arrival", "TRANSFER_ARRIVAL_CONFIRMATION_REQUIRED", 409, { fromWarehouseId: 2 }));
    const response = await post(body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TRANSFER_ARRIVAL_CONFIRMATION_REQUIRED", context: { fromWarehouseId: 2 } });
  });
  it("preserves command concurrency conflicts and retry guidance", async () => {
    transfer.mockRejectedValue(new FinancialCommandError("Command is running", 409, "FINANCIAL_COMMAND_IN_PROGRESS",
      { commandId: 7 }, { "Retry-After": "1" }));
    const response = await post(body);
    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.json()).toMatchObject({ code: "FINANCIAL_COMMAND_IN_PROGRESS", context: { commandId: 7 } });
  });
  it("reports unexpected application failures as server failures without exposing internals", async () => {
    transfer.mockRejectedValue(new Error("private database connection details"));
    const response = await post(body);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "INVENTORY_TRANSFER_FAILED", error: "Failed to transfer inventory" });
  });
});
