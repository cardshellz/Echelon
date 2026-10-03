import type { Express, Request, RequestHandler, Response } from "express";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, IntegrityError } from "@shared/errors";
import type { Order } from "@shared/schema";
import { requireAuth, requirePermission } from "../../../../routes/middleware";
import { broadcastOrdersUpdated } from "../../../../websocket";
import { registerPickingAssignmentReleaseRoutes } from "../../picking-assignment-release.routes";

vi.mock("../../../../routes/middleware", () => ({ requireAuth: vi.fn(), requirePermission: vi.fn(() => vi.fn()) }));
vi.mock("../../../../websocket", () => ({ broadcastOrdersUpdated: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

function fixture() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const routes = new Map<string, RequestHandler[]>();
  const app = { post(path: string, ...handlers: RequestHandler[]) { routes.set(path, handlers); } } as Express;
  const service = { releaseOrder: vi.fn(async () => ({ id: 1, onHold: 1, pickedCount: 2 }) as Order) };
  registerPickingAssignmentReleaseRoutes(app, service);
  const invoke = async (body: unknown, id = "1", userId: string | undefined = "signed-in-picker") => {
    const req = { params: { id }, body, session: { user: userId ? { id: userId } : undefined },
      sessionID: "session", get: () => "scanner" } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
    const handlers = routes.get("/api/picking/orders/:id/release")!;
    await handlers[handlers.length - 1](req, res, vi.fn());
    return res;
  };
  return { routes, service, invoke };
}

describe("picking assignment HTTP boundary", () => {
  it("uses one handler for normal and legacy force URLs; override URL also requires its explicit permission", () => {
    const { routes } = fixture();
    const normal = routes.get("/api/picking/orders/:id/release")!;
    const legacy = routes.get("/api/orders/:id/force-release")!;
    expect(normal[0]).toBe(requireAuth);
    expect(legacy[0]).toBe(requireAuth);
    expect(requirePermission).toHaveBeenCalledWith("picking", "release_any");
    expect(legacy[legacy.length - 1]).toBe(normal[normal.length - 1]);
  });
  it("takes actor identity only from the session and passes the observed assignment", async () => {
    const { service, invoke } = fixture();
    const expectedAssignment = { assignedPickerId: "assigned", startedAt: "2026-10-03T10:00:00.000Z" };
    const res = await invoke({ expectedAssignment });
    expect(service.releaseOrder).toHaveBeenCalledWith(1, { expectedAssignment,
      userId: "signed-in-picker", deviceType: "scanner", sessionId: "session" });
    expect(res.json).toHaveBeenCalledWith({ id: 1, onHold: 1, pickedCount: 2 });
    expect(broadcastOrdersUpdated).toHaveBeenCalledTimes(1);
  });
  it.each([
    { body: {}, id: "1oops" }, { body: {}, id: "0" }, { body: {}, id: "2147483648" },
    { body: { resetProgress: true }, id: "1" }, { body: { userId: "admin" }, id: "1" },
    { body: { canOverride: true }, id: "1" }, { body: { expectedAssignment: {} }, id: "1" },
    { body: { reason: " " }, id: "1" },
  ])("rejects malformed or authority-spoofing input: %j", async ({ body, id }) => {
    const { service, invoke } = fixture();
    expect((await invoke(body, id)).status).toHaveBeenCalledWith(400);
    expect(service.releaseOrder).not.toHaveBeenCalled();
    expect(broadcastOrdersUpdated).not.toHaveBeenCalled();
  });
  it.each([new AppError("Not permitted", "PICKING_RELEASE_FORBIDDEN", 403), new IntegrityError("Assignment changed")])
    ("preserves the command's error status without reporting success", async failure => {
      const { service, invoke } = fixture();
      service.releaseOrder.mockRejectedValue(failure);
      const res = await invoke({});
      expect(res.status).toHaveBeenCalledWith(failure.statusCode);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: failure.code, error: failure.message }));
      expect(broadcastOrdersUpdated).not.toHaveBeenCalled();
    });
  it("does not expose unexpected internal errors", async () => {
    const { service, invoke } = fixture();
    service.releaseOrder.mockRejectedValue(new Error("private database failure details"));
    const res = await invoke({});
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PICKING_RELEASE_FAILED" }));
    expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain("private database");
  });
  it("retires the old diagnostic writers and removes the storage-layer alternate release", () => {
    const diagnostics = readFileSync("server/routes/diagnostics.ts", "utf8");
    const storage = readFileSync("server/modules/orders/orders.storage.ts", "utf8");
    expect(diagnostics.includes('"PICKING_RELEASE_ENDPOINT_RETIRED"')).toBe(true);
    expect(diagnostics.includes("SET\n          warehouse_status = 'ready'")).toBe(false);
    expect(storage.includes("async forceReleaseOrder(")).toBe(false);
    expect(storage.includes("async releaseOrder(")).toBe(false);
    const pickingRoutes = readFileSync("server/modules/orders/picking.routes.ts", "utf8");
    for (const path of ["hold", "release-hold"]) {
      expect(pickingRoutes.includes(`app.post("/api/orders/:id/${path}", requireAuth, requirePermission("orders", "hold")`)).toBe(true);
    }
  });
});
