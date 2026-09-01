import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupplyTransformationsAdminView } from "@shared/types/inventory-availability-admin";

import {
  registerInventoryAvailabilityMasterDataRoutes,
} from "../../interfaces/http/inventory-availability-master-data.routes";

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: requirePermissionMock,
}));

describe("inventory availability master-data routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: ReturnType<typeof fakeService>;
  let promiseSafetyService: ReturnType<typeof fakePromiseSafetyService>;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = fakeService();
    promiseSafetyService = fakePromiseSafetyService();
    server = await startServer(buildApp(service, true, promiseSafetyService));
  });

  afterEach(async () => server.close());

  it("gates the product view with the dedicated view ability", async () => {
    service.getSupplyTransformationsAdminView.mockResolvedValue(adminView());
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10`,
    );

    expect(response).toMatchObject({ status: 200, body: { product: { id: 10 } } });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "view");
    expect(service.getSupplyTransformationsAdminView).toHaveBeenCalledWith(10);
  });

  it("validates a draft, binds the route product, and forwards the audit actor", async () => {
    service.createTransformationModelDraft.mockResolvedValue({
      modelId: 91,
      version: 1,
      definitionHash: "a".repeat(64),
      alreadyApplied: false,
    });
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/drafts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: 999,
          buildToPromiseEnabled: false,
          paths: [],
          recipeBindings: [],
          changeReason: "Reviewed exact-only model",
          idempotencyKey: "route-test-1",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "edit");
    expect(service.createTransformationModelDraft).toHaveBeenCalledWith({
      productId: 10,
      buildToPromiseEnabled: false,
      paths: [],
      recipeBindings: [],
      changeReason: "Reviewed exact-only model",
      idempotencyKey: "route-test-1",
    }, "operator-1");
  });

  it("returns 200 for an idempotent replay", async () => {
    service.createTransformationModelDraft.mockResolvedValue({
      modelId: 91,
      version: 1,
      definitionHash: "a".repeat(64),
      alreadyApplied: true,
    });
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/drafts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: 10,
          buildToPromiseEnabled: false,
          paths: [],
          recipeBindings: [],
          changeReason: "Reviewed exact-only model",
          idempotencyKey: "route-test-1",
        }),
      },
    );
    expect(response.status).toBe(200);
  });

  it("returns a retryable conflict for a serializable evidence race", async () => {
    service.createTransformationModelDraft.mockRejectedValue({ code: "40001" });
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/drafts`,
      jsonPost({
        productId: 10,
        buildToPromiseEnabled: false,
        paths: [],
        recipeBindings: [],
        changeReason: "Concurrent evidence test",
        idempotencyKey: "route-serialization-1",
      }),
    );

    expect(response).toMatchObject({
      status: 409,
      body: { error: { code: "INVENTORY_AVAILABILITY_RETRY_REQUIRED" } },
    });
  });

  it("rejects malformed draft input before calling the service", async () => {
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/drafts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buildToPromiseEnabled: false,
          paths: [{ inputQty: 0 }],
          recipeBindings: [],
          changeReason: "",
          idempotencyKey: "",
        }),
      },
    );
    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: "INVENTORY_AVAILABILITY_INVALID_INPUT" } },
    });
    expect(service.createTransformationModelDraft).not.toHaveBeenCalled();
  });

  it("rejects mutation requests without an authenticated audit actor", async () => {
    await server.close();
    server = await startServer(buildApp(service, false));
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/drafts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: 10,
          buildToPromiseEnabled: false,
          paths: [],
          recipeBindings: [],
          changeReason: "Reviewed exact-only model",
          idempotencyKey: "route-test-1",
        }),
      },
    );
    expect(response).toMatchObject({
      status: 401,
      body: { error: { code: "INVENTORY_AVAILABILITY_ACTOR_REQUIRED" } },
    });
    expect(service.createTransformationModelDraft).not.toHaveBeenCalled();
  });

  it("serves a bounded deterministic product query under the planning view ability", async () => {
    service.listProductOptions.mockResolvedValue({
      products: [{ id: 10, sku: "QUAD", name: "Quad Box" }],
    });
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/products?q=quad&limit=25`,
    );

    expect(response).toEqual({
      status: 200,
      body: { products: [{ id: 10, sku: "QUAD", name: "Quad Box" }] },
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "view");
    expect(service.listProductOptions).toHaveBeenCalledWith({ q: "quad", limit: 25 });
  });

  it("rejects unbounded or unexpected product-query fields", async () => {
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/products?limit=101&unexpected=true`,
    );
    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: "INVENTORY_AVAILABILITY_INVALID_INPUT" } },
    });
    expect(service.listProductOptions).not.toHaveBeenCalled();
  });

  it("accepts a strict location-policy draft and rejects malformed fields", async () => {
    service.createLocationPromisePolicyDraft.mockResolvedValue({
      policyId: 201,
      version: 1,
      alreadyApplied: false,
    });
    const valid = {
      warehouseLocationId: 7,
      eligibilityMode: "eligible",
      changeReason: "Reserve bins may promise",
      idempotencyKey: "location-route-1",
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/location-promise-policies/drafts`,
      jsonPost(valid),
    );
    expect(response.status).toBe(201);
    expect(service.createLocationPromisePolicyDraft).toHaveBeenCalledWith(valid, "operator-1");

    const malformed = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/location-promise-policies/drafts`,
      jsonPost({ ...valid, unexpected: true }),
    );
    expect(malformed).toMatchObject({
      status: 400,
      body: { error: { code: "INVENTORY_AVAILABILITY_INVALID_INPUT" } },
    });
    expect(service.createLocationPromisePolicyDraft).toHaveBeenCalledTimes(1);
  });

  it("accepts a strict safety-policy draft and rejects an invalid business inheritance", async () => {
    service.createPromiseSafetyPolicyDraft.mockResolvedValue({
      policyId: 301,
      version: 1,
      scopeKey: "network:variant:11",
      definitionHash: "b".repeat(64),
      alreadyApplied: false,
    });
    const valid = {
      scope: { scopeType: "network_variant", productVariantId: 11 },
      value: { policyMode: "off" },
      changeReason: "No floor for this SKU",
      idempotencyKey: "safety-route-1",
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/promise-safety-policies/drafts`,
      jsonPost(valid),
    );
    expect(response.status).toBe(201);
    expect(service.createPromiseSafetyPolicyDraft).toHaveBeenCalledWith(valid, "operator-1");

    const malformed = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/promise-safety-policies/drafts`,
      jsonPost({
        ...valid,
        scope: { scopeType: "business" },
        value: { policyMode: "inherit" },
      }),
    );
    expect(malformed).toMatchObject({
      status: 400,
      body: { error: { code: "INVENTORY_AVAILABILITY_INVALID_INPUT" } },
    });
    expect(service.createPromiseSafetyPolicyDraft).toHaveBeenCalledTimes(1);

    const outOfRange = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/promise-safety-policies/drafts`,
      jsonPost({
        ...valid,
        value: { policyMode: "fixed_units", fixedUnits: 2_147_483_648 },
      }),
    );
    expect(outOfRange).toMatchObject({
      status: 400,
      body: { error: { code: "INVENTORY_AVAILABILITY_INVALID_INPUT" } },
    });
    expect(service.createPromiseSafetyPolicyDraft).toHaveBeenCalledTimes(1);
  });

  it("loads, edits, and refreshes promise safety through role-gated admin routes", async () => {
    promiseSafetyService.getView.mockResolvedValue(promiseSafetyView());
    promiseSafetyService.updatePolicyDraft.mockResolvedValue({
      policyId: 301,
      version: 1,
      scopeKey: "network:variant:11",
      definitionHash: "b".repeat(64),
      alreadyApplied: false,
    });
    promiseSafetyService.refreshDemandEvidence.mockResolvedValue({
      productId: 10,
      methodVersion: "irreversible_consumption_v1_28d",
      windowStartedAt: "2026-08-02T00:00:00.000Z",
      windowEndedAt: "2026-08-30T00:00:00.000Z",
      calculatedAt: "2026-08-30T12:00:00.000Z",
      createdSnapshots: 1,
      reusedSnapshots: 0,
      trustedSnapshots: 1,
      untrustedSnapshots: 0,
      alreadyApplied: false,
    });

    const viewResponse = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/promise-safety/10`,
    );
    expect(viewResponse.status).toBe(200);
    expect(promiseSafetyService.getView).toHaveBeenCalledWith(10);

    const update = {
      expectedVersion: 1,
      expectedDefinitionHash: "a".repeat(64),
      expectedHeadRevision: "0",
      value: { policyMode: "fixed_units", fixedUnits: 4 },
      changeReason: "Protect four units",
      idempotencyKey: "safety-route-update-1",
    };
    const updateResponse = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/promise-safety-policies/drafts/301`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update) },
    );
    expect(updateResponse.status).toBe(200);
    expect(promiseSafetyService.updatePolicyDraft).toHaveBeenCalledWith(301, update, "operator-1");

    const refresh = {
      changeReason: "Refresh reviewed demand inputs",
      idempotencyKey: "safety-route-refresh-1",
    };
    const refreshResponse = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/promise-safety/10/demand-evidence/refresh`,
      jsonPost(refresh),
    );
    expect(refreshResponse.status).toBe(201);
    expect(promiseSafetyService.refreshDemandEvidence).toHaveBeenCalledWith(
      10,
      refresh,
      "operator-1",
    );
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "view");
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "edit");
  });

  it("updates a current draft in place with optimistic evidence and always returns 200", async () => {
    service.updateTransformationModelDraft.mockResolvedValue({
      modelId: 91,
      version: 1,
      definitionHash: "b".repeat(64),
      alreadyApplied: false,
    });
    const body = {
      expectedVersion: 1,
      expectedDefinitionHash: "a".repeat(64),
      expectedHeadRevision: "0",
      buildToPromiseEnabled: false,
      paths: [],
      recipeBindings: [],
      changeReason: "Correct draft authority",
      idempotencyKey: "draft-update-route-1",
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/drafts/91`,
      { ...jsonPost(body), method: "PUT" },
    );
    expect(response.status).toBe(200);
    expect(service.updateTransformationModelDraft).toHaveBeenCalledWith(
      10,
      91,
      body,
      "operator-1",
    );

    const malformed = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/drafts/91`,
      { ...jsonPost({ ...body, expectedHeadRevision: "9223372036854775808" }), method: "PUT" },
    );
    expect(malformed.status).toBe(400);
    expect(service.updateTransformationModelDraft).toHaveBeenCalledTimes(1);
  });

  it("reports the malformed draft-model path parameter accurately", async () => {
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/drafts/not-a-model`,
      { ...jsonPost({}), method: "PUT" },
    );
    expect(response).toMatchObject({
      status: 400,
      body: { error: { message: "Invalid draft model identifier." } },
    });
  });

  it("does not expose any activation route in Phase 1", async () => {
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/activate`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });
});

function fakeService() {
  return {
    listProductOptions: vi.fn(),
    getSupplyTransformationsAdminView: vi.fn(),
    createTransformationModelDraft: vi.fn(),
    updateTransformationModelDraft: vi.fn(),
    createLocationPromisePolicyDraft: vi.fn(),
    createPromiseSafetyPolicyDraft: vi.fn(),
  };
}

function fakePromiseSafetyService() {
  return {
    getView: vi.fn(),
    refreshDemandEvidence: vi.fn(),
    updatePolicyDraft: vi.fn(),
  };
}

function buildApp(
  service: ReturnType<typeof fakeService>,
  authenticated = true,
  promiseSafetyService = fakePromiseSafetyService(),
): express.Express {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", {
        configurable: true,
        value: { user: { id: "operator-1" } },
      });
      next();
    });
  }
  registerInventoryAvailabilityMasterDataRoutes(app, { service, promiseSafetyService });
  return app;
}

function promiseSafetyView() {
  return {
    product: { id: 10, sku: "BASE", name: "Base product" },
    variants: [],
    warehouses: [],
    policyHeads: [],
    demandMethod: {
      methodVersion: "irreversible_consumption_v1_28d" as const,
      observationDays: 28 as const,
      minimumObservedDays: 14 as const,
      minimumSourceEvents: 2 as const,
      minimumActiveDays: 2 as const,
      minimumConsumptionUnits: 3 as const,
      recencyDays: 14 as const,
      maximumEvidenceAgeHours: 36 as const,
    },
    demandEvidence: [],
  };
}

async function startServer(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
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
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
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
        let body: Record<string, unknown> = {};
        if (rawBody !== "") {
          try {
            body = JSON.parse(rawBody) as Record<string, unknown>;
          } catch {
            body = { raw: rawBody };
          }
        }
        resolve({
          status: response.statusCode ?? 0,
          body,
        });
      });
    });
    request.on("error", reject);
    if (init?.body !== undefined) request.write(init.body);
    request.end();
  });
}

function jsonPost(body: unknown) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function adminView(): SupplyTransformationsAdminView {
  return {
    product: {
      id: 10,
      sku: "QUAD",
      name: "Quad Box",
      isActive: true,
      legacyInventoryStrategy: "recipe_managed",
    },
    variants: [],
    recipes: [],
    head: null,
    activeModel: null,
    draftModel: null,
    runtimeAuthority: {
      kind: "legacy_inventory_strategy",
      value: "recipe_managed",
      draftAffectsRuntime: false,
    },
  };
}
