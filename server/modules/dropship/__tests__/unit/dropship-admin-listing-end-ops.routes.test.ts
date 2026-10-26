import http from "http";
import type { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipListingEndOpsService } from "../../application/dropship-listing-end-ops-service";
import { DropshipError } from "../../domain/errors";
import {
  registerDropshipAdminListingEndOpsRoutes,
  statusForListingEndOpsError,
} from "../../interfaces/http/dropship-admin-listing-end-ops.routes";
import { LISTING_END_OPS_ERROR_CODES } from "../../../../../shared/dropship/listing-end-ops";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

/** The permission check as the routes declare it: the test grants permissions by header, so the split is observable. */
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: (resource: string, action: string) => (req: Request, res: Response, next: NextFunction) => {
    const granted = String(req.headers["x-test-permissions"] ?? "").split(",");
    if (granted.includes(`${resource}:${action}`)) return next();
    return res.status(403).json({ error: `Permission denied: ${resource}:${action}` });
  },
}));

const VIEW = "dropship:view";
const MANAGE = "dropship:manage_operations";

class FakeService {
  readonly calls: Array<{ method: string; input: unknown }> = [];
  failWith: unknown = null;

  private async answer(method: string, input: unknown) {
    this.calls.push({ method, input });
    if (this.failWith) throw this.failWith;
    return { ok: method };
  }
  list(input: unknown) { return this.answer("list", input); }
  retry(input: unknown) { return this.answer("retry", input); }
  resolve(input: unknown) { return this.answer("resolve", input); }
}

describe("dropship admin listing end routes (PLAN-C v4.1 §10; TST-7)", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeService;

  beforeEach(async () => {
    service = new FakeService();
    server = await startServer(buildApp(service as unknown as DropshipListingEndOpsService));
  });

  afterEach(async () => {
    await server.close();
  });

  it("lists with dropship:view and passes the query through for the service to validate", async () => {
    const response = await request(`${server.url}/api/dropship/admin/listing-ends?state=ended&vendorId=70&storeConnectionId=801&page=2&limit=20`,
      { permissions: [VIEW] });
    expect(response.status).toBe(200);
    expect(service.calls).toEqual([{ method: "list", input: { state: "ended", vendorId: 70, storeConnectionId: 801, page: 2, limit: 20 } }]);
    await request(`${server.url}/api/dropship/admin/listing-ends?vendorId=abc`, { permissions: [VIEW] });
    expect(service.calls[1]?.input).toMatchObject({ state: undefined, vendorId: Number.NaN, page: undefined, limit: undefined });
  });

  it("splits permissions: view lists, manage_operations retries and resolves", async () => {
    expect((await request(`${server.url}/api/dropship/admin/listing-ends`, { permissions: [MANAGE] })).status).toBe(403);
    expect((await request(`${server.url}/api/dropship/admin/listing-ends/9/retry`, { method: "POST", permissions: [VIEW],
      body: { idempotencyKey: "staff-key-0001" } })).status).toBe(403);
    expect((await request(`${server.url}/api/dropship/admin/listing-ends/9/resolve`, { method: "POST", permissions: [VIEW],
      body: { outcome: "left_on_sale", reason: "Kept.", idempotencyKey: "staff-key-0001" } })).status).toBe(403);
    expect(service.calls).toEqual([]);
  });

  it("takes the key from the body, else from the Idempotency-Key header, and the actor from the session", async () => {
    await request(`${server.url}/api/dropship/admin/listing-ends/9/retry`, { method: "POST", permissions: [MANAGE],
      body: { idempotencyKey: "body-key-0001", reason: "Attested" }, headers: { "Idempotency-Key": "header-key-0001" } });
    await request(`${server.url}/api/dropship/admin/listing-ends/9/retry`, { method: "POST", permissions: [MANAGE], body: { reason: "  " },
      headers: { "Idempotency-Key": "header-key-0002" } });
    await request(`${server.url}/api/dropship/admin/listing-ends/9/resolve`, { method: "POST", permissions: [MANAGE],
      body: { outcome: "ended_on_ebay", reason: "Ended it." }, headers: { "Idempotency-Key": "header-key-0003" } });
    expect(service.calls).toEqual([
      { method: "retry", input: { endRequestId: 9, reason: "Attested", idempotencyKey: "body-key-0001", actor: { actorType: "admin", actorId: "admin-1" } } },
      { method: "retry", input: { endRequestId: 9, reason: undefined, idempotencyKey: "header-key-0002", actor: { actorType: "admin", actorId: "admin-1" } } },
      { method: "resolve", input: { endRequestId: 9, outcome: "ended_on_ebay", reason: "Ended it.", idempotencyKey: "header-key-0003",
        actor: { actorType: "admin", actorId: "admin-1" } } },
    ]);
  });

  it("passes a malformed id as nothing, so the service refuses it", async () => {
    for (const id of ["0", "01", "1e3", "-4", "9007199254740993999"]) {
      await request(`${server.url}/api/dropship/admin/listing-ends/${id}/retry`, { method: "POST", permissions: [MANAGE],
        body: { idempotencyKey: "staff-key-0001" } });
    }
    expect(service.calls.map((call) => (call.input as { endRequestId: unknown }).endRequestId)).toEqual([undefined, undefined, undefined,
      undefined, undefined]);
  });

  it.each([
    [LISTING_END_OPS_ERROR_CODES.listInvalidInput, 400],
    [LISTING_END_OPS_ERROR_CODES.actionInvalidInput, 400],
    [LISTING_END_OPS_ERROR_CODES.notFound, 404],
    [LISTING_END_OPS_ERROR_CODES.staffStateInvalid, 409],
    [LISTING_END_OPS_ERROR_CODES.staffKeyReused, 409],
    [LISTING_END_OPS_ERROR_CODES.quantityRecoveryRequired, 409],
    [LISTING_END_OPS_ERROR_CODES.staffBusy, 503],
  ])("answers %s with %i and its code, message and context", async (code, status) => {
    expect(statusForListingEndOpsError(code)).toBe(status);
    service.failWith = new DropshipError(code, "words", { attemptIds: ["41"] });
    const response = await request(`${server.url}/api/dropship/admin/listing-ends/9/retry`, { method: "POST", permissions: [MANAGE],
      body: { idempotencyKey: "staff-key-0001" } });
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message: "words", context: { attemptIds: ["41"] } } });
  });

  it("answers anything else 500 without its message", async () => {
    service.failWith = new Error("connection refused at 10.0.0.1");
    const response = await request(`${server.url}/api/dropship/admin/listing-ends`, { permissions: [VIEW] });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: "DROPSHIP_LISTING_END_OPS_INTERNAL_ERROR", message: "The listing end request could not be handled." } });
    service.failWith = new DropshipError("DROPSHIP_SOMETHING_ELSE", "inner words");
    expect((await request(`${server.url}/api/dropship/admin/listing-ends`, { permissions: [VIEW] })).body.error.code)
      .toBe("DROPSHIP_LISTING_END_OPS_INTERNAL_ERROR");
  });
});

function buildApp(service: DropshipListingEndOpsService): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    req.session = { user: { id: "admin-1" } } as unknown as Request["session"];
    next();
  });
  registerDropshipAdminListingEndOpsRoutes(app, service);
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

async function request(url: string, input: { method?: string; permissions: string[]; body?: unknown; headers?: Record<string, string> }):
  Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: input.method ?? "GET",
    headers: { "Content-Type": "application/json", "x-test-permissions": input.permissions.join(","), ...(input.headers ?? {}) },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
