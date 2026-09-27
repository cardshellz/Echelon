import http from "http";
import { AddressInfo } from "net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReturnPolicyAdminError, type ReturnPolicyAdminService } from "../../application/return-policy-admin.service";
import { registerReturnPolicyAdminRoutes } from "../../interfaces/http/return-policy-admin.routes";

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({ requirePermission: requirePermissionMock }));

describe("return policy admin routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: ReturnType<typeof fakeService>;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = fakeService();
    server = await startServer(buildApp(service));
  });

  afterEach(async () => server.close());

  it("requires an idempotency key for version creation", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPolicy()),
    });

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_POLICY_IDEMPOTENCY_REQUIRED" } } });
    expect(service.createVersion).not.toHaveBeenCalled();
  });

  it("forwards the simplified public scope with its authenticated actor", async () => {
    service.createVersion.mockResolvedValue({ policy: { id: 42 }, replayed: false });

    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": " returns-test-2 " },
      body: JSON.stringify(validPolicy()),
    });

    expect(response).toMatchObject({ status: 201, body: { policy: { id: 42 }, replayed: false } });
    expect(service.createVersion).toHaveBeenCalledWith({ ...validPolicy(), idempotencyKey: "returns-test-2", actor: "operator-1" });
  });

  it("rejects internal scope fields at the public boundary", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "returns-test-legacy" },
      body: JSON.stringify({ ...validPolicy(), appliesTo: undefined, scopeKind: "channel_context", businessContext: "retail" }),
    });

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_POLICY_INVALID" } } });
    expect(service.createVersion).not.toHaveBeenCalled();
  });

  it("searches stores within the selected vendor", async () => {
    service.searchStores.mockResolvedValue([{ id: 11, vendorId: 7, platform: "ebay", displayName: "Seven eBay", shopDomain: null, status: "connected" }]);

    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/stores?vendorId=7&search=seven&limit=10`);

    expect(response.status).toBe(200);
    expect(service.searchStores).toHaveBeenCalledWith(7, "seven", 10);
    expect(response.body).toMatchObject({ stores: [{ id: 11, vendorId: 7 }] });
  });

  it("rejects store search without a valid vendor", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/stores?vendorId=0`);

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_POLICY_INVALID" } } });
    expect(service.searchStores).not.toHaveBeenCalled();
  });

  it("preserves classified conflicts", async () => {
    service.createVersion.mockRejectedValue(new ReturnPolicyAdminError("RETURN_POLICY_IDEMPOTENCY_CONFLICT", "The key was already used.", 409));

    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "returns-test-4" },
      body: JSON.stringify(validPolicy()),
    });

    expect(response).toMatchObject({ status: 409, body: { error: { code: "RETURN_POLICY_IDEMPOTENCY_CONFLICT" } } });
  });

  it("returns a validated private archive preview and registers view/edit permission gates", async () => {
    const preview = archivePreview();
    service.previewArchive.mockResolvedValue(preview);

    expect(await jsonRequest(`${server.url}/api/returns/admin/policies/42/archive-preview`)).toMatchObject({
      status: 200, body: preview, cacheControl: "private, no-store",
    });
    expect(service.previewArchive).toHaveBeenCalledExactlyOnceWith(42);
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "view");
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "edit");
  });

  it("archives only the reviewed version with the authenticated actor and header key", async () => {
    const input = { expectedVersion: 3, previewRevision: "a".repeat(64) };
    service.archive.mockResolvedValue({ policy: { ...archivePreview().policy, status: "retired" }, replayed: false });
    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/42/archive`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": " archive-42 " }, body: JSON.stringify(input),
    });
    expect(response).toMatchObject({ status: 200, body: { policy: { id: 42, status: "retired" }, replayed: false }, cacheControl: "private, no-store" });
    expect(service.archive).toHaveBeenCalledExactlyOnceWith(42, input, "archive-42", "operator-1");
  });

  it.each(["0", "-1", "1.5", "42suffix", "9007199254740992"])("rejects invalid archive identity %s before reading policy data", async policyId => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/${policyId}/archive-preview`);
    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_POLICY_INVALID" } }, cacheControl: "private, no-store" });
    expect(service.previewArchive).not.toHaveBeenCalled();
  });

  it.each([
    { expectedVersion: 0, previewRevision: "a".repeat(64) },
    { expectedVersion: 3, previewRevision: "not-a-reviewed-revision" },
    { expectedVersion: 3, previewRevision: "a".repeat(64), actor: "spoofed-actor" },
  ])("rejects malformed or actor-injected archive commands", async input => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/42/archive`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "archive-42" }, body: JSON.stringify(input),
    });
    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_POLICY_INVALID" } } });
    expect(service.archive).not.toHaveBeenCalled();
  });

  it("requires an archive idempotency key", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/42/archive`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 3, previewRevision: "a".repeat(64) }),
    });
    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_POLICY_IDEMPOTENCY_REQUIRED" } } });
    expect(service.archive).not.toHaveBeenCalled();
  });

  it("does not accept an archive without a session audit actor even if the outer gate allowed it", async () => {
    const anonymous = await startServer(buildApp(service, false));
    try {
      const response = await jsonRequest(`${anonymous.url}/api/returns/admin/policies/42/archive`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "archive-42" },
        body: JSON.stringify({ expectedVersion: 3, previewRevision: "a".repeat(64) }),
      });
      expect(response).toMatchObject({ status: 401, body: { error: { code: "RETURN_POLICY_ACTOR_REQUIRED" } } });
      expect(service.archive).not.toHaveBeenCalled();
    } finally { await anonymous.close(); }
  });

  it("preserves archive stale-preview conflicts", async () => {
    service.archive.mockRejectedValue(new ReturnPolicyAdminError("RETURN_POLICY_ARCHIVE_CHANGED", "Review the current impact before archiving.", 409));
    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/42/archive`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "archive-42" },
      body: JSON.stringify({ expectedVersion: 3, previewRevision: "a".repeat(64) }),
    });
    expect(response).toMatchObject({ status: 409, body: { error: { code: "RETURN_POLICY_ARCHIVE_CHANGED" } }, cacheControl: "private, no-store" });
  });

  it("fails closed on malformed preview output without exposing raw dependency errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      service.previewArchive.mockResolvedValue({ ...archivePreview(), revision: "invalid" });
      expect(await jsonRequest(`${server.url}/api/returns/admin/policies/42/archive-preview`)).toMatchObject({
        status: 500, body: { error: { code: "RETURN_POLICY_ARCHIVE_PREVIEW_FAILED" } },
      });
      service.previewArchive.mockRejectedValue(new Error("sensitive-driver-detail"));
      const response = await jsonRequest(`${server.url}/api/returns/admin/policies/42/archive-preview`);
      expect(JSON.stringify(response)).not.toContain("sensitive-driver-detail");
      expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive-driver-detail");
    } finally { log.mockRestore(); }
  });
});

function archivePreview() {
  return {
    policy: { id: 42, name: "Shopify returns", version: 3, scopeKind: "channel_context", scopeKey: "context:retail:channel:36",
      businessContext: "retail", channelId: 36, vendorId: null, storeConnectionId: null, status: "active", returnWindowDays: 30 },
    revision: "a".repeat(64), effects: [], unaffectedMoreSpecificPolicies: [], historicalReferences: { returnCases: 4, portalIntakes: 2 },
  };
}

function validPolicy() {
  return {
    name: "Shopify returns",
    appliesTo: "channel",
    channelId: 36,
    vendorId: null,
    storeConnectionId: null,
    returnWindowDays: 30,
    returnDestination: "card_shellz",
    approvalAuthority: "card_shellz",
    labelProvider: "shipstation",
    returnShippingPayer: "customer",
    inspectionRequirement: "required",
    inspectionOwner: "card_shellz",
    customerRefundAuthority: "card_shellz",
    vendorSettlementTrigger: "none",
    returnlessRefundAllowed: false,
    notes: null,
  };
}

function fakeService() {
  return {
    listOverview: vi.fn(),
    listActivePolicies: vi.fn(),
    getDropshipOmsChannel: vi.fn(),
    searchVendors: vi.fn(),
    searchStores: vi.fn(),
    resolve: vi.fn(),
    createVersion: vi.fn(),
    previewArchive: vi.fn(),
    archive: vi.fn(),
  };
}

function buildApp(service: ReturnType<typeof fakeService>, authenticated = true): express.Express {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", { configurable: true, value: { user: { id: "operator-1" } } });
      next();
    });
  }
  registerReturnPolicyAdminRoutes(app, service as unknown as ReturnPolicyAdminService);
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function jsonRequest(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string | undefined }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: init?.method ?? "GET",
      headers: init?.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: rawBody === "" ? {} : JSON.parse(rawBody) as Record<string, unknown>, cacheControl: response.headers["cache-control"] });
      });
    });
    request.on("error", reject);
    if (init?.body !== undefined) request.write(init.body);
    request.end();
  });
}
