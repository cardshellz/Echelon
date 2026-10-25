import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../routes/middleware", () => ({
  requirePermission:
    (resource: string, action: string) =>
    (req: Request, res: Response, next: NextFunction) =>
      req.headers["x-permission"] === `${resource}:${action}`
        ? next()
        : res.status(403).json({ error: "Forbidden" }),
}));
import { registerCostOriginRepairRoutes } from "../../cost-origin-repair.routes";
import { OriginRepairError } from "../../domain/cost-origin-repair";

const input = {
  sourceVersion: "a".repeat(64),
  previewVersion: "b".repeat(64),
  unitsPerCase: 50,
  productMills: 1250000,
  packagingMills: 250000,
  destination: "historical_cogs",
  reason: "Original supplier evidence checked.",
  evidenceConfirmed: true,
};
describe("historical cost origin HTTP controls", () => {
  const service = { context: vi.fn(), preview: vi.fn(), approve: vi.fn() };
  let server: http.Server, base: string;
  beforeEach(async () => {
    vi.resetAllMocks();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = {
        user: req.headers["x-actor"]
          ? { id: String(req.headers["x-actor"]) }
          : undefined,
      } as typeof req.session;
      next();
    });
    registerCostOriginRepairRoutes(app, service);
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const post = (
    options: {
      id?: string;
      body?: unknown;
      permission?: string;
      actor?: string;
      key?: string;
      preview?: boolean;
    } = {},
  ) =>
    requestLocalHttp(
      `${base}/api/inventory-lots/${options.id ?? "23"}/cost-origin-repair${options.preview ? "/preview" : ""}`,
      {
        method: "POST",
        body: JSON.stringify(options.body ?? input),
        headers: {
          "content-type": "application/json",
          "x-actor": options.actor ?? "admin",
          "x-permission": options.permission ?? "purchasing:approve",
          "idempotency-key": options.key ?? "origin-test-key",
        },
      },
    );
  it("requires approval permission, authentication and a command key before calling the owner", async () => {
    for (const permission of [
      "purchasing:view",
      "purchasing:edit",
      "inventory:approve",
    ])
      expect((await post({ permission })).status).toBe(403);
    expect((await post({ actor: "" })).status).toBe(401);
    expect((await post({ key: "" })).status).toBe(400);
    expect(service.approve).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "0023", "23x", "23.5", "2147483648"])(
    "rejects invalid lot %s",
    async (id) => {
      expect((await post({ id })).status).toBe(400);
      expect(service.approve).not.toHaveBeenCalled();
    },
  );
  it("rejects missing confirmation, fractional money, oversized values and unreviewed commands", async () => {
    for (const body of [
      { ...input, evidenceConfirmed: false },
      { ...input, productMills: 0.5 },
      { ...input, productMills: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, unitsPerCase: 0 },
      { ...input, unitsPerCase: 2_147_483_648 },
      { ...input, destination: "ignore" },
      { ...input, reason: "" },
      { ...input, previewVersion: undefined },
      { ...input, force: true },
    ])
      expect((await post({ body })).status).toBe(400);
    expect(service.approve).not.toHaveBeenCalled();
  });
  it("binds the administrator to the reviewed lot and preserves replay responses", async () => {
    service.approve.mockResolvedValue({
      httpStatus: 200,
      replayed: true,
      body: { lotId: 23 },
    });
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(service.approve).toHaveBeenCalledWith(
      23,
      input,
      "admin",
      expect.objectContaining({
        actorId: "admin",
        actorType: "user",
        resourceKey: "inventory_lot:23",
        commandName: "procurement.cost_origin.repair",
        idempotencyKey: "origin-test-key",
      }),
    );
  });
  it("returns an actionable stale review while hiding database details", async () => {
    service.approve.mockRejectedValueOnce(
      new OriginRepairError("COST_ORIGIN_STALE", "Reload the changed receipt."),
    );
    expect(await (await post()).json()).toEqual({
      code: "COST_ORIGIN_STALE",
      error: "Reload the changed receipt.",
    });
    service.approve.mockRejectedValueOnce(
      new Error("private SQL or credentials"),
    );
    const failed = await post();
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("private SQL");
  });
  it("requires view permission for evidence and approval permission for a preview", async () => {
    expect(
      (await requestLocalHttp(`${base}/api/inventory-lots/23/cost-origin-repair`)).status,
    ).toBe(403);
    const { previewVersion, ...review } = input;
    expect(
      (
        await post({
          preview: true,
          body: review,
          permission: "purchasing:view",
        })
      ).status,
    ).toBe(403);
    service.preview.mockResolvedValue({ sourceVersion: input.sourceVersion });
    expect((await post({ preview: true, body: review })).status).toBe(200);
    expect(service.preview).toHaveBeenCalledWith(23, review, "admin");
  });
});
