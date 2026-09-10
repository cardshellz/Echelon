import type { Express, Request, Response } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const permission = vi.hoisted(() => vi.fn(() => () => {}));
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: permission,
}));
import { registerSharedConfigurationAdminRoutes } from "../../interfaces/http/shared-configuration-admin.routes";
import { SharedShippingConfigurationService } from "../../application/shared-configuration.service";
import type { SharedShippingConfigurationStore } from "../../application/shared-configuration.port";
import {
  ChannelPackagingService,
  type ChannelPackagingStore,
} from "../../application/channel-packaging.service";

describe("shared configuration administration boundaries", () => {
  const routes = new Map<
    string,
    (req: Request, res: Response) => Promise<void>
  >();
  let store: SharedShippingConfigurationStore;
  let packagingStore: ChannelPackagingStore;
  beforeEach(() => {
    vi.stubEnv("DROPSHIP_OMS_CHANNEL_ID", "");
    routes.clear();
    permission.mockClear();
    store = {
      listPackaging: vi.fn(),
      loadPackaging: vi.fn(),
      saveSuite: vi.fn().mockResolvedValue({ id: 1, revision: 1 }),
      saveAssignment: vi.fn(),
      changeSuiteStatus: vi.fn(),
      resetAssignment: vi.fn(),
      resetDropshipProgram: vi.fn(),
      readChargeConfiguration: vi.fn(),
      saveCharges: vi.fn(),
      dropshipConfig: vi.fn(),
      saveDropshipProgram: vi.fn(),
      saveService: vi.fn(),
      history: vi.fn(),
    };
    packagingStore = {
      overview: vi.fn(),
      savePolicy: vi.fn(),
      saveBox: vi.fn(),
    };
    const app = Object.fromEntries(
      ["get", "post", "put", "use"].map((method) => [
        method,
        (
          path: string,
          ...handlers: Array<(req: Request, res: Response) => Promise<void>>
        ) => routes.set(`${method}:${path}`, handlers[handlers.length - 1]),
      ]),
    ) as unknown as Express;
    registerSharedConfigurationAdminRoutes(
      app,
      new SharedShippingConfigurationService(
        store,
        () => new Date("2026-09-09T12:00:00Z"),
      ),
      new ChannelPackagingService(
        packagingStore,
        () => new Date("2026-09-09T12:00:00Z"),
        async () => 11,
      ),
    );
  });
  afterEach(() => vi.unstubAllEnvs());
  it("registers the retirement guard before the legacy write handlers", () => {
    const source = readFileSync(resolve("server/routes.ts"), "utf8");
    expect(
      source.indexOf("registerSharedConfigurationAdminRoutes(app);"),
    ).toBeLessThan(
      source.indexOf("registerDropshipAdminShippingConfigRoutes(app);"),
    );
  });
  it.each([
    "boxes",
    "package-profiles",
    "zone-rules",
    "rate-tables",
    "markup-policies",
    "insurance-policies",
  ])("retires legacy %s writes while preserving reads", (path) => {
    const guard = routes.get("use:/api/dropship/admin/shipping") as unknown as (
      req: Partial<Request>,
      res: unknown,
      next: () => void,
    ) => void;
    const next = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    guard({ method: "POST", path: `/${path}` }, response, next);
    expect(response.status).toHaveBeenCalledWith(410);
    expect(next).not.toHaveBeenCalled();
    guard({ method: "GET", path: `/${path}` }, response, next);
    expect(next).toHaveBeenCalledOnce();
  });
  async function call(
    path: string,
    body: unknown,
    user: unknown = { id: "admin-7" },
  ) {
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(value: unknown) {
        this.body = value;
        return this;
      },
    };
    await routes.get(path)!(
      { body, session: { user }, params: {}, query: {} } as unknown as Request,
      response as unknown as Response,
    );
    return response;
  }
  const valid = {
    name: "Parcel suite",
    boxIds: [1],
    expectedRevision: 0,
    commandId: "123e4567-e89b-42d3-a456-426614174000",
  };
  it("validates packaging commands and authenticates catalog changes before persistence", async () => {
    const body = {
      channelId: 11,
      defaultSuiteId: 1,
      requirement: "unbranded",
      overrides: [],
      expectedRevision: 0,
      commandId: valid.commandId,
    };
    expect(
      (
        await call("put:/api/shipping/admin/packaging-policies", {
          ...body,
          actorId: "spoofed",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call("put:/api/shipping/admin/catalog-boxes", {}, {})).statusCode,
    ).toBe(401);
    expect(packagingStore.savePolicy).not.toHaveBeenCalled();
    expect(packagingStore.saveBox).not.toHaveBeenCalled();
    expect(
      (await call("put:/api/shipping/admin/packaging-policies", body))
        .statusCode,
    ).toBe(200);
    expect(packagingStore.savePolicy).toHaveBeenCalledWith(
      body,
      "admin-7",
      new Date("2026-09-09T12:00:00Z"),
    );
  });
  it("cannot configure another real channel through the Dropship endpoint", async () => {
    const response = await call(
      "put:/api/dropship/admin/shipping/shared/packaging-policies",
      {
        channelId: 12,
        defaultSuiteId: 1,
        requirement: "any",
        overrides: [],
        expectedRevision: 0,
        commandId: valid.commandId,
      },
    );
    expect(response.statusCode).toBe(403);
    expect(packagingStore.savePolicy).not.toHaveBeenCalled();
  });
  it("uses authenticated identity and an injected clock for audited writes", async () => {
    expect(
      (await call("post:/api/shipping/admin/box-suites", valid)).statusCode,
    ).toBe(200);
    expect(store.saveSuite).toHaveBeenCalledWith(
      valid,
      "admin-7",
      new Date("2026-09-09T12:00:00Z"),
    );
    expect(permission).toHaveBeenCalledWith("settings", "edit");
    expect(permission).toHaveBeenCalledWith("dropship", "manage_operations");
  });
  it("rejects actor spoofing, invalid membership and unauthenticated edits before persistence", async () => {
    expect(
      (
        await call("post:/api/shipping/admin/box-suites", {
          ...valid,
          actorId: "other-admin",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call("post:/api/shipping/admin/box-suites", {
          ...valid,
          boxIds: [-1],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call("post:/api/shipping/admin/box-suites", valid, {})).statusCode,
    ).toBe(401);
    expect(store.saveSuite).not.toHaveBeenCalled();
  });
  it("prevents Dropship administrators from altering another channel", async () => {
    const result = await call(
      "put:/api/dropship/admin/shipping/shared/packaging",
      { channel: "shopify" },
    );
    expect(result.statusCode).toBe(403);
    expect(store.saveAssignment).not.toHaveBeenCalled();
  });
  it("does not bypass canonical channel routing when changing the pricing program", async () => {
    vi.stubEnv("DROPSHIP_OMS_CHANNEL_ID", "67");
    const result = await call(
      "put:/api/dropship/admin/shipping/shared/program",
      {},
    );
    expect(result.statusCode).toBe(409);
    expect(store.saveDropshipProgram).not.toHaveBeenCalled();
  });
});
