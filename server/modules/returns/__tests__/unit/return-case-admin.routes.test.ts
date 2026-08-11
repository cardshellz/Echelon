import http from "http";
import { AddressInfo } from "net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReturnCaseAdminError,
  type ReturnCaseAdminService,
} from "../../application/return-case-admin.service";
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

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = fakeService();
    server = await startServer(buildApp(service));
  });

  afterEach(async () => server.close());

  it("validates and forwards normalized list filters", async () => {
    service.list.mockResolvedValue({ cases: [], pagination: { page: 2, limit: 10, total: 0, totalPages: 0 } });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases?search=%20RMA-1%20&caseStatus=open&sourceProvider=shopify&page=2&limit=10`);

    expect(response.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith({
      search: "RMA-1",
      caseStatus: "open",
      sourceProvider: "shopify",
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
});

function fakeService() {
  return { list: vi.fn(), getById: vi.fn() };
}

function buildApp(service: ReturnType<typeof fakeService>): express.Express {
  const app = express();
  app.use(express.json());
  registerReturnCaseAdminRoutes(app, service as unknown as ReturnCaseAdminService);
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

async function jsonRequest(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "GET",
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: rawBody === "" ? {} : JSON.parse(rawBody) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}
