import http from "http";
import { AddressInfo } from "net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReturnCaseAdminError,
  type ReturnCaseAdminService,
} from "../../application/return-case-admin.service";
import {
  OpenReturnCaseError,
  type OpenReturnCaseService,
} from "../../application/open-return-case.service";
import { registerReturnCaseAdminRoutes } from "../../interfaces/http/return-case-admin.routes";

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({ requirePermission: requirePermissionMock }));

describe("return case admin routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: ReturnType<typeof fakeService>;
  let openService: ReturnType<typeof fakeOpenService>;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = fakeService();
    openService = fakeOpenService();
    server = await startServer(buildApp(service, openService));
  });

  afterEach(async () => server.close());

  it("validates and forwards normalized list filters", async () => {
    service.list.mockResolvedValue({
      cases: [],
      summary: { total: 0, open: 0, awaitingInspection: 0, closed: 0 },
      pagination: { page: 2, limit: 10, total: 0, totalPages: 0 },
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases?search=%20RMA-1%20&caseStatus=open&sourceProvider=shopify&page=2&limit=10`);

    expect(response.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith({
      search: "RMA-1",
      caseStatus: "open",
      sourceProvider: "shopify",
      channelId: null,
      page: 2,
      limit: 10,
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "view");
  });

  it("rejects invalid pagination before calling the service", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/cases?page=0&limit=101`);

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(service.list).not.toHaveBeenCalled();
  });

  it("rejects unsafe case ids before calling the service", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/9007199254740992`);

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(service.getById).not.toHaveBeenCalled();
  });

  it("returns classified not-found responses", async () => {
    service.getById.mockRejectedValue(new ReturnCaseAdminError(
      "RETURN_CASE_NOT_FOUND",
      "Return case was not found.",
      404,
      { id: 42 },
    ));

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42`);

    expect(response).toEqual({
      status: 404,
      body: {
        error: {
          code: "RETURN_CASE_NOT_FOUND",
          message: "Return case was not found.",
          context: { id: 42 },
        },
      },
    });
  });

  it("normalizes source-order search and requires view permission", async () => {
    openService.searchSourceOrders.mockResolvedValue({
      orders: [],
      channels: [],
      pagination: { page: 3, limit: 10, total: 0, totalPages: 0 },
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/source-orders?search=%20ORDER-1%20&channelId=36&page=3&limit=10`);

    expect(response.status).toBe(200);
    expect(openService.searchSourceOrders).toHaveBeenCalledWith({
      search: "ORDER-1",
      channelId: 36,
      page: 3,
      limit: 10,
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "view");
  });

  it("opens a case with the authenticated actor and edit permission", async () => {
    openService.open.mockResolvedValue({ caseId: 9, caseNumber: "RMA-00000009", wmsReturnId: 10, replayed: false });
    const body = {
      idempotencyKey: "command-1",
      omsOrderId: 101,
      wmsOrderId: 201,
      reasonCode: "buyer_return",
      notes: "customer request",
      items: [{ wmsOrderItemId: 301, quantity: 1 }],
    };

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases`, { method: "POST", body });

    expect(response.status).toBe(201);
    expect(openService.open).toHaveBeenCalledWith({ ...body, actor: "user:7" });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "edit");
  });

  it("returns 200 for an idempotent replay", async () => {
    openService.open.mockResolvedValue({ caseId: 9, caseNumber: "RMA-00000009", wmsReturnId: 10, replayed: true });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases`, {
      method: "POST",
      body: {
        idempotencyKey: "command-1",
        omsOrderId: 101,
        wmsOrderId: 201,
        reasonCode: "buyer_return",
        notes: null,
        items: [{ wmsOrderItemId: 301, quantity: 1 }],
      },
    });

    expect(response.status).toBe(200);
  });

  it("rejects malformed create commands before calling the service", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/cases`, {
      method: "POST",
      body: {
        idempotencyKey: "command-1",
        omsOrderId: 101,
        wmsOrderId: 201,
        reasonCode: "made_up",
        items: [],
      },
    });

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(openService.open).not.toHaveBeenCalled();
  });

  it("preserves classified create conflicts", async () => {
    openService.open.mockRejectedValue(new OpenReturnCaseError(
      "RETURN_CASE_QUANTITY_UNAVAILABLE",
      "The requested quantity is unavailable.",
      409,
      { wmsOrderItemId: 301 },
    ));

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases`, {
      method: "POST",
      body: {
        idempotencyKey: "command-1",
        omsOrderId: 101,
        wmsOrderId: 201,
        reasonCode: "buyer_return",
        notes: null,
        items: [{ wmsOrderItemId: 301, quantity: 2 }],
      },
    });

    expect(response).toMatchObject({ status: 409, body: { error: { code: "RETURN_CASE_QUANTITY_UNAVAILABLE" } } });
  });
});

function fakeService() {
  return { list: vi.fn(), getById: vi.fn() };
}

function fakeOpenService() {
  return { searchSourceOrders: vi.fn(), getSourceOrder: vi.fn(), open: vi.fn() };
}

function buildApp(
  service: ReturnType<typeof fakeService>,
  openService: ReturnType<typeof fakeOpenService>,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: number } } }).session = { user: { id: 7 } };
    next();
  });
  registerReturnCaseAdminRoutes(
    app,
    service as unknown as ReturnCaseAdminService,
    openService as unknown as OpenReturnCaseService,
  );
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(
  url: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const target = new URL(url);
  const rawRequestBody = options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "GET",
      headers: rawRequestBody === null ? undefined : {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(rawRequestBody),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: rawBody === "" ? {} : JSON.parse(rawBody) as Record<string, any>,
        });
      });
    });
    request.on("error", reject);
    if (rawRequestBody !== null) request.write(rawRequestBody);
    request.end();
  });
}
