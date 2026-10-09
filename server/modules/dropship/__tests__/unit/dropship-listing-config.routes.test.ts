import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipListingConfigService } from "../../application/dropship-listing-config-service";
import { DropshipError } from "../../domain/errors";
import { registerDropshipListingConfigRoutes } from "../../interfaces/http/dropship-listing-config.routes";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../infrastructure/dropship-listing-config.factory", () => ({
  createDropshipListingConfigServiceFromEnv: vi.fn(),
}));

const permissionChecks: Array<[string, string]> = [];
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: (resource: string, action: string) =>
    (_req: Request, _res: Response, next: NextFunction) => {
      permissionChecks.push([resource, action]);
      next();
    },
}));

const ADMIN_PATH = "/api/dropship/admin/store-connections/44/listing-config";
const VENDOR_PATH = "/api/dropship/store-connections/44/listing-config";
/**
 * The vendor PUT checks its step-up proof against the wall clock, so the
 * clock is pinned and the proof expires five minutes after it.
 */
const FIXED_NOW = new Date("2026-10-01T12:00:00.000Z");
const PROOF_EXPIRES_AT = "2026-10-01T12:05:00.000Z";

/** A whole config as the previous client sent it: no revision. */
const CONFIG_BODY = {
  listingMode: "live",
  inventoryMode: "managed_quantity_sync",
  priceMode: "vendor_defined",
  marketplaceConfig: { merchantLocationKey: "warehouse-main", fulfillmentPolicyId: "fulfillment-1" },
  requiredConfigKeys: ["merchantLocationKey"],
  requiredProductFields: ["sku", "title"],
  isActive: true,
} as const;

type SessionKind = "vendor" | "vendor_without_proof" | "admin" | "anonymous";

describe("dropship listing config routes", () => {
  let service: FakeService;
  let server: Awaited<ReturnType<typeof startServer>> | null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
    permissionChecks.length = 0;
    service = new FakeService();
    server = null;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await server?.close();
  });

  describe("admin PUT", () => {
    it("passes the parsed config and the revision it was read at, as the staff actor", async () => {
      server = await startServer(buildApp(service, "admin"));

      const response = await putJson(`${server.url}${ADMIN_PATH}`, {
        listingMode: "draft_first",
        inventoryMode: "managed_quantity_sync",
        priceMode: "connection_default",
        requiredConfigKeys: ["  merchantLocationKey  "],
        isActive: true,
        expectedRevision: 7,
      });

      expect(response.status).toBe(200);
      expect(permissionChecks).toContainEqual(["dropship", "manage_operations"]);
      expect(service.calls).toEqual([{
        method: "replaceForAdmin",
        storeConnectionId: 44,
        input: {
          listingMode: "draft_first",
          inventoryMode: "managed_quantity_sync",
          priceMode: "connection_default",
          marketplaceConfig: {},
          requiredConfigKeys: ["merchantLocationKey"],
          requiredProductFields: [],
          isActive: true,
          expectedRevision: 7,
        },
        actor: { actorType: "admin", actorId: "staff-7" },
      }]);
      expect(response.body).toMatchObject({ outcome: "changed", revisionBefore: 7, revisionAfter: 8, config: { revision: 8 } });
    });

    it("answers an unchanged save with the service's outcome and revisions, as given", async () => {
      service.replaceResult = { ...changedResult(), outcome: "unchanged", revisionBefore: 8, revisionAfter: 8 };
      server = await startServer(buildApp(service, "admin"));

      const response = await putJson(`${server.url}${ADMIN_PATH}`, { ...CONFIG_BODY, expectedRevision: 8 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(JSON.parse(JSON.stringify(service.replaceResult)));
      expect(response.body).toMatchObject({ outcome: "unchanged", revisionBefore: 8, revisionAfter: 8, config: { revision: 8 } });
    });

    it("sends no write options, so the service's staff statuses apply and no request key is recorded", async () => {
      server = await startServer(buildApp(service, "admin"));

      const response = await putJson(`${server.url}${ADMIN_PATH}`, { ...CONFIG_BODY, expectedRevision: 7 });

      expect(response.status).toBe(200);
      expect(service.replaceOptions).toEqual([[]]);
    });

    it("asks a page without the revision to reload (428) and does not call the service", async () => {
      server = await startServer(buildApp(service, "admin"));

      const response = await putJson(`${server.url}${ADMIN_PATH}`, CONFIG_BODY);

      expect(response.status).toBe(428);
      expect(response.body).toEqual({
        error: {
          code: "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED",
          message: "Reload the page to load the latest listing config, then save again.",
          context: { retryable: false },
        },
      });
      expect(service.calls).toEqual([]);
    });

    it.each([
      ["a zero revision", 0],
      ["a negative revision", -1],
      ["a fractional revision", 1.5],
      ["a revision sent as text", "7"],
      ["a null revision", null],
      ["a revision past the integer column", 2_147_483_648],
    ])("rejects %s with 400 before invoking the service", async (_label, expectedRevision) => {
      server = await startServer(buildApp(service, "admin"));

      const response = await putJson(`${server.url}${ADMIN_PATH}`, { ...CONFIG_BODY, expectedRevision });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: {
          code: "DROPSHIP_INVALID_LISTING_CONFIG_REQUEST",
          context: { issues: [expect.objectContaining({ path: "expectedRevision" })] },
        },
      });
      expect(service.calls).toEqual([]);
    });

    it("rejects an unknown field with 400 even when the revision is present", async () => {
      server = await startServer(buildApp(service, "admin"));

      const response = await putJson(`${server.url}${ADMIN_PATH}`, {
        ...CONFIG_BODY,
        expectedRevision: 7,
        revision: 7,
      });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: {
          code: "DROPSHIP_INVALID_LISTING_CONFIG_REQUEST",
          context: { issues: [expect.objectContaining({ code: "unrecognized_keys" })] },
        },
      });
      expect(service.calls).toEqual([]);
    });

    it("rejects a non-positive store connection id before invoking the service", async () => {
      server = await startServer(buildApp(service, "admin"));

      const response = await putJson(
        `${server.url}/api/dropship/admin/store-connections/0/listing-config`,
        { ...CONFIG_BODY, expectedRevision: 7 },
      );

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: "DROPSHIP_INVALID_LISTING_CONFIG_REQUEST" } });
      expect(service.calls).toEqual([]);
    });

    it("loads the config for staff behind dropship:view", async () => {
      server = await startServer(buildApp(service, "admin"));

      const response = await jsonRequest(`${server.url}${ADMIN_PATH}`);

      expect(response.status).toBe(200);
      expect(permissionChecks).toContainEqual(["dropship", "view"]);
      expect(service.calls).toEqual([{
        method: "getForAdmin",
        storeConnectionId: 44,
        actor: { actorType: "admin", actorId: "staff-7" },
      }]);
      expect(response.body).toMatchObject({ config: { revision: 8 } });
    });
  });

  describe("vendor PUT", () => {
    it("passes the parsed config and the revision it was read at for the session member", async () => {
      server = await startServer(buildApp(service, "vendor"));
      const body = { ...CONFIG_BODY, expectedRevision: 12 };

      const response = await putJson(`${server.url}${VENDOR_PATH}`, body);

      expect(response.status).toBe(200);
      expect(service.calls).toEqual([{
        method: "replaceForMember",
        memberId: "member-1",
        storeConnectionId: 44,
        input: body,
      }]);
      expect(response.body).toMatchObject({ outcome: "changed", revisionBefore: 7, revisionAfter: 8, config: { revision: 8 } });
    });

    it("asks a page without the revision to reload (428) and does not call the service", async () => {
      server = await startServer(buildApp(service, "vendor"));

      const response = await putJson(`${server.url}${VENDOR_PATH}`, CONFIG_BODY);

      expect(response.status).toBe(428);
      expect(response.body).toMatchObject({ error: { code: "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED" } });
      expect(service.calls).toEqual([]);
    });

    it("sends no write options, so the service's vendor setup statuses apply and no request key is recorded", async () => {
      server = await startServer(buildApp(service, "vendor"));

      const response = await putJson(`${server.url}${VENDOR_PATH}`, { ...CONFIG_BODY, expectedRevision: 12 });

      expect(response.status).toBe(200);
      expect(service.replaceOptions).toEqual([[]]);
    });

    it("asks for a reload (428) over a validation error when the revision is missing and another field is invalid", async () => {
      server = await startServer(buildApp(service, "vendor"));

      const response = await putJson(`${server.url}${VENDOR_PATH}`, { ...CONFIG_BODY, listingMode: "bogus" });

      expect(response.status).toBe(428);
      expect(response.body).toEqual({
        error: {
          code: "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED",
          message: "Reload the page to load the latest listing config, then save again.",
          context: { retryable: false },
        },
      });
      expect(service.calls).toEqual([]);
    });

    it("rejects a zero revision with 400 before invoking the service", async () => {
      server = await startServer(buildApp(service, "vendor"));

      const response = await putJson(`${server.url}${VENDOR_PATH}`, { ...CONFIG_BODY, expectedRevision: 0 });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: "DROPSHIP_INVALID_LISTING_CONFIG_REQUEST" } });
      expect(service.calls).toEqual([]);
    });

    it("still requires the listing-push step-up before it reads the body", async () => {
      server = await startServer(buildApp(service, "vendor_without_proof"));

      const response = await putJson(`${server.url}${VENDOR_PATH}`, CONFIG_BODY);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        error: { code: "DROPSHIP_STEP_UP_REQUIRED", context: { action: "bulk_listing_push" } },
      });
      expect(service.calls).toEqual([]);
    });

    it("requires a dropship session", async () => {
      server = await startServer(buildApp(service, "anonymous"));

      const response = await putJson(`${server.url}${VENDOR_PATH}`, { ...CONFIG_BODY, expectedRevision: 12 });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: { code: "DROPSHIP_AUTH_REQUIRED" } });
      expect(service.calls).toEqual([]);
    });

    it("loads the config for the session member", async () => {
      server = await startServer(buildApp(service, "vendor"));

      const response = await jsonRequest(`${server.url}${VENDOR_PATH}`);

      expect(response.status).toBe(200);
      expect(service.calls).toEqual([{ method: "getForMember", memberId: "member-1", storeConnectionId: 44 }]);
    });
  });

  describe("error mapping", () => {
    it.each([
      ["admin", ADMIN_PATH, "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", 409],
      ["admin", ADMIN_PATH, "DROPSHIP_LISTING_CONFIG_STORE_PAUSED", 409],
      ["admin", ADMIN_PATH, "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING", 409],
      ["admin", ADMIN_PATH, "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE", 409],
      ["admin", ADMIN_PATH, "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED", 409],
      ["admin", ADMIN_PATH, "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED", 428],
      ["admin", ADMIN_PATH, "DROPSHIP_STORE_CONNECTION_NOT_FOUND", 404],
      ["vendor", VENDOR_PATH, "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", 409],
      ["vendor", VENDOR_PATH, "DROPSHIP_LISTING_CONFIG_STORE_PAUSED", 409],
      ["vendor", VENDOR_PATH, "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING", 409],
      ["vendor", VENDOR_PATH, "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE", 409],
      ["vendor", VENDOR_PATH, "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED", 409],
      ["vendor", VENDOR_PATH, "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED", 403],
      ["vendor", VENDOR_PATH, "DROPSHIP_SOMETHING_UNMAPPED", 500],
    ] as const)("maps a %s save failing with %s (via %s) to %i", async (kind, path, code, status) => {
      service.error = new DropshipError(code, "Controlled failure.", { storeConnectionId: 44, retryable: false });
      server = await startServer(buildApp(service, kind));

      const response = await putJson(`${server.url}${path}`, { ...CONFIG_BODY, expectedRevision: 7 });

      expect(response.status).toBe(status);
      expect(response.body).toMatchObject({ error: { code, message: "Controlled failure." } });
    });

    it("gives a conflicted page the revision it sent and the current one", async () => {
      service.error = new DropshipError(
        "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        "The listing config changed since it was read.",
        { storeConnectionId: 44, expectedRevision: 7, currentRevision: 9, retryable: false },
      );
      server = await startServer(buildApp(service, "admin"));

      const response = await putJson(`${server.url}${ADMIN_PATH}`, { ...CONFIG_BODY, expectedRevision: 7 });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: {
          code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
          context: { storeConnectionId: 44, expectedRevision: 7, currentRevision: 9, retryable: false },
        },
      });
    });

    it("hides an unexpected failure behind a generic 500", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      service.error = new Error("connection string postgres://secret");
      server = await startServer(buildApp(service, "vendor"));

      const response = await putJson(`${server.url}${VENDOR_PATH}`, { ...CONFIG_BODY, expectedRevision: 7 });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: {
          code: "DROPSHIP_LISTING_CONFIG_INTERNAL_ERROR",
          message: "Dropship listing config request failed.",
        },
      });
      expect(consoleError).toHaveBeenCalledTimes(1);
    });
  });
});

type FakeCall =
  | { method: "getForAdmin"; storeConnectionId: number; actor: unknown }
  | { method: "replaceForAdmin"; storeConnectionId: number; input: unknown; actor: unknown }
  | { method: "getForMember"; memberId: string; storeConnectionId: number }
  | { method: "replaceForMember"; memberId: string; storeConnectionId: number; input: unknown };

class FakeService {
  calls: FakeCall[] = [];
  /** Arguments a replace was given past the input (and actor): the write options, when a route sends any. */
  replaceOptions: unknown[][] = [];
  error: Error | null = null;
  /** What a replace answers; a changed write from revision 7 to 8 unless set. */
  replaceResult: ReturnType<typeof changedResult> | null = null;

  async getForAdmin(storeConnectionId: number, actor: unknown) {
    this.calls.push({ method: "getForAdmin", storeConnectionId, actor });
    if (this.error) throw this.error;
    return { storeConnection: storeConnection(), config: configRecord() };
  }

  async replaceForAdmin(storeConnectionId: number, input: unknown, actor: unknown, ...options: unknown[]) {
    this.calls.push({ method: "replaceForAdmin", storeConnectionId, input, actor });
    this.replaceOptions.push(options);
    if (this.error) throw this.error;
    return this.replaceResult ?? changedResult();
  }

  async getForMember(memberId: string, storeConnectionId: number) {
    this.calls.push({ method: "getForMember", memberId, storeConnectionId });
    if (this.error) throw this.error;
    return { storeConnection: storeConnection(), config: configRecord() };
  }

  async replaceForMember(memberId: string, storeConnectionId: number, input: unknown, ...options: unknown[]) {
    this.calls.push({ method: "replaceForMember", memberId, storeConnectionId, input });
    this.replaceOptions.push(options);
    if (this.error) throw this.error;
    return this.replaceResult ?? changedResult();
  }
}

/** A write that moved the config from revision 7 to 8, as the service answers it. */
function changedResult() {
  return {
    storeConnection: storeConnection(),
    config: configRecord(),
    outcome: "changed" as "changed" | "unchanged" | "replayed",
    revisionBefore: 7,
    revisionAfter: 8,
  };
}

function storeConnection() {
  return { vendorId: 10, storeConnectionId: 44, platform: "ebay", status: "connected", setupStatus: "ready" };
}

function configRecord() {
  return {
    id: 3,
    storeConnectionId: 44,
    platform: "ebay",
    ...CONFIG_BODY,
    revision: 8,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: FIXED_NOW,
  };
}

function buildApp(service: FakeService, kind: SessionKind): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = sessionFor(kind);
    next();
  });
  registerDropshipListingConfigRoutes(app, service as unknown as DropshipListingConfigService);
  return app;
}

function sessionFor(kind: SessionKind): Record<string, unknown> {
  if (kind === "anonymous") return {};
  if (kind === "admin") return { user: { id: "staff-7" } };
  return {
    dropship: {
      authIdentityId: 1,
      memberId: "member-1",
      cardShellzEmail: "vendor@cardshellz.test",
      hasPasskey: false,
      authMethod: "password",
      entitlementStatus: "active",
      authenticatedAt: "2026-10-01T11:50:00.000Z",
    },
    dropshipSensitiveProofs: kind === "vendor"
      ? {
          bulk_listing_push: {
            method: "email_mfa",
            verifiedAt: "2026-10-01T11:55:00.000Z",
            expiresAt: PROOF_EXPIRES_AT,
          },
        }
      : {},
  };
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function putJson(url: string, body: unknown) {
  return jsonRequest(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function jsonRequest(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}
